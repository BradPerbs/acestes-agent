const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sftp = require('../sftp');
const agents = require('../agents');
const sandboxModule = require('./sandbox');
const files = require('./files');

/**
 * The agent's files: the inventory's bag for bytes. See files.js for where
 * they live and who owns which.
 *
 * The agent has the whole of its own bag. It lists and reads what is in it,
 * saves new files from text, from base64, from a granted folder on this
 * computer, from a server over SFTP or from a URL, renames and replaces
 * them, sends them to a server, into a granted folder or to another agent,
 * and deletes them. In a local command, `{{file:name}}` is the file's path
 * on this disk, filled in at launch (see run_local_command in tools.js).
 *
 * The approval line is drawn where the rest of the app draws it. Looking and
 * adding a new file change nothing anywhere but the agent's own bag, the way
 * a memory note does, so they go ahead; saving is marked `writes` so a run
 * told to change nothing still stops. Replacing, renaming, deleting and
 * sending all overwrite or reach out of the bag, and ask.
 *
 * Built by tools.js with its helpers, rather than requiring them back, which
 * would be a cycle.
 */

/** How much text one read returns, the same as read_local_file. */
const MAX_TEXT = 120000;
/** How much of a file is read to find the lines asked for. */
const MAX_SCAN = 8 * 1024 * 1024;
/** A picture shown to the model whole, at most. */
const MAX_IMAGE = 5 * 1024 * 1024;
/** Base64 handed back, at most, before encoding. */
const MAX_BASE64 = 1024 * 1024;
const MAX_LIST = 200;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const bagFor = (ctx) => ctx?.files || files.forAgent(ctx?.agentId || '');
const containerised = (ctx) => ctx?.sandbox?.execution === 'container';

/** What the model sees of a file: everything but whose it is by id. */
function shown(file) {
    return {
        id: file.id,
        name: file.name,
        size: file.size,
        mime: file.mime,
        description: file.description || undefined,
        tags: file.tags?.length ? file.tags : undefined,
        shared: file.shared || undefined,
        source: file.source || undefined,
        updatedAt: new Date(file.updatedAt || 0).toISOString(),
        reference: file.reference,
    };
}

function sizeLabel(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * A path on this computer the agent may use, as this disk names it. On the
 * host, inside a granted folder. In a container, a path under one of the
 * mounted folders, mapped back to the folder it mounts: the container's own
 * scratch space is not somewhere this process can reach.
 */
function localTarget(ctx, target, mode) {
    const raw = String(target || '').trim();
    if (!raw) return { error: 'A path is needed.' };
    if (containerised(ctx)) {
        const checked = sandboxModule.containerPath(ctx.sandbox, raw, mode);
        if (checked.error) return checked;
        if (!checked.mount) {
            return { error: `"${checked.path}" is inside the container's own scratch space, which the app cannot reach. Use a path under one of the mounted folders.` };
        }
        const inside = path.posix.relative(checked.mount.container, checked.path);
        return { path: path.join(checked.mount.host, ...inside.split('/').filter(Boolean)), shownAs: checked.path };
    }
    if (!path.isAbsolute(raw)) return { error: `"${raw}" is not an absolute path.` };
    const grant = sandboxModule.grantFor(ctx?.sandbox, raw, mode);
    return grant.error ? grant : { path: grant.path, shownAs: grant.path };
}

function findAgent(nameOrId) {
    const wanted = String(nameOrId || '').trim().toLowerCase();
    if (!wanted) return null;
    return agents.snapshot().agents.find(agent => agent.id === nameOrId || agent.name.toLowerCase() === wanted) || null;
}

/** One stretch of lines out of a text, counting from 1. */
function lines(text, offset, limit) {
    if (!offset && !limit) return { text, from: 1, to: null };
    const all = text.split('\n');
    const from = Math.max(1, offset || 1);
    const to = limit ? Math.min(all.length, from + limit - 1) : all.length;
    return { text: all.slice(from - 1, to).join('\n'), from, to, total: all.length };
}

function baseName(value) {
    const cleaned = String(value || '').split(/[?#]/)[0].replace(/\/+$/, '');
    const last = cleaned.split(/[/\\]/).pop() || '';
    try {
        return decodeURIComponent(last);
    } catch {
        return last;
    }
}

const SOURCE_FIELDS = ['content', 'base64', 'localPath', 'remotePath', 'url'];

function build({ z, ok, fail, resolveSession }) {
    const changed = (ctx) => {
        if (typeof ctx?.inventoryChanged === 'function') ctx.inventoryChanged('files');
    };

    /** A remote file into a temporary one here, for the store to copy. */
    async function fetchRemote(input, ctx) {
        const resolved = resolveSession(input, ctx);
        if (resolved.error) return { error: resolved.error };
        const remote = String(input.remotePath);
        const temp = path.join(os.tmpdir(), `acestes-file-${crypto.randomBytes(6).toString('hex')}`);
        const result = await sftp.withSftp(resolved.sessionId, (handle, done) => {
            handle.stat(remote, (statError, attrs) => {
                if (statError) return done({ error: `Could not read ${remote}: ${statError.message}` });
                if (attrs.isDirectory?.()) return done({ error: `${remote} is a directory.` });
                if (attrs.size > files.MAX_BYTES) {
                    return done({ error: `${remote} is ${sizeLabel(attrs.size)}, more than the ${sizeLabel(files.MAX_BYTES)} a file in the inventory may be.` });
                }
                handle.fastGet(remote, temp, (error) => done(error ? { error: `Could not download ${remote}: ${error.message}` } : { ok: true }));
                return undefined;
            });
        });
        if (!result?.ok) {
            await fs.promises.rm(temp, { force: true }).catch(() => {});
            return { error: result?.error || result?.message || 'SFTP could not be opened on that session.' };
        }
        return {
            fromPath: temp,
            cleanup: () => fs.promises.rm(temp, { force: true }).catch(() => {}),
            defaultName: baseName(remote),
            source: `${resolved.info.hostName || resolved.info.address || resolved.sessionId}:${remote}`,
        };
    }

    async function fetchUrl(url) {
        let parsed;
        try {
            parsed = new URL(String(url));
        } catch {
            return { error: `"${url}" is not a URL.` };
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) return { error: 'Only http and https URLs can be fetched.' };
        let response;
        try {
            response = await fetch(parsed, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
        } catch (error) {
            return { error: `Could not fetch ${parsed.href}: ${error.message}` };
        }
        if (!response.ok) return { error: `${parsed.href} answered ${response.status} ${response.statusText}.` };
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > files.MAX_BYTES) return { error: `${parsed.href} is ${sizeLabel(declared)}, more than a file in the inventory may be.` };
        const data = Buffer.from(await response.arrayBuffer());
        if (data.length > files.MAX_BYTES) return { error: `${parsed.href} is ${sizeLabel(data.length)}, more than a file in the inventory may be.` };
        const disposition = response.headers.get('content-disposition') || '';
        const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
        return {
            data,
            defaultName: baseName(named || parsed.pathname) || parsed.hostname,
            mime: (response.headers.get('content-type') || '').split(';')[0].trim(),
            source: parsed.href,
        };
    }

    /** Where new bytes come from: exactly one of the source fields. */
    async function gather(input, ctx) {
        const given = SOURCE_FIELDS.filter(field => input[field] !== undefined && input[field] !== '');
        if (given.length === 0) return { none: true };
        if (given.length > 1) return { error: `Give one source, not ${given.join(' and ')}.` };
        switch (given[0]) {
            case 'content':
                return { data: Buffer.from(String(input.content), 'utf8'), source: 'written by the agent' };
            case 'base64': {
                const text = String(input.base64).replace(/\s+/g, '');
                if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) return { error: 'That base64 is not valid.' };
                return { data: Buffer.from(text, 'base64'), source: 'written by the agent' };
            }
            case 'localPath': {
                const target = localTarget(ctx, input.localPath, 'read');
                if (target.error) return { error: target.error };
                return { fromPath: target.path, defaultName: path.basename(target.path), source: target.shownAs };
            }
            case 'remotePath':
                return fetchRemote(input, ctx);
            case 'url':
                return fetchUrl(input.url);
            default:
                return { error: 'Unknown source.' };
        }
    }

    const sourceShape = {
        content: z.string().optional().describe('The file\'s contents as text.'),
        base64: z.string().optional().describe('The file\'s contents as base64, for a binary file you have in hand.'),
        localPath: z.string().optional().describe('A file on this computer to copy in, inside a folder granted to you (under /workspace in a container).'),
        remotePath: z.string().optional().describe('A file on a server to download over SFTP; give `session` too.'),
        session: z.string().optional().describe('With remotePath: the session id. Defaults to the session in front of the user.'),
        url: z.string().optional().describe('An http or https URL to download.'),
    };

    return [
        {
            name: 'list_files',
            title: 'List your files',
            readOnly: true,
            description:
                'List the files in your inventory: documents, scripts, archives, images and anything else you or '
                + 'the user saved there to keep. Each comes with its id, size and type, and a reference such as '
                + '{{file:report.pdf}} that becomes the file\'s path on this computer inside run_local_command. '
                + 'Shared files belong to every agent; you can read and send those, but change only your own.',
            shape: {
                query: z.string().optional().describe('Filter by name, description or tag. Omit to list everything.'),
            },
            handler: async (input, ctx) => {
                const needle = String(input.query || '').trim().toLowerCase();
                const found = bagFor(ctx).list().filter(file => !needle
                    || [file.name, file.description, ...(file.tags || [])].join(' ').toLowerCase().includes(needle));
                return ok({ total: found.length, files: found.slice(0, MAX_LIST).map(shown) });
            },
        },

        {
            name: 'read_inventory_file',
            title: 'Read one of your files',
            readOnly: true,
            description:
                'Read a file from your inventory, by name or id. Text comes back as text, with `offset` and '
                + '`limit` to read a stretch of a long one by line; an image (PNG, JPEG, GIF, WebP) comes back '
                + 'as a picture you can see; anything else gives its details, or its bytes as base64 when you ask '
                + 'for encoding "base64" (up to 1 MB). For a PDF, an archive or a document, process it with '
                + 'run_local_command and {{file:name}} instead.',
            shape: {
                file: z.string().describe('The file\'s name or id, from list_files.'),
                offset: z.number().int().min(1).optional().describe('The first line to return, counting from 1.'),
                limit: z.number().int().min(1).max(5000).optional().describe('How many lines to return.'),
                encoding: z.enum(['text', 'base64']).optional().describe('"base64" for the raw bytes of a binary file.'),
            },
            handler: async (input, ctx) => {
                const bag = bagFor(ctx);
                const file = bag.get(input.file);
                if (!file) return fail(`There is no file "${input.file}" in your inventory. Call list_files for the list.`);

                if (input.encoding === 'base64') {
                    const read = await bag.readBytes(file.id, { max: MAX_BASE64 });
                    if (read.error) return fail(read.error);
                    return ok({ ...shown(file), truncated: read.truncated || undefined, base64: read.data.toString('base64') });
                }

                if (IMAGE_TYPES.has(file.mime) && file.size <= MAX_IMAGE) {
                    const read = await bag.readBytes(file.id, { max: MAX_IMAGE });
                    if (read.error) return fail(read.error);
                    return {
                        text: JSON.stringify(shown(file), null, 2),
                        images: [{ data: read.data.toString('base64'), mediaType: file.mime }],
                    };
                }

                const read = await bag.readBytes(file.id, { max: MAX_SCAN });
                if (read.error) return fail(read.error);
                if (!read.text) {
                    return ok({
                        ...shown(file),
                        note: 'This is a binary file. Use run_local_command with {{file:' + file.name + '}} to process it, '
                            + 'send_inventory_file to put it somewhere, or encoding "base64" for its bytes.',
                    });
                }
                const stretch = lines(read.data.toString('utf8'), input.offset, input.limit);
                const clipped = stretch.text.length > MAX_TEXT;
                return ok({
                    name: file.name,
                    size: file.size,
                    lines: stretch.to ? `${stretch.from}-${stretch.to} of ${stretch.total}` : undefined,
                    truncated: clipped || read.truncated || undefined,
                    note: clipped || read.truncated ? 'Only part of the file. Use offset and limit to read the rest.' : undefined,
                    content: clipped ? stretch.text.slice(0, MAX_TEXT) : stretch.text,
                });
            },
        },

        {
            name: 'save_inventory_file',
            title: 'Save a file to your inventory',
            // Like a memory note: it adds to the agent's own bag and touches no
            // machine, so it is waved through. `writes` keeps it out of a run
            // promised to change nothing. It never replaces a file; that is
            // update_inventory_file, which asks.
            readOnly: true,
            writes: true,
            description:
                'Keep a new file in your inventory, from exactly one source: text you write (`content`), bytes '
                + 'in base64, a file on this computer inside a granted folder (`localPath`), a file on a server '
                + 'over SFTP (`remotePath` with `session`), or a download (`url`). The user sees it under '
                + 'Inventory, Files. A name you already have is refused; use update_inventory_file to replace one.',
            shape: {
                name: z.string().optional().describe('The file name, with its extension. Defaults to the source\'s own name.'),
                ...sourceShape,
                description: z.string().max(500).optional().describe('A line on what the file is, for you and the user later.'),
                tags: z.array(z.string()).optional().describe('Up to eight short tags.'),
            },
            handler: async (input, ctx) => {
                const source = await gather(input, ctx);
                if (source.none) return fail(`Give the file's contents: one of ${SOURCE_FIELDS.join(', ')}.`);
                if (source.error) return fail(source.error);
                try {
                    const name = input.name || source.defaultName;
                    if (!name) return fail('Give the file a name.');
                    const kept = await bagFor(ctx).add({
                        name,
                        data: source.data || null,
                        fromPath: source.fromPath || '',
                        mime: source.mime || '',
                        description: input.description,
                        tags: input.tags,
                        source: source.source,
                    });
                    if (kept.error) return fail(kept.error);
                    changed(ctx);
                    return ok({ saved: true, ...shown(kept.file), sizeLabel: sizeLabel(kept.file.size) });
                } finally {
                    await source.cleanup?.();
                }
            },
        },

        {
            name: 'update_inventory_file',
            title: 'Change one of your files',
            readOnly: false,
            description:
                'Change a file of your own: rename it, change its description or tags, or replace its contents '
                + 'from one source (content, base64, localPath, remotePath with session, or url). Replacing '
                + 'discards what was there; read it first if you have not. Shared files are the user\'s.',
            shape: {
                file: z.string().describe('The file\'s name or id.'),
                name: z.string().optional().describe('A new name.'),
                description: z.string().max(500).optional().describe('A new description; empty to clear it.'),
                tags: z.array(z.string()).optional().describe('New tags, replacing the old.'),
                ...sourceShape,
            },
            handler: async (input, ctx) => {
                const bag = bagFor(ctx);
                const file = bag.get(input.file);
                if (!file) return fail(`There is no file "${input.file}" in your inventory.`);
                const source = await gather(input, ctx);
                if (source.error) return fail(source.error);
                try {
                    let current = file;
                    if (!source.none) {
                        const replaced = await bag.replace(file.id, {
                            data: source.data || null,
                            fromPath: source.fromPath || '',
                            source: source.source,
                        });
                        if (replaced.error) return fail(replaced.error);
                        current = replaced.file;
                    }
                    if (input.name !== undefined || input.description !== undefined || input.tags !== undefined) {
                        const updated = await bag.update(current.id, {
                            name: input.name,
                            description: input.description,
                            tags: input.tags,
                        });
                        if (updated.error) return fail(updated.error);
                        current = updated.file;
                    } else if (source.none) {
                        return fail('Nothing to change: give a new name, description, tags or contents.');
                    }
                    changed(ctx);
                    return ok({ updated: true, contentsReplaced: !source.none || undefined, ...shown(current) });
                } finally {
                    await source.cleanup?.();
                }
            },
        },

        {
            name: 'send_inventory_file',
            title: 'Send one of your files',
            readOnly: false,
            description:
                'Send a file from your inventory somewhere. to "server": upload it over SFTP to `path` on a '
                + 'session\'s server. to "local": copy it to `path` on this computer, inside a folder granted to '
                + 'you for writing. to "agent": put a copy in another agent\'s inventory, named by `agent` (your '
                + 'own name makes a copy of a shared file that is yours to change). A path ending in / is a '
                + 'directory and keeps the file\'s name. Something already there is only replaced with overwrite.',
            shape: {
                file: z.string().describe('The file\'s name or id.'),
                to: z.enum(['server', 'local', 'agent']).describe('Where it goes.'),
                path: z.string().optional().describe('For server and local: where to put it, a file path or a directory ending in /.'),
                session: z.string().optional().describe('For server: the session id. Defaults to the session in front of the user.'),
                agent: z.string().optional().describe('For agent: the agent\'s name or id.'),
                name: z.string().optional().describe('For agent: the name the copy gets. Defaults to the file\'s own.'),
                overwrite: z.boolean().optional().describe('Replace what is already at the destination.'),
            },
            handler: async (input, ctx) => {
                const bag = bagFor(ctx);
                const file = bag.get(input.file);
                if (!file) return fail(`There is no file "${input.file}" in your inventory.`);
                const from = bag.pathOf(file.id);

                if (input.to === 'agent') {
                    const target = findAgent(input.agent || '');
                    if (!target) return fail(`There is no agent called "${input.agent || ''}".`);
                    const copied = await bag.copyTo(file.id, target.id, { name: input.name, overwrite: Boolean(input.overwrite) });
                    if (copied.error) return fail(copied.error);
                    changed(ctx);
                    return ok({ sent: true, to: target.name, replaced: copied.replaced || undefined, file: shown(copied.file) });
                }

                const wanted = String(input.path || '').trim();
                if (!wanted) return fail('Give the path to send it to.');

                if (input.to === 'local') {
                    const target = localTarget(ctx, wanted, 'write');
                    if (target.error) return fail(target.error);
                    let dest = target.path;
                    const isDir = /[\\/]$/.test(wanted) || (fs.existsSync(dest) && fs.statSync(dest).isDirectory());
                    if (isDir) dest = path.join(dest, file.name);
                    if (fs.existsSync(dest) && !input.overwrite) {
                        return fail(`${dest} already exists. Pass overwrite: true only if the user wants it replaced.`);
                    }
                    try {
                        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
                        await fs.promises.copyFile(from, dest);
                    } catch (error) {
                        return fail(`Could not copy to ${dest}: ${error.message}`);
                    }
                    const shownAs = containerised(ctx) && target.shownAs
                        ? (isDir ? path.posix.join(target.shownAs, file.name) : target.shownAs)
                        : dest;
                    return ok({ sent: true, to: shownAs, size: file.size });
                }

                // A server, over the session's SFTP channel.
                const resolved = resolveSession(input, ctx);
                if (resolved.error) return fail(resolved.error);
                const result = await sftp.withSftp(resolved.sessionId, (handle, done) => {
                    const put = (dest) => {
                        handle.stat(dest, (statError) => {
                            if (!statError && !input.overwrite) {
                                return done({ error: `${dest} already exists on the server. Pass overwrite: true only if the user wants it replaced.` });
                            }
                            handle.fastPut(from, dest, (error) => (
                                done(error ? { error: `Could not upload to ${dest}: ${error.message}` } : { ok: true, dest })
                            ));
                            return undefined;
                        });
                    };
                    if (wanted.endsWith('/')) {
                        put(`${wanted}${file.name}`);
                        return;
                    }
                    handle.stat(wanted, (statError, attrs) => {
                        put(!statError && attrs.isDirectory?.() ? `${wanted.replace(/\/+$/, '')}/${file.name}` : wanted);
                    });
                });
                if (!result?.ok) return fail(result?.error || result?.message || 'SFTP could not be opened on that session.');
                return ok({
                    sent: true,
                    to: `${resolved.info.hostName || resolved.info.address}:${result.dest}`,
                    size: file.size,
                });
            },
        },

        {
            name: 'delete_inventory_file',
            title: 'Delete one of your files',
            readOnly: false,
            description:
                'Delete a file of your own from your inventory, for good. Only when the user asked for it to go, '
                + 'or for a file you made yourself and no longer need. Shared files are the user\'s.',
            shape: {
                file: z.string().describe('The file\'s name or id.'),
            },
            handler: async (input, ctx) => {
                const result = await bagFor(ctx).remove(input.file);
                if (result.error) return fail(result.error);
                changed(ctx);
                return ok({ deleted: true, name: result.file.name });
            },
        },
    ];
}

/**
 * Every `{{file:name}}` in a local command and its env made the file's path,
 * or why it cannot be. A container cannot see this disk, so there the agent
 * is told to send the file into its workspace instead.
 */
function resolveLocal(ctx, command, env) {
    const values = [command, ...Object.values(env || {})];
    if (!values.some(files.refersToFiles)) return { command, env };
    if (containerised(ctx)) {
        return {
            error: '{{file:...}} is a path on this computer, which your container cannot see. Copy the file into '
                + 'a mounted folder first with send_inventory_file to "local" and a /workspace path, and use that path.',
        };
    }
    const bag = bagFor(ctx);
    const missing = new Set();
    const fill = (text) => {
        const resolved = bag.resolve(text);
        for (const name of resolved.missing) missing.add(name);
        return resolved.text;
    };
    const out = { command: fill(command), env: env ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, fill(v)])) : env };
    if (missing.size) {
        return { error: `There is no file ${[...missing].map(name => `"${name}"`).join(', ')} in your inventory. Call list_files for the names.` };
    }
    return out;
}

module.exports = { build, resolveLocal, localTarget };

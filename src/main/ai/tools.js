const zodModule = require('zod');
const store = require('../store');
const ssh = require('../ssh');
const sftp = require('../sftp');
const transcript = require('../transcript');
const exec = require('./exec');
const terminalRun = require('./terminal-run');
const memory = require('./memory');
const local = require('./local');
const checkpoints = require('./checkpoints');
const inventoryTools = require('./inventory-tools');
const jobTools = require('./job-tools');
const delegationTools = require('./delegation-tools');
const computerTools = require('./computer-tools');

// zod 4 exports both a namespace and a `z` binding depending on how it is
// reached. Taking either keeps this working whichever the installed build is.
const z = zodModule.z || zodModule;

/**
 * What the assistant can actually do.
 *
 * These are written once, in a neutral shape, and adapted by each provider:
 * Claude Code wants them as an in-process MCP server, and whatever comes next
 * will want JSON Schema and a loop of its own. Neither of those concerns
 * belongs in a file about what a tool does, so neither is in here.
 *
 * Two rules shape the whole set.
 *
 * The assistant never sees a credential. It asks for a session or a host by
 * id, and the main process resolves that to a connection the user already
 * opened with their own keys. There is no tool that returns a password, and
 * no tool that takes one. A model that is asked to "log in to the database"
 * has to do it the way a person would, through a shell that is already
 * authenticated.
 *
 * Every tool declares whether it only reads. That single flag is what the
 * approval policy is built on, so a tool added later is refused by default
 * until someone decides which side of that line it is on.
 */

/** How much of a remote file one read may return. */
const MAX_FILE_BYTES = 120000;

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/**
 * Whether the user has pinned this conversation to an explicit set of servers.
 *
 * The other two scopes are not fences. Following the session in front is a
 * default for calls that name none, and "all hosts" is the absence of a limit.
 * Only a set the user ticked is enforced here.
 */
function fenced(ctx) {
    return ctx?.scope === 'targets';
}

/**
 * Whether one session is inside the fence.
 *
 * Two ways in: the session itself was ticked, or the host behind it was. The
 * second is what makes a pinned host mean the machine rather than one terminal
 * on it, and it is also what lets `connect_host` be useful: the session it
 * opens did not exist when the user was ticking boxes, and it has to be usable
 * the moment it does.
 */
/**
 * Whether a session belongs to some other agent.
 *
 * A session the user opened by hand belongs to nobody and every agent may
 * use it. One an agent opened through connect_host is that agent's, and the
 * others are kept off it unless the envelope says `sessions: 'any'`. This is
 * the fence that makes two agents in one window two agents, rather than one
 * agent with two names: it is enforced here, in front of every tool that
 * takes a session, and not asked for in the prompt.
 */
function ownedElsewhere(ctx, sessionId) {
    if (!ctx?.agentId || ctx.sandbox?.sessions === 'any') return false;
    const info = transcript.info(sessionId);
    return Boolean(info?.agentId && info.agentId !== ctx.agentId);
}

function sessionInScope(ctx, sessionId) {
    if (ownedElsewhere(ctx, sessionId)) return false;
    if (!fenced(ctx)) return true;
    if (ctx.sessionIds.includes(sessionId)) return true;
    const info = transcript.info(sessionId);
    return Boolean(info?.hostId && ctx.hostIds.includes(info.hostId));
}

function hostInScope(ctx, hostId) {
    if (!fenced(ctx)) return true;
    if (ctx.hostIds.includes(hostId)) return true;
    // The host behind a pinned session, so a session opened from the Hosts page
    // does not leave its own host unnameable.
    return ctx.sessionIds.some(id => transcript.info(id)?.hostId === hostId);
}

/** What is inside the fence, named the way the tools take it. */
function scopeSummary(ctx) {
    const open = transcript.list().filter(session => sessionInScope(ctx, session.sessionId));
    const parts = open.map(session => `${session.sessionId} (${session.hostName || session.address})`);
    for (const hostId of ctx.hostIds) {
        if (open.some(session => session.hostId === hostId)) continue;
        parts.push(`host ${hostId} (not connected)`);
    }
    return parts.join(', ') || 'nothing that is currently open';
}

/** The refusal, written so the model's next move is a correct one. */
function outOfScope(ctx, what) {
    return `${what} is outside the set the user pinned this conversation to. `
        + `In scope: ${scopeSummary(ctx)}. `
        + 'Do not try to reach anything else; if the task needs it, say so and let the user widen the scope.';
}

/**
 * Which session a call is about.
 *
 * A tool may name one explicitly. When it does not, the session the panel is
 * pinned to is used, which is what makes "restart nginx" mean the obvious
 * thing while looking at a server. With neither, the error lists what is open
 * rather than just saying no: the model's next move should be to pick one, and
 * it needs the ids to do that.
 *
 * A pinned set is enforced here, which is the one place every tool that touches
 * a server passes through. Two servers ticked in the menu is a promise the app
 * keeps, not an instruction the model agrees to and then forgets six calls
 * later.
 */
function resolveSession(input, ctx) {
    const requested = input?.session ? String(input.session) : '';
    const chosen = requested || ctx.boundSessionId || '';

    if (!chosen) {
        const open = transcript.list().filter(session => sessionInScope(ctx, session.sessionId));
        if (open.length === 0) {
            return fenced(ctx)
                ? { error: `Nothing in scope is open. In scope: ${scopeSummary(ctx)}.` }
                : { error: 'No sessions are open. Ask the user to connect to a host, or use connect_host.' };
        }
        return {
            error: 'This call needs a session id. Open sessions: '
                + open.map(s => `${s.sessionId} (${s.hostName || s.address})`).join(', '),
        };
    }

    if (ownedElsewhere(ctx, chosen)) {
        return {
            error: `Session "${chosen}" was opened by another agent and is not yours to use. `
                + 'Use list_sessions for the ones you can, or connect_host to open your own.',
        };
    }

    if (!sessionInScope(ctx, chosen)) {
        return { error: outOfScope(ctx, `Session "${chosen}"`) };
    }

    const info = transcript.info(chosen);
    if (!info) {
        return { error: `There is no open session with the id "${chosen}". Call list_sessions for the current list.` };
    }
    return { sessionId: chosen, info };
}

function ok(payload) {
    return { text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) };
}

/**
 * A result as MCP content: its text, then any pictures it carries (a
 * screenshot). The pictures go to the runtime and on to the model; the
 * transcript is built from the text alone, so they never pile up in the
 * saved history.
 */
function contentOf(result) {
    const content = [{ type: 'text', text: String(result?.text ?? '') }];
    for (const image of Array.isArray(result?.images) ? result.images : []) {
        if (image?.data) content.push({ type: 'image', data: image.data, mimeType: image.mediaType || 'image/png' });
    }
    return content;
}

function fail(message) {
    return { text: message, isError: true };
}

/**
 * How much of a long text one result carries. Below what Claude Code lets an
 * MCP result be before it spills to a file, JSON escaping included.
 */
const PAGE_CHARS = 30000;

/**
 * One page of a long text, from `offset`, ended on a line break when there is
 * one in the back half of the page so a message is not cut mid-word.
 * `nextOffset` is null on the last page.
 */
function pageOf(text, offset = 0, size = PAGE_CHARS) {
    const start = Math.max(0, Math.min(Number(offset) || 0, text.length));
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
        const newline = text.lastIndexOf('\n', end);
        if (newline > start + size / 2) end = newline + 1;
    }
    return { offset: start, text: text.slice(start, end), nextOffset: end < text.length ? end : null };
}

/**
 * An SFTP call, with the two failure shapes reconciled.
 *
 * `withSftp` answers with its own `{ success, message }` when the subsystem
 * could not be opened at all, which is not a tool result and would otherwise
 * reach the model as an empty success: the worst possible reading of "the
 * connection is dead".
 */
async function viaSftp(sessionId, fn) {
    const result = await sftp.withSftp(sessionId, fn);
    if (result && typeof result.text === 'string') return result;
    return fail(result?.message || 'SFTP could not be opened on that session.');
}

/**
 * The hosts in the agent's inventory: its own, and the ones that belong to no
 * agent in particular, which is what a synced or imported host is.
 */
function agentHosts(ctx) {
    return store.getHosts().filter(host => !host.agentId || !ctx?.agentId || host.agentId === ctx.agentId);
}

/** A saved host, with everything the assistant has no business seeing gone. */
function publicHost(host) {
    return {
        id: host.id,
        name: host.name,
        protocol: host.protocol || 'ssh',
        address: host.protocol === 'serial'
            ? (host.serial?.path || '')
            : [host.host, host.port].filter(Boolean).join(':'),
        username: host.username || '',
        authMethod: host.authMethod || '',
        tags: host.tags || [],
        folderId: host.folderId || '',
        os: host.os || '',
        distro: host.distro || '',
        viaJumpHost: Boolean(host.jumpHostId),
        viaProxy: Boolean(host.proxyId),
        lastConnectedAt: host.lastConnectedAt || 0,
    };
}

/* ------------------------------------------------------------------ *
 * The catalog
 * ------------------------------------------------------------------ */

const TOOLS = [
    {
        name: 'list_hosts',
        title: 'List saved hosts',
        readOnly: true,
        description:
            'List the hosts saved in this app, with their names, addresses, tags and folders. '
            + 'Use this to find the id of a host before connecting to it, or to answer questions about '
            + 'what infrastructure the user has. Never returns passwords or keys.',
        shape: {
            query: z.string().optional().describe('Filter by name, address, or tag. Omit to list everything.'),
            limit: z.number().int().min(1).max(500).optional().describe('Maximum hosts to return. Defaults to 200.'),
        },
        handler: async (input, ctx) => {
            const hosts = agentHosts(ctx);
            const folders = await store.getFolders();
            const folderName = new Map(folders.map(folder => [folder.id, folder.name]));

            // A pinned conversation sees the hosts it was pinned to and no
            // others. Returning the whole estate would be a list of machines
            // that every other tool then refuses, which reads as a bug rather
            // than as a boundary.
            const reachable = hosts.filter(host => hostInScope(ctx, host.id));

            const needle = String(input.query || '').trim().toLowerCase();
            const matched = reachable.filter((host) => {
                if (!needle) return true;
                const haystack = [
                    host.name, host.host, host.username,
                    ...(host.tags || []),
                    folderName.get(host.folderId) || '',
                ].join(' ').toLowerCase();
                return haystack.includes(needle);
            });

            const limit = input.limit || 200;
            return ok({
                total: matched.length,
                returned: Math.min(matched.length, limit),
                scoped: fenced(ctx) || undefined,
                note: fenced(ctx)
                    ? 'Only the hosts the user pinned this conversation to are listed.'
                    : undefined,
                hosts: matched.slice(0, limit).map(host => ({
                    ...publicHost(host),
                    folder: folderName.get(host.folderId) || '',
                })),
            });
        },
    },

    {
        name: 'list_sessions',
        title: 'List open sessions',
        readOnly: true,
        description:
            'List the terminal sessions currently open in the app. Each has a session id, which every '
            + 'other tool uses to say which server to act on. The session marked "current" is the one '
            + 'the user is looking at.',
        shape: {},
        handler: async (input, ctx) => {
            const open = transcript.list().filter(session => sessionInScope(ctx, session.sessionId));
            return ok({
                count: open.length,
                current: ctx.boundSessionId || null,
                scoped: fenced(ctx) || undefined,
                note: fenced(ctx)
                    ? 'Only the sessions the user pinned this conversation to are listed. '
                        + 'Other terminals may be open; they are not yours to use.'
                    : undefined,
                sessions: open.map(session => ({
                    ...session,
                    current: session.sessionId === ctx.boundSessionId,
                    canRunCommands: Boolean(ssh.sessions.get(session.sessionId)?.client),
                })),
            });
        },
    },

    {
        name: 'read_terminal',
        title: 'Read terminal output',
        readOnly: true,
        description:
            'Read what a session recently printed on screen, as plain text with the colour codes '
            + 'stripped. This is the fastest way to understand what the user is looking at, what they '
            + 'just ran, and what error they are asking about. Read this before asking them to paste '
            + 'anything.',
        shape: {
            session: z.string().optional().describe('Session id. Defaults to the session in front of the user.'),
            lines: z.number().int().min(1).max(2000).optional().describe('How many trailing lines to return.'),
        },
        handler: async (input, ctx) => {
            const resolved = resolveSession(input, ctx);
            if (resolved.error) return fail(resolved.error);

            const result = transcript.read(resolved.sessionId, {
                lines: input.lines || ctx.settings.transcriptLines,
            });
            if (!result.available) return fail('That session has no output recorded yet.');
            if (!result.text.trim()) return ok('The session has produced no output yet.');

            return ok(
                `Terminal output for ${resolved.info.hostName || resolved.info.address}`
                + `${result.truncated ? ' (trimmed to the most recent output)' : ''}:\n\n${result.text}`
            );
        },
    },

    {
        name: 'run_command',
        title: 'Run a command',
        readOnly: false,
        description:
            'Run a shell command on a session\'s server. By default it is typed into the terminal the '
            + 'user is watching, so they see it happen and the output stays in their scrollback, and it '
            + 'returns what appeared on screen. It is not interactive: a command that stops to ask '
            + 'something will sit there until the timeout, so pass flags like -y, and use send_input to '
            + 'answer a prompt that is already waiting. Prefer one command per call so failures are '
            + 'attributable. Set background: true only when the output is for you rather than for them, '
            + 'such as a quick probe you are about to act on; that runs on a separate channel, returns a '
            + 'real exit code, and they see nothing.',
        shape: {
            session: z.string().optional().describe('Session id. Defaults to the session in front of the user.'),
            command: z.string().min(1).describe('The command to run, exactly as it would be typed.'),
            background: z.boolean().optional().describe('Run out of sight on a separate channel instead of in the user\'s terminal. Returns an exit code. Defaults to the user\'s own setting.'),
            cwd: z.string().optional().describe('Directory to run in. Background calls each start a fresh shell, so a cd in one does not carry to the next.'),
            timeoutSeconds: z.number().int().min(1).max(600).optional().describe('How long to allow before giving up on it. Defaults to 60.'),
        },
        handler: async (input, ctx) => {
            const resolved = resolveSession(input, ctx);
            if (resolved.error) return fail(resolved.error);

            // Checked here as well as at the approval gate. The gate is what
            // keeps a pointless card off the screen; this is what makes the
            // rule true, because every provider reaches a server through this
            // function and one that forgot the gate would otherwise walk past
            // the list entirely.
            const blocked = blockedReason('run_command', input, ctx.settings);
            if (blocked) return fail(blockedMessage(blocked));

            const timeout = (input.timeoutSeconds || 60) * 1000;
            const background = input.background === undefined
                ? ctx.settings.commandMode === 'background'
                : input.background;

            if (!background) {
                const result = await terminalRun.run(resolved.sessionId, input.command, {
                    timeout,
                    sessionAction: ctx.sessionAction,
                });
                if (!result.success) return fail(result.message);

                // No exit code on this path: a PTY does not carry one. Saying
                // so is better than leaving the model to infer success from
                // output that happens to look calm.
                const parts = [result.output || '(no output)'];
                if (!result.completed) parts.push(result.note);
                else parts.push('(the shell returned to a prompt; a PTY carries no exit code, '
                    + 'so judge the result from the output)');

                return ok(parts.filter(Boolean).join('\n\n'));
            }

            const result = await exec.run(resolved.sessionId, input.command, {
                timeout,
                cwd: input.cwd || '',
            });

            if (!result.success) {
                return fail(result.message + (result.stdout ? `\n\nOutput before it stopped:\n${result.stdout}` : ''));
            }

            const parts = [`exit code: ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ''}`];
            if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
            if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
            if (!result.stdout && !result.stderr) parts.push('(no output)');
            if (result.truncated) parts.push('(output was trimmed to its most recent portion)');

            // A non-zero exit is reported as a normal result rather than an
            // error. It is information, and very often the answer: flagging it
            // as a tool failure invites a retry of something that worked.
            return ok(parts.join('\n\n'));
        },
    },

    {
        name: 'send_input',
        title: 'Type into the terminal',
        readOnly: false,
        description:
            'Type text into the terminal the user is watching, as if they had typed it, then return '
            + 'whatever appeared on screen afterwards. Use this only when run_command will not do: '
            + 'answering a prompt that is already waiting, driving an interactive program, or when the '
            + 'user should see the command land in their own shell. This does go into their shell '
            + 'history and does disturb anything half-typed at the prompt.',
        shape: {
            session: z.string().optional().describe('Session id. Defaults to the session in front of the user.'),
            text: z.string().describe('The text to type.'),
            submit: z.boolean().optional().describe('Press Enter after the text. Defaults to true.'),
            waitMs: z.number().int().min(0).max(30000).optional().describe('How long to wait before reading the screen back. Defaults to 1500.'),
        },
        handler: async (input, ctx) => {
            const resolved = resolveSession(input, ctx);
            if (resolved.error) return fail(resolved.error);

            // Typing reaches the same shell that run_command does, so it
            // answers to the same list. Without this the block would be one
            // tool call wide.
            const blocked = blockedReason('send_input', input, ctx.settings);
            if (blocked) return fail(blockedMessage(blocked));

            const session = ssh.sessions.get(resolved.sessionId);
            const mark = transcript.cursor(resolved.sessionId);
            const payload = input.text + (input.submit === false ? '' : '\n');

            // SSH writes to the shell stream directly. Other transports are
            // reached through the renderer, which owns their input path.
            if (session?.stream?.writable) {
                session.stream.write(payload);
            } else {
                const delivered = await ctx.sessionAction({
                    action: 'input',
                    sessionId: resolved.sessionId,
                    data: payload,
                });
                if (!delivered?.success) {
                    return fail(delivered?.message || 'That session could not accept input.');
                }
            }

            const wait = input.waitMs === undefined ? 1500 : input.waitMs;
            if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));

            const after = transcript.read(resolved.sessionId, { since: mark, lines: ctx.settings.transcriptLines });
            return ok(
                `Sent. What appeared on screen after it:\n\n${after.text || '(nothing yet)'}`
                + '\n\nIf that looks incomplete, the command may still be running. Read the terminal again rather than sending it twice.'
            );
        },
    },

    {
        name: 'list_directory',
        title: 'List a directory',
        readOnly: true,
        description:
            'List a directory on a session\'s server over SFTP, with sizes, permissions and modified '
            + 'times. Use this instead of running ls when you want structured results.',
        shape: {
            session: z.string().optional().describe('Session id. Defaults to the session in front of the user.'),
            path: z.string().describe('Absolute path to list. Use "." for the login directory.'),
        },
        handler: async (input, ctx) => {
            const resolved = resolveSession(input, ctx);
            if (resolved.error) return fail(resolved.error);

            const target = input.path === '.' || !input.path
                ? (await sftp.home(resolved.sessionId))?.path || '.'
                : input.path;

            const result = await sftp.list(resolved.sessionId, target);
            if (!result.success) return fail(result.message || 'That directory could not be listed.');

            return ok({
                path: target,
                entries: (result.files || []).map(entry => ({
                    name: entry.name,
                    type: entry.isDirectory ? 'directory' : entry.isSymlink ? 'symlink' : 'file',
                    size: entry.size,
                    permissions: entry.permissions || entry.mode,
                    modifiedAt: entry.modifiedAt || entry.mtime,
                })),
            });
        },
    },

    {
        name: 'read_file',
        title: 'Read a remote file',
        readOnly: true,
        description:
            'Read a text file from a session\'s server over SFTP. Use this for config files and logs '
            + 'rather than running cat, because it returns the file cleanly and tells you when it was '
            + 'trimmed. Reads with the same access the user already has on that server.',
        shape: {
            session: z.string().optional().describe('Session id. Defaults to the session in front of the user.'),
            path: z.string().describe('Absolute path to the file.'),
        },
        handler: async (input, ctx) => {
            const resolved = resolveSession(input, ctx);
            if (resolved.error) return fail(resolved.error);

            return viaSftp(resolved.sessionId, (handle, resolve) => {
                handle.stat(input.path, (statError, attrs) => {
                    if (statError) {
                        resolve(fail(`Could not read ${input.path}: ${statError.message}`));
                        return;
                    }
                    if (attrs.size > MAX_FILE_BYTES * 8) {
                        resolve(fail(
                            `${input.path} is ${Math.round(attrs.size / 1024)} KB, which is too large to read whole. `
                            + 'Use run_command with tail, head or grep to get the part you need.'
                        ));
                        return;
                    }
                    handle.readFile(input.path, (readError, data) => {
                        if (readError) {
                            resolve(fail(`Could not read ${input.path}: ${readError.message}`));
                            return;
                        }
                        const text = data.toString('utf8');
                        const trimmed = text.length > MAX_FILE_BYTES;
                        resolve(ok(
                            `${input.path}${trimmed ? ' (first part only)' : ''}:\n\n`
                            + (trimmed ? text.slice(0, MAX_FILE_BYTES) : text)
                        ));
                    });
                });
            });
        },
    },

    {
        name: 'write_file',
        title: 'Write a remote file',
        readOnly: false,
        description:
            'Write a text file on a session\'s server over SFTP, replacing it if it exists. Read the '
            + 'file first so you are not discarding something you have not seen, and say in your reply '
            + 'what you changed. For a config file that matters, copy it to a .bak first with '
            + 'run_command.',
        shape: {
            session: z.string().optional().describe('Session id. Defaults to the session in front of the user.'),
            path: z.string().describe('Absolute path to write.'),
            content: z.string().describe('The complete new contents of the file.'),
        },
        handler: async (input, ctx) => {
            const resolved = resolveSession(input, ctx);
            if (resolved.error) return fail(resolved.error);

            const file = { where: 'remote', sessionId: resolved.sessionId, path: input.path };
            return viaSftp(resolved.sessionId, (handle, resolve) => {
                const write = () => handle.writeFile(input.path, input.content, { encoding: 'utf8' }, (error) => {
                    if (error) {
                        resolve(fail(`Could not write ${input.path}: ${error.message}`));
                        return;
                    }
                    ctx.checkpoint?.after(file, { existed: true, content: input.content });
                    resolve(ok(`Wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}.`));
                });
                // Read first, only so the turn's undo has something to put
                // back. A file that is not there is recorded as not there,
                // and one too big to hold is not read at all.
                handle.stat(input.path, (statError, attrs) => {
                    if (statError || attrs.size > checkpoints.MAX_BYTES) {
                        ctx.checkpoint?.before(file, statError?.code === 2 ? { existed: false, content: '' } : null);
                        write();
                        return;
                    }
                    handle.readFile(input.path, (readError, data) => {
                        ctx.checkpoint?.before(file, readError ? null : { existed: true, content: data.toString('utf8') });
                        write();
                    });
                });
            });
        },
    },

    {
        name: 'connect_host',
        title: 'Connect to a host',
        readOnly: false,
        description:
            'Open a new terminal session to a saved host, in a new tab in the app. Returns the new '
            + 'session id once it is connected, which you can then use with the other tools. Use '
            + 'list_hosts first to find the host id. Connecting uses the credentials the user already '
            + 'saved; you never see or supply them.',
        shape: {
            hostId: z.string().describe('The id of a saved host, from list_hosts.'),
        },
        handler: async (input, ctx) => {
            const hosts = agentHosts(ctx);
            const host = hosts.find(entry => entry.id === input.hostId);
            if (!host) return fail(`There is no saved host with the id "${input.hostId}". Call list_hosts for the current list.`);

            // Checked before the connection rather than after: a session opened
            // out of scope has already put a tab on the user's screen by the
            // time the next tool call refuses it.
            if (!hostInScope(ctx, host.id)) {
                return fail(outOfScope(ctx, `The host "${host.name || host.id}"`));
            }

            const result = await ctx.sessionAction({ action: 'connect', hostId: host.id, hostName: host.name });
            if (!result?.success) {
                return fail(result?.message || `Could not connect to ${host.name}.`);
            }
            return ok({
                connected: true,
                sessionId: result.sessionId,
                host: publicHost(host),
                note: 'Use this session id with the other tools.',
            });
        },
    },

    {
        name: 'disconnect_session',
        title: 'Disconnect a session',
        readOnly: false,
        description:
            'Close an open terminal session. Only do this when the user has asked for it: a session '
            + 'may be holding work they have not finished.',
        shape: {
            session: z.string().describe('Session id to close.'),
        },
        handler: async (input, ctx) => {
            const resolved = resolveSession(input, ctx);
            if (resolved.error) return fail(resolved.error);

            const result = await ctx.sessionAction({ action: 'disconnect', sessionId: resolved.sessionId });
            if (!result?.success) return fail(result?.message || 'That session could not be closed.');
            return ok(`Closed the session on ${resolved.info.hostName || resolved.info.address}.`);
        },
    },

    /* -------------------------------------------------------------- *
     * Memory: the agent's own notebook, kept between conversations. See
     * memory.js. Read-only in the sense that matters to the approval policy:
     * a note changes nothing on any machine, so writing one asks nobody.
     * -------------------------------------------------------------- */

    {
        name: 'remember',
        title: 'Remember something',
        readOnly: true,
        description:
            'Save a note to your memory for later conversations: a preference the user stated, a fact '
            + 'about their environment that is not on the host record, a decision, what a fix turned '
            + 'out to be. It is shown to you at the start of every later conversation. One fact per '
            + 'call, short and specific. Never save a password, a key or a token.',
        shape: {
            text: z.string().min(1).max(1000).describe('The note, one or two sentences.'),
            tags: z.array(z.string()).optional().describe('Up to eight short tags, e.g. ["preference", "nginx"].'),
        },
        handler: async (input, ctx) => {
            const entry = memory.add(ctx.agentId, { text: input.text, tags: input.tags, source: 'agent' });
            if (!entry) return fail('There was nothing to remember.');
            return ok({ saved: true, id: entry.id, text: entry.text, tags: entry.tags });
        },
    },

    {
        name: 'recall',
        title: 'Search your memory',
        readOnly: true,
        description:
            'Search the notes you kept in earlier conversations. The newest are already in your '
            + 'context; use this for something older or more specific. Matches on words in the note '
            + 'and on its tags.',
        shape: {
            query: z.string().describe('Words to look for.'),
            limit: z.number().int().min(1).max(50).optional().describe('How many to return. Defaults to 10.'),
        },
        handler: async (input, ctx) => ok({
            matches: await memory.search(ctx.agentId, input.query, input.limit || 10),
        }),
    },

    {
        name: 'forget',
        title: 'Forget a note',
        readOnly: true,
        description:
            'Delete one of your notes by id, when it is wrong or no longer true. The id is shown '
            + 'beside each note in your context and in recall results.',
        shape: {
            id: z.string().describe('The note id, e.g. m-abc123-4.'),
        },
        handler: async (input, ctx) => (
            memory.remove(ctx.agentId, input.id)
                ? ok({ forgotten: input.id })
                : fail(`There is no note with the id "${input.id}".`)
        ),
    },

    /* -------------------------------------------------------------- *
     * This computer. Every one of these goes through local.js, which
     * reads the agent's envelope and either stays inside the folders the
     * user granted or runs inside the agent's container. See sandbox.js.
     * -------------------------------------------------------------- */

    {
        name: 'list_local_directory',
        title: 'List a local directory',
        readOnly: true,
        description:
            'List a directory on the user\'s own computer, inside a folder the user has granted this '
            + 'agent. When the agent runs in a container, paths are as seen inside it, under /workspace. '
            + 'Refused outside the granted folders.',
        shape: {
            path: z.string().optional().describe('Absolute path of the directory. Inside a container, a path under /workspace; omit for /workspace itself.'),
        },
        handler: async (input, ctx) => {
            const result = await local.list(ctx, input.path || '');
            return result.error ? fail(result.error) : ok(result);
        },
    },

    {
        name: 'read_local_file',
        title: 'Read a local file',
        readOnly: true,
        description:
            'Read a text file on the user\'s own computer, inside a folder the user has granted this '
            + 'agent. Give `offset` and `limit` to read a stretch of it by line rather than the whole '
            + 'thing, which is what you want for a long file: offset is the first line, counting from 1. '
            + 'Returns at most 120 KB. Refused outside the granted folders.',
        shape: {
            path: z.string().describe('Absolute path of the file, or a path under /workspace inside a container.'),
            offset: z.number().int().min(1).optional().describe('The first line to return, counting from 1. Omit for the start of the file.'),
            limit: z.number().int().min(1).max(5000).optional().describe('How many lines to return. Omit for the rest of the file.'),
        },
        handler: async (input, ctx) => {
            const result = await local.read(ctx, input.path, { offset: input.offset, limit: input.limit });
            return result.error ? fail(result.error) : ok(result);
        },
    },

    {
        name: 'write_local_file',
        title: 'Write a local file',
        readOnly: false,
        description:
            'Write a text file on the user\'s own computer, replacing it if it exists, inside a folder '
            + 'the user has granted this agent for writing. Parent directories are created. Refused '
            + 'outside the granted folders and in folders granted read-only.',
        shape: {
            path: z.string().describe('Absolute path of the file, or a path under /workspace inside a container.'),
            content: z.string().describe('The whole content the file should have.'),
        },
        handler: async (input, ctx) => {
            const file = local.hostPath(ctx, input.path);
            if (file) ctx.checkpoint?.before({ where: 'local', path: file }, checkpoints.readLocal(file));
            const result = await local.write(ctx, input.path, input.content);
            if (file) ctx.checkpoint?.after({ where: 'local', path: file }, checkpoints.readLocal(file));
            return result.error ? fail(result.error) : ok({ written: true, ...result });
        },
    },

    {
        name: 'run_local_command',
        title: 'Run a command on this computer',
        readOnly: false,
        description:
            'Run a shell command on the user\'s own computer and return its output and exit code. '
            + 'Runs with its working directory inside a folder the user has granted this agent, or '
            + 'inside the agent\'s container when it has one. Not for servers: use run_command with a '
            + 'session for those.',
        shape: {
            command: z.string().describe('The command line to run.'),
            cwd: z.string().optional().describe('Working directory, inside a granted folder. Defaults to the first granted folder, or /workspace in a container.'),
            // A number under a thousand is read as seconds. Nobody wants a
            // 30ms timeout, and refusing `timeout: 30` outright cost a whole
            // turn to a validation message about milliseconds.
            timeout: z.number().int().min(1).max(600000).optional().describe('How long to wait before stopping it. Milliseconds, or seconds if under 1000. Default 60 seconds.'),
            env: z.record(z.string(), z.string()).optional()
                .describe('Environment variables for this command. This is where a secret goes: a value may be a reference '
                    + 'such as {{secret:webshare}}, which the app fills in at launch, so the command line itself stays clean.'),
        },
        handler: async (input, ctx) => {
            const env = input.env && ctx.secrets ? ctx.secrets.resolveObject(input.env) : (input.env || null);
            const missing = ctx.secrets ? Object.values(input.env || {}).flatMap(value => ctx.secrets.unresolved(value)) : [];
            if (missing.length) return fail(`No stored secret is named ${missing.map(name => `"${name}"`).join(', ')}. Ask the user for it with ask_user and a secret name.`);
            const result = await local.run(ctx, input.command, {
                cwd: input.cwd || '',
                timeout: millis(input.timeout),
                env: env && Object.keys(env).length ? env : null,
            });
            if (!result.success) {
                return fail([result.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
            }
            return ok({
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                truncated: result.truncated || undefined,
            });
        },
    },

    /* -------------------------------------------------------------- *
     * Editing in place, remote and local.
     *
     * A replacement of one passage rather than a whole file. The
     * approval card gets something a person can read (the text going
     * out and the text coming in) instead of a full config file, and a
     * file the agent has not read whole cannot be quietly rewritten.
     * -------------------------------------------------------------- */

    {
        name: 'edit_file',
        title: 'Edit a remote file',
        readOnly: false,
        description:
            'Replace one passage of a text file on a session\'s server over SFTP, leaving the rest as '
            + 'it is. Prefer this to write_file for a change to a config file: it is smaller to review '
            + 'and cannot discard lines you did not see. `old` must match the file exactly, whitespace '
            + 'included, and exactly once unless `all` is set. Read the file first.',
        shape: {
            session: z.string().optional().describe('Session id. Defaults to the session in front of the user.'),
            path: z.string().describe('Absolute path of the file.'),
            old: z.string().min(1).describe('The exact text to replace.'),
            new: z.string().describe('What it becomes. Empty to delete the passage.'),
            all: z.boolean().optional().describe('Replace every occurrence rather than requiring exactly one.'),
        },
        handler: async (input, ctx) => {
            const resolved = resolveSession(input, ctx);
            if (resolved.error) return fail(resolved.error);

            return viaSftp(resolved.sessionId, (handle, resolve) => {
                handle.readFile(input.path, (readError, data) => {
                    if (readError) {
                        resolve(fail(`Could not read ${input.path}: ${readError.message}`));
                        return;
                    }
                    if (data.length > MAX_FILE_BYTES * 8) {
                        resolve(fail(`${input.path} is too large to edit in place. Use run_command with sed.`));
                        return;
                    }
                    const applied = local.applyEdit(data.toString('utf8'), input.old, input.new, { all: Boolean(input.all) });
                    if (applied.error) {
                        resolve(fail(applied.error));
                        return;
                    }
                    const file = { where: 'remote', sessionId: resolved.sessionId, path: input.path };
                    ctx.checkpoint?.before(file, { existed: true, content: data.toString('utf8') });
                    handle.writeFile(input.path, applied.content, { encoding: 'utf8' }, (writeError) => {
                        if (writeError) {
                            resolve(fail(`Could not write ${input.path}: ${writeError.message}`));
                            return;
                        }
                        ctx.checkpoint?.after(file, { existed: true, content: applied.content });
                        ctx.checkpoint?.passage(file, { old: input.old, new: input.new, all: Boolean(input.all) });
                        resolve(ok(`Replaced ${applied.replaced} occurrence${applied.replaced === 1 ? '' : 's'} in ${input.path}.`));
                    });
                });
            });
        },
    },

    {
        name: 'edit_local_file',
        title: 'Edit a local file',
        readOnly: false,
        description:
            'Replace one passage of a text file on the user\'s own computer, inside a folder granted '
            + 'for writing, leaving the rest as it is. `old` must match exactly, whitespace included, '
            + 'and exactly once unless `all` is set. Read the file first.',
        shape: {
            path: z.string().describe('Absolute path of the file, or a path under /workspace inside a container.'),
            old: z.string().min(1).describe('The exact text to replace.'),
            new: z.string().describe('What it becomes. Empty to delete the passage.'),
            all: z.boolean().optional().describe('Replace every occurrence rather than requiring exactly one.'),
        },
        handler: async (input, ctx) => {
            const file = local.hostPath(ctx, input.path);
            if (file) ctx.checkpoint?.before({ where: 'local', path: file }, checkpoints.readLocal(file));
            const result = await local.edit(ctx, input.path, input.old, input.new, { all: Boolean(input.all) });
            if (file) ctx.checkpoint?.after({ where: 'local', path: file }, checkpoints.readLocal(file));
            if (file && !result.error) {
                ctx.checkpoint?.passage({ where: 'local', path: file }, { old: input.old, new: input.new, all: Boolean(input.all) });
            }
            return result.error ? fail(result.error) : ok({ edited: true, ...result });
        },
    },

    {
        name: 'search_local_files',
        title: 'Search local files',
        readOnly: true,
        description:
            'Search for text inside the files of the folders the user granted this agent, like grep. '
            + 'Returns file, line number and the line. Skips .git, node_modules, build output and '
            + 'binary files. Omit `path` to search every granted folder. The query is matched as '
            + 'literal text and case-sensitively unless you say otherwise: set `regex` to use '
            + 'alternation or wildcards, and `ignoreCase` when the spelling may differ. Searching '
            + '"a|b" without `regex` looks for those three characters and finds nothing.',
        shape: {
            query: z.string().min(1).describe('The text to look for, matched literally, or a regular expression when `regex` is set.'),
            path: z.string().optional().describe('A granted folder, or a file or folder inside one. Omit for all of them.'),
            regex: z.boolean().optional().describe('Treat the query as a regular expression. Needed for | ( ) [ ] * + ? to mean anything.'),
            ignoreCase: z.boolean().optional().describe('Match whatever the case. Use it for a name you may be spelling differently.'),
            glob: z.string().optional().describe('Only files whose name matches, e.g. "*.conf" or "*.js".'),
            limit: z.number().int().min(1).max(local.MAX_MATCHES).optional().describe('Most matches to return. Defaults to 200.'),
        },
        handler: async (input, ctx) => {
            const result = await local.search(ctx, input);
            return result.error ? fail(result.error) : ok(result);
        },
    },

    /* -------------------------------------------------------------- *
     * Looking back, and asking.
     * -------------------------------------------------------------- */

    {
        name: 'search_conversations',
        title: 'Search past conversations',
        readOnly: true,
        description:
            'Search this agent\'s earlier conversations with the user by what was said in them: the '
            + 'user\'s messages, your replies, the commands run and what came back. Use it for "what '
            + 'did we do about X", "how did we fix this last time", or to find the host a problem was '
            + 'on. Plain words plus operators: "exact phrase", -word, host:web-01, tool:run_command, '
            + 'after:7d, before:2026-08-01, has:error, from:me, from:agent. A filter on its own, like '
            + 'after:2d, lists the recent ones newest first. Returns the matching conversations with '
            + 'a line or two around each hit: enough to find one, never enough to say what is or is '
            + 'not in it. Read it with read_conversation for that.',
        shape: {
            query: z.string().min(1).describe('Words and operators, as above.'),
            limit: z.number().int().min(1).max(30).optional().describe('Most conversations to return. Defaults to 8.'),
        },
        handler: async (input, ctx) => {
            if (typeof ctx.searchConversations !== 'function') return fail('Conversation search is not available here.');
            const found = await ctx.searchConversations({ query: input.query, limit: input.limit || 8 });
            return ok({
                total: found.total,
                meaning: found.meaning,
                conversations: (found.results || []).map(result => ({
                    conversationId: result.conversationId,
                    title: result.title,
                    when: new Date(result.updatedAt || result.createdAt || 0).toISOString(),
                    current: result.conversationId === ctx.conversationId || undefined,
                    byMeaning: result.byMeaning || undefined,
                    passages: (result.snippets || []).map(snippet => ({
                        from: snippet.kind || snippet.source || undefined,
                        text: snippet.text,
                    })),
                })),
            });
        },
    },

    {
        name: 'read_conversation',
        title: 'Read a past conversation',
        readOnly: true,
        description:
            'Read one of this agent\'s earlier conversations in full, as a transcript: the user\'s '
            + 'messages, your replies, and the tool calls with what came back. Use it once '
            + 'search_conversations has found the conversation and you need what was actually said '
            + 'or produced there: a draft, a plan, the command that fixed it. A long one comes in '
            + 'pages; pass nextOffset back as offset for the next. messagesOnly leaves out the tool '
            + 'calls, which are most of a long transcript.',
        shape: {
            conversationId: z.string().min(1).describe('The conversationId search_conversations returned.'),
            offset: z.number().int().min(0).optional().describe('Where to start reading, in characters. Defaults to 0.'),
            messagesOnly: z.boolean().optional().describe('Only the user\'s messages and your replies.'),
        },
        handler: async (input, ctx) => {
            if (typeof ctx.readConversation !== 'function') return fail('Reading past conversations is not available here.');
            const found = ctx.readConversation(input.conversationId, { messagesOnly: Boolean(input.messagesOnly) });
            if (!found) {
                return fail(`There is no conversation ${input.conversationId} of this agent's. `
                    + 'Only the most recent ones are kept; search_conversations lists what there is.');
            }
            const page = pageOf(found.text, input.offset || 0);
            return ok({
                conversationId: found.conversationId,
                title: found.title,
                when: new Date(found.updatedAt || found.createdAt || 0).toISOString(),
                current: found.conversationId === ctx.conversationId || undefined,
                totalChars: found.text.length,
                offset: page.offset,
                nextOffset: page.nextOffset,
                text: page.text,
            });
        },
    },

    {
        name: 'ask_user',
        title: 'Ask the user a question',
        readOnly: true,
        description:
            'Put a question to the user with a short list of answers to pick from, and wait for the '
            + 'answer. Use it when the next step depends on a choice only they can make: which of two '
            + 'hosts, whether to proceed a particular way, a value you cannot find. Not for approval of a '
            + 'tool call, which the app asks on its own. Keep the question to one line and the options '
            + 'to two to four; the user can always type something else.',
        shape: {
            question: z.string().min(1).max(500).describe('The question, one or two sentences.'),
            options: z.array(z.string().min(1).max(120)).min(0).max(6).optional()
                .describe('Answers to offer, in the order to show them. Omit for a free-text answer.'),
            secret: z.string().max(60).optional()
                .describe('When the answer is a password, an API key or a token: the name to store it under, e.g. "webshare". '
                    + 'The user types it into a masked field, the app stores it encrypted, and you get a reference '
                    + '{{secret:name}} instead of the value. Use the reference in env, headers or passwords; the app fills it in.'),
        },
        handler: async (input, ctx) => {
            if (typeof ctx.askUser !== 'function') return fail('There is no one to ask here.');
            const options = (input.options || []).map(option => String(option).trim()).filter(Boolean).slice(0, 6);
            const reply = await ctx.askUser({
                question: input.question,
                options,
                secret: input.secret || '',
                // So the question outlives a client that stops waiting for it.
                signal: ctx.signal,
            });
            if (!reply.answered) return fail(reply.message || 'The user did not answer.');
            if (reply.stored) {
                return ok({
                    stored: true,
                    name: reply.name,
                    reference: reply.reference,
                    note: 'The value is in the keychain and was not shown to you. Put the reference where the value '
                        + 'is needed: the env of run_local_command, the env or headers of save_mcp_server, the password of '
                        + 'save_proxy or save_host. Never write the value out yourself.',
                });
            }
            return ok({ answer: reply.answer, chosen: reply.chosen || undefined });
        },
    },

    {
        name: 'save_secret',
        title: 'Store a secret',
        // Auto-approved, and still a write. The two are usually the same
        // question and here they are not: holding a pasted key back behind an
        // approval card would leave the value sitting in the transcript for as
        // long as the card waits, which is the one thing this tool exists to
        // prevent. `writes` says the other half out loud, so a run promised to
        // change nothing does not quietly store something. See changesNothing.
        readOnly: true,
        writes: true,
        description:
            'Put a secret you already have into the keychain, under a name, so it is never asked for '
            + 'again: an API key or token the user pasted into chat, or one you were given by a service. '
            + 'It is encrypted on this computer and the user sees it under Inventory, Keychain, Secrets. '
            + 'From then on refer to it as {{secret:name}} in env, headers and passwords, and never write '
            + 'the value out again. Every copy of the value in the transcript is masked once it is stored. '
            + 'Prefer ask_user with a secret name when the user has not given it yet.',
        shape: {
            name: z.string().min(1).max(60).describe('A clear name: the service, e.g. "webshare", "github", "2captcha".'),
            secret: z.string().min(1).max(4000).describe('The value to store.'),
        },
        handler: async (input, ctx) => {
            if (!ctx.secrets?.set) return fail('There is no secrets store here.');
            const kept = ctx.secrets.set(input.name, input.secret);
            if (kept.error) return fail(kept.error);
            return ok({
                stored: true,
                name: kept.name,
                reference: kept.reference,
                note: 'Use the reference from now on. The value itself is masked everywhere it appeared.',
            });
        },
    },

    {
        name: 'list_secrets',
        title: 'List the stored secrets',
        readOnly: true,
        description:
            'The names of the secrets in the keychain, with the reference to use for each. Never the values. '
            + 'This is the secrets half of the user\'s keychain, beside their SSH keys, under Inventory. '
            + 'Check here before asking the user for a key they may already have given.',
        shape: {},
        handler: async (input, ctx) => {
            if (!ctx.secrets) return fail('There is no secrets store here.');
            // This agent's own and the shared ones; another agent's are not
            // there to list. A shared one is marked, since deleting it is
            // not this agent's to do.
            return ok({ secrets: ctx.secrets.list().map(entry => ({ name: entry.name, reference: entry.reference, shared: entry.shared || undefined })) });
        },
    },

    {
        name: 'delete_secret',
        title: 'Delete a stored secret',
        readOnly: false,
        description:
            'Remove one secret from the keychain by name. Anything still referring to it — a host\'s password, '
            + 'an MCP server, a proxy — stops working, and the value cannot be recovered. '
            + 'Only when the user asked for it to go.',
        shape: {
            name: z.string().min(1).max(60).describe('The name, as list_secrets shows it.'),
        },
        handler: async (input, ctx) => {
            if (!ctx.secrets) return fail('There is no secrets store here.');
            const result = ctx.secrets.remove(input.name);
            return result.removed ? ok({ removed: true, name: result.name }) : fail(`There is no secret named "${input.name}".`);
        },
    },

    /* -------------------------------------------------------------- *
     * The agent's kit: reading and keeping its own inventory. Defined
     * in inventory-tools.js and built with the helpers above, so they
     * fence hosts the same way list_hosts does.
     * -------------------------------------------------------------- */
    ...inventoryTools.build({ z, ok, fail, hostInScope, publicHost, agentHosts }),

    /* -------------------------------------------------------------- *
     * Jobs: work on a schedule. See job-tools.js.
     * -------------------------------------------------------------- */
    ...jobTools.build({ z, ok, fail }),

    /* -------------------------------------------------------------- *
     * Delegation and fan-out. See delegation-tools.js.
     * -------------------------------------------------------------- */
    ...delegationTools.build({ z, ok, fail }),

    /* -------------------------------------------------------------- *
     * Using this computer: its windows, with the real mouse and
     * keyboard. See computer-tools.js and computer.js.
     * -------------------------------------------------------------- */
    ...computerTools.build({ z, ok, fail }),
];

const BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));

/**
 * Run a tool, with the hooks around it.
 *
 * The one place every provider hands a call to a handler, so the hooks the
 * user wrote for the agent run for every runtime. A pre-tool hook may block
 * the call, and its reason is what the model reads; a post-tool hook only
 * observes. Hooks are the conversation's to supply, through `ctx.hooks`; a
 * context without them (a test, a tool run from the page) is the plain call.
 */
async function invoke(definition, input, ctx) {
    const hooks = typeof ctx?.hooks === 'function' ? ctx.hooks : null;
    if (hooks) {
        const before = await hooks('pre-tool', { tool: definition.name, input });
        if (before?.blocked) {
            return { text: before.message || `A hook blocked ${definition.name}.`, isError: true };
        }
    }
    const result = await definition.handler(input, ctx);
    if (hooks) {
        await hooks('post-tool', {
            tool: definition.name,
            input,
            output: String(result?.text ?? '').slice(0, 20000),
            isError: Boolean(result?.isError),
        });
    }
    return result;
}

/**
 * The input fields that are secrets, and a copy of an input with them masked.
 *
 * The inventory tools take a password or a key so the agent can save a host
 * it was just told about. The call that carries one is also an event: it is
 * drawn on the approval card, kept in the conversation's log, written to the
 * history file and summarised into the activity log. None of those should
 * hold the secret, so it is masked once, where an event enters the
 * conversation, and the handler is the only thing that sees the real value.
 */
const SECRET_FIELDS = ['password', 'privateKey', 'passphrase', 'secret'];

/** A wait in milliseconds, from a number that may have been meant as seconds. */
function millis(value) {
    const given = Number(value) || 0;
    if (given <= 0) return local.DEFAULT_TIMEOUT;
    return given < 1000 ? given * 1000 : given;
}

function redactInput(input) {
    if (!input || typeof input !== 'object') return input;
    let masked = input;
    for (const field of SECRET_FIELDS) {
        if (typeof input[field] !== 'string' || !input[field]) continue;
        if (masked === input) masked = { ...input };
        masked[field] = '••••';
    }
    return masked;
}

/* ------------------------------------------------------------------ *
 * Blocked commands
 *
 * What this is, and what it is not.
 *
 * It is a guardrail. It catches the destructive command that arrives by
 * accident: a model that misread the question, a suggestion copied out of a
 * log, a plausible-looking answer to "clear some space". That is the common
 * case by a wide margin, and refusing it outright is worth doing.
 *
 * It is not a security boundary, and it must never be treated as one. A shell
 * has unlimited ways to spell the same command, and anything that can write a
 * script can sidestep any list of words: `bash -c "$(echo cm0gLXJmIC8K |
 * base64 -d)"` is not going to be caught here and neither is the next one.
 * The control that actually stands between a compromised server and a bad
 * command is the approval card, which is why nothing about this list loosens
 * anything above it.
 *
 * So the matching below is written to be hard to trip over by accident rather
 * than impossible to evade: it reads through the quoting, the wrappers, the
 * flag spellings and the chaining that show up in ordinary commands, and it
 * errs towards refusing when a string is ambiguous.
 * ------------------------------------------------------------------ */

/**
 * Words that stand in front of the command that actually runs.
 *
 * Seeing one is what lets `sudo rm -rf /` be read as the `rm` it is, rather
 * than as a command called `sudo` that no rule mentions. See `readingsOf`.
 */
const WRAPPERS = new Set([
    'sudo', 'doas', 'env', 'nice', 'ionice', 'nohup', 'time', 'timeout',
    'command', 'builtin', 'exec', 'xargs', 'stdbuf', 'setsid', 'strace',
]);

/**
 * Long flags that mean the same as a short letter, so `--recursive --force`
 * is not a way around a rule written `-rf`.
 *
 * Deliberately short. These are the spellings that matter for the commands
 * anyone actually blocks; a general table would be one per program and would
 * still be incomplete.
 */
const LONG_FLAGS = {
    recursive: 'r',
    force: 'f',
    all: 'a',
    verbose: 'v',
};

/** Anything that can end one command and begin another, or nest one inside. */
const SEPARATORS = /[;&|\n\r`(){}<>]/g;

/** The last path segment, so `/bin/rm` and `rm` are the same command. */
const commandName = (token) => token.split(/[/\\]/).pop();

/**
 * Drop the quoting that lets one word be written as several.
 *
 * `r''m`, `"rm"` and `r\m` are all `rm` to a shell, and a rule that missed
 * that would be a rule that only stops the careless spelling.
 */
const unquote = (text) => text.replace(/['"]/g, '').replace(/\\(.)/g, '$1');

/**
 * Split a command line into the individual commands it runs.
 *
 * Substitutions and subshells are cut at their brackets rather than parsed, so
 * the command inside `$(...)` is checked as its own segment. That over-splits
 * a string with a stray bracket in it, which costs an occasional false refusal
 * and never a missed one. For a list whose whole job is to say no, that is the
 * direction to be wrong in.
 */
function segmentsOf(command) {
    return unquote(String(command ?? '').toLowerCase())
        .replace(SEPARATORS, '\n')
        .split('\n')
        .map(part => part.trim().replace(/\s+/g, ' '))
        .filter(Boolean);
}

/**
 * Read a command starting at one token: what is being run, which flags it
 * carries, and its remaining arguments.
 *
 * Flags are gathered as a set of letters, so `-rf`, `-fr` and `-r -f` are one
 * answer and the order they were typed in stops mattering.
 */
function parseFrom(tokens, position) {
    const flags = new Set();
    const positionals = [];

    for (const token of tokens.slice(position + 1)) {
        if (token.startsWith('--') && token.length > 2) {
            const short = LONG_FLAGS[token.slice(2).split('=')[0]];
            if (short) flags.add(short);
        } else if (token.startsWith('-') && token.length > 1) {
            for (const letter of token.slice(1)) flags.add(letter);
        } else {
            positionals.push(token);
        }
    }

    return { name: commandName(tokens[position]), flags, positionals };
}

/**
 * Every reading of a segment that could be the command it runs.
 *
 * Usually there is one, and it is the first word. A wrapper is what makes a
 * second reading possible, and the reason this is a list rather than a single
 * parse: `sudo -u root rm -rf /` cannot be read by walking past the wrapper's
 * flags, because `-u` takes a value and knowing which flags do that means
 * knowing every wrapper's option table. So once a wrapper has been seen, every
 * later word is offered as a candidate and the rules decide.
 *
 * That permission is deliberately not granted without one. If any word could
 * be the command, a rule naming `ls` would fire on `cat ls`, and a list that
 * refuses things nobody asked it to is a list people turn off.
 */
function readingsOf(segment) {
    const tokens = String(segment).split(' ').filter(Boolean);
    const readings = [];

    // `FOO=bar cmd` sets a variable for one command; the command is what
    // follows it.
    let start = 0;
    while (start < tokens.length && /^[a-z_][a-z0-9_]*=/.test(tokens[start])) start += 1;

    let sawWrapper = false;
    for (let position = start; position < tokens.length; position += 1) {
        const token = tokens[position];
        if (token.startsWith('-')) continue;

        readings.push(parseFrom(tokens, position));

        if (WRAPPERS.has(commandName(token))) sawWrapper = true;
        else if (!sawWrapper) break;
    }

    return readings;
}

/**
 * Whether one command matches one rule.
 *
 * The rule's flags must all be present, and its words must lead the command's
 * own. So `rm -rf` catches `rm -rf /var`, `rm -fr /var` and `rm -r -f /var`,
 * while `rm -r /var` is left to the ordinary approval path: it is not what the
 * rule named, and silently widening a rule is how a block list ends up
 * refusing things nobody asked it to.
 */
function matchesRule(command, rule) {
    if (command.name !== rule.name) return false;
    for (const flag of rule.flags) {
        if (!command.flags.has(flag)) return false;
    }
    return rule.positionals.every((word, position) => command.positionals[position] === word);
}

/** The text a tool call would put on a server, or '' for one that runs nothing. */
function commandTextFor(toolName, input) {
    if (toolName === 'run_command') return String(input?.command ?? '');
    // Typing into the terminal reaches the same shell by another door. A list
    // that only covered run_command would be one tool call away from useless.
    if (toolName === 'send_input') return String(input?.text ?? '');
    // A shell on this computer is still a shell. What is blocked on a server
    // is blocked here too, container or not.
    if (toolName === 'run_local_command') return String(input?.command ?? '');
    // Opening an app is starting a program, which is a command by any name.
    if (toolName === 'open_app') return [input?.app, input?.args].filter(Boolean).join(' ');
    return '';
}

/**
 * The blocked rule a call trips, or '' when it trips none.
 *
 * Returns the rule rather than a boolean so the refusal can quote the line the
 * user wrote, which is the difference between "no" and "no, because of this,
 * which you can change here".
 */
function blockedReason(toolName, input, settings) {
    const rules = Array.isArray(settings?.blockedCommands) ? settings.blockedCommands : [];
    if (rules.length === 0) return '';

    const text = commandTextFor(toolName, input);
    if (!text.trim()) return '';

    const segments = segmentsOf(text);

    for (const raw of rules) {
        // A rule is taken literally, from its first word: it is what someone
        // typed into a settings box, not something a shell handed us. That is
        // also what lets a wrapper be blocked by name, since `sudo` as a rule
        // has to mean the command `sudo`.
        const tokens = unquote(String(raw).toLowerCase()).trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
        if (tokens.length === 0) continue;
        const rule = parseFrom(tokens, 0);

        for (const segment of segments) {
            if (readingsOf(segment).some(reading => matchesRule(reading, rule))) return raw;
        }
    }

    return '';
}

/** What the model is told, phrased so its next move is not to try again. */
const blockedMessage = (rule) =>
    `Refused: "${rule}" is on the blocked command list in this app's assistant settings, `
    + 'so it cannot be run here and there is no approval that would let it through. '
    + 'Do not try to reach the same result another way. Tell the user what you wanted to run '
    + 'and why, and let them run it themselves or change the list in Settings.';

/**
 * The runtimes' own tools that only look, across the three naming
 * conventions: Claude Code's `Read`, OpenCode's `read`, Grok's `read_file`.
 * Compared in lower case with the underscores kept.
 */
const NATIVE_READS = new Set([
    'read', 'read_file', 'glob', 'grep', 'ls', 'list', 'list_dir', 'list_directory',
    'notebookread', 'bashoutput', 'get_command_or_subagent_output',
    'webfetch', 'web_fetch', 'websearch', 'web_search', 'search_tool',
    'todowrite', 'todoread', 'todo_write', 'task', 'exitplanmode',
    // Handing work to a subagent, or checking on one, touches nothing by
    // itself: each call the subagent makes is asked about on its own.
    'agent', 'taskoutput', 'taskstop',
]);

/** The runtimes' own shells, which are judged by the allow list like any command. */
const NATIVE_SHELLS = new Set(['bash', 'run_terminal_command', 'shell']);

/** An MCP tool whose name says it only looks: `browser_snapshot`, `list_issues`, `get_page`. */
const READ_NAME = /^(list|get|read|search|find|fetch|query|describe|show|check|health)[_a-z0-9]*$|^browser_(snapshot|take_screenshot|console_messages|network_requests?|find|tabs)$|^healthcheck$/;

/** The bare tool of an MCP name, however the runtime spells the prefix. */
function bareMcpName(toolName) {
    const doubled = toolName.lastIndexOf('__');
    if (toolName.startsWith('mcp__') && doubled > 0) return toolName.slice(doubled + 2);
    return '';
}

/**
 * Whether one of the runtime's own tools can go ahead without asking.
 *
 * The approval mode is the user's answer for the whole agent, and it has to
 * mean the same thing whoever is holding the keyboard: their tools or ours,
 * this runtime or the next. Nothing waits under "never", everything waits
 * under "always", and under the default a read runs and a change stops, with
 * the runtime's shell judged by the same allow list as a command on a server.
 *
 * A name this does not recognise is a change, and a change asks. That is the
 * case that matters: a runtime grows a tool, nobody revisits this, and the
 * safe answer is the one that puts a card in front of a person.
 */
function nativeAutoApproved(toolName, input, settings) {
    if (settings.approval === 'never') return true;
    if (settings.approval === 'always') return false;

    const name = String(toolName || '').toLowerCase();
    if (NATIVE_READS.has(name)) return true;
    if (NATIVE_SHELLS.has(name)) {
        return isAutoApproved('run_command', { command: input?.command ?? input?.cmd ?? '' }, settings);
    }
    const bare = bareMcpName(String(toolName || ''));
    if (bare) return READ_NAME.test(bare.toLowerCase());
    return false;
}

/**
 * Whether a call can go ahead without asking, under the current policy.
 *
 * A tool the catalog does not know is never auto-approved. That is the case
 * that matters: it is what happens when a tool is added and this function is
 * not revisited, and the safe answer is to ask.
 */
/**
 * Whether running this tool leaves the app exactly as it found it.
 *
 * Not the same question as `readOnly`, which has always meant "safe to run
 * without asking". They agree on every tool but `save_secret`, which is waved
 * through on purpose and still writes to the keychain. A run told to look and
 * not touch is asking this question, not that one.
 */
function changesNothing(toolName) {
    const tool = BY_NAME.get(toolName);
    return Boolean(tool?.readOnly && !tool.writes);
}

function isAutoApproved(toolName, input, settings) {
    // Before the approval mode, not after it. A blocked command is refused
    // rather than approved, so it must never come back from here as "run it",
    // and `never ask` is exactly the setting under which that would happen.
    if (blockedReason(toolName, input, settings)) return false;

    if (settings.approval === 'never') return true;
    if (settings.approval === 'always') return false;

    const tool = BY_NAME.get(toolName);
    if (!tool) return false;
    // In a read-only run the waved-through writes stop being waved through.
    // Refusing here rather than running sends them to requestApproval, which
    // is where a read-only run turns a write down and says why.
    if (tool.readOnly) return !(settings.readOnlyRun && tool.writes);

    // A command whose leading words are on the safe list is a read wearing a
    // shell's clothing, and making someone approve `ls` teaches them to
    // approve without looking.
    if (toolName === 'run_command') {
        const command = String(input?.command || '').trim().toLowerCase();
        // Anything chained, redirected or carried onto a second line is judged
        // as a whole rather than by its first word, because `ls; rm -rf /` and
        // `ls -la\nrm -rf /` both start with `ls`.
        //
        // The line breaks are not an afterthought to the list. A newline ends a
        // command exactly as `;` does, so a payload whose first line is `ls`
        // would otherwise be approved in full and run in full; and a carriage
        // return is Enter to the PTY that the terminal path types into, which
        // is the default place a command goes.
        if (/[;&|><`$(\n\r]/.test(command)) return false;
        return settings.autoApproveCommands.some(prefix => (
            command === prefix || command.startsWith(`${prefix} `)
        ));
    }

    return false;
}

module.exports = {
    TOOLS,
    BY_NAME,
    invoke,
    contentOf,
    SECRET_FIELDS,
    redactInput,
    isAutoApproved,
    changesNothing,
    nativeAutoApproved,
    blockedReason,
    blockedMessage,
    resolveSession,
    sessionInScope,
    ownedElsewhere,
    hostInScope,
    publicHost,
};

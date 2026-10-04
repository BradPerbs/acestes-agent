/**
 * The things a message can point at: anything in the agent's inventory,
 * tagged in the composer with `@`.
 *
 * A mention is `{ kind, id }` on the wire and nothing else. The renderer sends
 * ids, never text, for the same reason it always has: the store is the
 * authority on what a host's address or a runbook's contents are, the panel's
 * cached copy of either can be a save behind, and a sixty-thousand-character
 * document should not cross the bridge twice. Everything the model sees is
 * assembled here, from the records the main process already holds.
 *
 * This replaces the spec attachment, which was the same idea for one kind of
 * thing. A spec is now a mention of a snippet that happens to be a document,
 * and the same gesture reaches a host, a proxy, a key, a note the agent kept,
 * or an MCP server.
 *
 * Kept free of Electron so it can be tested on its own: the caller hands in
 * the inventory to resolve against.
 */

/** A sanity cap. Twenty things on one question is a question about the list. */
const MAX_MENTIONS = 20;

/** How much of a document rides along. Past this it is a file, not a mention. */
const MAX_TEXT = 60000;

/** The kinds that can be tagged, and where each is looked up. */
const KINDS = ['host', 'snippet', 'memory', 'proxy', 'key', 'mcp', 'skill'];

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** What a host is, as much as the model has any business seeing. */
function fromHost(host) {
    const address = (host.protocol === 'serial')
        ? (host.serial?.path || '')
        : [host.host, host.port].filter(Boolean).join(':');

    const detail = [
        host.username ? `${host.username}@${address}` : address,
        host.protocol && host.protocol !== 'ssh' ? host.protocol : '',
    ].filter(Boolean).join(' · ');

    return {
        name: host.name || address || host.id,
        detail,
        lines: [
            `id: ${host.id}`,
            address ? `address: ${address}` : '',
            host.username ? `username: ${host.username}` : '',
            `protocol: ${host.protocol || 'ssh'}`,
            host.os ? `os: ${[host.distro, host.os].filter(Boolean).join(' / ')}` : '',
            host.tags?.length ? `tags: ${host.tags.join(', ')}` : '',
        ].filter(Boolean),
        note: 'Use this id with connect_host to open a session on it.',
    };
}

function fromSnippet(snippet) {
    const document = snippet.kind === 'spec';
    return {
        name: snippet.name,
        detail: document ? 'document' : (snippet.kind || 'command'),
        text: String(snippet.command || '').slice(0, MAX_TEXT),
        lines: snippet.description ? [`description: ${snippet.description}`] : [],
        note: document
            ? 'Treat this as the user\'s instructions for this request.'
            : 'This is a command the user keeps; it has not been run.',
    };
}

const RESOLVE = {
    host: (record) => fromHost(record),
    snippet: (record) => fromSnippet(record),
    memory: (record) => ({
        name: record.tags?.[0] ? `#${record.tags[0]}` : 'note',
        detail: 'remembered',
        text: record.text,
    }),
    proxy: (record) => ({
        name: record.name || record.host,
        detail: `${String(record.type || '').toUpperCase()} ${record.host}:${record.port}`.trim(),
        lines: [`id: ${record.id}`],
    }),
    key: (record) => ({
        name: record.name,
        detail: record.type || 'key',
        // The public half and nothing else. There is no path from here to a
        // private key, and there never should be.
        lines: [`id: ${record.id}`, record.fingerprint ? `fingerprint: ${record.fingerprint}` : ''].filter(Boolean),
    }),
    mcp: (record) => ({
        name: record.name,
        detail: record.transport === 'http' ? record.url : record.command,
        lines: [record.transport === 'http'
            ? `url: ${record.url}`
            : `command: ${[record.command, ...(record.args || [])].join(' ')}`],
        note: 'Its tools are already available to you.',
    }),
    skill: (record) => ({
        name: record.name,
        detail: record.description ? `skill · ${record.description}`.slice(0, 300) : 'skill',
        text: String(record.text || '').slice(0, MAX_TEXT),
        lines: record.description ? [`description: ${record.description}`] : [],
        note: 'The user invoked this skill with `/`. Treat it as the instructions for this request.',
    }),
};

/** Where each kind is found in the inventory the caller hands in. */
const SOURCE = {
    host: 'hosts',
    snippet: 'snippets',
    memory: 'notes',
    proxy: 'proxies',
    key: 'keys',
    mcp: 'servers',
    skill: 'skills',
};

/**
 * The mentions as records, in the order they were tagged, or the reason one of
 * them cannot be sent.
 *
 * All or nothing, as the attachments have always been: the message was written
 * about all of them, and a question answered against half of what it named is
 * worse than one that was refused and asked again.
 */
function readMentions(raw, inventory = {}) {
    if (raw === undefined || raw === null) return { mentions: [], error: '' };
    if (!Array.isArray(raw)) return { mentions: [], error: 'The mentions were not a list' };
    if (raw.length > MAX_MENTIONS) {
        return { mentions: [], error: `A message can carry at most ${MAX_MENTIONS} mentions` };
    }

    const seen = new Set();
    const mentions = [];

    for (const entry of raw) {
        const kind = clean(entry?.kind);
        const id = clean(entry?.id);
        if (!kind || !id) continue;
        if (!KINDS.includes(kind)) {
            return { mentions: [], error: `“${kind}” is not something that can be tagged` };
        }

        const key = `${kind}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const record = (inventory[SOURCE[kind]] || []).find(item => item.id === id);
        if (!record) {
            return {
                mentions: [],
                error: 'One of the things this message tags no longer exists. Take it off and try again.',
            };
        }

        const resolved = RESOLVE[kind](record);
        if (resolved.text !== undefined && !String(resolved.text).trim()) {
            return { mentions: [], error: `“${resolved.name}” is empty` };
        }

        mentions.push({ kind, id, ...resolved });
    }

    return { mentions, error: '' };
}

/** What each kind is called when the block introduces it. */
const LABEL = {
    host: 'host',
    snippet: 'snippet',
    memory: 'note',
    proxy: 'proxy',
    key: 'key',
    mcp: 'mcp-server',
    skill: 'skill',
};

/**
 * The block that goes in front of the user's text.
 *
 * Tagged, and named, so the model can tell what was pointed at from what was
 * asked, and can refer back to "the deploy checklist" or "web-01" by name. A
 * closing tag inside a document would end the block early, so it is spelled
 * out of harm's way rather than trusted.
 */
function mentionBlock(mentions) {
    if (!mentions?.length) return '';

    const lines = [
        mentions.length === 1
            ? 'The user tagged the following from their inventory. It is what they are referring to.'
            : `The user tagged the following ${mentions.length} things from their inventory. They are what the message refers to.`,
        '',
    ];

    for (const mention of mentions) {
        const tag = LABEL[mention.kind] || 'item';
        const name = String(mention.name || tag).replace(/["\n]/g, ' ').trim();

        lines.push(`<${tag} name="${name}">`);
        for (const line of mention.lines || []) lines.push(line);
        if (mention.note) lines.push(mention.note);
        if (mention.text) {
            if (mention.lines?.length || mention.note) lines.push('');
            lines.push(String(mention.text).replace(new RegExp(`</${tag}>`, 'gi'), `</ ${tag}>`));
        }
        lines.push(`</${tag}>`, '');
    }

    return lines.join('\n').trimEnd();
}

/** The same mentions without their text, for the transcript: enough for a chip. */
function stripMentions(mentions) {
    return mentions.map(({ kind, id, name }) => ({ kind, id, name }));
}

module.exports = { readMentions, mentionBlock, stripMentions, MAX_MENTIONS, KINDS };

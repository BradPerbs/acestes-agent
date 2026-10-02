const store = require('../store');
const agents = require('../agents');
const transcript = require('../transcript');
const keygen = require('../keygen');
const snippetConfig = require('../snippet-config');
const proxyConfig = require('../proxy-config');
const mcpLibrary = require('./mcp-library');
const mcpProbe = require('./mcp-probe');
const { isBrowserServer } = require('./browser-use');
const secrets = require('./secrets');

/**
 * Credentials in a server's env or headers moved into the secrets store,
 * leaving references on the record. The registry does this to every server
 * on its way in whichever door it came through; it is done here as well so
 * the reply can tell the agent what became of each value it typed.
 */
const vaultCredentials = agents.vaultCredentials;

/**
 * The agent's kit: the tools that let it look through its own inventory and
 * keep it.
 *
 * Reading is the half that matters most. A snippet or a spec used to reach
 * the agent only when the user tagged it, so a playbook the user wrote for
 * exactly this job sat unread unless they remembered to attach it. Now the
 * agent can find it.
 *
 * Writing is the agent's full hand over its own bag. Every record it creates
 * is stamped with its own id, so it lands in that agent's bag and no other,
 * and every record it edits or deletes is one already in that bag: its own,
 * or one the user left unassigned for every agent to share. That includes
 * credentials: it can set a host's password or private key, a proxy's
 * password, and add a key to the keychain, so a machine it has just been
 * told about can be reached without the user opening an editor. Secrets flow
 * one way, though. What the agent writes is encrypted by the store like
 * anything the user typed, and nothing here ever reads one back: a host
 * comes out with `hasPassword`, a key with its fingerprint, the same
 * redaction the renderer gets.
 *
 * Every write here is a change to how the app reaches real servers, so none
 * of these is read-only to the approval policy: under the default setting
 * each one stops at the card.
 *
 * Built by `tools.js` with the handful of helpers it already has, rather than
 * requiring them back, which would be a cycle.
 */

/** Proxies, keys and servers carry `agentId`; blank is everyone's. */
const inAgent = (ctx) => (record) => !record.agentId || !ctx?.agentId || record.agentId === ctx.agentId;

const KINDS = ['host', 'snippet', 'proxy', 'key', 'server', 'folder'];
const SNIPPET_KINDS = ['command', 'spec'];
const AUTH_METHODS = ['password', 'key', 'keychain', 'agent'];
const HOST_PROTOCOLS = ['ssh', 'telnet'];

const MAX_LIST = 200;

const clean = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A key as the agent may see it: the public half and nothing else. */
function publicKey(key) {
    return {
        id: key.id,
        name: key.name || '',
        type: key.type || '',
        fingerprint: key.fingerprint || '',
        comment: key.comment || '',
        hasPassphrase: Boolean(key.hasPassphrase || key.passphrase),
    };
}

/** A proxy without the one field that is a secret. */
function publicProxy(proxy) {
    const { password, hasPassword, ...rest } = proxy;
    return { ...rest, hasPassword: Boolean(hasPassword || password) };
}

/** A server as it was given, less the values in its environment and headers. */
function publicServer(server) {
    return {
        id: server.id,
        name: server.name,
        transport: server.transport,
        command: server.command || '',
        args: server.args || [],
        url: server.url || '',
        env: Object.keys(server.env || {}),
        headers: Object.keys(server.headers || {}),
        template: server.template || undefined,
    };
}

function publicSnippet(snippet) {
    return {
        id: snippet.id,
        name: snippet.name,
        kind: snippet.kind,
        description: snippet.description || '',
        tags: snippet.tags || [],
        hostIds: snippet.hostIds || [],
        length: (snippet.command || '').length,
        steps: snippet.kind === 'package' ? snippet.steps.length : undefined,
    };
}

function matches(needle, ...fields) {
    if (!needle) return true;
    return fields.flat().filter(Boolean).join(' ').toLowerCase().includes(needle);
}

function build({ z, ok, fail, hostInScope, publicHost, agentHosts }) {
    /** The snippets in this agent's bag. */
    const agentSnippets = (ctx) => store.getSnippets().filter(inAgent(ctx));
    const agentProxies = (ctx) => store.getProxies().filter(inAgent(ctx));
    const agentKeys = (ctx) => store.getKeys().filter(inAgent(ctx));
    const agentServers = (ctx) => agents.get(ctx?.agentId)?.mcpServers || [];

    /** Tell the windows a collection changed, when the context can. */
    const changed = (ctx, kind) => {
        if (typeof ctx?.inventoryChanged === 'function') ctx.inventoryChanged(kind);
    };

    /** A host this agent may edit, or the reason it may not. */
    function ownHost(ctx, id) {
        const host = agentHosts(ctx).find(entry => entry.id === id);
        if (!host) return { error: `There is no host with the id "${id}" in your inventory.` };
        if (!hostInScope(ctx, id)) {
            return { error: 'That host is outside the set the user pinned this conversation to.' };
        }
        return { host };
    }

    return [
        /* ---------------------------------------------------------- *
         * Reading the kit
         * ---------------------------------------------------------- */

        {
            name: 'list_snippets',
            title: 'List snippets and playbooks',
            readOnly: true,
            description:
                'List the snippets in your inventory: saved commands, packages of commands, and specs. '
                + 'A spec is a document the user wrote for you, such as a runbook, a checklist or house '
                + 'rules. Check for one before starting a task the user may have written a procedure for. '
                + 'Returns names and ids; use read_snippet for the text.',
            shape: {
                query: z.string().optional().describe('Filter by name, description or tag. Omit to list everything.'),
                kind: z.enum(['command', 'package', 'spec']).optional().describe('Only this kind.'),
            },
            handler: async (input, ctx) => {
                const needle = clean(input.query).toLowerCase();
                const found = agentSnippets(ctx)
                    .filter(snippet => !input.kind || snippet.kind === input.kind)
                    .filter(snippet => matches(needle, snippet.name, snippet.description, snippet.tags));
                return ok({
                    total: found.length,
                    snippets: found.slice(0, MAX_LIST).map(publicSnippet),
                });
            },
        },

        {
            name: 'read_snippet',
            title: 'Read a snippet',
            readOnly: true,
            description:
                'Read one snippet by id: the command text, the steps of a package, or the full text of a '
                + 'spec. A spec is the user\'s own instructions; follow it. A command is something the user '
                + 'keeps; it has not been run.',
            shape: {
                id: z.string().describe('The snippet id from list_snippets.'),
            },
            handler: async (input, ctx) => {
                const snippet = agentSnippets(ctx).find(entry => entry.id === input.id);
                if (!snippet) return fail(`There is no snippet with the id "${input.id}" in your inventory.`);

                const composed = snippet.kind === 'package'
                    ? snippetConfig.composeSnippet(snippet, store.getSnippets())
                    : null;

                return ok({
                    ...publicSnippet(snippet),
                    text: snippet.kind === 'package' ? composed?.text || '' : snippet.command,
                    chain: snippet.kind === 'package' ? snippet.chain : undefined,
                    missingSteps: composed?.missing?.length ? composed.missing : undefined,
                    runImmediately: snippet.runImmediately || undefined,
                });
            },
        },

        {
            name: 'list_inventory',
            title: 'List the inventory',
            readOnly: true,
            description:
                'List one part of your inventory other than hosts and snippets: the keys in the '
                + 'keychain (names and fingerprints; the key material itself is never returned), the '
                + 'proxies, the MCP servers you are given, or the folders hosts are filed in. Use '
                + 'list_hosts for hosts and list_snippets for snippets.',
            shape: {
                kind: z.enum(['keys', 'proxies', 'servers', 'folders']).describe('Which collection.'),
                query: z.string().optional().describe('Filter by name. Omit to list everything.'),
            },
            handler: async (input, ctx) => {
                const needle = clean(input.query).toLowerCase();
                switch (input.kind) {
                    case 'keys': {
                        const keys = agentKeys(ctx).filter(key => matches(needle, key.name, key.type, key.comment));
                        return ok({ total: keys.length, keys: keys.slice(0, MAX_LIST).map(publicKey) });
                    }
                    case 'proxies': {
                        const proxies = agentProxies(ctx)
                            .filter(proxy => matches(needle, proxy.name, proxy.host, proxy.type));
                        return ok({ total: proxies.length, proxies: proxies.slice(0, MAX_LIST).map(publicProxy) });
                    }
                    case 'servers': {
                        const servers = agentServers(ctx)
                            .filter(server => matches(needle, server.name, server.command, server.url));
                        return ok({ total: servers.length, servers: servers.map(publicServer) });
                    }
                    case 'folders': {
                        const folders = (await store.getFolders()).filter(folder => matches(needle, folder.name));
                        return ok({
                            total: folders.length,
                            folders: folders.slice(0, MAX_LIST).map(folder => ({
                                id: folder.id,
                                name: folder.name || '',
                                parentId: folder.parentId || '',
                            })),
                        });
                    }
                    default:
                        return fail(`Unknown collection "${input.kind}".`);
                }
            },
        },

        /* ---------------------------------------------------------- *
         * Keeping the kit
         * ---------------------------------------------------------- */

        {
            name: 'save_snippet',
            title: 'Save a snippet',
            readOnly: false,
            description:
                'Create or update a snippet in your inventory: a command worth keeping, or a spec, which '
                + 'is a document such as a runbook or a procedure you worked out. Give an id to update an '
                + 'existing one; omit it to create. Save a procedure as a spec once it has worked, so it '
                + 'can be found next time with list_snippets.',
            shape: {
                id: z.string().optional().describe('The id of the snippet to update. Omit to create a new one.'),
                name: z.string().min(1).max(snippetConfig.MAX_NAME_LENGTH).optional()
                    .describe('The name. Required when creating.'),
                kind: z.enum(SNIPPET_KINDS).optional()
                    .describe('"command" for shell text, "spec" for a document. Defaults to command when creating.'),
                text: z.string().optional().describe('The command text, or the document for a spec.'),
                description: z.string().max(snippetConfig.MAX_NAME_LENGTH * 4).optional()
                    .describe('One line on what it is for.'),
                tags: z.array(z.string()).optional().describe('Tags, replacing the current set.'),
                hostIds: z.array(z.string()).optional()
                    .describe('Host ids this applies to. Empty or omitted means every host.'),
            },
            handler: async (input, ctx) => {
                const existing = input.id ? agentSnippets(ctx).find(entry => entry.id === input.id) : null;
                if (input.id && !existing) {
                    return fail(`There is no snippet with the id "${input.id}" in your inventory.`);
                }
                if (existing?.kind === 'package' && input.text !== undefined) {
                    return fail('That snippet is a package of steps. Its steps are edited by the user in the library.');
                }

                const draft = {
                    ...(existing || { agentId: ctx.agentId || '' }),
                    ...(input.name !== undefined ? { name: input.name } : {}),
                    ...(input.kind !== undefined ? { kind: input.kind } : {}),
                    ...(input.text !== undefined ? { command: input.text } : {}),
                    ...(input.description !== undefined ? { description: input.description } : {}),
                    ...(input.tags !== undefined ? { tags: input.tags } : {}),
                    ...(input.hostIds !== undefined ? { hostIds: input.hostIds } : {}),
                };
                if (!existing && !draft.kind) draft.kind = 'command';

                const record = snippetConfig.normalizeSnippet(draft);
                const problem = snippetConfig.validateSnippet(record);
                if (problem) return fail(problem);

                const saved = store.saveSnippet(record);
                changed(ctx, 'snippets');
                return ok({ saved: existing ? 'updated' : 'created', ...publicSnippet(saved) });
            },
        },

        {
            name: 'save_host',
            title: 'Save a host',
            readOnly: false,
            description:
                'Create or update a saved host in your inventory, credentials included. Give an id to '
                + 'update; omit it to create. Four ways to authenticate: "password" with a password, "key" '
                + 'with a private key pasted here, "keychain" with the id of a key from list_inventory, or '
                + '"agent" for the SSH agent. The method is inferred from what you give when you do not '
                + 'name it. A secret you set is stored encrypted and is never shown back to you; the '
                + 'record only says whether one is set. Leave a secret out to keep the one already stored.',
            shape: {
                id: z.string().optional().describe('The host id to update. Omit to create a new one.'),
                name: z.string().min(1).max(120).optional().describe('Display name. Required when creating.'),
                address: z.string().max(253).optional().describe('Hostname or IP. Required when creating.'),
                port: z.number().int().min(1).max(65535).optional().describe('Defaults to 22.'),
                username: z.string().max(120).optional(),
                protocol: z.enum(HOST_PROTOCOLS).optional().describe('Defaults to ssh.'),
                authMethod: z.enum(AUTH_METHODS).optional()
                    .describe('password, key, keychain or agent. Inferred from the fields given when omitted.'),
                password: z.string().max(1000).optional().describe('The password, for authMethod password.'),
                privateKey: z.string().max(20000).optional().describe('A private key in PEM or OpenSSH form, for authMethod key.'),
                passphrase: z.string().max(1000).optional().describe('The passphrase of that private key, if it has one.'),
                keychainKeyId: z.string().optional().describe('A key id from the keychain, for authMethod keychain.'),
                tags: z.array(z.string()).optional().describe('Tags, replacing the current set.'),
                folderId: z.string().optional().describe('Folder id from list_inventory. Empty for the top level.'),
                jumpHostId: z.string().optional().describe('The id of a saved host to hop through. Empty for none.'),
                proxyId: z.string().optional().describe('The id of a saved proxy. Empty for none.'),
                initCommand: z.string().max(2000).optional().describe('A command to run when the session opens.'),
            },
            handler: async (input, ctx) => {
                let existing = null;
                if (input.id) {
                    const found = ownHost(ctx, input.id);
                    if (found.error) return fail(found.error);
                    existing = found.host;
                }

                if (!existing && (!clean(input.name) || !clean(input.address))) {
                    return fail('A new host needs a name and an address.');
                }
                if (input.keychainKeyId && !agentKeys(ctx).some(key => key.id === input.keychainKeyId)) {
                    return fail(`There is no key with the id "${input.keychainKeyId}" in the keychain.`);
                }
                if (input.jumpHostId) {
                    const hop = ownHost(ctx, input.jumpHostId);
                    if (hop.error) return fail(hop.error);
                    if (input.id && input.jumpHostId === input.id) return fail('A host cannot be its own jump host.');
                }
                if (input.proxyId && !agentProxies(ctx).some(proxy => proxy.id === input.proxyId)) {
                    return fail(`There is no proxy with the id "${input.proxyId}" in your inventory.`);
                }
                if (input.folderId && !(await store.getFolders()).some(folder => folder.id === input.folderId)) {
                    return fail(`There is no folder with the id "${input.folderId}".`);
                }

                // Only the fields named above reach the store. The secrets
                // among them are handed over as they are: the store encrypts
                // them on the way in, and merges a stored one back over an
                // edit that left it out, the same as a save from the editor.
                const patch = {};
                if (input.name !== undefined) patch.name = clean(input.name, 120);
                if (input.address !== undefined) patch.host = clean(input.address, 253);
                if (input.port !== undefined) patch.port = input.port;
                if (input.username !== undefined) patch.username = clean(input.username, 120);
                if (input.protocol !== undefined) patch.protocol = input.protocol;
                if (input.authMethod !== undefined) patch.authMethod = input.authMethod;
                // A reference to one of this agent's secrets is resolved here,
                // once, and the store encrypts the value the way it does one
                // the user typed. Another agent's is not this agent's to use.
                if (input.password !== undefined) patch.password = secrets.resolve(input.password, ctx.agentId);
                if (input.privateKey !== undefined) patch.privateKey = secrets.resolve(input.privateKey, ctx.agentId);
                if (input.passphrase !== undefined) patch.passphrase = secrets.resolve(input.passphrase, ctx.agentId);
                if (input.keychainKeyId !== undefined) patch.keychainKeyId = clean(input.keychainKeyId, 80);
                if (input.tags !== undefined) patch.tags = input.tags;
                if (input.folderId !== undefined) patch.folderId = clean(input.folderId, 80);
                if (input.jumpHostId !== undefined) patch.jumpHostId = clean(input.jumpHostId, 80);
                if (input.proxyId !== undefined) patch.proxyId = clean(input.proxyId, 80);
                if (input.initCommand !== undefined) patch.initCommand = input.initCommand;

                // The method follows the credential given, so a call that
                // hands over a password does not have to also say "password".
                const implied = patch.privateKey ? 'key'
                    : patch.password ? 'password'
                        : patch.keychainKeyId ? 'keychain'
                            : '';
                if (!existing) {
                    patch.agentId = ctx.agentId || '';
                    if (patch.port === undefined) patch.port = 22;
                    if (patch.protocol === undefined) patch.protocol = 'ssh';
                    if (patch.authMethod === undefined) patch.authMethod = implied || 'agent';
                } else if (patch.authMethod === undefined && implied && existing.authMethod !== implied) {
                    patch.authMethod = implied;
                }

                const saved = store.saveHost({ ...(existing ? { id: existing.id } : {}), ...patch });
                if (!saved) return fail('The host could not be saved.');
                changed(ctx, 'hosts');
                return ok({ saved: existing ? 'updated' : 'created', host: publicHost(saved) });
            },
        },

        {
            name: 'save_proxy',
            title: 'Save a proxy',
            readOnly: false,
            description:
                'Create or update a proxy in your inventory, password included. Give an id to update; '
                + 'omit it to create. A password you set is stored encrypted and never shown back; leave '
                + 'it out to keep the one already stored.',
            shape: {
                id: z.string().optional().describe('The proxy id to update. Omit to create a new one.'),
                name: z.string().max(120).optional(),
                type: z.enum(proxyConfig.PROXY_TYPES).optional().describe('Defaults to socks5.'),
                host: z.string().max(253).optional().describe('Required when creating.'),
                port: z.number().int().min(1).max(65535).optional().describe('Defaults to the type\'s usual port.'),
                username: z.string().max(120).optional(),
                password: z.string().max(1000).optional().describe('The proxy password, if it needs one.'),
                remoteDns: z.boolean().optional().describe('Let the proxy resolve names. Defaults to true.'),
                viaProxyId: z.string().optional().describe('The id of a proxy to chain through. Empty for none.'),
                timeout: z.number().int().optional().describe('Connect timeout in milliseconds.'),
            },
            handler: async (input, ctx) => {
                const existing = input.id ? agentProxies(ctx).find(entry => entry.id === input.id) : null;
                if (input.id && !existing) {
                    return fail(`There is no proxy with the id "${input.id}" in your inventory.`);
                }
                if (input.viaProxyId && !agentProxies(ctx).some(proxy => proxy.id === input.viaProxyId)) {
                    return fail(`There is no proxy with the id "${input.viaProxyId}" in your inventory.`);
                }

                const patch = {};
                for (const field of ['name', 'type', 'host', 'port', 'username', 'remoteDns', 'viaProxyId', 'timeout']) {
                    if (input[field] !== undefined) patch[field] = input[field];
                }
                if (!existing) patch.agentId = ctx.agentId || '';

                const record = proxyConfig.normalizeProxy({ ...(existing || {}), ...patch });
                const problem = proxyConfig.validateProxy(record);
                if (problem) return fail(problem);

                // The password rides beside the normalised record rather than
                // through it: the normaliser drops fields it does not know,
                // and the store merges a stored one back in when none is sent.
                const saved = store.saveProxy(input.password !== undefined
                    ? { ...record, password: secrets.resolve(input.password, ctx.agentId) }
                    : record);
                changed(ctx, 'proxies');
                return ok({ saved: existing ? 'updated' : 'created', proxy: publicProxy(saved) });
            },
        },

        {
            name: 'save_key',
            title: 'Save a key',
            readOnly: false,
            description:
                'Add a private key to the keychain, or update one by id, so hosts can use it with '
                + 'authMethod keychain. The algorithm and fingerprint are read from the key itself. '
                + 'The material is stored encrypted and never shown back; list_inventory shows the '
                + 'name and fingerprint. Leave the key out on an update to keep the one stored.',
            shape: {
                id: z.string().optional().describe('The key id to update. Omit to add a new one.'),
                name: z.string().min(1).max(120).optional().describe('A name. Required when adding.'),
                privateKey: z.string().max(20000).optional().describe('The private key. Required when adding.'),
                passphrase: z.string().max(1000).optional().describe('Its passphrase, if it has one.'),
                publicKey: z.string().max(4000).optional().describe('The public half, if you have it. Gives the fingerprint.'),
                comment: z.string().max(200).optional(),
            },
            handler: async (input, ctx) => {
                const existing = input.id ? agentKeys(ctx).find(entry => entry.id === input.id) : null;
                if (input.id && !existing) {
                    return fail(`There is no key with the id "${input.id}" in the keychain.`);
                }
                if (!existing && (!clean(input.name) || !String(input.privateKey || '').trim())) {
                    return fail('A new key needs a name and the private key.');
                }

                const patch = {};
                if (input.name !== undefined) patch.name = clean(input.name, 120);
                if (input.privateKey !== undefined) patch.privateKey = input.privateKey;
                if (input.passphrase !== undefined) patch.passphrase = input.passphrase;
                if (input.publicKey !== undefined) patch.publicKey = String(input.publicKey).trim();
                if (input.comment !== undefined) patch.comment = clean(input.comment, 200);
                if (!existing) patch.agentId = ctx.agentId || '';

                // Read off the key rather than asked for: see keygen.identify.
                if (patch.privateKey !== undefined || patch.publicKey !== undefined) {
                    Object.assign(patch, keygen.identify({
                        publicKey: patch.publicKey ?? existing?.publicKey,
                        privateKey: patch.privateKey,
                    }));
                }

                const saved = store.saveKey({ ...(existing ? { id: existing.id } : {}), ...patch });
                changed(ctx, 'keys');
                return ok({ saved: existing ? 'updated' : 'created', key: publicKey(saved) });
            },
        },

        {
            name: 'list_mcp_library',
            title: 'Browse the MCP library',
            readOnly: true,
            description:
                'The library of MCP servers ready to switch on: the reference servers (filesystem, git, '
                + 'fetch, memory, time), GitHub, Playwright, Brave Search, Context7, PostgreSQL, SQLite, '
                + 'Kubernetes, Grafana, Slack and more, each with the fields it needs (a folder, a token). '
                + 'Pass a query to also search the official MCP registry. Switch one on with '
                + 'save_mcp_server, giving its template id and the field values.',
            shape: {
                query: z.string().max(120).optional().describe('Words to filter by, and to search the registry with.'),
                category: z.enum(mcpLibrary.CATEGORIES).optional().describe('Only this shelf of the curated library.'),
                registry: z.boolean().optional().describe('Also search the official registry. Defaults to true when a query is given.'),
            },
            handler: async (input) => {
                const curated = mcpLibrary.list({ query: input.query || '', category: input.category || '' });
                let registry = { templates: [], error: '' };
                if (input.query && input.registry !== false) registry = await mcpLibrary.search(input.query, { limit: 15 });
                const brief = (template) => ({
                    template: template.id,
                    name: template.name,
                    category: template.category,
                    description: template.description,
                    transport: template.transport,
                    fields: template.fields.map(field => ({ key: field.key, label: field.label, required: field.required, secret: field.secret })),
                });
                return ok({
                    curated: curated.map(brief),
                    registry: registry.templates.map(brief),
                    ...(registry.error ? { registryError: registry.error } : {}),
                });
            },
        },

        {
            name: 'save_mcp_server',
            title: 'Add an MCP server',
            readOnly: false,
            description:
                'Add or update an MCP server in your inventory, so its tools are available to you in later '
                + 'conversations. Two ways: give a `template` id from list_mcp_library with the `values` its '
                + 'fields ask for, or describe the server yourself. Give the name of an existing server to '
                + 'update it. A stdio server is a command to spawn; an http server is a URL. Its tools reach '
                + 'you after the conversation restarts.',
            shape: {
                name: z.string().min(1).max(60).optional().describe('The server\'s name. Matches an existing one to update it. Defaults to the template\'s name.'),
                template: z.string().max(200).optional().describe('A template id from list_mcp_library, e.g. "filesystem" or "registry:io.github.x/y".'),
                values: z.record(z.string(), z.string()).optional().describe('The template\'s fields, by key: a folder, a token, a URL.'),
                transport: z.enum(['stdio', 'http']).optional().describe('Defaults to stdio.'),
                command: z.string().max(500).optional().describe('The executable, for stdio.'),
                args: z.array(z.string()).optional().describe('Arguments, for stdio.'),
                url: z.string().max(500).optional().describe('The endpoint, for http.'),
                env: z.record(z.string(), z.string()).optional()
                    .describe('Environment variables for a stdio server.'),
                headers: z.record(z.string(), z.string()).optional()
                    .describe('HTTP headers for an http server, e.g. Authorization.'),
            },
            handler: async (input, ctx) => {
                const agent = agents.get(ctx.agentId);
                if (!agent) return fail('This conversation has no agent to add a server to.');

                const servers = agent.mcpServers || [];

                // From the library: the template says what the record is.
                let fromTemplate = null;
                if (input.template) {
                    const template = await mcpLibrary.resolve(input.template);
                    if (!template) return fail(`There is no template "${input.template}" in the library.`);
                    const made = mcpLibrary.instantiate(template, input.values || {}, { name: input.name || '', agentId: agent.id });
                    if (made.error) return fail(made.error);
                    fromTemplate = made.server;
                }

                const name = clean(input.name || fromTemplate?.name, 60);
                if (!name) return fail('A server needs a name.');
                const existing = servers.find(server => server.name.toLowerCase() === name.toLowerCase());

                const draft = {
                    ...(existing || {}),
                    ...(fromTemplate || {}),
                    name,
                    ...(input.transport !== undefined ? { transport: input.transport } : {}),
                    ...(input.command !== undefined ? { command: input.command } : {}),
                    ...(input.args !== undefined ? { args: input.args } : {}),
                    ...(input.url !== undefined ? { url: input.url } : {}),
                    ...(input.env !== undefined ? { env: input.env } : {}),
                    ...(input.headers !== undefined ? { headers: input.headers } : {}),
                };
                if (!draft.transport) draft.transport = 'stdio';
                // Credentials go to the secrets store; the record keeps references.
                const vaulted = [];
                if (draft.env) {
                    const kept = vaultCredentials(name, draft.env);
                    draft.env = kept.map;
                    vaulted.push(...kept.moved);
                }
                if (draft.headers) {
                    const kept = vaultCredentials(name, draft.headers);
                    draft.headers = kept.map;
                    vaulted.push(...kept.moved);
                }
                if (draft.transport === 'stdio' && !clean(draft.command)) return fail('A stdio server needs a command.');
                if (draft.transport === 'http' && !/^https?:\/\//i.test(String(draft.url || ''))) {
                    return fail('An http server needs a URL starting with http:// or https://.');
                }

                const next = existing
                    ? servers.map(server => (server === existing ? draft : server))
                    : [...servers, draft];
                const result = agents.save({ id: agent.id, mcpServers: next });
                if (result?.error) return fail(result.error);

                const saved = (agents.get(agent.id)?.mcpServers || []).find(
                    server => server.name.toLowerCase() === name.toLowerCase(),
                );
                if (!saved) return fail('The server definition was not accepted.');
                changed(ctx, 'mcp');

                // A browser the user just approved adding is a browser they
                // want used, so browser use comes on with it. Off, the server
                // would be saved and then quietly left out of every run.
                // Required here rather than at the top: the settings module
                // needs Electron, which this one is tested without.
                if (isBrowserServer(saved)) {
                    const assistantSettings = require('./settings');
                    if (!assistantSettings.get(agent.id).browserUse) assistantSettings.set({ browserUse: true }, agent.id);
                }

                // Shake hands with it now, so a wrong command or a stale
                // token is found here rather than at the next conversation.
                const status = await mcpProbe.check(agent.id, saved.id);
                return ok({
                    saved: existing ? 'updated' : 'created',
                    server: publicServer(saved),
                    ...(vaulted.length ? { secretsStored: vaulted, secretsNote: 'Those values went into the encrypted store; the record holds references.' } : {}),
                    reachable: status.ok,
                    ...(status.ok
                        ? { tools: status.tools, serverName: status.name, serverVersion: status.version }
                        : { problem: status.error }),
                    note: status.ok
                        ? 'Its tools become available when the conversation next starts.'
                        : 'It was saved, but it did not answer the handshake. Fix the definition, or tell the user what it needs.',
                });
            },
        },

        {
            name: 'save_folder',
            title: 'Save a folder',
            readOnly: false,
            description:
                'Create or rename a folder that hosts are filed in. Give an id to update; omit it to create. '
                + 'File a host into it with save_host.',
            shape: {
                id: z.string().optional().describe('The folder id to update. Omit to create a new one.'),
                name: z.string().min(1).max(120).describe('The folder name.'),
                parentId: z.string().optional().describe('The id of the folder this sits in. Empty for the top level.'),
            },
            handler: async (input, ctx) => {
                const folders = await store.getFolders();
                const existing = input.id ? folders.find(folder => folder.id === input.id) : null;
                if (input.id && !existing) return fail(`There is no folder with the id "${input.id}".`);
                if (input.parentId && !folders.some(folder => folder.id === input.parentId)) {
                    return fail(`There is no folder with the id "${input.parentId}".`);
                }
                if (input.parentId && input.id && input.parentId === input.id) {
                    return fail('A folder cannot sit inside itself.');
                }

                const saved = store.saveFolder({
                    ...(existing ? { id: existing.id } : {}),
                    name: clean(input.name, 120),
                    ...(input.parentId !== undefined ? { parentId: clean(input.parentId, 80) } : {}),
                });
                changed(ctx, 'hosts');
                return ok({
                    saved: existing ? 'updated' : 'created',
                    folder: { id: saved.id, name: saved.name, parentId: saved.parentId || '' },
                });
            },
        },

        {
            name: 'delete_inventory_item',
            title: 'Delete from the inventory',
            readOnly: false,
            description:
                'Delete one record from your inventory: a host, a snippet, a proxy, a key, an MCP '
                + 'server (by name), or a folder. Deleting a folder moves what was in it up a level; '
                + 'deleting a key leaves hosts that used it unable to connect until they are given '
                + 'another. Only delete something the user has asked to have removed.',
            shape: {
                kind: z.enum(KINDS).describe('What kind of record.'),
                id: z.string().describe('Its id, or for a server its name.'),
            },
            handler: async (input, ctx) => {
                switch (input.kind) {
                    case 'host': {
                        const found = ownHost(ctx, input.id);
                        if (found.error) return fail(found.error);
                        const open = transcript.list().some(session => session.hostId === input.id);
                        if (open) return fail('A session to that host is open. Close it first.');
                        store.deleteHost(input.id);
                        changed(ctx, 'hosts');
                        return ok({ deleted: 'host', id: input.id, name: found.host.name || '' });
                    }
                    case 'snippet': {
                        const snippet = agentSnippets(ctx).find(entry => entry.id === input.id);
                        if (!snippet) return fail(`There is no snippet with the id "${input.id}" in your inventory.`);
                        store.deleteSnippet(input.id);
                        changed(ctx, 'snippets');
                        return ok({ deleted: 'snippet', id: input.id, name: snippet.name });
                    }
                    case 'proxy': {
                        const proxy = agentProxies(ctx).find(entry => entry.id === input.id);
                        if (!proxy) return fail(`There is no proxy with the id "${input.id}" in your inventory.`);
                        store.deleteProxy(input.id);
                        changed(ctx, 'proxies');
                        return ok({ deleted: 'proxy', id: input.id, name: proxy.name || proxy.host });
                    }
                    case 'key': {
                        const key = agentKeys(ctx).find(entry => entry.id === input.id);
                        if (!key) return fail(`There is no key with the id "${input.id}" in the keychain.`);
                        const users = agentHosts(ctx).filter(host => host.keychainKeyId === input.id);
                        store.deleteKey(input.id);
                        changed(ctx, 'keys');
                        return ok({
                            deleted: 'key',
                            id: input.id,
                            name: key.name || '',
                            hostsLeftWithoutIt: users.length ? users.map(host => host.id) : undefined,
                        });
                    }
                    case 'server': {
                        const agent = agents.get(ctx.agentId);
                        const servers = agent?.mcpServers || [];
                        const wanted = clean(input.id, 80).toLowerCase();
                        const server = servers.find(entry => entry.name.toLowerCase() === wanted || entry.id === input.id);
                        if (!server) return fail(`There is no MCP server named "${input.id}" in your inventory.`);
                        const result = agents.save({ id: agent.id, mcpServers: servers.filter(entry => entry !== server) });
                        if (result?.error) return fail(result.error);
                        return ok({ deleted: 'server', name: server.name });
                    }
                    case 'folder': {
                        const folder = (await store.getFolders()).find(entry => entry.id === input.id);
                        if (!folder) return fail(`There is no folder with the id "${input.id}".`);
                        store.deleteFolder(input.id);
                        changed(ctx, 'hosts');
                        return ok({ deleted: 'folder', id: input.id, name: folder.name || '' });
                    }
                    default:
                        return fail(`Unknown kind "${input.kind}".`);
                }
            },
        },
    ];
}

module.exports = { build, KINDS, publicKey, publicProxy, publicServer, publicSnippet };

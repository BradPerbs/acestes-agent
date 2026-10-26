const store = require('../store');
const knownHosts = require('../known-hosts');
const agents = require('../agents');

/**
 * What sync carries (see sync.js), store by store: each as `{ list, apply,
 * subscribe?, present?, onPrime? }`, reading and writing through the same
 * export and import the backup uses, so secrets travel in the clear inside
 * the sealed record and are encrypted again by the store that receives them.
 *
 * Synced: hosts, folders, SSH keys, snippets and specs, proxies, trusted host
 * keys, agents (with their MCP servers and per-agent settings), the shared
 * assistant settings and API keys, the keychain's secrets, memory notes,
 * scheduled jobs and where each one runs.
 *
 * Kept per machine, because they name something only that machine has:
 *
 *   hosts      when it was last connected to; a local SSH agent socket;
 *              whether a tunnel opens by itself (it would listen on every
 *              machine at once)
 *   keys       Windows Hello keys, which live in this machine's TPM
 *   agents     the sandbox (granted folders are paths on this disk), hooks
 *              (commands run here), and which local sign-in each runtime uses
 *   settings   which runtimes are installed and selected, the local model
 *              server, voice models, sounds, how long chats are kept
 *   jobs       the run state (next and last run, failures), and a webhook's
 *              token, whose URL is this machine's loopback port
 *
 * `present(id)` stops a record from being taken for deleted when the store
 * holds it but cannot list it right now (a secret this machine cannot
 * decrypt, a one-shot job whose time passed before it arrived).
 */

const MACHINE_SETTINGS = [
    'providers', 'provider', 'model', 'localBaseUrl', 'voiceInput', 'voiceEngine', 'voiceModel', 'voiceLanguage',
    'doneSound', 'doneSoundVolume', 'historyDays', 'hiddenModels',
];
const MACHINE_AGENT_SETTINGS = ['accounts', 'menuAccounts'];
const JOB_RUNTIME = ['lastRunAt', 'lastStatus', 'nextRunAt', 'failures', 'runCount', 'updatedAt', 'token'];

const byId = list => Object.fromEntries((Array.isArray(list) ? list : []).filter(entry => entry?.id).map(entry => [String(entry.id), entry]));
const omit = (value, keys) => {
    const out = { ...value };
    for (const key of keys) delete out[key];
    return out;
};
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value && key in value).map(key => [key, value[key]]));

function createCollections({ notify = () => {}, selfId = () => '', placements }) {
    const lazy = {
        settings: () => require('../ai/settings'),
        secrets: () => require('../ai/secrets'),
        memory: () => require('../ai/memory'),
        jobs: () => require('../runs/jobs'),
    };

    // One decrypting export serves the five store collections in a round.
    let exported = null;
    let exportedAt = 0;
    const storeData = () => {
        if (!exported || Date.now() - exportedAt > 500) {
            exported = store.exportAll();
            exportedAt = Date.now();
        }
        return exported;
    };
    const dropCache = () => {
        exported = null;
    };
    const inventoryChanged = kind => notify('inventory-changed', { kind });

    /** One of the main store's collections. */
    function storeCollection(field, { strip = value => value, merge = value => value, remove, skip = () => false }) {
        return {
            list: () => {
                const out = {};
                for (const record of storeData()[field] || []) {
                    if (!record?.id || skip(record)) continue;
                    out[record.id] = strip(record);
                }
                return out;
            },
            apply: (id, value) => {
                const local = (storeData()[field] || []).find(record => record.id === id);
                dropCache();
                if (local && skip(local)) return;
                if (value === null) {
                    if (local) remove(id);
                } else {
                    store.importAll({ [field]: [merge({ ...value, id }, local)] }, { overwrite: true });
                }
                dropCache();
            },
            subscribe: (fn) => {
                store.onChanged(() => {
                    dropCache();
                    fn();
                });
            },
        };
    }

    const hosts = storeCollection('hosts', {
        strip: (host) => {
            const out = omit(host, ['lastConnectedAt', 'agentPath', 'hasPassword', 'hasPrivateKey', 'hasPassphrase']);
            if (Array.isArray(out.tunnels)) out.tunnels = out.tunnels.map(tunnel => omit(tunnel, ['autoStart']));
            return out;
        },
        merge: (host, local) => {
            const out = { ...host };
            if (local?.lastConnectedAt) out.lastConnectedAt = local.lastConnectedAt;
            if (local?.agentPath) out.agentPath = local.agentPath;
            if (Array.isArray(out.tunnels)) {
                const before = new Map((local?.tunnels || []).map(tunnel => [tunnel.id, tunnel]));
                out.tunnels = out.tunnels.map(tunnel => ({ ...tunnel, autoStart: Boolean(before.get(tunnel.id)?.autoStart) }));
            }
            return out;
        },
        remove: id => store.deleteHost(id),
    });

    const collections = {
        hosts,
        folders: storeCollection('folders', { remove: id => store.deleteFolder(id) }),
        keys: storeCollection('keys', {
            strip: key => omit(key, ['hasPassword', 'hasPrivateKey', 'hasPassphrase']),
            skip: key => Boolean(key.hello || key.helloCredential),
            remove: id => store.deleteKey(id),
        }),
        snippets: storeCollection('snippets', { remove: id => store.deleteSnippet(id) }),
        proxies: storeCollection('proxies', {
            strip: proxy => omit(proxy, ['hasPassword']),
            remove: id => store.deleteProxy(id),
        }),

        knownHosts: {
            list: () => knownHosts.exportAll() || {},
            apply: (id, entries) => {
                if (entries === null) knownHosts.forgetById(id);
                else knownHosts.importAll({ [id]: entries }, { overwrite: true });
            },
            subscribe: fn => knownHosts.onChanged(fn),
        },

        agents: {
            list: () => {
                const out = {};
                for (const agent of agents.exportAll().agents || []) {
                    const settings = omit(agent.settings || {}, MACHINE_AGENT_SETTINGS);
                    if (settings.starred && typeof settings.starred === 'object') settings.starred = omit(settings.starred, ['account']);
                    out[agent.id] = { ...omit(agent, ['sandbox', 'hooks']), settings };
                }
                return out;
            },
            apply: (id, value) => {
                const local = (agents.exportAll().agents || []).find(agent => agent.id === id);
                if (value === null) {
                    if (local) {
                        try {
                            agents.remove(id);
                        } catch (error) {
                            console.error('Sync could not remove an agent:', error.message);
                        }
                    }
                    return;
                }
                const settings = { ...(value.settings || {}), ...pick(local?.settings, MACHINE_AGENT_SETTINGS) };
                if (value.settings?.starred && local?.settings?.starred?.account) {
                    settings.starred = { ...value.settings.starred, account: local.settings.starred.account };
                }
                const merged = { ...value, id, settings };
                if (local?.sandbox) merged.sandbox = local.sandbox;
                if (local?.hooks) merged.hooks = local.hooks;
                agents.importAll({ agents: [merged] }, { overwrite: true });
            },
            /**
             * Joining: the agent every fresh install makes for itself is not
             * published as a second "Acestes" beside the fleet's, unless the
             * person here already made something of it (servers, hooks, notes).
             * Its settings do not count: picking a model on a new install is
             * the first thing anyone does, and the fleet's agent has its own.
             */
            onPrime: (fleetHas) => {
                if (fleetHas.size === 0) return;
                for (const agent of agents.exportAll().agents || []) {
                    if (fleetHas.has(agent.id)) continue;
                    const untouched = /^acestes$/i.test(String(agent.name || '').trim())
                        && !(agent.mcpServers || []).length
                        && !(agent.hooks || []).length;
                    if (!untouched) continue;
                    const notes = (lazy.memory().list(agent.id) || []).length;
                    if (notes > 0) continue;
                    try {
                        const fleetAgent = [...fleetHas][0];
                        if (agents.activeId() === agent.id && agents.get(fleetAgent)) agents.select(fleetAgent);
                        agents.remove(agent.id);
                    } catch (error) {
                        console.error('Sync could not set aside the new install\'s own agent:', error.message);
                    }
                }
            },
        },

        settings: {
            list: () => {
                const exportedSettings = lazy.settings().exportAll();
                const out = { config: omit(exportedSettings.config || {}, MACHINE_SETTINGS) };
                for (const [provider, value] of Object.entries(exportedSettings.keys || {})) {
                    if (value) out[`apikey:${provider}`] = value;
                }
                return out;
            },
            apply: (id, value) => {
                const settings = lazy.settings();
                if (id.startsWith('apikey:')) {
                    const name = id.slice('apikey:'.length);
                    settings.setApiKey(name, value === null ? '' : String(value));
                    // The fleet's Claude sign-in reaching a computer with no
                    // runtime switched on: Claude Code is switched on, if it
                    // is installed, so that computer can take tasks at once.
                    if (name === settings.CLAUDE_FLEET_TOKEN && value !== null && (settings.get().providers || []).length === 0) {
                        try {
                            if (require('../ai/providers/claude-code').findClaude()) settings.set({ providers: ['claude-code'] });
                        } catch (error) {
                            console.error('Sync could not switch Claude Code on:', error.message);
                        }
                    }
                } else if (id === 'config' && value) {
                    const local = settings.exportAll().config || {};
                    settings.importAll({ config: { ...value, ...pick(local, MACHINE_SETTINGS) } }, { overwrite: true });
                }
                try {
                    notify('ai-settings', settings.get());
                } catch {
                    // The window reads them again when it next asks.
                }
            },
        },

        secrets: {
            list: () => lazy.secrets().exportAll() || {},
            apply: (id, value) => {
                const slash = id.indexOf('/');
                const owner = slash >= 0 ? id.slice(0, slash) : '';
                const name = slash >= 0 ? id.slice(slash + 1) : id;
                if (value === null) lazy.secrets().remove(name, owner);
                else lazy.secrets().set(name, String(value), owner);
                inventoryChanged('secrets');
            },
            present: id => (lazy.secrets().list() || []).some(entry => `${entry.owner || ''}/${entry.name}` === id),
        },

        memory: {
            list: () => {
                const out = {};
                for (const [agentKey, entries] of Object.entries(lazy.memory().exportAll() || {})) {
                    for (const entry of entries || []) if (entry?.id) out[`${agentKey}/${entry.id}`] = entry;
                }
                return out;
            },
            apply: (id, value) => {
                const slash = id.indexOf('/');
                const agentKey = id.slice(0, slash);
                const noteId = id.slice(slash + 1);
                if (value === null) lazy.memory().remove(agentKey === 'default' ? '' : agentKey, noteId);
                else lazy.memory().importAll({ [agentKey]: [value] }, { overwrite: true });
            },
        },
    };

    // Jobs a device took in that its import refused (a one-shot whose time had
    // passed): held as present, so this device does not delete them for all.
    const refused = new Set();
    collections.jobs = {
        list: () => {
            const out = {};
            for (const job of lazy.jobs().exportAll() || []) if (job?.id) out[job.id] = omit(job, JOB_RUNTIME);
            return out;
        },
        apply: (id, value) => {
            const jobs = lazy.jobs();
            const local = jobs.get(id);
            if (value === null) {
                if (local) jobs.remove(id);
                refused.delete(id);
                return;
            }
            jobs.importAll([{ ...value, id, ...(local?.token ? { token: local.token } : {}) }], { overwrite: true });
            if (!jobs.get(id)) refused.add(id);
            else refused.delete(id);
        },
        present: id => refused.has(id),
    };

    // Where each job runs: on any device by default, made on the device that made it.
    collections.placements = {
        list: () => {
            const jobIds = new Set((lazy.jobs().exportAll() || []).map(job => job.id));
            const current = placements.read();
            let changed = false;
            for (const id of jobIds) {
                if (!current[id]) {
                    current[id] = { placement: 'any', origin: selfId() };
                    changed = true;
                }
            }
            for (const id of Object.keys(current)) {
                if (!jobIds.has(id) && !refused.has(id)) {
                    delete current[id];
                    changed = true;
                }
            }
            if (changed) placements.write(current);
            return { ...current };
        },
        apply: (id, value) => {
            const current = placements.read();
            if (value === null) delete current[id];
            else current[id] = { placement: String(value.placement || 'any'), origin: String(value.origin || '') };
            placements.write(current);
        },
    };

    return collections;
}

/** What to tell the windows after records from the fleet landed. */
function changedKinds(names) {
    const kinds = new Set();
    for (const name of names) {
        if (name === 'hosts' || name === 'folders') kinds.add('hosts');
        else if (['keys', 'snippets', 'proxies', 'secrets', 'knownHosts'].includes(name)) kinds.add(name);
    }
    return [...kinds];
}

module.exports = { createCollections, changedKinds, MACHINE_SETTINGS };

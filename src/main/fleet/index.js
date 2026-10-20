const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vault = require('../vault');
const agents = require('../agents');
const activity = require('../activity');
const { createDevice } = require('./device');
const { createHub } = require('./hub');
const { createTasks } = require('./tasks');
const { createSync } = require('./sync');
const { createCollections, changedKinds } = require('./collections');
const { createGate } = require('./placement');

/**
 * Devices: this Acestes and the others the user installed, on other PCs and
 * servers, working as one fleet. See device.js for how a fleet holds
 * together and relay-core.js for what the relay in the middle does.
 *
 * Every device is the equal of the others: the same agents, settings,
 * inventory, secrets, memory and jobs (sync.js, collections.js), any of them
 * can hand another a task (tasks.js), and a scheduled job runs once, on
 * whichever is on (placement.js). The one exception is the lock: a locked
 * device takes no tasks from the others and runs none of their jobs. It
 * still syncs, so it stays on par; it just cannot be made to do anything
 * from elsewhere.
 *
 * This file is the app's side of it: where the state is kept (fleet.json
 * beside the rest, every private key and the fleet key under the vault), what
 * this device says about itself to the others, and hub mode, where this
 * machine hosts the relay for the fleet.
 *
 * Like the channels, it waits while the app is locked: the keys cannot be
 * read, so it cannot sign in or open anything, and it starts when the vault
 * is unlocked.
 */

const statePath = () => path.join(app.getPath('userData'), 'fleet.json');
const relayPath = () => path.join(app.getPath('userData'), 'fleet-relay.json');
const syncPath = () => path.join(app.getPath('userData'), 'fleet-sync.json');

const DEFAULT_PORT = 7377;

let device = null;
let tasks = null;
let sync = null;
let gate = null;
let hub = null;
let hubError = '';
let notify = () => {};
let started = false;

function readState() {
    try {
        return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    } catch {
        return null;
    }
}

function writeState(state) {
    const file = statePath();
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, file);
}

function osLabel() {
    try {
        return os.version();
    } catch {
        return process.platform;
    }
}

/** This machine's addresses on its networks, for the hub's "others reach it at" hint. */
function addresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const entry of list || []) {
            if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
        }
    }
    return out;
}

/** What this device tells the others about itself. Cheap: it is read on every status. */
function describe() {
    let assistant = null;
    try {
        assistant = require('../ai');
    } catch {
        assistant = null;
    }
    const list = agents.snapshot()?.agents || [];
    return {
        hostname: os.hostname(),
        platform: process.platform,
        os: osLabel(),
        arch: process.arch,
        version: app.getVersion(),
        user: os.userInfo().username,
        agents: list.map((agent) => {
            let runtimes = [];
            try {
                runtimes = assistant?.settings.get(agent.id).providers || [];
            } catch {
                runtimes = [];
            }
            return { id: agent.id, name: agent.name || 'Agent', runtimes };
        }),
        computerUse: process.platform === 'win32' || process.platform === 'darwin',
        hub: hub?.listening() ? { port: hub.port() } : null,
        locked: device ? isLocked() : false,
        acceptsTasks: device ? !isLocked() : true,
    };
}

function hubSettings() {
    const saved = build().extra().hub || {};
    return {
        enabled: Boolean(saved.enabled),
        port: Number(saved.port) || DEFAULT_PORT,
        publicUrl: typeof saved.publicUrl === 'string' ? saved.publicUrl : '',
    };
}

function build() {
    if (device) return device;
    device = createDevice({
        load: readState,
        save: writeState,
        protect: value => vault.encryptSecret(value),
        unprotect: value => vault.decryptSecret(value),
        describe,
        defaultName: () => os.hostname(),
        // The hub's own device reaches it over loopback: its public address
        // may not route back to itself from behind the same NAT.
        localRelay: (relay) => {
            if (!hub?.listening()) return '';
            const own = hubSettings().publicUrl.replace(/\/+$/, '');
            return own && relay === own ? `ws://127.0.0.1:${hub.port()}` : '';
        },
        onChange: () => notify('fleet-changed', status()),
    });
    return device;
}

/**
 * Locked: the other devices may not have this one do anything (no tasks, none
 * of their jobs). Off unless switched on here. `accept: false` is what the
 * first version of the switch stored.
 */
function isLocked() {
    const extra = build().extra();
    if (typeof extra.locked === 'boolean') return extra.locked;
    return extra.accept === false;
}

const accepts = () => !isLocked();

function placementsStore() {
    return {
        read: () => ({ ...(build().extra().placements || {}) }),
        write: value => build().saveExtra({ placements: value }),
    };
}

function readSync() {
    try {
        return JSON.parse(fs.readFileSync(syncPath(), 'utf8'));
    } catch {
        return null;
    }
}

function writeSync(state) {
    const file = syncPath();
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
    fs.renameSync(`${file}.tmp`, file);
}

/**
 * Conversations, as a list every device shows: each device publishes the
 * ones it runs (title, agent, times), and the others hold a mirror of each
 * (tasks.js `ensureMirror`), whose messages are fetched from the device that
 * runs it when it is opened, and which carries on there when written into.
 * Only a device's own conversations are its to publish or delete.
 */
function conversationsCollection() {
    const assistant = require('../ai');
    const self = () => build().selfId();
    return {
        list: () => {
            // Every conversation being put down at once is not every one deleted.
            if (assistant.isClosingAll()) throw new Error('Conversations are closing.');
            const out = {};
            for (const entry of assistant.list()) {
                if (entry.device) continue;
                out[`${self()}/${entry.conversationId}`] = {
                    title: entry.title || '',
                    agentId: entry.agentId || '',
                    createdAt: entry.createdAt || 0,
                    updatedAt: entry.updatedAt || 0,
                    messages: entry.messages || 0,
                };
            }
            return out;
        },
        apply: (id, value) => {
            const slash = id.indexOf('/');
            const owner = id.slice(0, slash);
            const remoteCid = id.slice(slash + 1);
            if (!owner || owner === self()) return;
            if (value === null) buildTasks().dropMirror(owner, remoteCid);
            else buildTasks().ensureMirror({ deviceId: owner, remoteCid, ...value });
        },
        // The other devices' conversations are not in this one's list to be missed.
        present: id => !id.startsWith(`${self()}/`),
        // Looked at again when a turn ends or a conversation is named, not on every event.
        subscribe: fn => assistant.observe((event) => {
            if (event.type === 'result' || event.type === 'title' || event.type === 'error' || event.type === 'interrupted') fn();
        }),
    };
}

/** Everything the devices share, kept in step (sync.js, collections.js). */
function buildSync() {
    if (sync) return sync;
    sync = createSync({
        device: build(),
        collections: {
            ...createCollections({
                notify: (channel, payload) => notify(channel, payload),
                selfId: () => build().selfId(),
                placements: placementsStore(),
            }),
            conversations: conversationsCollection(),
        },
        persist: { load: readSync, save: writeSync },
        onApplied: (names) => {
            for (const kind of changedKinds(names)) notify('inventory-changed', { kind });
            notify('fleet-changed', status());
        },
    });
    return sync;
}

/** Whether this device runs a due job, of all the devices that have it (placement.js). */
function buildGate() {
    if (gate) return gate;
    gate = createGate({
        device: build(),
        placementOf: jobId => (build().extra().placements || {})[jobId] || null,
        locked: isLocked,
    });
    return gate;
}

/** Tasks to and from the other devices (tasks.js), wired to the assistant core. */
function buildTasks() {
    if (tasks) return tasks;
    const assistant = require('../ai');
    tasks = createTasks({
        device: build(),
        ai: {
            create: options => assistant.create(options),
            send: (id, text) => assistant.send(id, text),
            interrupt: id => assistant.interrupt(id),
            respondToApproval: payload => assistant.respondToApproval(payload),
            respondToQuestion: payload => assistant.respondToQuestion(payload),
            history: id => assistant.history(id),
            observe: fn => assistant.observe(fn),
            createMirror: options => assistant.createMirror(options),
            ingestRemote: (id, event) => assistant.ingestRemote(id, event),
            replaceRemoteEvents: (id, events, busy) => assistant.replaceRemoteEvents(id, events, busy),
            updateMirror: (id, meta) => assistant.updateMirror(id, meta),
            has: id => assistant.has(id),
            remoteOf: id => assistant.remoteOf(id),
            close: id => assistant.close(id),
            setRemoteBridge: bridge => assistant.setRemoteBridge(bridge),
            showConversation: (id, near) => assistant.showConversation(id, near),
            agents: () => (agents.snapshot()?.agents || []).map(agent => ({ id: agent.id, name: agent.name || 'Agent' })),
            activeAgentId: () => agents.activeId(),
        },
        persist: {
            load: () => build().extra().tasks,
            save: value => build().saveExtra({ tasks: value }),
        },
        accepts,
    });
    return tasks;
}

async function startHub() {
    const settings = hubSettings();
    await stopHub();
    if (!settings.enabled) return;
    hub = createHub({
        port: settings.port,
        host: '0.0.0.0',
        file: relayPath(),
        // Once this device is in a fleet, its hub serves that fleet only.
        allowFleet: (fleetId) => {
            const fleet = build().status().fleet;
            return !fleet || fleet.id === fleetId;
        },
    });
    try {
        await hub.start();
        hubError = '';
    } catch (error) {
        hubError = error.code === 'EADDRINUSE' ? `Port ${settings.port} is already in use.` : error.message;
        hub = null;
    }
}

async function stopHub() {
    const old = hub;
    hub = null;
    if (old) await old.stop();
}

function status() {
    const settings = hubSettings();
    return {
        ...build().status(),
        // The app's own lock (the vault): nothing here works while it is on.
        appLocked: vault.isLocked(),
        // This device's lock: the others may not have it do anything.
        deviceLocked: device ? isLocked() : false,
        sync: sync ? sync.status() : null,
        hub: {
            ...settings,
            listening: Boolean(hub?.listening()),
            error: hubError,
            addresses: addresses(),
        },
    };
}

const changed = () => notify('fleet-changed', status());

function audit(action, detail) {
    activity.record({ category: 'security', action, outcome: 'info', target: 'Devices', detail });
}

async function start(notifier) {
    if (typeof notifier === 'function') notify = notifier;
    if (started) return;
    if (vault.isLocked()) {
        vault.onUnlocked(() => start());
        return;
    }
    started = true;
    try {
        await startHub();
        // Before the connection, so a task that arrives first finds its handler.
        buildTasks();
        buildSync().start();
        build().start();
    } catch (error) {
        console.error('Could not start the fleet:', error.message);
    }
    changed();
}

async function stop() {
    sync?.stop();
    device?.stop();
    await stopHub();
}

/** Errors as `{ error }`, never thrown across the bridge. */
const guard = fn => async (...args) => {
    try {
        if (vault.isLocked()) return { error: 'Unlock the app first.' };
        const result = await fn(...args);
        return result?.error ? result : status();
    } catch (error) {
        return { error: error.message };
    }
};

module.exports = {
    start,
    stop,
    status,
    device: () => build(),
    // In a fleet, the app stays in the tray with the window closed: the other
    // devices may hand it work, and a hub has a relay to keep up.
    keepAlive: () => Boolean(device?.status().fleet || hub?.listening()),
    createFleet: guard(async ({ relay, name, hostHere, port, publicUrl } = {}) => {
        if (hostHere) {
            const chosenPort = Number(port) || DEFAULT_PORT;
            const url = String(publicUrl || '').trim().replace(/\/+$/, '') || `ws://${addresses()[0] || '127.0.0.1'}:${chosenPort}`;
            build().saveExtra({ hub: { enabled: true, port: chosenPort, publicUrl: url } });
            await startHub();
            if (!hub) return { error: hubError || 'The relay did not start.' };
            const result = build().createFleet({ relay: url, name });
            if (!result.error) audit('fleet.create', `Started a fleet, relay hosted here at ${url}`);
            return result;
        }
        const result = build().createFleet({ relay, name });
        if (!result.error) audit('fleet.create', `Started a fleet on the relay ${relay}`);
        return result;
    }),
    invite: async () => {
        if (vault.isLocked()) return { error: 'Unlock the app first.' };
        const result = build().createInvite();
        if (!result.error) audit('fleet.invite', 'Made a code to add a device');
        return result;
    },
    join: guard(async ({ code, name } = {}) => {
        const result = build().join(code, { name });
        if (!result.error) audit('fleet.join', `Joining the fleet of ${result.joining?.from || 'another device'}`);
        return result;
    }),
    remove: guard(async (deviceId) => {
        const name = build().deviceName(deviceId);
        const result = build().removeDevice(String(deviceId || ''));
        if (!result.error) audit('fleet.remove', `Removed ${name} from the fleet`);
        return result;
    }),
    leave: guard(async () => {
        const result = build().leave();
        audit('fleet.leave', 'Left the fleet');
        return result;
    }),
    rename: guard(async name => build().rename(name)),
    setLock: guard(async (on) => {
        build().saveExtra({ locked: Boolean(on) });
        build().announce();
        audit('fleet.lock', on
            ? 'Locked this device: the other devices may not have it do anything'
            : 'Unlocked this device: the other devices may hand it tasks and jobs again');
        return status();
    }),
    /** Where a job runs: 'any' device, or one device by id or name. */
    setPlacement: async (jobId, where) => {
        const ref = String(where || 'any').trim();
        let placement = 'any';
        if (ref && ref.toLowerCase() !== 'any') {
            const self = build().devices().find(entry => entry.self);
            const found = ref.toLowerCase() === 'this' || ref.toLowerCase() === 'here'
                ? self
                : build().devices().find(entry => entry.id === ref || entry.name.toLowerCase() === ref.toLowerCase());
            if (!found) return { error: `No device called "${ref}".` };
            placement = found.id;
        }
        const current = placementsStore().read();
        current[jobId] = { placement, origin: current[jobId]?.origin || build().selfId() };
        placementsStore().write(current);
        sync?.scheduleScan();
        return { placement, device: placement === 'any' ? 'any' : build().deviceName(placement) };
    },
    placementOf: (jobId) => {
        const place = (build().extra().placements || {})[jobId];
        if (!place || place.placement === 'any' || !build().inFleet()) return { placement: 'any', device: '' };
        return { placement: place.placement, device: build().deviceName(place.placement) };
    },
    /** The scheduler's question: does this device run this due job? See placement.js. */
    gateJob: (job, options) => {
        if (!started || vault.isLocked() || !build().inFleet()) return true;
        return buildGate()(job, options);
    },
    syncNow: async () => {
        if (!sync) return { error: 'Devices are still starting.' };
        await sync.sync();
        return status();
    },
    /** Hand a task to another device. See tasks.js `start`. */
    runOnDevice: async (options) => {
        if (vault.isLocked()) return { error: 'The app is locked.' };
        if (!started) return { error: 'Devices are still starting.' };
        return buildTasks().start(options || {});
    },
    setHub: guard(async ({ enabled, port, publicUrl } = {}) => {
        const current = hubSettings();
        build().saveExtra({
            hub: {
                enabled: enabled === undefined ? current.enabled : Boolean(enabled),
                port: Number(port) || current.port,
                publicUrl: publicUrl === undefined ? current.publicUrl : String(publicUrl).trim().replace(/\/+$/, ''),
            },
        });
        await startHub();
        build().start();
        return status();
    }),
};

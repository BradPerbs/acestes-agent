const { app } = require('electron');
const vault = require('../vault');
const agents = require('../agents');
const activity = require('../activity');
const jobs = require('../runs/jobs');
const secrets = require('../ai/secrets');
const { createConfig } = require('./config');
const { createGateway } = require('./gateway');
const { createTelegramAdapter } = require('./telegram');

/**
 * Channels: talking to the agent from somewhere other than the app.
 * Telegram so far: a gateway (gateway.js) on its own adapter. Another
 * chat app is another adapter beside it, with its own bot, its own paired
 * account and its own switch, independent of the others.
 *
 * Started by ipc once the window is wired, stopped on quit. None needs the
 * window: a message with the window closed starts its turn the way a
 * scheduled job does, and the app stays in the tray to keep answering while
 * a paired channel is on (see `keepAlive`).
 */

const ADAPTERS = {
    telegram: () => createTelegramAdapter(),
};

/** The channels, in the order the settings page and `message_user` take them. */
const NAMES = Object.keys(ADAPTERS);

let gateways = null;
let notify = () => {};

function build() {
    if (gateways) return gateways;
    const assistant = require('../ai');
    const config = createConfig({
        dir: () => app.getPath('userData'),
        crypt: {
            encrypt: value => vault.encryptSecret(value),
            decrypt: stored => (vault.isLocked() ? '' : vault.decryptSecret(stored)),
        },
    });
    const shared = {
        ai: assistant,
        agents: {
            list: () => (agents.snapshot()?.agents || []).map(agent => ({ id: agent.id, name: agent.name || 'Agent' })),
            activeId: () => agents.activeId(),
            get: (id) => {
                const agent = id ? agents.get(id) : null;
                return agent ? { id: agent.id, name: agent.name || 'Agent' } : null;
            },
        },
        jobs: { get: id => jobs.get(id) },
        isLocked: () => vault.isLocked(),
        scrub: text => secrets.scrub(text),
        onChange: () => notify('channels-changed', status()),
    };
    gateways = {};
    for (const name of NAMES) {
        const adapter = ADAPTERS[name]();
        gateways[name] = createGateway({
            ...shared,
            adapter,
            section: config.section(name),
            audit: ({ action, detail }) => activity.record({
                category: 'security',
                action,
                outcome: 'info',
                target: adapter.label,
                detail,
            }),
        });
    }
    // The agent's `message_user` goes out through here.
    assistant.setMessenger(({ text, from }) => messageOwner({ text, from }));
    return gateways;
}

const gatewayOf = (name) => {
    const found = build()[name];
    if (!found) throw new Error(`No channel called ${name}`);
    return found;
};

function status() {
    const all = build();
    return Object.fromEntries(NAMES.map(name => [name, all[name].status()]));
}

/**
 * The agent writing first goes where the user last wrote from, or failing
 * that the first channel that can take it. One message, not one per app.
 */
async function messageOwner({ text, from }) {
    const ready = NAMES.map(name => build()[name]).filter(gateway => gateway.ready());
    if (ready.length === 0) {
        return { error: 'No channel is paired: the user has not connected Telegram in Settings, Channels.' };
    }
    ready.sort((a, b) => b.lastMessageAt() - a.lastMessageAt());
    let last = null;
    for (const gateway of ready) {
        last = await gateway.messageOwner({ text, from });
        if (last?.sent) return last;
    }
    return last || { error: 'The message did not go.' };
}

function start(notifier) {
    if (typeof notifier === 'function') notify = notifier;
    try {
        for (const gateway of Object.values(build())) gateway.start();
    } catch (error) {
        console.error('Could not start the channels:', error.message);
    }
}

function stop() {
    for (const gateway of Object.values(gateways || {})) gateway.stop();
}

/** What the settings page calls, by channel name. */
const call = (name, method, ...args) => {
    try {
        return gatewayOf(name)[method](...args);
    } catch (error) {
        return { error: error.message };
    }
};

module.exports = {
    start,
    stop,
    status,
    connect: (name, credentials) => call(name, 'connect', credentials || {}),
    disconnect: name => call(name, 'disconnect'),
    pair: name => call(name, 'pair'),
    cancelPair: name => call(name, 'cancelPair'),
    unpair: name => call(name, 'unpair'),
    update: (name, patch) => call(name, 'update', patch || {}),
    test: name => call(name, 'test'),
    keepAlive: () => Object.values(gateways || {}).some(gateway => gateway.keepAlive()),
    deliverJob: (job, run) => {
        for (const gateway of Object.values(gateways || {})) gateway.deliverJob(job, run);
    },
    appClosing: () => {
        for (const gateway of Object.values(gateways || {})) gateway.appClosing();
    },
};

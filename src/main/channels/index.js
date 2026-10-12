const { app } = require('electron');
const vault = require('../vault');
const agents = require('../agents');
const activity = require('../activity');
const jobs = require('../runs/jobs');
const secrets = require('../ai/secrets');
const { createConfig } = require('./config');
const { createTelegramGateway } = require('./telegram');

/**
 * Channels: talking to the agent from somewhere other than the app. One so
 * far, Telegram; Discord or Slack would be another gateway beside it with
 * the same shape (see telegram.js), and this module would hold both.
 *
 * Started by ipc once the window is wired, stopped on quit. It does not
 * need the window: a message from the phone with the window closed starts
 * its turn the way a scheduled job does, and the app stays in the tray to
 * keep answering while a paired channel is on (see `keepAlive`).
 */

let gateway = null;
let notify = () => {};

function build() {
    if (gateway) return gateway;
    const assistant = require('../ai');
    const config = createConfig({
        dir: () => app.getPath('userData'),
        crypt: {
            encrypt: value => vault.encryptSecret(value),
            decrypt: stored => (vault.isLocked() ? '' : vault.decryptSecret(stored)),
        },
    });
    gateway = createTelegramGateway({
        config,
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
        onChange: state => notify('channels-changed', state),
        audit: ({ action, detail }) => activity.record({
            category: 'security',
            action,
            outcome: 'info',
            target: 'Telegram',
            detail,
        }),
    });
    // The agent's `message_user` goes out through here.
    assistant.setMessenger(({ text, from }) => gateway.messageOwner({ text, from }));
    return gateway;
}

function start(notifier) {
    if (typeof notifier === 'function') notify = notifier;
    try {
        build().start();
    } catch (error) {
        console.error('Could not start the channels:', error.message);
    }
}

function stop() {
    gateway?.stop();
}

const telegram = {
    connect: token => build().connect(token),
    disconnect: () => build().disconnect(),
    pair: () => build().pair(),
    cancelPair: () => build().cancelPair(),
    unpair: () => build().unpair(),
    update: patch => build().update(patch || {}),
    test: () => build().test(),
};

module.exports = {
    start,
    stop,
    status: () => build().status(),
    telegram,
    keepAlive: () => Boolean(gateway?.keepAlive()),
    deliverJob: (job, run) => gateway?.deliverJob(job, run),
    appClosing: () => gateway?.appClosing(),
};

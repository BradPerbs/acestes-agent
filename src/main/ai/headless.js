const ssh = require('../ssh');
const store = require('../store');
const transcript = require('../transcript');

/**
 * Sessions with no window.
 *
 * A session used to be a tab: the renderer made the pane, the pane dialled,
 * and the main process held the connection under the pane's id. The agent
 * therefore could not open one without a window to ask. This opens one from
 * the main process directly, under an id of its own, and the session is
 * complete without a pane: the connection, the transcript the agent reads
 * and the session log are all in main already. A window that is up, or one
 * that opens later, adopts it as a tab through `ssh.attach`, and from then
 * on it is drawn like any other.
 *
 * Only SSH. Telnet and serial sessions go through a pipe that expects a
 * window, and neither is what an unattended run reaches for.
 *
 * Two prompts a dial can raise are refused rather than answered: an unknown
 * host key, and a keyboard-interactive round. Both need a person, and a
 * headless run is by definition without one. The refusal names the fix, so
 * the agent can report it and the user can open the host once by hand.
 */

let counter = 0;
let notify = () => {};

function setNotifier(fn) {
    notify = fn || (() => {});
}

function nextId() {
    counter += 1;
    return `headless-${Date.now().toString(36)}-${counter.toString(36)}`;
}

const DEFAULT_COLS = 160;
const DEFAULT_ROWS = 48;

async function open({ hostId, agentId = '' } = {}) {
    const host = store.getHosts().find(entry => entry.id === hostId);
    if (!host) return { success: false, message: 'That host is not saved.' };
    if ((host.protocol || 'ssh') !== 'ssh') {
        return { success: false, message: 'Only SSH hosts can be opened without a window.' };
    }

    const sessionId = nextId();
    const result = await ssh.connect(
        { tabId: sessionId, hostId, cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
        {
            window: null,
            requestTrust: async () => false,
            requestKeyboardInteractive: async () => null,
        },
    );

    if (!result.success) {
        const message = /host key/i.test(result.message || '')
            ? `${result.message} Open this host once from the app so its key can be trusted.`
            : (result.message || 'The connection failed.');
        return { success: false, message };
    }

    if (agentId) transcript.claim(sessionId, agentId);
    notify('session-headless', { sessionId, hostId, agentId, hostName: host.name || '', address: host.host || '' });
    return { success: true, sessionId, route: result.route };
}

/** The sessions no window is drawing, for a window to adopt. */
function list() {
    const out = [];
    for (const [sessionId, session] of ssh.sessions) {
        if (session.attached) continue;
        out.push({
            sessionId,
            hostId: session.hostId,
            hostName: session.hostName,
            address: session.address,
            openedAt: session.openedAt,
            agentId: transcript.info(sessionId)?.agentId || '',
        });
    }
    return out;
}

/** Give a window a session, with what the session has shown so far. */
function attach(sessionId, window) {
    const shown = transcript.read(sessionId, { maxChars: 200000 });
    return ssh.attach(sessionId, window, { backlog: shown.available ? shown.text : '' });
}

module.exports = { setNotifier, open, list, attach };

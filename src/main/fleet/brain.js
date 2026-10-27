const crypto = require('crypto');

/**
 * A model borrowed from another computer of the fleet.
 *
 * A computer in the fleet takes tasks whether or not it has an AI agent of
 * its own that works: none switched on, none installed, or Claude Code not
 * signed in. Its conversation still runs on it, with its own tools, folders,
 * desktop, blocked list and approval mode, and with the tab on the asking
 * computer mirroring it as before (tasks.js). Only the model's side runs
 * elsewhere: a computer that has a working runtime starts it with this one's
 * system prompt and tool list and none of its own built-in tools, and hands
 * every tool call back to be checked and run where the conversation is. No
 * sign-in is copied anywhere, and nobody has to set anything up.
 *
 * Two sides, both in every install:
 *
 *   The computer with the conversation (`open`) sends the turns, runs the
 *   tool calls that come back, answers the approvals the runtime asks for
 *   itself (web search, subagents), and takes the events in order.
 *
 *   The computer with the model (`brain.open` and the rest) runs the
 *   runtime through `ai.hostRun` and passes everything back.
 *
 * Wire kinds, to the model: brain.open, brain.send, brain.interrupt,
 * brain.close. Back: brain.event, brain.tool, brain.approve. All ride on
 * device.js's sealed request and reply.
 */

const OPEN_TIMEOUT_MS = 90 * 1000;
const SEND_TIMEOUT_MS = 30 * 1000;
// A call can wait on a person (ask_user, an approval card) as long as they take.
const CALL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
// One tool result, well under what the hub carries in a message (1 MB)
// once it is sealed and encoded again.
const RESULT_BUDGET = 400 * 1024;
// How long an event that came early waits for the ones before it.
const GAP_MS = 2000;
// What the model's computer says about itself, not about the conversation:
// its model list, its plan's limits, its account. Kept there.
const KEPT_THERE = new Set(['models', 'limits', 'rate-limit', 'account']);

/** A tool result small enough to cross: pictures go first, then the text is cut. */
function fitResult(result) {
    const out = {
        text: String(result?.text ?? ''),
        ...(result?.isError ? { isError: true } : {}),
        ...(Array.isArray(result?.images) && result.images.length ? { images: result.images } : {}),
    };
    if (JSON.stringify(out).length <= RESULT_BUDGET) return out;
    if (out.images) {
        delete out.images;
        out.text += '\n\n(The picture was too large to send to the computer running the model, so it was left out.)';
        if (JSON.stringify(out).length <= RESULT_BUDGET) return out;
    }
    out.text = `${out.text.slice(0, RESULT_BUDGET - 2000)}\n… (cut short on the way to the computer running the model)`;
    return out;
}

/** What an approval request carries across: no signal, nothing that cannot be sent. */
const approvalOf = request => ({
    toolName: String(request?.toolName || request?.name || ''),
    name: String(request?.name || request?.toolName || ''),
    input: request?.input ?? {},
    local: Boolean(request?.local),
});

function createBrain({ device, ai, accepts = () => true, selfName = () => 'this computer' }) {
    /* ---------------- this side running the model ---------------- */

    // `${from}:${sid}` -> { session, n }
    const hosted = new Map();

    const hostedEntry = (from, sid) => {
        const entry = hosted.get(`${from}:${sid}`);
        if (!entry?.session) throw new Error(`${selfName()} is not running that conversation's model any more.`);
        return entry;
    };

    device.on('brain.open', async (data, meta) => {
        if (!accepts()) throw new Error(`${selfName()} is locked, so it does not lend its model.`);
        const sid = String(data.sid || '');
        if (!sid) throw new Error('No conversation was named.');
        const key = `${meta.from}:${sid}`;
        const entry = { session: null, n: 0 };
        hosted.set(key, entry);
        const forward = (event) => {
            if (!event || KEPT_THERE.has(event.type) || hosted.get(key) !== entry) return;
            entry.n += 1;
            device.send(meta.from, 'brain.event', { sid, n: entry.n, event });
        };
        try {
            const started = await ai.hostRun({
                systemPrompt: typeof data.systemPrompt === 'string' ? data.systemPrompt : '',
                toolSettings: data.toolSettings && typeof data.toolSettings === 'object' ? data.toolSettings : {},
                resumeSessionId: typeof data.resume === 'string' ? data.resume : '',
                forwardTool: (name, input) => device.request(meta.from, 'brain.tool', { sid, name, input }, { timeout: CALL_TIMEOUT_MS })
                    .catch(error => ({ text: `The call did not come back from ${meta.fromName}: ${error.message}`, isError: true })),
                requestApproval: request => device.request(meta.from, 'brain.approve', { sid, request: approvalOf(request) }, { timeout: CALL_TIMEOUT_MS })
                    .catch(error => ({ approved: false, message: `No answer from ${meta.fromName}: ${error.message}` })),
                onEvent: forward,
            });
            if (hosted.get(key) !== entry) {
                try {
                    await started.session.close?.();
                } catch {
                    // Already gone.
                }
                throw new Error('The conversation closed while its model was starting.');
            }
            entry.session = started.session;
            return { name: selfName(), runtime: started.runtime || '', model: started.model || '' };
        } catch (error) {
            if (hosted.get(key) === entry) hosted.delete(key);
            throw error;
        }
    });

    device.on('brain.send', async (data, meta) => {
        if (!accepts()) throw new Error(`${selfName()} is locked, so it does not lend its model.`);
        const entry = hostedEntry(meta.from, String(data.sid || ''));
        entry.session.send(String(data.text || ''), Array.isArray(data.images) ? data.images : []);
        return { sent: true };
    });

    device.on('brain.interrupt', async (data, meta) => {
        const entry = hostedEntry(meta.from, String(data.sid || ''));
        await entry.session.interrupt?.();
        return { interrupted: true };
    });

    device.on('brain.close', async (data, meta) => {
        const key = `${meta.from}:${String(data.sid || '')}`;
        const entry = hosted.get(key);
        hosted.delete(key);
        try {
            await entry?.session?.close?.();
        } catch {
            // Already gone.
        }
        return { closed: true };
    });

    /* ---------------- this side with the conversation ---------------- */

    // sid -> { peer, peerName, onEvent, runTool, approve, next, early, timer }
    const opened = new Map();

    const openedEntry = (sid, from) => {
        const entry = opened.get(sid);
        if (!entry || entry.peer !== from) throw new Error('That conversation is not open here any more.');
        return entry;
    };

    /** Hand on what has arrived in order; after a gap has waited long enough, the rest as it is. */
    function deliver(entry, flush = false) {
        while (entry.early.has(entry.next)) {
            const event = entry.early.get(entry.next);
            entry.early.delete(entry.next);
            entry.next += 1;
            entry.onEvent(event);
        }
        if (flush && entry.early.size) {
            const numbers = [...entry.early.keys()].sort((a, b) => a - b);
            for (const n of numbers) entry.onEvent(entry.early.get(n));
            entry.early.clear();
            entry.next = numbers[numbers.length - 1] + 1;
        }
        clearTimeout(entry.timer);
        entry.timer = null;
        if (entry.early.size) {
            entry.timer = setTimeout(() => deliver(entry, true), GAP_MS);
            entry.timer.unref?.();
        }
    }

    device.on('brain.event', async (data, meta) => {
        const entry = opened.get(String(data.sid || ''));
        if (!entry || entry.peer !== meta.from || !data.event) return undefined;
        const n = Number(data.n) || 0;
        if (n < entry.next) return undefined;
        entry.early.set(n, data.event);
        deliver(entry);
        return undefined;
    });

    device.on('brain.tool', async (data, meta) => {
        const entry = openedEntry(String(data.sid || ''), meta.from);
        const result = await entry.runTool(String(data.name || ''), data.input && typeof data.input === 'object' ? data.input : {});
        return fitResult(result);
    });

    device.on('brain.approve', async (data, meta) => {
        const entry = openedEntry(String(data.sid || ''), meta.from);
        const verdict = await entry.approve(approvalOf(data.request));
        return { approved: Boolean(verdict?.approved), ...(verdict?.message ? { message: String(verdict.message) } : {}), ...(verdict?.input ? { input: verdict.input } : {}) };
    });

    /**
     * Which computer lends its model: one that is online, takes work, and
     * says it has a runtime that is signed in. The one that asked for the
     * task first, since it has just shown it has a model, then the one
     * hosting the relay, then any.
     */
    function lender(preferred = '') {
        const candidates = device.devices().filter(entry => (
            !entry.self && device.isOnline(entry.id) && entry.info?.lendsModel && entry.info?.acceptsTasks !== false
        ));
        return candidates.find(entry => entry.id === preferred)
            || candidates.find(entry => entry.info?.hub)
            || candidates[0]
            || null;
    }

    /**
     * Start the model's side of a conversation on `peer`. Resolves the
     * session, shaped like a runtime's (send, interrupt, close), once the
     * other computer has its runtime up.
     *
     *   runTool(name, input)  checks and runs one call here, resolving a result
     *   approve(request)      asks here about a call of the runtime's own
     *   onEvent(event)        the runtime's events, in order
     */
    async function open({ peer, systemPrompt = '', toolSettings = {}, resumeSessionId = '', runTool, approve, onEvent }) {
        const sid = crypto.randomBytes(9).toString('base64url');
        // Session ids are kept as `fleet:<device>:<id>` so a conversation that
        // moves to another computer, or back to a runtime of its own, does not
        // try to resume a session that computer never had.
        const prefix = `fleet:${peer.id}:`;
        const resume = resumeSessionId.startsWith(prefix) ? resumeSessionId.slice(prefix.length) : '';
        const entry = {
            peer: peer.id,
            peerName: peer.name,
            onEvent: event => onEvent(event?.type === 'session' && event.sessionId ? { ...event, sessionId: `${prefix}${event.sessionId}` } : event),
            runTool,
            approve,
            next: 1,
            early: new Map(),
            timer: null,
        };
        opened.set(sid, entry);
        let reply;
        try {
            reply = await device.request(peer.id, 'brain.open', { sid, systemPrompt, toolSettings, resume }, { timeout: OPEN_TIMEOUT_MS });
        } catch (error) {
            opened.delete(sid);
            throw new Error(`${peer.name} could not lend its model: ${error.message}`);
        }
        const closeHere = () => {
            opened.delete(sid);
            clearTimeout(entry.timer);
        };
        return {
            lender: { id: peer.id, name: reply?.name || peer.name, runtime: reply?.runtime || '', model: reply?.model || '' },
            send(text, images = []) {
                device.request(peer.id, 'brain.send', { sid, text, images }, { timeout: SEND_TIMEOUT_MS }).catch((error) => {
                    entry.onEvent({ type: 'error', message: `${peer.name} did not take the message: ${error.message}` });
                });
            },
            async setModel() {},
            async setEffort() {},
            async interrupt() {
                try {
                    await device.request(peer.id, 'brain.interrupt', { sid }, { timeout: SEND_TIMEOUT_MS });
                } catch {
                    // Gone already, or offline: nothing left running to stop.
                }
            },
            async close() {
                closeHere();
                device.send(peer.id, 'brain.close', { sid });
            },
        };
    }

    return { open, lender, fitResult };
}

module.exports = { createBrain, fitResult };

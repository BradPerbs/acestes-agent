const fleetCrypto = require('./crypto');
const { signedText } = require('./relay-core');

/**
 * One device's connection to its fleet's relay.
 *
 * Opens the WebSocket, answers the relay's challenge with whatever the device
 * is doing (starting the fleet, signing in, or knocking with a code), and from
 * then on hands every frame to `onFrame`. It reconnects by itself, backing off
 * from one second to a minute, and stops for good on an answer that waiting
 * will not change: a code that was refused, a device taken off the roster.
 *
 * Frames sent while the connection is down are held, up to a few hundred, and
 * go when it is back; ephemeral ones (a status that is stale by then) are
 * dropped instead.
 */

const FATAL = new Set(['unknown-device', 'unknown-fleet', 'fleet-exists', 'bad-invite', 'bad-signature']);
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];
const PING_MS = 25 * 1000;
const OUTBOX_LIMIT = 500;

function relayUrl(base, fleetId) {
    return `${String(base || '').trim().replace(/\/+$/, '')}/v1/fleet/${encodeURIComponent(fleetId)}`;
}

function createRelayClient({ url, fleetId, identity, mode, onFrame, onState, WebSocketImpl = globalThis.WebSocket }) {
    let socket = null;
    let stopped = false;
    let attempt = 0;
    let retryTimer = null;
    let pingTimer = null;
    let ready = false;
    const outbox = [];
    // Questions to the relay itself (the sync log, claims), by request id.
    const calls = new Map();
    let callCounter = 0;

    const dropCalls = (reason) => {
        for (const entry of calls.values()) {
            clearTimeout(entry.timer);
            entry.reject(new Error(reason));
        }
        calls.clear();
    };

    const setState = (state, detail = {}) => {
        try {
            onState?.(state, detail);
        } catch (error) {
            console.error('Fleet state handler failed:', error.message);
        }
    };

    const raw = (frame) => {
        if (!socket || socket.readyState !== 1) return false;
        socket.send(JSON.stringify(frame));
        return true;
    };

    function schedule() {
        if (stopped || retryTimer) return;
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt += 1;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            connect();
        }, delay);
        retryTimer.unref?.();
    }

    function connect() {
        if (stopped) return;
        ready = false;
        setState('connecting');
        let ws;
        try {
            ws = new WebSocketImpl(url());
        } catch (error) {
            setState('offline', { message: error.message });
            schedule();
            return;
        }
        socket = ws;

        ws.onmessage = (event) => {
            let frame;
            try {
                frame = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
            } catch {
                return;
            }
            if (frame.rid && calls.has(frame.rid)) {
                const entry = calls.get(frame.rid);
                calls.delete(frame.rid);
                clearTimeout(entry.timer);
                if (frame.t === 'error') entry.reject(new Error(frame.message || frame.code));
                else entry.resolve(frame);
                return;
            }
            if (frame.t === 'challenge') {
                const current = mode();
                const sig = fleetCrypto.sign(identity(), signedText(current.action, fleetId(), identity().deviceId, frame.nonce));
                raw({ t: current.action, device: identity().deviceId, signPublic: identity().signPublic, sig, ...(current.extra || {}) });
                return;
            }
            if (frame.t === 'ready') {
                ready = true;
                attempt = 0;
                setState('online');
                while (outbox.length && raw(outbox[0])) outbox.shift();
            }
            if (frame.t === 'waiting') setState('waiting');
            if (frame.t === 'pong') return;
            if (frame.t === 'error' && FATAL.has(frame.code)) {
                stopped = true;
                setState('error', { code: frame.code, message: frame.message });
            }
            try {
                onFrame(frame);
            } catch (error) {
                console.error('Fleet frame handler failed:', error.message);
            }
        };

        ws.onclose = (event) => {
            if (socket === ws) socket = null;
            ready = false;
            dropCalls('The connection to the relay dropped.');
            if (event?.code === 4001) {
                stopped = true;
                setState('error', { code: 'removed', message: 'This device was removed from the fleet.' });
                try {
                    onFrame({ t: 'removed-self' });
                } catch (error) {
                    console.error('Fleet frame handler failed:', error.message);
                }
                return;
            }
            if (!stopped) setState('offline');
            schedule();
        };

        ws.onerror = () => {
            // onclose follows and does the retrying.
        };
    }

    return {
        start() {
            stopped = false;
            attempt = 0;
            if (!pingTimer) {
                pingTimer = setInterval(() => raw({ t: 'ping' }), PING_MS);
                pingTimer.unref?.();
            }
            if (!socket) connect();
        },
        stop() {
            stopped = true;
            dropCalls('Stopped.');
            clearTimeout(retryTimer);
            retryTimer = null;
            clearInterval(pingTimer);
            pingTimer = null;
            const ws = socket;
            socket = null;
            ready = false;
            try {
                ws?.close(1000, 'bye');
            } catch {
                // Already closed.
            }
            setState('stopped');
        },
        /** Send now when signed in, or hold it for when the connection is back. */
        send(frame, { ephemeral = false } = {}) {
            if (ready && raw(frame)) return true;
            if (ephemeral) return false;
            outbox.push(frame);
            if (outbox.length > OUTBOX_LIMIT) outbox.shift();
            return false;
        },
        isReady: () => ready,
        /** Ask the relay itself and wait for its answer: the sync log, a claim. */
        call(frame, { timeout = 20000 } = {}) {
            return new Promise((resolve, reject) => {
                if (!ready) {
                    reject(new Error('Not connected to the relay.'));
                    return;
                }
                callCounter += 1;
                const rid = `r${Date.now().toString(36)}${callCounter.toString(36)}`;
                const timer = setTimeout(() => {
                    calls.delete(rid);
                    reject(new Error('The relay did not answer in time.'));
                }, timeout);
                timer.unref?.();
                calls.set(rid, { resolve, reject, timer });
                if (!raw({ ...frame, rid })) {
                    calls.delete(rid);
                    clearTimeout(timer);
                    reject(new Error('Not connected to the relay.'));
                }
            });
        },
    };
}

module.exports = { createRelayClient, relayUrl };

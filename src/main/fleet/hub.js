const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { attach } = require('./ws-server');
const { createRelay } = require('./relay-core');
const fleetCrypto = require('./crypto');

/**
 * The relay in Node: an HTTP server whose WebSocket path is the fleet,
 * `/v1/fleet/<fleet id>`, with the relay core (relay-core.js) behind it and
 * a JSON file for its memory: the roster, the open invites and the mailboxes.
 *
 * Two ways it runs:
 *
 *   Inside Acestes, as hub mode: the always-on machine (an RDP server, say)
 *   hosts the relay for the fleet and is a device in it like the others,
 *   reaching its own relay over loopback.
 *
 *   On its own, on any server with Node 22 or later:
 *       node src/main/fleet/hub.js --port 7377 --data ./relay.json
 *
 * Every frame for a fleet goes through one queue, so the core's reads and
 * writes of the mailbox never interleave. Between fleets nothing is shared.
 *
 * Plain ws:// unless a TLS proxy is put in front. What crosses it is sealed
 * and signed either way (crypto.js); what plain ws:// shows an onlooker is
 * which device ids are talking and how much.
 */

const FLEET_PATH = /^\/v1\/fleet\/([A-Za-z0-9_-]{8,64})\/?$/;
const MAX_FLEETS = 200;
const WRITE_DELAY_MS = 400;

function fileStore(file) {
    let data = { fleets: {} };
    if (file) {
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (raw && typeof raw.fleets === 'object') data = raw;
        } catch {
            // First run, or unreadable: start empty.
        }
    }
    let timer = null;
    const write = () => {
        timer = null;
        if (!file) return;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const temp = `${file}.tmp`;
            fs.writeFileSync(temp, JSON.stringify(data));
            fs.renameSync(temp, file);
        } catch (error) {
            console.error('Relay could not save its state:', error.message);
        }
    };
    const schedule = () => {
        if (!timer) timer = setTimeout(write, WRITE_DELAY_MS);
    };
    return {
        fleetIds: () => Object.keys(data.fleets),
        forFleet(fleetId) {
            const bucket = () => (data.fleets[fleetId] ||= {});
            return {
                get: async key => bucket()[key],
                put: async (key, value) => {
                    bucket()[key] = value;
                    schedule();
                },
                delete: async (key) => {
                    delete bucket()[key];
                    schedule();
                },
                list: async (prefix, { after = '', limit = 0 } = {}) => {
                    const found = Object.entries(bucket())
                        .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
                        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
                    return limit > 0 ? found.slice(0, limit) : found;
                },
            };
        },
        flush() {
            if (timer) {
                clearTimeout(timer);
                write();
            }
        },
    };
}

function createHub({ port = 7377, host = '0.0.0.0', file = '', allowFleet = () => true } = {}) {
    const store = fileStore(file);
    const fleets = new Map();
    let server = null;

    function fleet(fleetId) {
        let entry = fleets.get(fleetId);
        if (entry) return entry;
        const conns = new Set();
        entry = {
            conns,
            queue: Promise.resolve(),
            relay: createRelay({
                fleetId,
                storage: store.forFleet(fleetId),
                sockets: () => [...conns],
                verify: async (signPublic, text, sig) => fleetCrypto.verify(signPublic, text, sig),
                deviceIdFor: async signPublic => fleetCrypto.deviceIdFor(signPublic),
                randomId: () => crypto.randomBytes(16).toString('base64url'),
            }),
        };
        fleets.set(fleetId, entry);
        return entry;
    }

    const enqueue = (entry, work) => {
        entry.queue = entry.queue.then(work).catch(error => console.error('Relay error:', error.message));
        return entry.queue;
    };

    function onConnection(raw, req) {
        const match = FLEET_PATH.exec(String(req.url || '').split('?')[0]);
        const known = match && store.fleetIds().includes(match[1]);
        if (!match || !allowFleet(match[1]) || (!known && fleets.size >= MAX_FLEETS && !fleets.has(match[1]))) {
            raw.close(4004, 'no such fleet');
            return;
        }
        const entry = fleet(match[1]);
        let state = {};
        const conn = {
            send: text => raw.send(text),
            close: (code, reason) => raw.close(code, reason),
            getState: () => state,
            setState: (next) => {
                state = next || {};
            },
        };
        entry.conns.add(conn);
        enqueue(entry, () => entry.relay.onOpen(conn));
        raw.onMessage = text => enqueue(entry, () => entry.relay.onMessage(conn, text));
        raw.onClose = () => {
            entry.conns.delete(conn);
            enqueue(entry, () => entry.relay.onClose(conn));
        };
    }

    return {
        start() {
            return new Promise((resolve, reject) => {
                server = http.createServer((req, res) => {
                    if (req.url === '/health' || req.url === '/') {
                        res.writeHead(200, { 'Content-Type': 'text/plain' });
                        res.end('acestes-relay 1\n');
                        return;
                    }
                    res.writeHead(404);
                    res.end();
                });
                attach(server, { path: '/v1/fleet/', onConnection });
                server.once('error', reject);
                server.listen(port, host, () => {
                    server.off('error', reject);
                    resolve({ port: server.address().port });
                });
            });
        },
        stop() {
            store.flush();
            for (const entry of fleets.values()) {
                for (const conn of entry.conns) conn.close(1001, 'relay stopping');
            }
            fleets.clear();
            return new Promise((resolve) => {
                if (!server) return resolve();
                server.close(() => resolve());
                server.closeAllConnections?.();
                server = null;
                return undefined;
            });
        },
        port: () => server?.address()?.port || 0,
        listening: () => Boolean(server?.listening),
    };
}

module.exports = { createHub };

if (require.main === module) {
    const args = process.argv.slice(2);
    const option = (name, fallback) => {
        const index = args.indexOf(`--${name}`);
        return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
    };
    const hub = createHub({
        port: Number(option('port', process.env.PORT || 7377)),
        host: option('host', '0.0.0.0'),
        file: path.resolve(option('data', 'acestes-relay.json')),
    });
    hub.start().then(({ port }) => {
        console.log(`Acestes relay listening on ws://0.0.0.0:${port}/v1/fleet/<fleet>`);
    }, (error) => {
        console.error(`Relay could not start: ${error.message}`);
        process.exit(1);
    });
    const quit = () => hub.stop().then(() => process.exit(0));
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
}

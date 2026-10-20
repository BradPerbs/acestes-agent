/**
 * The Acestes relay as a Cloudflare Worker: one Durable Object per fleet,
 * running the same core as the Node hub (src/main/fleet/relay-core.js).
 *
 * Always on, reachable from anywhere over wss://, and none of the user's
 * computers has to host it, so every device in a fleet is the equal of the
 * others. It holds what the core holds (the roster, invites, mailboxes, the
 * sync log, claims) and can read none of it: messages and records are sealed
 * under the fleet key, which never leaves the devices.
 *
 * Sockets use the hibernation API, so an idle fleet costs nothing between
 * messages; each socket's state lives in its attachment, which is why the
 * core keeps state on the connection rather than in memory.
 *
 * Deploy: see relay/cloudflare/README.md.
 */
import relayCore from '../../src/main/fleet/relay-core.js';

const { createRelay } = relayCore;

const FLEET_PATH = /^\/v1\/fleet\/([A-Za-z0-9_-]{8,64})\/?$/;

const fromB64u = (text) => {
    const base64 = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
};

async function verify(signPublic, text, signature) {
    try {
        const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: signPublic }, { name: 'Ed25519' }, false, ['verify']);
        return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromB64u(signature), new TextEncoder().encode(text));
    } catch {
        return false;
    }
}

async function deviceIdFor(signPublic) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fromB64u(signPublic)));
    return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/' || url.pathname === '/health') {
            return new Response('acestes-relay 1\n', { headers: { 'content-type': 'text/plain' } });
        }
        const match = FLEET_PATH.exec(url.pathname);
        if (!match) return new Response('Not found', { status: 404 });
        if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
        return env.FLEET.get(env.FLEET.idFromName(match[1])).fetch(request);
    },
};

export class FleetRelay {
    constructor(ctx) {
        this.ctx = ctx;
        this.relays = new Map();
        this.conns = new WeakMap();
    }

    /** A stable wrapper per socket: the core compares connections by identity. */
    conn(ws) {
        let wrapped = this.conns.get(ws);
        if (wrapped) return wrapped;
        wrapped = {
            send: text => ws.send(text),
            close: (code, reason) => ws.close(code, reason),
            getState: () => ws.deserializeAttachment() || {},
            setState: (next) => {
                const fleetId = (ws.deserializeAttachment() || {}).fleetId;
                ws.serializeAttachment({ ...(next || {}), fleetId });
            },
        };
        this.conns.set(ws, wrapped);
        return wrapped;
    }

    relay(fleetId) {
        let relay = this.relays.get(fleetId);
        if (relay) return relay;
        const storage = this.ctx.storage;
        relay = createRelay({
            fleetId,
            storage: {
                get: key => storage.get(key),
                put: (key, value) => storage.put(key, value),
                delete: key => storage.delete(key),
                list: async (prefix, { after = '', limit = 0 } = {}) => [...(await storage.list({
                    prefix,
                    ...(after ? { startAfter: after } : {}),
                    ...(limit ? { limit } : {}),
                })).entries()],
            },
            sockets: () => this.ctx.getWebSockets()
                .filter(ws => (ws.deserializeAttachment() || {}).fleetId === fleetId)
                .map(ws => this.conn(ws)),
            verify,
            deviceIdFor,
            randomId: () => crypto.randomUUID().replace(/-/g, ''),
        });
        this.relays.set(fleetId, relay);
        return relay;
    }

    async fetch(request) {
        const match = FLEET_PATH.exec(new URL(request.url).pathname);
        if (!match) return new Response('Not found', { status: 404 });
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ fleetId: match[1] });
        await this.relay(match[1]).onOpen(this.conn(server));
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
        if (typeof message !== 'string') {
            ws.close(1003, 'text only');
            return;
        }
        const { fleetId } = ws.deserializeAttachment() || {};
        if (!fleetId) return;
        await this.relay(fleetId).onMessage(this.conn(ws), message);
    }

    async webSocketClose(ws) {
        const { fleetId } = ws.deserializeAttachment() || {};
        if (fleetId) await this.relay(fleetId).onClose(this.conn(ws));
    }

    async webSocketError(ws) {
        await this.webSocketClose(ws);
    }
}

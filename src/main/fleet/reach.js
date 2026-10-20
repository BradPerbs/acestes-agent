const net = require('net');
const os = require('os');

/**
 * Who can reach an address, in the words the Devices page uses.
 *
 * A fleet's relay is a ws:// or wss:// address, and whether another computer
 * can get to it depends on what kind of address it is: a Tailscale one works
 * only from the same tailnet, a 192.168 one only from the same network, a
 * bare public IP only if the router forwards the port. The page used to show
 * the address and leave the user to know that, and a computer that could not
 * reach it just sat on "Connecting". This module names the kind, and `probe`
 * asks the relay's /health whether it answers from here.
 *
 * Kinds: tailscale, lan, public (an IP on the internet), internet (a name,
 * as a hosted relay has), loopback, linklocal (169.254, never reachable),
 * vpn (another overlay network), unknown.
 */

const PROBE_MS = 5000;

function ipv4(host) {
    if (!net.isIPv4(host)) return null;
    return host.split('.').map(Number);
}

/** The kind of a host name or IP, with the interface it sits on when it is one of ours. */
function kindOf(host, iface = '') {
    const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return 'unknown';
    if (h === 'localhost' || h === '::1' || /^127\./.test(h)) return 'loopback';
    if (/tailscale/i.test(iface) || /\.ts\.net$/.test(h)) return 'tailscale';
    if (/zerotier|wireguard|wg\d|nordlynx|hamachi/i.test(iface)) return 'vpn';
    const p = ipv4(h);
    if (p) {
        // 100.64.0.0/10 is carrier-grade NAT space, and Tailscale hands out its
        // addresses from it. A computer's own address in it is Tailscale.
        if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return 'tailscale';
        if (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)) return 'lan';
        if (p[0] === 169 && p[1] === 254) return 'linklocal';
        return 'public';
    }
    if (net.isIPv6(h)) {
        if (/^fe[89ab]/.test(h)) return 'linklocal';
        if (/^fd7a:115c:a1e0/.test(h)) return 'tailscale';
        if (/^f[cd]/.test(h)) return 'lan';
        return 'public';
    }
    if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home') || !h.includes('.')) return 'lan';
    return 'internet';
}

/** A relay address taken apart: `{ url, kind, host, port, secure }`. */
function describeRelay(url) {
    const text = String(url || '').trim();
    try {
        const parsed = new URL(text);
        if (!/^wss?:$/.test(parsed.protocol)) return { url: text, kind: 'unknown', host: '', port: '', secure: false };
        const secure = parsed.protocol === 'wss:';
        return {
            url: text,
            kind: kindOf(parsed.hostname),
            host: parsed.hostname.replace(/^\[|\]$/g, ''),
            port: parsed.port || (secure ? '443' : '80'),
            secure,
        };
    } catch {
        return { url: text, kind: 'unknown', host: '', port: '', secure: false };
    }
}

const ORDER = { tailscale: 0, lan: 1, vpn: 2, public: 3 };

/**
 * This computer's addresses the others could use, best first: Tailscale
 * (works across places), then the local network. Loopback and the 169.254
 * addresses Windows gives an unplugged adapter are left out: nothing else
 * can reach them.
 */
function networks() {
    const out = [];
    const seen = new Set();
    for (const [iface, list] of Object.entries(os.networkInterfaces())) {
        for (const entry of list || []) {
            if (entry.family !== 'IPv4' || entry.internal) continue;
            const kind = kindOf(entry.address, iface);
            if (!(kind in ORDER) || seen.has(entry.address)) continue;
            seen.add(entry.address);
            out.push({ address: entry.address, kind, iface });
        }
    }
    return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

function errorCode(error) {
    const name = error?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
    // A name with several addresses fails as an AggregateError of each attempt.
    const code = error?.cause?.code || error?.cause?.errors?.[0]?.code || error?.code || '';
    if (code === 'ECONNREFUSED') return 'refused';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'notfound';
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL') return 'unreachable';
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
    if (/CERT|TLS|SSL/i.test(code)) return 'tls';
    return 'failed';
}

/**
 * Whether a relay answers from this computer: GET /health on the same host
 * and port, which both relays (hub.js and the Worker) answer with
 * "acestes-relay". `{ ok, ms }`, or `{ ok: false, code, detail }`.
 */
async function probe(url) {
    const relay = describeRelay(url);
    if (relay.kind === 'unknown') return { ok: false, code: 'bad-address', ...relay };
    const target = new URL(relay.url);
    target.protocol = relay.secure ? 'https:' : 'http:';
    target.pathname = '/health';
    target.search = '';
    target.hash = '';
    const started = Date.now();
    try {
        const response = await fetch(target, { signal: AbortSignal.timeout(PROBE_MS), cache: 'no-store', redirect: 'manual' });
        const text = await response.text().catch(() => '');
        if (response.ok && text.startsWith('acestes-relay')) return { ok: true, ms: Date.now() - started, ...relay };
        return { ok: false, code: 'not-relay', detail: `HTTP ${response.status}`, ...relay };
    } catch (error) {
        return { ok: false, code: errorCode(error), detail: error?.cause?.code || error?.message || '', ...relay };
    }
}

module.exports = { kindOf, describeRelay, networks, probe };

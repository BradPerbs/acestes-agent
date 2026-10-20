const crypto = require('crypto');

/**
 * The fleet's cryptography: who a device is, and what only the fleet can read.
 *
 * Every device has two key pairs of its own, made on the device and never sent
 * anywhere in private form:
 *
 *   signing    Ed25519. Every message a device sends is signed with it, so a
 *              receiver knows which machine said it, and the relay can check a
 *              device is who it claims before it routes anything for it.
 *   box        X25519. How a secret is handed to one device alone: the fleet
 *              key when it joins, a new fleet key when another device is
 *              removed.
 *
 * And the fleet shares one key, 256 random bits made by the device that
 * started it. Everything devices say to each other is sealed under it
 * (AES-256-GCM), so the relay in the middle carries ciphertext it cannot open.
 *
 * Keys travel as JWK fields (the base64url `x` and `d`), which is also what
 * WebCrypto imports, so the relay can verify a signature with the same bytes
 * whether it runs in Node or in a Cloudflare Worker.
 *
 * An invite is a code one device shows and another pastes: the relay, the
 * fleet, an invite id and a 128-bit secret. The secret never reaches the relay.
 * The joiner proves it holds the code with an HMAC over its own public keys,
 * and the inviter proves the welcome is genuine with an HMAC over what it
 * sends back, so a relay that wanted to slip in a device of its own, or hand
 * the joiner a fleet of its own, would need a secret it never saw.
 */

const INVITE_PREFIX = 'ACESTES1.';
const INVITE_TTL_MS = 15 * 60 * 1000;

const b64u = (buffer) => Buffer.from(buffer).toString('base64url');
const fromB64u = (text) => Buffer.from(String(text || ''), 'base64url');
const bytes = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));

/** A device id is derived from its signing key, so it cannot be claimed by another key. */
function deviceIdFor(signPublic) {
    return crypto.createHash('sha256').update(fromB64u(signPublic)).digest('hex').slice(0, 20);
}

function generateIdentity() {
    const sign = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    const box = crypto.generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
    return {
        deviceId: deviceIdFor(sign.x),
        signPublic: sign.x,
        signPrivate: sign.d,
        boxPublic: box.x,
        boxPrivate: box.d,
    };
}

const signKeyObject = (x, d) => crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x, d }, format: 'jwk' });
const verifyKeyObject = (x) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
const boxPrivateObject = (x, d) => crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', x, d }, format: 'jwk' });
const boxPublicObject = (x) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });

function sign(identity, data) {
    return b64u(crypto.sign(null, bytes(data), signKeyObject(identity.signPublic, identity.signPrivate)));
}

function verify(signPublic, data, signature) {
    try {
        return crypto.verify(null, bytes(data), verifyKeyObject(signPublic), fromB64u(signature));
    } catch {
        return false;
    }
}

function newFleetKey() {
    return b64u(crypto.randomBytes(32));
}

function newId(size = 12) {
    return b64u(crypto.randomBytes(size));
}

/** Seal a JSON value under a 32-byte key; `aad` binds the routing header to it. */
function seal(key, value, aad = '') {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', fromB64u(key), iv);
    cipher.setAAD(bytes(aad));
    const body = Buffer.concat([cipher.update(bytes(JSON.stringify(value))), cipher.final(), cipher.getAuthTag()]);
    return { iv: b64u(iv), ct: b64u(body) };
}

/** The value, or throws when the key is wrong or anything was altered. */
function open(key, sealed, aad = '') {
    const raw = fromB64u(sealed?.ct);
    if (raw.length < 17) throw new Error('Sealed message is truncated');
    const decipher = crypto.createDecipheriv('aes-256-gcm', fromB64u(key), fromB64u(sealed.iv));
    decipher.setAAD(bytes(aad));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
}

function wrapKey(shared, epk) {
    return b64u(crypto.hkdfSync('sha256', shared, fromB64u(epk), bytes('acestes-fleet-wrap'), 32));
}

/** Seal a value so only the holder of one box key can open it. */
function wrapTo(boxPublic, value) {
    const ephemeral = crypto.generateKeyPairSync('x25519');
    const epk = ephemeral.publicKey.export({ format: 'jwk' }).x;
    const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: boxPublicObject(boxPublic) });
    return { epk, ...seal(wrapKey(shared, epk), value, epk) };
}

function unwrap(identity, wrapped) {
    const shared = crypto.diffieHellman({
        privateKey: boxPrivateObject(identity.boxPublic, identity.boxPrivate),
        publicKey: boxPublicObject(wrapped.epk),
    });
    return open(wrapKey(shared, wrapped.epk), wrapped, wrapped.epk);
}

function hmac(secret, text) {
    return b64u(crypto.createHmac('sha256', fromB64u(secret)).update(bytes(text)).digest());
}

/**
 * The key the sync log's record names are hashed under: derived from the
 * fleet's first key, which every device keeps, so a name hashes the same
 * after any number of key changes.
 */
function indexKeyFrom(firstKey) {
    return b64u(crypto.hkdfSync('sha256', fromB64u(firstKey), Buffer.alloc(0), bytes('acestes-fleet-index'), 32));
}

/** A record's name as the relay sees it: 43 characters that say nothing. */
const recordKey = (indexKey, name) => hmac(indexKey, name);

function sameText(a, b) {
    const left = bytes(a || '');
    const right = bytes(b || '');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/* ------------------------------------------------------------------ *
 * Invites
 * ------------------------------------------------------------------ */

function makeInvite({ relay, fleetId, name = '' }) {
    const invite = { relay, fleetId, inviteId: newId(9), secret: b64u(crypto.randomBytes(16)), expiresAt: Date.now() + INVITE_TTL_MS };
    const code = INVITE_PREFIX + b64u(JSON.stringify({ r: relay, f: fleetId, i: invite.inviteId, s: invite.secret, n: String(name).slice(0, 80) }));
    return { ...invite, code };
}

/** `{ relay, fleetId, inviteId, secret, from }`, or null for anything that is not an invite code. */
function parseInvite(code) {
    const text = String(code || '').trim().replace(/\s+/g, '');
    if (!text.startsWith(INVITE_PREFIX)) return null;
    try {
        const raw = JSON.parse(fromB64u(text.slice(INVITE_PREFIX.length)).toString('utf8'));
        if (!raw || typeof raw.r !== 'string' || typeof raw.f !== 'string' || typeof raw.i !== 'string' || typeof raw.s !== 'string') return null;
        if (!/^wss?:\/\//i.test(raw.r)) return null;
        return { relay: raw.r, fleetId: raw.f, inviteId: raw.i, secret: raw.s, from: typeof raw.n === 'string' ? raw.n : '' };
    } catch {
        return null;
    }
}

/** What the joiner sends to prove it holds the code, bound to its own keys. */
const joinProof = (secret, { inviteId, deviceId, signPublic, boxPublic }) =>
    hmac(secret, `join\n${inviteId}\n${deviceId}\n${signPublic}\n${boxPublic}`);

/** What the inviter sends back to prove the welcome came from the device that made the code. */
const welcomeProof = (secret, { inviteId, deviceId, ct }) => hmac(secret, `welcome\n${inviteId}\n${deviceId}\n${ct}`);

module.exports = {
    INVITE_TTL_MS,
    deviceIdFor,
    generateIdentity,
    sign,
    verify,
    newFleetKey,
    newId,
    seal,
    open,
    wrapTo,
    unwrap,
    makeInvite,
    parseInvite,
    joinProof,
    welcomeProof,
    indexKeyFrom,
    recordKey,
    sameText,
};

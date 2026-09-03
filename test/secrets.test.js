/**
 * The secrets store: values in by name, references out, resolution at the
 * moment of use, and every stored value scrubbed from whatever is recorded.
 *
 * `electron` is stubbed with a reversible "encryption" so the round trip can
 * be checked under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-secrets-'));

let encryptionAvailable = true;
const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: {
        isEncryptionAvailable: () => encryptionAvailable,
        encryptString: (text) => Buffer.from(`enc:${text}`, 'utf8'),
        decryptString: (buffer) => {
            const text = buffer.toString('utf8');
            if (!text.startsWith('enc:')) throw new Error('not ours');
            return text.slice(4);
        },
    },
    ipcMain: { handle: () => {}, on: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    Notification: class { show() {} },
};
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, ...rest);
};

const secrets = require(path.join(ROOT, 'ai', 'secrets'));

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
}

console.log('secrets');

check('a value goes in by name and comes back as a reference', () => {
    const kept = secrets.set('webshare', 'ws-test-key-not-a-real-credential');
    assert.strictEqual(kept.stored, true);
    assert.strictEqual(kept.reference, '{{secret:webshare}}');
    assert.deepStrictEqual(secrets.list().map(entry => entry.name), ['webshare']);
    assert.strictEqual(secrets.list()[0].readable, true);
    assert.strictEqual(secrets.has('webshare'), true);
});

check('the file on disk carries ciphertext, not the value', () => {
    const text = fs.readFileSync(path.join(userData, 'secrets.json'), 'utf8');
    assert.ok(!text.includes('ws-test-key-not-a-real-credential'));
    assert.ok(text.includes('"webshare"'));
});

check('a reference resolves in a string and in a map; an unknown one is left as written', () => {
    assert.strictEqual(secrets.resolve('Token {{secret:webshare}}'), 'Token ws-test-key-not-a-real-credential');
    assert.strictEqual(secrets.resolve('{{ secret:webshare }}'), 'ws-test-key-not-a-real-credential');
    assert.strictEqual(secrets.resolve('{{secret:nope}}'), '{{secret:nope}}');
    assert.deepStrictEqual(secrets.unresolved('a {{secret:nope}} b {{secret:webshare}}'), ['nope']);
    assert.deepStrictEqual(
        secrets.resolveObject({ WSKEY: '{{secret:webshare}}', PLAIN: 'x' }),
        { WSKEY: 'ws-test-key-not-a-real-credential', PLAIN: 'x' },
    );
    assert.strictEqual(secrets.resolve(42), 42);
});

check('references resolve through the arguments of a tool call, and missing ones are named', () => {
    const input = {
        fields: [
            { name: 'Username', value: 'brad' },
            { name: 'Password', value: '{{secret:webshare}}' },
        ],
        submit: true,
    };
    const filled = secrets.resolveDeep(input);
    assert.strictEqual(filled.fields[1].value, 'ws-test-key-not-a-real-credential');
    assert.strictEqual(filled.fields[0].value, 'brad');
    assert.strictEqual(filled.submit, true);
    assert.notStrictEqual(filled, input, 'a filled input is a copy');
    assert.strictEqual(input.fields[1].value, '{{secret:webshare}}', 'and the original still says the reference');
    const plain = { text: 'nothing to fill' };
    assert.strictEqual(secrets.resolveDeep(plain), plain, 'an input with no reference is the same object');
    assert.deepStrictEqual(secrets.unresolvedDeep({ a: ['{{secret:nope}}'], b: { c: '{{secret:webshare}}', d: '{{secret:gone}}' } }), ['nope', 'gone']);
    assert.deepStrictEqual(secrets.unresolvedDeep(plain), []);
});

check('every stored value is scrubbed from strings, arrays and objects', () => {
    const event = {
        type: 'tool-call',
        input: { command: "$env:WSKEY='ws-test-key-not-a-real-credential'; curl ..." },
        text: 'key ws-test-key-not-a-real-credential twice ws-test-key-not-a-real-credential',
        list: ['ws-test-key-not-a-real-credential', 'fine'],
        at: 5,
    };
    const clean = secrets.scrubDeep(event);
    assert.strictEqual(clean.input.command, "$env:WSKEY='••••'; curl ...");
    assert.strictEqual(clean.text, 'key •••• twice ••••');
    assert.deepStrictEqual(clean.list, ['••••', 'fine']);
    assert.strictEqual(clean.at, 5);
    assert.notStrictEqual(clean, event, 'a scrubbed event is a copy');
    const untouched = { text: 'nothing here', input: { a: 1 } };
    assert.strictEqual(secrets.scrubDeep(untouched), untouched, 'and an untouched one is the same object');
});

check('a short value is not scrubbed, which would eat ordinary words', () => {
    secrets.set('pin', '1234');
    assert.strictEqual(secrets.scrub('code 1234 here'), 'code 1234 here');
    secrets.remove('pin');
});

check('names are checked, and an empty value removes', () => {
    assert.ok(secrets.set('bad name!', 'x').error);
    assert.ok(secrets.set('', 'x').error);
    assert.strictEqual(secrets.set('gone', 'value-to-drop').stored, true);
    assert.strictEqual(secrets.set('gone', '').removed, true);
    assert.strictEqual(secrets.has('gone'), false);
    assert.strictEqual(secrets.remove('never').removed, false);
});

check('the store is read back from disk on a fresh load', () => {
    secrets._test.reset();
    assert.strictEqual(secrets.read('webshare'), 'ws-test-key-not-a-real-credential');
});

check('without OS encryption a value is refused rather than written in the clear', () => {
    encryptionAvailable = false;
    const refused = secrets.set('plain', 'should-not-land');
    assert.ok(refused.error);
    assert.strictEqual(secrets.has('plain'), false);
    encryptionAvailable = true;
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

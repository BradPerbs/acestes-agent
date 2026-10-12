/**
 * Teach mode: recording a person at work and turning it into a draft the
 * agent can learn from, without ever writing a password to the trace and
 * without writing anything at all until the person accepts.
 *
 * `electron` is stubbed with reversible "encryption" so secrets round-trip
 * under plain node, as in secrets.test.js.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-teach-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: {
        isEncryptionAvailable: () => true,
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

const teach = require(path.join(ROOT, 'ai', 'teach'));
const secrets = require(path.join(ROOT, 'ai', 'secrets'));
const memory = require(path.join(ROOT, 'ai', 'memory'));
const { redactText, redactLine, splitEpisodes, loginsFrom, parseDraft, secretName, looksLikeCard } = teach._test;

let failures = 0;
function test(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok  ${name}`))
        .catch((error) => { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); });
}

/** A fake helper so no desktop-helper process is needed. */
const helperCalls = [];
teach.configure({
    userDataDir: userData,
    helper: {
        start: async (o) => { helperCalls.push(['start', o]); return { ok: true }; },
        pause: async (o) => { helperCalls.push(['pause', o]); return { ok: true }; },
        stop: async () => { helperCalls.push(['stop']); return { ok: true }; },
    },
});

async function run() {
    await test('a password field value is never written to the trace', () => {
        // Even if a confused helper sends a password on a field line, it is dropped.
        const clean = redactLine({ t: 1, type: 'field', target: { name: 'Password' }, value: 'hunter2', password: true });
        assert.strictEqual(clean.value, undefined, 'a line marked password keeps no value');
        assert.strictEqual(clean.password, undefined, 'the password flag is dropped');
        const login = redactLine({ t: 2, type: 'login', site: 'panel.example.com', user: 'anna', value: 'hunter2' });
        assert.strictEqual(login.value, undefined, 'a login line never carries a value');
        assert.strictEqual(login.site, 'panel.example.com');
    });

    await test('stored secrets are scrubbed out of recorded values', () => {
        secrets.set('panel-token', 'SEKRET-TOKEN-1234', 'agent-a');
        const clean = redactText('the token is SEKRET-TOKEN-1234 ok', { });
        assert.ok(!clean.includes('SEKRET-TOKEN-1234'), 'the stored secret is masked');
        secrets.set('panel-token', '', 'agent-a');
    });

    await test('redaction masks cards and IBANs only when asked', () => {
        const card = '4111 1111 1111 1111';
        assert.ok(looksLikeCard('4111111111111111'), 'a valid test card passes Luhn');
        assert.strictEqual(redactText(`pay ${card}`, { redact: false }).includes(card), true, 'off by default');
        assert.ok(redactText(`pay ${card}`, { redact: true }).includes('{{card}}'), 'on when asked');
        assert.ok(redactText('IBAN DE89 3704 0044 0532 0130 00', { redact: true }).includes('{{iban}}'));
    });

    await test('episodes split on app change, long gaps and marks', () => {
        const lines = [
            { t: 0, type: 'window', app: 'chrome.exe', window: 'A' },
            { t: 100, type: 'click', target: { name: 'x' } },
            { t: 200000, type: 'click', target: { name: 'y' } }, // > 2 min gap
            { t: 200100, type: 'window', app: 'excel.exe', window: 'B' }, // app change
            { t: 200200, type: 'mark', note: 'here' }, // mark
        ];
        const eps = splitEpisodes(lines);
        assert.ok(eps.length >= 3, `expected several episodes, got ${eps.length}`);
    });

    await test('logins are gathered as site and username, no password', () => {
        const logins = loginsFrom([
            { t: 1, type: 'login', site: 'panel.example.com', user: 'anna' },
            { t: 2, type: 'login', site: 'panel.example.com', user: 'anna' }, // duplicate
            { t: 3, type: 'login', site: 'mail.example.com', user: 'bob' },
        ]);
        assert.strictEqual(logins.length, 2, 'duplicates folded');
        assert.ok(!('password' in logins[0]));
    });

    await test('secretName stays within the keychain charset', () => {
        assert.strictEqual(secretName('https://panel.example.com/', 'anna.rossi'), 'panel.example.com-anna.rossi');
        assert.ok(/^[A-Za-z0-9_.-]+$/.test(secretName('weird site!', 'user name')));
    });

    await test('a draft is parsed out of a fenced JSON reply', () => {
        const reply = 'Sure:\n```json\n{"appMap":[{"app":"x","where":"Mail","path":"A > B"}],"procedures":[],"questions":[]}\n```';
        const parsed = parseDraft(reply);
        assert.ok(parsed.ok);
        assert.strictEqual(parsed.draft.appMap[0].where, 'Mail');
        assert.deepStrictEqual(parsed.draft.glossary, []);
    });

    await test('record, distil, accept: writes memory, a spec and a login', async () => {
        teach._test.reset();
        const saved = [];
        teach.configure({ saveSpec: async (s) => { saved.push(s); return { id: 's1' }; } });

        const started = await teach.start('agent-b', { apps: ['chrome.exe'] });
        assert.ok(started.ok, started.error);
        teach.ingest({ t: 0, type: 'window', app: 'chrome.exe', window: 'panel.example.com' });
        teach.ingest({ t: 1, type: 'click', target: { role: 'button', name: 'Mail' } });
        teach.ingest({ t: 2, type: 'login', site: 'panel.example.com', user: 'anna' });
        const stopped = await teach.stop();
        assert.ok(stopped.ok);

        const provider = {
            title: async () => JSON.stringify({
                appMap: [{ app: 'panel.example.com', where: 'Mail queue', path: 'Tools > Mail' }],
                procedures: [{ name: 'Check mail queue', when: 'a ticket', params: [], steps: ['open Mail'], branches: [] }],
                glossary: [{ term: 'SUB', meaning: 'subscription' }],
                templates: [],
                questions: [],
            }),
        };
        const distilled = await teach.distil(provider, { settings: {}, id: stopped.id });
        assert.ok(distilled.ok);
        assert.strictEqual(distilled.logins.length, 1, 'the login is offered for review');

        const result = await teach.accept(stopped.id, {
            agentId: 'agent-b',
            logins: [{ site: 'panel.example.com', user: 'anna', password: 'Tr0ub4dor&3' }],
        });
        assert.ok(result.ok, result.error);
        assert.strictEqual(result.counts.logins, 1, 'one login stored');
        assert.ok(result.counts.facts >= 2, 'app map and glossary became facts');
        assert.strictEqual(saved.length, 1, 'the procedure became a spec');

        // The password is in the keychain under site-user, resolvable.
        const ref = secrets.read('panel.example.com-anna', 'agent-b');
        assert.strictEqual(ref, 'Tr0ub4dor&3', 'the login resolves for the agent');
        // A fact about the app map is in memory.
        const facts = memory.list('agent-b');
        assert.ok(facts.some(f => /Mail queue/.test(f.text)), 'the app map reached memory');
        // The recording is gone from disk.
        assert.ok(!fs.existsSync(path.join(userData, 'recordings', stopped.id)), 'the recording is deleted');
    });

    await test('discard writes nothing and deletes the recording', async () => {
        teach._test.reset();
        const started = await teach.start('agent-c', { apps: [] });
        assert.ok(started.ok);
        teach.ingest({ t: 0, type: 'window', app: 'chrome.exe', window: 'site' });
        teach.ingest({ t: 1, type: 'login', site: 'site', user: 'joe' });
        const stopped = await teach.stop();
        await teach.distil({ title: async () => '{}' }, { settings: {}, id: stopped.id });

        const before = memory.list('agent-c').length;
        const login = { site: 'site', user: 'joe', password: 'secret-pw' };
        const result = teach.discard(stopped.id, { logins: [login] });
        assert.ok(result.ok);
        assert.strictEqual(login.password, undefined, 'the typed password is wiped');
        assert.strictEqual(secrets.read('site-joe', 'agent-c'), '', 'nothing reached the keychain');
        assert.strictEqual(memory.list('agent-c').length, before, 'nothing reached memory');
        assert.ok(!fs.existsSync(path.join(userData, 'recordings', stopped.id)), 'the recording is deleted');
    });

    await test('a second recording is refused while one is under way', async () => {
        teach._test.reset();
        const a = await teach.start('agent-d', {});
        assert.ok(a.ok);
        const b = await teach.start('agent-d', {});
        assert.strictEqual(b.ok, false);
        assert.strictEqual(b.code, 'busy');
        await teach.stop();
    });

    console.log(failures ? `\n${failures} test(s) failed.` : '\nAll teach tests passed.');
    process.exit(failures ? 1 : 0);
}

run();

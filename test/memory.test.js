/**
 * The agent's memory: notes filed by kind, the core every prompt carries
 * (the rules, then one line on the rest), the notes sent with a message (not
 * the ones in the prompt, not one the conversation was already shown, a
 * short follow-up searched with the message before it), the tools that
 * write and rewrite them, the bin, and tidying (what a tidy may change, the
 * log it keeps, and taking it back).
 *
 * The encoder is a stand-in: a bag of words hashed into a small vector, so
 * notes that share words are near each other and the tests run without a
 * model. memory.js only ever sees cosines, which this gives it.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-memory-'));

const DIMS = 512;
/** Words a real encoder gives next to no weight, left out so they do not make unrelated texts close. */
const COMMON = new Set('the and for with what like its that this into through from are was'.split(' '));
const fake = {
    MODEL: 'fake-bag-of-words',
    DIMS,
    fail: false,
    calls: 0,
    vector(text) {
        const out = new Float32Array(DIMS);
        const words = (String(text).toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(word => !COMMON.has(word));
        for (const word of words) {
            let hash = 7;
            for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 100003;
            out[hash % DIMS] += 1;
        }
        const norm = Math.hypot(...out) || 1;
        return out.map(value => value / norm);
    },
    async embed(texts) {
        fake.calls += 1;
        if (fake.fail) throw new Error('no model');
        return texts.map(text => fake.vector(text));
    },
    isReady: () => !fake.fail,
    warm: () => {},
    status: () => ({ model: 'fake', dims: DIMS, loading: false, failure: '' }),
};

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable'); }, decryptString: () => { throw new Error('unavailable'); } },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    Notification: class { show() {} },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    if (request === './embeddings' && parent?.filename?.endsWith(`${path.sep}memory.js`)) return fake;
    return realLoad.call(this, request, parent, isMain);
};

const memory = require(path.join(ROOT, 'ai', 'memory'));
const memoryTidy = require(path.join(ROOT, 'ai', 'memory-tidy'));
const prompt = require(path.join(ROOT, 'ai', 'prompt'));
const settings = require(path.join(ROOT, 'ai', 'settings'));
const tools = require(path.join(ROOT, 'ai', 'tools'));

let passed = 0;
let failed = 0;
async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${error.stack || error.message}`);
    }
}

/** Let queued embeds finish. */
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

const file = (agentId) => path.join(userData, 'memory', `${agentId}.json`);

async function main() {
    console.log('\nmemory: kinds and migration');

    await check('a notebook from before kinds is filed by kind and written back as version 2', async () => {
        const AGENT = 'agent-migrate';
        fs.mkdirSync(path.join(userData, 'memory'), { recursive: true });
        const at = Date.now() - 1000;
        fs.writeFileSync(file(AGENT), JSON.stringify({
            version: 1,
            entries: [
                { id: 'm-a', text: 'Never add a co-author line to commits.', tags: [], createdAt: at, updatedAt: at },
                { id: 'm-b', text: 'The user wants replies in short sentences.', tags: ['preference'], createdAt: at, updatedAt: at },
                { id: 'm-c', text: 'Release 1.3.5 published 2026-10-05 as tag v1.3.5.', tags: ['release'], createdAt: at, updatedAt: at },
                { id: 'm-d', text: 'The web boxes run nginx behind haproxy.', tags: ['nginx'], createdAt: at, updatedAt: at },
            ],
        }));
        const kinds = Object.fromEntries(memory.list(AGENT).map(entry => [entry.id, entry.kind]));
        assert.deepStrictEqual(kinds, { 'm-a': 'rule', 'm-b': 'rule', 'm-c': 'event', 'm-d': 'fact' });
        const written = JSON.parse(fs.readFileSync(file(AGENT), 'utf8'));
        assert.strictEqual(written.version, 2);
        assert.strictEqual(written.entries.find(entry => entry.id === 'm-d').kind, 'fact');
    });

    await check('a kind given wins over the one worked out', () => {
        const entry = memory.add('agent-kinds', { text: 'Never mind the staging box, it is gone.', kind: 'fact' });
        assert.strictEqual(entry.kind, 'fact');
        const unknown = memory.add('agent-kinds', { text: 'Something else entirely', kind: 'nonsense' });
        assert.strictEqual(unknown.kind, 'fact');
    });

    await check('the stemmer agrees with itself on common endings', () => {
        const { stem } = memory._test;
        assert.strictEqual(stem('commits'), stem('commit'));
        assert.strictEqual(stem('committed'), stem('commit'));
        assert.strictEqual(stem('releases'), stem('release'));
        assert.strictEqual(stem('released'), stem('release'));
        assert.strictEqual(stem('failing'), stem('fails'));
        assert.strictEqual(stem('status'), 'status');
    });

    console.log('\nmemory: the core');

    await check('the core carries the rules, user rules first, and a topic line for the rest', async () => {
        const AGENT = 'agent-core';
        memory.add(AGENT, { text: 'Never use em dashes in anything the user reads.', kind: 'rule', source: 'agent' });
        memory.add(AGENT, { text: 'Reply in short sentences.', kind: 'rule', source: 'user' });
        memory.add(AGENT, { text: 'Web-01 runs nginx 1.24.', kind: 'fact', tags: ['nginx', 'web'] });
        memory.add(AGENT, { text: 'Web-02 runs nginx too.', kind: 'fact', tags: ['nginx', 'web'] });
        memory.add(AGENT, { text: 'The captcha solver uses 2captcha.', kind: 'fact', tags: ['captcha', 'fixed'] });
        memory.add(AGENT, { text: 'Captcha drag puzzles go to CoordinatesTask.', kind: 'fact', tags: ['captcha', 'fixed'] });
        const held = memory.core(AGENT);
        assert.strictEqual(held.ids.length, 2);
        const lines = held.text.split('\n');
        assert.ok(lines[0].startsWith('Rules the user set'));
        assert.ok(lines[1].includes('Reply in short sentences.'), 'the user rule comes first');
        assert.ok(lines[2].includes('em dashes'));
        assert.ok(/4 more notes/.test(held.text));
        assert.ok(held.text.includes('nginx (2)'));
        assert.ok(held.text.includes('captcha (2)'));
        assert.ok(!held.text.includes('fixed ('), 'a state is not a topic');
        assert.ok(!held.text.includes('Web-01 runs'), 'facts are not in the prompt');
        assert.strictEqual(memory.summary(AGENT), held.text);
    });

    await check('rules past the budget are left out of the core and listed as not fitting', () => {
        const AGENT = 'agent-budget';
        const long = 'x'.repeat(700);
        for (let index = 0; index < 5; index += 1) {
            memory.add(AGENT, { text: `Never do thing ${index}: ${long}`, kind: 'rule' });
        }
        const held = memory.core(AGENT);
        assert.ok(held.ids.length >= 2 && held.ids.length < 5);
        assert.strictEqual(held.ids.length + held.over.length, 5);
        assert.ok(held.ruleChars <= held.ruleBudget);
        assert.ok(memory.status(AGENT).rulesOver.length > 0);
    });

    await check('the prompt carries the core under its heading', () => {
        const text = prompt.build({ memory: memory.summary('agent-core') });
        assert.ok(text.includes('## What you remember'));
        assert.ok(text.includes('Reply in short sentences.'));
        assert.ok(text.includes('## Memory'));
        assert.ok(/recall searches all of them/.test(text));
    });

    console.log('\nmemory: notes sent with a message');

    const AGENT = 'agent-relevant';
    const rule = memory.add(AGENT, { text: 'Never add a co-author line to git commits.', kind: 'rule' });
    const nginx = memory.add(AGENT, { text: 'The web server web-01 runs nginx with its config in /etc/nginx/sites-enabled.', kind: 'fact', tags: ['nginx'] });
    const captcha = memory.add(AGENT, { text: 'The captcha solver sends reCAPTCHA image challenges to 2captcha.', kind: 'fact', tags: ['captcha'] });
    const captcha2 = memory.add(AGENT, { text: 'reCAPTCHA in Chrome: the captcha iframe covers the checkbox, so the solver clicks through it.', kind: 'fact', tags: ['captcha'] });
    memory.add(AGENT, { text: 'Paint drawing uses physical pixels at 150 percent scaling.', kind: 'fact', tags: ['paint'] });
    await settle();
    const pinned = memory.core(AGENT).ids;

    await check('a message gets the notes about it, not the rules the prompt has', async () => {
        const found = await memory.relevant(AGENT, 'the captcha solver failed on reCAPTCHA in chrome', {
            conversationId: 'c-1', session: 's-1', exclude: pinned, budget: Infinity,
        });
        const ids = found.map(entry => entry.id);
        assert.ok(ids.includes(captcha.id) || ids.includes(captcha2.id), 'a captcha note is sent');
        assert.ok(!ids.includes(rule.id), 'the rule is in the prompt already');
        assert.ok(!ids.includes(nginx.id), 'nothing about nginx');
        assert.ok(found.length <= 4);
    });

    await check('a note is sent once a conversation', async () => {
        const again = await memory.relevant(AGENT, 'the captcha solver failed on reCAPTCHA in chrome', {
            conversationId: 'c-1', session: 's-1', exclude: pinned, budget: Infinity,
        });
        const first = await memory.relevant(AGENT, 'the captcha solver failed on reCAPTCHA in chrome', {
            conversationId: 'c-other', session: 's-9', exclude: pinned, budget: Infinity,
        });
        assert.ok(first.length > 0, 'another conversation gets them');
        for (const entry of again) assert.ok(!first.slice(0, 1).some(held => held.id === entry.id) || again.length === 0);
    });

    await check('a conversation moved to a new session is shown its notes again', async () => {
        const moved = await memory.relevant(AGENT, 'the captcha solver failed on reCAPTCHA in chrome', {
            conversationId: 'c-1', session: 's-2', exclude: pinned, budget: Infinity,
        });
        assert.ok(moved.length > 0);
    });

    await check('the first message of a session keeps its notes when the session id arrives', async () => {
        const first = await memory.relevant(AGENT, 'where is the nginx config on web-01', {
            conversationId: 'c-new', session: '', exclude: pinned, budget: Infinity,
        });
        assert.ok(first.some(entry => entry.id === nginx.id));
        const second = await memory.relevant(AGENT, 'where is the nginx config on web-01', {
            conversationId: 'c-new', session: 's-new', exclude: pinned, budget: Infinity,
        });
        assert.ok(!second.some(entry => entry.id === nginx.id));
    });

    await check('a short follow-up is searched with the message before it', async () => {
        const alone = await memory.relevant(AGENT, 'ok do it', {
            conversationId: 'c-follow-a', exclude: pinned, budget: Infinity,
        });
        assert.strictEqual(alone.length, 0);
        const followed = await memory.relevant(AGENT, 'ok do it', {
            previous: 'check the nginx config on the web server web-01',
            conversationId: 'c-follow-b', exclude: pinned, budget: Infinity,
        });
        assert.ok(followed.some(entry => entry.id === nginx.id));
    });

    await check('a message about nothing the notebook knows gets nothing', async () => {
        const found = await memory.relevant(AGENT, 'what is the weather like in Lisbon tomorrow afternoon', {
            conversationId: 'c-none', exclude: pinned, budget: Infinity,
        });
        assert.strictEqual(found.length, 0);
    });

    await check('without the model, a note naming the same host is still found by word', async () => {
        fake.fail = true;
        try {
            const found = await memory.relevant(AGENT, 'is web-01 up?', { conversationId: 'c-words', exclude: pinned, budget: 50 });
            assert.ok(found.some(entry => entry.id === nginx.id));
        } finally {
            fake.fail = false;
        }
    });

    await check('an event fades a little with age; a fact does not', () => {
        const { faded } = memory._test;
        const now = Date.now();
        const old = { kind: 'event', createdAt: now - 90 * 24 * 3600 * 1000 };
        const fresh = { kind: 'event', createdAt: now };
        const fact = { kind: 'fact', createdAt: now - 400 * 24 * 3600 * 1000 };
        assert.ok(faded(old, 0.5, now) < faded(fresh, 0.5, now));
        assert.ok(faded(old, 0.5, now) >= 0.5 * 0.85);
        assert.strictEqual(faded(fact, 0.5, now), 0.5);
    });

    await check('a found event is written with its date', () => {
        const line = memory.line({ id: 'm-x', kind: 'event', createdAt: Date.UTC(2026, 9, 5), text: 'Released 1.3.5.' });
        assert.strictEqual(line, '- (m-x, 2026-10-05) Released 1.3.5.');
        assert.strictEqual(memory.line({ id: 'm-y', kind: 'fact', createdAt: 0, text: 'A fact.' }), '- (m-y) A fact.');
    });

    console.log('\nmemory: the tools');

    const on = { agentId: 'agent-tools', conversationId: 'c-tools', settings: settings._test.sanitize({ memory: true }) };
    const call = (name, input) => tools.BY_NAME.get(name).handler(input, on);

    await check('remember files a note by the kind given and says what is close to it', async () => {
        const first = JSON.parse((await call('remember', { text: 'The backups run nightly at 01:00 on db-01 with pg_dump.', kind: 'fact', tags: ['backups'] })).text);
        assert.strictEqual(first.kind, 'fact');
        await settle();
        const second = JSON.parse((await call('remember', { text: 'Nightly backups on db-01 run pg_dump at 01:00.', kind: 'fact' })).text);
        assert.ok(Array.isArray(second.similar) && second.similar.some(note => note.id === first.id), 'the near duplicate is named');
        assert.ok(second.hint);
    });

    await check('remember with replaces rewrites a note in place and keeps its earlier wording', async () => {
        const [held] = memory.list('agent-tools').filter(entry => entry.text.startsWith('The backups'));
        const result = JSON.parse((await call('remember', { text: 'The backups run nightly at 02:00 on db-01 with pg_dump.', replaces: held.id })).text);
        assert.strictEqual(result.updated, true);
        assert.strictEqual(result.id, held.id);
        const now = memory.get('agent-tools', held.id);
        assert.ok(now.text.includes('02:00'));
        assert.ok(now.history.some(item => item.text.includes('01:00')));
        const missing = await call('remember', { text: 'x', replaces: 'm-nope' });
        assert.strictEqual(missing.isError, true);
    });

    await check('recall searches by kind and tag', async () => {
        memory.add('agent-tools', { text: 'Never restart db-01 during business hours.', kind: 'rule', tags: ['backups'] });
        const rules = JSON.parse((await call('recall', { query: 'db-01', kind: 'rule' })).text);
        assert.ok(rules.matches.length >= 1 && rules.matches.every(match => match.kind === 'rule'));
        const tagged = JSON.parse((await call('recall', { query: 'db-01', tag: 'backups' })).text);
        assert.ok(tagged.matches.every(match => match.tags.includes('backups')));
    });

    await check('forget puts a note in the bin, and restore brings it back', async () => {
        const [held] = memory.list('agent-tools').filter(entry => entry.text.startsWith('Nightly'));
        const gone = await call('forget', { id: held.id, reason: 'Said twice' });
        assert.ok(!gone.isError);
        assert.ok(!memory.get('agent-tools', held.id));
        const bin = memory.trashed('agent-tools');
        assert.ok(bin.some(entry => entry.id === held.id && entry.reason === 'Said twice'));
        const back = memory.restore('agent-tools', held.id);
        assert.strictEqual(back.id, held.id);
        assert.ok(memory.get('agent-tools', held.id));
    });

    console.log('\nmemory: tidying');

    await check('the runtime\'s answer is read through fences and prose', () => {
        const { parse } = memoryTidy._test;
        assert.deepStrictEqual(parse('```json\n{"ops":[{"op":"delete","id":"m-1"}]}\n```').ops, [{ op: 'delete', id: 'm-1' }]);
        assert.strictEqual(parse('Here you go: {"ops": []}').ok, true);
        assert.strictEqual(parse('[{"op":"edit","id":"m-2","kind":"rule"}]').ops.length, 1);
        assert.strictEqual(parse('<think>hmm</think>{"ops":[{"op":"nope"}]}').ops.length, 0);
        assert.strictEqual(parse('I cannot help with that.').ok, false);
        assert.strictEqual(parse('').ok, false);
    });

    await check('the question carries the notes and the rule budget', () => {
        const { instruction, request } = memoryTidy._test;
        const text = instruction({ today: '2026-10-07', ruleChars: 900, ruleBudget: 2400 });
        assert.ok(text.includes('2400') && text.includes('900') && text.includes('2026-10-07'));
        const asked = request([{ id: 'm-1', kind: 'fact', source: 'agent', created: '2026-10-01', updated: '2026-10-01', tags: [], text: 'A note.' }]);
        assert.ok(asked.includes('"id":"m-1"') && asked.includes('<notes>'));
    });

    await check('ask goes through the runtime\'s one-turn question and never rejects', async () => {
        const provider = { title: async ({ instruction, prompt: asked }) => {
            assert.ok(instruction.includes('long-term memory'));
            assert.ok(asked.includes('m-1'));
            return '{"ops":[{"op":"delete","id":"m-1","reason":"stale"}]}';
        } };
        const answer = await memoryTidy.ask(provider, { settings: {}, notes: [{ id: 'm-1', kind: 'fact', source: 'agent', created: '', updated: '', tags: [], text: 'x' }] });
        assert.strictEqual(answer.ok, true);
        assert.strictEqual(answer.ops[0].id, 'm-1');
        const broken = await memoryTidy.ask({ title: async () => { throw new Error('offline'); } }, { settings: {}, notes: [] });
        assert.deepStrictEqual(broken, { ok: false, error: 'offline' });
        const none = await memoryTidy.ask({}, { settings: {}, notes: [] });
        assert.strictEqual(none.ok, false);
    });

    const TIDY = 'agent-tidy';
    const dupA = memory.add(TIDY, { text: 'Sidebar resize is uncommitted in Sidebar.jsx.', kind: 'event', tags: ['sidebar'] });
    const dupB = memory.add(TIDY, { text: 'Sidebar resize committed as 5caada5.', kind: 'event', tags: ['sidebar'] });
    const misfiled = memory.add(TIDY, { text: 'The user wants answers without em dashes.', kind: 'fact' });
    const wordy = memory.add(TIDY, { text: 'The deploy script lives in scripts/deploy.sh and it takes the environment as the first argument and then does many things.', kind: 'fact' });
    const stale = memory.add(TIDY, { text: 'Self-test passed 34 of 34 on an old checkout.', kind: 'event' });
    const users = memory.add(TIDY, { text: 'My laptop is the one called brad-xps.', kind: 'fact', source: 'user' });
    const rules = memory.add(TIDY, { text: 'Never push to main without running the tests.', kind: 'rule' });
    for (let index = 0; index < 4; index += 1) memory.add(TIDY, { text: `Filler fact number ${index} about server ${index}.`, kind: 'fact' });

    await check('a notebook never tidied, with enough notes, is due', () => {
        assert.strictEqual(memory.tidyState(TIDY).due, true);
        assert.strictEqual(memory.tidyState(TIDY).last, null);
        assert.ok(memory.tidyInput(TIDY).notes.some(note => note.id === dupA.id && note.source === 'agent'));
    });

    await check('a tidy merges, rewrites, refiles and puts away, within what it is allowed', () => {
        const result = memory.applyTidy(TIDY, [
            { op: 'merge', ids: [dupA.id, dupB.id], text: 'Sidebar resize committed as 5caada5 (Sidebar.jsx).', reason: 'same change' },
            { op: 'edit', id: misfiled.id, kind: 'rule', reason: 'a standing preference' },
            { op: 'edit', id: wordy.id, text: 'scripts/deploy.sh deploys; first argument is the environment.' },
            { op: 'delete', id: stale.id, reason: 'old self-test' },
            { op: 'edit', id: users.id, text: 'Rewritten by the model', tags: ['laptop'] },
            { op: 'delete', id: rules.id },
            { op: 'delete', id: 'm-not-there' },
            { op: 'edit', id: dupA.id, text: 'touched twice in one plan' },
        ], { by: 'claude-code' });
        assert.strictEqual(result.applied, true);
        assert.deepStrictEqual(result.counts, { merged: 2, edited: 1, reclassified: 1, retagged: 1, removed: 1 });

        const merged = memory.get(TIDY, dupA.id);
        assert.strictEqual(merged.text, 'Sidebar resize committed as 5caada5 (Sidebar.jsx).');
        assert.ok(merged.history.some(item => item.text.includes('uncommitted')));
        assert.ok(!memory.get(TIDY, dupB.id), 'the other half is in the bin');
        assert.ok(memory.trashed(TIDY).some(entry => entry.id === dupB.id && entry.reason.includes(dupA.id)));
        assert.strictEqual(memory.get(TIDY, misfiled.id).kind, 'rule');
        assert.ok(memory.get(TIDY, wordy.id).text.startsWith('scripts/deploy.sh'));
        assert.ok(!memory.get(TIDY, stale.id));
        assert.strictEqual(memory.get(TIDY, users.id).text, 'My laptop is the one called brad-xps.', 'the user\'s words stay');
        assert.deepStrictEqual(memory.get(TIDY, users.id).tags, ['laptop'], 'its tags may change');
        assert.ok(memory.get(TIDY, rules.id), 'a rule is never thrown away');

        const state = memory.tidyState(TIDY);
        assert.strictEqual(state.due, false);
        assert.strictEqual(state.last.by, 'claude-code');
        assert.strictEqual(state.last.changes.length, 5);
        assert.ok(memory.core(TIDY).ids.includes(misfiled.id), 'the refiled rule is in the prompt');
    });

    await check('undo takes the tidy back, except a note changed since', () => {
        memory.update(TIDY, wordy.id, { text: 'scripts/deploy.sh takes the environment first; edited by hand.' });
        const result = memory.undoTidy(TIDY);
        assert.strictEqual(result.undone, true);
        assert.strictEqual(result.kept, 1);
        assert.strictEqual(memory.get(TIDY, dupA.id).text, 'Sidebar resize is uncommitted in Sidebar.jsx.');
        assert.strictEqual(memory.get(TIDY, dupB.id).text, 'Sidebar resize committed as 5caada5.');
        assert.strictEqual(memory.get(TIDY, misfiled.id).kind, 'fact');
        assert.ok(memory.get(TIDY, stale.id));
        assert.ok(memory.get(TIDY, wordy.id).text.includes('edited by hand'));
        assert.strictEqual(memory.tidyState(TIDY).last.undone, true);
        assert.strictEqual(memory.undoTidy(TIDY).undone, false, 'once only');
    });

    await check('a plan that would empty the notebook is refused whole', () => {
        const before = memory.list(TIDY).length;
        const ops = memory.list(TIDY).filter(entry => entry.kind !== 'rule' && entry.source !== 'user').map(entry => ({ op: 'delete', id: entry.id }));
        const result = memory.applyTidy(TIDY, ops);
        assert.strictEqual(result.applied, false);
        assert.strictEqual(memory.list(TIDY).length, before);
        assert.ok(memory.tidyState(TIDY).failure.includes('too many'));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

/**
 * Searching conversations by what was said in them: the query language, the
 * scan, and the passages that come back marked for highlighting.
 *
 * The meaning half needs the embedding model, which a test machine may not
 * have, so it is switched off here and the word half is what is checked.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const assert = require('assert');

const electronStub = {
    app: { getPath: () => require('os').tmpdir(), getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const search = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'search'));

let passed = 0;
let failed = 0;
const check = async (label, fn) => {
    try {
        await fn();
        console.log(`  ok   ${label}`);
        passed++;
    } catch (error) {
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.message}`);
        failed++;
    }
};

const NOW = Date.parse('2026-09-02T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const conversation = (id, { title = '', pinned = false, busy = false, hostIds = [], updatedAt = NOW, events = [] } = {}) => ({
    id, title, pinned, busy, hostIds, updatedAt, createdAt: updatedAt - DAY, events, session: null, starting: null,
});

const CONVERSATIONS = [
    conversation('disk', {
        title: 'Disk full on web-01',
        pinned: true,
        hostIds: ['h-web'],
        events: [
            { type: 'user-message', text: 'web-01 is out of disk space, can you look?', at: NOW - 3 * DAY },
            { type: 'assistant-text', text: 'The /var volume is at 97%. Old journal files are the bulk of it.', at: NOW - 3 * DAY },
            { type: 'tool-call', name: 'run_command', input: { session: 's1', command: 'journalctl --vacuum-size=200M' }, at: NOW - 3 * DAY },
            { type: 'tool-result', text: 'Vacuuming done, freed 3.1G of archived journals.', isError: false, at: NOW - 3 * DAY },
        ],
    }),
    conversation('nginx', {
        title: 'nginx restart loop',
        updatedAt: NOW - 10 * DAY,
        events: [
            { type: 'user-message', text: 'nginx keeps restarting on api-02', at: NOW - 10 * DAY },
            { type: 'tool-call', name: 'run_command', input: { command: 'systemctl status nginx' }, at: NOW - 10 * DAY },
            { type: 'tool-result', text: 'nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)', isError: true, at: NOW - 10 * DAY },
            { type: 'assistant-text', text: 'Something else holds port 80. Let me find it.', at: NOW - 10 * DAY },
        ],
    }),
    conversation('chat', {
        title: 'Which distro for the new box',
        busy: true,
        updatedAt: NOW - DAY,
        events: [
            { type: 'user-message', text: 'Debian or Ubuntu for the new database server?', at: NOW - DAY },
            { type: 'assistant-text', text: 'Debian, for the release cadence you described.', at: NOW - DAY },
        ],
    }),
];

const options = (extra = {}) => ({
    now: NOW,
    withMeaning: false,
    openIds: new Set(['nginx']),
    hostName: (id) => ({ 'h-web': 'web-01' }[id] || ''),
    describe: (entry) => ({ conversationId: entry.id, title: entry.title, pinned: entry.pinned, updatedAt: entry.updatedAt }),
    ...extra,
});

async function run() {
    console.log('\nconversation search');

    await check('the query language is taken apart as documented', () => {
        const parsed = search.parse('disk "out of space" -ubuntu is:pinned has:error from:me tool:run_command host:web-01 after:7d before:2026-09-01', NOW);
        assert.deepStrictEqual(parsed.terms, ['disk']);
        assert.deepStrictEqual(parsed.phrases, ['out of space']);
        assert.deepStrictEqual(parsed.excluded, ['ubuntu']);
        assert.strictEqual(parsed.pinned, true);
        assert.ok(parsed.has.has('error'));
        assert.strictEqual(parsed.from, 'user');
        assert.strictEqual(parsed.tool, 'run_command');
        assert.strictEqual(parsed.host, 'web-01');
        assert.strictEqual(parsed.after, NOW - 7 * DAY);
        assert.strictEqual(parsed.before, Date.parse('2026-09-01'));
    });

    await check('an operator nobody defined is just a word', () => {
        const parsed = search.parse('is:whatever http://x', NOW);
        assert.deepStrictEqual(parsed.terms, ['is:whatever', 'http://x']);
    });

    await check('a plain word is found wherever it was said', async () => {
        const { results } = await search.search(CONVERSATIONS, options({ query: 'journal' }));
        assert.deepStrictEqual(results.map(result => result.conversationId), ['disk']);
        assert.ok(results[0].snippets.length >= 2, 'the reply and the command both mention it');
        assert.ok(results[0].snippets.every(snippet => snippet.ranges.length > 0));
    });

    await check('every word must appear, so adding one narrows', async () => {
        const loose = await search.search(CONVERSATIONS, options({ query: 'nginx' }));
        const tight = await search.search(CONVERSATIONS, options({ query: 'nginx journal' }));
        assert.strictEqual(loose.results.length, 1);
        assert.strictEqual(tight.results.length, 0);
    });

    await check('a title hit outranks a passage hit', async () => {
        const { results } = await search.search(CONVERSATIONS, options({ query: 'web-01' }));
        assert.strictEqual(results[0].conversationId, 'disk');
        assert.ok(results[0].titleRanges.length > 0);
    });

    await check('a phrase is the words in that order', async () => {
        const yes = await search.search(CONVERSATIONS, options({ query: '"address already in use"' }));
        const no = await search.search(CONVERSATIONS, options({ query: '"in use already"' }));
        assert.strictEqual(yes.results.length, 1);
        assert.strictEqual(no.results.length, 0);
    });

    await check('a minus keeps a conversation out', async () => {
        const { results } = await search.search(CONVERSATIONS, options({ query: 'server -debian' }));
        assert.strictEqual(results.length, 0);
    });

    await check('is:, has: and from: filter as they say', async () => {
        assert.deepStrictEqual((await search.search(CONVERSATIONS, options({ query: 'is:pinned' }))).results.map(r => r.conversationId), ['disk']);
        assert.deepStrictEqual((await search.search(CONVERSATIONS, options({ query: 'is:open' }))).results.map(r => r.conversationId), ['nginx']);
        assert.deepStrictEqual((await search.search(CONVERSATIONS, options({ query: 'is:working' }))).results.map(r => r.conversationId), ['chat']);
        assert.deepStrictEqual((await search.search(CONVERSATIONS, options({ query: 'has:error' }))).results.map(r => r.conversationId), ['nginx']);
        assert.deepStrictEqual((await search.search(CONVERSATIONS, options({ query: 'has:tool' }))).results.map(r => r.conversationId).sort(), ['disk', 'nginx']);
        // "port" is in the agent's reply about nginx, not in anything the user typed.
        assert.strictEqual((await search.search(CONVERSATIONS, options({ query: 'from:me port' }))).results.length, 0);
        assert.strictEqual((await search.search(CONVERSATIONS, options({ query: 'from:agent port' }))).results.length, 1);
    });

    await check('tool: and host: find what was run and where', async () => {
        assert.strictEqual((await search.search(CONVERSATIONS, options({ query: 'tool:run_command' }))).results.length, 2);
        assert.deepStrictEqual((await search.search(CONVERSATIONS, options({ query: 'host:web-01' }))).results.map(r => r.conversationId), ['disk']);
        assert.deepStrictEqual((await search.search(CONVERSATIONS, options({ query: 'host:api-02' }))).results.map(r => r.conversationId), ['nginx'], 'a host named in a message counts too');
    });

    await check('after: and before: read relative spans and dates', async () => {
        assert.deepStrictEqual((await search.search(CONVERSATIONS, options({ query: 'after:7d' }))).results.map(r => r.conversationId), ['disk', 'chat']);
        assert.deepStrictEqual((await search.search(CONVERSATIONS, options({ query: 'before:2026-08-30' }))).results.map(r => r.conversationId), ['nginx']);
        assert.strictEqual(search.parseDate('yesterday', NOW) < NOW, true);
    });

    await check('filters alone list by pin and recency with an opening line', async () => {
        const { results } = await search.search(CONVERSATIONS, options({ query: 'has:tool' }));
        assert.strictEqual(results[0].conversationId, 'disk', 'pinned first');
        assert.strictEqual(results[0].snippets[0].kind, 'user');
    });

    await check('passages are windows around the hit with the hit marked', () => {
        const long = 'x'.repeat(300) + ' the needle sits here ' + 'y'.repeat(300);
        const lower = long.toLowerCase();
        const at = lower.indexOf('needle');
        const snippet = search.excerpt(long, [[at, at + 6]]);
        assert.ok(snippet.text.startsWith('…') && snippet.text.endsWith('…'));
        const [[start, end]] = snippet.ranges;
        assert.strictEqual(snippet.text.slice(start, end), 'needle');
    });

    await check('tool calls are searched by their values, not their keys', () => {
        const passage = search.passageOf({ type: 'tool-call', name: 'run_command', input: { session: 'pane-1', command: 'df -h' } });
        assert.ok(passage.text.includes('df -h'));
        assert.ok(!passage.text.includes('session'), 'the key of an argument is not text anyone typed');
    });

    await check('the answer says whether meaning was in play', async () => {
        const { meaning } = await search.search(CONVERSATIONS, options({ query: 'disk' }));
        assert.strictEqual(meaning, 'off');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});

/**
 * The conversation history keeps everything.
 *
 * It used to keep the twenty most recent conversations and the last 600
 * events of each, and drop the pictures; a day and a half of real use was
 * enough to lose a week's worth. These are the promises that replaced that:
 * no count, no trimming, pictures kept, nothing read into memory before it
 * is asked for, the old single file brought across without losing it, and a
 * conversation deleted only by the user, or by the history period the user
 * chose.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
let userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-history-'));

const electronStub = {
    app: {
        getPath: (what) => (what === 'userData' ? userData : os.tmpdir()),
        getVersion: () => '1.0.0',
        on: () => {},
        whenReady: () => new Promise(() => {}),
    },
    safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => { throw new Error('unavailable'); },
        decryptString: () => { throw new Error('unavailable'); },
    },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
    ipcMain: { handle: () => {}, on: () => {} },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    if (request === '@huggingface/transformers') throw new Error('no model in tests');
    return realLoad.call(this, request, parent, isMain);
};

/** The main-process modules again, from scratch: what a restart of the app looks like. */
const fresh = (name) => {
    for (const key of Object.keys(require.cache)) {
        if (key.includes(`${path.sep}main${path.sep}`)) delete require.cache[key];
    }
    return require(path.join(ROOT, name));
};

let passed = 0;
let failed = 0;
const checkAsync = async (label, fn) => {
    try {
        await fn();
        console.log(`  ok   ${label}`);
        passed++;
    } catch (error) {
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.stack || error.message}`);
        failed++;
    }
};

/** A minimal conversation, the shape index.js keeps. */
function conversation(id, { title = `Chat ${id}`, events = [], updatedAt = Date.now(), pinned = false, agentId = '' } = {}) {
    return {
        id,
        scope: 'global',
        boundSessionId: '',
        sessionIds: [],
        hostIds: [],
        providerSessionId: '',
        provider: '',
        accountId: '',
        title,
        titleSource: '',
        pinned,
        settingsPatch: null,
        carryOver: '',
        pendingNote: '',
        agentId,
        costUsd: 0,
        busy: false,
        session: null,
        starting: null,
        createdAt: updatedAt - 1000,
        updatedAt,
        events,
    };
}

/** An archive with a map of its own behind it, as index.js gives it. */
function archiveWithMap() {
    const archive = fresh('ai/archive');
    const map = new Map();
    archive.setSource({
        get: id => map.get(id),
        all: () => map.values(),
        canRelease: entry => !entry.session && !entry.starting && !entry.busy,
    });
    archive.resume();
    return { archive, map };
}

/** The archive again over the same folder, with its stubs in a map. */
function reopen() {
    const { archive, map } = archiveWithMap();
    for (const meta of archive.load()) {
        const entry = archive.stub(meta, '');
        if (entry) map.set(entry.id, entry);
    }
    return { archive, map };
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex').toString('base64');

(async () => {
    console.log('\nconversation history');

    await checkAsync('every conversation is kept, not the most recent twenty', async () => {
        const { archive, map } = archiveWithMap();
        for (let index = 0; index < 75; index += 1) {
            const id = `conv-many-${index}`;
            map.set(id, archive.track(conversation(id, {
                events: [{ type: 'user-message', text: `message ${index}`, at: index + 1 }],
                updatedAt: 1000 + index,
            }), [{ type: 'user-message', text: `message ${index}`, at: index + 1 }]));
            archive.save(id);
        }
        archive.flush();

        const again = reopen();
        assert.strictEqual(again.map.size, 75);
        assert.ok(again.map.has('conv-many-0'), 'the oldest is still there');
        assert.strictEqual(again.archive.messageCount(again.map.get('conv-many-0')), 1);
    });

    await checkAsync('a long conversation is kept whole, start and all', async () => {
        const { archive, map } = reopen();
        const events = [];
        for (let index = 0; index < 5000; index += 1) {
            events.push({ type: 'tool-result', id: `t${index}`, text: `line ${index} `.repeat(80), at: index + 1 });
        }
        events.unshift({ type: 'user-message', text: 'the very first thing said', at: 0 });
        map.set('conv-long', archive.track(conversation('conv-long'), events));
        archive.save('conv-long');
        archive.flush();

        const again = reopen();
        const stored = again.map.get('conv-long');
        assert.strictEqual(stored.events.length, 5001);
        assert.strictEqual(stored.events[0].text, 'the very first thing said');
    });

    await checkAsync('pictures pasted into a message come back with their bytes', async () => {
        const { archive, map } = reopen();
        const events = [{ type: 'user-message', text: 'look at this', images: [{ name: 'shot.png', mediaType: 'image/png', data: PNG }], at: 5 }];
        map.set('conv-picture', archive.track(conversation('conv-picture'), events));
        archive.save('conv-picture');
        archive.flush();

        const file = fs.readFileSync(archive._paths.recordPath('conv-picture'), 'utf8');
        assert.ok(!file.includes(PNG), 'the bytes are not in the conversation file');
        const pictures = fs.readdirSync(archive._paths.imagesDirectory());
        assert.strictEqual(pictures.filter(name => name.startsWith('conv-picture.')).length, 1);

        const again = reopen();
        const image = again.map.get('conv-picture').events[0].images[0];
        assert.strictEqual(image.data, PNG);
        assert.strictEqual(image.name, 'shot.png');
    });

    await checkAsync('a conversation is not read in until something asks for its events', async () => {
        const { archive, map } = reopen();
        const stored = map.get('conv-long');
        assert.strictEqual(archive.isLoaded(stored), false);
        assert.strictEqual(archive.hasContent(stored), true);
        assert.strictEqual(archive.messageCount(stored), 1, 'the list reads the count from the index');
        assert.strictEqual(archive.isLoaded(stored), false);
        assert.strictEqual(stored.events.length, 5001);
        assert.strictEqual(archive.isLoaded(stored), true);
    });

    await checkAsync('a change to a stub that was never read in keeps its events', async () => {
        const { archive, map } = reopen();
        const stored = map.get('conv-long');
        stored.pinned = true;
        archive.save('conv-long');
        archive.flush();
        assert.strictEqual(archive.isLoaded(stored), false, 'pinning did not read it in');

        const again = reopen();
        assert.strictEqual(again.map.get('conv-long').pinned, true);
        assert.strictEqual(again.map.get('conv-long').events.length, 5001);
    });

    await checkAsync('deleting a conversation removes its file and its pictures, and nothing else', async () => {
        const { archive, map } = reopen();
        map.delete('conv-picture');
        archive.remove('conv-picture');
        archive.flush();
        assert.ok(!fs.existsSync(archive._paths.recordPath('conv-picture')));
        const pictures = fs.readdirSync(archive._paths.imagesDirectory());
        assert.strictEqual(pictures.filter(name => name.startsWith('conv-picture.')).length, 0);

        const again = reopen();
        assert.ok(!again.map.has('conv-picture'));
        assert.ok(again.map.has('conv-long'));
        assert.strictEqual(again.map.size, 76);
    });

    await checkAsync('a file the index never heard of is found and listed', async () => {
        const { archive } = reopen();
        const record = archive.pack(conversation('conv-orphan', {
            events: [{ type: 'user-message', text: 'written just before a crash', at: 1 }],
        }));
        fs.writeFileSync(archive._paths.recordPath('conv-orphan'), JSON.stringify({ version: 2, conversation: record }));

        const again = reopen();
        assert.ok(again.map.has('conv-orphan'));
        assert.strictEqual(again.map.get('conv-orphan').events[0].text, 'written just before a crash');
    });

    await checkAsync('a file that cannot be read is kept aside, not overwritten', async () => {
        const { archive } = reopen();
        const target = archive._paths.recordPath('conv-many-3');
        fs.writeFileSync(target, '{"version":2,"conversation":{"id":"conv-many-3","ev');
        const again = reopen();
        const stored = again.map.get('conv-many-3');
        assert.deepStrictEqual(stored.events, []);
        const aside = fs.readdirSync(path.dirname(target)).filter(name => name.startsWith('conv-many-3.json.unreadable-'));
        assert.strictEqual(aside.length, 1, 'the damaged file is still on disk, under another name');
    });

    await checkAsync('the index is rewritten once it is mostly old lines', async () => {
        const { archive, map } = reopen();
        const stored = map.get('conv-many-10');
        for (let index = 0; index < 400; index += 1) {
            stored.title = `Renamed ${index}`;
            archive.save('conv-many-10');
            archive.flush();
        }
        const lines = fs.readFileSync(archive._paths.journalPath(), 'utf8').split('\n').filter(Boolean).length;
        assert.ok(lines <= 2 * map.size + 201, `the index has ${lines} lines for ${map.size} conversations`);

        const again = reopen();
        assert.strictEqual(again.map.get('conv-many-10').title, 'Renamed 399');
        assert.strictEqual(again.map.size, map.size);
    });

    await checkAsync('the events of conversations nobody is looking at are let go, and read back intact', async () => {
        const { archive, map } = reopen();
        const ids = [...map.keys()].filter(id => id.startsWith('conv-many-'));
        for (const id of ids) void map.get(id).events;
        archive.flush();
        const held = ids.filter(id => archive.isLoaded(map.get(id))).length;
        assert.ok(held <= archive.MAX_RESIDENT, `${held} conversations still in memory`);
        const first = map.get(ids[0]);
        assert.strictEqual(archive.isLoaded(first), false);
        assert.strictEqual(first.events[0].type, 'user-message');
    });

    await checkAsync('a conversation in use is never let go', async () => {
        const { archive, map } = reopen();
        const busy = map.get('conv-many-20');
        void busy.events;
        busy.busy = true;
        for (const [id, entry] of map) if (id !== 'conv-many-20') void entry.events;
        archive.flush();
        assert.strictEqual(archive.isLoaded(busy), true);
    });

    await checkAsync('search reads a stub for a word only when its file has the word', async () => {
        const { archive, map } = reopen();
        const stored = map.get('conv-long');
        assert.strictEqual(await archive.peekEvents(stored, ['nowhere-to-be-found']), null);
        const events = await archive.peekEvents(stored, ['first']);
        assert.strictEqual(events.length, 5001);
        assert.strictEqual(archive.isLoaded(stored), false, 'and it was not kept');
    });

    console.log('\nthe old single file');

    // A machine that only ever ran an earlier version.
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-history-legacy-'));
    const legacyFile = path.join(userData, 'assistant-history.json');
    const legacyRecord = (id, updatedAt, text) => ({
        ...fresh('ai/archive').pack(conversation(id, { events: [{ type: 'user-message', text, at: updatedAt }], updatedAt })),
    });
    fs.writeFileSync(legacyFile, JSON.stringify({
        version: 1,
        conversations: [legacyRecord('conv-old-a', 100, 'alpha'), legacyRecord('conv-old-b', 200, 'beta'), legacyRecord('conv-old-c', 300, 'gamma')],
    }));

    await checkAsync('everything in it comes across, and the file is left where it was', async () => {
        const { map } = reopen();
        assert.deepStrictEqual([...map.keys()].sort(), ['conv-old-a', 'conv-old-b', 'conv-old-c']);
        assert.strictEqual(map.get('conv-old-b').events[0].text, 'beta');
        assert.ok(fs.existsSync(legacyFile));
    });

    await checkAsync('reading it again adds nothing twice', async () => {
        const { map } = reopen();
        assert.strictEqual(map.size, 3);
    });

    await checkAsync('one deleted here does not come back from it', async () => {
        const { archive, map } = reopen();
        map.delete('conv-old-a');
        archive.remove('conv-old-a');
        archive.flush();
        // An older copy of the app runs and writes its file again.
        const later = Date.now() + 5000;
        fs.writeFileSync(legacyFile, JSON.stringify({
            version: 1,
            conversations: [
                legacyRecord('conv-old-a', 100, 'alpha'),
                { ...legacyRecord('conv-old-b', later, 'beta'), events: [
                    { type: 'user-message', text: 'beta', at: 200 },
                    { type: 'user-message', text: 'said in the old copy', at: later },
                ] },
                legacyRecord('conv-old-c', 300, 'gamma'),
                legacyRecord('conv-old-d', later, 'delta'),
            ],
        }));
        fs.utimesSync(legacyFile, new Date(), new Date(Date.now() + 10000));

        const again = reopen();
        assert.ok(!again.map.has('conv-old-a'), 'the deleted one stays deleted');
        assert.ok(again.map.has('conv-old-d'), 'one started in the old copy since comes across');
        const carried = again.map.get('conv-old-b').events.map(event => event.text);
        assert.deepStrictEqual(carried, ['beta', 'said in the old copy'], 'what was said there since goes on the end');
    });

    await checkAsync('a backup reads every conversation, oldest first', async () => {
        const archive = fresh('ai/archive');
        const records = archive.read();
        assert.deepStrictEqual(records.map(record => record.id), ['conv-old-c', 'conv-old-b', 'conv-old-d']);
    });

    console.log('\nthe history setting');

    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-history-assistant-'));
    const assistant = fresh('ai/index');
    const agents = require(path.join(ROOT, 'agents'));
    const owner = agents.activeId();
    const DAY = 24 * 60 * 60 * 1000;

    const records = [];
    for (let index = 0; index < 40; index += 1) {
        records.push({
            id: `conv-a-${index}`,
            agentId: owner,
            title: `Chat ${index}`,
            createdAt: Date.now() - (index + 1) * DAY,
            updatedAt: Date.now() - index * DAY,
            pinned: index === 39,
            events: [{ type: 'user-message', text: index === 35 ? 'the payroll cron on billing-02' : `hello ${index}`, at: Date.now() - index * DAY }],
        });
    }

    await checkAsync('a restore adds every conversation in it, not the newest twenty', async () => {
        const result = assistant.importConversations(records);
        assert.strictEqual(result.added, 40);
        assert.strictEqual(assistant.list({ agentId: owner }).length, 40);
    });

    await checkAsync('forever is the default, and keeps everything', async () => {
        assert.strictEqual(assistant.settings.get().historyDays, 0);
        assert.strictEqual(assistant.sweepHistory(), 0);
        assert.strictEqual(assistant.list({ agentId: owner }).length, 40);
    });

    await checkAsync('after a restart, every conversation is listed and searchable without being read in', async () => {
        await assistant.shutdown();
        const rows = assistant.list({ agentId: owner });
        assert.strictEqual(rows.length, 40);
        assert.strictEqual(rows.find(row => row.conversationId === 'conv-a-35').messages, 1);
        const found = await assistant.search({ agentId: owner, query: 'payroll' });
        assert.deepStrictEqual(found.results.map(result => result.conversationId), ['conv-a-35']);
        assert.ok(found.results[0].snippets[0].text.includes('payroll'));
    });

    await checkAsync('a period the user chose deletes what is older, but never a pinned one', async () => {
        const before = assistant.settings.get();
        const after = assistant.settings.set({ historyDays: 30 });
        assert.strictEqual(after.historyDays, 30);
        assistant.reconfigure(before, after, after.agentId);
        const left = assistant.list({ agentId: owner }).map(row => row.conversationId);
        assert.ok(left.includes('conv-a-29'), 'touched 29 days ago, kept');
        assert.ok(!left.includes('conv-a-31'), 'touched 31 days ago, deleted');
        assert.ok(left.includes('conv-a-39'), 'pinned, kept whatever its age');
    });

    await checkAsync('nonsense in the setting keeps everything rather than deleting it', async () => {
        assert.strictEqual(assistant.settings.set({ historyDays: 'soon' }).historyDays, 0);
        assert.strictEqual(assistant.settings.set({ historyDays: -5 }).historyDays, 0);
    });

    await assistant.shutdown();

    console.log(`\n${passed} checks passed${failed > 0 ? `, ${failed} failed` : ''}`);
    if (failed > 0) process.exit(1);
})();

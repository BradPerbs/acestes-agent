/**
 * Exercises the backup envelope and a full export -> restore round trip,
 * with `electron` stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');

let userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-a-'));

const electronStub = {
    app: {
        getPath: (what) => (what === 'userData' ? userData : os.tmpdir()),
        getVersion: () => '1.0.0',
    },
    // No OS keystore: the vault falls back to storing the data key unwrapped,
    // which is the Linux-without-a-keyring path and is fine for a test.
    safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => { throw new Error('unavailable'); },
        decryptString: () => { throw new Error('unavailable'); },
    },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    // No model in tests: memory imports must not attempt a 90MB download.
    if (request === '@huggingface/transformers') throw new Error('no model in tests');
    return realLoad.call(this, request, parent, isMain);
};

const fresh = (name) => {
    for (const key of Object.keys(require.cache)) {
        if (key.includes(`${path.sep}main${path.sep}`)) delete require.cache[key];
    }
    return require(path.join(ROOT, name));
};

let passed = 0;
const check = (label, fn) => {
    try {
        fn();
        console.log(`  ok   ${label}`);
        passed++;
    } catch (error) {
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.message}`);
        process.exitCode = 1;
    }
};

/* ---------------- envelope ---------------- */

console.log('\nbackup envelope');

const backup = fresh('backup.js');
const PAYLOAD = { hosts: [{ id: 'h1', name: 'prod', password: 'hunter2' }], nested: { a: [1, 2] } };
const PASS = 'correct horse battery';

check('round trips an identical payload', () => {
    const opened = backup.unseal(backup.seal(PAYLOAD, PASS), PASS);
    assert.deepStrictEqual(opened, PAYLOAD);
});

check('never writes the plaintext into the envelope', () => {
    const sealed = JSON.stringify(backup.seal(PAYLOAD, PASS));
    assert.ok(!sealed.includes('hunter2'), 'password appears in the envelope');
    assert.ok(!sealed.includes('prod'), 'host name appears in the envelope');
});

check('rejects the wrong passphrase', () => {
    assert.strictEqual(backup.unseal(backup.seal(PAYLOAD, PASS), 'wrong passphrase'), null);
});

check('rejects a tampered ciphertext', () => {
    const sealed = backup.seal(PAYLOAD, PASS);
    const raw = Buffer.from(sealed.payload, 'base64');
    raw[raw.length - 1] ^= 0xff;
    sealed.payload = raw.toString('base64');
    assert.strictEqual(backup.unseal(sealed, PASS), null);
});

check('rejects a KDF cost downgraded in the header', () => {
    const sealed = backup.seal(PAYLOAD, PASS);
    sealed.kdf.N = 2; // what an attacker would want, to make guessing cheap
    assert.strictEqual(backup.unseal(sealed, PASS), null);
});

check('rejects a swapped salt', () => {
    const sealed = backup.seal(PAYLOAD, PASS);
    sealed.kdf.salt = 'ab'.repeat(32);
    assert.strictEqual(backup.unseal(sealed, PASS), null);
});

check('throws on a file that is not a backup', () => {
    assert.throws(() => backup.unseal({ hello: 'world' }, PASS), /not a CloudBlast backup/i);
});

check('throws on a newer format version', () => {
    const sealed = backup.seal(PAYLOAD, PASS);
    sealed.version = 99;
    assert.throws(() => backup.unseal(sealed, PASS), /newer version/i);
});

check('throws on a truncated payload', () => {
    const sealed = backup.seal(PAYLOAD, PASS);
    sealed.payload = Buffer.from('short').toString('base64');
    assert.throws(() => backup.unseal(sealed, PASS), /truncated/i);
});

check('requires a passphrase of at least 8 characters', () => {
    assert.ok(backup.validatePassphrase('short'));
    assert.strictEqual(backup.validatePassphrase('longenough'), '');
});

check('writes and reads a file', () => {
    const file = path.join(userData, 'test.cbbackup');
    backup.writeFile(file, backup.seal(PAYLOAD, PASS));
    assert.deepStrictEqual(backup.unseal(backup.readFile(file), PASS), PAYLOAD);
});

/* ---------------- export -> restore ---------------- */

console.log('\nexport and restore');

const storeA = fresh('store.js');
const knownA = fresh('known-hosts.js');

storeA.saveHost({
    id: 'host-1', name: 'prod-web', host: '10.0.0.5', port: 22,
    username: 'deploy', authMethod: 'password', password: 'sup3rsecret',
    tunnels: [{ id: 't1', type: 'local', listenPort: 5432, destHost: 'db', destPort: 5432 }],
});
storeA.saveHost({
    id: 'host-2', name: 'bastion', host: '10.0.0.1', username: 'root',
    authMethod: 'key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n', passphrase: 'kp',
});
storeA.saveFolder({ id: 'folder-1', name: 'Production' });
storeA.saveKey({ id: 'key-1', name: 'work', privateKey: 'PRIVATE-MATERIAL', passphrase: 'keypass' });
storeA.saveSnippet({ id: 'snip-1', name: 'restart', command: 'systemctl restart {{svc}}' });
knownA.trust('10.0.0.5', 22, Buffer.concat([
    Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from('keyblob'),
]));

const exported = { ...storeA.exportAll(), knownHosts: knownA.exportAll() };

check('export carries secrets in the clear inside the payload', () => {
    assert.strictEqual(exported.hosts.find(h => h.id === 'host-1').password, 'sup3rsecret');
    assert.strictEqual(exported.keys.find(k => k.id === 'key-1').privateKey, 'PRIVATE-MATERIAL');
    assert.strictEqual(exported.keys.find(k => k.id === 'key-1').passphrase, 'keypass');
});

check('export includes every collection', () => {
    assert.strictEqual(exported.hosts.length, 2);
    assert.strictEqual(exported.folders.length, 1);
    assert.strictEqual(exported.keys.length, 1);
    assert.strictEqual(exported.snippets.length, 1);
    assert.strictEqual(Object.keys(exported.knownHosts).length, 1);
});

const sealedFile = path.join(userData, 'roundtrip.cbbackup');
backup.writeFile(sealedFile, backup.seal(exported, PASS));

// A second machine: new user-data directory, nothing in it.
userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-b-'));
const storeB = fresh('store.js');
const knownB = fresh('known-hosts.js');
const backupB = fresh('backup.js');

const restored = backupB.unseal(backupB.readFile(sealedFile), PASS);

check('preview reports everything as new on a fresh machine', () => {
    const preview = storeB.previewImport(restored);
    assert.strictEqual(preview.hosts.total, 2);
    assert.strictEqual(preview.hosts.new, 2);
    assert.strictEqual(preview.hosts.existing, 0);
});

const summary = storeB.importAll(restored, { overwrite: false });
knownB.importAll(restored.knownHosts, { overwrite: false });

check('restore reports what it added', () => {
    assert.strictEqual(summary.hosts.added, 2);
    assert.strictEqual(summary.keys.added, 1);
    assert.strictEqual(summary.folders.added, 1);
    assert.strictEqual(summary.snippets.added, 1);
});

check('restored secrets decrypt back to the originals', () => {
    const one = storeB.resolveCredentials('host-1');
    assert.strictEqual(one.password, 'sup3rsecret');
    const two = storeB.resolveCredentials('host-2');
    assert.strictEqual(two.privateKey, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n');
    assert.strictEqual(two.passphrase, 'kp');
});

check('restored secrets are re-encrypted at rest, not stored in the clear', () => {
    const onDisk = fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8');
    assert.ok(!onDisk.includes('sup3rsecret'), 'host password is on disk in the clear');
    assert.ok(!onDisk.includes('PRIVATE-MATERIAL'), 'key material is on disk in the clear');
    assert.ok(onDisk.includes('v2:'), 'secrets are not under the vault key');
});

check('keychain auth resolves through the restored key', () => {
    storeB.saveHost({ id: 'host-3', name: 'via-keychain', host: 'h', username: 'u',
        authMethod: 'keychain', keychainKeyId: 'key-1' });
    const creds = storeB.resolveCredentials('host-3');
    assert.strictEqual(creds.privateKey, 'PRIVATE-MATERIAL');
    assert.strictEqual(creds.passphrase, 'keypass');
});

check('tunnels survive the round trip', () => {
    const tunnels = storeB.getHostTunnels('host-1');
    assert.strictEqual(tunnels.length, 1);
    assert.strictEqual(tunnels[0].listenPort, 5432);
});

check('trusted host keys come back', () => {
    const list = knownB.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].host, '10.0.0.5');
    assert.strictEqual(list[0].entries.length, 1);
});

/* ---------------- merge behaviour ---------------- */

console.log('\nmerge behaviour');

check('restoring twice is a no-op by default', () => {
    const again = storeB.importAll(restored, { overwrite: false });
    assert.strictEqual(again.hosts.added, 0);
    assert.strictEqual(again.hosts.skipped, 2);
    assert.strictEqual(storeB.getHosts().filter(h => h.id === 'host-1').length, 1);
});

check('a local edit survives a default restore', () => {
    storeB.saveHost({ id: 'host-1', name: 'renamed-locally' });
    storeB.importAll(restored, { overwrite: false });
    assert.strictEqual(storeB.getHosts().find(h => h.id === 'host-1').name, 'renamed-locally');
});

check('overwrite makes the machine match the backup', () => {
    const result = storeB.importAll(restored, { overwrite: true });
    assert.strictEqual(result.hosts.replaced, 2);
    assert.strictEqual(storeB.getHosts().find(h => h.id === 'host-1').name, 'prod-web');
    assert.strictEqual(storeB.resolveCredentials('host-1').password, 'sup3rsecret');
});

check('preview marks existing records once they are there', () => {
    const preview = storeB.previewImport(restored);
    assert.strictEqual(preview.hosts.existing, 2);
    assert.strictEqual(preview.hosts.new, 0);
});

check('a secret that looks like ciphertext is still stored encrypted', () => {
    // The "does this already look encrypted" heuristic used on the save path
    // would store this as-is; the restore path must not use it.
    storeB.importAll({ hosts: [{ id: 'odd', name: 'odd', password: 'v2:notreallyciphertext' }] },
        { overwrite: true });
    assert.strictEqual(storeB.resolveCredentials('odd').password, 'v2:notreallyciphertext');
    const onDisk = fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8');
    assert.ok(!onDisk.includes('v2:notreallyciphertext'), 'stored verbatim instead of encrypted');
});

check('known-hosts merge is additive and deduplicated', () => {
    const before = knownB.list()[0].entries.length;
    knownB.importAll(restored.knownHosts, { overwrite: false });
    assert.strictEqual(knownB.list()[0].entries.length, before, 'a duplicate fingerprint was added');
});

check('malformed records are skipped, not fatal', () => {
    const result = storeB.importAll({ hosts: [null, { name: 'no id' }, undefined] }, {});
    assert.strictEqual(result.hosts.added, 0);
    assert.strictEqual(result.hosts.skipped, 3);
});

/* ---------------- agents, assistant, secrets, memory, jobs, history ---------------- */

console.log('\nnew backup sections');

// A third machine holding an agent, assistant settings, a memory and a job.
userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-c-'));
const agentsC = fresh('agents.js');
const settingsC = fresh('ai/settings');
const secretsC = fresh('ai/secrets');
const memoryC = fresh('ai/memory');
const jobsC = fresh('runs/jobs');
const archiveC = fresh('ai/archive');
const sessionLogC = fresh('session-log');

const savedAgent = agentsC.save({ name: 'Work', color: 'violet' });
const workAgentId = savedAgent.saved;
settingsC.set({ enabled: false });
memoryC.add(workAgentId, { text: 'The user prefers vim.', source: 'user' });
const createdJob = jobsC.create({ name: 'nightly', agentId: workAgentId, schedule: 'every 30m', prompt: 'Summarise the day.' });
assert.ok(createdJob.job, 'job setup failed: ' + (createdJob.error || 'unknown'));

const liveConversation = {
    id: 'conv-1',
    scope: 'global',
    boundSessionId: '',
    sessionIds: [],
    hostIds: ['host-1'],
    providerSessionId: '',
    provider: 'test-provider',
    title: 'Deploy chat',
    pinned: true,
    agentId: workAgentId,
    costUsd: 0,
    busy: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    events: [{ type: 'user-text', text: 'deploy it' }],
};

const extended = {
    agents: agentsC.exportAll(),
    conversations: [archiveC.pack(liveConversation)],
    assistant: settingsC.exportAll(),
    secrets: secretsC.exportAll(),
    memory: memoryC.exportAll(),
    jobs: jobsC.exportAll(),
    sessionLog: sessionLogC.exportAll(),
};

check('export carries the new sections', () => {
    assert.strictEqual(extended.agents.agents.length, 2);
    assert.strictEqual(extended.agents.agents.find(a => a.id === workAgentId).name, 'Work');
    assert.strictEqual(extended.conversations.length, 1);
    assert.strictEqual(extended.assistant.config.enabled, false);
    assert.deepStrictEqual(extended.secrets, {});
    assert.strictEqual(extended.memory[workAgentId].length, 1);
    assert.strictEqual(extended.jobs.length, 1);
    assert.ok('enabled' in extended.sessionLog, 'session-log config missing');
});

// A fourth machine: nothing in it but defaults.
userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-d-'));
const agentsD = fresh('agents.js');
const settingsD = fresh('ai/settings');
const secretsD = fresh('ai/secrets');
const memoryD = fresh('ai/memory');
const jobsD = fresh('runs/jobs');
const archiveD = fresh('ai/archive');
const sessionLogD = fresh('session-log');

const agentsResult = agentsD.importAll(extended.agents, {});
const assistantResult = settingsD.importAll(extended.assistant, { overwrite: true });
const secretsResult = secretsD.importAll({ orphan: 'unencryptable-here' }, {});
const memoryResult = memoryD.importAll(extended.memory, {});
const jobsResult = jobsD.importAll(extended.jobs, {});
const sessionLogResult = sessionLogD.importAll(extended.sessionLog, { overwrite: true });

check('agents merge by id and keep the local selection', () => {
    assert.strictEqual(agentsResult.added, 2);
    const snapshot = agentsD.snapshot();
    assert.strictEqual(snapshot.agents.length, 3);
    assert.strictEqual(snapshot.agents.find(a => a.id === workAgentId).color, 'violet');
    assert.notStrictEqual(snapshot.activeId, workAgentId);
});

check('agents re-import is a no-op without overwrite', () => {
    const again = agentsD.importAll(extended.agents, {});
    assert.strictEqual(again.added, 0);
    assert.strictEqual(again.skipped, 2);
});

check('assistant base and session-log config apply on overwrite', () => {
    assert.strictEqual(assistantResult.replaced, 1);
    assert.strictEqual(settingsD.get().enabled, false);
    assert.strictEqual(sessionLogResult.replaced, 1);
});

check('assistant base is kept without overwrite', () => {
    settingsD.set({ enabled: true });
    const kept = settingsD.importAll(extended.assistant, {});
    assert.strictEqual(settingsD.get().enabled, true);
    assert.strictEqual(kept.skipped, 1);
});

check('secrets that cannot be encrypted are skipped, not kept in the clear', () => {
    assert.strictEqual(secretsResult.added, 0);
    assert.strictEqual(secretsResult.skipped, 1);
    assert.deepStrictEqual(secretsD.exportAll(), {});
});

check('memories round trip with their ids', () => {
    assert.strictEqual(memoryResult.added, 1);
    const notes = memoryD.list(workAgentId);
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].text, 'The user prefers vim.');
    const again = memoryD.importAll(extended.memory, {});
    assert.strictEqual(again.added, 0);
    assert.strictEqual(again.skipped, 1);
});

check('one notebook exports as a file and imports into another agent', () => {
    const file = JSON.parse(JSON.stringify(memoryC.exportAgent(workAgentId, { name: 'Work' })));
    assert.strictEqual(file.format, 'acestes-memory');
    assert.strictEqual(file.agent.name, 'Work');
    assert.strictEqual(file.entries.length, 1);

    const result = memoryD.importAgent('other-agent', file);
    assert.deepStrictEqual(result, { added: 1, updated: 0, skipped: 0 });
    const notes = memoryD.list('other-agent');
    assert.strictEqual(notes[0].text, 'The user prefers vim.');
    assert.strictEqual(notes[0].source, 'user');
    assert.strictEqual(notes[0].createdAt, file.entries[0].createdAt);

    // The same file again adds nothing; a newer copy of the note replaces it.
    assert.deepStrictEqual(memoryD.importAgent('other-agent', file), { added: 0, updated: 0, skipped: 1 });
    const newer = { ...file.entries[0], text: 'The user prefers neovim.', updatedAt: file.entries[0].updatedAt + 1 };
    assert.deepStrictEqual(memoryD.importAgent('other-agent', { entries: [newer] }), { added: 0, updated: 1, skipped: 0 });
    assert.strictEqual(memoryD.list('other-agent')[0].text, 'The user prefers neovim.');
});

check('a notebook import takes bare lists and plain sentences, and refuses anything else', () => {
    const result = memoryD.importAgent('list-agent', ['Staging runs Ubuntu 22.04.', { text: '  ' }, 'staging runs ubuntu 22.04.']);
    assert.deepStrictEqual(result, { added: 1, updated: 0, skipped: 2 });
    assert.strictEqual(memoryD.list('list-agent')[0].source, 'agent');
    assert.strictEqual(memoryD.importAgent('list-agent', { hosts: [] }), null);
    assert.strictEqual(memoryD.importAgent('list-agent', null), null);
});

check('jobs round trip with fresh execution state', () => {
    assert.strictEqual(jobsResult.added, 1);
    const job = jobsD.get(createdJob.job.id);
    assert.strictEqual(job.name, 'nightly');
    assert.strictEqual(job.prompt, 'Summarise the day.');
    assert.strictEqual(job.lastRunAt, null);
    assert.strictEqual(job.runCount, 0);
    const again = jobsD.importAll(extended.jobs, {});
    assert.strictEqual(again.skipped, 1);
});

check('expired one-shot jobs are skipped', () => {
    const result = jobsD.importAll([{
        id: 'old', name: 'old', agentId: workAgentId,
        schedule: { kind: 'at', at: Date.now() - 3600000 },
        prompt: 'too late',
    }], { overwrite: true });
    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.skipped, 1);
});

check('packed conversations survive seal and unseal, and unpack honestly', () => {
    const opened = backupB.unseal(backupB.seal({ conversations: extended.conversations }, PASS), PASS);
    const record = opened.conversations[0];
    assert.strictEqual(record.title, 'Deploy chat');
    const back = archiveD.unpack(record, 'test-provider');
    assert.strictEqual(back.events.length, 1);
    assert.strictEqual(back.pinned, true);
    // A question nobody answered before the app closed is not still asked.
    const hanging = archiveD.unpack({
        ...record,
        id: 'conv-2',
        busy: true,
        events: [...record.events, { type: 'approval-request', requestId: 'r1' }],
    }, 'test-provider');
    assert.ok(hanging.events.some(e => e.type === 'approval-settled' && e.status === 'expired'));
    assert.ok(hanging.events.some(e => e.type === 'notice'));
});

check('the model a conversation was left on comes back with it', () => {
    const packed = archiveD.pack({
        id: 'conv-model', scope: 'global', events: [],
        settingsPatch: { provider: 'codex', model: 'gpt-5.5', effort: 'high' },
        createdAt: 1, updatedAt: 2,
    });
    const back = archiveD.unpack(JSON.parse(JSON.stringify(packed)), 'codex');
    assert.deepStrictEqual(back.settingsPatch, { provider: 'codex', model: 'gpt-5.5', effort: 'high' });
    // One that follows the agent's defaults keeps following them, and junk is
    // dropped rather than handed to the settings resolver.
    assert.strictEqual(archiveD.unpack({ ...packed, settingsPatch: null }, 'codex').settingsPatch, null);
    assert.deepStrictEqual(archiveD.unpack({ ...packed, settingsPatch: { model: 'x', effort: 7 } }, 'codex').settingsPatch, { model: 'x' });
});

check('missing sections import as zeros, for old backups', () => {
    const empty = agentsD.importAll(undefined, {});
    assert.deepStrictEqual(empty, { added: 0, replaced: 0, skipped: 0 });
    const emptyJobs = jobsD.importAll(undefined, {});
    assert.deepStrictEqual(emptyJobs, { added: 0, replaced: 0, skipped: 0 });
});

console.log(`\n${passed} checks passed${process.exitCode ? ', with failures above' : ''}\n`);

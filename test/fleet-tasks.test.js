/**
 * Tasks across devices (src/main/fleet/tasks.js), over a real relay, with a
 * stand-in for the assistant core on each side.
 *
 * The worker's fake runs a turn the way the real one is seen from outside:
 * the user's message, then an approval card when the brief asks for one, a
 * reply, and the end of the turn. The asker's fake keeps mirrors the way
 * ai/index.js does, and hands what it cannot answer itself to the bridge.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createHub } = require('../src/main/fleet/hub');
const { createDevice } = require('../src/main/fleet/device');
const { createTasks, shrink } = require('../src/main/fleet/tasks');

let passed = 0;
let failed = 0;

async function check(label, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${label}`);
    } catch (error) {
        failed += 1;
        process.exitCode = 1;
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.stack || error.message}`);
    }
}

async function until(test, what, timeout = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (await test()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

function makeDevice(name) {
    const saved = { value: null };
    const device = createDevice({
        load: () => (saved.value ? JSON.parse(saved.value) : null),
        save: (state) => {
            saved.value = JSON.stringify(state);
        },
        describe: () => ({ os: 'test' }),
        defaultName: () => name,
    });
    return device;
}

/** The assistant core as tasks.js sees it, with conversations held in memory. */
function makeAi() {
    const conversations = new Map();
    const observers = new Set();
    const approvals = new Map();
    let bridge = null;
    let counter = 0;

    const emit = (conversation, event) => {
        const stamped = { ...event, at: Date.now() };
        conversation.events.push(stamped);
        if (!conversation.remote) for (const fn of observers) fn(stamped, { conversationId: conversation.id, busy: conversation.busy });
    };

    async function turn(conversation, text) {
        conversation.busy = true;
        emit(conversation, { type: 'user-message', text });
        await new Promise(resolve => setTimeout(resolve, 10));
        if (/approval/.test(text)) {
            const requestId = `approve-${++counter}`;
            const verdict = await new Promise((resolve) => {
                approvals.set(requestId, { resolve, conversation });
                emit(conversation, { type: 'approval-request', requestId, name: 'run_command', input: { command: 'whoami' } });
            });
            emit(conversation, { type: 'approval-settled', requestId, status: verdict ? 'approved' : 'denied' });
        }
        if (conversation.stopped) {
            conversation.stopped = false;
            return;
        }
        emit(conversation, { type: 'assistant-text', text: `done: ${text}` });
        conversation.busy = false;
        emit(conversation, { type: 'result' });
    }

    const agentsList = [{ id: 'agent-1', name: 'Ops' }, { id: 'agent-2', name: 'Builder' }];

    return {
        conversations,
        observers,
        bridge: () => bridge,
        create({ agentId }) {
            const id = `conv-${++counter}`;
            conversations.set(id, { id, agentId, events: [], busy: false });
            return { conversationId: id };
        },
        async send(id, text) {
            const conversation = conversations.get(id);
            if (conversation.remote) return bridge.send(conversation, text);
            turn(conversation, text);
            return { success: true };
        },
        async interrupt(id) {
            const conversation = conversations.get(id);
            if (conversation.remote) return bridge.interrupt(conversation);
            conversation.stopped = true;
            conversation.busy = false;
            for (const [requestId, entry] of approvals) {
                if (entry.conversation === conversation) {
                    approvals.delete(requestId);
                    entry.resolve(false);
                }
            }
            emit(conversation, { type: 'interrupted' });
            return { success: true };
        },
        respondToApproval({ requestId, approved }) {
            const entry = approvals.get(requestId);
            if (!entry) return bridge ? bridge.answer({ kind: 'approval', requestId, approved }) : false;
            approvals.delete(requestId);
            entry.resolve(Boolean(approved));
            return true;
        },
        respondToQuestion: () => false,
        history(id) {
            const conversation = conversations.get(id);
            return { events: conversation.events, busy: conversation.busy };
        },
        observe(fn) {
            observers.add(fn);
            return () => observers.delete(fn);
        },
        createMirror({ agentId, title, remote }) {
            const id = `mirror-${++counter}`;
            conversations.set(id, { id, agentId, title, remote, events: [], busy: false });
            return id;
        },
        ingestRemote(id, event) {
            const conversation = conversations.get(id);
            conversation.events.push(event);
            return true;
        },
        replaceRemoteEvents(id, events) {
            const conversation = conversations.get(id);
            conversation.events = [...events];
            conversation.replaced = (conversation.replaced || 0) + 1;
            return true;
        },
        setRemoteBridge(next) {
            bridge = next;
        },
        showConversation: () => ({ opened: true }),
        has: id => conversations.has(id),
        remoteOf: id => (conversations.get(id)?.remote ? conversations.get(id).remote.deviceName || 'another' : ''),
        updateMirror(id, meta) {
            const conversation = conversations.get(id);
            if (!conversation) return false;
            if (meta.title) conversation.title = meta.title;
            return true;
        },
        close(id) {
            conversations.delete(id);
            return { success: true };
        },
        /** What ai/index.js does when a mirror is read: ask the bridge to fetch it. */
        read(id) {
            const conversation = conversations.get(id);
            if (conversation?.remote) bridge?.opened?.(conversation);
            return conversation?.events || [];
        },
        agents: () => agentsList,
        activeAgentId: () => 'agent-1',
    };
}

function makeTasks(device, ai, { accept = { on: true }, stored = { value: null } } = {}) {
    return createTasks({
        device,
        ai,
        persist: { load: () => stored.value, save: (value) => { stored.value = value; } },
        accepts: () => accept.on,
    });
}

const types = conversation => conversation.events.map(event => event.type);

(async () => {
    console.log('\nfleet tasks');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acestes-tasks-'));
    const hub = createHub({ port: 0, host: '127.0.0.1', file: path.join(dir, 'relay.json') });
    const { port } = await hub.start();

    const desk = makeDevice('Office PC');
    const server = makeDevice('RDP-01');
    const deskAi = makeAi();
    const serverAi = makeAi();
    const accept = { on: true };
    const serverStore = { value: null };
    const deskTasks = makeTasks(desk, deskAi);
    let serverTasks = makeTasks(server, serverAi, { accept, stored: serverStore });

    desk.createFleet({ relay: `ws://127.0.0.1:${port}` });
    await until(() => desk.status().connection.state === 'online', 'desk online');
    server.join(desk.createInvite().code);
    await until(() => server.status().fleet && desk.isOnline(server.selfId()), 'server joined');

    let mirrorId = '';

    await check('a task runs on the other device and its report comes back', async () => {
        const result = await deskTasks.start({ device: 'rdp-01', brief: 'check the disk', agentId: 'agent-1' });
        assert.strictEqual(result.status, 'done', JSON.stringify(result));
        assert.strictEqual(result.report, 'done: check the disk');
        assert.strictEqual(result.device, 'RDP-01');
        assert.strictEqual(result.agent, 'Ops');
        mirrorId = result.conversationId;
        const mirror = deskAi.conversations.get(mirrorId);
        await until(() => types(mirror).includes('result'), 'mirror has the result');
        assert.deepStrictEqual(types(mirror), ['user-message', 'assistant-text', 'result']);
        assert.strictEqual(mirror.remote.deviceName, 'RDP-01');
        const worked = [...serverAi.conversations.values()][0];
        assert.strictEqual(worked.agentId, 'agent-1');
    });

    await check('an agent on the other device is picked by name', async () => {
        const result = await deskTasks.start({ device: 'RDP-01', brief: 'build it', agent: 'builder' });
        assert.strictEqual(result.agent, 'Builder');
        const missing = await deskTasks.start({ device: 'RDP-01', brief: 'x', agent: 'nobody' });
        assert.match(missing.error, /no agent called "nobody"/);
    });

    await check('an unknown device is named as such, with the ones there are', async () => {
        const result = await deskTasks.start({ device: 'Laptop', brief: 'x' });
        assert.match(result.error, /No device called "Laptop".*RDP-01/);
    });

    await check('an approval asked over there is answered from the mirror', async () => {
        const started = await deskTasks.start({ device: 'RDP-01', brief: 'needs approval', wait: false });
        assert.strictEqual(started.status, 'working');
        const mirror = deskAi.conversations.get(started.conversationId);
        await until(() => types(mirror).includes('approval-request'), 'card in the mirror');
        const card = mirror.events.find(event => event.type === 'approval-request');
        assert.strictEqual(deskAi.respondToApproval({ requestId: card.requestId, approved: true }), true);
        await until(() => types(mirror).includes('result'), 'turn finished after the answer');
        const settled = mirror.events.find(event => event.type === 'approval-settled');
        assert.strictEqual(settled.status, 'approved');
    });

    await check('a message typed in the mirror runs over there', async () => {
        const mirror = deskAi.conversations.get(mirrorId);
        const sent = await deskAi.send(mirrorId, 'and the memory');
        assert.strictEqual(sent.success, true);
        await until(() => mirror.events.filter(event => event.type === 'result').length === 2, 'second turn back');
        assert.strictEqual(mirror.events.at(-2).text, 'done: and the memory');
    });

    await check('stop in the mirror stops the turn over there', async () => {
        const started = await deskTasks.start({ device: 'RDP-01', brief: 'needs approval, then stop', wait: false });
        const mirror = deskAi.conversations.get(started.conversationId);
        await until(() => types(mirror).includes('approval-request'), 'waiting on a card');
        const stopped = await deskAi.interrupt(started.conversationId);
        assert.strictEqual(stopped.success, true);
        await until(() => types(mirror).includes('interrupted'), 'interrupted in the mirror');
    });

    await check('a device with tasks switched off says so', async () => {
        accept.on = false;
        const result = await deskTasks.start({ device: 'RDP-01', brief: 'x' });
        assert.match(result.error, /is locked: it does not take tasks/);
        accept.on = true;
    });

    await check('a conversation from the other device\'s list is fetched when opened, and goes on there', async () => {
        // One of RDP-01's own conversations, as sync lists it here.
        const { conversationId } = serverAi.create({ agentId: 'agent-1' });
        await serverAi.send(conversationId, 'local work on the server');
        const worked = serverAi.conversations.get(conversationId);
        await until(() => worked.events.some(event => event.type === 'result'), 'the local turn ended');
        const mirrorId = deskTasks.ensureMirror({ deviceId: server.selfId(), remoteCid: conversationId, title: 'Server work', agentId: 'agent-1' });
        assert.strictEqual(deskTasks.ensureMirror({ deviceId: server.selfId(), remoteCid: conversationId, title: 'Renamed' }), mirrorId, 'one mirror per conversation');
        const mirror = deskAi.conversations.get(mirrorId);
        assert.strictEqual(mirror.title, 'Renamed');
        assert.strictEqual(mirror.events.length, 0, 'nothing fetched until it is opened');
        deskAi.read(mirrorId);
        await until(() => mirror.events.length === worked.events.length, 'fetched on opening');
        await deskAi.send(mirrorId, 'carry on');
        await until(() => mirror.events.some(event => event.text === 'done: carry on'), 'the next turn streams in');
        deskTasks.dropMirror(server.selfId(), conversationId);
        assert.strictEqual(deskAi.conversations.has(mirrorId), false, 'gone when deleted over there');
    });

    await check('a locked device refuses to be written into, but still reads', async () => {
        const { conversationId } = serverAi.create({ agentId: 'agent-1' });
        await serverAi.send(conversationId, 'private work');
        const worked = serverAi.conversations.get(conversationId);
        await until(() => worked.events.some(event => event.type === 'result'), 'the local turn ended');
        const mirrorId = deskTasks.ensureMirror({ deviceId: server.selfId(), remoteCid: conversationId, title: 'Private' });
        accept.on = false;
        deskAi.read(mirrorId);
        const mirror = deskAi.conversations.get(mirrorId);
        await until(() => mirror.events.length === worked.events.length, 'read while locked');
        const sent = await deskAi.send(mirrorId, 'do something');
        assert.strictEqual(sent.success, false);
        assert.match(sent.message, /is locked/);
        accept.on = true;
    });

    /** A new process over there: a new boot id, its events numbered from one again. */
    const restartServer = (stored) => {
        for (const fn of [...serverAi.observers]) serverAi.observers.delete(fn);
        serverTasks = makeTasks(server, serverAi, { accept, stored });
        assert.ok(serverTasks);
    };

    await check('a worker that restarted is caught up by a full resync', async () => {
        restartServer(serverStore);
        const mirror = deskAi.conversations.get(mirrorId);
        const sent = await deskAi.send(mirrorId, 'after restart');
        assert.strictEqual(sent.success, true, sent.message);
        await until(() => mirror.replaced >= 1, 'the mirror resynced');
        await until(() => mirror.events.some(event => event.text === 'done: after restart'), 'the new turn in the mirror');
        const worked = serverAi.conversations.get(mirror.remote.conversationId);
        assert.strictEqual(mirror.events.length, worked.events.length);
    });

    await check('a worker restarted without its saved state still serves what it has', async () => {
        restartServer({ value: null });
        const sent = await deskAi.send(mirrorId, 'still there');
        assert.strictEqual(sent.success, true, sent.message);
    });

    await check('a conversation deleted over there fails cleanly', async () => {
        serverAi.conversations.delete(deskAi.conversations.get(mirrorId).remote.conversationId);
        const sent = await deskAi.send(mirrorId, 'anyone there');
        assert.strictEqual(sent.success, false);
        assert.match(sent.message, /not on this computer any more/);
    });

    await check('large events are cut to size on the way', () => {
        const big = { type: 'tool-result', output: 'x'.repeat(400 * 1024), images: [{ name: 'a.png', data: 'y'.repeat(300 * 1024) }] };
        const small = shrink(big, 'RDP-01');
        assert.ok(JSON.stringify(small).length < 64 * 1024);
        assert.match(small.output, /cut short on the way from RDP-01/);
        assert.strictEqual(small.images[0].name, 'a.png');
        assert.strictEqual(small.images[0].data, undefined);
    });

    desk.stop();
    server.stop();
    // Let the sockets close before the process goes: Node on Windows aborts
    // on a handle still closing at exit.
    await new Promise(resolve => setTimeout(resolve, 300));
    await hub.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(dir, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(process.exitCode || 0);
})();

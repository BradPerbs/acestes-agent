const crypto = require('crypto');

/**
 * Tasks across devices: the agent here asking another of the user's computers
 * to do something, and watching it happen.
 *
 * Two sides, both in every install:
 *
 *   The device doing the work runs it as an ordinary conversation of its own
 *   agent, in that agent's own approval mode, and in its own list (so
 *   someone at that machine sees it too). Every event the conversation
 *   records goes back to the device that asked, numbered, through the
 *   relay's mailbox, so one that was off when it happened gets it later.
 *
 *   The device that asked keeps a mirror (`createMirror` in ai/index.js): a
 *   conversation with no runtime, whose events are the other device's. Its
 *   tab works like any other. A message typed there, stop, and the answer
 *   to an approval or a question go to the device doing the work, and the
 *   card settles on both, whichever side answered first.
 *
 * A number out of step (the other device restarted, or mail was dropped)
 * means the mirror has missed something, so it asks for the whole log again
 * and replaces its own. So does a mirror whose device comes back online.
 *
 * The same mirrors carry every device's conversation list: sync publishes
 * what each device runs, and the others hold a mirror of each
 * (`ensureMirror`), fetched the first time it is opened. Any device that
 * opens one becomes a watcher and gets its events from then on. A locked
 * device's conversations still read on the others; nothing is sent into
 * them, stopped, or answered from elsewhere.
 *
 * Wire kinds: task.start, task.event, task.send, task.stop, task.answer,
 * task.history. Everything rides on device.js's sealed request and reply.
 */

const TURN_ENDS = new Set(['result', 'error', 'interrupted']);
const ORPHAN_MS = 60 * 1000;
const EVENT_BUDGET = 200 * 1024;
const FIELD_CAP = 20 * 1024;
const DEFAULT_WAIT_MS = 30 * 60 * 1000;

/** An event small enough to cross: long strings cut, pictures by name only. */
function shrink(event, deviceName) {
    if (JSON.stringify(event).length <= EVENT_BUDGET) return event;
    const note = `\n… (cut short on the way from ${deviceName})`;
    const walk = (value, depth) => {
        if (typeof value === 'string') return value.length > FIELD_CAP ? value.slice(0, FIELD_CAP) + note : value;
        if (Array.isArray(value)) return value.slice(0, 200).map(item => walk(item, depth + 1));
        if (value && typeof value === 'object' && depth < 6) {
            const out = {};
            for (const [key, item] of Object.entries(value)) {
                if ((key === 'data' || key === 'base64') && typeof item === 'string') continue;
                out[key] = walk(item, depth + 1);
            }
            return out;
        }
        return value;
    };
    return walk(event, 0);
}

function createTasks({ device, ai, persist, accepts = () => true, now = () => Date.now() }) {
    const boot = crypto.randomBytes(6).toString('base64url');
    const saved = persist.load() || {};

    // This side doing the work: conversation id -> the devices watching it.
    // A task's asker watches from the start; any device that opens the
    // conversation from its own list joins them.
    const served = new Map(Object.entries(saved.served || {}).map(([cid, entry]) => [
        cid,
        { watchers: new Set(Array.isArray(entry.watchers) ? entry.watchers : [entry.deviceId].filter(Boolean)), n: 0 },
    ]));
    // This side asking: mirror id -> the conversation it stands for.
    const mirrors = new Map(Object.entries(saved.mirrors || {}));
    const byRemote = new Map([...mirrors].map(([id, m]) => [`${m.deviceId}:${m.remoteCid}`, id]));
    const cards = new Map();
    const waiters = new Map();
    const lastSaid = new Map();
    const orphans = new Map();
    const resyncing = new Set();

    const save = () => persist.save({
        served: Object.fromEntries([...served].map(([cid, entry]) => [cid, { watchers: [...entry.watchers] }])),
        mirrors: Object.fromEntries(mirrors),
    });

    const selfName = () => device.deviceName(device.selfId());
    const lockedError = () => new Error(`${selfName()} is locked: it does not take tasks from other computers. It can be unlocked there, under Settings, Devices.`);

    /* ---------------- the device doing the work ---------------- */

    function resolveAgent(wanted) {
        const list = ai.agents();
        const text = String(wanted || '').trim().toLowerCase();
        if (!text) return list.find(agent => agent.id === ai.activeAgentId()) || list[0];
        return list.find(agent => agent.id === wanted || agent.name.toLowerCase() === text) || null;
    }

    function watch(cid, deviceId) {
        let entry = served.get(cid);
        if (!entry) {
            entry = { watchers: new Set(), n: 0 };
            served.set(cid, entry);
        }
        if (!entry.watchers.has(deviceId)) {
            entry.watchers.add(deviceId);
            save();
        }
        return entry;
    }

    device.on('task.start', async (data, meta) => {
        if (!accepts()) throw lockedError();
        const brief = String(data.brief || '').trim();
        if (!brief) throw new Error('The task is empty.');
        const agent = resolveAgent(data.agent);
        if (!agent) throw new Error(`There is no agent called "${data.agent}" on ${selfName()}.`);
        const { conversationId } = ai.create({ agentId: agent.id });
        watch(conversationId, meta.from);
        const sent = await ai.send(conversationId, brief);
        if (!sent?.success) {
            served.delete(conversationId);
            save();
            throw new Error(sent?.message || 'The task could not start.');
        }
        return { conversationId, agent: agent.name, boot };
    });

    ai.observe((event, info) => {
        const entry = served.get(info.conversationId);
        if (!entry || entry.watchers.size === 0) return;
        entry.n += 1;
        const data = { cid: info.conversationId, boot, n: entry.n, event: shrink(event, selfName()) };
        for (const watcher of entry.watchers) device.send(watcher, 'task.event', data);
    });

    /** A conversation run here, which another device may read, or write into when not locked. */
    const local = (cid) => {
        if (!cid || !ai.has(cid) || ai.remoteOf(cid)) throw new Error('That conversation is not on this computer any more.');
        return cid;
    };

    device.on('task.send', async (data, meta) => {
        if (!accepts()) throw lockedError();
        const cid = local(String(data.cid || ''));
        watch(cid, meta.from);
        const sent = await ai.send(cid, String(data.text || ''));
        if (!sent?.success) throw new Error(sent?.message || 'The message did not go.');
        return { success: true };
    });

    device.on('task.stop', async (data, meta) => {
        if (!accepts()) throw lockedError();
        const cid = local(String(data.cid || ''));
        watch(cid, meta.from);
        await ai.interrupt(cid);
        return { success: true };
    });

    device.on('task.answer', async (data) => {
        if (!accepts()) throw lockedError();
        if (data.kind === 'approval') {
            return ai.respondToApproval({ requestId: String(data.requestId || ''), approved: Boolean(data.approved), message: String(data.message || '') });
        }
        return ai.respondToQuestion({ requestId: String(data.requestId || ''), answer: String(data.answer || ''), chosen: Boolean(data.chosen) });
    });

    // Reading is not doing: a locked device's conversations still read on the others.
    device.on('task.history', async (data, meta) => {
        const cid = local(String(data.cid || ''));
        const entry = watch(cid, meta.from);
        const history = ai.history(cid);
        const name = selfName();
        return {
            boot,
            n: entry.n,
            busy: Boolean(history.busy),
            events: (history.events || []).map(event => shrink(event, name)),
        };
    });

    /* ---------------- the device that asked ---------------- */

    function settleWaiters(mirrorId, outcome) {
        const set = waiters.get(mirrorId);
        if (!set) return;
        waiters.delete(mirrorId);
        for (const resolve of set) resolve(outcome);
    }

    function noteEvent(mirrorId, event) {
        if (event.type === 'approval-request' || event.type === 'question-request') cards.set(event.requestId, mirrorId);
        if (event.type === 'approval-settled' || event.type === 'question-settled') cards.delete(event.requestId);
        if (event.type === 'user-message') {
            lastSaid.set(mirrorId, '');
            const m = mirrors.get(mirrorId);
            if (m) m.done = false;
        }
        if (event.type === 'assistant-text' && event.text && !event.parentId) lastSaid.set(mirrorId, String(event.text).slice(0, 4000));
        if (TURN_ENDS.has(event.type)) {
            const m = mirrors.get(mirrorId);
            const status = event.type === 'result' ? 'done' : event.type === 'interrupted' ? 'cancelled' : 'failed';
            if (m) m.done = status;
            settleWaiters(mirrorId, { status, summary: lastSaid.get(mirrorId) || '', reason: event.type === 'error' ? event.message || '' : '' });
        }
    }

    async function resync(mirrorId) {
        const m = mirrors.get(mirrorId);
        if (!m || resyncing.has(mirrorId) || !device.isOnline(m.deviceId)) return;
        resyncing.add(mirrorId);
        try {
            const reply = await device.request(m.deviceId, 'task.history', { cid: m.remoteCid }, { timeout: 60000 });
            ai.replaceRemoteEvents(mirrorId, reply.events || [], reply.busy);
            m.boot = reply.boot;
            m.n = reply.n;
            m.fetched = true;
            for (const event of reply.events || []) noteEvent(mirrorId, event);
            if (!reply.busy && !m.done) m.done = 'done';
            save();
        } catch (error) {
            // Gone on that side (deleted, or the app was reinstalled): the mirror keeps what it has.
            console.error('Could not bring a remote task up to date:', error.message);
        } finally {
            resyncing.delete(mirrorId);
        }
    }

    function receive(mirrorId, data) {
        const m = mirrors.get(mirrorId);
        if (m.boot === data.boot && data.n <= m.n) return;
        if (m.boot !== data.boot || data.n !== m.n + 1) {
            if (m.boot === undefined && data.n === 1) {
                m.boot = data.boot;
            } else {
                resync(mirrorId);
                return;
            }
        }
        m.n = data.n;
        ai.ingestRemote(mirrorId, data.event);
        noteEvent(mirrorId, data.event);
        save();
    }

    device.on('task.event', async (data, meta) => {
        const mirrorId = byRemote.get(`${meta.from}:${data.cid}`);
        if (!mirrorId) {
            // Ahead of the reply to task.start, sometimes: held until the mirror exists.
            const key = `${meta.from}:${data.cid}`;
            if (!orphans.has(key)) orphans.set(key, { at: now(), items: [] });
            orphans.get(key).items.push(data);
            for (const [other, held] of orphans) if (now() - held.at > ORPHAN_MS) orphans.delete(other);
            return true;
        }
        receive(mirrorId, data);
        return true;
    });

    device.onArrival((deviceId) => {
        for (const [mirrorId, m] of mirrors) {
            if (m.deviceId === deviceId && m.fetched !== false && m.done !== 'done') resync(mirrorId);
        }
    });

    const offline = (m) => `${device.deviceName(m.deviceId)} is offline. The task carries on there; this tab catches up when it is back.`;

    /**
     * A conversation another device runs, listed here from sync (see the
     * conversations collection in fleet/index.js): a mirror whose messages
     * are fetched the first time it is opened. One made by a task keeps the
     * title it was given here.
     */
    function ensureMirror({ deviceId, remoteCid, title = '', agentId = '', createdAt = 0, updatedAt = 0, messages = 0 }) {
        const key = `${deviceId}:${remoteCid}`;
        const deviceName = device.deviceName(deviceId);
        const existing = byRemote.get(key);
        if (existing && mirrors.has(existing) && ai.has(existing)) {
            const m = mirrors.get(existing);
            ai.updateMirror(existing, { ...(m.source === 'index' ? { title } : {}), updatedAt, messages, deviceName });
            return existing;
        }
        const mirrorId = ai.createMirror({
            agentId,
            title,
            remote: { deviceId, deviceName, conversationId: remoteCid },
            createdAt,
            updatedAt,
            messages,
        });
        mirrors.set(mirrorId, { deviceId, remoteCid, boot: undefined, n: 0, done: 'done', source: 'index', fetched: false });
        byRemote.set(key, mirrorId);
        save();
        return mirrorId;
    }

    /** The conversation was deleted where it runs: its mirror goes too. */
    function dropMirror(deviceId, remoteCid) {
        const key = `${deviceId}:${remoteCid}`;
        const mirrorId = byRemote.get(key);
        byRemote.delete(key);
        if (!mirrorId) return;
        mirrors.delete(mirrorId);
        save();
        Promise.resolve(ai.close(mirrorId)).catch(() => {});
    }

    ai.setRemoteBridge({
        /** A mirror being read: fetch its messages the first time. */
        opened(conversation) {
            const m = mirrors.get(conversation.id);
            if (m && !m.fetched) resync(conversation.id);
        },
        async send(conversation, text) {
            const m = mirrors.get(conversation.id);
            if (!m) return { success: false, message: 'This mirror lost track of its task.' };
            if (!device.isOnline(m.deviceId)) return { success: false, message: offline(m) };
            try {
                await device.request(m.deviceId, 'task.send', { cid: m.remoteCid, text }, { timeout: 30000 });
                return { success: true };
            } catch (error) {
                return { success: false, message: error.message };
            }
        },
        async interrupt(conversation) {
            const m = mirrors.get(conversation.id);
            if (!m || !device.isOnline(m.deviceId)) return { success: false };
            try {
                await device.request(m.deviceId, 'task.stop', { cid: m.remoteCid }, { timeout: 30000 });
                return { success: true };
            } catch {
                return { success: false };
            }
        },
        answer(payload) {
            const mirrorId = cards.get(payload.requestId);
            const m = mirrorId ? mirrors.get(mirrorId) : null;
            if (!m) return false;
            device.request(m.deviceId, 'task.answer', payload, { timeout: 30000 })
                .catch(error => console.error('The answer did not reach the other computer:', error.message));
            return true;
        },
    });

    /** Find a device by id or name, case-insensitively, among the others. */
    function findDevice(ref) {
        const text = String(ref || '').trim().toLowerCase();
        const others = device.devices().filter(entry => !entry.self);
        return others.find(entry => entry.id === ref)
            || others.find(entry => entry.name.toLowerCase() === text)
            || others.find(entry => entry.name.toLowerCase().includes(text) && text.length >= 3)
            || null;
    }

    /**
     * Hand a task to another device. Resolves when it has started there, or
     * with `wait`, when its first turn ends, with what the agent there said.
     */
    async function start({ device: ref, brief, agent = '', title = '', agentId = '', near = '', open = true, wait = true, timeout = DEFAULT_WAIT_MS }) {
        const target = findDevice(ref);
        if (!target) {
            const names = device.devices().filter(entry => !entry.self).map(entry => entry.name);
            return { error: names.length ? `No device called "${ref}". The others are: ${names.join(', ')}.` : 'There are no other devices in the fleet.' };
        }
        if (!device.isOnline(target.id)) {
            return { error: `${target.name} is offline${target.seenAt ? ` (last seen ${new Date(target.seenAt).toISOString()})` : ''}.` };
        }
        let reply;
        try {
            reply = await device.request(target.id, 'task.start', { brief, agent, title }, { timeout: 60000 });
        } catch (error) {
            return { error: error.message };
        }
        const mirrorId = ai.createMirror({
            agentId,
            title: title || `${brief.replace(/\s+/g, ' ').slice(0, 60)} · ${target.name}`,
            remote: { deviceId: target.id, deviceName: target.name, conversationId: reply.conversationId },
        });
        mirrors.set(mirrorId, { deviceId: target.id, remoteCid: reply.conversationId, boot: reply.boot, n: 0, done: false, source: 'task', fetched: true });
        byRemote.set(`${target.id}:${reply.conversationId}`, mirrorId);
        save();
        const key = `${target.id}:${reply.conversationId}`;
        const held = orphans.get(key);
        orphans.delete(key);
        for (const data of (held?.items || []).sort((a, b) => a.n - b.n)) receive(mirrorId, data);

        const shown = open ? ai.showConversation(mirrorId, near) : { opened: false };
        const base = { conversationId: mirrorId, device: target.name, agent: reply.agent, opened: shown.opened };
        if (!wait) return { ...base, status: 'working' };

        const m = mirrors.get(mirrorId);
        if (m.done) return { ...base, status: m.done, report: lastSaid.get(mirrorId) || '' };
        const outcome = await new Promise((resolve) => {
            const timer = setTimeout(() => {
                waiters.get(mirrorId)?.delete(done);
                resolve({ status: 'working', summary: lastSaid.get(mirrorId) || '', reason: 'Still running when the wait ran out; it carries on.' });
            }, timeout);
            timer.unref?.();
            const done = (result) => {
                clearTimeout(timer);
                resolve(result);
            };
            if (!waiters.has(mirrorId)) waiters.set(mirrorId, new Set());
            waiters.get(mirrorId).add(done);
        });
        return { ...base, status: outcome.status, report: outcome.summary, ...(outcome.reason ? { reason: outcome.reason } : {}) };
    }

    return { start, findDevice, isMirror: id => mirrors.has(id), ensureMirror, dropMirror };
}

module.exports = { createTasks, shrink };

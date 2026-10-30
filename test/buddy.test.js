/**
 * The buddy (src/main/ai/buddy.js): Ctrl+Alt held anywhere, the agent told
 * what was said with a picture of where the pointer is, and its turn drawn
 * beside the cursor and in the notch.
 *
 * `electron` is stubbed with windows that record what they are sent and a
 * screen with two displays; the agent and the computer are stand-ins that
 * record what the buddy asks of them. Then computer.js's half, against the
 * fake helper: push to talk is armed and its events come through, and the
 * picture with the pointer becomes the conversation's latest screenshot.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const windows = [];
class FakeWindow {
    constructor(options) {
        this.options = options;
        this.calls = [];
        this.sent = [];
        this.destroyed = false;
        this.handlers = {};
        this.webContents = {
            send: (channel, payload) => this.sent.push({ channel, payload: JSON.parse(JSON.stringify(payload ?? null)) }),
            setWindowOpenHandler: () => {},
            on: () => {},
        };
        windows.push(this);
    }
    setAlwaysOnTop(...args) { this.calls.push(['setAlwaysOnTop', ...args]); }
    setIgnoreMouseEvents(...args) { this.calls.push(['setIgnoreMouseEvents', ...args]); }
    setContentProtection(...args) { this.calls.push(['setContentProtection', ...args]); }
    once(name, handler) { this.handlers[name] = handler; }
    loadURL(url) { this.url = url; }
    isDestroyed() { return this.destroyed; }
    showInactive() { this.shown = true; }
    setBounds(bounds) { this.bounds = bounds; }
    destroy() { this.destroyed = true; }
    last(channel) { return [...this.sent].reverse().find(entry => entry.channel === channel)?.payload; }
}

let cursor = { x: 600, y: 400 };
const DISPLAYS = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 1024 } },
];
const electronStub = {
    BrowserWindow: FakeWindow,
    screen: {
        getAllDisplays: () => DISPLAYS,
        getPrimaryDisplay: () => DISPLAYS[0],
        getCursorScreenPoint: () => cursor,
        getDisplayNearestPoint: point => DISPLAYS.find(display => point.x >= display.bounds.x && point.x < display.bounds.x + display.bounds.width) || DISPLAYS[0],
        // A desk at 150%: physical pixels are DIPs times one and a half.
        dipToScreenPoint: point => ({ x: point.x * 1.5, y: point.y * 1.5 }),
        screenToDipPoint: point => ({ x: point.x / 1.5, y: point.y / 1.5 }),
        on: () => {},
    },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const buddy = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'buddy'));

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

let failures = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  ok  ${name}`);
    } catch (error) {
        failures += 1;
        console.log(`  FAIL ${name}\n       ${error.stack}`);
    }
}

/* What the buddy asks of the agent and the computer, recorded. */
const asked = [];
let settingsNow = { buddy: true, buddyNotch: true, buddySpeak: true, buddyAgent: '', voiceInput: true, voiceEngine: 'parakeet', computerUse: true };
let observer = null;
const busy = new Set();
let made = 0;
const ai = {
    create: (target) => {
        made += 1;
        asked.push(['create', target]);
        return { conversationId: `conv-${made}` };
    },
    startOnPick: id => asked.push(['startOnPick', id]),
    warm: async id => asked.push(['warm', id]),
    has: () => true,
    isBusy: id => busy.has(id),
    send: async (...args) => {
        asked.push(['send', ...args]);
        return { success: true };
    },
    steer: async (...args) => {
        asked.push(['steer', ...args]);
        return { success: true, steered: true };
    },
    observe: (fn) => {
        observer = fn;
        return () => { observer = null; };
    },
};
const frames = new Map();
const computer = {
    pushToTalk: async (mods, options) => {
        asked.push(['pushToTalk', mods, ...(options ? [options] : [])]);
        return { ok: true };
    },
    look: async () => {
        asked.push(['look']);
        return {
            ok: true,
            image: { name: 'screen.jpg', mediaType: 'image/jpeg', data: '/9j/' },
            width: 1000,
            height: 500,
            pointer: [300, 200],
            frame: { hwnd: 0, screen: true, region: [0, 0, 2000, 1000], scale: 0.5, width: 1000, height: 500, mode: 'image' },
        };
    },
    seed: (id, frame) => {
        asked.push(['seed', id]);
        frames.set(id, frame);
    },
    frameToScreen: (id, x, y) => {
        const frame = frames.get(id);
        return frame ? { x: frame.region[0] + x / frame.scale, y: frame.region[1] + y / frame.scale } : null;
    },
    screenToFrame: (id, x, y) => {
        const frame = frames.get(id);
        return frame ? { x: Math.round(x * frame.scale), y: Math.round(y * frame.scale) } : null;
    },
};
let locked = false;
buddy.configure({
    ai,
    computer,
    settings: { get: () => settingsNow },
    isLocked: () => locked,
    urlOf: () => 'http://localhost:5173/',
});
buddy._test.setPlatform('win32');

const state = () => buddy._test.state();
const said = name => asked.filter(entry => entry[0] === name);
/** Every window says it is ready, as each renderer does once it is listening. */
const allReady = () => windows.forEach(window => buddy.ready(window.webContents));
/** The window that was told to listen, and what it was told last. */
const listener = () => windows.find(window => window.sent.some(entry => entry.channel === 'buddy-listen'));
const emit = (event, info = {}) => observer?.(event, { conversationId: buddy.conversation(), remembering: false, ...info });

async function main() {
    console.log('buddy');

    await test('switched on, it has a click-through window per display and watches Ctrl+Alt', async () => {
        await buddy.sync();
        assert.strictEqual(buddy.isOn(), true);
        assert.strictEqual(windows.length, 2);
        for (const window of windows) {
            assert.strictEqual(window.options.focusable, false);
            assert.strictEqual(window.options.transparent, true);
            assert.ok(window.calls.some(call => call[0] === 'setIgnoreMouseEvents' && call[1] === true));
            assert.ok(window.calls.some(call => call[0] === 'setContentProtection' && call[1] === true));
            assert.ok(window.calls.some(call => call[0] === 'setAlwaysOnTop' && call[2] === 'screen-saver'));
        }
        assert.ok(windows[0].url.endsWith('#buddy=1'));
        assert.ok(windows[1].url.endsWith('#buddy=2'));
        // With Space as the switch key: Ctrl+Alt+Space, the next agent.
        assert.deepStrictEqual(said('pushToTalk').pop(), ['pushToTalk', 'ctrl+alt', { next: 'space' }]);
        allReady();
        assert.deepStrictEqual(windows[0].last('buddy-hello'), { displayId: 1, bounds: DISPLAYS[0].bounds, primary: true });
        assert.strictEqual(windows[1].last('buddy-hello').primary, false);
        assert.strictEqual(windows[0].last('buddy-state').phase, 'idle');
    });

    await test('holding the chord listens in the window under the cursor, and warms a conversation', async () => {
        cursor = { x: 2400, y: 300 };
        buddy.onPtt({ state: 'down', seq: 1 });
        assert.strictEqual(state().phase, 'listening');
        assert.strictEqual(state().mode, 'ask');
        assert.strictEqual(listener(), windows[1]);
        assert.strictEqual(windows[1].last('buddy-listen').action, 'start');
        assert.strictEqual(windows[1].last('buddy-listen').live, true);
        assert.deepStrictEqual(said('create').pop(), ['create', { agentId: '', scope: 'global' }]);
        assert.ok(said('warm').length === 1);
        assert.ok(buddy.owns('conv-1'));
    });

    await test('words so far are shown; letting go stops listening and looks at the screen', async () => {
        buddy.heard(windows[1].webContents, { text: 'click the', final: false });
        assert.strictEqual(state().heard, 'click the');
        await wait(260);
        buddy.onPtt({ state: 'up', seq: 2 });
        assert.strictEqual(windows[1].last('buddy-listen').action, 'stop');
        assert.strictEqual(state().phase, 'hearing');
        assert.strictEqual(said('look').length, 1);
    });

    await test('what was said goes to the agent with the picture, briefed the first time', async () => {
        buddy.heard(windows[1].webContents, { text: 'click the save button', final: true });
        await wait(10);
        const [, id, text, images, , , options] = said('send').pop();
        assert.strictEqual(id, 'conv-1');
        assert.strictEqual(text, 'click the save button');
        assert.strictEqual(images.length, 1);
        assert.strictEqual(images[0].mediaType, 'image/jpeg');
        assert.strictEqual(options.spoken, true);
        assert.ok(options.note.includes('held Ctrl+Alt'));
        assert.ok(options.note.includes('(300, 200)'));
        assert.ok(options.note.includes('1000x500'));
        assert.ok(options.note.includes('[POINT:x,y:label]'));
        assert.deepStrictEqual(said('seed').pop(), ['seed', 'conv-1']);
        assert.strictEqual(state().phase, 'thinking');
    });

    await test('the turn is drawn as it goes: acting, aimed, and the reply read out with its point', async () => {
        busy.add('conv-1');
        emit({ type: 'user-message', text: 'click the save button' });
        emit({ type: 'assistant-text', text: 'Let me look.' });
        emit({ type: 'tool-call', name: 'click', input: { x: 120, y: 40 } });
        assert.strictEqual(state().phase, 'acting');
        assert.strictEqual(state().action.name, 'click');
        assert.strictEqual(state().said, 'Let me look.');
        buddy.aimed('conv-1', 'button "Save"');
        assert.strictEqual(state().action.aim, 'button "Save"');
        emit({ type: 'tool-result', name: 'click' });
        assert.strictEqual(state().phase, 'thinking');
        emit({ type: 'assistant-text', text: 'Saved it. The **export** is up here. [POINT:400,100:export]' });
        busy.delete('conv-1');
        emit({ type: 'result', subtype: 'success' });
        assert.strictEqual(state().phase, 'speaking');
        assert.strictEqual(state().reply, 'Saved it. The **export** is up here.');
        assert.strictEqual(state().say.text, 'Saved it. The export is up here.');
        assert.strictEqual(state().say.engine, 'system');
        assert.strictEqual(state().recap, 'Saved it. The export is up here.');
        // 400,100 in a half-size picture is 800,200 on the screen, 533,133 in DIPs at 150%.
        assert.deepStrictEqual({ x: state().point.x, y: state().point.y, label: state().point.label }, { x: 533, y: 133, label: 'export' });
        buddy.spoke(windows[0].webContents, { id: state().say.id });
        assert.strictEqual(state().phase, 'done');
    });

    await test('a subagent\'s work, the note-taking turn and other conversations are not drawn', async () => {
        emit({ type: 'tool-call', name: 'click', parentId: 'sub-1' });
        emit({ type: 'tool-call', name: 'remember' }, { remembering: true });
        emit({ type: 'tool-call', name: 'click' }, { conversationId: 'conv-other' });
        assert.strictEqual(state().phase, 'done');
    });

    await test('asked again, it carries on in the same conversation with a short note', async () => {
        buddy.onPtt({ state: 'down', seq: 3 });
        assert.strictEqual(said('create').length, 1);
        await wait(260);
        buddy.onPtt({ state: 'up', seq: 4 });
        buddy.heard(listener().webContents, { text: 'now the next one', final: true });
        await wait(10);
        const [, id, , , , , options] = said('send').pop();
        assert.strictEqual(id, 'conv-1');
        assert.ok(options.note.startsWith('Said through the buddy again'));
        assert.ok(!options.note.includes('How to work'));
    });

    await test('spoken to while it works, what is said steers the turn with where the pointer is', async () => {
        busy.add('conv-1');
        cursor = { x: 400, y: 200 };
        const sends = said('send').length;
        buddy.onPtt({ state: 'down', seq: 5 });
        assert.strictEqual(state().mode, 'steer');
        await wait(260);
        buddy.onPtt({ state: 'up', seq: 6 });
        // No picture for a steer: the agent takes its own.
        assert.strictEqual(said('look').length, 2);
        buddy.heard(listener().webContents, { text: 'no, that one', final: true });
        await wait(10);
        assert.strictEqual(said('send').length, sends);
        // 400,200 DIPs is 600,300 physical, 300,150 in the half-size picture.
        assert.deepStrictEqual(said('steer').pop(), ['steer', 'conv-1', 'no, that one (pointing at 300,150 in your latest screenshot)']);
        busy.delete('conv-1');
    });

    await test('a shortcut after all (Ctrl+Alt+T) throws the recording away and sends nothing', async () => {
        const sends = said('send').length;
        buddy.onPtt({ state: 'down', seq: 7 });
        buddy.onPtt({ state: 'cancel', seq: 8 });
        assert.strictEqual(listener().last('buddy-listen').action, 'cancel');
        assert.strictEqual(state().phase, 'idle');
        buddy.heard(listener().webContents, { text: '', final: true });
        assert.strictEqual(said('send').length, sends);
    });

    await test('events out of order are put right by their numbers', async () => {
        buddy.onPtt({ state: 'up', seq: 8 });
        buddy.onPtt({ state: 'down', seq: 3 });
        assert.strictEqual(state().phase, 'idle');
    });

    await test('nothing heard after a real hold says so; after a slip of the hand it does not', async () => {
        buddy.onPtt({ state: 'down', seq: 9 });
        await wait(260);
        buddy.onPtt({ state: 'up', seq: 10 });
        buddy.heard(listener().webContents, { text: '', final: true });
        buddy.heard(listener().webContents, { notice: 'Nothing was heard.' });
        assert.strictEqual(state().phase, 'notice');
        assert.strictEqual(state().notice, 'Nothing was heard.');

        buddy.onPtt({ state: 'down', seq: 11 });
        buddy.onPtt({ state: 'up', seq: 12 });
        buddy.heard(listener().webContents, { text: '', final: true });
        buddy.heard(listener().webContents, { notice: 'Nothing was heard.' });
        assert.notStrictEqual(state().phase, 'notice');
    });

    await test('no microphone while listening ends it and says why', async () => {
        buddy.onPtt({ state: 'down', seq: 13 });
        buddy.heard(listener().webContents, { notice: 'No microphone was found.' });
        assert.strictEqual(listener().last('buddy-listen').action, 'cancel');
        assert.strictEqual(state().notice, 'No microphone was found.');
        buddy.onPtt({ state: 'up', seq: 14 });
        assert.strictEqual(state().phase, 'notice');
    });

    await test('locked, or with voice input off, it says so and does not listen', async () => {
        locked = true;
        buddy.onPtt({ state: 'down', seq: 15 });
        assert.strictEqual(state().phase, 'notice');
        assert.ok(/locked/i.test(state().notice));
        locked = false;
        buddy.onPtt({ state: 'up', seq: 16 });
        settingsNow = { ...settingsNow, voiceInput: false };
        buddy.onPtt({ state: 'down', seq: 17 });
        assert.ok(/Voice input/.test(state().notice));
        settingsNow = { ...settingsNow, voiceInput: true };
        buddy.onPtt({ state: 'up', seq: 18 });
    });

    await test('a question it stands on is shown and said aloud, and the failure of a turn said', async () => {
        busy.add('conv-1');
        emit({ type: 'question-request', question: 'Which file?', options: ['a.txt', 'b.txt'] });
        assert.strictEqual(state().phase, 'waiting');
        assert.deepStrictEqual(state().ask, { question: 'Which file?', options: ['a.txt', 'b.txt'] });
        assert.strictEqual(state().say.text, 'Which file? a.txt or b.txt?');
        emit({ type: 'question-settled' });
        assert.strictEqual(state().ask, null);
        busy.delete('conv-1');
        emit({ type: 'error', message: 'The model is overloaded.' });
        assert.strictEqual(state().phase, 'notice');
        assert.strictEqual(state().notice, 'The model is overloaded.');
    });

    await test('the hand on the mouse is shown as paused', async () => {
        buddy.held(['conv-1'], 'took-over');
        assert.strictEqual(state().held, 'took-over');
        buddy.held(['conv-other'], 'escape');
        assert.strictEqual(state().held, 'took-over');
    });

    await test('a reply\'s point and say tags are read, and what is spoken is plain', () => {
        const { readTags, speakable } = buddy._test;
        assert.deepStrictEqual(readTags('Over here. [POINT:12,34:save button]'), { body: 'Over here.', point: { x: 12, y: 34, label: 'save button' }, recap: '' });
        assert.deepStrictEqual(readTags('Nothing to show. [POINT:none]'), { body: 'Nothing to show.', point: null, recap: '' });
        assert.deepStrictEqual(readTags('On the other one [POINT:5,6:terminal:screen2]').point, { x: 5, y: 6, label: 'terminal' });
        assert.deepStrictEqual(
            readTags('I went through all twelve rows.\n\n[SAY: Marked the two November invoices as sent.]\n[POINT:4,5:export]'),
            { body: 'I went through all twelve rows.', point: { x: 4, y: 5, label: 'export' }, recap: 'Marked the two November invoices as sent.' },
        );
        assert.strictEqual(speakable('Run `npm test`, see [the docs](https://x.y) or https://a.b\n- one\n- two'), 'Run npm test, see the docs or the link one two');
    });

    await test('what is said aloud is a recap: the agent\'s own, else the first sentence or two', () => {
        const { recapOf, questionWords } = buddy._test;
        assert.strictEqual(recapOf('A long reply. With **detail**.', 'Done, both invoices are sent.'), 'Done, both invoices are sent.');
        assert.strictEqual(recapOf('Short and done.', ''), 'Short and done.');
        const long = 'I opened the billing page and filtered to unpaid. There were two due in November. '
            + 'I marked both as sent, then checked the totals against the ledger, which matched to the cent, '
            + 'and I also noticed a duplicate customer record you may want to merge later.';
        const recap = recapOf(long, '');
        assert.strictEqual(recap, 'I opened the billing page and filtered to unpaid. There were two due in November.');
        const runOn = `${'word '.repeat(80)}end`;
        assert.ok(recapOf(runOn, '').length <= 161);
        assert.strictEqual(questionWords({ question: 'Which file?', options: ['a.txt', 'b.txt'] }), 'Which file? a.txt or b.txt?');
        assert.strictEqual(questionWords({ question: 'Go on?', options: [] }), 'Go on?');
    });

    /* The ElevenLabs voice: the key from the keychain, the audio streamed to the main display's window. */
    const streams = [];
    let ttsFails = '';
    const fakeTts = {
        RATE: 24000,
        stream: async ({ key, text, voiceId, model, signal, onAudio }) => {
            streams.push({ key, text, voiceId, model, signal });
            if (ttsFails) throw new Error(ttsFails);
            onAudio(new Uint8Array([1, 2, 3]));
            await wait(30);
            if (signal.aborted) throw new Error('aborted');
            onAudio(new Uint8Array([4, 5]));
            return { rate: 24000, bytes: 5 };
        },
        voices: async () => ({ voices: [{ id: 'voiceAAAAAAAA', name: 'Eldrin', category: 'premade' }] }),
    };
    let keychain = {};
    buddy.configure({ tts: fakeTts, secrets: { read: name => keychain[name] || '', has: name => Boolean(keychain[name]) } });

    await test('with ElevenLabs and a key, the recap streams to the main display\'s window', async () => {
        keychain = { elevenlabs: 'sk_test' };
        settingsNow = { ...settingsNow, buddyVoice: 'elevenlabs', buddyVoiceModel: 'eleven_v4', buddyVoiceId: 'voiceBBBBBBBB' };
        await buddy.sync();
        assert.strictEqual(buddy.status().voiceKey, true);
        windows[0].sent.length = 0;
        busy.add('conv-1');
        emit({ type: 'user-message', text: 'mark them' });
        emit({ type: 'assistant-text', text: 'Long details here.\n[SAY: Both invoices are marked as sent.]' });
        busy.delete('conv-1');
        emit({ type: 'result', subtype: 'success' });
        assert.strictEqual(state().say.engine, 'elevenlabs');
        assert.strictEqual(state().say.text, 'Both invoices are marked as sent.');
        assert.strictEqual(state().recap, 'Both invoices are marked as sent.');
        assert.strictEqual(state().reply, 'Long details here.');
        await wait(80);
        const last = streams[streams.length - 1];
        assert.deepStrictEqual({ key: last.key, text: last.text, voiceId: last.voiceId, model: last.model },
            { key: 'sk_test', text: 'Both invoices are marked as sent.', voiceId: 'voiceBBBBBBBB', model: 'eleven_v4' });
        const audio = windows[0].sent.filter(entry => entry.channel === 'buddy-audio').map(entry => entry.payload);
        assert.strictEqual(audio.length, 3);
        assert.ok(audio.every(message => message.id === state().say.id));
        assert.ok(audio[0].chunk && audio[1].chunk && audio[2].done);
        // The state naming the say went before its audio.
        const order = windows[0].sent.map(entry => entry.channel);
        assert.ok(order.lastIndexOf('buddy-state') < order.indexOf('buddy-audio'));
        buddy.spoke(windows[0].webContents, { id: state().say.id });
        assert.strictEqual(state().phase, 'done');
    });

    await test('talking over it stops ElevenLabs mid-sentence', async () => {
        busy.add('conv-1');
        emit({ type: 'question-request', question: 'Which one?', options: [] });
        // Started a tick after the state that names it, and half way through.
        await wait(5);
        const asked = streams[streams.length - 1];
        assert.strictEqual(asked.text, 'Which one?');
        buddy.onPtt({ state: 'down', seq: 100 });
        assert.strictEqual(asked.signal.aborted, true);
        assert.strictEqual(state().say, null);
        buddy.onPtt({ state: 'cancel', seq: 101 });
        emit({ type: 'question-settled' });
        busy.delete('conv-1');
    });

    await test('if ElevenLabs refuses, this computer\'s voice says it and the notch says why', async () => {
        ttsFails = 'Your ElevenLabs credits are used up.';
        windows[0].sent.length = 0;
        emit({ type: 'user-message', text: 'again' });
        emit({ type: 'assistant-text', text: 'Done.' });
        emit({ type: 'result', subtype: 'success' });
        await wait(20);
        const audio = windows[0].sent.filter(entry => entry.channel === 'buddy-audio').map(entry => entry.payload);
        assert.deepStrictEqual(audio, [{ id: state().say.id, error: 'Your ElevenLabs credits are used up.' }]);
        assert.strictEqual(state().say.engine, 'system');
        assert.strictEqual(state().say.trouble, 'Your ElevenLabs credits are used up.');
        ttsFails = '';
    });

    await test('with no key yet it falls back to this computer\'s voice, and says so', async () => {
        keychain = {};
        emit({ type: 'user-message', text: 'and again' });
        emit({ type: 'assistant-text', text: 'All set.' });
        emit({ type: 'result', subtype: 'success' });
        assert.strictEqual(state().say.engine, 'system');
        assert.ok(/No ElevenLabs key/.test(state().say.trouble));
        assert.strictEqual(buddy.status().voiceKey, false);
        settingsNow = { ...settingsNow, buddyVoice: 'system' };
    });

    await test('with speaking off, nothing is said', async () => {
        settingsNow = { ...settingsNow, buddySpeak: false };
        await buddy.sync();
        emit({ type: 'user-message', text: 'quiet' });
        emit({ type: 'assistant-text', text: 'Done quietly.' });
        emit({ type: 'result', subtype: 'success' });
        assert.strictEqual(state().say, null);
        assert.strictEqual(state().phase, 'done');
        assert.strictEqual(state().recap, 'Done quietly.');
        settingsNow = { ...settingsNow, buddySpeak: true };
        await buddy.sync();
    });

    /* Who it talks to: Ctrl+Alt+Space for the next agent, or a click on one in the notch. */
    const AGENTS = [
        { id: 'a1', name: 'Acestino', color: 'violet' },
        { id: 'a2', name: 'Codex', color: 'emerald' },
        { id: 'a3', name: 'Reader', color: 'sky' },
    ];
    const saved = [];
    const plainSettings = { get: () => settingsNow };
    buddy.configure({
        agents: { snapshot: () => ({ activeId: 'a1', agents: AGENTS }) },
        // As settings.js answers: one agent's view, else the buddy's (or the selected) one's.
        settings: { get: id => ({ ...settingsNow, agentId: id || settingsNow.buddyAgent || 'a1', computerUse: (id || settingsNow.buddyAgent || 'a1') !== 'a3' }) },
        setSettings: (patch) => {
            saved.push(patch);
            settingsNow = { ...settingsNow, ...patch };
        },
    });
    const live = () => windows.filter(window => !window.destroyed);

    await test('the agents are in the notch\'s state, with who it talks to and who may use the computer', async () => {
        await buddy.sync();
        assert.deepStrictEqual(state().agents.map(agent => agent.id), ['a1', 'a2', 'a3']);
        assert.strictEqual(state().agentId, 'a1');
        assert.deepStrictEqual(state().agents[2], { id: 'a3', name: 'Reader', color: 'sky', computerUse: false });
        assert.strictEqual(state().switchChord, 'Ctrl Alt Space');
    });

    await test('Ctrl+Alt+Space mid-sentence lets the words go, switches, saves it, and the next hold talks to the new agent afresh', async () => {
        cursor = { x: 600, y: 400 };
        // The last agent is still at work: a hold now would steer it.
        const old = buddy.conversation();
        busy.add(old);
        buddy.onPtt({ state: 'down', seq: 400 });
        assert.strictEqual(state().mode, 'steer');
        const before = state().switcher;
        buddy.onPtt({ state: 'next', seq: 401 });
        assert.strictEqual(listener().last('buddy-listen').action, 'cancel');
        assert.notStrictEqual(state().phase, 'listening');
        assert.strictEqual(state().agentId, 'a2');
        assert.strictEqual(state().switcher, before + 1);
        assert.deepStrictEqual(saved.pop(), { buddyAgent: 'a2' });
        // Its turn carries on, and is still the one drawn, until the next hold.
        assert.strictEqual(buddy.conversation(), old);
        const creates = said('create').length;
        buddy.onPtt({ state: 'down', seq: 402 });
        assert.strictEqual(state().mode, 'ask');
        assert.strictEqual(said('create').length, creates + 1);
        assert.deepStrictEqual(said('create').pop(), ['create', { agentId: 'a2', scope: 'global' }]);
        assert.notStrictEqual(buddy.conversation(), old);
        buddy.onPtt({ state: 'cancel', seq: 403 });
        busy.delete(old);
    });

    await test('pressed again it goes on round the list, back to the first', async () => {
        buddy.onPtt({ state: 'next', seq: 404 });
        assert.strictEqual(state().agentId, 'a3');
        buddy.onPtt({ state: 'next', seq: 405 });
        assert.strictEqual(state().agentId, 'a1');
        assert.deepStrictEqual(saved.slice(-2), [{ buddyAgent: 'a3' }, { buddyAgent: 'a1' }]);
    });

    await test('a click on an agent in the notch picks it; from anywhere else, or one not listed, nothing', () => {
        const notch = live()[0].webContents;
        assert.strictEqual(buddy.pick(notch, { agentId: 'a2' }), true);
        assert.strictEqual(state().agentId, 'a2');
        assert.strictEqual(buddy.pick({ send: () => {} }, { agentId: 'a3' }), false);
        assert.strictEqual(buddy.pick(notch, { agentId: 'nobody' }), false);
        assert.strictEqual(state().agentId, 'a2');
        // The one it already talks to: shown again, not saved again.
        const count = saved.length;
        assert.strictEqual(buddy.pick(notch, { agentId: 'a2' }), true);
        assert.strictEqual(saved.length, count);
    });

    await test('only the row of agents takes the mouse, only with the pointer on it, and not for long', async () => {
        const [main, other] = live();
        const mouse = window => window.calls.filter(call => call[0] === 'setIgnoreMouseEvents').map(call => call[1]);
        main.calls.length = 0;
        other.calls.length = 0;
        cursor = { x: 300, y: 600 };
        await wait(50);
        assert.strictEqual(buddy.hit(main.webContents, { x: 780, y: 40, width: 360, height: 30 }), true);
        assert.deepStrictEqual(mouse(main), [], 'the pointer is elsewhere: still click-through');
        cursor = { x: 900, y: 52 };
        await wait(60);
        assert.deepStrictEqual(mouse(main), [false]);
        cursor = { x: 900, y: 200 };
        await wait(60);
        assert.deepStrictEqual(mouse(main), [false, true]);
        // Gone from the notch while the pointer is on it: click-through at once.
        cursor = { x: 900, y: 52 };
        await wait(60);
        buddy.hit(main.webContents, null);
        assert.deepStrictEqual(mouse(main), [false, true, false, true]);
        // On the second display, in its own pixels.
        buddy.hit(other.webContents, { x: 10, y: 10, width: 60, height: 20 });
        cursor = { x: 1940, y: 20 };
        await wait(60);
        assert.deepStrictEqual(mouse(other), [false]);
        buddy.hit(other.webContents, null);
        assert.deepStrictEqual(mouse(other), [false, true]);
        // Not from a window of its own, nor a place that is no place.
        assert.strictEqual(buddy.hit({ send: () => {} }, { x: 0, y: 0, width: 10, height: 10 }), false);
        buddy.hit(main.webContents, { x: 0, y: 0, width: -5, height: 'x' });
        cursor = { x: 1, y: 1 };
        await wait(60);
        assert.deepStrictEqual(mouse(main), [false, true, false, true]);
    });

    await test('pointed at another agent in Settings, the next hold starts afresh with that one', async () => {
        settingsNow = { ...settingsNow, buddyAgent: 'a3' };
        await buddy.sync();
        assert.strictEqual(state().agentId, 'a3');
        buddy.onPtt({ state: 'down', seq: 406 });
        assert.deepStrictEqual(said('create').pop(), ['create', { agentId: 'a3', scope: 'global' }]);
        buddy.onPtt({ state: 'cancel', seq: 407 });
        settingsNow = { ...settingsNow, buddyAgent: '' };
        buddy.configure({ settings: plainSettings, agents: null, setSettings: null });
        await buddy.sync();
    });

    await test('switched off, its windows go and Ctrl+Alt is no longer watched', async () => {
        settingsNow = { ...settingsNow, buddy: false };
        await buddy.sync();
        assert.strictEqual(buddy.isOn(), false);
        assert.ok(windows.every(window => window.destroyed));
        assert.deepStrictEqual(said('pushToTalk').pop(), ['pushToTalk', '']);
        assert.strictEqual(observer, null);
    });

    await test('not on Windows, it stays off', async () => {
        buddy._test.setPlatform('linux');
        settingsNow = { ...settingsNow, buddy: true };
        const before = windows.length;
        await buddy.sync();
        assert.strictEqual(buddy.isOn(), false);
        assert.strictEqual(windows.length, before);
        buddy._test.setPlatform('win32');
        settingsNow = { ...settingsNow, buddy: false };
    });

    /* computer.js's half, against the fake helper. */
    console.log('computer: push to talk and the buddy\'s picture');
    const computer2 = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'computer'));
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acestes-buddy-')), 'helper.log');
    computer2._test.useHelper({ file: process.execPath, args: [path.join(__dirname, 'fixtures', 'fake-desktop-helper.js'), log] });
    computer2._test.setPlatform('win32');
    const events = [];
    computer2.configure({ ptt: message => events.push(message), hideFromCapture: () => {} });

    await test('push to talk is armed in the helper, and its events come through', async () => {
        const answer = await computer2.pushToTalk('ctrl+alt+test');
        assert.strictEqual(answer.ok, true);
        await wait(150);
        assert.deepStrictEqual(events.map(event => event.state), ['down', 'up']);
        const off = await computer2.pushToTalk('');
        assert.strictEqual(off.ok, true);
    });

    await test('a helper started afresh is armed again, switch key and all', async () => {
        await computer2.pushToTalk('ctrl+alt', { next: 'space' });
        const before = fs.readFileSync(log, 'utf8').split('\n').filter(line => line.includes('"ptt"')).length;
        process.kill(computer2._test.helperPid());
        // Started again a second after it went, which for a node stand-in
        // takes a moment more.
        for (let tries = 0; tries < 40; tries += 1) {
            await wait(100);
            const count = fs.readFileSync(log, 'utf8').split('\n').filter(line => line.includes('"ptt"')).length;
            if (count > before) break;
        }
        const lines = fs.readFileSync(log, 'utf8').split('\n').filter(line => line.includes('"ptt"'));
        assert.ok(lines.length > before, 'the new helper was told to watch the chord');
        assert.ok(lines[lines.length - 1].includes('"mods":"ctrl+alt"'));
        assert.ok(lines[lines.length - 1].includes('"next":"space"'), lines[lines.length - 1]);
        await computer2.pushToTalk('');
    });

    await test('the picture of the pointer\'s monitor becomes the latest screenshot', async () => {
        const look = await computer2.look();
        assert.strictEqual(look.ok, true);
        assert.strictEqual(look.image.mediaType, 'image/jpeg');
        assert.deepStrictEqual(look.pointer, [300, 200]);
        computer2.seed('conv-x', look.frame);
        assert.deepStrictEqual(computer2.frameToScreen('conv-x', 300, 200), { x: 600, y: 400 });
        assert.deepStrictEqual(computer2.screenToFrame('conv-x', 600, 400), { x: 300, y: 200, width: 1000, height: 500 });
        assert.strictEqual(computer2.screenToFrame('conv-x', 5000, 400), null);
        assert.strictEqual(computer2.frameToScreen('conv-none', 1, 1), null);
    });

    await test('push to talk is refused off Windows', async () => {
        computer2._test.setPlatform('darwin');
        const answer = await computer2.pushToTalk('ctrl+alt');
        assert.strictEqual(answer.ok, false);
        computer2._test.setPlatform('win32');
    });

    computer2.shutdown();

    /* elevenlabs.js against a stand-in for ElevenLabs' API. */
    console.log('elevenlabs');
    const elevenlabs = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'elevenlabs'));
    const calls = [];
    const streamBody = parts => new ReadableStream({
        start(controller) {
            for (const part of parts) controller.enqueue(new Uint8Array(part));
            controller.close();
        },
    });
    const reply = (status, body, parts) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        body: parts ? streamBody(parts) : null,
    });
    let answer = () => reply(200, {}, [[1, 2], [3, 4, 5]]);
    elevenlabs._test.useFetch(async (url, options = {}) => {
        calls.push({ url, options });
        // As a real free account lists them: a Voice Library voice first, which such an account may not use.
        if (url.includes('/v2/voices')) {
            return reply(200, {
                voices: [
                    { voice_id: 'libraryVoice1', name: 'Danilo', category: 'professional' },
                    { voice_id: 'ownVoice12345', name: 'Hades', category: 'generated' },
                    { voice_id: 'firstVoice123', name: 'Roger', category: 'premade' },
                    { voice_id: 'bad id', name: 'x' },
                ],
            });
        }
        return answer(url, options);
    });

    await test('it streams raw PCM from the stream endpoint, with the key, model and voice', async () => {
        const chunks = [];
        const result = await elevenlabs.stream({ key: 'sk_1', text: 'Both are sent.', voiceId: 'voiceBBBBBBBB', model: 'eleven_v4', onAudio: chunk => chunks.push([...chunk]) });
        const call = calls[calls.length - 1];
        assert.strictEqual(call.url, 'https://api.elevenlabs.io/v1/text-to-speech/voiceBBBBBBBB/stream?output_format=pcm_24000');
        assert.strictEqual(call.options.method, 'POST');
        assert.strictEqual(call.options.headers['xi-api-key'], 'sk_1');
        assert.deepStrictEqual(JSON.parse(call.options.body), { text: 'Both are sent.', model_id: 'eleven_v4' });
        assert.deepStrictEqual(chunks, [[1, 2], [3, 4, 5]]);
        assert.deepStrictEqual(result, { rate: 24000, bytes: 5 });
    });

    await test('with no voice picked it uses one any plan can, not a library voice; a model it does not know becomes v4', async () => {
        await elevenlabs.stream({ key: 'sk_1', text: 'Hi.', voiceId: '', model: 'eleven_v9', onAudio: () => {} });
        const call = calls[calls.length - 1];
        assert.ok(call.url.includes('/text-to-speech/firstVoice123/stream'));
        assert.strictEqual(JSON.parse(call.options.body).model_id, 'eleven_v4');
        const listed = await elevenlabs.voices('sk_1');
        assert.deepStrictEqual(listed.voices.map(voice => voice.id), ['firstVoice123', 'ownVoice12345', 'libraryVoice1']);
        assert.deepStrictEqual(listed.voices[0], { id: 'firstVoice123', name: 'Roger', category: 'premade' });
    });

    await test('its refusals are said plainly: a bad key, no credits, a plan without the model', async () => {
        const refused = async (status, detail) => {
            answer = () => reply(status, { detail });
            try {
                await elevenlabs.stream({ key: 'sk_1', text: 'x', voiceId: 'voiceBBBBBBBB', onAudio: () => {} });
                return 'no error';
            } catch (error) {
                return error.message;
            }
        };
        assert.ok(/refused the key/.test(await refused(401, { code: 'invalid_api_key', status: 'invalid_api_key' })));
        assert.ok(/credits are used up/.test(await refused(402, { code: 'insufficient_credits' })));
        // ElevenLabs' own answer when a free account asks for a library voice: a 402, but not about credits.
        const library = await refused(402, { type: 'payment_required', code: 'paid_plan_required', status: 'payment_required', message: 'Free users cannot use library voices via the API.' });
        assert.ok(/cannot use Voice Library voices/.test(library), library);
        assert.ok(!/credits/.test(library), library);
        assert.ok(/plan does not include/.test(await refused(403, { code: 'model_access_denied' })));
        assert.ok(/answered 422: field required/.test(await refused(422, [{ loc: ['body', 'text'], msg: 'field required', type: 'missing' }])));
        await assert.rejects(elevenlabs.stream({ key: '', text: 'x', onAudio: () => {} }), /no ElevenLabs key/);
        answer = () => reply(200, {}, [[1, 2]]);
    });

    buddy.shutdown();

    if (failures > 0) {
        console.log(`${failures} failing`);
        process.exit(1);
    }
    console.log('all passed');
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

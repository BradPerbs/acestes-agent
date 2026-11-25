/**
 * Cloud sandboxes on Spaceyard: starting one and pointing the computer tools
 * at it, the same tools acting there (numbers from a read, pixels from a
 * picture, a Windows sandbox's smaller pictures), secrets typed from the
 * sandbox's own variables and never sent as text, and the refusals. Run
 * against a stand-in for the Spaceyard API, so nothing here is billed.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-spaceyard-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', getAppPath: () => path.join(__dirname, '..'), on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable'); }, decryptString: () => { throw new Error('unavailable'); } },
    ipcMain: { handle: () => {}, on: () => {} },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const spaceyard = require(path.join(ROOT, 'ai', 'spaceyard'));
const tools = require(path.join(ROOT, 'ai', 'tools'));
const prompt = require(path.join(ROOT, 'ai', 'prompt'));

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

const API = 'https://api.spaceyard.dev/v1';

/** A Spaceyard that answers like the real one, keeping what it was asked. */
function fakeYard({ os: system = 'linux', screen = { width: 1280, height: 800 }, picture = null } = {}) {
    const calls = [];
    const overrides = [];
    const sandboxes = new Map();
    let made = 0;
    const reply = (status, body, headers = {}) => ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => headers[name.toLowerCase()] ?? null },
        json: async () => body,
    });
    const sandboxOf = (fields = {}) => ({
        uuid: 'sb-1',
        name: 'Acestes: Test chat',
        image: system === 'windows' ? 'Windows Server desktop' : 'Ubuntu 24.04 desktop',
        desktop: true,
        status: 'creating',
        os: system,
        hourly_price: 0.0377,
        stopped_hourly_price: 0.0017,
        billed_total: 0,
        env: [],
        ...fields,
    });
    const shot = () => picture || { width: screen.width, height: screen.height, format: 'jpeg', image: 'U0NSRUVO' };
    const nodes = system === 'windows'
        ? [
            { id: 4, d: 0, r: 'window', n: 'Notepad' },
            { id: 5, d: 1, r: 'edit', n: 'Text editor', v: 'hello', s: 'focused' },
        ]
        : [
            { n: 1, role: 'push button', name: 'OK', x: 100, y: 200, box: [90, 190, 20, 20] },
            { n: 2, role: 'entry', name: 'Search', value: 'abc', x: 300, y: 50, box: [200, 40, 200, 20], states: ['focused', 'editable'] },
            { n: 3, role: 'link', name: 'Sign in', box: [500, 60, 40, 10] },
            { n: 4, role: 'heading', name: 'Welcome back', x: 640, y: 120, box: [540, 110, 200, 20] },
            { n: 5, role: 'label', name: 'Password', x: 640, y: 300, box: [600, 290, 80, 20] },
            { n: 6, role: 'password text', name: 'Password', value: '(hidden)', x: 640, y: 330, box: [540, 320, 200, 20] },
            { n: 7, role: 'push button', name: 'Continue', x: 640, y: 380, box: [600, 370, 80, 20] },
        ];

    const computerAnswer = (body) => {
        const withShot = answer => (body.screenshot ? { ...answer, screenshot: shot() } : answer);
        switch (body.action) {
            case 'size': return { ok: true, ...screen };
            case 'screenshot': return { ok: true, ...shot() };
            case 'read_screen':
                return { ok: true, window: system === 'windows' ? { hwnd: 77, title: 'Notepad', process: 'notepad.exe' } : { title: 'Mozilla Firefox', app: 'Firefox', box: [0, 0, 1280, 800] }, nodes, truncated: false };
            case 'windows':
                return {
                    ok: true,
                    windows: system === 'windows'
                        ? [{ hwnd: 77, title: 'Notepad', process: 'notepad.exe', foreground: true }]
                        : [
                            { id: '0x01', desktop: -1, pid: 10, title: 'Desktop', active: false },
                            { id: '0x02', desktop: 0, pid: 20, title: 'Mozilla Firefox', active: true },
                        ],
                };
            case 'type': return withShot({ ok: true, typed: body.text ? body.text.length : 7 });
            case 'key': return withShot({ ok: true, pressed: body.keys });
            default: return withShot({ ok: true, x: body.x ?? 0, y: body.y ?? 0 });
        }
    };

    const fetch = async (url, init = {}) => {
        const route = url.replace(API, '');
        const body = init.body ? JSON.parse(init.body) : null;
        const call = { method: init.method, path: route, body, auth: init.headers?.Authorization };
        calls.push(call);
        for (const override of overrides) {
            const answer = override(call);
            if (answer) return answer;
        }
        if (route === '/sandboxes/images') {
            return reply(200, {
                data: [
                    { id: 2, name: 'Ubuntu desktop large', slug: 'ubuntu-large', os: 'linux', desktop: true, vcpu: 4, memory_mb: 8192, disk_gb: 32, hourly_price: 0.08, allowed: true, in_stock: true },
                    { id: 1, name: 'Ubuntu 24.04 desktop', slug: 'ubuntu-desktop', os: 'linux', desktop: true, vcpu: 2, memory_mb: 4096, disk_gb: 16, location: { name: 'Salt Lake City' }, hourly_price: 0.0377, allowed: true, in_stock: true },
                    { id: 3, name: 'Windows Server desktop', slug: 'windows-desktop', os: 'windows', desktop: true, vcpu: 2, memory_mb: 4096, disk_gb: 40, hourly_price: 0.09, allowed: false, in_stock: true },
                    { id: 4, name: 'Ubuntu server', slug: 'ubuntu', os: 'linux', desktop: false, vcpu: 1, memory_mb: 1024, disk_gb: 8, hourly_price: 0.01, allowed: true, in_stock: true },
                ],
                limits: { used: 0, max: 2, cpu: 4, memory_mb: 8192 },
                currency: 'EUR',
                lifecycle: { auto_stop_minutes: 15, auto_destroy_minutes: -1 },
            });
        }
        if (route === '/sandboxes' && init.method === 'GET') {
            return reply(200, { data: [...sandboxes.values()], meta: { used: sandboxes.size, max: 2 } });
        }
        if (route === '/sandboxes' && init.method === 'POST') {
            made += 1;
            const sandbox = sandboxOf({ name: body.name, env: Object.keys(body.env || {}), polls: 0 });
            sandboxes.set(sandbox.uuid, sandbox);
            return reply(201, { data: sandbox });
        }
        const match = route.match(/^\/sandboxes\/([^/]+)(?:\/(\w+))?$/);
        if (match) {
            const [, uuid, action] = match;
            const sandbox = sandboxes.get(uuid);
            if (!sandbox) return reply(404, { error: { code: 'NOT_FOUND', message: 'No such sandbox.' } });
            if (!action && init.method === 'GET') {
                sandbox.polls += 1;
                if (sandbox.status === 'creating' && sandbox.polls >= 2) sandbox.status = 'running';
                if (sandbox.status === 'starting') sandbox.status = 'running';
                return reply(200, { data: sandbox });
            }
            if (!action && init.method === 'DELETE') {
                sandbox.status = 'deleting';
                return reply(200, { data: sandbox });
            }
            if (action === 'start') {
                if (sandbox.status === 'stopped') sandbox.status = 'starting';
                return reply(200, { data: sandbox });
            }
            if (action === 'stop') {
                sandbox.status = 'stopped';
                return reply(200, { data: { ...sandbox, status: 'stopping' } });
            }
            if (action === 'exec') {
                return reply(200, { data: { finished: true, exit_code: 3, stdout: 'WIFI=hunter2\n', stderr: 'warn\n', truncated: false, seconds: 0.2 } });
            }
            if (action === 'computer') {
                if (sandbox.status !== 'running') return reply(409, { error: { code: 'CONFLICT', message: 'The sandbox is not running.' } });
                return reply(200, { data: computerAnswer(body) });
            }
        }
        return reply(404, { error: { code: 'NOT_FOUND', message: `No route ${route}` } });
    };

    return {
        fetch,
        calls,
        overrides,
        sandboxes,
        reply,
        made: () => made,
        actions: () => calls.filter(call => call.path.endsWith('/computer')).map(call => call.body),
        clear: () => { calls.length = 0; },
        running: (fields = {}) => {
            const sandbox = sandboxOf({ status: 'running', polls: 0, ...fields });
            sandboxes.set(sandbox.uuid, sandbox);
            return sandbox;
        },
    };
}

/** A conversation as spaceyard.js sees one. */
function conversation(id, { settings, keys, target = null, canSee = true } = {}) {
    let current = target;
    const secrets = keys || { spaceyard: 'sy-test-key', wifi: 'hunter2' };
    const state = {
        id,
        title: () => 'Test chat',
        settings: () => settings || { spaceyard: true, spaceyardIdle: 20, spaceyardDestroy: 60 },
        canSee: () => canSee,
        resolveSecrets: text => String(text).replace(/\{\{\s*secret:([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, name) => secrets[name] ?? whole),
        scrub: text => String(text).split('hunter2').join('••••'),
        target: () => current,
        setTarget: (next) => { current = next; },
    };
    return {
        state,
        manager: spaceyard.managerFor(state),
        computer: () => spaceyard.computerFor(state),
        target: () => current,
    };
}

const linuxTarget = (fields = {}) => ({ kind: 'spaceyard', uuid: 'sb-1', name: 'test', os: 'linux', image: 'Ubuntu', env: [], secrets: {}, ...fields });

(async () => {
    const use = (yard, extra = {}) => {
        spaceyard._test.reset();
        spaceyard.configure({ fetch: yard.fetch, sleep: async () => {}, imaging: null, timing: { poll: 1, boot: 60000, ready: 60000 }, ...extra });
    };

    console.log('\nthe API');

    await check('every request carries the key as a bearer token', async () => {
        const yard = fakeYard();
        use(yard);
        await spaceyard.client('sy-abc').images();
        assert.strictEqual(yard.calls[0].auth, 'Bearer sy-abc');
    });

    await check('too many requests are waited out for Retry-After, then tried again', async () => {
        const yard = fakeYard();
        const waited = [];
        use(yard, { sleep: async (ms) => { waited.push(ms); } });
        let first = true;
        yard.overrides.push((call) => {
            if (first && call.path === '/sandboxes/images') {
                first = false;
                return yard.reply(429, { error: { code: 'RATE_LIMITED', message: 'Slow down.' } }, { 'retry-after': '3' });
            }
            return null;
        });
        const offer = await spaceyard.client('k').images();
        assert.ok(Array.isArray(offer.data));
        assert.deepStrictEqual(waited, [3000]);
    });

    await check('a failure comes back with Spaceyard\'s own message and code', async () => {
        const yard = fakeYard();
        use(yard);
        yard.overrides.push(() => yard.reply(422, { error: { code: 'UNPROCESSABLE', message: 'As a first time user, top up 10€.' } }));
        await assert.rejects(spaceyard.client('k').create({ image_id: 1 }), (error) => {
            assert.ok(error instanceof spaceyard.SpaceyardError);
            assert.strictEqual(error.status, 422);
            assert.strictEqual(error.code, 'UNPROCESSABLE');
            assert.ok(/top up/.test(error.message));
            return true;
        });
    });

    console.log('\nstarting and choosing');

    await check('switched off, or without a key, nothing is asked of Spaceyard', async () => {
        const yard = fakeYard();
        use(yard);
        const off = conversation('c-off', { settings: { spaceyard: false } });
        assert.ok(/switched off/.test((await off.manager.list()).error));
        const keyless = conversation('c-nokey', { keys: {} });
        assert.ok(/no Spaceyard API key/.test((await keyless.manager.start({})).error));
        assert.strictEqual(yard.calls.length, 0);
    });

    await check('a new sandbox is the cheapest Linux desktop that may start, with the agent\'s lifecycle', async () => {
        const yard = fakeYard();
        use(yard);
        const chat = conversation('c-start');
        const result = await chat.manager.start({});
        assert.ok(!result.error, result.error);
        const create = yard.calls.find(call => call.method === 'POST' && call.path === '/sandboxes');
        assert.strictEqual(create.body.image_id, 1);
        assert.strictEqual(create.body.auto_stop_minutes, 20);
        assert.strictEqual(create.body.auto_destroy_minutes, 60);
        assert.strictEqual(create.body.name, 'Acestes: Test chat');
        assert.ok(!('env' in create.body));
    });

    await check('it waits until running and the desktop answers, then the computer tools point at it', async () => {
        const yard = fakeYard();
        use(yard);
        const chat = conversation('c-point');
        const result = await chat.manager.start({});
        assert.strictEqual(yard.sandboxes.get('sb-1').status, 'running');
        assert.ok(yard.actions().some(action => action.action === 'size'));
        assert.strictEqual(chat.target().uuid, 'sb-1');
        assert.strictEqual(chat.target().os, 'linux');
        assert.strictEqual(result.screen, '1280×800');
        assert.ok(/console\.spaceyard\.dev\/sandboxes\/sb-1\?tab=desktop/.test(result.watch));
        assert.ok(/not on this computer/.test(result.note));
    });

    await check('secrets go in as encrypted variables, named so a shell takes them', async () => {
        const yard = fakeYard();
        use(yard);
        const chat = conversation('c-secrets', { keys: { spaceyard: 'k', 'site.login-pw': 's3cret', wifi: 'hunter2' } });
        const result = await chat.manager.start({ secrets: ['site.login-pw', 'wifi'] });
        assert.ok(!result.error, result.error);
        const create = yard.calls.find(call => call.method === 'POST' && call.path === '/sandboxes');
        assert.deepStrictEqual(create.body.env, { SITE_LOGIN_PW: 's3cret', WIFI: 'hunter2' });
        assert.deepStrictEqual(chat.target().secrets, { 'site.login-pw': 'SITE_LOGIN_PW', wifi: 'WIFI' });
        assert.deepStrictEqual(chat.target().env, ['SITE_LOGIN_PW', 'WIFI']);
        assert.strictEqual(spaceyard.envNameFor('2fa'), '_2FA');
    });

    await check('a secret not in the keychain stops it before anything is made', async () => {
        const yard = fakeYard();
        use(yard);
        const result = await conversation('c-missing').manager.start({ secrets: ['nope'] });
        assert.ok(/no secret "nope"/.test(result.error));
        assert.strictEqual(yard.made(), 0);
    });

    await check('an image the account may not start yet says why', async () => {
        const yard = fakeYard();
        use(yard);
        const result = await conversation('c-win').manager.start({ os: 'windows' });
        assert.ok(/level does not allow it/.test(result.error), result.error);
        assert.strictEqual(yard.made(), 0);
    });

    await check('a stopped sandbox is started again, disk as it was', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running({ status: 'stopped' });
        const chat = conversation('c-resume');
        const result = await chat.manager.start({ sandbox: 'sb-1' });
        assert.ok(!result.error, result.error);
        assert.ok(yard.calls.some(call => call.path === '/sandboxes/sb-1/start'));
        assert.strictEqual(chat.target().uuid, 'sb-1');
        assert.strictEqual(yard.made(), 0);
    });

    await check('stopping the one in use hands the tools back to this computer, and says so', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const chat = conversation('c-stop', { target: linuxTarget() });
        const result = await chat.manager.stop({});
        assert.strictEqual(chat.target(), null);
        assert.ok(/Its disk is kept/.test(result.note));
        assert.ok(/switched off/.test(result.computer), 'computer use is off here, so it says they are refused');
    });

    await check('use_computer "this" needs no key and no switch; a sandbox id points at it', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const chat = conversation('c-use', { settings: { spaceyard: false }, target: linuxTarget() });
        const back = await chat.manager.use({ target: 'this' });
        assert.ok(/act on this computer/.test(back.computer));
        assert.strictEqual(chat.target(), null);
        const on = conversation('c-use2');
        const pointed = await on.manager.use({ target: 'sb-1' });
        assert.ok(!pointed.error, pointed.error);
        assert.strictEqual(on.target().uuid, 'sb-1');
    });

    await check('a command\'s output comes back with secrets masked', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const chat = conversation('c-exec', { target: linuxTarget() });
        const result = await chat.manager.command({ command: 'env | grep WIFI' });
        assert.strictEqual(result.exitCode, 3);
        assert.strictEqual(result.stdout, 'WIFI=••••\n');
        assert.strictEqual(result.stderr, 'warn\n');
        assert.deepStrictEqual(yard.calls.find(call => call.path.endsWith('/exec')).body, { command: 'env | grep WIFI' });
    });

    console.log('\nthe same tools, in a sandbox');

    await check('a read numbers the controls as computer.js does, with their values and states', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const chat = conversation('c-read', { target: linuxTarget() });
        const result = await chat.computer().read({});
        assert.ok(/sandbox "test"/.test(result.computer));
        assert.ok(result.elements.includes('[1] push button "OK"'), result.elements);
        assert.ok(result.elements.includes('[2] entry "Search" = "abc" (focused, editable)'), result.elements);
        assert.strictEqual(result.window.title, 'Mozilla Firefox');
    });

    await check('an element is clicked at its middle, and the window comes back read', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const chat = conversation('c-click', { target: linuxTarget() });
        const api = chat.computer();
        await api.read({});
        yard.clear();
        const result = await api.click({ element: 3 });
        assert.ok(!result.error, result.error);
        const [click, read] = yard.actions();
        assert.deepStrictEqual(click, { action: 'click', x: 520, y: 65 });
        assert.strictEqual(read.action, 'read_screen');
        assert.strictEqual(result.clicked, 'element 3');
        assert.ok(result.screen.elements.includes('[7] push button "Continue"'));
    });

    await check('a number from no read, or one not in it, is refused before anything moves', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const api = conversation('c-noread', { target: linuxTarget() }).computer();
        assert.ok(/read the sandbox's screen first/.test((await api.click({ element: 1 })).error));
        await api.read({});
        assert.ok(/no element 99/.test((await api.click({ element: 99 })).error));
        assert.ok(!yard.actions().some(action => action.action === 'click'));
    });

    await check('after a screenshot, pixels are the picture\'s and the next action brings one back with it', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const api = conversation('c-shot', { target: linuxTarget() }).computer();
        const shot = await api.screenshot({});
        assert.strictEqual(shot.screenshot.size, '1280×800');
        assert.deepStrictEqual(shot.image, { mediaType: 'image/jpeg', data: 'U0NSRUVO' });
        yard.clear();
        const result = await api.click({ x: 640, y: 400 });
        const actions = yard.actions();
        assert.deepStrictEqual(actions, [{ action: 'click', x: 640, y: 400, screenshot: true, format: 'jpeg' }], JSON.stringify(actions));
        assert.ok(result.image, 'the picture that came with the click');
        const outside = await api.click({ x: 2000, y: 10 });
        assert.ok(/\(2000, 10\) is outside your latest screenshot, which is 1280×800/.test(outside.error), outside.error);
    });

    await check('a Windows sandbox\'s smaller picture is reckoned against its real screen', async () => {
        const yard = fakeYard({ os: 'windows', screen: { width: 1920, height: 1080 }, picture: { width: 1531, height: 861, format: 'jpeg', image: 'V0lO' } });
        use(yard);
        yard.running({ os: 'windows' });
        const api = conversation('c-winshot', { target: linuxTarget({ os: 'windows' }) }).computer();
        await api.screenshot({});
        yard.clear();
        await api.click({ x: 765, y: 430, read: false });
        const [click] = yard.actions();
        assert.ok(Math.abs(click.x - 959) <= 1 && Math.abs(click.y - 539) <= 1, JSON.stringify(click));
    });

    await check('a picture too big for the model is shrunk, and pixels follow it', async () => {
        const yard = fakeYard({ screen: { width: 2560, height: 1440 }, picture: { width: 2560, height: 1440, format: 'png', image: 'QklH' } });
        const shrunk = [];
        use(yard, { imaging: { resize: (data, width, height) => { shrunk.push([width, height]); return 'U01BTEw='; }, crop: () => 'Q1JPUA==' } });
        yard.running();
        const api = conversation('c-big', { target: linuxTarget() }).computer();
        const shot = await api.screenshot({});
        assert.strictEqual(shrunk.length, 1);
        const [width, height] = shrunk[0];
        assert.ok(width <= 1568 && width * height <= 1150000, `${width}×${height}`);
        assert.strictEqual(shot.image.mediaType, 'image/jpeg');
        yard.clear();
        await api.click({ x: Math.round(width / 2), y: Math.round(height / 2), read: false });
        const [click] = yard.actions();
        assert.ok(Math.abs(click.x - 1280) <= 2 && Math.abs(click.y - 720) <= 2, JSON.stringify(click));
        const zoom = await api.zoom({ x0: 0, y0: 0, x1: 100, y1: 100 });
        assert.strictEqual(zoom.image.data, 'Q1JPUA==');
    });

    await check('a Windows sandbox\'s controls are listed but clicked by pixel', async () => {
        const yard = fakeYard({ os: 'windows' });
        use(yard);
        yard.running({ os: 'windows' });
        const api = conversation('c-winread', { target: linuxTarget({ os: 'windows' }) }).computer();
        const read = await api.read({});
        assert.ok(read.elements.includes('[5] edit "Text editor" = "hello" (focused)'), read.elements);
        assert.ok(/without a place on the screen/.test((await api.click({ element: 5 })).error));
    });

    await check('a secret is typed from the sandbox\'s own variable, by name, with Enter after it', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running({ env: ['WIFI'] });
        const api = conversation('c-type', { target: linuxTarget({ env: ['WIFI'], secrets: { wifi: 'WIFI' } }) }).computer();
        const result = await api.type({ text: '{{secret:wifi}}\n', read: false });
        assert.ok(!result.error, result.error);
        const actions = yard.actions();
        assert.deepStrictEqual(actions, [{ action: 'type', env: 'WIFI' }, { action: 'key', keys: 'enter' }]);
        assert.ok(!JSON.stringify(yard.calls).includes('hunter2'), 'the value is in no request');
    });

    await check('a secret the sandbox was not given, or one inside other text, is never sent', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const api = conversation('c-type2', { target: linuxTarget() }).computer();
        assert.ok(/was not given to this sandbox/.test((await api.type({ text: '{{secret:wifi}}' })).error));
        assert.ok(/typed on its own/.test((await api.type({ text: 'pw: {{secret:wifi}}' })).error));
        assert.strictEqual(yard.actions().length, 0);
        assert.ok(!JSON.stringify(yard.calls).includes('hunter2'));
    });

    await check('plain text, keys and a scroll go as Spaceyard takes them', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const api = conversation('c-keys', { target: linuxTarget() }).computer();
        await api.read({});
        yard.clear();
        await api.type({ text: 'hello', element: 2, replace: true, read: false });
        await api.keys({ keys: 'ctrl+l', repeat: 2, read: false });
        await api.scroll({ direction: 'down', amount: 5, read: false });
        assert.deepStrictEqual(yard.actions(), [
            { action: 'click', x: 300, y: 50 },
            { action: 'key', keys: 'ctrl+a' },
            { action: 'type', text: 'hello' },
            { action: 'key', keys: 'ctrl+l', repeat: 2 },
            { action: 'scroll', x: 640, y: 400, direction: 'down', amount: 5 },
        ]);
    });

    await check('the desktop\'s own windows are left out of the list', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const result = await conversation('c-win', { target: linuxTarget() }).computer().windows({});
        assert.deepStrictEqual(result.windows, [{ id: '0x02', title: 'Mozilla Firefox', app: 'pid 20', front: true }]);
    });

    await check('a batch runs in order, reads once at the end, and stops at a failure saying which', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const api = conversation('c-steps', { target: linuxTarget() }).computer();
        await api.read({});
        yard.clear();
        const done = await api.steps({ steps: [{ do: 'click', element: 2 }, { do: 'type', text: 'x' }, { do: 'keys', keys: 'enter' }] });
        assert.deepStrictEqual(yard.actions().map(action => action.action), ['click', 'type', 'key', 'read_screen']);
        assert.strictEqual(done.done.length, 3);
        const failed = await api.steps({ steps: [{ do: 'keys', keys: 'tab' }, { do: 'hold_key', keys: 'w' }] });
        assert.ok(/Step 2 of 2 \(hold_key\) failed: hold_key works on this computer only/.test(failed.error), failed.error);
        assert.ok(/The 1 before it were done/.test(failed.error));
    });

    await check('wait_for reads until the text is there', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const result = await conversation('c-wait', { target: linuxTarget() }).computer().waitFor({ text: 'welcome' });
        assert.strictEqual(result.found, 'heading "Welcome back"');
        assert.ok(result.screen.elements.includes('Continue'));
    });

    console.log('\nwhat it will not do');

    await check('a sandbox that stopped says how to start it again', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running({ status: 'stopped' });
        const result = await conversation('c-409', { target: linuxTarget() }).computer().read({});
        assert.ok(/is not running/.test(result.error) && /start_sandbox with sandbox "sb-1"/.test(result.error), result.error);
    });

    await check('switched off, a conversation in a sandbox is refused rather than sent to this desktop', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const result = await conversation('c-offt', { settings: { spaceyard: false }, target: linuxTarget() }).computer().click({ x: 1, y: 1 });
        assert.ok(/switched off/.test(result.error) && /use_computer/.test(result.error), result.error);
        assert.strictEqual(yard.calls.length, 0);
    });

    await check('a stopped turn sends nothing more', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const chat = conversation('c-halt', { target: linuxTarget() });
        spaceyard.halt('c-halt');
        assert.ok(/stopped this turn/.test((await chat.computer().keys({ keys: 'enter' })).error));
        spaceyard.resume('c-halt');
        assert.ok(!(await chat.computer().keys({ keys: 'enter', read: false })).error);
    });

    await check('a mouse button left down is let go when the turn ends', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const api = conversation('c-mouse', { target: linuxTarget() }).computer();
        await api.read({});
        await api.mouse({ action: 'down', element: 1, read: false });
        yard.clear();
        spaceyard.release('c-mouse');
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepStrictEqual(yard.actions(), [{ action: 'mouse_up', button: 'left' }]);
    });

    await check('what only this computer does says so', async () => {
        const yard = fakeYard();
        use(yard);
        yard.running();
        const api = conversation('c-only', { target: linuxTarget() }).computer();
        for (const method of ['hold', 'clipboard', 'arrange', 'captcha']) {
            const result = await api[method]({});
            assert.ok(/this computer only/.test(result.error), `${method}: ${result.error}`);
        }
        assert.ok(/toEnd works on this computer only/.test((await api.scroll({ direction: 'down', toEnd: true })).error));
    });

    console.log('\nwhere it shows');

    const names = settings => tools.visibleTools(settings).map(tool => tool.name);

    await check('the computer tools are offered with sandboxes on even when computer use here is off', () => {
        const offered = names({ computerUse: false, spaceyard: true });
        for (const name of ['read_screen', 'click', 'start_sandbox', 'sandbox_command', 'use_computer']) assert.ok(offered.includes(name), name);
    });

    await check('with sandboxes off, the sandbox tools are not offered', () => {
        const offered = names({ computerUse: true, spaceyard: false });
        assert.ok(offered.includes('click'));
        assert.ok(!offered.includes('start_sandbox') && !offered.includes('use_computer'));
        const neither = names({ computerUse: false, spaceyard: false });
        assert.ok(!neither.includes('click') && !neither.includes('list_sandboxes'));
    });

    await check('starting and running in a sandbox ask; listing and choosing do not', () => {
        assert.strictEqual(tools.BY_NAME.get('start_sandbox').readOnly, false);
        assert.strictEqual(tools.BY_NAME.get('stop_sandbox').readOnly, false);
        assert.strictEqual(tools.BY_NAME.get('sandbox_command').readOnly, false);
        assert.strictEqual(tools.BY_NAME.get('list_sandboxes').readOnly, true);
        assert.strictEqual(tools.BY_NAME.get('use_computer').readOnly, true);
    });

    await check('the blocked command list reaches sandbox_command', () => {
        assert.strictEqual(tools.blockedReason('sandbox_command', { command: 'rm -rf /tmp/x' }, { blockedCommands: ['rm -rf'] }), 'rm -rf');
    });

    await check('a stored target is read back, and anything else is not a target', () => {
        const back = spaceyard.readTarget(JSON.parse(JSON.stringify(linuxTarget({ secrets: { wifi: 'WIFI' }, env: ['WIFI'] }))));
        assert.deepStrictEqual(back, linuxTarget({ secrets: { wifi: 'WIFI' }, env: ['WIFI'] }));
        assert.strictEqual(spaceyard.readTarget({ kind: 'other', uuid: 'x' }), null);
        assert.strictEqual(spaceyard.readTarget(null), null);
    });

    await check('the prompt explains sandboxes when they are on, and names the one in use', () => {
        const base = { scope: 'global', sessionIds: [], hostIds: [], commandMode: 'terminal' };
        const off = prompt.build(base);
        assert.ok(!off.includes('## Cloud sandboxes'));
        const on = prompt.build({ ...base, spaceyard: true, computerTarget: spaceyard.describeTarget(linuxTarget()) });
        assert.ok(on.includes('## Cloud sandboxes'));
        assert.ok(/act on Spaceyard sandbox "test" \(Linux, sb-1\), not on this computer/.test(on));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    fs.rmSync(userData, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
})();

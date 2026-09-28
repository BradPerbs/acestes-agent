const assert = require('assert');

const provider = require('../src/main/ai/providers/opencode');

async function run() {
    const windowsCandidates = provider.openCodeCandidates({
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: {
            Path: 'C:\\Tools;D:\\Bin',
            APPDATA: 'C:\\Users\\Mario\\AppData\\Roaming',
            LOCALAPPDATA: 'C:\\Users\\Mario\\AppData\\Local',
            ChocolateyInstall: 'C:\\ProgramData\\chocolatey',
            SCOOP: 'D:\\Scoop',
        },
    });
    assert(windowsCandidates.includes('C:\\Tools\\opencode.exe'));
    assert(windowsCandidates.includes('C:\\Users\\Mario\\AppData\\Roaming\\npm\\opencode.cmd'));
    assert(windowsCandidates.includes('D:\\Scoop\\shims\\opencode.exe'));
    assert(windowsCandidates.includes('C:\\ProgramData\\chocolatey\\bin\\opencode.exe'));

    const npmShim = 'C:\\Users\\Mario\\AppData\\Roaming\\npm\\opencode.cmd';
    assert.strictEqual(provider.findOpenCode({
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: { APPDATA: 'C:\\Users\\Mario\\AppData\\Roaming' },
        accessSync(candidate) {
            if (candidate !== npmShim) throw new Error('missing');
        },
    }), npmShim);

    /* ---------------- OpenCode Desktop, which ships no CLI ---------------- */

    const desktopExe = 'C:\\Users\\Mario\\AppData\\Local\\Programs\\@opencode-aidesktop\\OpenCode.exe';
    const desktopAsar = 'C:\\Users\\Mario\\AppData\\Local\\Programs\\@opencode-aidesktop\\resources\\app.asar';
    const desktops = provider.desktopCandidates({
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: { LOCALAPPDATA: 'C:\\Users\\Mario\\AppData\\Local' },
    });
    assert(desktops.some(entry => entry.exe === desktopExe && entry.asar === desktopAsar), 'the Windows install is a candidate');
    assert(provider.desktopCandidates({ platform: 'darwin', home: '/Users/mario', env: {} })
        .some(entry => entry.exe === '/Applications/OpenCode.app/Contents/MacOS/OpenCode'));

    // Only the desktop app is there: the launch runs its bundle under its
    // own Electron as Node, through our serve script, on the reserved port.
    const onlyDesktop = {
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: { LOCALAPPDATA: 'C:\\Users\\Mario\\AppData\\Local' },
        accessSync(candidate) {
            if (candidate !== desktopExe && candidate !== desktopAsar) throw new Error('missing');
        },
    };
    assert.strictEqual(provider.findOpenCode(onlyDesktop), '', 'no CLI');
    const launch = provider.findOpenCodeLaunch(onlyDesktop);
    assert.strictEqual(launch.kind, 'desktop');
    assert.strictEqual(launch.command, desktopExe);
    assert.strictEqual(launch.env.ELECTRON_RUN_AS_NODE, '1');
    const args = launch.args(51234);
    assert(args[0].endsWith('opencode-desktop-serve.mjs'));
    assert.strictEqual(args[1], desktopAsar);
    assert.deepStrictEqual(args.slice(2), ['127.0.0.1', '51234']);

    // The CLI wins when both are there.
    const cli = provider.findOpenCodeLaunch({
        ...onlyDesktop,
        accessSync(candidate) {
            if (candidate !== npmShim && candidate !== desktopExe && candidate !== desktopAsar) throw new Error('missing');
        },
        env: { APPDATA: 'C:\\Users\\Mario\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Mario\\AppData\\Local' },
    });
    assert.strictEqual(cli.kind, 'cli');
    assert.deepStrictEqual(cli.args(7), ['serve', '--hostname=127.0.0.1', '--port=7']);

    // Nothing at all is null, not a guess.
    assert.strictEqual(provider.findOpenCodeLaunch({ ...onlyDesktop, accessSync() { throw new Error('missing'); } }), null);

    let killed = false;
    let taskkill = null;
    provider._test.closeProcess({
        pid: 42,
        exitCode: null,
        signalCode: null,
        kill() { killed = true; },
    }, {
        platform: 'win32',
        spawnSyncFn(command, args, options) {
            taskkill = { command, args, options };
            return { status: 0 };
        },
    });
    assert.deepStrictEqual(taskkill, {
        command: 'taskkill',
        args: ['/pid', '42', '/T', '/F'],
        options: { windowsHide: true },
    });
    assert.strictEqual(killed, false);

    provider._test.closeProcess({
        pid: 43,
        exitCode: null,
        signalCode: null,
        kill() { killed = true; },
    }, {
        platform: 'win32',
        spawnSyncFn: () => ({ status: 1 }),
    });
    assert.strictEqual(killed, true);

    assert.deepStrictEqual(provider.parseModel('anthropic/claude-sonnet-4'), {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4',
    });
    assert.deepStrictEqual(provider.parseModel('custom/team/model'), {
        providerID: 'custom',
        modelID: 'team/model',
    });
    assert.strictEqual(provider.parseModel('not-a-model'), undefined);
    // `question` asks the user something and touches nothing, so it is allowed
    // whichever way the local-tools switch is set. Denied or merely asked, the
    // turn stopped on a card nobody could see.
    assert.deepStrictEqual(provider.permissions(false), { '*': 'deny', 'remote_*': 'allow', question: 'allow' });
    assert.deepStrictEqual(provider.permissions(true), { '*': 'ask', 'remote_*': 'allow', question: 'allow' });
    assert.strictEqual(provider.serverConfig({ allowLocalTools: false }).tools.question, true);

    /* ---------------- Effort, which OpenCode calls a variant ---------------- */

    // Read off /config/providers, which has carried them since 1.18 whether or
    // not the pinned SDK declares the field. Only the stops the app has a name
    // for survive, in the app's order: `minimal` has none, so it is dropped.
    assert.deepStrictEqual(provider.variantsOf({
        variants: { minimal: {}, xhigh: {}, low: {}, medium: {}, high: {} },
    }), ['low', 'medium', 'high', 'xhigh']);
    assert.deepStrictEqual(provider.variantsOf({ variants: { low: {}, medium: {}, high: {} } }), ['low', 'medium', 'high']);
    // No variants is what every OpenCode model used to report, and the menu
    // hides the dial on an empty scale.
    assert.deepStrictEqual(provider.variantsOf({}), []);
    assert.deepStrictEqual(provider.variantsOf(null), []);

    // A saved effort travels between models whose scales differ, so it rounds
    // down to the stop this one has rather than resetting or being sent as-is.
    assert.strictEqual(provider.nearestVariant(['low', 'medium', 'high'], 'high'), 'high');
    assert.strictEqual(provider.nearestVariant(['low', 'medium', 'high'], 'max'), 'high');
    assert.strictEqual(provider.nearestVariant(['low', 'medium', 'high', 'xhigh'], 'max'), 'xhigh');
    assert.strictEqual(provider.nearestVariant(['medium', 'high'], 'low'), '', 'nothing low enough asks for nothing');
    assert.strictEqual(provider.nearestVariant([], 'high'), '', 'a model with no variants is asked for none');
    assert.strictEqual(provider.nearestVariant(['low', 'high'], ''), '');
    assert.strictEqual(provider.nearestVariant(['low', 'high'], 'nonsense'), '');

    const emitted = [];
    const translator = provider.createTranslator('session-1', event => emitted.push(event));
    translator.beginTurn();

    await translator.event({
        type: 'message.part.updated',
        properties: {
            delta: 'Hello',
            part: {
                id: 'text-1',
                sessionID: 'session-1',
                messageID: 'message-1',
                type: 'text',
                text: 'Hello',
                time: { start: 1 },
            },
        },
    }, async () => {});

    await translator.event({
        type: 'message.part.updated',
        properties: {
            part: {
                id: 'text-1',
                sessionID: 'session-1',
                messageID: 'message-1',
                type: 'text',
                text: 'Hello world',
                time: { start: 1, end: 2 },
            },
        },
    }, async () => {});

    const pendingTool = {
        id: 'tool-part-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'tool',
        callID: 'call-1',
        tool: 'remote_run_command',
        state: { status: 'pending', input: {}, raw: '' },
    };
    await translator.event({
        type: 'message.part.updated', properties: { part: pendingTool },
    }, async () => {});
    await translator.event({
        type: 'message.part.updated',
        properties: {
            part: {
                ...pendingTool,
                state: { status: 'running', input: { command: 'uptime' }, time: { start: 3 } },
            },
        },
    }, async () => {});
    await translator.event({
        type: 'message.part.updated',
        properties: {
            part: {
                ...pendingTool,
                state: {
                    status: 'completed',
                    input: { command: 'uptime' },
                    output: 'up 4 days',
                    title: 'run_command',
                    metadata: {},
                    time: { start: 3, end: 4 },
                },
            },
        },
    }, async () => {});

    await translator.event({
        type: 'message.updated',
        properties: {
            info: {
                id: 'message-1',
                sessionID: 'session-1',
                role: 'assistant',
                cost: 0.012,
                time: { created: 1, completed: 5 },
            },
        },
    }, async () => {});
    await translator.event({
        type: 'session.idle', properties: { sessionID: 'session-1' },
    }, async () => {});

    assert.deepStrictEqual(emitted.map(event => event.type), [
        'text-delta', 'assistant-text', 'tool-call', 'tool-result', 'result',
    ]);
    assert.deepStrictEqual(emitted[2], {
        type: 'tool-call',
        id: 'call-1',
        name: 'run_command',
        rawName: 'remote_run_command',
        local: false,
        input: { command: 'uptime' },
    });
    assert.strictEqual(emitted[4].costUsd, 0.012);
    assert.strictEqual(emitted[4].isError, false);

    /* ------- the runtime's own question, which used to hang the turn ------- */

    // Both flavours reach the handler, one for another session does not, and
    // the stream is not held while the person thinks: the translator hands the
    // request on and returns, so what follows it still gets read.
    const asked = [];
    const questioner = provider.createTranslator('session-1', () => {});
    let slow;
    const held = new Promise((resolve) => { slow = resolve; });
    const started = questioner.event({
        type: 'question.asked',
        properties: {
            id: 'q-1',
            sessionID: 'session-1',
            questions: [{ question: 'Which host?', header: 'Host', options: [{ label: 'web-01', description: 'the front end' }] }],
        },
    }, async () => {}, (request, v2) => {
        asked.push({ id: request.id, v2 });
        return held;
    });
    await started;
    assert.strictEqual(asked.length, 1, 'the question was handed on');
    assert.strictEqual(asked[0].v2, false);
    slow();

    await questioner.event({
        type: 'question.v2.asked',
        properties: { id: 'q-2', sessionID: 'session-1', questions: [] },
    }, async () => {}, (request, v2) => { asked.push({ id: request.id, v2 }); });
    await questioner.event({
        type: 'question.asked',
        properties: { id: 'q-3', sessionID: 'another-session', questions: [] },
    }, async () => {}, (request, v2) => { asked.push({ id: request.id, v2 }); });

    assert.deepStrictEqual(asked, [{ id: 'q-1', v2: false }, { id: 'q-2', v2: true }]);

    console.log('opencode-provider tests passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

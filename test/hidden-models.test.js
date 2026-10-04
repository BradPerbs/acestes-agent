/**
 * Hiding models from the composer's menu, per runtime.
 *
 * The settings page lists each switched-on runtime's models as ticks; unticked
 * ones disappear from the menu, "deselect all" keeps none, "select all" puts
 * the runtime back the way it was. Checked here: what the setting keeps, and
 * what the menu's rows look like with parts of them hidden. The model the
 * conversation is pinned to is always kept, so the page can never strand the
 * composer on a row that is gone.
 *
 * `electron` is stubbed so it runs under plain node, and the renderer's
 * modules are ESM written for the bundler, so they are imported with a
 * resolve hook that adds the extensions the bundler would.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-hidden-models-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable'); }, decryptString: () => { throw new Error('unavailable'); } },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {} },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

// `../i18n` the way the bundler reads it, as `../i18n/index.js`.
Module.registerHooks({
    resolve(specifier, context, nextResolve) {
        try {
            return nextResolve(specifier, context);
        } catch (error) {
            if (!specifier.startsWith('.')) throw error;
            for (const suffix of ['.js', '/index.js']) {
                try {
                    return nextResolve(specifier + suffix, context);
                } catch {
                    // The next spelling.
                }
            }
            throw error;
        }
    },
});
const memoryStore = new Map();
globalThis.localStorage = {
    getItem: key => (memoryStore.has(key) ? memoryStore.get(key) : null),
    setItem: (key, value) => memoryStore.set(key, String(value)),
};
globalThis.document = { documentElement: {} };
globalThis.navigator = { languages: ['en'], language: 'en' };

const settings = require(path.join(ROOT, 'ai', 'settings'));

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

(async () => {
    const importRenderer = file => import(pathToFileURL(path.join(RENDERER, 'lib', file)).href);
    const catalog = await importRenderer('ai-catalog.js');

    console.log('\nthe setting');

    await check('hidden models are kept per runtime, cleaned, and empty lists dropped', () => {
        const clean = settings._test.sanitize({
            hiddenModels: {
                codex: ['gpt-5.1', ' gpt-5.1-mini ', '', 7, 'gpt-5.1'],
                bogus: ['x'],
                'claude-code': [],
            },
        });
        assert.deepStrictEqual(clean.hiddenModels, { codex: ['gpt-5.1', 'gpt-5.1-mini'] });
        assert.deepStrictEqual(settings._test.sanitize({}).hiddenModels, {});
        assert.deepStrictEqual(settings._test.sanitize({ hiddenModels: ['nope'] }).hiddenModels, {});
    });

    console.log('\nthe menu rows');

    const rowsFor = (provider) => [
        { value: 'alpha', resolved: 'alpha', short: 'Alpha', label: 'Alpha', hint: '' },
        { value: 'beta', resolved: 'beta', short: 'Beta', label: 'Beta', hint: '' },
    ];
    const base = { provider: 'codex', providers: ['codex'], model: '', hiddenModels: {} };

    await check('unticked models disappear from the menu, other runtimes untouched', () => {
        const catalogs = { codex: rowsFor('codex'), 'claude-code': rowsFor('claude-code') };
        const settingsValue = {
            ...base,
            providers: ['codex', 'claude-code'],
            hiddenModels: { codex: ['beta'] },
        };
        const rows = catalog.mergedModelRows(catalogs, ['codex', 'claude-code'], settingsValue);
        assert.deepStrictEqual(
            rows.filter(row => row.provider === 'codex').map(row => row.value),
            ['alpha'],
        );
        assert.deepStrictEqual(
            rows.filter(row => row.provider === 'claude-code').map(row => row.value),
            ['alpha', 'beta'],
        );
    });

    await check('the model the conversation is on stays offered whatever is ticked', () => {
        const catalogs = { codex: rowsFor('codex') };
        const rows = catalog.mergedModelRows(catalogs, ['codex'], {
            ...base,
            model: 'beta',
            hiddenModels: { codex: ['alpha', 'beta'] },
        });
        assert.deepStrictEqual(rows.map(row => row.value), ['beta']);
    });

    await check('deselect all hides everything but the pinned model, select all restores', () => {
        const catalogs = { codex: rowsFor('codex') };
        const none = catalog.mergedModelRows(catalogs, ['codex'], {
            ...base,
            hiddenModels: { codex: ['alpha', 'beta'] },
        });
        // Nothing pinned and nothing preferred: the runtime's default answers.
        assert.deepStrictEqual(none.map(row => row.value), []);
        const all = catalog.mergedModelRows(catalogs, ['codex'], base);
        assert.deepStrictEqual(all.map(row => row.value), ['alpha', 'beta']);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    try {
        fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
        // Left in the temp folder.
    }
    process.exit(failed > 0 ? 1 : 0);
})();

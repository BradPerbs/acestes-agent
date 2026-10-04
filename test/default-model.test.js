/**
 * What a new conversation starts on.
 *
 * First an explicitly chosen default model from the settings page, then the
 * chip's last pick, then the agent's own default. Checked here: the default
 * wins over the remembered pick, switching its runtime off falls back to the
 * remembered pick, and with no default set the old behaviour (remembered
 * pick, invalidated by a settings change) is untouched.
 */
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

const memoryStore = new Map();
globalThis.localStorage = {
    getItem: key => (memoryStore.has(key) ? memoryStore.get(key) : null),
    setItem: (key, value) => memoryStore.set(key, String(value)),
    removeItem: key => memoryStore.delete(key),
};

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

const base = {
    provider: 'codex',
    providers: ['codex', 'claude-code'],
    model: '',
    effort: 'high',
};

(async () => {
    const { lastModel, rememberModel } = await import(
        pathToFileURL(path.join(RENDERER, 'lib', 'last-model.js')).href
    );

    console.log('\nthe starting pick');

    await check('with no default set, the remembered pick wins', () => {
        memoryStore.clear();
        rememberModel('agent-1', base, { provider: 'claude-code', model: 'opus', effort: 'max' });
        assert.deepStrictEqual(lastModel('agent-1', base), {
            provider: 'claude-code', model: 'opus', effort: 'max',
        });
    });

    await check('an explicitly chosen default wins over the remembered pick', () => {
        memoryStore.clear();
        rememberModel('agent-1', base, { provider: 'claude-code', model: 'opus', effort: 'max' });
        assert.deepStrictEqual(lastModel('agent-1', { ...base, model: 'gpt-5' }), {
            provider: 'codex', model: 'gpt-5', effort: 'high',
        });
    });

    await check('a default on a runtime that is switched off falls back to the remembered pick', () => {
        memoryStore.clear();
        const withDefault = { ...base, model: 'gpt-5' };
        rememberModel('agent-1', withDefault, { provider: 'claude-code', model: 'opus', effort: 'max' });
        const switchedOff = { ...withDefault, providers: ['claude-code'] };
        assert.deepStrictEqual(lastModel('agent-1', switchedOff), {
            provider: 'claude-code', model: 'opus', effort: 'max',
        });
    });

    await check('a settings change still invalidates the remembered pick', () => {
        memoryStore.clear();
        rememberModel('agent-1', base, { provider: 'codex', model: 'gpt-5', effort: 'high' });
        assert.strictEqual(
            lastModel('agent-1', { ...base, provider: 'claude-code' }),
            null,
            'a new harness means the agent default answers',
        );
    });

    await check('nothing remembered and no default means the agent default answers', () => {
        memoryStore.clear();
        assert.strictEqual(lastModel('agent-1', base), null);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();

/**
 * The MCP launcher's npx shortcut: an `npx -y <package>` server whose package
 * is already in npx's cache, under exactly that spec, is run with `node`
 * directly; anything else goes through npx as it always did. The cache here
 * is a real directory laid out the way npm lays it out, so the lookup is
 * tested against files rather than a map.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const launcher = require('../src/main/ai/mcp-launch');

const LAUNCHER = path.join(__dirname, '..', 'src', 'main', 'ai', 'mcp-launch.js');
const windows = process.platform === 'win32';

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
}

/** An npx cache with one install per spec given: `{ spec: { bin, script } }`. */
function makeCache(installs) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acestes-npx-'));
    let index = 0;
    for (const [spec, install] of Object.entries(installs)) {
        const dir = path.join(root, '_npx', `entry${index += 1}`);
        const name = launcher.packageName(spec);
        const packageDir = path.join(dir, 'node_modules', ...name.split('/'));
        fs.mkdirSync(packageDir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { [name]: '^1.0.0' }, _npx: { packages: [spec] } }));
        fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, bin: install.bin }));
        if (install.script !== null) {
            fs.writeFileSync(path.join(packageDir, 'cli.js'), install.script || '#!/usr/bin/env node\n');
        }
    }
    return root;
}

/** A directory holding a `node` for the shortcut to find on PATH. */
function makeNodeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acestes-node-'));
    fs.writeFileSync(path.join(dir, windows ? 'node.exe' : 'node'), '');
    return dir;
}

console.log('mcp launcher');

check('npx command lines are read as a package and its arguments', () => {
    assert.deepStrictEqual(launcher.parseNpx('npx', ['-y', '@playwright/mcp@latest']), { spec: '@playwright/mcp@latest', args: [] });
    assert.deepStrictEqual(launcher.parseNpx('npx', ['--yes', '--', 'server-x@1.2.3', '--port', '3']), { spec: 'server-x@1.2.3', args: ['--port', '3'] });
    assert.deepStrictEqual(launcher.parseNpx('C:\\Program Files\\nodejs\\npx.cmd', ['-y', 'pkg']), { spec: 'pkg', args: [] });
    assert.deepStrictEqual(launcher.parseNpx('/usr/local/bin/npx', ['pkg', '-y']), { spec: 'pkg', args: ['-y'] });
});

check('anything npx would do differently is left to npx', () => {
    assert.strictEqual(launcher.parseNpx('node', ['server.js']), null);
    assert.strictEqual(launcher.parseNpx('npx', ['-p', 'pkg', 'bin']), null);
    assert.strictEqual(launcher.parseNpx('npx', ['--registry=https://example', 'pkg']), null);
    assert.strictEqual(launcher.parseNpx('npx', ['-y']), null);
    assert.strictEqual(launcher.parseNpx('npx', ['./local-server']), null);
    assert.strictEqual(launcher.parseNpx('npx', ['github:someone/server']), null);
});

check('package names and exact versions', () => {
    assert.strictEqual(launcher.packageName('@playwright/mcp@latest'), '@playwright/mcp');
    assert.strictEqual(launcher.packageName('@playwright/mcp'), '@playwright/mcp');
    assert.strictEqual(launcher.packageName('server-x@1.2.3'), 'server-x');
    assert.strictEqual(launcher.isExactVersion('@playwright/mcp@0.0.83'), true);
    assert.strictEqual(launcher.isExactVersion('server-x@1.2.3-beta.1'), true);
    assert.strictEqual(launcher.isExactVersion('@playwright/mcp@latest'), false);
    assert.strictEqual(launcher.isExactVersion('server-x@^1.2.0'), false);
    assert.strictEqual(launcher.isExactVersion('server-x'), false);
});

check('the bin is npx\'s pick: the only one, or the one named after the package', () => {
    assert.strictEqual(launcher.binOf({ bin: 'cli.js' }, 'x'), 'cli.js');
    assert.strictEqual(launcher.binOf({ bin: { 'playwright-mcp': 'cli.js' } }, '@playwright/mcp'), 'cli.js');
    assert.strictEqual(launcher.binOf({ bin: { tool: 'a.js', other: 'b.js' } }, '@scope/tool'), 'a.js');
    assert.strictEqual(launcher.binOf({ bin: { a: 'a.js', b: 'b.js' } }, 'c'), null);
    assert.strictEqual(launcher.binOf({}, 'x'), null);
});

check('npm\'s cache is where the environment or the platform says', () => {
    assert.strictEqual(launcher.npmCacheDir({ npm_config_cache: '/elsewhere' }), '/elsewhere');
    assert.strictEqual(launcher.npmCacheDir({ LOCALAPPDATA: 'C:\\Users\\M\\AppData\\Local' }, { platform: 'win32' }), 'C:\\Users\\M\\AppData\\Local\\npm-cache');
    assert.strictEqual(launcher.npmCacheDir({}, { platform: 'darwin', home: '/Users/m' }), '/Users/m/.npm');
});

check('a cached package is found under exactly the spec it was installed for', () => {
    const cache = makeCache({
        '@playwright/mcp@latest': { bin: { 'playwright-mcp': 'cli.js' } },
        '@playwright/mcp@0.0.70': { bin: { 'playwright-mcp': 'cli.js' } },
    });
    const found = launcher.findCached('@playwright/mcp@latest', cache);
    assert.ok(found, 'found');
    assert.ok(found.bin.endsWith(path.join('@playwright', 'mcp', 'cli.js')));
    assert.notStrictEqual(found.installDir, launcher.findCached('@playwright/mcp@0.0.70', cache).installDir);
    // Spelled another way is another cache entry, and npx's to make.
    assert.strictEqual(launcher.findCached('@playwright/mcp', cache), null);
    assert.strictEqual(launcher.findCached('@playwright/mcp@latest', path.join(cache, 'missing')), null);
});

check('a half-installed or non-node package is not taken', () => {
    const cache = makeCache({
        'gone@latest': { bin: 'cli.js', script: null },
        'shell@latest': { bin: 'cli.js', script: '#!/bin/sh\necho hi\n' },
    });
    // A bin named .js runs under node whatever its first line; this one has
    // no file at all.
    assert.strictEqual(launcher.findCached('gone@latest', cache), null);
    // cli.js is taken by its extension even with a shell shebang: npm bins
    // named .js are node scripts.
    assert.ok(launcher.findCached('shell@latest', cache));
});

check('the shortcut runs the bin with node, with the install\'s .bin first on PATH', () => {
    const cache = makeCache({ '@playwright/mcp@latest': { bin: { 'playwright-mcp': 'cli.js' } } });
    const nodeDir = makeNodeDir();
    const env = { npm_config_cache: cache, PATH: nodeDir };
    const plan = launcher.npxShortcut('npx', ['-y', '@playwright/mcp@latest', '--headless'], env);
    assert.ok(plan, 'a plan');
    assert.strictEqual(path.dirname(plan.command), nodeDir);
    assert.ok(plan.args[0].endsWith('cli.js'));
    assert.deepStrictEqual(plan.args.slice(1), ['--headless']);
    assert.ok(plan.env.PATH.startsWith(path.join(plan.args[0].split(`${path.sep}node_modules${path.sep}`)[0], 'node_modules', '.bin')));
    assert.ok(plan.env.PATH.endsWith(nodeDir));
    assert.strictEqual(plan.spec, '@playwright/mcp@latest');
});

check('no shortcut without a cached copy or a node to run it', () => {
    const cache = makeCache({ '@playwright/mcp@latest': { bin: { 'playwright-mcp': 'cli.js' } } });
    assert.strictEqual(launcher.npxShortcut('npx', ['-y', 'other@latest'], { npm_config_cache: cache, PATH: makeNodeDir() }), null);
    assert.strictEqual(launcher.npxShortcut('npx', ['-y', '@playwright/mcp@latest'], { npm_config_cache: cache, PATH: '' }), null);
    assert.strictEqual(launcher.npxShortcut('uvx', ['server'], { npm_config_cache: cache, PATH: makeNodeDir() }), null);
});

check('the launcher runs a cached package directly, end to end', () => {
    const cache = makeCache({
        'echo-server@latest': { bin: 'cli.js', script: 'process.stdout.write("cached copy " + process.argv.slice(2).join(" "));\n' },
    });
    const env = {
        ...process.env,
        npm_config_cache: cache,
        PATH: [path.dirname(process.execPath), process.env.PATH || process.env.Path || ''].join(path.delimiter),
    };
    delete env.Path;
    const spec = JSON.stringify({ command: 'npx', args: ['-y', 'echo-server@latest', 'one', 'two'], env });
    const result = spawnSync(process.execPath, [LAUNCHER, spec], { encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, 'cached copy one two');
});

console.log(`mcp launcher: ${passed} passed`);

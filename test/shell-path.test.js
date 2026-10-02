/**
 * shell-path: the login shell's PATH for a packaged app started outside a
 * terminal, so script CLIs like `pi` (`#!/usr/bin/env node`) can be spawned
 * when the inherited PATH knows no `node`.
 */
const assert = require('assert');
const path = require('path');

const shellPath = require(path.join(__dirname, '..', 'src', 'main', 'shell-path.js'));
const { mergePaths, pickPathLine, queryShellPath, shellCandidates } = shellPath._test;

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

console.log('\nshell-path: merging');

check('puts the shell order first and drops duplicates', () => {
    assert.strictEqual(
        mergePaths('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin:/bin'),
        '/opt/homebrew/bin:/usr/bin:/bin',
    );
});

check('keeps entries only in the current PATH, at the end', () => {
    assert.strictEqual(
        mergePaths('/usr/bin:/custom/kept', '/opt/homebrew/bin:/usr/bin'),
        '/opt/homebrew/bin:/usr/bin:/custom/kept',
    );
});

check('survives empty and missing sides', () => {
    assert.strictEqual(mergePaths('', '/opt/homebrew/bin'), '/opt/homebrew/bin');
    assert.strictEqual(mergePaths('/usr/bin', ''), '/usr/bin');
    assert.strictEqual(mergePaths('', ''), '');
});

console.log('\nshell-path: reading the shell answer');

check('takes the last non-empty line past chatty dotfiles', () => {
    assert.strictEqual(pickPathLine('hello\n/opt/homebrew/bin:/usr/bin\n'), '/opt/homebrew/bin:/usr/bin');
    assert.strictEqual(pickPathLine('/opt/homebrew/bin:/usr/bin'), '/opt/homebrew/bin:/usr/bin');
});

check('refuses what is not colon-separated absolute directories', () => {
    assert.strictEqual(pickPathLine(''), '');
    assert.strictEqual(pickPathLine('command not found: foo'), '');
    assert.strictEqual(pickPathLine('hello\nstill not a path'), '');
});

check('asks the shell as a login interactive shell and reads its PATH', () => {
    let asked = null;
    const spawnFn = (shell, args) => {
        asked = { shell, args };
        return { status: 0, stdout: '/opt/homebrew/bin:/usr/bin' };
    };
    assert.strictEqual(queryShellPath('/bin/zsh', spawnFn), '/opt/homebrew/bin:/usr/bin');
    assert.deepStrictEqual(asked.args, ['-l', '-i', '-c', 'printf %s "$PATH"']);
});

check('gives up quietly when the shell fails', () => {
    assert.strictEqual(queryShellPath('/bin/zsh', () => ({ status: 1, stdout: '' })), '');
    assert.strictEqual(queryShellPath('/bin/zsh', () => { throw new Error('nope'); }), '');
});

console.log('\nshell-path: ensuring');

check("prefers the user's own SHELL, then the stock ones", () => {
    assert.deepStrictEqual(
        shellCandidates({ SHELL: '/opt/homebrew/bin/fish' }),
        ['/opt/homebrew/bin/fish', '/bin/zsh', '/bin/bash', '/bin/sh'],
    );
    assert.deepStrictEqual(shellCandidates({}), ['/bin/zsh', '/bin/bash', '/bin/sh']);
});

check('does nothing on Windows', () => {
    let calls = 0;
    const env = { PATH: 'C:\\Windows' };
    const out = shellPath.ensureShellPath({ env, platform: 'win32', spawnFn: () => { calls++; return {}; } });
    assert.strictEqual(out, 'C:\\Windows');
    assert.strictEqual(calls, 0);
});

check('adds the missing shell entries and leaves the rest alone', () => {
    const env = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' };
    shellPath.ensureShellPath({
        env,
        platform: 'darwin',
        spawnFn: () => ({ status: 0, stdout: '/opt/homebrew/bin:/usr/bin:/bin' }),
    });
    assert.strictEqual(env.PATH, '/opt/homebrew/bin:/usr/bin:/bin');
});

check('leaves the PATH alone when the shell has nothing to say', () => {
    const env = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' };
    shellPath.ensureShellPath({
        env,
        platform: 'darwin',
        spawnFn: () => ({ status: 1, stdout: '' }),
    });
    assert.strictEqual(env.PATH, '/usr/bin:/bin');
});

check('tries the next shell when the first one fails', () => {
    const tried = [];
    const env = { PATH: '/usr/bin:/bin', SHELL: '/bin/nonexistent' };
    shellPath.ensureShellPath({
        env,
        platform: 'linux',
        spawnFn: (shell) => {
            tried.push(shell);
            if (tried.length === 1) return { status: 1, stdout: '' };
            return { status: 0, stdout: '/home/u/.local/bin:/usr/bin:/bin' };
        },
    });
    assert.deepStrictEqual(tried.slice(0, 2), ['/bin/nonexistent', '/bin/zsh']);
    assert.strictEqual(env.PATH, '/home/u/.local/bin:/usr/bin:/bin');
});

console.log(`\n${passed} checks passed${process.exitCode ? ', with failures above' : ''}\n`);

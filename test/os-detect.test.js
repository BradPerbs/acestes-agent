/**
 * The os/distro vocabulary live SSH detection keys the host icons on.
 */
const path = require('path');
const assert = require('assert');

const {
    classifyShellOutput,
} = require(path.join(__dirname, '..', 'src', 'main', 'os-detect.js'));

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

console.log('\nos detection: shell output');

check('reads a real os-release', () => {
    const output = 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="22.04"\n---UNAME---\nLinux web 5.15.0 x86_64';
    assert.deepStrictEqual(classifyShellOutput(output), { os: 'linux', distro: 'ubuntu' });
});

check('prefers the derivative over its base', () => {
    assert.strictEqual(classifyShellOutput('ID=kubuntu\nID_LIKE=ubuntu debian').distro, 'kubuntu');
    assert.strictEqual(classifyShellOutput('ID=manjaro\nID_LIKE=arch').distro, 'manjaro');
});

check('recognises the non-Linux families', () => {
    assert.strictEqual(classifyShellOutput('Darwin Kernel Version 23.0').os, 'macos');
    assert.strictEqual(classifyShellOutput('FreeBSD host 14.0-RELEASE').os, 'freebsd');
    assert.strictEqual(classifyShellOutput('OpenBSD host 7.4').os, 'openbsd');
});

check('carries no distro for a non-Linux OS', () => {
    assert.strictEqual(classifyShellOutput('Darwin ... arch ...').distro, '');
});

check('falls back to plain linux when nothing matches', () => {
    assert.deepStrictEqual(classifyShellOutput('Linux box 6.1.0 x86_64'), { os: 'linux', distro: '' });
});

check('survives empty and missing output', () => {
    assert.deepStrictEqual(classifyShellOutput(''), { os: 'linux', distro: '' });
    assert.deepStrictEqual(classifyShellOutput(undefined), { os: 'linux', distro: '' });
});

console.log(`\n${passed} checks passed${process.exitCode ? ', with failures above' : ''}\n`);

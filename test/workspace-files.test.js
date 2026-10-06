/**
 * The files behind `@`: a capped walk of the agent's granted folders, and
 * the path helpers the send flow uses to open a tagged file.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const workspaceFiles = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'workspace-files.js'));

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

/** A small tree with the traps: controls, output, a binary, a big file. */
function plant() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-files-'));
    const write = (rel, content) => {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    };
    write('src/app.js', 'console.log("hi");\n');
    write('src/nested/deep/tool.js', 'module.exports = 1;\n');
    write('README.md', '# hi\n');
    write('node_modules/dep/index.js', 'x\n');
    write('.git/config', 'x\n');
    write('dist/bundle.js', 'x\n');
    write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    write('big.bin', 'x'.repeat(workspaceFiles.MAX_FILE_SIZE + 1));
    return root;
}

const sandboxFor = (root, execution = 'host') => ({
    execution,
    folders: [{ path: root, mode: 'write' }],
});

console.log('\nlisting workspace files');

check('lists text files and skips controls, output, binaries and big files', () => {
    const root = plant();
    const names = workspaceFiles.listWorkspaceFiles(sandboxFor(root)).map(entry => entry.name).sort();
    assert.deepStrictEqual(names, ['README.md', 'src/app.js', 'src/nested/deep/tool.js']);
});

check('every entry carries the absolute path as its id', () => {
    const root = plant();
    for (const entry of workspaceFiles.listWorkspaceFiles(sandboxFor(root))) {
        assert.ok(path.isAbsolute(entry.id), `${entry.id} is absolute`);
        assert.ok(entry.id.startsWith(root), `${entry.id} stays in the grant`);
        assert.strictEqual(entry.hint, entry.id);
    }
});

check('a missing folder reads as empty, not an error', () => {
    assert.deepStrictEqual(
        workspaceFiles.listWorkspaceFiles({ execution: 'host', folders: [{ path: path.join('nope', 'missing'), mode: 'read' }] }),
        [],
    );
});

check('no folders is no files', () => {
    assert.deepStrictEqual(workspaceFiles.listWorkspaceFiles({ execution: 'host', folders: [] }), []);
});

check('the file cap holds on a wide tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-files-wide-'));
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x\n');
    const found = workspaceFiles.listWorkspaceFiles(sandboxFor(root), { maxFiles: 10 });
    assert.strictEqual(found.length, 10);
});

check('a second folder prefixes names so twins tell apart', () => {
    const first = plant();
    const second = plant();
    const sandbox = { execution: 'host', folders: [{ path: first, mode: 'read' }, { path: second, mode: 'read' }] };
    const names = workspaceFiles.listWorkspaceFiles(sandbox).map(entry => entry.name);
    assert.ok(names.some(name => name.startsWith(`${path.basename(first)}/`)), names.join(','));
    assert.ok(names.some(name => name.startsWith(`${path.basename(second)}/`)), names.join(','));
});

console.log('\nresolving a tagged file');

check('a path inside the grant resolves to itself on the host', () => {
    const root = plant();
    const target = workspaceFiles.toAgentPath(sandboxFor(root), path.join(root, 'src', 'app.js'));
    assert.strictEqual(target.path, path.join(root, 'src', 'app.js'));
});

check('a path outside the grant is refused with the reason', () => {
    const root = plant();
    const target = workspaceFiles.toAgentPath(sandboxFor(root), path.join(path.dirname(root), 'elsewhere.js'));
    assert.match(target.error, /outside the folders/);
});

check('a relative id is refused', () => {
    const root = plant();
    assert.match(workspaceFiles.toAgentPath(sandboxFor(root), 'src/app.js').error, /absolute/);
});

check('in a container the path becomes its mount', () => {
    const root = plant();
    const target = workspaceFiles.toAgentPath(sandboxFor(root, 'container'), path.join(root, 'src', 'app.js'));
    assert.ok(target.path.startsWith('/workspace/'), target.path);
    assert.ok(target.path.endsWith('src/app.js'), target.path);
});

check('in a container a path outside the grant is refused', () => {
    const root = plant();
    const target = workspaceFiles.toAgentPath(sandboxFor(root, 'container'), '/etc/passwd');
    assert.match(target.error, /outside the folders/);
});

check('display names stay relative to the grant', () => {
    const root = plant();
    assert.strictEqual(
        workspaceFiles.displayRel(sandboxFor(root), path.join(root, 'src', 'app.js')),
        'src/app.js',
    );
});

console.log(`\n${passed} checks passed${process.exitCode ? ', with failures above' : ''}\n`);

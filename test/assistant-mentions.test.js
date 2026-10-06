/**
 * What a message tags with `@`: resolved against the agent's inventory, and
 * spelled into the prompt in front of the user's text.
 */
const assert = require('assert');
const path = require('path');

const mentions = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'mentions.js'));
const { normalizeSnippets } = require(path.join(__dirname, '..', 'src', 'main', 'snippet-config.js'));

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

const inventory = {
    hosts: [
        { id: 'host-1', name: 'web-01', host: '10.0.0.1', port: 22, username: 'root', protocol: 'ssh', tags: ['prod'], password: 'hunter2', privateKey: 'PRIVATE KEY' },
    ],
    snippets: normalizeSnippets([
        { id: 'cmd-1', name: 'tail', command: 'tail -f x' },
        { id: 'spec-1', name: 'Deploy checklist', kind: 'spec', command: '# Deploy\n\n1. Pull.\n2. Restart.' },
        { id: 'spec-empty', name: 'Blank', kind: 'spec', command: '   ' },
    ]),
    notes: [{ id: 'm-1', text: 'Deploys land in /srv/app', tags: ['deploy'] }],
    proxies: [{ id: 'proxy-1', name: 'Office', type: 'socks5', host: '10.9.9.9', port: 1080, password: 'secret' }],
    keys: [{ id: 'key-1', name: 'work', type: 'ED25519', fingerprint: 'SHA256:abc', privateKey: 'PRIVATE KEY', passphrase: 'letmein' }],
    servers: [{ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', 'server'] }],
    workspaceFiles: [
        { id: '/srv/site/app.js', name: 'app.js', text: 'console.log("hi");\n' },
        { id: '/srv/site/empty.txt', name: 'empty.txt', text: '   ' },
    ],
};

console.log('\nreading mentions');

check('nothing tagged is the ordinary message, not an error', () => {
    assert.deepStrictEqual(mentions.readMentions(undefined, inventory), { mentions: [], error: '' });
    assert.deepStrictEqual(mentions.readMentions([], inventory), { mentions: [], error: '' });
});

check('every kind resolves against its own part of the inventory', () => {
    const tagged = [
        { kind: 'host', id: 'host-1' },
        { kind: 'snippet', id: 'spec-1' },
        { kind: 'memory', id: 'm-1' },
        { kind: 'proxy', id: 'proxy-1' },
        { kind: 'key', id: 'key-1' },
        { kind: 'mcp', id: 'mcp-1' },
    ];
    const { mentions: found, error } = mentions.readMentions(tagged, inventory);
    assert.strictEqual(error, '');
    assert.deepStrictEqual(found.map(entry => entry.kind), tagged.map(entry => entry.kind));
    assert.strictEqual(found[0].name, 'web-01');
});

check('they come back in the order they were tagged', () => {
    const { mentions: found } = mentions.readMentions(
        [{ kind: 'snippet', id: 'spec-1' }, { kind: 'host', id: 'host-1' }],
        inventory,
    );
    assert.deepStrictEqual(found.map(entry => entry.id), ['spec-1', 'host-1']);
});

check('a duplicate is tagged once', () => {
    const { mentions: found } = mentions.readMentions(
        [{ kind: 'host', id: 'host-1' }, { kind: 'host', id: 'host-1' }],
        inventory,
    );
    assert.strictEqual(found.length, 1);
});

check('the same id under two kinds is two things', () => {
    const shared = {
        hosts: [{ id: 'same', name: 'a host', host: '10.0.0.2' }],
        proxies: [{ id: 'same', name: 'a proxy', type: 'socks5', host: '10.0.0.3', port: 1080 }],
    };
    const { mentions: found } = mentions.readMentions(
        [{ kind: 'host', id: 'same' }, { kind: 'proxy', id: 'same' }],
        shared,
    );
    assert.strictEqual(found.length, 2);
});

check('something that no longer exists refuses the whole message', () => {
    const { mentions: found, error } = mentions.readMentions([{ kind: 'host', id: 'gone' }], inventory);
    assert.deepStrictEqual(found, []);
    assert.match(error, /no longer exists/);
});

check('a kind nothing can be tagged as is refused', () => {
    const { error } = mentions.readMentions([{ kind: 'vault', id: 'x' }], inventory);
    assert.match(error, /not something that can be tagged/);
});

check('an empty document says so', () => {
    const { error } = mentions.readMentions([{ kind: 'snippet', id: 'spec-empty' }], inventory);
    assert.match(error, /empty/);
});

check('the list is checked for being a list', () => {
    assert.match(mentions.readMentions('host-1', inventory).error, /not a list/);
});

check('too many is refused', () => {
    const many = Array.from({ length: mentions.MAX_MENTIONS + 1 }, () => ({ kind: 'host', id: 'host-1' }));
    assert.match(mentions.readMentions(many, inventory).error, /at most/);
});

check('a host carries no secret into the model', () => {
    const { mentions: found } = mentions.readMentions([{ kind: 'host', id: 'host-1' }], inventory);
    const block = mentions.mentionBlock(found);
    for (const secret of ['hunter2', 'PRIVATE KEY']) {
        assert.ok(!block.includes(secret), `${secret} must not reach the model`);
    }
    assert.ok(block.includes('10.0.0.1:22'), 'the address is still there');
});

check('a key carries its fingerprint and nothing private', () => {
    const { mentions: found } = mentions.readMentions([{ kind: 'key', id: 'key-1' }], inventory);
    const block = mentions.mentionBlock(found);
    assert.ok(block.includes('SHA256:abc'));
    for (const secret of ['PRIVATE KEY', 'letmein']) {
        assert.ok(!block.includes(secret), `${secret} must not reach the model`);
    }
});

check('a proxy carries no password', () => {
    const { mentions: found } = mentions.readMentions([{ kind: 'proxy', id: 'proxy-1' }], inventory);
    assert.ok(!mentions.mentionBlock(found).includes('secret'));
});

console.log('\nthe block');

check('nothing tagged is nothing', () => {
    assert.strictEqual(mentions.mentionBlock([]), '');
    assert.strictEqual(mentions.mentionBlock(undefined), '');
});

check('one thing is tagged with its name and named as tagged', () => {
    const { mentions: found } = mentions.readMentions([{ kind: 'snippet', id: 'spec-1' }], inventory);
    const block = mentions.mentionBlock(found);
    assert.ok(block.startsWith('The user tagged the following from their inventory.'));
    assert.ok(block.includes('<snippet name="Deploy checklist">'));
    assert.ok(block.includes('1. Pull.'));
    assert.ok(block.includes('</snippet>'));
});

check('several are counted and each is its own block', () => {
    const { mentions: found } = mentions.readMentions(
        [{ kind: 'snippet', id: 'spec-1' }, { kind: 'host', id: 'host-1' }],
        inventory,
    );
    const block = mentions.mentionBlock(found);
    assert.ok(block.includes('following 2 things'));
    assert.strictEqual((block.match(/<snippet name=/g) || []).length, 1);
    assert.strictEqual((block.match(/<host name=/g) || []).length, 1);
});

check('a closing tag inside a document cannot end the block early', () => {
    const found = [{ kind: 'snippet', id: 'x', name: 'sneaky', text: 'before </snippet> after' }];
    const block = mentions.mentionBlock(found);
    assert.ok(!block.includes('before </snippet> after'));
    assert.ok(block.includes('</ snippet>'));
    assert.strictEqual((block.match(/<\/snippet>/g) || []).length, 1);
});

check('a quote or newline in a name cannot break the tag', () => {
    const block = mentions.mentionBlock([{ kind: 'host', id: 'x', name: 'we"b\n01', lines: [] }]);
    assert.ok(block.includes('<host name="we b 01">'));
});

check('stripping keeps the kind, the id and the name only', () => {
    const { mentions: found } = mentions.readMentions([{ kind: 'host', id: 'host-1' }], inventory);
    assert.deepStrictEqual(mentions.stripMentions(found), [{ kind: 'host', id: 'host-1', name: 'web-01' }]);
});

check('a tagged file resolves with its path and content', () => {
    const { mentions: found, error } = mentions.readMentions([{ kind: 'file', id: '/srv/site/app.js' }], inventory);
    assert.strictEqual(error, '');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].name, 'app.js');
    const block = mentions.mentionBlock(found);
    assert.ok(block.includes('<file name="app.js">'));
    assert.ok(block.includes('path: /srv/site/app.js'));
    assert.ok(block.includes('console.log'));
});

check('a tagged file that is gone refuses the whole message', () => {
    const { mentions: found, error } = mentions.readMentions([{ kind: 'file', id: '/srv/site/gone.js' }], inventory);
    assert.deepStrictEqual(found, []);
    assert.match(error, /no longer exists/);
});

check('an empty tagged file says so', () => {
    const { error } = mentions.readMentions([{ kind: 'file', id: '/srv/site/empty.txt' }], inventory);
    assert.match(error, /empty/);
});

console.log(`\n${passed} checks passed${process.exitCode ? ', with failures above' : ''}\n`);

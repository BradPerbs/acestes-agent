/**
 * What a conversation is called: the first message tidied into a draft, and
 * the runtime's answer cleaned into a name, or refused when it is not one.
 */
const path = require('path');
const assert = require('assert');

const titles = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'titles'));

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
}

async function checkAsync(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
}

async function main() {
    console.log('titles');

    const { clean } = titles._test;

    check('the draft drops the greeting and the asking', () => {
        assert.strictEqual(titles.fromMessage('Hi! Could you please check disk usage on db-02? It alerted at 3am.'), 'Check disk usage on db-02');
        assert.strictEqual(titles.fromMessage('hey, can you restart nginx on web-01'), 'Restart nginx on web-01');
        assert.strictEqual(titles.fromMessage('I need you to rotate the SSH keys'), 'Rotate the SSH keys');
    });

    check('a long draft is cut at a word, with an ellipsis', () => {
        const draft = titles.fromMessage('set up nightly postgres backups to s3 for all the prod databases and make sure they rotate');
        assert.ok(draft.length <= titles.MAX_LENGTH, draft);
        assert.ok(draft.endsWith('…'), draft);
        assert.ok(!/\s…$/.test(draft), 'no space before the ellipsis');
    });

    check('a message that is only a greeting is still a draft, and too thin to name', () => {
        assert.strictEqual(titles.fromMessage('hi'), 'Hi');
        assert.strictEqual(titles.tooThin('hi'), true);
        assert.strictEqual(titles.tooThin('hey there'), true);
        assert.strictEqual(titles.tooThin('rotate ssh keys'), false);
    });

    check('an answer loses its label, quotes, bold and full stop', () => {
        assert.strictEqual(clean('Title: "Fix 502 errors on web-01".'), 'Fix 502 errors on web-01');
        assert.strictEqual(clean('**Disk usage alert on db-02**'), 'Disk usage alert on db-02');
        assert.strictEqual(clean('# Port 8080 on staging\n\nExtra words'), 'Port 8080 on staging');
    });

    check('a local model thinking out loud is not the name', () => {
        assert.strictEqual(clean('<think>They want backups.</think>\nNightly Postgres backups to S3'), 'Nightly Postgres backups to S3');
        assert.strictEqual(clean('<think>still thinking when it was cut off'), '');
    });

    check('an answer to the request instead of a name is refused', () => {
        assert.strictEqual(clean('Sure! I can help with that. First, let me check the nginx logs on the server and see.'), '');
        assert.strictEqual(clean(''), '');
    });

    await checkAsync('a runtime that cannot be asked, or that fails, gives no name', async () => {
        assert.strictEqual(await titles.generate({}, { settings: {}, messages: ['check disk on db-02'] }), '');
        const failing = { title: async () => { throw new Error('offline'); } };
        assert.strictEqual(await titles.generate(failing, { settings: {}, messages: ['check disk on db-02'] }), '');
    });

    await checkAsync('the runtime is shown the messages and told what to answer', async () => {
        let asked = null;
        const provider = { title: async (request) => { asked = request; return 'Disk usage on db-02.'; } };
        const name = await titles.generate(provider, { settings: { model: 'm' }, messages: ['hi', 'check disk on db-02'] });
        assert.strictEqual(name, 'Disk usage on db-02');
        assert.deepStrictEqual(asked.settings, { model: 'm' });
        assert.ok(asked.prompt.includes('User: hi') && asked.prompt.includes('User: check disk on db-02'));
        assert.ok(/title/i.test(asked.instruction));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

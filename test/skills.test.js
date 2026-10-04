/**
 * Slash skills: `SKILL.md` folders from ~/.claude/skills and ~/.agents/skills,
 * listed as metadata for the `/` picker and resolved to their instructions
 * when invoked.
 */
const assert = require('assert');
const path = require('path');

const skills = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'skills.js'));
const mentions = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'mentions.js'));

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

console.log('\nslash skills');

check('frontmatter reads the fields the picker shows', () => {
    const front = skills.parseFrontmatter('---\nname: seo\ndescription: "Site audits"\nargument-hint: "[url]"\n---\n\n# body');
    assert.strictEqual(front.name, 'seo');
    assert.strictEqual(front.description, 'Site audits');
    assert.strictEqual(front['argument-hint'], '[url]');
});

check('a file without frontmatter lists under its directory name', () => {
    assert.deepStrictEqual(skills.parseFrontmatter('# just a body'), {});
});

check('the list carries no instruction text', () => {
    for (const entry of skills.list()) {
        assert.ok(entry.id, 'an id');
        assert.ok(entry.name, 'a name');
        assert.strictEqual(entry.text, undefined, `${entry.id} must not carry its text`);
    }
});

check('an unknown skill is nothing to resolve', () => {
    assert.strictEqual(skills.get('no-such-skill-xyz'), null);
});

check('every listed skill resolves to instructions', () => {
    for (const entry of skills.list()) {
        const full = skills.get(entry.id);
        assert.ok(full, `${entry.id} resolves`);
        assert.ok(String(full.text).trim().length > 0, `${entry.id} has instructions`);
    }
});

check('a skill is tagged and spelled into the prompt as one', () => {
    const full = skills.list().map(entry => skills.get(entry.id)).filter(Boolean)[0];
    if (!full) {
        console.log('       (no skills installed; skipped)');
        return;
    }
    const { mentions: found, error } = mentions.readMentions(
        [{ kind: 'skill', id: full.id }],
        { skills: [full] },
    );
    assert.strictEqual(error, '');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].kind, 'skill');
    const block = mentions.mentionBlock(found);
    assert.ok(block.includes('<skill name='), 'a skill block names the skill');
});

check('a skill that no longer exists refuses the whole message', () => {
    const { mentions: found, error } = mentions.readMentions([{ kind: 'skill', id: 'gone' }], { skills: [] });
    assert.deepStrictEqual(found, []);
    assert.match(error, /no longer exists/);
});

console.log(`\n${passed} checks passed\n`);

/**
 * Document attachments: Office and OpenDocument text extraction, RTF
 * stripping, and the text-likeness sniff that lets any text-like file
 * through. `office.js` touches no DOM, so it all runs under plain node.
 */
const assert = require('assert');
const { zipSync, strToU8 } = require('fflate');

const office = require('../src/renderer/lib/office');

let passed = 0;
let failed = 0;
const check = async (label, fn) => {
    try {
        await fn();
        console.log(`  ok   ${label}`);
        passed++;
    } catch (error) {
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.stack || error.message}`);
        failed++;
    }
};

/** A ZIP of the given `path` to XML text map, as bytes. */
const zipOf = (entries) => {
    const files = {};
    for (const [path, xml] of Object.entries(entries)) files[path] = strToU8(xml);
    return zipSync(files);
};

const officeFile = (bytes, name, type = '') => new File([bytes], name, { type });

const DOCX_BODY = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>World</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>A</w:t></w:r><w:r><w:t xml:space="preserve"> B</w:t></w:r><w:r><w:tab/><w:t>C</w:t></w:r></w:p>'
    + '</w:body></w:document>';

(async () => {
    console.log('\nassistant attachments');

    await check('documents are recognised by extension and by type', () => {
        assert.strictEqual(office.officeKind({ name: 'memo.docx', type: '' }), 'word');
        assert.strictEqual(office.officeKind({ name: 'DECK.PPTX', type: '' }), 'slides');
        assert.strictEqual(office.officeKind({ name: 'grid.xlsx', type: 'application/octet-stream' }), 'sheets');
        assert.strictEqual(office.officeKind({ name: 'essay.odt', type: '' }), 'odt');
        assert.strictEqual(office.officeKind({ name: 'grid.ods', type: '' }), 'ods');
        assert.strictEqual(office.officeKind({ name: 'deck.odp', type: '' }), 'odp');
        assert.strictEqual(
            office.officeKind({ name: 'renamed.bin', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
            'word',
            'a renamed file is caught by its type',
        );
        assert.strictEqual(office.officeKind({ name: 'notes.txt', type: 'text/plain' }), '');
        assert.strictEqual(office.officeKind({ name: 'old.doc', type: 'application/msword' }), '', 'legacy OLE stays out');
        assert.strictEqual(office.officeKind(null), '');
        assert.strictEqual(office.isOfficeFile({ name: 'a.docx' }), true);
        assert.strictEqual(office.isOfficeFile({ name: 'a.pdf' }), false);
    });

    await check('entities unescape', () => {
        assert.strictEqual(office.unescapeXml('&lt;a&amp;b&gt; &#65; &#x42; &quot;q&quot;'), '<a&b> A B "q"');
    });

    await check('a docx reads runs, lists, tabs and headers', async () => {
        const bytes = zipOf({
            'word/document.xml': DOCX_BODY,
            'word/header1.xml': '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Acme Corp</w:t></w:r></w:p></w:body></w:document>',
        });
        const text = await office.extractOfficeText(officeFile(bytes, 'memo.docx'), 'word');
        assert.strictEqual(text, 'Hello World\n- First item\nA B\tC\n\nAcme Corp');
    });

    await check('a docx without words is empty, and junk is no document', async () => {
        const bare = zipOf({ 'word/document.xml': '<w:document xmlns:w="x"><w:body><w:p></w:p></w:body></w:document>' });
        await assert.rejects(office.extractOfficeText(officeFile(bare, 'bare.docx')), /empty/);
        const junk = zipOf({ 'other.txt': 'hi' });
        await assert.rejects(office.extractOfficeText(officeFile(junk, 'junk.docx')), /empty/);
        await assert.rejects(office.extractOfficeText(officeFile(strToU8('not a zip'), 'fake.docx')), /not office/);
    });

    await check('a pptx reads slide by slide, in order', async () => {
        const slide = (title, body) => '<p:sld xmlns:p="x" xmlns:a="y"><p:cSld><p:spTree>'
            + `<p:nvSp><p:cNvPr name="${title}"/></p:nvSp><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p>`
            + (body ? `<a:p><a:r><a:t>${body}</a:t></a:r></a:p>` : '')
            + '</p:txBody></p:spTree></p:cSld></p:sld>';
        const bytes = zipOf({
            'ppt/slides/slide2.xml': slide('Second', ''),
            'ppt/slides/slide1.xml': slide('Title One', 'Body &amp; soul'),
            'ppt/slides/slide10.xml': slide('Tenth', ''),
        });
        const text = await office.extractOfficeText(officeFile(bytes, 'deck.pptx'), 'slides');
        assert.strictEqual(text, '--- Slide 1 ---\nTitle One\nBody & soul\n\n--- Slide 2 ---\nSecond\n\n--- Slide 10 ---\nTenth');
    });

    await check('an xlsx resolves shared strings and names sheets via rels', async () => {
        const bytes = zipOf({
            'xl/sharedStrings.xml': '<sst xmlns="x"><si><t>Name</t></si><si><t>First</t><t> Last</t></si></sst>',
            'xl/_rels/workbook.xml.rels': '<Relationships xmlns="x">'
                + '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
                + '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>'
                + '</Relationships>',
            'xl/workbook.xml': '<workbook xmlns="x" xmlns:r="y"><sheets>'
                + '<sheet name="Second" sheetId="2" r:id="rId2"/>'
                + '<sheet name="First" sheetId="1" r:id="rId1"/>'
                + '</sheets></workbook>',
            'xl/worksheets/sheet1.xml': '<worksheet xmlns="x"><sheetData>'
                + '<row r="1"><c r="A1" t="inlineStr"><is><t>Hi</t></is></c><c r="C1"><v>42</v></c></row>'
                + '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="e"><v>15</v></c></row>'
                + '</sheetData></worksheet>',
            'xl/worksheets/sheet2.xml': '<worksheet xmlns="x"><sheetData>'
                + '<row r="1"><c r="A1" t="s"><v>1</v></c></row>'
                + '</sheetData></worksheet>',
        });
        const text = await office.extractOfficeText(officeFile(bytes, 'grid.xlsx'), 'sheets');
        assert.strictEqual(text, '--- Second ---\nFirst Last\n\n--- First ---\nHi |  | 42\nName | TRUE');
    });

    await check('an odt reads spans and tabs', async () => {
        const bytes = zipOf({
            'content.xml': '<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text>'
                + '<text:p>Hello <text:span text:style-name="T1">brave</text:span> world</text:p>'
                + '<text:p>Second<text:tab/>line</text:p>'
                + '</office:text></office:body></office:document-content>',
            'mimetype': 'application/vnd.oasis.opendocument.text',
        });
        const text = await office.extractOfficeText(officeFile(bytes, 'essay.odt'), 'odt');
        assert.strictEqual(text, 'Hello brave world\nSecond\tline');
    });

    await check('an ods reads sheets, skips covered cells and empty rows', async () => {
        const bytes = zipOf({
            'content.xml': '<office:document-content xmlns:table="tb" xmlns:text="t"><office:body><office:spreadsheet>'
                + '<table:table table:name="Sales">'
                + '<table:table-row><table:table-cell><text:p>Item</text:p></table:table-cell>'
                + '<table:table-cell><text:p>Qty</text:p></table:table-cell></table:table-row>'
                + '<table:table-row><table:table-cell><text:p>Apples</text:p></table:table-cell>'
                + '<table:covered-table-cell/></table:table-row>'
                + '<table:table-row><table:table-cell table:number-columns-repeated="3"/></table:table-row>'
                + '</table:table>'
                + '</office:spreadsheet></office:body></office:document-content>',
        });
        const text = await office.extractOfficeText(officeFile(bytes, 'grid.ods'), 'ods');
        assert.strictEqual(text, '--- Sales ---\nItem | Qty\nApples');
    });

    await check('an odp reads pages as slides', async () => {
        const bytes = zipOf({
            'content.xml': '<office:document-content xmlns:draw="d" xmlns:text="t"><office:body><office:presentation>'
                + '<draw:page draw:name="p1"><text:p>Opening</text:p></draw:page>'
                + '<draw:page draw:name="p2"><text:p>Closing <text:span>words</text:span></text:p></draw:page>'
                + '</office:presentation></office:body></office:document-content>',
        });
        const text = await office.extractOfficeText(officeFile(bytes, 'deck.odp'), 'odp');
        assert.strictEqual(text, '--- Slide 1 ---\nOpening\n\n--- Slide 2 ---\nClosing words');
    });

    await check('RTF strips to words, and plain text is no RTF', () => {
        const rtf = '{\\rtf1\\ansi Hello \\b bold\\b0  world\\par Next\\tab line\\par}';
        assert.strictEqual(office.stripRtf(rtf), 'Hello bold world\nNext\tline');
        assert.strictEqual(office.stripRtf('just text'), null);
        assert.strictEqual(office.stripRtf('{\\RTF1\\ansi upper}'), 'upper');
    });

    await check('text-likeness sniffs binary from words', () => {
        assert.strictEqual(office.looksLikeText('Hello, world!\nSecond line with caf\u00e9 \u{1F600}'), true);
        assert.strictEqual(office.looksLikeText(''), false);
        assert.strictEqual(office.looksLikeText('abc\u0000def'), false);
        assert.strictEqual(office.looksLikeText('ok\x07bell ' + 'x'.repeat(200)), true, 'a stray control in a long text is forgiven');
        assert.strictEqual(office.looksLikeText('a\x01b\x02c\x03d\x04e\x05f'), false);
        assert.strictEqual(office.looksLikeText('half �\uFFFD� broken �\uFFFD� bytes �\uFFFD� here'), false);
    });

    await check('columns line up: A, Z, AA', () => {
        assert.strictEqual(office.columnIndex('A1'), 0);
        assert.strictEqual(office.columnIndex('Z9'), 25);
        assert.strictEqual(office.columnIndex('AA1'), 26);
        assert.strictEqual(office.columnIndex('C3'), 2);
    });

    await check('the media type follows the file', () => {
        assert.strictEqual(
            office.officeMediaType({ name: 'a.docx', type: '' }),
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        );
        assert.strictEqual(office.officeMediaType({ name: 'a.bin', type: 'Application/X-Custom' }), 'application/x-custom');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();

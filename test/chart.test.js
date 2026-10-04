/**
 * The ```chart fence: what reads as a chart, what falls back to code, and the
 * arithmetic the drawing leans on. The module is ESM for the bundler, so it is
 * imported dynamically, as in the reducer's test.
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { pathToFileURL } = require('url');

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

const json = value => JSON.stringify(value);

async function main() {
    const spec = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'chart-spec.js')).href);
    const { parseChart, niceScale, formatValue, labelIndexes, meterState, toCsv, extent } = spec;

    console.log('\nchart spec');

    check('the bar shorthand reads as one series', () => {
        const { chart, error } = parseChart(json({
            type: 'bar', title: 'Disk use', unit: '%',
            data: [{ label: '/', value: 42 }, { label: '/var', value: 87 }],
        }));
        assert.strictEqual(error, undefined);
        assert.strictEqual(chart.type, 'bar');
        assert.deepStrictEqual(chart.labels, ['/', '/var']);
        assert.strictEqual(chart.series.length, 1);
        assert.deepStrictEqual(chart.series[0].values, [42, 87]);
        assert.strictEqual(chart.unit, '%');
    });

    check('a line with series is fitted to its labels, gaps kept as null', () => {
        const { chart } = parseChart(json({
            type: 'line', labels: ['a', 'b', 'c'],
            series: [{ name: 'web1', values: [1, 2] }, { name: 'web2', values: [3, null, 5, 9] }],
        }));
        assert.deepStrictEqual(chart.series[0].values, [1, 2, null]);
        assert.deepStrictEqual(chart.series[1].values, [3, null, 5]);
    });

    check('numbers written as strings are read, thousands commas and all', () => {
        const { chart } = parseChart(json({ type: 'bar', data: [{ label: 'x', value: '1,284' }] }));
        assert.deepStrictEqual(chart.series[0].values, [1284]);
    });

    check('type defaults to bar', () => {
        assert.strictEqual(parseChart(json({ data: [{ label: 'x', value: 1 }] })).chart.type, 'bar');
    });

    check('half a JSON object is an error, not a chart', () => {
        assert.match(parseChart('{"type":"bar","data":[{"label":"/","va').error, /not valid JSON/);
    });

    check('an unknown type is named in the error', () => {
        assert.match(parseChart(json({ type: 'radar', data: [{ label: 'x', value: 1 }] })).error, /"radar"/);
    });

    check('the names models reach for are read as the form they mean', () => {
        assert.strictEqual(parseChart(json({ type: 'pie', data: [{ label: 'x', value: 1 }] })).chart.type, 'donut');
        assert.strictEqual(parseChart(json({ type: 'gantt', data: [{ label: 'x', start: '01:00', end: '02:00' }] })).chart.type, 'timeline');
        const stacked = parseChart(json({ type: 'stacked-area', labels: ['a', 'b'], series: [{ values: [1, 2] }, { values: [3, 4] }] })).chart;
        assert.strictEqual(stacked.type, 'area');
        assert.strictEqual(stacked.stacked, true);
    });

    check('a word where a number belongs is refused', () => {
        assert.match(parseChart(json({ type: 'bar', data: [{ label: 'x', value: 'lots' }] })).error, /not a number/);
    });

    check('a chart of nothing but gaps is refused', () => {
        assert.match(parseChart(json({ type: 'line', labels: ['a'], series: [{ name: 's', values: [null] }] })).error, /no numbers/);
    });

    check('series without labels is refused', () => {
        assert.match(parseChart(json({ type: 'line', series: [{ values: [1] }] })).error, /labels/);
    });

    check('negative bars are refused, with lines suggested', () => {
        assert.match(parseChart(json({ type: 'bar', data: [{ label: 'x', value: -1 }] })).error, /line/);
    });

    check('a ninth line series is refused rather than given an unchecked colour', () => {
        const series = Array.from({ length: 9 }, (_, index) => ({ name: `s${index}`, values: [index] }));
        assert.match(parseChart(json({ type: 'line', labels: ['a'], series })).error, /at most 8/);
    });

    check('grouped bars stop at four series', () => {
        const series = Array.from({ length: 5 }, (_, index) => ({ name: `s${index}`, values: [index] }));
        assert.match(parseChart(json({ type: 'bar', labels: ['a'], series })).error, /at most 4/);
    });

    check('meters take a max per row, or 100 for percent', () => {
        const rows = parseChart(json({ type: 'meter', unit: 'GB', data: [{ label: '/var', value: 43, max: 50 }] })).chart;
        assert.deepStrictEqual(rows.maxes, [50]);
        const percent = parseChart(json({ type: 'meter', unit: '%', data: [{ label: '/', value: 91 }] })).chart;
        assert.deepStrictEqual(percent.maxes, [100]);
        assert.deepStrictEqual(percent.thresholds, [80, 90]);
    });

    check('a meter with no max is refused', () => {
        assert.match(parseChart(json({ type: 'meter', unit: 'GB', data: [{ label: '/var', value: 43 }] })).error, /max/);
    });

    check('meter state follows the thresholds', () => {
        assert.strictEqual(meterState(40, 50), 'warning');
        assert.strictEqual(meterState(46, 50), 'critical');
        assert.strictEqual(meterState(10, 50), 'normal');
        assert.strictEqual(meterState(30, 50, [50, 70]), 'warning');
    });

    check('the value axis starts at zero and ends on a round number', () => {
        const scale = niceScale(3, 87);
        assert.strictEqual(scale.min, 0);
        assert.strictEqual(scale.max, 100);
        assert.deepStrictEqual(scale.ticks, [0, 25, 50, 75, 100]);
    });

    check('small steps do not drift into float noise', () => {
        const { ticks } = niceScale(0, 0.3);
        assert.ok(ticks.every(tick => String(tick).length <= 4), ticks.join(' '));
    });

    check('a given min is kept, and a flat series still gets a scale', () => {
        assert.strictEqual(niceScale(7.1, 7.3, { min: 7 }).min, 7);
        const flat = niceScale(5, 5);
        assert.ok(flat.max > flat.min);
    });

    check('negative values pull the axis below zero', () => {
        const scale = niceScale(-12, 30);
        assert.ok(scale.min <= -12 && scale.ticks.includes(0));
    });

    check('values are written compactly, with the unit after', () => {
        assert.strictEqual(formatValue(1284), '1,284');
        assert.strictEqual(formatValue(12873.4567), '12.9K');
        assert.strictEqual(formatValue(4200000, 'B'), '4.2M B');
        assert.strictEqual(formatValue(42, '%'), '42%');
        assert.strictEqual(formatValue(0.456, 'ms'), '0.456 ms');
        assert.strictEqual(formatValue(null), '–');
    });

    check('the foot keeps its first and last label and thins the rest', () => {
        const shown = labelIndexes(60, 5);
        assert.strictEqual(shown[0], 0);
        assert.strictEqual(shown[shown.length - 1], 59);
        assert.ok(shown.length <= 5);
        assert.deepStrictEqual(labelIndexes(3, 10), [0, 1, 2]);
        // Evenly spaced: never two neighbours printed side by side mid-axis.
        for (const [count, slots] of [[24, 17], [24, 9], [60, 7], [100, 13]]) {
            const picked = labelIndexes(count, slots);
            const gaps = picked.slice(1).map((index, at) => index - picked[at]);
            const step = gaps[0];
            assert.ok(gaps.slice(0, -1).every(gap => gap === step), `${count}/${slots}: ${picked}`);
            assert.ok(gaps[gaps.length - 1] >= step * 0.6, `${count}/${slots}: last gap ${gaps[gaps.length - 1]}`);
            assert.ok(picked.length <= slots + 1, `${count}/${slots}: ${picked.length} labels`);
        }
    });

    check('the smooth curve never leaves the range of its data', () => {
        // A sharp spike between flat runs: a plain spline swings below the floor here.
        const points = [[0, 100], [10, 100], [20, 10], [30, 100], [40, 100], [50, 60]];
        const path = spec.smoothPath(points);
        const ys = [...path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(match => Number(match[2]));
        assert.ok(ys.every(value => value >= 10 - 0.01 && value <= 100 + 0.01), `control points out of range: ${ys}`);
        assert.ok(path.startsWith('M0.0,100.0C'), path);
    });

    check('short runs draw as a point or a straight line', () => {
        assert.strictEqual(spec.smoothPath([[1, 2]]), 'M1.0,2.0');
        assert.strictEqual(spec.smoothPath([[1, 2], [3, 4]]), 'M1.0,2.0L3.0,4.0');
        assert.strictEqual(spec.smoothPath([]), '');
    });

    check('runs split a series at its gaps', () => {
        assert.deepStrictEqual(spec.runsOf([1, 2, null, 4, null, null, 7, 8]), [[0, 1], [3], [6, 7]]);
    });

    check('a one-series line leads with its last value and the change since its first', () => {
        const { chart } = parseChart(json({ type: 'line', labels: ['a', 'b', 'c', 'd'], series: [{ name: 's', values: [null, 50, 60, 75] }] }));
        const lead = spec.headline(chart);
        assert.strictEqual(lead.value, 75);
        assert.strictEqual(lead.since, 'b');
        assert.strictEqual(lead.change, 50);
    });

    check('no headline for several series, or for bars', () => {
        const many = parseChart(json({ type: 'line', labels: ['a'], series: [{ values: [1] }, { values: [2] }] })).chart;
        const bars = parseChart(json({ type: 'bar', data: [{ label: 'a', value: 1 }] })).chart;
        assert.strictEqual(spec.headline(many), null);
        assert.strictEqual(spec.headline(bars), null);
    });

    check('extent skips gaps', () => {
        assert.deepStrictEqual(extent([{ values: [null, 4, 2] }, { values: [9, null] }]), [2, 9]);
    });

    check('CSV quotes what needs it', () => {
        const { chart } = parseChart(json({ type: 'bar', title: 'x', data: [{ label: 'a,b', value: 1 }] }));
        assert.strictEqual(toCsv(chart), 'label,x\n"a,b",1');
    });

    console.log('\nchart forms');

    check('stacked bars may carry the whole palette, grouped bars only four', () => {
        const series = Array.from({ length: 6 }, (_, index) => ({ name: `s${index}`, values: [index + 1] }));
        assert.strictEqual(parseChart(json({ type: 'bar', stacked: true, labels: ['a'], series })).error, undefined);
        assert.match(parseChart(json({ type: 'bar', labels: ['a'], series })).error, /at most 4/);
    });

    check('stacks refuse negative values', () => {
        const spec = { type: 'area', stacked: true, labels: ['a'], series: [{ values: [1] }, { values: [-2] }] };
        assert.match(parseChart(json(spec)).error, /negative/);
    });

    check('stack totals add every series, gaps as zero', () => {
        assert.deepStrictEqual(spec.totals([{ values: [1, null, 3] }, { values: [2, 5, null] }], 3), [3, 5, 3]);
    });

    check('limits and events are read; an event at no label is dropped', () => {
        const { chart } = parseChart(json({
            type: 'line', labels: ['10:00', '10:05', '10:10'], series: [{ values: [1, 2, 3] }],
            limits: [{ value: 2.5, label: 'Alert' }, 4, { value: 'x' }],
            events: [{ at: '10:05', label: 'Deploy' }, { at: 2, label: 'Reboot' }, { at: '11:00', label: 'Nowhere' }],
        }));
        assert.deepStrictEqual(chart.limits, [{ value: 2.5, label: 'Alert' }, { value: 4, label: '' }]);
        assert.deepStrictEqual(chart.events, [{ index: 1, label: 'Deploy' }, { index: 2, label: 'Reboot' }]);
    });

    check('stat tiles take numbers, words, trends and notes', () => {
        const { chart } = parseChart(json({ type: 'stats', data: [
            { label: 'CPU', value: 34, unit: '%', trend: [20, 31, null, 34] },
            { label: 'Uptime', value: '14d 3h', note: 'since reboot' },
        ] }));
        assert.strictEqual(chart.tiles[0].value, 34);
        assert.deepStrictEqual(chart.tiles[0].trend, [20, 31, null, 34]);
        assert.strictEqual(chart.tiles[1].value, null);
        assert.strictEqual(chart.tiles[1].shown, '14d 3h');
        assert.match(parseChart(json({ type: 'stats', data: [{ label: 'x' }] })).error, /no value/);
    });

    check('a donut sorts its slices and folds the tail into Other', () => {
        const data = [3, 9, 1, 7, 5, 2, 4, 8].map((value, index) => ({ label: `s${index}`, value }));
        const { chart } = parseChart(json({ type: 'donut', data }));
        assert.strictEqual(chart.slices.length, 6);
        assert.deepStrictEqual(chart.slices.slice(0, 5).map(slice => slice.value), [9, 8, 7, 5, 4]);
        assert.strictEqual(chart.slices[5].other, true);
        assert.strictEqual(chart.slices[5].value, 6);
        assert.strictEqual(chart.total, 39);
    });

    check('six slices are shown as six, not five and an Other of one', () => {
        const data = [1, 2, 3, 4, 5, 6].map(value => ({ label: `v${value}`, value }));
        assert.ok(!parseChart(json({ type: 'donut', data })).chart.slices.some(slice => slice.other));
    });

    check('a treemap group is the size of its children together', () => {
        const { chart } = parseChart(json({ type: 'treemap', data: [
            { label: '/var/log', value: 31 },
            { label: '/var/lib', children: [{ label: 'docker', value: 12 }, { label: 'mysql', value: 20 }] },
        ] }));
        assert.strictEqual(chart.nodes[0].label, '/var/lib');
        assert.strictEqual(chart.nodes[0].value, 32);
        assert.deepStrictEqual(chart.nodes[0].children.map(child => child.label), ['mysql', 'docker']);
        assert.strictEqual(chart.total, 63);
        assert.strictEqual(chart.nested, true);
    });

    check('squarify fills the box exactly, with no overlaps and fair areas', () => {
        const items = [60, 30, 20, 10, 6, 4].map(value => ({ value }));
        const boxes = spec.squarify(items, 0, 0, 300, 200);
        const total = boxes.reduce((sum, box) => sum + box.width * box.height, 0);
        assert.ok(Math.abs(total - 60000) < 0.5, `area ${total}`);
        boxes.forEach((box, index) => {
            const share = (box.width * box.height) / 60000;
            assert.ok(Math.abs(share - items[index].value / 130) < 1e-6, `box ${index} share ${share}`);
            assert.ok(box.x >= -1e-9 && box.y >= -1e-9 && box.x + box.width <= 300 + 1e-6 && box.y + box.height <= 200 + 1e-6);
        });
        for (let a = 0; a < boxes.length; a += 1) {
            for (let b = a + 1; b < boxes.length; b += 1) {
                const overlapX = Math.min(boxes[a].x + boxes[a].width, boxes[b].x + boxes[b].width) - Math.max(boxes[a].x, boxes[b].x);
                const overlapY = Math.min(boxes[a].y + boxes[a].height, boxes[b].y + boxes[b].height) - Math.max(boxes[a].y, boxes[b].y);
                assert.ok(overlapX <= 1e-6 || overlapY <= 1e-6, `boxes ${a} and ${b} overlap`);
            }
        }
    });

    check('a heatmap is fitted to its axes, gaps kept', () => {
        const { chart } = parseChart(json({ type: 'heatmap', x: ['a', 'b', 'c'], y: ['r1', 'r2'], values: [[1, 2], [3, 4, 5, 6]] }));
        assert.deepStrictEqual(chart.values, [[1, 2, null], [3, 4, 5]]);
        assert.match(parseChart(json({ type: 'heatmap', x: ['a'], y: ['b'] })).error, /values/);
    });

    check('uptime reads status words, and refuses ones it does not know', () => {
        const { chart } = parseChart(json({ type: 'uptime', labels: ['1', '2', '3', '4'], series: [{ name: 'web1', values: ['ok', 'Degraded', 'down', null] }] }));
        assert.deepStrictEqual(chart.series[0].values, ['up', 'degraded', 'down', null]);
        assert.match(parseChart(json({ type: 'uptime', data: [{ label: '1', status: 'sideways' }] })).error, /"sideways" is not a status/);
    });

    check('uptime counts degraded as up and skips the unknown', () => {
        assert.strictEqual(spec.uptimeShare(['up', 'degraded', 'down', null]), (2 / 3) * 100);
        assert.strictEqual(spec.uptimeShare([null, null]), null);
    });

    check('a timeline reads times of day, past midnight, and open spans', () => {
        const { chart } = parseChart(json({ type: 'timeline', data: [
            { label: 'backup', start: '23:30', end: '00:15', status: 'done' },
            { label: 'sync', start: '23:50' },
        ] }));
        assert.strictEqual(chart.clock, true);
        const [backup, sync] = chart.spans;
        assert.strictEqual(backup.end - backup.start, 45 * 60000);
        assert.strictEqual(backup.status, 'ok');
        assert.strictEqual(sync.open, true);
        assert.strictEqual(sync.status, 'running');
        assert.strictEqual(sync.end, backup.end);
    });

    check('a timeline will not mix times of day with dates, or end before it starts', () => {
        assert.match(parseChart(json({ type: 'timeline', data: [{ label: 'a', start: '01:00', end: '2026-10-04T02:00:00Z' }] })).error, /not both/);
        assert.match(parseChart(json({ type: 'timeline', data: [{ label: 'a', start: '2026-10-04T03:00:00Z', end: '2026-10-04T02:00:00Z' }] })).error, /ends before/);
    });

    check('time ticks land on round steps', () => {
        const from = Date.UTC(2026, 9, 4, 1, 7);
        const { step, ticks } = spec.timeTicks(from, from + 3 * 3600000, 4);
        assert.strictEqual(step, 3600000);
        assert.ok(ticks.every(tick => tick % step === 0), ticks.join(' '));
        assert.strictEqual(spec.formatTime(Date.UTC(1970, 0, 1, 14, 5), { clock: true }), '14:05');
    });

    check('durations are said the way people say them', () => {
        assert.strictEqual(spec.formatDuration(45000), '45s');
        assert.strictEqual(spec.formatDuration(12 * 60000), '12m');
        assert.strictEqual(spec.formatDuration(65 * 60000), '1h 05m');
        assert.strictEqual(spec.formatDuration(51 * 3600000), '2d 3h');
    });

    check('every form has a table and a CSV', () => {
        const forms = [
            { type: 'stats', data: [{ label: 'CPU', value: 34, unit: '%' }] },
            { type: 'donut', data: [{ label: 'a', value: 3 }, { label: 'b', value: 1 }] },
            { type: 'treemap', data: [{ label: 'g', children: [{ label: 'c', value: 2 }] }] },
            { type: 'heatmap', x: ['a'], y: ['b'], values: [[1]] },
            { type: 'uptime', data: [{ label: 'd1', status: 'up' }] },
            { type: 'timeline', data: [{ label: 'job', start: '01:00', end: '01:30' }] },
            { type: 'bar', stacked: true, labels: ['a'], series: [{ name: 'x', values: [1] }, { name: 'y', values: [2] }] },
        ];
        for (const form of forms) {
            const { chart, error } = parseChart(json(form));
            assert.strictEqual(error, undefined, `${form.type}: ${error}`);
            const table = spec.tableOf(chart);
            assert.ok(table.rows.length > 0 && table.rows.every(row => row.length === table.header.length), form.type);
            assert.ok(toCsv(chart).split('\n').length === table.rows.length + 1, form.type);
        }
        const donut = parseChart(json(forms[1])).chart;
        assert.strictEqual(toCsv(donut), 'label,Value,Share\na,3,75\nb,1,25');
        const stacked = parseChart(json(forms[6])).chart;
        assert.strictEqual(toCsv(stacked), 'label,x,y,Total\na,1,2,3');
    });

    check('the system prompt teaches the fence', () => {
        const prompt = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai', 'prompt.js'), 'utf8');
        assert.match(prompt, /language is \\`chart\\`/);
        // The examples in the prompt must themselves be charts.
        const examples = prompt.match(/\{"type":"[^\r\n]+?\}(?=\r?\n|$)/g) || [];
        assert.ok(examples.length >= 3, `found ${examples.length} examples`);
        for (const example of examples) {
            const { error } = parseChart(example);
            assert.strictEqual(error, undefined, `${example}: ${error}`);
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exit(1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

/**
 * The transcript's rows as drawn, folded from its items.
 *
 *   tool calls     two or more back to back fold into one `tools` group.
 *   subagents      two or more calls back to back fold into one `subagents`
 *                  group, which opens each one's transcript.
 *   thoughts       never folded. The narration and the thinking between calls
 *                  stand in the transcript on their own and end the group
 *                  above them, so the next calls start a new one. A burst
 *                  reads thought, calls, thought, calls, reply.
 *
 * An assistant message with nothing in it draws as nothing, so it does not
 * split a run in two; it is left out while a run is open.
 *
 * Done here rather than in the reducer, so every answer, result and update
 * still finds its call where it always did. A group is the same object for
 * as long as its members are (`previous` is the last pass's groups by id),
 * which is what lets the transcript segment it sits in tell nothing changed.
 *
 * `enabled` is the "Group tool calls" setting; subagent groups predate it
 * and are not affected by it.
 */

const hasText = item => Boolean(String(item.text || '').trim());
const hasThinking = item => Boolean(String(item.thinking || '').trim());

/** An assistant message with neither words nor thinking in it. */
const isEmptyAssistant = item => item.kind === 'assistant' && !hasText(item) && !hasThinking(item);

/** A call that has been answered: one still waiting is the card above the composer. */
const isAnswered = item => item.kind === 'tool' && item.approval?.status !== 'pending';

export function groupRows(items, { enabled = true, subagentTools = new Set(), previous = new Map() } = {}) {
    const kept = new Map();
    const rows = [];
    let subRun = [];
    let toolRun = [];

    const makeGroup = (kind, run) => {
        const id = `${kind}-${run[0].id}`;
        const old = previous.get(id);
        const same = old && old.items.length === run.length && old.items.every((item, index) => item === run[index]);
        const group = same ? old : { kind, id, items: run };
        kept.set(id, group);
        return group;
    };
    const closeSub = () => {
        if (subRun.length === 1) rows.push(subRun[0]);
        else if (subRun.length > 1) rows.push(makeGroup('subagents', subRun));
        subRun = [];
    };
    const closeTools = () => {
        if (toolRun.length > 1 && enabled) rows.push(makeGroup('tools', toolRun));
        else rows.push(...toolRun);
        toolRun = [];
    };

    for (const item of items) {
        if (isEmptyAssistant(item) && (subRun.length > 0 || (enabled && toolRun.length > 0))) continue;
        if (isAnswered(item) && subagentTools.has(item.name)) {
            closeTools();
            subRun.push(item);
            continue;
        }
        closeSub();
        if (isAnswered(item)) {
            toolRun.push(item);
            continue;
        }
        // A thought, a reply, a notice, a call still waiting: the group
        // above ends here, and the calls after it start a new one.
        closeTools();
        rows.push(item);
    }
    closeSub();
    closeTools();
    return { rows, kept };
}

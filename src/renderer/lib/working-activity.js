/**
 * What the agent is doing right now, for the line under the transcript.
 *
 * Read off what the chat already has: the calls still running, and what the
 * runtime said it is in the middle of (thinking, writing its next call,
 * summarising the history). It asks nothing of the model, so it costs
 * nothing, and it cannot be wrong about which step the turn is on. The words
 * are the component's (WorkingIndicator.jsx); this picks the state and gives
 * it a key, so the clock beside it starts again when the work changes.
 */

/** A desktop action as a live verb, for the chat's working line and the buddy's notch. */
export const DESKTOP_VERBS = {
    click: 'activity.clicking',
    type_text: 'activity.typing',
    press_keys: 'activity.pressing',
    scroll: 'activity.scrolling',
    drag: 'activity.dragging',
    hover: 'activity.pointing',
    mouse_button: 'activity.pressing',
    hold_key: 'activity.holding',
    read_clipboard: 'activity.reading',
    read_screen: 'activity.reading',
    read_text: 'activity.reading',
    screenshot: 'activity.looking',
    zoom: 'activity.looking',
    wait_for: 'activity.waitingFor',
    do_steps: 'activity.steps',
    open_app: 'activity.opening',
    arrange_windows: 'activity.arranging',
    list_windows: 'activity.looking',
};

/**
 * This turn's calls still at work, newest first: running ones, and a
 * subagent sent off in the background, whose call came back at once and
 * whose task is what is still going.
 */
function callsAtWork(items) {
    const running = [];
    const background = [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item.kind === 'user') break;
        if (item.kind !== 'tool') continue;
        if (item.status === 'running') running.push(item);
        else if (item.task?.status === 'running') background.push(item);
    }
    return { running, background };
}

/** One call at work, as the line's state. */
function callState(calls) {
    const call = calls[0];
    return {
        kind: call.task?.status === 'running' ? 'subagent' : 'tool',
        call,
        more: calls.length - 1,
        key: `call:${call.id}`,
    };
}

/**
 * The state the working line shows.
 *
 * A call running comes first: it is what the turn is waiting on. Then what
 * the model is doing, when the runtime said: summarising, writing a call,
 * thinking. Then a background subagent, still at work while the model has
 * nothing to say. With none of those, the turn is waiting on the model's
 * next reply.
 *
 * `kind` is one of tool, subagent, compacting, composing, thinking, waiting.
 * `key` changes when the work does, and only then.
 */
export function workingActivity(items = [], draft = {}) {
    const { running, background } = callsAtWork(items);
    if (running.length > 0) return callState(running);

    const phase = draft?.activity?.phase || '';
    if (phase === 'compacting') return { kind: 'compacting', more: 0, key: 'compacting' };
    if (phase === 'composing') {
        const tool = draft.activity.tool || '';
        return { kind: 'composing', tool, more: 0, key: `composing:${tool}` };
    }
    if (phase === 'thinking') return { kind: 'thinking', more: 0, key: 'thinking' };

    if (background.length > 0) return callState(background);
    return { kind: 'waiting', more: 0, key: 'waiting' };
}

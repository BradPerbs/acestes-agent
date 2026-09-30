import { useMemo, useState } from 'react';
import { ArrowDown01Icon, ArrowUpRight01Icon } from 'hugeicons-react';
import CopyButton from '../ui/CopyButton';
import DiffView from './DiffView';
import { translate, useT } from '../../i18n';

/**
 * One tool call, as a row in the transcript.
 *
 * This is the honest record of what happened on the server, as opposed to the
 * assistant's account of it in prose above. That is why the output is here at
 * all and why it opens: when the summary says a service came back up, this is
 * where you check.
 *
 * Collapsed by default and kept to a single line, because a working answer is
 * usually several calls and nobody wants to scroll past a full `systemctl
 * status` to reach the conclusion. A failure opens itself, since that is the
 * one people always go looking for.
 */

const TITLES = {
    list_hosts: 'assistant.didListHosts',
    list_sessions: 'assistant.didListSessions',
    read_terminal: 'assistant.didReadTerminal',
    run_command: 'assistant.didRun',
    send_input: 'assistant.didType',
    list_directory: 'assistant.didList',
    read_file: 'assistant.didRead',
    write_file: 'assistant.didWrite',
    connect_host: 'assistant.didConnect',
    disconnect_session: 'assistant.didDisconnect',
    remember: 'assistant.didRemember',
    recall: 'assistant.didRecall',
    forget: 'assistant.didForget',
    list_snippets: 'assistant.didListSnippets',
    read_snippet: 'assistant.didReadSnippet',
    list_inventory: 'assistant.didListInventory',
    save_snippet: 'assistant.didSaveSnippet',
    save_host: 'assistant.didSaveHost',
    save_proxy: 'assistant.didSaveProxy',
    save_key: 'assistant.didSaveKey',
    save_mcp_server: 'assistant.didSaveServer',
    save_folder: 'assistant.didSaveFolder',
    delete_inventory_item: 'assistant.didDeleteItem',
    edit_file: 'assistant.didEdit',
    edit_local_file: 'assistant.didEdit',
    search_local_files: 'assistant.didSearchFiles',
    search_conversations: 'assistant.didSearchConversations',
    read_conversation: 'assistant.didReadConversation',
    ask_user: 'assistant.didAsk',
    delegate: 'assistant.didDelegate',
    fan_out: 'assistant.didFanOut',
    start_task: 'assistant.didStartTask',
    new_conversation: 'assistant.didNewConversation',
    branch_conversation: 'assistant.didBranchConversation',
    open_conversation: 'assistant.didOpenConversation',
    message_conversation: 'assistant.didMessageConversation',
    check_conversations: 'assistant.didCheckConversations',
    list_windows: 'assistant.didListWindows',
    open_app: 'assistant.didOpenApp',
    read_screen: 'assistant.didReadScreen',
    click: 'assistant.didClick',
    type_text: 'assistant.didType',
    press_keys: 'assistant.didPressKeys',
    scroll: 'assistant.didScroll',
    drag: 'assistant.didDrag',
    wait_for: 'assistant.didWaitFor',
    read_text: 'assistant.didReadText',
    do_steps: 'assistant.didSteps',
    arrange_windows: 'assistant.didArrange',
    screenshot: 'assistant.didScreenshot',
    zoom: 'assistant.didZoom',
    solve_captcha: 'assistant.didSolveCaptcha',
};

/** Where a computer action was aimed: an element from the last read, or a point. */
function aimedAt(element, x, y) {
    if (element) return `element ${element}`;
    if (x !== undefined && y !== undefined) return `${x}, ${y}`;
    return '';
}

/**
 * The calls whose result names a conversation they started, which the row
 * can open. A delegated run is out of sight by design; this is the way in.
 */
const STARTS = new Set([
    'delegate', 'fan_out', 'start_task', 'new_conversation', 'branch_conversation', 'message_conversation',
]);

/** The conversations a finished call started, from its result. */
function startedConversations(item) {
    if (!STARTS.has(item.name) || !item.result || item.isError) return [];
    const ids = new Set();
    for (const match of item.result.matchAll(/"conversationId":\s*"([^"]+)"/g)) ids.add(match[1]);
    return [...ids];
}

/** The dot carries the status, so the row height never changes with it. */
const DOTS = {
    running: 'bg-blue-500 animate-pulse',
    waiting: 'bg-amber-500',
    error: 'bg-red-500',
    done: 'bg-emerald-500',
};

/**
 * A call that was put to the user and turned down.
 *
 * It never ran, so the row does not get to say "Ran". This is also the state
 * the approval card collapses into once it is answered, which is why the shape
 * is identical: the same row, still naming the same command.
 */
const REFUSED = {
    denied: 'assistant.declined',
    expired: 'assistant.timedOut',
};

/** The one line that says what this call actually was. */
export function describeCall(name, input = {}) {
    switch (name) {
        case 'run_command':
            return { mono: true, text: input.command || '' };
        case 'send_input':
            return { mono: true, text: input.text || '' };
        case 'read_file':
        case 'write_file':
        case 'list_directory':
            return { mono: true, text: input.path || '' };
        case 'edit_file':
        case 'edit_local_file':
            // The path on the row; the change itself is what the approval
            // card shows in full, old above new.
            return {
                mono: true,
                text: input.path || '',
                detail: input.old !== undefined
                    ? `- ${String(input.old)}\n+ ${String(input.new ?? '')}`
                    : '',
            };
        case 'search_local_files':
        case 'search_conversations':
            return { mono: false, text: input.query || '' };
        case 'read_conversation':
            return { mono: true, text: input.conversationId || '' };
        case 'ask_user':
            return { mono: false, text: input.question || '' };
        case 'delegate':
            return { mono: false, text: [input.agent, input.title || input.brief].filter(Boolean).join(': ') };
        case 'fan_out':
            return { mono: false, text: input.title || input.brief || '' };
        case 'start_task':
            return { mono: false, text: input.title || input.task || '' };
        case 'new_conversation':
            return { mono: false, text: [input.agent, input.title || input.message].filter(Boolean).join(': ') };
        case 'branch_conversation':
            return { mono: false, text: input.title || input.message || '' };
        case 'message_conversation':
            return { mono: false, text: input.message || '' };
        case 'open_conversation':
            return { mono: true, text: (input.conversationIds || []).join(', ') };
        case 'check_conversations':
            return { mono: true, text: input.waitFor || '' };
        case 'open_app':
            return { mono: false, text: [input.app, input.args].filter(Boolean).join(' ') };
        case 'read_screen':
            return { mono: false, text: input.under ? `element ${input.under}` : (input.window || '') };
        case 'click':
            return {
                mono: false,
                text: [input.button && input.button !== 'left' ? input.button : '', input.count > 1 ? `×${input.count}` : '',
                    aimedAt(input.element, input.x, input.y)].filter(Boolean).join(' '),
            };
        case 'type_text':
            return { mono: false, text: input.text || '' };
        case 'press_keys':
            return { mono: true, text: `${input.keys || ''}${input.repeat > 1 ? ` ×${input.repeat}` : ''}` };
        case 'scroll':
            return { mono: false, text: [input.direction, aimedAt(input.element, input.x, input.y)].filter(Boolean).join(' · ') };
        case 'drag':
            return {
                mono: false,
                text: `${aimedAt(input.fromElement, input.fromX, input.fromY)} → ${aimedAt(input.toElement, input.toX, input.toY)}`,
            };
        case 'wait_for':
            return { mono: false, text: input.text || '' };
        case 'read_text':
            return { mono: false, text: input.element ? `element ${input.element}` : (input.window || '') };
        case 'screenshot':
            return { mono: false, text: [input.window, input.screen ? 'whole screen' : ''].filter(Boolean).join(' · ') };
        case 'zoom':
            return { mono: true, text: `${input.x0},${input.y0} → ${input.x1},${input.y1}` };
        case 'solve_captcha':
            return {
                mono: false,
                text: [
                    input.window,
                    input.into ? `answer into element ${input.into}` : '',
                    input.x0 !== undefined ? `${input.x0},${input.y0} → ${input.x1},${input.y1}` : '',
                    input.instruction || '',
                ].filter(Boolean).join(' · '),
            };
        case 'do_steps':
            return {
                mono: false,
                text: (input.steps || []).map(step => (step.do === 'type' ? `type "${step.text || ''}"`
                    : step.do === 'keys' ? step.keys
                        : [step.do, aimedAt(step.element, step.x, step.y)].filter(Boolean).join(' '))).join(' → '),
            };
        case 'arrange_windows':
            return { mono: false, text: (input.windows || []).map(entry => `${entry.window} ${entry.place}`).join(', ') };
        case 'read_terminal':
            return {
                mono: false,
                text: input.lines
                    ? translate('assistant.lastLines', { count: input.lines })
                    : translate('assistant.recentOutput'),
            };
        case 'list_hosts':
            return {
                mono: false,
                text: input.query ? translate('assistant.matching', { query: input.query }) : '',
            };
        case 'connect_host':
            return { mono: false, text: input.hostId || '' };
        case 'list_snippets':
        case 'list_inventory':
            return {
                mono: false,
                text: [input.kind, input.query ? translate('assistant.matching', { query: input.query }) : '']
                    .filter(Boolean).join(' '),
            };
        case 'read_snippet':
            return { mono: false, text: input.id || '' };
        case 'save_snippet':
        case 'save_host':
        case 'save_proxy':
        case 'save_key':
        case 'save_mcp_server':
        case 'save_folder':
            // The name and nothing else. A password or a key in the input
            // must not be drawn on the row, in the tooltip, or in the log.
            return { mono: false, text: input.name || input.id || '' };
        case 'delete_inventory_item':
            return { mono: false, text: [input.kind, input.id].filter(Boolean).join(' ') };
        default: {
            const entries = Object.entries(input).filter(([key]) => key !== 'session');
            if (entries.length === 0) return { mono: false, text: '' };
            return { mono: false, text: entries.map(([key, value]) => `${key}: ${value}`).join(', ') };
        }
    }
}

export default function ToolCall({ item, onOpenConversation }) {
    const t = useT();
    // An edit opens on its own: the change is the point of the row, and
    // having to click to see what was done to a file is one click too many.
    const [open, setOpen] = useState(item.status === 'error' || Boolean(item.diff));
    const summary = describeCall(item.name, item.input);
    const refused = REFUSED[item.approval?.status];
    const known = refused || TITLES[item.name];
    const title = known
        ? t(known)
        : (item.local ? item.name : item.name.replace(/_/g, ' '));
    const expandable = Boolean(item.result) || Boolean(item.diff);
    const started = useMemo(() => (onOpenConversation ? startedConversations(item) : []), [item, onOpenConversation]);

    return (
        <div className="rounded-lg bg-gray-50 dark:bg-white/[0.035] overflow-hidden">
            <div className="flex items-center">
                {/* Not selectable, unlike the output it opens: this row is a
                    control, and dragging across a transcript should pick up what
                    the server said rather than the label on the toggle. */}
                <button
                    type="button"
                    onClick={() => setOpen(value => !value)}
                    disabled={!expandable}
                    className="flex-1 min-w-0 h-8 px-2.5 flex items-center gap-2 text-left select-none
                        transition-colors
                        hover:bg-gray-100 dark:hover:bg-white/[0.06] disabled:hover:bg-transparent
                        disabled:cursor-default"
                >
                    <span
                        aria-hidden="true"
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${refused
                            ? 'bg-gray-400 dark:bg-gray-600'
                            : DOTS[item.status] || DOTS.done}`}
                    />

                    <span className="text-[11px] font-medium text-gray-600 dark:text-gray-400 shrink-0">
                        {title}
                    </span>

                    {summary.text && (
                        <span
                            className={`min-w-0 flex-1 truncate text-[11px] text-gray-500 dark:text-gray-500 ${
                                summary.mono ? 'font-jetbrains' : ''
                            }`}
                            title={summary.text}
                        >
                            {summary.text}
                        </span>
                    )}

                    {expandable && (
                        <ArrowDown01Icon
                            size={13}
                            strokeWidth={2}
                            className={`shrink-0 ml-auto text-gray-400 dark:text-gray-600 transition-transform
                                ${open ? 'rotate-180' : ''}`}
                        />
                    )}
                </button>

                {/* Beside the toggle rather than in it: a button inside a button
                    is no button at all. */}
                {started.length > 0 && (
                    <button
                        type="button"
                        onClick={() => started.forEach(id => onOpenConversation(id))}
                        title={t('assistant.openConversationHint')}
                        className="shrink-0 h-8 px-2.5 flex items-center gap-1 select-none
                            text-[11px] font-medium transition-colors
                            text-gray-500 dark:text-gray-400
                            hover:bg-gray-100 dark:hover:bg-white/[0.06]
                            hover:text-gray-900 dark:hover:text-gray-100"
                    >
                        {started.length === 1
                            ? t('assistant.openConversation')
                            : t('assistant.openConversations', { count: started.length })}
                        <ArrowUpRight01Icon size={12} strokeWidth={2} />
                    </button>
                )}
            </div>

            {open && item.diff && (
                <DiffView
                    diff={item.diff}
                    path={item.input?.path || item.input?.file_path || item.input?.filePath || ''}
                    className="border-t border-black/[0.06] dark:border-white/[0.06]"
                />
            )}

            {open && item.result && (
                // The button is a sibling of the scroller rather than a child
                // of it: inside, it would scroll away with the first screen of
                // output, which is the one place it must not be.
                <div className="group relative border-t border-black/[0.06] dark:border-white/[0.06]">
                    {/* Scrolls in both directions on its own: a wide log line must
                        not stretch the panel, and a long one must not bury the
                        reply under it. */}
                    <pre className="px-2.5 py-2 max-h-64 overflow-auto
                        font-jetbrains text-[11px] leading-[1.6] whitespace-pre
                        text-gray-600 dark:text-gray-400">
                        {item.result}
                    </pre>
                    <CopyButton text={item.result} label="Copy output" className="absolute right-1 top-1" />
                </div>
            )}
        </div>
    );
}

import { useState } from 'react';
import {
    ArrowDown01Icon,
    BrainIcon,
    CommandLineIcon,
    Edit02Icon,
    EyeIcon,
    Search01Icon,
} from 'hugeicons-react';
import Markdown from '../../lib/markdown';
import ToolCall, { DOTS, callStatus } from './ToolCall';
import { useT } from '../../i18n';

/**
 * A burst of work — consecutive tool calls plus the narration between them —
 * as one row.
 *
 * A working answer used to take one row per call with its narration strung
 * between, so the reply was buried under a screen of nearly identical lines.
 * Grouped, the burst reads as one summary that opens into the calls and the
 * thoughts on the way there: "8 reads · 3 commands · 2 thoughts".
 *
 * The turn's final reply is not in here: the transcript strips trailing
 * assistant messages from the run and leaves them outside, so the answer
 * stays visible while the narration that led to it folds into the group.
 *
 * Folded in the transcript (see `useGrouped` there), not in the reducer, so
 * every result still finds its call where it always did. A group is the same
 * object for as long as its members are, which lets the segment it sits in
 * tell nothing has changed.
 */

/** Which summary bucket a tool belongs in, by name. Lower-cased. */
export function toolBucket(name = '') {
    const lower = String(name || '').toLowerCase();
    if (!lower) return 'other';
    // Edits first: an "edit" that also mentions a file is still an edit.
    if (lower.includes('edit') || lower.includes('write') || lower.includes('apply_patch')
        || lower.includes('replace') || lower.startsWith('save_') || lower.startsWith('delete_')
        || lower === 'create' || lower === 'todowrite' || lower === 'todo') return 'edits';
    if (lower.includes('search') || lower === 'grep' || lower === 'glob' || lower === 'find'
        || lower === 'recall' || lower === 'lookup' || lower.startsWith('search_')) return 'searches';
    if (lower.includes('run') || lower.includes('exec') || lower.includes('bash')
        || lower.includes('command') || lower.includes('shell') || lower.includes('terminal')
        || lower === 'send_input' || lower === 'type_text' || lower === 'press_keys') return 'commands';
    if (lower.includes('read') || lower.includes('list') || lower.includes('view')
        || lower.includes('cat') || lower === 'ls'
        || lower.startsWith('list_') || lower.startsWith('read_')) return 'views';
    return 'other';
}

const isThoughtItem = item => item.kind === 'assistant';

/** How many of the group's tool calls are still running, and how many went wrong. */
function tally(items) {
    let running = 0;
    let failed = 0;
    for (const item of items) {
        if (item.kind !== 'tool') continue;
        const status = callStatus(item);
        if (status === 'running' || status === 'waiting') running += 1;
        else if (status === 'error') failed += 1;
    }
    return { running, failed };
}

/** The group's dot: at work while any call is, then red if any went wrong. */
function groupDot({ running, failed }) {
    if (running > 0) return DOTS.running;
    if (failed > 0) return DOTS.error;
    return DOTS.done;
}

/** The first readable line, for the collapsed thought row. */
function previewOf(item) {
    const text = String(item.text || '').trim();
    const thinking = String(item.thinking || '').trim();
    const first = (text || thinking).split('\n').map(line => line.trim()).filter(Boolean)[0] || '';
    return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}

/**
 * One thought, inside the group or standing on its own: the narration
 * between calls, with the model's extended thinking where it has any.
 *
 * Collapsed to one line with a brain, like a tool call. Opens into the full
 * text, with the extended thinking above it where there is any.
 */
export function Thought({ item }) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const preview = previewOf(item);
    const thinking = String(item.thinking || '').trim();
    const text = String(item.text || '').trim();

    return (
        <div className="overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen(value => !value)}
                aria-expanded={open}
                className="w-full min-w-0 h-8 pl-6 pr-2.5 flex items-center gap-2 text-left select-none
                    transition-colors hover:bg-gray-100 dark:hover:bg-white/[0.06]"
            >
                <BrainIcon size={13} strokeWidth={2} className="shrink-0 text-gray-400 dark:text-gray-500" />
                <span className="text-[11px] font-medium text-gray-600 dark:text-gray-400 shrink-0">
                    {t('assistant.thought')}
                </span>
                {preview && (
                    <span
                        className="min-w-0 flex-1 truncate text-[11px] text-gray-500 dark:text-gray-500"
                        title={preview}
                    >
                        {preview}
                    </span>
                )}
                <ArrowDown01Icon
                    size={13}
                    strokeWidth={2}
                    className={`shrink-0 ml-auto text-gray-400 dark:text-gray-600 transition-transform
                        ${open ? 'rotate-180' : ''}`}
                />
            </button>

            {open && (
                <div className="pl-6 pr-2.5 pb-2.5 space-y-2">
                    {thinking && (
                        <div className="rounded-lg px-2.5 py-2 bg-gray-100/70 dark:bg-white/[0.04]">
                            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase
                                tracking-wide text-gray-400 dark:text-gray-500">
                                <BrainIcon size={11} strokeWidth={2} />
                                {t('assistant.thoughtThinking')}
                            </div>
                            <div className="text-[12px] leading-relaxed text-gray-600 dark:text-gray-400">
                                <Markdown text={thinking} />
                            </div>
                        </div>
                    )}
                    {text && (
                        <div className="px-2.5 text-[12px] leading-relaxed text-gray-700 dark:text-gray-300">
                            <Markdown text={text} />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export default function ToolGroup({ group, conversationId, onOpenConversation }) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const items = group.items || [];
    const { running, failed } = tally(items);

    const tools = items.filter(item => item.kind === 'tool');
    const thoughts = items.filter(isThoughtItem);
    const counts = { views: 0, commands: 0, edits: 0, searches: 0, other: 0 };
    for (const item of tools) counts[toolBucket(item.name)] += 1;

    const buckets = [
        counts.views > 0 && { icon: <EyeIcon size={12} strokeWidth={2} />, text: t('assistant.toolGroupViews', { count: counts.views }) },
        counts.commands > 0 && { icon: <CommandLineIcon size={12} strokeWidth={2} />, text: t('assistant.toolGroupCommands', { count: counts.commands }) },
        counts.edits > 0 && { icon: <Edit02Icon size={12} strokeWidth={2} />, text: t('assistant.toolGroupEdits', { count: counts.edits }) },
        counts.searches > 0 && { icon: <Search01Icon size={12} strokeWidth={2} />, text: t('assistant.toolGroupSearches', { count: counts.searches }) },
        thoughts.length > 0 && { icon: <BrainIcon size={12} strokeWidth={2} />, text: t('assistant.toolGroupThoughts', { count: thoughts.length }) },
        counts.other > 0 && { icon: null, text: t('assistant.toolGroupOther', { count: counts.other }) },
    ].filter(Boolean);
    if (running > 0) buckets.unshift({ icon: null, text: t('assistant.toolGroupRunning', { count: running }) });
    if (failed > 0 && running === 0) buckets.push({ icon: null, text: t('assistant.toolGroupFailed', { count: failed }) });

    return (
        <div className="rounded-lg bg-gray-50 dark:bg-white/[0.035] overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen(value => !value)}
                aria-expanded={open}
                className="w-full min-w-0 h-8 px-2.5 flex items-center gap-2 text-left select-none
                    transition-colors hover:bg-gray-100 dark:hover:bg-white/[0.06]"
            >
                <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${groupDot({ running, failed })}`} />
                <span className="text-[11px] font-medium text-gray-600 dark:text-gray-400 shrink-0">
                    {t('assistant.toolGroup', { count: tools.length })}
                </span>
                <span className="min-w-0 flex-1 flex items-center gap-2 overflow-hidden
                    text-[11px] text-gray-500 dark:text-gray-500">
                    {buckets.map((part, index) => (
                        <span key={index} className="shrink-0 flex items-center gap-1 truncate">
                            {part.icon && (
                                <span className="shrink-0 text-gray-400 dark:text-gray-600">{part.icon}</span>
                            )}
                            <span className="truncate">{part.text}</span>
                            {index < buckets.length - 1 && (
                                <span aria-hidden="true" className="ml-2 text-gray-300 dark:text-gray-700">·</span>
                            )}
                        </span>
                    ))}
                </span>
                <span className="shrink-0 ml-auto flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-600">
                    {open ? t('assistant.toolGroupShowLess') : t('assistant.toolGroupShowAll')}
                    <ArrowDown01Icon
                        size={13}
                        strokeWidth={2}
                        className={`transition-transform ${open ? 'rotate-180' : ''}`}
                    />
                </span>
            </button>

            {open && (
                <div className="border-t border-black/[0.06] dark:border-white/[0.06] py-0.5 space-y-0.5">
                    {items.map(item => (
                        item.kind === 'assistant'
                            ? <Thought key={item.id} item={item} />
                            : (
                                <ToolCall
                                    key={item.id}
                                    item={item}
                                    conversationId={conversationId}
                                    onOpenConversation={onOpenConversation}
                                />
                            )
                    ))}
                </div>
            )}
        </div>
    );
}

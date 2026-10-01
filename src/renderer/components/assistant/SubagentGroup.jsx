import { useState } from 'react';
import { ArrowDown01Icon, ArrowUpRight01Icon } from 'hugeicons-react';
import { DOTS, callStatus, describeCall, subagentConversationId, taskStatus } from './ToolCall';
import { useT } from '../../i18n';

/**
 * Subagents sent off together, as one row.
 *
 * An agent that splits a job ten ways makes ten calls in one breath, and ten
 * rows for them was most of the screen before a word of the answer. They are
 * one thing to the person reading: a piece of work handed out. So the row
 * says how many there are and how far they have got, and opens into a line
 * each, and each line opens that subagent's own transcript in a tab, which
 * is where its calls and its report are.
 */

/** How many of the group are running, finished, and failed or stopped. */
function tally(items) {
    const counts = { running: 0, done: 0, failed: 0 };
    for (const item of items) {
        const status = callStatus(item);
        if (status === 'running' || status === 'waiting') counts.running += 1;
        else if (status === 'error' || item.task?.status === 'stopped' || item.task?.status === 'killed') counts.failed += 1;
        else counts.done += 1;
    }
    return counts;
}

/** The group's dot: at work while any is, then red if any went wrong. */
function groupDot(counts) {
    if (counts.running > 0) return DOTS.running;
    if (counts.failed > 0) return DOTS.error;
    return DOTS.done;
}

/** One subagent, as a line that opens it. */
function Member({ item, conversationId, onOpenConversation }) {
    const t = useT();
    const summary = describeCall(item.name, item.input);
    // Not "background" on every line: they were all sent off the same way.
    const meta = taskStatus(item.task, t, { background: false });
    const open = onOpenConversation && conversationId
        ? () => onOpenConversation(subagentConversationId(conversationId, item.id))
        : null;

    return (
        <button
            type="button"
            onClick={open || undefined}
            disabled={!open}
            title={open ? t('assistant.openSubagentHint') : undefined}
            className="group/member w-full min-w-0 h-8 pl-6 pr-2.5 flex items-center gap-2 text-left select-none
                transition-colors
                hover:bg-gray-100 dark:hover:bg-white/[0.06] disabled:hover:bg-transparent disabled:cursor-default"
        >
            <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOTS[callStatus(item)] || DOTS.done}`} />
            <span className="min-w-0 flex-1 truncate text-[11px] text-gray-600 dark:text-gray-400" title={summary.text}>
                {summary.text || t('assistant.didSubagent')}
            </span>
            {meta && (
                <span className="shrink-0 max-w-[45%] truncate text-[11px] text-gray-400 dark:text-gray-600" title={meta}>
                    {meta}
                </span>
            )}
            {open && (
                <ArrowUpRight01Icon
                    size={12}
                    strokeWidth={2}
                    className="shrink-0 text-gray-400 dark:text-gray-600
                        group-hover/member:text-gray-900 dark:group-hover/member:text-gray-100"
                />
            )}
        </button>
    );
}

export default function SubagentGroup({ group, conversationId, onOpenConversation }) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const counts = tally(group.items);
    const parts = [];
    if (counts.running > 0) parts.push(t('assistant.subagentsRunning', { count: counts.running }));
    if (counts.done > 0) parts.push(t('assistant.subagentsDone', { count: counts.done }));
    if (counts.failed > 0) parts.push(t('assistant.subagentsFailed', { count: counts.failed }));
    const steps = group.items.reduce((sum, item) => sum + (item.task?.toolUses || 0), 0);
    if (steps > 0 && counts.running === 0) parts.push(t('assistant.subagentSteps', { count: steps }));

    return (
        <div className="rounded-lg bg-gray-50 dark:bg-white/[0.035] overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen(value => !value)}
                aria-expanded={open}
                className="w-full min-w-0 h-8 px-2.5 flex items-center gap-2 text-left select-none
                    transition-colors hover:bg-gray-100 dark:hover:bg-white/[0.06]"
            >
                <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${groupDot(counts)}`} />
                <span className="text-[11px] font-medium text-gray-600 dark:text-gray-400 shrink-0">
                    {t('assistant.subagents', { count: group.items.length })}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-gray-500 dark:text-gray-500">
                    {parts.join(' · ')}
                </span>
                <ArrowDown01Icon
                    size={13}
                    strokeWidth={2}
                    className={`shrink-0 ml-auto text-gray-400 dark:text-gray-600 transition-transform
                        ${open ? 'rotate-180' : ''}`}
                />
            </button>

            {open && (
                <div className="border-t border-black/[0.06] dark:border-white/[0.06] py-0.5">
                    {group.items.map(item => (
                        <Member
                            key={item.id}
                            item={item}
                            conversationId={conversationId}
                            onOpenConversation={onOpenConversation}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

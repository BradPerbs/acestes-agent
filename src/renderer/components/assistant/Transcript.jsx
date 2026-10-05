import { memo, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Image01Icon } from 'hugeicons-react';
import Markdown from '../../lib/markdown';
import ToolCall, { SUBAGENT_TOOLS } from './ToolCall';
import SubagentGroup from './SubagentGroup';
import ToolGroup, { Thought } from './ToolGroup';
import { groupRows } from '../../lib/group-rows';
import ApprovalRequest from './ApprovalRequest';
import QuestionRequest from './QuestionRequest';
import { TurnActions, TurnChanges } from './TurnFooter';
import { useT } from '../../i18n';

/**
 * The conversation so far, as rows.
 *
 * A long conversation is thousands of rows: every message, every tool call
 * and its output, every diff. It used to be drawn in one pass inside the
 * panel, which meant each streamed word, each keystroke in the composer and
 * each tool result drew all of it again. On a day-long session that was a
 * fifth of a second per key. Four things keep it flat now, and none of them
 * takes anything away: every row is still in the page, selectable, copyable
 * and findable.
 *
 *   one row, one memo   a row is drawn again only when its own item changes.
 *                       The reducer keeps every other item the same object
 *                       (see useAssistant), so a new tool result redraws one
 *                       row, not two thousand. Rows are grouped in fixed runs
 *                       of fifty that check their own items by identity, so
 *                       even looking at the rows that did not change costs a
 *                       comparison per item rather than an element per row.
 *   its own component   the composer, the menus and the streaming draft live
 *                       beside this, not inside it, so typing and streaming
 *                       do not reach it at all.
 *   off-screen rows     are left out of layout and paint by the browser
 *                       (`content-visibility`), with their last size kept so
 *                       the scrollbar does not jump. They are still in the
 *                       document: selection, copy and find work across them.
 *   newest first        a long conversation opens on its last rows, and the
 *                       older ones are added above in the background, a few
 *                       hundred at a time, where they would have been anyway.
 */

/** Rows drawn straight away when a conversation opens: more than a screen. */
const FIRST_ROWS = 60;
/** Rows added above per idle moment while the rest are brought in. */
const CHUNK = 150;
/**
 * Rows per segment. Segments start at fixed multiples of this from the
 * first item, so bringing older rows in never moves a boundary.
 */
const SEGMENT = 50;

/**
 * Off-screen rows skip layout and paint. The height is a guess for a row the
 * browser has never drawn; `auto` makes it remember the real one after.
 */
const ROW_STYLE = { contentVisibility: 'auto', containIntrinsicHeight: 'auto 72px' };

export function Notice({ item }) {
    const tone = item.tone === 'error'
        ? 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300'
        : item.tone === 'warn'
            ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300'
            : 'bg-gray-50 dark:bg-white/[0.035] text-gray-500 dark:text-gray-400';

    return (
        <div className={`rounded-lg px-2.5 py-2 text-[11px] leading-relaxed ${tone}`}>
            {item.text}
        </div>
    );
}


/** What one item draws as, or null for one that is shown elsewhere. */
function RowContent({ item, conversationId, onRespond, onAnswer, onRevert, onOpenConversation }) {
    const t = useT();
    if (item.kind === 'user') {
        return (
            <div key={item.id} className="flex justify-end">
                <div className="assistant-bubble max-w-[88%] px-3 py-2 rounded-2xl rounded-br-md
                    bg-gray-900 dark:bg-white text-white dark:text-black
                    text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                    {/* The pictures, or a chip naming each one for a
                        message read back from disk, which keeps the
                        name and not the bytes. */}
                    {/* What the message tagged, by name. The
                        records are in the inventory, and a
                        bubble holding a runbook would be the
                        whole panel. */}
                    {item.files?.length > 0 && (
                        <div className={`flex flex-wrap gap-1.5 ${item.text || item.images?.length || item.mentions?.length ? 'mb-1.5' : ''}`}>
                            {item.files.map((file, index) => (
                                <span
                                    key={file.name || index}
                                    title={file.name}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md
                                        text-xs bg-white/15 dark:bg-black/10"
                                >
                                    {file.name}
                                </span>
                            ))}
                        </div>
                    )}
                    {item.mentions?.length > 0 && (
                        <div className={`flex flex-wrap gap-1.5 ${item.text || item.images?.length ? 'mb-1.5' : ''}`}>
                            {item.mentions.map((entry, index) => (
                                <span
                                    key={`${entry.kind}:${entry.id}` || index}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md
                                        text-xs bg-white/15 dark:bg-black/10"
                                >
                                    {entry.kind === 'skill' ? `/${entry.name}` : `@${entry.name}`}
                                </span>
                            ))}
                        </div>
                    )}
                    {item.images?.length > 0 && (
                        <div className={`flex flex-wrap gap-1.5 ${item.text ? 'mb-1.5' : ''}`}>
                            {item.images.map((image, index) => (image.data ? (
                                <img
                                    key={index}
                                    src={`data:${image.mediaType};base64,${image.data}`}
                                    alt={image.name}
                                    className="max-h-40 max-w-full rounded-lg object-contain"
                                />
                            ) : (
                                <span
                                    key={index}
                                    title={image.name}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md
                                        text-xs bg-white/15 dark:bg-black/10"
                                >
                                    <Image01Icon size={12} strokeWidth={2} />
                                    {image.name || t('assistant.image')}
                                </span>
                            )))}
                        </div>
                    )}
                    {item.text}
                </div>
            </div>
        );
    }
    if (item.kind === 'assistant') {
        // The thinking as a collapsed thought row, the words under it as they
        // always drew. Thinking with no words is the thought row alone.
        const thinking = String(item.thinking || '').trim();
        if (!String(item.text || '').trim()) {
            return thinking ? <Thought key={item.id} item={item} /> : <Markdown key={item.id} text={item.text} />;
        }
        if (!thinking) return <Markdown key={item.id} text={item.text} />;
        return (
            <div key={item.id} className="space-y-1.5">
                <Thought item={{ id: item.id, thinking: item.thinking }} />
                <Markdown text={item.text} />
            </div>
        );
    }
    if (item.kind === 'tool') {
        // A call waiting on an answer is not here at all: it
        // is the card pinned above the composer, and drawing
        // the row as well would put the same command on
        // screen twice. It takes its place in the transcript
        // the moment it is answered.
        if (item.approval?.status === 'pending') return null;
        return <ToolCall key={item.id} item={item} conversationId={conversationId} onOpenConversation={onOpenConversation} />;
    }
    if (item.kind === 'subagents') {
        return <SubagentGroup group={item} conversationId={conversationId} onOpenConversation={onOpenConversation} />;
    }
    if (item.kind === 'tools') {
        return <ToolGroup group={item} conversationId={conversationId} onOpenConversation={onOpenConversation} />;
    }
    if (item.kind === 'approval') {
        if (item.status === 'pending') return null;
        return (
            <ApprovalRequest
                key={item.id}
                group={{ key: item.id, items: [item], queued: [] }}
                onRespond={onRespond}
            />
        );
    }
    if (item.kind === 'question') {
        // Pinned above the composer while it stands, like an
        // approval; here once answered, with the answer on it.
        if (item.status === 'pending') return null;
        return <QuestionRequest key={item.id} item={item} onAnswer={onAnswer} />;
    }
    if (item.kind === 'changes') {
        return (
            <TurnChanges
                key={item.id}
                item={item}
                conversationId={conversationId}
                onRevert={onRevert}
            />
        );
    }
    if (item.kind === 'divider') return <Divider key={item.id} item={item} />;
    return <Notice key={item.id} item={item} />;
}

/** A thin rule with a few words on it: the chat moved to another model, effort or account. */
function Divider({ item }) {
    return (
        <div className="flex items-center gap-2 py-0.5 text-[10.5px] text-gray-400 dark:text-neutral-500 select-none" role="separator">
            <span className="h-px flex-1 bg-gray-200 dark:bg-white/[0.08]" />
            <span className="shrink-0 max-w-[80%] truncate" title={item.text}>{item.text}</span>
            <span className="h-px flex-1 bg-gray-200 dark:bg-white/[0.08]" />
        </div>
    );
}

/**
 * One item, and under it the row a finished turn ends on. Its props are all
 * values or stable callbacks, so it is drawn again only when its own item,
 * or the turn ending on it, changes.
 */
const Row = memo(function Row({
    item, endTurnId, endText, endRate, conversationId, onRespond, onAnswer, onRevert, onBranch, onOpenConversation,
}) {
    // A question standing is drawn in the dock above the composer instead,
    // and a row with nothing in it would still take a gap in the column.
    const waiting = (item.kind === 'tool' && item.approval?.status === 'pending')
        || ((item.kind === 'approval' || item.kind === 'question') && item.status === 'pending');
    const ends = endTurnId !== undefined;
    if (waiting && !ends) return null;

    return (
        // Never squeezed by the column it sits in: a flex column would
        // otherwise shrink its rows to fit rather than scroll.
        <div className="shrink-0" style={ROW_STYLE}>
            {!waiting && (
                <RowContent
                    item={item}
                    conversationId={conversationId}
                    onRespond={onRespond}
                    onAnswer={onAnswer}
                    onRevert={onRevert}
                    onOpenConversation={onOpenConversation}
                />
            )}
            {ends && (
                <div className="mt-3">
                    <TurnActions
                        text={endText}
                        rate={endRate}
                        onBranch={onBranch ? () => onBranch(endTurnId) : null}
                    />
                </div>
            )}
        </div>
    );
});

/**
 * Where each finished turn ends, by the index of its last item, with the
 * turn's id (its message's), its reply and its answer rate. The row under
 * a turn goes there. The turn still running has none until it is over.
 */
function findTurnEnds(items, busy, turnRates) {
    const ends = new Map();
    let turn = null;
    const close = () => {
        if (turn && turn.last >= 0 && turn.worked) {
            turn.rate = turnRates?.[turn.turnId] || null;
            ends.set(turn.last, turn);
        }
    };
    items.forEach((item, index) => {
        if (item.kind === 'user') {
            close();
            turn = { turnId: item.id, text: '', last: index, worked: false };
            return;
        }
        if (!turn) return;
        // A divider is between turns, not the end of one: the turn's row
        // stays above it.
        if (item.kind === 'divider') return;
        if (item.kind === 'assistant' && item.text) turn.text = item.text;
        if (item.kind !== 'notice') turn.worked = true;
        turn.last = index;
    });
    if (!busy) close();
    return ends;
}

/**
 * The rows as drawn: back-to-back tool calls folded into one group, with the
 * thoughts between them left standing outside (see lib/group-rows).
 */
function useGrouped(items, enabled = true) {
    const cache = useRef(new Map());
    return useMemo(() => {
        const { rows, kept } = groupRows(items, {
            enabled,
            subagentTools: SUBAGENT_TOOLS,
            previous: cache.current,
        });
        cache.current = kept;
        return rows;
    }, [items, enabled]);
}

/**
 * A row's key: the item's own id, made unique if two items share one. Two
 * events stamped in the same millisecond can, and React would then hand
 * one row's state to the other.
 */
function rowKeys(items) {
    const keys = new Array(items.length);
    const seen = new Set();
    for (let index = 0; index < items.length; index += 1) {
        let key = String(items[index].id);
        if (seen.has(key)) key = `${key}~${index}`;
        seen.add(key);
        keys[index] = key;
    }
    return keys;
}

/**
 * A fixed run of rows. Skipped outright when every item in it is the same
 * object as last time and no turn has started or stopped ending in it, which
 * is every segment but the last while a turn is streaming in.
 */
const Segment = memo(function Segment({ items, keys, ends, from, to, rowProps }) {
    const rows = [];
    for (let index = from; index < to; index += 1) {
        const end = ends.get(index);
        rows.push(
            <Row
                key={keys[index]}
                item={items[index]}
                endTurnId={end ? end.turnId : undefined}
                endText={end ? end.text : ''}
                endRate={end ? end.rate : null}
                {...rowProps}
            />,
        );
    }
    return rows;
}, (previous, next) => {
    if (previous.from !== next.from || previous.to !== next.to || previous.rowProps !== next.rowProps) return false;
    for (let index = next.from; index < next.to; index += 1) {
        if (previous.items[index] !== next.items[index] || previous.keys[index] !== next.keys[index]) return false;
        const before = previous.ends.get(index);
        const after = next.ends.get(index);
        if (before?.turnId !== after?.turnId || before?.text !== after?.text) return false;
        if (before?.rate?.tps !== after?.rate?.tps || before?.rate?.tokens !== after?.rate?.tokens) return false;
    }
    return true;
});

function Transcript({
    items: allItems,
    busy,
    conversationId,
    /** Each finished turn's answer rate by its message's id. */
    turnRates,
    onRespond,
    onAnswer,
    onRevert,
    onBranch,
    /** Open a conversation by id in a tab: one a tool call started. */
    onOpenConversation,
    /** Told after every change to what is drawn, so the panel can follow the bottom. */
    onLayout,
    /** Fold consecutive tool calls into one summary row. On unless switched off in settings. */
    groupTools = true,
}) {
    const t = useT();
    const items = useGrouped(allItems, groupTools);
    const ends = useMemo(() => findTurnEnds(items, busy, turnRates), [items, busy, turnRates]);

    // Newest first: the first row drawn. The rest come in above it while
    // the browser is idle, as a transition, so a key pressed meanwhile is
    // never kept waiting behind them.
    const [from, setFrom] = useState(() => Math.max(0, items.length - FIRST_ROWS));
    useEffect(() => {
        if (from <= 0) return undefined;
        const idle = window.requestIdleCallback
            ? callback => window.requestIdleCallback(callback, { timeout: 300 })
            : callback => setTimeout(callback, 30);
        const cancel = window.cancelIdleCallback || clearTimeout;
        const handle = idle(() => {
            startTransition(() => setFrom(current => Math.max(0, current - CHUNK)));
        });
        return () => cancel(handle);
    }, [from]);

    useLayoutEffect(() => {
        onLayout?.();
    }, [items, from, ends, onLayout]);

    const keys = useMemo(() => rowKeys(items), [items]);
    // One object for the props every row shares, so a segment can tell they
    // have not changed with one comparison.
    const rowProps = useMemo(
        () => ({ conversationId, onRespond, onAnswer, onRevert, onBranch, onOpenConversation }),
        [conversationId, onRespond, onAnswer, onRevert, onBranch, onOpenConversation],
    );

    const start = Math.min(from, items.length);
    const segments = [];
    for (let first = Math.floor(start / SEGMENT) * SEGMENT; first < items.length; first += SEGMENT) {
        const segmentFrom = Math.max(first, start);
        const segmentTo = Math.min(first + SEGMENT, items.length);
        segments.push(
            <Segment
                key={first}
                items={items}
                keys={keys}
                ends={ends}
                from={segmentFrom}
                to={segmentTo}
                rowProps={rowProps}
            />,
        );
    }

    return (
        <>
            {start > 0 && (
                <div className="h-8 flex items-center justify-center text-[11px] select-none
                    text-gray-400 dark:text-gray-600">
                    {t('assistant.loadingEarlier', { count: start })}
                </div>
            )}
            {segments}
        </>
    );
}

export default memo(Transcript);

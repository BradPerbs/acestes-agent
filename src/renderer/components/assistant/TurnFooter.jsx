import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ArrowDown01Icon,
    Copy01Icon,
    GitBranchIcon,
    PlusMinusSquare01Icon,
    Tick01Icon,
    Undo02Icon,
} from 'hugeicons-react';
import Tooltip from '../ui/Tooltip';
import DiffView from './DiffView';
import { useT } from '../../i18n';

/**
 * The foot of a finished turn: what it did to files, and what can be done
 * with it.
 *
 * A turn that edits files ends with a card naming each of them and how many
 * lines it gained and lost, which is the answer to "what did it just do to my
 * project" without scrolling back through every tool row. The card can undo
 * the lot, and opens to the diffs. Under every finished turn there is a row
 * to copy the reply and to branch a new chat from that point.
 *
 * The diffs are asked for when the card is opened rather than carried on the
 * event: they are the whole files' worth of change, and the transcript on
 * disk has a budget. See ai/checkpoints.js for where they are kept.
 */

/** How long the tick stays up after a copy. */
const CONFIRM_MS = 1400;

const SEPARATOR = /[\\/]/;

/** A path as the folder it is in and the file's own name. */
function splitPath(file) {
    const full = String(file.path || '');
    const at = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'));
    const folder = at >= 0 ? full.slice(0, at + 1) : '';
    const name = at >= 0 ? full.slice(at + 1) : full;
    return {
        folder: file.where === 'remote' && file.host ? `${file.host}:${folder}` : folder,
        name: name || full.split(SEPARATOR).filter(Boolean).pop() || full,
    };
}

function Counts({ added, removed, className = '' }) {
    return (
        <span className={`shrink-0 flex items-center gap-1.5 text-[11px] font-medium tabular-nums ${className}`}>
            <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
            <span className="text-red-600 dark:text-red-400">-{removed}</span>
        </span>
    );
}

/**
 * The files one turn changed, as a card.
 *
 *   applied    what the turn left, with Undo offered
 *   reverting  the undo is under way
 *   reverted   every file is back; the card stays, saying so
 *   partial    some could not be put back, each with why; Undo again tries
 *              the rest, and the ones already back are left alone
 */
export function TurnChanges({ item, conversationId, onRevert }) {
    const t = useT();
    const [reverting, setReverting] = useState(false);
    const [problem, setProblem] = useState('');
    const [open, setOpen] = useState(() => new Set());
    const [diffs, setDiffs] = useState(null);
    const [missing, setMissing] = useState(false);
    const asked = useRef(false);

    const files = item.files || [];
    const added = files.reduce((total, file) => total + (file.added || 0), 0);
    const removed = files.reduce((total, file) => total + (file.removed || 0), 0);
    const reverted = item.status === 'reverted';
    const inherited = Boolean(item.from);
    const source = item.from || conversationId;

    // The lines, once, the first time any of them is wanted.
    const loadDiffs = useCallback(() => {
        if (asked.current || !source) return;
        asked.current = true;
        window.api.ai.turnChanges?.(source, item.turnId)
            .then((answer) => {
                if (!answer?.found) {
                    setMissing(true);
                    return;
                }
                setDiffs(new Map(answer.files.map(file => [file.path, file.diff])));
            })
            .catch(() => setMissing(true));
    }, [source, item.turnId]);

    const toggle = useCallback((path) => {
        loadDiffs();
        setOpen((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, [loadDiffs]);

    const allOpen = files.length > 0 && files.every(file => open.has(file.path));
    const review = useCallback(() => {
        loadDiffs();
        setOpen(allOpen ? new Set() : new Set(files.map(file => file.path)));
    }, [allOpen, files, loadDiffs]);

    const undo = useCallback(async () => {
        if (reverting) return;
        setReverting(true);
        setProblem('');
        try {
            const answer = await onRevert?.(item.turnId);
            if (answer && answer.success === false) setProblem(answer.message || t('assistant.undoFailed'));
        } catch (error) {
            setProblem(error.message || t('assistant.undoFailed'));
        } finally {
            setReverting(false);
        }
    }, [reverting, onRevert, item.turnId, t]);

    const failed = new Map((item.failed || []).map(entry => [entry.path, entry.reason]));

    return (
        <div className="rounded-xl overflow-hidden select-none
            border border-gray-200 dark:border-white/[0.08]
            bg-white dark:bg-white/[0.025]">
            <div className="px-3 py-2.5 flex items-center gap-3">
                <span className="w-9 h-9 shrink-0 flex items-center justify-center rounded-lg
                    bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-gray-300">
                    {reverted
                        ? <Undo02Icon size={17} strokeWidth={1.75} />
                        : <PlusMinusSquare01Icon size={17} strokeWidth={1.75} />}
                </span>

                <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-gray-900 dark:text-white truncate">
                        {reverted
                            ? t('assistant.revertedFiles', { count: files.length })
                            : t('assistant.editedFiles', { count: files.length })}
                    </div>
                    <Counts added={added} removed={removed} className={reverted ? 'opacity-50 line-through' : ''} />
                </div>

                {!inherited && !reverted && (
                    <Tooltip label={t('assistant.undoHint')} placement="top">
                        <button
                            type="button"
                            aria-label={t('assistant.undo')}
                            onClick={undo}
                            disabled={reverting}
                            className="h-7 px-2 shrink-0 flex items-center gap-1.5 rounded-lg
                                text-xs font-medium transition-colors
                                text-gray-600 dark:text-gray-300
                                hover:bg-gray-100 hover:text-gray-900
                                dark:hover:bg-white/[0.06] dark:hover:text-white
                                disabled:opacity-60 disabled:cursor-default"
                        >
                            {reverting ? t('assistant.undoing') : t('assistant.undo')}
                            <Undo02Icon size={14} strokeWidth={2} />
                        </button>
                    </Tooltip>
                )}

                {reverted && (
                    <span className="shrink-0 flex items-center gap-1 text-xs font-medium
                        text-gray-500 dark:text-gray-400">
                        <Tick01Icon size={14} strokeWidth={2.25} className="text-emerald-600 dark:text-emerald-400" />
                        {t('assistant.undone')}
                    </span>
                )}

                <button
                    type="button"
                    onClick={review}
                    className="h-7 px-3 shrink-0 rounded-lg text-xs font-medium transition-colors
                        border border-gray-200 dark:border-white/[0.1]
                        bg-gray-50 dark:bg-white/[0.04]
                        text-gray-700 dark:text-gray-200
                        hover:bg-gray-100 dark:hover:bg-white/[0.08]"
                >
                    {allOpen ? t('assistant.hideReview') : t('assistant.review')}
                </button>
            </div>

            {problem && (
                <p className="px-3 pb-2 text-[11px] text-red-600 dark:text-red-400">{problem}</p>
            )}

            <div className="border-t border-black/[0.06] dark:border-white/[0.06]">
                {files.map((file) => {
                    const { folder, name } = splitPath(file);
                    const expanded = open.has(file.path);
                    const reason = failed.get(file.path);
                    const change = diffs?.get(file.path);
                    return (
                        <div key={`${file.where}:${file.host}:${file.path}`}>
                            <button
                                type="button"
                                onClick={() => toggle(file.path)}
                                title={file.path}
                                className="w-full h-9 px-3 flex items-center gap-3 text-left transition-colors
                                    hover:bg-gray-50 dark:hover:bg-white/[0.03]"
                            >
                                <span className="min-w-0 flex-1 flex items-baseline text-xs">
                                    <span className="min-w-0 truncate text-gray-500 dark:text-gray-500">{folder}</span>
                                    <span className="shrink-0 font-medium text-gray-900 dark:text-white">{name}</span>
                                </span>
                                <Counts
                                    added={file.added || 0}
                                    removed={file.removed || 0}
                                    className={reverted ? 'opacity-50 line-through' : ''}
                                />
                                <ArrowDown01Icon
                                    size={13}
                                    strokeWidth={2}
                                    className={`shrink-0 text-gray-400 dark:text-gray-600 transition-transform
                                        ${expanded ? 'rotate-180' : ''}`}
                                />
                            </button>
                            {reason && (
                                <p className="px-3 pb-2 -mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                                    {t('assistant.notUndone', { reason })}
                                </p>
                            )}
                            {expanded && (
                                <div className="select-text border-t border-black/[0.06] dark:border-white/[0.06]
                                    bg-gray-50/60 dark:bg-black/20">
                                    {change ? (
                                        <DiffView diff={change} path={file.path} header={false} />
                                    ) : (
                                        <p className="px-3 py-2 text-[11px] text-gray-500 dark:text-gray-400">
                                            {missing || (diffs && !change)
                                                ? t('assistant.reviewUnavailable')
                                                : t('assistant.loadingReview')}
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/** An icon button for the row under a turn. */
function ActionButton({ label, hint, onClick, disabled = false, children }) {
    return (
        <Tooltip label={label} hint={hint} placement="bottom">
            <button
                type="button"
                aria-label={label}
                onClick={onClick}
                disabled={disabled}
                className="w-7 h-7 flex items-center justify-center rounded-lg transition-colors
                    text-gray-400 dark:text-gray-500
                    hover:bg-gray-100 hover:text-gray-900
                    dark:hover:bg-white/[0.06] dark:hover:text-white
                    disabled:opacity-50 disabled:cursor-default"
            >
                {children}
            </button>
        </Tooltip>
    );
}

/**
 * How fast the turn generated its answer, as the number beside the branch
 * icon. Output tokens over generation seconds only: tool runs and waits
 * are timed out of it. Whole numbers past twenty, one decimal below, so a
 * slow turn still says something.
 */
function formatRate(tps) {
    if (!(tps > 0)) return '';
    const rounded = tps >= 20 ? Math.round(tps) : Math.round(tps * 10) / 10;
    return `${rounded} tok/sec`;
}

/**
 * Copy the reply, or branch a new chat from here.
 *
 * The reply is the last thing the agent wrote in the turn, which is the
 * answer; what it said on the way there, between tool calls, is narration.
 * `rate` is the turn's answer rate ({ tps, tokens, seconds }), shown beside
 * the branch icon when the runtime reported usage to work it out from.
 */
export function TurnActions({ text, onBranch, rate }) {
    const t = useT();
    const [copied, setCopied] = useState(false);
    const [branching, setBranching] = useState(false);
    const timer = useRef(0);
    useEffect(() => () => clearTimeout(timer.current), []);

    const copy = useCallback(async () => {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            try {
                await window.api?.clipboard?.writeText?.(text);
            } catch {
                return;
            }
        }
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
    }, [text]);

    const branch = useCallback(async () => {
        if (branching || !onBranch) return;
        setBranching(true);
        try {
            await onBranch();
        } finally {
            setBranching(false);
        }
    }, [branching, onBranch]);

    const speed = rate ? formatRate(rate.tps) : '';
    // The wall time alongside when the turn spent meaningfully longer than
    // generating: the model wrote at this pace, the turn took that long.
    const showWall = Boolean(rate?.wall && rate.wall > rate.seconds + 1);

    return (
        <div className="flex items-center gap-0.5 select-none">
            {text && (
                <ActionButton label={copied ? t('assistant.copied') : t('assistant.copyResponse')} onClick={copy}>
                    {copied
                        ? <Tick01Icon size={15} strokeWidth={2.25} className="text-emerald-600 dark:text-emerald-400" />
                        : <Copy01Icon size={15} strokeWidth={1.75} />}
                </ActionButton>
            )}
            {onBranch && (
                <ActionButton
                    label={t('assistant.branchChat')}
                    hint={t('assistant.branchChatHint')}
                    onClick={branch}
                    disabled={branching}
                >
                    <GitBranchIcon size={15} strokeWidth={1.75} />
                </ActionButton>
            )}
            {speed && (
                <Tooltip
                    label={showWall
                        ? t('assistant.turnRateHintWall', { tokens: rate.tokens, seconds: rate.seconds, wall: rate.wall })
                        : t('assistant.turnRateHint', { tokens: rate.tokens, seconds: rate.seconds })}
                    placement="bottom"
                >
                    <span className="px-1.5 text-[11px] tabular-nums
                        text-gray-400 dark:text-gray-500">
                        {speed}
                    </span>
                </Tooltip>
            )}
        </div>
    );
}

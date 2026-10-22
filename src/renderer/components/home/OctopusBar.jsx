import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    ArrowDown01Icon,
    ArrowLeft01Icon,
    ArrowRight01Icon,
    OctopusIcon,
    Tick02Icon,
} from 'hugeicons-react';
import Tooltip from '../ui/Tooltip';
import AgentMark from '../assistant/AgentMark';
import { useT } from '../../i18n';
import { useEnterOn } from '../../hooks/useEnter';

/** The chords, as the tooltips show them. Kept with the handler in HomeStart. */
export const OCTOPUS_KEYS = {
    toggle: 'Ctrl+Shift+O',
    previous: 'Alt+←',
    next: 'Alt+→',
};

const STEP = `w-5 h-5 shrink-0 flex items-center justify-center rounded-md transition-colors
    text-gray-400 dark:text-neutral-500
    enabled:hover:bg-black/[0.05] dark:enabled:hover:bg-white/[0.07]
    enabled:hover:text-gray-900 dark:enabled:hover:text-white
    disabled:opacity-40`;

/**
 * The agent a prompt goes to, as a chip with a list under it.
 *
 * Portalled to the body and placed from the chip's rectangle, so Home's
 * scroller cannot clip it.
 */
function AgentPicker({ agents, target, onPick }) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState(null);
    const buttonRef = useRef(null);
    const menuRef = useRef(null);
    useEnterOn(menuRef, open && 'dialog');
    const close = useCallback(() => setOpen(false), []);

    useLayoutEffect(() => {
        if (!open || !buttonRef.current) return;
        const rect = buttonRef.current.getBoundingClientRect();
        const width = menuRef.current?.offsetWidth || 220;
        setPosition({
            top: rect.bottom + 6,
            left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        });
    }, [open]);

    useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event) => {
            if (menuRef.current?.contains(event.target) || buttonRef.current?.contains(event.target)) return;
            close();
        };
        const onKey = (event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            close();
        };
        document.addEventListener('mousedown', onPointer, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('blur', close);
        window.addEventListener('resize', close);
        return () => {
            document.removeEventListener('mousedown', onPointer, true);
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('blur', close);
            window.removeEventListener('resize', close);
        };
    }, [open, close]);

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('home.octopus.pick')}
                onClick={() => setOpen(value => !value)}
                className={`h-5 max-w-[11rem] pl-1 pr-1 flex items-center gap-1 rounded-md transition-colors
                    text-[11px] font-medium
                    ${open
                        ? 'bg-black/[0.05] dark:bg-white/[0.07] text-gray-900 dark:text-white'
                        : 'text-gray-700 dark:text-neutral-200 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]'}`}
            >
                <AgentMark size={13} look={target} />
                <span className="truncate">{target?.name}</span>
                <ArrowDown01Icon size={11} strokeWidth={2} className="shrink-0 text-gray-400 dark:text-neutral-500" />
            </button>
            {open && createPortal(
                <div
                    ref={menuRef}
                    role="menu"
                    className="fixed z-[9999] min-w-[220px] max-h-[50vh] overflow-y-auto p-1 rounded-xl
                        bg-white dark:bg-surface-raised
                        border border-gray-200 dark:border-surface-control
                        shadow-xl shadow-black/10 dark:shadow-black/40"
                    style={{
                        top: position?.top ?? -9999,
                        left: position?.left ?? -9999,
                        visibility: position ? 'visible' : 'hidden',
                    }}
                >
                    <div className="px-2.5 pt-1 pb-1.5 text-[10px] font-medium text-gray-400 dark:text-neutral-500 select-none">
                        {t('home.octopus.sendTo')}
                    </div>
                    {agents.map(agent => (
                        <button
                            key={agent.id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={agent.id === target?.id}
                            onClick={() => { close(); onPick(agent.id); }}
                            className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-xs text-left transition-colors
                                text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-surface-control"
                        >
                            <AgentMark size={14} look={agent} />
                            <span className="font-medium flex-1 truncate">{agent.name}</span>
                            {agent.id === target?.id && (
                                <Tick02Icon size={13} strokeWidth={2} className="shrink-0 text-gray-500 dark:text-neutral-400" />
                            )}
                        </button>
                    ))}
                </div>,
                document.body,
            )}
        </>
    );
}

/**
 * Octopus mode's controls, on the top edge of Home's card.
 *
 * Off, one button that turns it on. On, the agent the next prompt goes to,
 * with a step either side and the list under its name, and a line saying
 * where the last prompt went, since its tab opened behind Home and nothing
 * else on the page moved.
 */
export default function OctopusBar({ on, agents, target, sentTo, onToggle, onPick, onStep }) {
    const t = useT();
    const several = agents.length > 1;

    return (
        <div className="ml-auto flex items-center gap-0.5 min-w-0">
            {on && sentTo && (
                <span
                    key={sentTo.at}
                    role="status"
                    className="mr-1.5 truncate text-[11px] text-gray-400 dark:text-neutral-500"
                >
                    {t('home.octopus.sent', { name: sentTo.name })}
                </span>
            )}
            {on && target && (
                <>
                    <Tooltip label={t('home.octopus.previous')} hint={OCTOPUS_KEYS.previous} placement="top">
                        <button
                            type="button"
                            aria-label={t('home.octopus.previous')}
                            disabled={!several}
                            onClick={() => onStep(-1)}
                            className={STEP}
                        >
                            <ArrowLeft01Icon size={12} strokeWidth={2} />
                        </button>
                    </Tooltip>
                    <AgentPicker agents={agents} target={target} onPick={onPick} />
                    <Tooltip label={t('home.octopus.next')} hint={OCTOPUS_KEYS.next} placement="top">
                        <button
                            type="button"
                            aria-label={t('home.octopus.next')}
                            disabled={!several}
                            onClick={() => onStep(1)}
                            className={STEP}
                        >
                            <ArrowRight01Icon size={12} strokeWidth={2} />
                        </button>
                    </Tooltip>
                </>
            )}
            <Tooltip
                label={on ? t('home.octopus.off') : t('home.octopus.on')}
                hint={OCTOPUS_KEYS.toggle}
                placement="top"
            >
                <button
                    type="button"
                    aria-label={t('home.octopus.title')}
                    aria-pressed={on}
                    onClick={onToggle}
                    className={`ml-1 h-5 w-5 shrink-0 flex items-center justify-center rounded-md transition-colors
                        ${on
                            ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
                            : 'text-gray-400 dark:text-neutral-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07] hover:text-gray-900 dark:hover:text-white'}`}
                >
                    <OctopusIcon size={13} strokeWidth={1.75} />
                </button>
            </Tooltip>
        </div>
    );
}

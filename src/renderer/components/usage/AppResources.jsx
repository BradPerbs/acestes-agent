import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Coffee02Icon, CpuIcon } from 'hugeicons-react';
import Tooltip from '../ui/Tooltip';
import { useEnterOn } from '../../hooks/useEnter';
import { HEADING } from '../../lib/text-styles';
import { localeTag, useT } from '../../i18n';

/**
 * The right end of the status bar: what the app holds in memory, how many tabs
 * it has open, and a coffee cup that keeps the computer awake.
 *
 * The figure is read every few seconds while the window is visible, and more
 * often while its breakdown is open, since that is when someone is watching it
 * move. A hidden window reads nothing.
 */

const EVERY = 5000;
const EVERY_OPEN = 1500;
const PANEL_WIDTH = 264;
const EDGE = 12;

const MUTED = 'text-gray-400 dark:text-neutral-500';

/** `412 MB`, `1.2 GB`. */
function bytes(value) {
    const mb = (value || 0) / (1024 * 1024);
    if (mb < 1000) return `${Math.round(mb)} MB`;
    return `${(mb / 1024).toFixed(mb < 10 * 1024 ? 1 : 0)} GB`;
}

/** The app's memory, read on a timer that stops while the window is hidden. */
function useMemory(interval) {
    const [reading, setReading] = useState(null);

    useEffect(() => {
        let cancelled = false;
        const read = async () => {
            if (document.visibilityState === 'hidden') return;
            try {
                const next = await window.api.system.memory();
                if (!cancelled) setReading(next);
            } catch {
                // Locked, or the window is on its way out. The last figure stays.
            }
        };
        read();
        const timer = setInterval(read, interval);
        document.addEventListener('visibilitychange', read);
        return () => {
            cancelled = true;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', read);
        };
    }, [interval]);

    return reading;
}

/** Main holds the switch, so a reload finds it as it was left. */
function useKeepAwake() {
    const [state, setState] = useState({ awake: false, since: 0 });

    useEffect(() => {
        let cancelled = false;
        window.api.system.keepAwake()
            .then(next => { if (!cancelled && next) setState(next); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    const toggle = useCallback(async () => {
        try {
            const next = await window.api.system.setKeepAwake(!state.awake);
            if (next) setState(next);
        } catch {
            // Nothing changed; the cup still says what is true.
        }
    }, [state.awake]);

    return [state, toggle];
}

function Part({ label, value, total }) {
    const share = total > 0 ? (value / total) * 100 : 0;
    return (
        <div className="flex items-center gap-3 h-6">
            <span className="flex-1 min-w-0 truncate text-[11.5px] text-gray-600 dark:text-gray-300">{label}</span>
            <span className="relative w-14 h-[3px] rounded-full bg-gray-200 dark:bg-white/[0.08] overflow-hidden">
                <span
                    className="absolute inset-y-0 left-0 rounded-full bg-gray-500 dark:bg-neutral-300/80 transition-[width] duration-700"
                    style={{ width: `${Math.max(share, value > 0 ? 3 : 0)}%` }}
                />
            </span>
            <span className="w-14 text-right text-[11.5px] tabular-nums font-medium text-gray-900 dark:text-white">{bytes(value)}</span>
        </div>
    );
}

function Count({ label, value }) {
    return (
        <div className="flex items-center justify-between gap-3 h-6 text-[11.5px]">
            <span className="text-gray-600 dark:text-gray-300">{label}</span>
            <span className="tabular-nums font-medium text-gray-900 dark:text-white">{value}</span>
        </div>
    );
}

function MemoryPanel({ anchor, reading, tabs, onClose }) {
    const t = useT();
    const panelRef = useRef(null);
    const [pos, setPos] = useState(null);

    useEnterOn(panelRef, pos && 'fade');

    // Measured before paint, and held to the window's right edge, which is
    // where the button that opened it sits.
    useLayoutEffect(() => {
        const rect = anchor.current?.getBoundingClientRect();
        if (!rect) return;
        setPos({
            bottom: window.innerHeight - rect.top + 8,
            left: Math.max(EDGE, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - EDGE)),
        });
    }, [anchor]);

    useEffect(() => {
        const handlePointer = (event) => {
            if (panelRef.current?.contains(event.target)) return;
            if (anchor.current?.contains(event.target)) return;
            onClose();
        };
        const handleKey = (event) => { if (event.key === 'Escape') onClose(); };
        document.addEventListener('mousedown', handlePointer);
        document.addEventListener('keydown', handleKey);
        window.addEventListener('resize', onClose);
        window.addEventListener('blur', onClose);
        return () => {
            document.removeEventListener('mousedown', handlePointer);
            document.removeEventListener('keydown', handleKey);
            window.removeEventListener('resize', onClose);
            window.removeEventListener('blur', onClose);
        };
    }, [anchor, onClose]);

    const total = reading?.total || 0;
    const parts = reading?.parts || {};

    return createPortal(
        <div
            ref={panelRef}
            role="dialog"
            aria-label={t('statusBar.memoryTitle')}
            className="fixed z-[9999] app-no-drag rounded-2xl overflow-hidden
                bg-white/95 dark:bg-neutral-900/95 backdrop-blur-xl
                border border-gray-200/80 dark:border-white/[0.08]
                shadow-[0_24px_64px_-12px_rgba(0,0,0,0.35)] dark:shadow-[0_24px_64px_-12px_rgba(0,0,0,0.7)]"
            style={{
                bottom: pos?.bottom ?? -9999,
                left: pos?.left ?? EDGE,
                width: PANEL_WIDTH,
                visibility: pos ? 'visible' : 'hidden',
            }}
        >
            <header className="px-4 pt-3.5 pb-3 border-b border-gray-100 dark:border-white/[0.06]">
                <p className={HEADING}>{t('statusBar.memoryTitle')}</p>
                <p className="mt-1 flex items-baseline gap-2">
                    <span className="text-[20px] font-semibold tracking-tight tabular-nums text-gray-900 dark:text-white">{bytes(total)}</span>
                    {reading?.system?.total > 0 && (
                        <span className={`text-[11px] tabular-nums ${MUTED}`}>
                            {t('statusBar.memoryOf', { total: bytes(reading.system.total), count: reading.processes })}
                        </span>
                    )}
                </p>
            </header>

            <div className="px-4 py-2">
                <Part label={t('statusBar.memoryMain')} value={parts.main} total={total} />
                <Part label={t('statusBar.memoryWindows')} value={parts.windows} total={total} />
                <Part label={t('statusBar.memoryGpu')} value={parts.gpu} total={total} />
                <Part label={t('statusBar.memoryOther')} value={parts.other} total={total} />
            </div>

            <div className="px-4 py-2 border-t border-gray-100 dark:border-white/[0.06]">
                <Count label={t('statusBar.tabsSessions')} value={tabs.sessions} />
                <Count label={t('statusBar.tabsConversations')} value={tabs.conversations} />
                <Count label={t('statusBar.tabsOpen')} value={tabs.open} />
            </div>

            <p className={`px-4 pt-2 pb-3 text-[10.5px] leading-snug border-t border-gray-100 dark:border-white/[0.06] ${MUTED}`}>
                {t('statusBar.memoryNote')}
            </p>
        </div>,
        document.body
    );
}

export default function AppResources({ tabs }) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const reading = useMemory(open ? EVERY_OPEN : EVERY);
    const [awake, toggleAwake] = useKeepAwake();
    const buttonRef = useRef(null);
    const close = useCallback(() => setOpen(false), []);

    const since = awake.since
        ? new Date(awake.since).toLocaleTimeString(localeTag(), { hour: 'numeric', minute: '2-digit' })
        : '';

    return (
        <div className="flex items-center gap-0.5 -mr-1.5">
            <Tooltip label={t('statusBar.memoryHint')} placement="top" enabled={!open}>
                <button
                    ref={buttonRef}
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-label={t('statusBar.memoryTitle')}
                    onClick={() => setOpen(value => !value)}
                    className={`h-5 px-1.5 flex items-center gap-2 rounded-md text-[10.5px] leading-none
                        tabular-nums font-medium transition-colors outline-none text-gray-500 dark:text-neutral-400
                        focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25
                        ${open ? 'bg-gray-200 dark:bg-white/[0.08]' : 'hover:bg-gray-200/80 dark:hover:bg-white/[0.06]'}`}
                >
                    <span className="flex items-center gap-1.5">
                        <CpuIcon size={11} strokeWidth={2} className={MUTED} />
                        <span className="text-gray-600 dark:text-gray-300">{reading ? bytes(reading.total) : '—'}</span>
                    </span>
                    <span aria-hidden="true" className="w-px h-2.5 bg-gray-300 dark:bg-white/10" />
                    <span>{t('statusBar.tabs', { count: tabs.open })}</span>
                </button>
            </Tooltip>

            <Tooltip
                label={awake.awake ? t('statusBar.awakeOn', { since }) : t('statusBar.awakeOff')}
                placement="top"
            >
                <button
                    type="button"
                    role="switch"
                    aria-checked={awake.awake}
                    aria-label={t('statusBar.awakeLabel')}
                    onClick={toggleAwake}
                    className={`h-5 w-6 flex items-center justify-center rounded-md transition-colors outline-none
                        focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25
                        ${awake.awake
                            ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/15'
                            : 'text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/80 dark:hover:bg-white/[0.06]'}`}
                >
                    <Coffee02Icon size={12} strokeWidth={awake.awake ? 2.2 : 1.8} />
                </button>
            </Tooltip>

            {open && <MemoryPanel anchor={buttonRef} reading={reading} tabs={tabs} onClose={close} />}
        </div>
    );
}

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ArrowDown01Icon, ArrowDownDoubleIcon, ArrowLeft01Icon, ArrowRight01Icon, ArrowRightDoubleIcon, Cancel01Icon, CommandLineIcon, Folder01Icon, PlusSignIcon, Refresh01Icon } from 'hugeicons-react';
import { resolveTerminalTheme, useTerminalTheme } from '../../hooks/useTerminalTheme';
import { resolveFontFamily, useTerminalSettings } from '../../hooks/useTerminalSettings';
import { readDefaultShell, useShells, writeDefaultShell } from '../../hooks/useLocalTerminals';
import MenuButton from '../ui/MenuButton';
import Tooltip from '../ui/Tooltip';
import { HAIRLINE, HeaderButton } from './AssistantConversation';
import { PANE_HEADER_HEIGHT } from '../../lib/layout';
import { useT } from '../../i18n';

/**
 * Shells on this computer, beside a conversation.
 *
 * For running the thing the agent is working on: `npm run dev` in one tab and
 * the tests in another while the chat edits the code. Each tab is its own
 * shell, whichever the machine has (PowerShell, Git Bash, Command Prompt, a
 * WSL distribution, zsh), picked from the menu beside the plus.
 *
 * The shells live in main (see local-terminal.js) and outlive these
 * components, which are remounted whenever the conversation moves in or out
 * of the split view and unmounted whenever the panel is put away: that lets
 * go of the ports, and mounting again with the same ids attaches to the
 * running shells with their recent output replayed. Only closing a tab, or
 * the conversation, ends one.
 *
 * Deliberately smaller than TerminalView, which is a host's session with
 * SFTP, tunnels, recording and reconnects. This is shells and their output.
 */

/** Wait this long after the last resize before telling the shell. */
const RESIZE_DEBOUNCE_MS = 60;

/** The last part of a folder's path, which is how a tab names it. */
const folderName = (path) => String(path || '').split(/[\\/]+/).filter(Boolean).pop() || String(path || '');

/* ------------------------------------------------------------------ *
 * Colours: the app's, not a terminal theme's
 * ------------------------------------------------------------------ */

/**
 * Whether the app is dark right now. Read off the root's class, which is the
 * one thing every theme choice (light, dark, system, a custom palette) ends
 * up setting, and watched, so switching the app switches these at once.
 */
function useAppDark() {
    const read = () => document.documentElement.classList.contains('dark');
    const [dark, setDark] = useState(read);
    useEffect(() => {
        const observer = new MutationObserver(() => setDark(read()));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);
    return dark;
}

/**
 * Text colours for a light app. GitHub's light palette: every colour legible
 * on white, including the yellow PowerShell writes commands in and the ones
 * Git Bash draws its prompt with.
 */
const LIGHT_TERMINAL = {
    foreground: '#1f2328',
    cursor: '#1f2328',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(9, 105, 218, 0.18)',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#7d4e00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f',
};

/**
 * The terminal's colours inside the app.
 *
 * The background is transparent, so the panel is exactly the surface the
 * chat beside it sits on, whichever theme or custom palette that is, with
 * nothing to keep in step. The text is the light palette on a light app, and
 * on a dark one the terminal theme picked in the settings, whose colours the
 * dark ramp was designed alongside.
 */
function panelTheme(dark, terminalTheme) {
    const transparent = 'rgba(0, 0, 0, 0)';
    if (!dark) return { ...LIGHT_TERMINAL, background: transparent };
    return {
        ...terminalTheme,
        background: transparent,
        selectionBackground: terminalTheme.selectionBackground || 'rgba(255, 255, 255, 0.18)',
    };
}

/**
 * One shell's screen.
 *
 * `generation` is bumped by a restart, which rebuilds the terminal and opens a
 * new shell under the same id.
 */
const LocalTerminalView = memo(function LocalTerminalView({
    id,
    shellId,
    cwd,
    agentId,
    generation,
    visible,
    settled,
    theme,
    options,
    onStarted,
    onExited,
    onClose,
}) {
    const t = useT();
    const hostRef = useRef(null);
    const termRef = useRef(null);
    const fitRef = useRef(null);
    const [failure, setFailure] = useState('');

    // Built once the panel has finished sliding in, and kept from then on.
    // Building an xterm is a long frame, and the slide is a layout animation
    // on the same thread: done mid-slide it is a visible hitch. The shell's
    // prompt takes longer than the slide to arrive anyway.
    const [ready, setReady] = useState(settled);
    useEffect(() => {
        if (settled) setReady(true);
    }, [settled]);

    // Read when the terminal is built; a change applies to the next one.
    const optionsRef = useRef(options);
    optionsRef.current = options;
    const callbacks = useRef({ onStarted, onExited });
    callbacks.current = { onStarted, onExited };
    const visibleRef = useRef(visible);
    visibleRef.current = visible;

    const fit = useCallback(() => {
        const term = termRef.current;
        const fitAddon = fitRef.current;
        const element = hostRef.current;
        if (!term || !fitAddon || !element || element.clientWidth === 0 || element.clientHeight === 0) return;
        try {
            fitAddon.fit();
        } catch {
            // Measured mid-layout; the next resize gets it.
        }
        window.api.ssh.resize(id, term.cols, term.rows);
    }, [id]);

    useEffect(() => {
        const element = hostRef.current;
        if (!element || !ready) return undefined;

        let disposed = false;
        let teardown = () => {};
        setFailure('');

        // xterm measures its cell from the font loaded when it is built. Built
        // before the terminal face arrives, it measures the fallback, and the
        // last column is drawn off the edge; TerminalView waits the same way.
        const mountOptions = optionsRef.current;
        const fontReady = document.fonts?.load
            ? document.fonts.load(`${mountOptions.fontWeight} ${mountOptions.fontSize}px ${mountOptions.fontFamily}`).catch(() => {})
            : Promise.resolve();

        fontReady.then(() => {
            if (disposed) return;
            teardown = build(element);
        });

        return () => {
            disposed = true;
            teardown();
        };

        /** The terminal itself, once its font is in; returns its cleanup. */
        function build(host) {
            const term = new Terminal({
                ...optionsRef.current,
                theme,
                allowProposedApi: true,
                // So the app surface shows through: see panelTheme.
                allowTransparency: true,
                fastScrollModifier: 'alt',
            });
            const fitAddon = new FitAddon();
            term.loadAddon(fitAddon);
            term.loadAddon(new WebLinksAddon((event, uri) => {
                // A dev server's "Local: http://localhost:5173" is the link
                // that gets clicked here, so a plain click opens it.
                if (event.button !== 0 || term.hasSelection()) return;
                Promise.resolve(window.api.links?.open(uri)).catch(() => {});
            }));
            term.open(host);
            termRef.current = term;
            fitRef.current = fitAddon;

            // Ctrl+Shift+C and V copy and paste; plain Ctrl+C stays an
            // interrupt, which is the point of a terminal a dev server runs in.
            term.attachCustomKeyEventHandler((event) => {
                if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey || event.altKey) return true;
                if (event.code === 'KeyC') {
                    event.preventDefault();
                    const selection = term.getSelection();
                    if (selection) window.api.clipboard?.writeText(selection);
                    return false;
                }
                if (event.code === 'KeyV') {
                    event.preventDefault();
                    Promise.resolve(window.api.clipboard?.readText()).then((text) => {
                        if (text) window.api.ssh.sendInput(id, text);
                    });
                    return false;
                }
                return true;
            });

            term.onData((data) => window.api.ssh.sendInput(id, data));

            const unsubscribe = window.api.ssh.onData(id, (message) => {
                if (message.type === 'data') term.write(message.data);
                // The shell ended itself (`exit`); its tab goes with it.
                else if (message.type === 'disconnected') callbacks.current.onExited?.();
            });

            try {
                fitAddon.fit();
            } catch {
                // Not laid out yet; the observer below fits it once it is.
            }
            window.api.ssh.openLocal({ id, agentId, shellId, cwd, cols: term.cols, rows: term.rows }).then((result) => {
                if (disposed) return;
                if (result?.success) {
                    callbacks.current.onStarted?.(result);
                    // A shell just started is one somebody asked for and is
                    // about to type into; one attached to again after a
                    // remount is not a reason to take the keys from the chat.
                    if (!result.attached && visibleRef.current) term.focus();
                } else {
                    setFailure(result?.message || t('assistant.localTerminalFailed'));
                }
            });

            let timer = 0;
            const observer = new ResizeObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(fit, RESIZE_DEBOUNCE_MS);
            });
            observer.observe(host);

            return () => {
                clearTimeout(timer);
                observer.disconnect();
                unsubscribe?.();
                // The port only: the shell keeps running for the next mount.
                window.api.ssh.release(id);
                term.dispose();
                termRef.current = null;
                fitRef.current = null;
            };
        }
        // The theme is applied live below; rebuilding for it would drop the screen.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, generation, ready]);

    useEffect(() => {
        if (termRef.current) termRef.current.options.theme = theme;
    }, [theme]);

    // A tab behind another keeps its size from before; coming to the front is
    // when a resize in between is caught up with. The keys follow only when
    // the user was already in the panel, picking this tab: a conversation
    // coming to the front keeps them in its chat.
    useEffect(() => {
        if (!visible) return;
        fit();
        if (hostRef.current?.closest('[data-local-terminals]')?.contains(document.activeElement)) {
            termRef.current?.focus();
        }
    }, [visible, fit]);

    return (
        <>
            {/* The padding sits outside the element xterm measures: the fit
                addon reads its parent's box, and a padded one hands it
                columns that are drawn off the edge. */}
            <div className="absolute inset-0 px-2 py-1.5">
                <div ref={hostRef} className="w-full h-full" />
            </div>
            {failure && (
                <div className="absolute inset-0 flex items-center justify-center p-6">
                    <div className="max-w-sm flex flex-col items-center gap-3 text-center">
                        <span className="text-xs text-gray-600 dark:text-neutral-300">{failure}</span>
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-3 h-8 rounded-xl text-xs font-medium transition-colors
                                bg-gray-100 text-gray-900 hover:bg-gray-200
                                dark:bg-surface-control dark:text-white dark:hover:bg-surface-hover"
                        >
                            {t('assistant.localTerminalCloseTab')}
                        </button>
                    </div>
                </div>
            )}
        </>
    );
});

/**
 * Where a new terminal should start, asked in the tab itself when the agent
 * has more than one folder. Arrows and Enter pick, Escape closes the tab;
 * the list takes the keys as soon as it appears.
 */
function FolderPicker({ folders, onPick, onCancel }) {
    const t = useT();
    const [index, setIndex] = useState(0);
    const listRef = useRef(null);

    useEffect(() => { listRef.current?.focus(); }, []);

    const onKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setIndex(value => (value + 1) % folders.length);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setIndex(value => (value - 1 + folders.length) % folders.length);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            onPick(folders[index].path);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
        }
    };

    return (
        <div className="absolute inset-0 overflow-y-auto flex items-center justify-center p-6">
            <div className="local-term-picker w-full max-w-sm">
                <p className="mb-2 px-1 text-xs font-semibold text-gray-900 dark:text-white">
                    {t('assistant.localTerminalWhere')}
                </p>
                <div
                    ref={listRef}
                    role="listbox"
                    tabIndex={0}
                    aria-label={t('assistant.localTerminalWhere')}
                    onKeyDown={onKeyDown}
                    className="p-1 rounded-2xl border outline-none border-gray-200 bg-white
                        dark:border-neutral-700 dark:bg-surface-control/60
                        focus-visible:ring-2 focus-visible:ring-gray-900/10 dark:focus-visible:ring-white/15"
                >
                    {folders.map((folder, position) => (
                        <button
                            key={folder.path}
                            type="button"
                            role="option"
                            aria-selected={position === index}
                            tabIndex={-1}
                            onMouseEnter={() => setIndex(position)}
                            onClick={() => onPick(folder.path)}
                            className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left transition-colors outline-none ${
                                position === index ? 'bg-gray-100 dark:bg-surface-hover' : ''
                            }`}
                        >
                            <Folder01Icon size={16} strokeWidth={1.75} className="shrink-0 text-gray-500 dark:text-neutral-400" />
                            <span className="min-w-0 flex-1">
                                <span className="block text-xs font-medium text-gray-900 dark:text-white truncate">{folder.name}</span>
                                <span className="block text-[11px] text-gray-500 dark:text-neutral-400 truncate" title={folder.path}>
                                    {folder.path}
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

/** A nudge along the tab strip, shown only at an end with tabs past it. */
function StripArrow({ direction, label, onClick }) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={onClick}
            className="shrink-0 w-6 h-7 flex items-center justify-center rounded-lg transition-colors outline-none
                text-gray-500 dark:text-gray-400 hover:bg-gray-100 hover:text-gray-900
                dark:hover:bg-surface-control dark:hover:text-white"
        >
            {direction < 0
                ? <ArrowLeft01Icon size={14} strokeWidth={2} />
                : <ArrowRight01Icon size={14} strokeWidth={2} />}
        </button>
    );
}

/** One terminal's tab: the shell it runs, and its close button. */
function TerminalTab({ label, ordinal = 1, title, active, onSelect, onClose }) {
    const t = useT();
    const ref = useRef(null);
    // The tab in front is always wholly on screen, close button included,
    // however many tabs the strip is scrolling.
    useEffect(() => {
        if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [active]);
    return (
        // Shrinks before the strip has to scroll, the way browser tabs do,
        // down to a width that still shows the start of the name and the
        // close button. A middle click closes it, as a browser tab does.
        <div
            ref={ref}
            onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
            onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                onClose();
            }}
            className={`local-term-tab group min-w-[7.5rem] max-w-[14rem] h-7 pl-2 pr-1 flex items-center gap-1.5 rounded-lg text-xs transition-colors ${
                active
                    ? 'bg-gray-100 text-gray-900 dark:bg-surface-control dark:text-white'
                    : 'text-gray-500 dark:text-neutral-400 hover:bg-gray-100/70 hover:text-gray-900 dark:hover:bg-surface-control/60 dark:hover:text-white'
            }`}
            style={{ flex: '0 1 auto' }}
        >
            <button
                type="button"
                onClick={onSelect}
                // The whole name, which a narrow tab cannot show, and where it is.
                title={[ordinal > 1 ? `${label} ${ordinal}` : label, title].filter(Boolean).join('\n')}
                className="min-w-0 flex-1 flex items-center gap-1.5 outline-none"
            >
                <CommandLineIcon size={13} strokeWidth={1.75} className="shrink-0" />
                <span className="min-w-0 font-medium whitespace-nowrap truncate">{label}</span>
                {ordinal > 1 && (
                    <span className="shrink-0 min-w-[1rem] h-4 px-1 rounded-md text-[10px] leading-4 font-semibold text-center
                        bg-gray-200/80 text-gray-600 dark:bg-white/10 dark:text-neutral-300"
                    >
                        {ordinal}
                    </span>
                )}
            </button>
            <button
                type="button"
                aria-label={t('assistant.localTerminalCloseTab')}
                onClick={onClose}
                className={`shrink-0 w-5 h-5 flex items-center justify-center rounded-md transition-opacity outline-none
                    hover:bg-gray-200 dark:hover:bg-white/10 ${active ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70'}`}
            >
                <Cancel01Icon size={11} strokeWidth={2} />
            </button>
        </div>
    );
}

function LocalTerminalPanel({ terminals, agentId = '', visible = true, settled = true, direction = 'row' }) {
    const t = useT();
    const { shells, refresh } = useShells();
    const { terminalTheme, customTerminalTheme } = useTerminalTheme();
    const { terminalSettings } = useTerminalSettings();
    const dark = useAppDark();
    const theme = useMemo(
        () => panelTheme(dark, resolveTerminalTheme(terminalTheme, customTerminalTheme)),
        [dark, terminalTheme, customTerminalTheme],
    );
    const options = useMemo(() => ({
        fontFamily: resolveFontFamily(terminalSettings.fontFamily),
        fontSize: terminalSettings.fontSize,
        fontWeight: terminalSettings.fontWeight,
        fontWeightBold: Math.min(900, terminalSettings.fontWeight + 300),
        lineHeight: terminalSettings.lineHeight,
        letterSpacing: terminalSettings.letterSpacing,
        cursorStyle: terminalSettings.cursorStyle,
        cursorBlink: terminalSettings.cursorBlink,
        scrollback: terminalSettings.scrollback,
    }), [terminalSettings]);

    // The agent's folders, which decide where a new shell starts: straight
    // into the only one, or a choice between several. Null while asking.
    const [agentFolders, setAgentFolders] = useState(null);
    useEffect(() => {
        let live = true;
        setAgentFolders(null);
        Promise.resolve(window.api.ssh.localFolders?.(agentId))
            .then((list) => { if (live) setAgentFolders(Array.isArray(list) ? list : []); })
            .catch(() => { if (live) setAgentFolders([]); });
        return () => { live = false; };
    }, [agentId]);
    const manyFolders = (agentFolders?.length || 0) > 1;

    const { add, select, remove, restart, settle, chooseFolder, hide } = terminals;
    const defaultShell = readDefaultShell() || shells[0]?.id || '';

    // A tab is named for its shell and the folder it is in, `~` for home, so
    // a shell that is not where it was meant to be says so; numbered when
    // two are otherwise the same.
    const labels = useMemo(() => {
        const seen = new Map();
        return new Map(terminals.terminals.map((term) => {
            const shell = shells.find(entry => entry.id === term.shellId)?.label
                || shells.find(entry => entry.id === defaultShell)?.label
                || t('assistant.localTerminal');
            const where = term.home ? '~' : folderName(term.cwd);
            const name = where ? `${shell} · ${where}` : shell;
            const count = (seen.get(name) || 0) + 1;
            seen.set(name, count);
            // The number is kept apart from the name: a narrow tab truncates
            // its name, and the number is what tells two of them apart.
            return [term.id, { name, ordinal: count }];
        }));
    }, [terminals.terminals, shells, defaultShell, t]);

    /**
     * What a terminal's area shows: its shell, a folder picker when it is new
     * and there is a choice to make, or nothing yet while the folders are
     * still being read. One restored from a remount is already running
     * somewhere, and attaches whatever the folders are.
     */
    const stageOf = (term) => {
        if (term.restored || term.cwd) return 'shell';
        if (agentFolders === null) return 'waiting';
        return manyFolders ? 'pick' : 'shell';
    };

    // Which ends of the tab strip have tabs past them, for the arrows and the
    // fades. Measured on scroll, on resize, and whenever the tabs change.
    const stripRef = useRef(null);
    const [edges, setEdges] = useState({ left: false, right: false });
    const measureEdges = useCallback(() => {
        const strip = stripRef.current;
        if (!strip) return;
        const left = strip.scrollLeft > 1;
        // A couple of pixels of slack: a strip scrolled to its end by
        // scrollIntoView can stop a subpixel or two short of it.
        const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 3;
        setEdges(previous => (previous.left === left && previous.right === right ? previous : { left, right }));
    }, []);
    useEffect(() => {
        const strip = stripRef.current;
        if (!strip) return undefined;
        const observer = new ResizeObserver(measureEdges);
        observer.observe(strip);
        return () => observer.disconnect();
    }, [measureEdges]);
    useLayoutEffect(measureEdges, [measureEdges, terminals.terminals, labels]);

    const scrollStrip = useCallback((direction) => {
        const strip = stripRef.current;
        if (!strip) return;
        strip.scrollBy({ left: direction * Math.max(120, strip.clientWidth * 0.7), behavior: 'smooth' });
    }, []);

    const menuItems = useMemo(() => [
        ...shells.map(shell => ({
            label: shell.label,
            hint: shell.id === defaultShell ? t('assistant.localTerminalDefault') : '',
            icon: <CommandLineIcon size={14} strokeWidth={1.75} />,
            onSelect: () => {
                writeDefaultShell(shell.id);
                add(shell.id);
            },
        })),
        { separator: true },
        { label: t('assistant.localTerminalRescan'), icon: <Refresh01Icon size={14} strokeWidth={1.75} />, onSelect: refresh },
    ], [shells, defaultShell, add, refresh, t]);

    return (
        // Keys typed here are the shell's: the conversation's own Ctrl+W and
        // Ctrl+T must not see them, or deleting a word closes the chat.
        <div data-local-terminals className="absolute inset-0 flex flex-col" onKeyDown={(event) => event.stopPropagation()}>
            <div
                className={`shrink-0 pl-2 pr-2 flex items-center gap-1 border-b ${HAIRLINE}`}
                style={{ height: PANE_HEADER_HEIGHT }}
            >
                {/* The arrows sit over the strip's faded ends rather than
                    beside it, so showing one never narrows the strip and
                    pushes the tab just scrolled into view back out of it. */}
                <div className="relative min-w-0 flex-1 flex items-center">
                    {edges.left && (
                        <div className="absolute left-0 inset-y-0 z-10 flex items-center">
                            <StripArrow direction={-1} label={t('assistant.localTerminalScrollLeft')} onClick={() => scrollStrip(-1)} />
                        </div>
                    )}
                    <div
                        ref={stripRef}
                        className="local-term-strip min-w-0 flex-1 flex items-center gap-1 overflow-x-auto scrollbar-none"
                        // Room under each arrow, so a tab scrolled into view
                        // lands clear of it, close button and all.
                        style={{ scrollPaddingInline: 28 }}
                        data-fade-left={edges.left ? 'true' : 'false'}
                        data-fade-right={edges.right ? 'true' : 'false'}
                        onScroll={measureEdges}
                        // The wheel scrolls the strip sideways, as the
                        // workspace's strip does: a row that cannot move
                        // vertically is being asked to move the way it can.
                        onWheel={(event) => {
                            if (event.deltaY === 0 || event.deltaX !== 0) return;
                            event.currentTarget.scrollLeft += event.deltaY;
                        }}
                    >
                        {terminals.terminals.map(term => (
                            <TerminalTab
                                key={term.id}
                                label={labels.get(term.id)?.name}
                                ordinal={labels.get(term.id)?.ordinal}
                                title={term.home ? t('assistant.localTerminalHomeHint', { path: term.cwd }) : (term.cwd || '')}
                                active={term.id === terminals.activeId}
                                onSelect={() => select(term.id)}
                                onClose={() => remove(term.id)}
                            />
                        ))}
                    </div>
                    {edges.right && (
                        <div className="absolute right-0 inset-y-0 z-10 flex items-center">
                            <StripArrow direction={1} label={t('assistant.localTerminalScrollRight')} onClick={() => scrollStrip(1)} />
                        </div>
                    )}
                </div>
                {/* Outside the scrolling strip, so however many tabs there
                    are, a new one is always a click away. */}
                <div className="shrink-0 flex items-center">
                    <Tooltip label={t('assistant.localTerminalNew')}>
                        <button
                            type="button"
                            aria-label={t('assistant.localTerminalNew')}
                            onClick={() => add(defaultShell)}
                            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-colors outline-none
                                text-gray-500 dark:text-gray-400 hover:bg-gray-100 hover:text-gray-900
                                dark:hover:bg-surface-control dark:hover:text-white"
                        >
                            <PlusSignIcon size={15} strokeWidth={2} />
                        </button>
                    </Tooltip>
                    <MenuButton
                        icon={<ArrowDown01Icon size={14} strokeWidth={2} />}
                        title={t('assistant.localTerminalPick')}
                        items={menuItems}
                        align="left"
                        className="!w-6 !h-7 !rounded-lg"
                    />
                </div>
                {terminals.activeId && (
                    <HeaderButton
                        title={t('assistant.localTerminalRestart')}
                        icon={<Refresh01Icon size={16} strokeWidth={1.75} />}
                        onClick={() => restart(terminals.activeId)}
                    />
                )}
                <HeaderButton
                    title={t('assistant.localTerminalHide')}
                    hint={t('assistant.localTerminalHideHint')}
                    icon={direction === 'row'
                        ? <ArrowRightDoubleIcon size={16} strokeWidth={1.75} />
                        : <ArrowDownDoubleIcon size={16} strokeWidth={1.75} />}
                    onClick={hide}
                />
            </div>
            {/* No background of its own: the terminals are transparent and
                this is the surface the chat sits on. See panelTheme. */}
            <div className="relative flex-1 min-h-0">
                {terminals.terminals.map((term) => {
                    const stage = stageOf(term);
                    // Only the chat in front draws the shells. Every chat of
                    // the project stays mounted and shares this list, and two
                    // live views of one shell would fight over its port: the
                    // second attach replays the backlog into both. The tabs
                    // above stay live everywhere; the screens attach here.
                    const live = visible && stage !== 'waiting';
                    return (
                        // Left to inherit when in front: an explicit `visible`
                        // would show through a conversation tab that is hidden.
                        <div
                            key={term.id}
                            className="absolute inset-0"
                            style={{ visibility: term.id === terminals.activeId ? undefined : 'hidden' }}
                        >
                            {live && stage === 'pick' && (
                                <FolderPicker
                                    folders={agentFolders}
                                    onPick={(path) => chooseFolder(term.id, path)}
                                    onCancel={() => remove(term.id)}
                                />
                            )}
                            {live && stage === 'shell' && (
                                <LocalTerminalView
                                    id={term.id}
                                    shellId={term.shellId}
                                    cwd={term.cwd || agentFolders?.[0]?.path || ''}
                                    agentId={agentId}
                                    generation={term.generation}
                                    visible={visible && term.id === terminals.activeId}
                                    settled={settled}
                                    theme={theme}
                                    options={options}
                                    onStarted={(result) => settle(term.id, result)}
                                    onExited={() => remove(term.id)}
                                    onClose={() => remove(term.id)}
                                />
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export default memo(LocalTerminalPanel);

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * The terminals of one project: which there are, which is in front, and
 * whether the panel is showing.
 *
 * One project, one set of terminals, whichever chat is looking at it: opening
 * a shell from a chat attaches it to the project (the agent), so every other
 * chat of the same project shows the same tabs. Switching chats neither
 * starts nor ends anything; a terminal ends when its tab is closed, when its
 * project is removed, or when its shell exits on its own.
 *
 * The shells themselves live in main (see local-terminal.js) and outlive any
 * one chat's panel, which is remounted whenever its conversation moves in or
 * out of the split view. So each project's list is kept in session storage by
 * project key and shared between every hook mounted for it: a remount reads
 * it back and attaches to the same shells, a window reload (whose shells main
 * ends) reads it back too but finds them gone and starts new ones, and a
 * fresh start of the app starts with nothing open.
 *
 * The list, the tabs and the panel's open state are what is shared. The
 * screens are not: only the chat in front draws them (see LocalTerminalPanel),
 * since every chat stays mounted, hidden ones included, and two live views of
 * one shell would fight over its port.
 */

const stateKey = (key) => `assistant.localTerminal.v3:${key}`;
/** Where a chat's terminals were kept before they belonged to its project. */
const legacyStateKey = (tabId) => `assistant.localTerminal.v2:${tabId}`;
const DEFAULT_SHELL_KEY = 'assistant.localTerminal.shell.v1';

/** The store key for a chat's terminals: its project when it has one. */
export const localTerminalKey = (agentId, tabId) => (
    agentId ? `agent:${agentId}` : `chat:${tabId}`
);

/**
 * The group a project's terminal ids share: `<group>:<n>`. Mirrored in main
 * (see local-terminal.js `groupForAgent`), which ends the group when the
 * project is removed.
 */
export const localTerminalGroupForAgent = (agentId) => `local-agent-${agentId}`;

/** A chat with no project yet keeps its own terminals, as they always were. */
export const localTerminalGroupForChat = (tabId) => `local-${tabId}`;

export const localTerminalGroup = (agentId, tabId) => (
    agentId ? localTerminalGroupForAgent(agentId) : localTerminalGroupForChat(tabId)
);

const EMPTY = { open: false, terminals: [], activeId: '', seq: 0 };

/** Store key -> `{ state, adoptedTabId, listeners }`, shared by every hook for it. */
const shared = new Map();

function normalizeState(stored) {
    if (!stored || !Array.isArray(stored.terminals)) return null;
    // Read back from a remount, so each one's shell may well be running:
    // it attaches rather than asking for a folder again.
    const terminals = stored.terminals
        .filter(term => term && typeof term.id === 'string')
        .map(term => ({
            id: term.id,
            shellId: String(term.shellId || ''),
            cwd: String(term.cwd || ''),
            home: Boolean(term.home),
            restored: true,
            generation: 0,
        }));
    return {
        open: Boolean(stored.open) && terminals.length > 0,
        terminals,
        activeId: terminals.some(term => term.id === stored.activeId) ? stored.activeId : (terminals[0]?.id || ''),
        seq: Number.isInteger(stored.seq) ? stored.seq : terminals.length,
    };
}

function readState(key, tabId) {
    try {
        const state = normalizeState(JSON.parse(sessionStorage.getItem(stateKey(key)) || 'null'));
        if (state) return { state, adopted: false };
    } catch {
        // Unreadable: fall through to the chat's own slot below.
    }
    // Opened before terminals belonged to the project: the chat's own list
    // becomes the project's, so what is already running stays visible. The
    // second chat of the same project to mount adopts nothing; whatever it
    // had is left to the reload, which ends shells main no longer hears from.
    if (tabId) {
        try {
            const state = normalizeState(JSON.parse(sessionStorage.getItem(legacyStateKey(tabId)) || 'null'));
            if (state && state.terminals.length > 0) return { state, adopted: true };
        } catch {
            // Same as above.
        }
    }
    return { state: { ...EMPTY }, adopted: false };
}

function writeState(key, state) {
    try {
        sessionStorage.setItem(stateKey(key), JSON.stringify({
            open: state.open,
            terminals: state.terminals.map(term => ({ id: term.id, shellId: term.shellId, cwd: term.cwd, home: term.home })),
            activeId: state.activeId,
            seq: state.seq,
        }));
    } catch {
        // Storage blocked; the panel still works for this run.
    }
}

function entryFor(key, tabId) {
    let entry = shared.get(key);
    if (!entry) {
        const { state, adopted } = readState(key, tabId);
        entry = { state, adoptedTabId: adopted ? tabId : '', listeners: new Set() };
        shared.set(key, entry);
    }
    return entry;
}

/* ------------------------------------------------------------------ *
 * The shells on this machine, and which one a new terminal gets
 * ------------------------------------------------------------------ */

let shellsPromise = null;

/** Asked of main once per window; `fresh` looks again for one installed since. */
export function loadShells({ fresh = false } = {}) {
    if (!shellsPromise || fresh) {
        shellsPromise = Promise.resolve(window.api.ssh.localShells?.({ fresh }))
            .then(list => (Array.isArray(list) ? list : []))
            .catch(() => []);
    }
    return shellsPromise;
}

export function useShells() {
    const [shells, setShells] = useState([]);
    useEffect(() => {
        let live = true;
        loadShells().then((list) => { if (live) setShells(list); });
        return () => { live = false; };
    }, []);
    const refresh = useCallback(() => loadShells({ fresh: true }).then(setShells), []);
    return { shells, refresh };
}

/** The shell the user picked last, which is what the plus button opens. */
export function readDefaultShell() {
    try {
        return localStorage.getItem(DEFAULT_SHELL_KEY) || '';
    } catch {
        return '';
    }
}

export function writeDefaultShell(shellId) {
    try {
        localStorage.setItem(DEFAULT_SHELL_KEY, shellId);
    } catch {
        // As above.
    }
}

/* ------------------------------------------------------------------ *
 * The hook
 * ------------------------------------------------------------------ */

export default function useLocalTerminals(agentId, tabId) {
    const key = localTerminalKey(agentId, tabId);
    const group = localTerminalGroup(agentId, tabId);
    // One entry per project, whatever mounted first: `tabId` is only read
    // when the entry is made, to adopt that chat's pre-project list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const entry = useMemo(() => entryFor(key, tabId), [key]);

    const [state, setState] = useState(() => entry.state);

    useEffect(() => {
        // Persist the adopted list under the project key, and forget the
        // chat's own slot it came from.
        writeState(key, entry.state);
        if (entry.adoptedTabId) {
            const adopted = entry.adoptedTabId;
            entry.adoptedTabId = '';
            try {
                sessionStorage.removeItem(legacyStateKey(adopted));
            } catch {
                // Storage blocked; the stale slot is simply read never again.
            }
        }
        const notify = () => setState(entry.state);
        entry.listeners.add(notify);
        // Another chat of the project may have moved it since this render.
        notify();
        return () => { entry.listeners.delete(notify); };
    }, [entry, key]);

    const update = useCallback((fn) => {
        const live = entryFor(key);
        const next = fn(live.state);
        if (!next || next === live.state) return;
        live.state = next;
        writeState(key, next);
        live.listeners.forEach((notify) => notify());
    }, [key]);

    /** A new terminal in front, on `shellId` or the default shell. */
    const add = useCallback((shellId = '') => {
        update((previous) => {
            const seq = previous.seq + 1;
            const id = `${group}:${seq}`;
            return {
                open: true,
                seq,
                terminals: [...previous.terminals, { id, shellId: shellId || readDefaultShell(), cwd: '', restored: false, generation: 0 }],
                activeId: id,
            };
        });
    }, [update, group]);

    /** Show the panel, with a terminal in it if it had none. */
    const show = useCallback(() => {
        update((previous) => {
            if (previous.terminals.length > 0) return { ...previous, open: true };
            const seq = previous.seq + 1;
            const id = `${group}:${seq}`;
            return { open: true, seq, terminals: [{ id, shellId: readDefaultShell(), cwd: '', restored: false, generation: 0 }], activeId: id };
        });
    }, [update, group]);

    /** Put the panel away. The shells go on running. */
    const hide = useCallback(() => update(previous => ({ ...previous, open: false })), [update]);

    const toggle = useCallback(() => {
        if (state.open) hide();
        else show();
    }, [state.open, hide, show]);

    const select = useCallback((id) => update(previous => ({ ...previous, activeId: id })), [update]);

    /**
     * Take a terminal away, and its shell with it. The neighbour comes to the
     * front; the last one closing puts the panel away.
     */
    const remove = useCallback((id) => {
        window.api.ssh.closeLocal?.(id);
        update((previous) => {
            const index = previous.terminals.findIndex(term => term.id === id);
            if (index === -1) return previous;
            const terminals = previous.terminals.filter(term => term.id !== id);
            const activeId = previous.activeId === id
                ? (terminals[Math.min(index, terminals.length - 1)]?.id || '')
                : previous.activeId;
            return { ...previous, terminals, activeId, open: previous.open && terminals.length > 0 };
        });
    }, [update]);

    /** A fresh shell in the same tab. */
    const restart = useCallback(async (id) => {
        await window.api.ssh.closeLocal?.(id);
        update(previous => ({
            ...previous,
            terminals: previous.terminals.map(term => (
                term.id === id ? { ...term, generation: term.generation + 1 } : term
            )),
        }));
    }, [update]);

    /**
     * What main actually started: the shell, when the tab asked for the
     * default, and the folder it is in. Kept, so a remount attaches to the
     * shell rather than asking where to start it again.
     */
    const settle = useCallback((id, { shell = '', cwd = '', home = false } = {}) => {
        update(previous => ({
            ...previous,
            terminals: previous.terminals.map((term) => {
                if (term.id !== id) return term;
                const next = { ...term, restored: true, home: Boolean(home) };
                if (shell) next.shellId = shell;
                if (cwd) next.cwd = cwd;
                return next;
            }),
        }));
    }, [update]);

    /** The folder picked for a terminal that asked where to start. */
    const chooseFolder = useCallback((id, cwd) => {
        update(previous => ({
            ...previous,
            terminals: previous.terminals.map(term => (term.id === id ? { ...term, cwd } : term)),
        }));
    }, [update]);

    return { ...state, key, group, add, show, hide, toggle, select, remove, restart, settle, chooseFolder };
}

import { useCallback, useEffect, useState } from 'react';

/**
 * The terminals beside one conversation: which there are, which is in front,
 * and whether the panel is showing.
 *
 * The shells themselves live in main (see local-terminal.js) and outlive this
 * state's component, which is remounted whenever the conversation moves in or
 * out of the split view. So the list is kept in session storage by tab id: a
 * remount reads it back and attaches to the same shells, a window reload
 * (whose shells main ends) reads it back too but finds them gone and starts
 * new ones, and a fresh start of the app starts with nothing open.
 */

const stateKey = (tabId) => `assistant.localTerminal.v2:${tabId}`;
const DEFAULT_SHELL_KEY = 'assistant.localTerminal.shell.v1';

/** The group a conversation's terminal ids share: `<group>:<n>`. */
export const localTerminalGroup = (tabId) => `local-${tabId}`;

const EMPTY = { open: false, terminals: [], activeId: '', seq: 0 };

function readState(tabId) {
    try {
        const stored = JSON.parse(sessionStorage.getItem(stateKey(tabId)) || 'null');
        if (!stored || !Array.isArray(stored.terminals)) return EMPTY;
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
    } catch {
        return EMPTY;
    }
}

function writeState(tabId, state) {
    try {
        sessionStorage.setItem(stateKey(tabId), JSON.stringify({
            open: state.open,
            terminals: state.terminals.map(term => ({ id: term.id, shellId: term.shellId, cwd: term.cwd, home: term.home })),
            activeId: state.activeId,
            seq: state.seq,
        }));
    } catch {
        // Storage blocked; the panel still works for this run.
    }
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

export default function useLocalTerminals(tabId) {
    const group = localTerminalGroup(tabId);
    const [state, setState] = useState(() => readState(tabId));

    useEffect(() => { writeState(tabId, state); }, [tabId, state]);

    /** A new terminal in front, on `shellId` or the default shell. */
    const add = useCallback((shellId = '') => {
        setState((previous) => {
            const seq = previous.seq + 1;
            const id = `${group}:${seq}`;
            return {
                open: true,
                seq,
                terminals: [...previous.terminals, { id, shellId: shellId || readDefaultShell(), cwd: '', restored: false, generation: 0 }],
                activeId: id,
            };
        });
    }, [group]);

    /** Show the panel, with a terminal in it if it had none. */
    const show = useCallback(() => {
        setState((previous) => {
            if (previous.terminals.length > 0) return { ...previous, open: true };
            const seq = previous.seq + 1;
            const id = `${group}:${seq}`;
            return { open: true, seq, terminals: [{ id, shellId: readDefaultShell(), cwd: '', restored: false, generation: 0 }], activeId: id };
        });
    }, [group]);

    /** Put the panel away. The shells go on running. */
    const hide = useCallback(() => setState(previous => ({ ...previous, open: false })), []);

    const toggle = useCallback(() => {
        if (state.open) hide();
        else show();
    }, [state.open, hide, show]);

    const select = useCallback((id) => setState(previous => ({ ...previous, activeId: id })), []);

    /**
     * Take a terminal away, and its shell with it. The neighbour comes to the
     * front; the last one closing puts the panel away.
     */
    const remove = useCallback((id) => {
        window.api.ssh.closeLocal?.(id);
        setState((previous) => {
            const index = previous.terminals.findIndex(term => term.id === id);
            if (index === -1) return previous;
            const terminals = previous.terminals.filter(term => term.id !== id);
            const activeId = previous.activeId === id
                ? (terminals[Math.min(index, terminals.length - 1)]?.id || '')
                : previous.activeId;
            return { ...previous, terminals, activeId, open: previous.open && terminals.length > 0 };
        });
    }, []);

    /** A fresh shell in the same tab. */
    const restart = useCallback(async (id) => {
        await window.api.ssh.closeLocal?.(id);
        setState(previous => ({
            ...previous,
            terminals: previous.terminals.map(term => (
                term.id === id ? { ...term, generation: term.generation + 1 } : term
            )),
        }));
    }, []);

    /**
     * What main actually started: the shell, when the tab asked for the
     * default, and the folder it is in. Kept, so a remount attaches to the
     * shell rather than asking where to start it again.
     */
    const settle = useCallback((id, { shell = '', cwd = '', home = false } = {}) => {
        setState(previous => ({
            ...previous,
            terminals: previous.terminals.map((term) => {
                if (term.id !== id) return term;
                const next = { ...term, restored: true, home: Boolean(home) };
                if (shell) next.shellId = shell;
                if (cwd) next.cwd = cwd;
                return next;
            }),
        }));
    }, []);

    /** The folder picked for a terminal that asked where to start. */
    const chooseFolder = useCallback((id, cwd) => {
        setState(previous => ({
            ...previous,
            terminals: previous.terminals.map(term => (term.id === id ? { ...term, cwd } : term)),
        }));
    }, []);

    return { ...state, group, add, show, hide, toggle, select, remove, restart, settle, chooseFolder };
}

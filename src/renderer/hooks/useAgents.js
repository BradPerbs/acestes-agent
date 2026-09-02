import { useCallback, useEffect, useState } from 'react';

/**
 * The agents, and which one is selected.
 *
 * The registry lives in the main process; this is a mirror of it that follows
 * every change, whichever window made it. Every mutation answers with the
 * whole snapshot, so the mirror never has to guess what a change did.
 */
export function useAgents() {
    const [state, setState] = useState({ agents: [], activeId: '' });

    useEffect(() => {
        window.api.agents.list().then(setState).catch(() => {});
        return window.api.agents.onChange(setState);
    }, []);

    const select = useCallback(async (id) => {
        setState(await window.api.agents.select(id));
    }, []);

    /** Create (no id) or rename; resolves to the saved agent's id. */
    const save = useCallback(async (agent) => {
        const result = await window.api.agents.save(agent);
        setState({ agents: result.agents, activeId: result.activeId });
        return result;
    }, []);

    const remove = useCallback(async (id) => {
        const result = await window.api.agents.remove(id);
        setState({ agents: result.agents, activeId: result.activeId });
        return result;
    }, []);

    const active = state.agents.find(agent => agent.id === state.activeId) || state.agents[0] || null;

    return { agents: state.agents, activeId: state.activeId, active, select, save, remove };
}

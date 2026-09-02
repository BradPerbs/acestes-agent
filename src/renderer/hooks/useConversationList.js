import { useCallback, useEffect, useState } from 'react';

/**
 * The conversations one agent has, newest first, kept current.
 *
 * Read when the agent changes, and again as the conversations move: every
 * message is an event, and a title or a timestamp moves with it. Coalesced,
 * since one turn is a couple of dozen events.
 */
export function useConversationList(agentId) {
    const [conversations, setConversations] = useState([]);

    const refresh = useCallback(async () => {
        if (!agentId) return;
        try {
            setConversations(await window.api.ai.list({ agentId }) || []);
        } catch {
            // The list just shows what it had.
        }
    }, [agentId]);

    useEffect(() => {
        refresh();
        let timer = null;
        const off = window.api.ai.onEvent(() => {
            clearTimeout(timer);
            timer = setTimeout(refresh, 400);
        });
        return () => {
            clearTimeout(timer);
            off?.();
        };
    }, [refresh]);

    return { conversations, refresh };
}

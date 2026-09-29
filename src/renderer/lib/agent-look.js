import { AGENT_COLORS } from './agent-colors';

/**
 * What an agent's mark looks like: its colour, and whether the helmet wears
 * its crest.
 *
 * The ids are what the agent record stores, and `src/main/agents.js` keeps
 * the same list so an unknown one is refused on the way in. The helmet
 * itself is in `components/assistant/helmet`.
 */
export const AGENT_CRESTS = ['plume', 'none'];

export const DEFAULT_LOOK = { color: AGENT_COLORS[0].id, crest: 'plume' };

/**
 * A look, whatever it was handed: an agent, a look, a bare colour id (what
 * the mark was given before it had a crest) or nothing. Anything it does not
 * know falls back to the default, part by part.
 */
export function agentLook(value) {
    const source = typeof value === 'string' ? { color: value } : (value || {});
    return {
        color: AGENT_COLORS.some(color => color.id === source.color) ? source.color : DEFAULT_LOOK.color,
        crest: AGENT_CRESTS.includes(source.crest) ? source.crest : DEFAULT_LOOK.crest,
    };
}

/**
 * A look for a new agent: the first colour and crest no agent in the list is
 * wearing, every colour with the crest before any without it, so the first
 * ten agents all wear the helmet as people know it.
 */
export function nextAgentLook(agents) {
    const worn = new Set((agents || []).map((agent) => {
        const look = agentLook(agent);
        return `${look.color}/${look.crest}`;
    }));
    for (const crest of AGENT_CRESTS) {
        const free = AGENT_COLORS.find(color => !worn.has(`${color.id}/${crest}`));
        if (free) return { color: free.id, crest };
    }
    const turn = (agents?.length || 0) % (AGENT_COLORS.length * AGENT_CRESTS.length);
    return {
        color: AGENT_COLORS[turn % AGENT_COLORS.length].id,
        crest: AGENT_CRESTS[Math.floor(turn / AGENT_COLORS.length)],
    };
}

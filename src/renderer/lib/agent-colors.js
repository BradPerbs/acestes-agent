/**
 * The colours an agent can wear.
 *
 * Each is a pair, the top and the bottom of the gradient the mark is filled
 * with. The ids are what the agent record stores, and `src/main/agents.js`
 * keeps the same list of ids so a colour it has never heard of is refused on
 * the way in rather than drawn as nothing.
 */
export const AGENT_COLORS = [
    { id: 'sky', label: 'Sky', from: '#307AF0', to: '#0FCBE3' },
    { id: 'violet', label: 'Violet', from: '#7C3AED', to: '#C084FC' },
    { id: 'emerald', label: 'Emerald', from: '#059669', to: '#34D399' },
    { id: 'amber', label: 'Amber', from: '#D97706', to: '#FBBF24' },
    { id: 'rose', label: 'Rose', from: '#E11D48', to: '#FB7185' },
    { id: 'orange', label: 'Orange', from: '#EA580C', to: '#FB923C' },
    { id: 'teal', label: 'Teal', from: '#0D9488', to: '#5EEAD4' },
    { id: 'slate', label: 'Slate', from: '#475569', to: '#94A3B8' },
];

const BY_ID = Object.fromEntries(AGENT_COLORS.map(color => [color.id, color]));

/** The colour an id means, falling back to the first one for anything else. */
export const agentColor = (id) => BY_ID[id] || AGENT_COLORS[0];

/** The first colour no agent in the list is wearing, or the next in turn. */
export function nextAgentColor(agents) {
    const worn = new Set((agents || []).map(agent => agent.color));
    const free = AGENT_COLORS.find(color => !worn.has(color.id));
    return (free || AGENT_COLORS[(agents?.length || 0) % AGENT_COLORS.length]).id;
}

/**
 * A colour moved towards white (positive) or black (negative) by a share of
 * the way there, for the light and the shadow on the mark.
 */
export function shade(hex, amount) {
    const value = String(hex || '').replace('#', '');
    if (value.length !== 6) return hex;
    const target = amount > 0 ? 255 : 0;
    const share = Math.min(1, Math.abs(amount));
    const channel = (at) => {
        const from = parseInt(value.slice(at, at + 2), 16);
        return Math.round(from + (target - from) * share).toString(16).padStart(2, '0');
    };
    return '#' + channel(0) + channel(2) + channel(4);
}

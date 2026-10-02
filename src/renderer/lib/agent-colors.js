/**
 * The colours an agent can wear.
 *
 * The mark is drawn in ink, so each colour is really an ink: the colour of
 * the lines and of the dark in the face, and what, if anything, the helmet is
 * filled with. Most are a pair, the colour itself and a lighter one of the
 * same family (see `agentInk`), and leave the helmet unfilled so it sits on
 * whatever is behind it. White and black carry theirs spelled out, and fill
 * the helmet with the opposite, so a black helmet is black ink on white
 * paper whatever the theme, and a white one the reverse. The ids are what the
 * agent record stores, and `src/main/agents.js` keeps the same list of ids so
 * a colour it has never heard of is refused on the way in rather than drawn
 * as nothing.
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
    {
        id: 'white',
        label: 'White',
        ink: { line: '#F4F4F5', lineDark: '#F4F4F5', paper: '#18181B' },
    },
    {
        id: 'black',
        label: 'Black',
        ink: { line: '#18181B', lineDark: '#18181B', paper: '#FFFFFF' },
    },
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

/** Two colours mixed, `amount` of the way from the first to the second. */
export function mix(from, to, amount) {
    const read = (hex) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
    const a = read(from);
    const b = read(to);
    return '#' + a.map((channel, index) => (
        Math.round(channel + (b[index] - channel) * amount).toString(16).padStart(2, '0')
    )).join('');
}

/**
 * The light an agent casts on the window behind the sidebar: its colour, and
 * the lighter one of its family for the fainter glow lower down. Null for
 * white and black, which have no hue to cast, so the ground keeps its own
 * neutral wash.
 */
export function agentGlow(id) {
    const color = agentColor(id);
    return color.ink ? null : { from: color.from, to: color.to };
}

/**
 * The ink one colour is drawn in: `line`, and `lineDark` for a dark theme,
 * where the colour itself would sink into the background and is lifted
 * towards white instead; and `paper`, what the helmet is filled with, or
 * null for nothing.
 */
export function agentInk(id) {
    const color = agentColor(id);
    if (color.ink) return color.ink;
    return {
        line: color.from,
        lineDark: mix(color.from, '#FFFFFF', 0.3),
        paper: null,
    };
}

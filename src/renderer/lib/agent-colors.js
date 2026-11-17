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
 *
 * Besides these, an agent can wear a colour of its own, stored as `#RRGGBB`.
 * Its lighter one is worked out from it, and its ink is pushed only as far
 * towards black or white as it takes to be seen in each theme, since a colour
 * picked by hand can be one that would vanish into either.
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

/**
 * How the helmet is drawn: `outline`, lines only over whatever is behind it,
 * or `solid`, filled with the colour and drawn in a shade of it. White and
 * black are filled already, and draw the same either way.
 */
export const AGENT_FINISHES = ['outline', 'solid'];

const BY_ID = Object.fromEntries(AGENT_COLORS.map(color => [color.id, color]));

/** What the ink has to stand out against: the light page, and the dark one's base. */
const LIGHT_GROUND = '#FFFFFF';
const DARK_GROUND = '#16161E';
/** How much a line has to stand out from the ground to be seen, as a contrast ratio. */
const SEEN = 3;

/** Whether `value` is a colour of the person's own, `#RRGGBB`. */
export const isCustomColor = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** A colour of one's own as it is stored: in capitals, or null if it is not one. */
export const customColor = (value) => (isCustomColor(value) ? value.toUpperCase() : null);

/** Two colours mixed, `amount` of the way from the first to the second. */
export function mix(from, to, amount) {
    const read = (hex) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
    const a = read(from);
    const b = read(to);
    return '#' + a.map((channel, index) => (
        Math.round(channel + (b[index] - channel) * amount).toString(16).padStart(2, '0')
    )).join('').toUpperCase();
}

/** How bright a colour looks, from 0 for black to 1 for white (WCAG relative luminance). */
export function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((index) => {
        const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** How far apart two colours stand, as a contrast ratio from 1 to 21. */
export function contrast(a, b) {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
}

/**
 * `hex` moved towards `towards` only as far as it takes to stand out from
 * `ground`, in twentieths, so a colour that is seen already is left as it is.
 */
function readable(hex, ground, towards) {
    for (let step = 0; step <= 20; step += 1) {
        const tried = mix(hex, towards, step / 20);
        if (contrast(tried, ground) >= SEEN) return tried;
    }
    return towards.toUpperCase();
}

/** The colour an id means, or a colour of one's own, falling back to the first one for anything else. */
export function agentColor(id) {
    if (BY_ID[id]) return BY_ID[id];
    const hex = customColor(id);
    if (!hex) return AGENT_COLORS[0];
    return {
        id: hex,
        label: hex,
        from: hex,
        // The lighter one of its family, and one that shows on the black of
        // the buddy's notch, where the light end of a colour is its dot.
        to: readable(mix(hex, '#FFFFFF', 0.4), DARK_GROUND, '#FFFFFF'),
        custom: true,
    };
}

/** The first colour no agent in the list is wearing, or the next in turn. */
export function nextAgentColor(agents) {
    const worn = new Set((agents || []).map(agent => agent.color));
    const free = AGENT_COLORS.find(color => !worn.has(color.id));
    return (free || AGENT_COLORS[(agents?.length || 0) % AGENT_COLORS.length]).id;
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

/** Whether a colour has a hue of its own, and so a choice of finish. White and black do not. */
export const hasHue = (id) => !agentColor(id).ink;

/**
 * The colour of the specks behind a large mark (`AgentAura`), per theme: the
 * colour as an outline is drawn in, whatever the finish, since a filled
 * helmet's deep shade would be specks of near-black. White and black, whose
 * own ink would vanish into one theme, are a grey that shows in both.
 */
export function agentAuraInk(id) {
    const color = agentColor(id);
    if (color.id === 'white') return { line: '#71717A', lineDark: '#E4E4E7' };
    if (color.id === 'black') return { line: '#27272A', lineDark: '#A1A1AA' };
    const ink = agentInk(id);
    return { line: ink.line, lineDark: ink.lineDark };
}

/**
 * The ink one colour is drawn in: `line`, and `lineDark` for a dark theme,
 * where the colour itself would sink into the background and is lifted
 * towards white instead; and `paper`, what the helmet is filled with, or
 * null for nothing.
 *
 * `solid` fills the helmet with the colour itself and draws it in a deep
 * shade of the same, or a pale one where the colour is too dark for a shade
 * to show; the same in both themes, as white and black are. Deep by rule
 * rather than whichever stands further off, so the set reads as one family
 * and not half dark and half washed out. The lines of an outline are what
 * the accents across the app are drawn from, so those ask for the outline.
 */
export function agentInk(id, finish = 'outline') {
    const color = agentColor(id);
    if (color.ink) return color.ink;
    if (finish === 'solid') {
        const deep = mix(color.from, '#000000', 0.65);
        const line = contrast(deep, color.from) >= 2 ? deep : mix(color.from, '#FFFFFF', 0.78);
        return { line, lineDark: line, paper: color.from };
    }
    return {
        line: readable(color.from, LIGHT_GROUND, '#000000'),
        lineDark: readable(mix(color.from, '#FFFFFF', 0.3), DARK_GROUND, '#FFFFFF'),
        paper: null,
    };
}

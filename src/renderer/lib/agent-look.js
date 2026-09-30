import { AGENT_COLORS } from './agent-colors';

/**
 * What an agent's mark looks like: its colour, which helmet, and what the
 * helmet wears on top.
 *
 * The ids are what the agent record stores, and `src/main/agents.js` keeps
 * the same lists so an unknown one is refused on the way in. The helmets
 * themselves are in `components/assistant/helmet`, and `scripts/helmets`
 * says where each model comes from and how each crest is fitted.
 *
 * The crests: `plume`, horsehair from front to back (the Corinthian's own,
 * and the Trojan's; the others wear the Corinthian's); `transverse`, the same
 * across the head from ear to ear; `horns`; `crown`; `feathers`; or `none`.
 *
 * Every helmet lists the crests it can wear, the one it wears unless told
 * otherwise first. The kabuto wears none of them: its own horns stand where
 * they would.
 */
export const AGENT_CRESTS = ['plume', 'transverse', 'horns', 'crown', 'feathers', 'none'];

const OTHERS = ['transverse', 'horns', 'crown', 'feathers'];
export const AGENT_HELMETS = [
    { id: 'corinthian', crests: ['plume', 'none', ...OTHERS] },
    { id: 'trojan', crests: ['plume', 'none', ...OTHERS] },
    { id: 'attic', crests: ['none', 'plume', ...OTHERS] },
    { id: 'galea', crests: ['none', 'plume', ...OTHERS] },
    { id: 'viking', crests: ['none', 'plume', ...OTHERS] },
    { id: 'greathelm', crests: ['none', 'plume', ...OTHERS] },
    { id: 'barbute', crests: ['none', 'plume', ...OTHERS] },
    { id: 'morion', crests: ['none', 'plume', ...OTHERS] },
    { id: 'kabuto', crests: ['none'] },
];

export const DEFAULT_LOOK = { color: AGENT_COLORS[0].id, helmet: 'corinthian', crest: 'plume' };

/** The crests `helmet` can wear, its usual one first. */
export function helmetCrests(helmet) {
    return (AGENT_HELMETS.find(entry => entry.id === helmet) || AGENT_HELMETS[0]).crests;
}

/**
 * A look, whatever it was handed: an agent, a look, a bare colour id (what
 * the mark was given before it had a crest) or nothing. Anything it does not
 * know falls back to the default, part by part: an agent from before there
 * was a choice of helmet wears the Corinthian, and a crest the helmet cannot
 * wear gives way to the one it can.
 */
export function agentLook(value) {
    const source = typeof value === 'string' ? { color: value } : (value || {});
    const helmet = AGENT_HELMETS.some(entry => entry.id === source.helmet) ? source.helmet : DEFAULT_LOOK.helmet;
    const crests = helmetCrests(helmet);
    return {
        color: AGENT_COLORS.some(color => color.id === source.color) ? source.color : DEFAULT_LOOK.color,
        helmet,
        crest: crests.includes(source.crest) ? source.crest : crests[0],
    };
}

/**
 * Every helmet and crest there is, in the order new agents are given them:
 * the Corinthian as people know it, then without its crest, then every other
 * helmet as it usually is, then the rest.
 */
const WEARS = (() => {
    const all = AGENT_HELMETS.flatMap(({ id, crests }) => crests.map(crest => ({ helmet: id, crest })));
    const first = [all[0], all[1], ...AGENT_HELMETS.slice(1).map(({ id, crests }) => ({ helmet: id, crest: crests[0] }))];
    return [...first, ...all.filter(wear => !first.some(f => f.helmet === wear.helmet && f.crest === wear.crest))];
})();

/**
 * A look for a new agent: the first colour, helmet and crest no agent in the
 * list is wearing, every colour of one before the next, so the first ten
 * agents all wear the helmet as people know it, the next ten the same helmet
 * without its crest, and so on down the list.
 */
export function nextAgentLook(agents) {
    const worn = new Set((agents || []).map((agent) => {
        const look = agentLook(agent);
        return `${look.color}/${look.helmet}/${look.crest}`;
    }));
    for (const wear of WEARS) {
        const free = AGENT_COLORS.find(color => !worn.has(`${color.id}/${wear.helmet}/${wear.crest}`));
        if (free) return { color: free.id, ...wear };
    }
    const turn = (agents?.length || 0) % (AGENT_COLORS.length * WEARS.length);
    return { color: AGENT_COLORS[turn % AGENT_COLORS.length].id, ...WEARS[Math.floor(turn / AGENT_COLORS.length)] };
}

/**
 * Finding a model from the way a person names it.
 *
 * "grok 4.6 xhigh", "opus on claude", "gpt-5 codex high": a runtime, a
 * model and an effort, in any order, spelled the way the menu shows them or
 * the way the id reads. The catalogs come from the runtimes the agent has
 * switched on, one list of rows each (`{ value, label, effort: [...] }`, the
 * shape every provider's `listModels` answers with). Pure, so it can be
 * tested with made-up catalogs.
 */

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Words that name a runtime, so "on grok" narrows the search to it. */
const PROVIDER_ALIASES = {
    'claude-code': ['claude', 'claudecode', 'anthropic'],
    codex: ['codex', 'openai'],
    opencode: ['opencode'],
    grok: ['grok', 'xai'],
    kimi: ['kimi', 'moonshot'],
    local: ['local', 'ollama', 'lmstudio', 'llamacpp', 'vllm'],
    openai: ['openrouter', 'api', 'router'],
};

/** Filler a person adds that names nothing. */
const NOISE = new Set(['on', 'with', 'using', 'use', 'via', 'the', 'model', 'effort', 'at', 'in', 'mode', 'reasoning', 'and']);

const fold = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9.]+/g, '');

function tokens(text) {
    return String(text || '')
        .toLowerCase()
        .split(/[\s,/]+/)
        .map(token => token.replace(/^[^a-z0-9]+|[^a-z0-9.]+$/g, ''))
        .filter(token => token && !NOISE.has(token));
}

/**
 * Read a model query.
 *
 * Answers `{ provider, model, label, effort, candidates }` on a match, or
 * `{ error, candidates }` when nothing fits or several fit equally. The
 * effort is only kept when the matched model offers it; otherwise it is
 * reported back so the caller can say so rather than silently drop it.
 */
function matchModel(catalogs, query, { providerOrder = [] } = {}) {
    const words = tokens(query);
    if (words.length === 0) return { error: 'Say which model.', candidates: [] };

    let effort = '';
    const rest = [];
    let wantedProvider = '';
    for (const word of words) {
        if (EFFORTS.includes(word) && !effort) {
            effort = word;
            continue;
        }
        const provider = Object.entries(PROVIDER_ALIASES).find(([, aliases]) => aliases.includes(fold(word)))?.[0];
        if (provider && catalogs.some(catalog => catalog.provider === provider)) {
            wantedProvider = provider;
            continue;
        }
        rest.push(word);
    }

    const pool = catalogs.filter(catalog => !wantedProvider || catalog.provider === wantedProvider);
    const scored = [];
    for (const catalog of pool) {
        for (const row of catalog.rows || []) {
            const haystacks = [fold(row.label), fold(row.value), fold(row.resolved), fold(row.short)].filter(Boolean);
            let score = 0;
            let missed = false;
            for (const word of rest) {
                const needle = fold(word);
                if (!needle) continue;
                if (haystacks.some(hay => hay === needle)) score += 5;
                else if (haystacks.some(hay => hay.includes(needle))) score += 2;
                else {
                    missed = true;
                    break;
                }
            }
            if (missed) continue;
            // Nothing but a provider or an effort was said: the runtime's
            // preferred model is the one meant.
            if (rest.length === 0) score = row.preferred ? 2 : 1;
            if (score === 0) continue;
            // Tighter names win: "grok 4" should not prefer "grok 4.6 fast"
            // over "grok 4" when both contain the words.
            const slack = Math.max(0, fold(row.label).length - rest.join('').length) / 100;
            scored.push({ catalog, row, score: score - slack });
        }
    }

    if (scored.length === 0) {
        return {
            error: rest.length
                ? `No model matching "${rest.join(' ')}"${wantedProvider ? ` on ${wantedProvider}` : ''} in the runtimes this agent has on.`
                : 'No model list is available for that runtime.',
            candidates: [],
            effort,
        };
    }

    const order = (provider) => {
        const index = providerOrder.indexOf(provider);
        return index === -1 ? providerOrder.length : index;
    };
    scored.sort((a, b) => (b.score - a.score) || (order(a.catalog.provider) - order(b.catalog.provider)));
    const best = scored[0];
    const candidates = scored.slice(0, 6).map(entry => ({ provider: entry.catalog.provider, model: entry.row.value, label: entry.row.label }));

    // Equal scores across runtimes is a real ambiguity: "opus" may be on
    // Claude Code and on OpenCode. Say so rather than pick.
    const tied = scored.filter(entry => Math.abs(entry.score - best.score) < 1e-9 && entry.catalog.provider !== best.catalog.provider);
    if (tied.length > 0 && !wantedProvider && rest.length > 0) {
        return {
            error: `"${rest.join(' ')}" matches a model on more than one runtime: ${[best, ...tied].map(entry => `${entry.row.label} on ${entry.catalog.provider}`).join(', ')}. Name the runtime.`,
            candidates,
            effort,
        };
    }

    const offered = Array.isArray(best.row.effort) ? best.row.effort : [];
    const kept = effort && (offered.length === 0 || offered.includes(effort)) ? effort : '';
    return {
        provider: best.catalog.provider,
        model: best.row.value,
        label: best.row.label,
        effort: kept,
        effortOffered: offered,
        effortDropped: effort && !kept ? effort : '',
        candidates,
    };
}

module.exports = { matchModel, tokens, EFFORTS, PROVIDER_ALIASES };

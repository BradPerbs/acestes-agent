const engine = require('./openai-compatible');

/**
 * Any OpenAI-compatible API, with a key.
 *
 * The local provider's twin for the other side of the network: OpenRouter,
 * a hosted vLLM, an enterprise gateway, OpenAI itself, anything that speaks
 * `/chat/completions` and `/models` behind a bearer token. Same loop in
 * `openai-compatible.js`, same tools, same approval gate; what differs is
 * that the address is remote and the key is required rather than optional.
 *
 * The key is the one credential this app stores for a runtime. The others
 * run agents already signed in on the machine; this one has nothing on the
 * machine to be signed in to, so the key is kept the way the vault keeps a
 * host's password, encrypted by the OS and never sent to a window.
 *
 * OpenRouter is the placeholder because it is the one address that reaches
 * every model, and its two courtesy headers are sent to everyone: a server
 * that does not know them ignores them.
 */

const LABEL = 'The API';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

const HEADERS = {
    'HTTP-Referer': 'https://github.com/BradPerbs/acestes-agent',
    'X-Title': 'Acestes Agent',
};

function baseUrl(current) {
    return current?.apiBaseUrl || DEFAULT_BASE_URL;
}

function endpoint(current) {
    return {
        baseUrl: baseUrl(current),
        apiKey: current.apiKey || '',
        headers: HEADERS,
        label: LABEL,
    };
}

/**
 * Which model to ask for when none is pinned.
 *
 * A hosted API lists hundreds and has no notion of a "loaded" one, so the
 * first row is no better than the last. The list is still the only source
 * there is, so it is used, and the settings page and the model menu are
 * where a real choice is made.
 */
let known = { url: '', model: '' };

async function resolveModel(current) {
    if (current.model) return current.model;

    const url = baseUrl(current);
    if (known.url === url && known.model) return known.model;

    const rows = await engine.listModels({ baseUrl: url, apiKey: current.apiKey || '', headers: HEADERS, label: LABEL });
    if (!rows?.length) throw new Error(`${LABEL} listed no models. Pick one in the assistant settings.`);

    known = { url, model: rows[0].value };
    return known.model;
}

async function start(options) {
    if (!options?.settings?.apiKey) {
        throw new Error('No API key is stored for the OpenAI-compatible API. Add one in the assistant settings.');
    }
    return engine.start({
        ...options,
        label: LABEL,
        prefix: 'api',
        endpoint,
        model: resolveModel,
    });
}

/**
 * What the API offers. Hundreds on OpenRouter, so nothing is marked
 * preferred: an unpinned conversation goes to the first row, which the
 * note under the menu says, and the settings page is where to pin one.
 */
async function listModels({ settings: current = {} } = {}) {
    if (!current.apiKey) return null;
    const rows = await engine.listModels({ baseUrl: baseUrl(current), apiKey: current.apiKey, headers: HEADERS, label: LABEL });
    if (!rows?.length) return null;
    return rows.map((row, index) => ({ ...row, preferred: index === 0 }));
}

/** Whether the address answers with the key. No key is its own answer. */
async function detect({ settings: current = {} } = {}) {
    if (!current.apiKey) return { ok: false, reason: 'noKey' };
    try {
        const rows = await listModels({ settings: current });
        return { ok: Boolean(rows?.length), reason: 'noServer' };
    } catch (error) {
        return { ok: false, reason: /401|403|credentials/i.test(error.message) ? 'badKey' : 'noServer' };
    }
}

module.exports = {
    start,
    listModels,
    detect,
    endpoint,
    resolveModel,
    LABEL,
    DEFAULT_BASE_URL,
    _test: { forget: () => { known = { url: '', model: '' }; } },
};

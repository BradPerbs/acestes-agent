/**
 * OpenRouter text to speech, for the buddy's spoken recap (buddy.js): one
 * key for the speech models of many providers (ElevenLabs, Google's Gemini,
 * Deepgram, Grok, Kokoro, Microsoft, Mistral and more), through its
 * OpenAI-shaped `/audio/speech`.
 *
 * The key is the user's, kept in the keychain as the secret `openrouter`
 * (secrets.js): read here, in this process, at the moment of use, and sent
 * to OpenRouter and nowhere else. The audio is asked for as raw 16-bit PCM
 * and handed on chunk by chunk as it arrives, as elevenlabs.js does, so the
 * renderer's player (lib/pcm-player.js) plays either.
 *
 * The rate is not the same for every model: most send 24 kHz, Fish Audio and
 * HeyGen 44.1 kHz (measured 2026-11-11). Each answer says which in its
 * Content-Type (`audio/pcm;rate=24000;channels=1`), so it is read from
 * there and handed on with the audio.
 */

const API = 'https://openrouter.ai/api/v1';

/** What OpenRouter is told the requests come from, as the chat provider says it (providers/openai.js). */
const HEADERS = {
    'HTTP-Referer': 'https://github.com/BradPerbs/acestes-agent',
    'X-Title': 'Acestes Agent',
};

/** The model used when none has been picked: quick to start, natural, and cheap. */
const DEFAULT_MODEL = 'elevenlabs/eleven-flash-v2.5';

/** The rate when an answer does not say: what nearly every model sends. */
const RATE = 24000;

/** The name the key is kept under in the keychain. */
const SECRET = 'openrouter';

/** A recap is a sentence; anything longer is cut, so no reply runs up the bill. */
const MAX_CHARS = 400;

/** A model's id as OpenRouter writes them: `provider/name`, with a variant after a colon. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/;

/** A voice's id: `george`, `aura-2-thalia-en`, `en-US-Harper:MAI-Voice-2.1-Flash`. */
const VOICE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/;

/** How long the list of speech models is kept before it is asked for again. */
const LIST_MS = 10 * 60 * 1000;

let fetchImpl = (...args) => globalThis.fetch(...args);

/**
 * What OpenRouter said was wrong, as a person would want it put. Its errors
 * are `{ error: { code, message } }`; a voice it does not know comes back as
 * a 400 that lists every voice the model has, which is cut short here.
 */
async function refusal(response) {
    let message = '';
    try {
        const body = await response.json();
        message = String(body?.error?.message || body?.message || '');
    } catch {
        message = '';
    }
    if (response.status === 401) return 'OpenRouter refused the key. Check it in Settings, under Voice.';
    if (response.status === 402) return 'Your OpenRouter credits are used up. Add more at openrouter.ai/credits.';
    if (response.status === 403) return `OpenRouter would not do it${message ? `: ${message.slice(0, 160)}` : ' (a spend limit, or the key is switched off).'}`;
    if (response.status === 429) return 'OpenRouter is busy (too many requests). Try again in a moment.';
    if (/unknown voice/i.test(message)) return 'That model does not have the voice picked. Pick another in Settings, under Voice.';
    if (/only supports response_format="?mp3/i.test(message)) return 'That model only sends MP3, which cannot be played as it arrives. Pick another in Settings, under Voice.';
    if (/does not exist/i.test(message) || response.status === 404) return 'That OpenRouter model is gone. Pick another in Settings, under Voice.';
    return `OpenRouter answered ${response.status}${message ? `: ${message.replace(/\s+/g, ' ').slice(0, 200)}` : ''}.`;
}

/** The sample rate an answer's Content-Type gives, or the usual one. */
function rateOf(response) {
    const type = String(response.headers?.get?.('content-type') || '');
    const rate = Number(/rate=(\d+)/i.exec(type)?.[1]);
    return Number.isFinite(rate) && rate >= 8000 && rate <= 96000 ? rate : RATE;
}

// The speech models, as last listed: one list for every key, since it is
// OpenRouter's catalogue and not the account's.
let listed = { at: 0, models: null };

/**
 * Speak `text`: the audio streamed to `onAudio(Uint8Array, rate)` as it
 * comes. Resolves with its rate when it has all come, rejects with a plain
 * message when it cannot; `signal` stops it (someone started talking over it).
 * `instructions` is how to say it, which the models that take direction
 * (Gemini, OpenAI's, Fish Audio) follow and the rest ignore.
 */
async function stream({ key, text, model = DEFAULT_MODEL, voice = '', instructions = '', signal, onAudio }) {
    if (!key) throw new Error('There is no OpenRouter key. Add it in Settings, under Voice.');
    const words = String(text || '').trim().slice(0, MAX_CHARS);
    if (!words) return { rate: RATE, bytes: 0 };
    const chosen = MODEL_ID.test(String(model || '')) ? model : DEFAULT_MODEL;
    const spoken = await voiceFor(chosen, voice);
    const direction = String(instructions || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const response = await fetchImpl(`${API}/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({
            model: chosen,
            input: words,
            ...(spoken ? { voice: spoken } : {}),
            ...(direction ? { instructions: direction } : {}),
            response_format: 'pcm',
        }),
        signal,
    });
    if (!response.ok) throw new Error(await refusal(response));
    const rate = rateOf(response);
    let bytes = 0;
    const reader = response.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) {
            bytes += value.length;
            onAudio?.(value, rate);
        }
    }
    return { rate, bytes };
}

/**
 * The voice to ask for: the one picked, when it looks like a voice; else
 * the model's first, from the list. A model that lists none (Fish Audio)
 * has a voice of its own and is asked without one.
 */
async function voiceFor(model, voice) {
    if (VOICE.test(String(voice || ''))) return voice;
    const found = await models();
    const row = found.models?.find(entry => entry.id === model);
    return row?.voices?.[0] || '';
}

/**
 * The speech models OpenRouter offers, each with its voices and its price
 * per million characters of text, for picking one in Settings. Listing them
 * needs no key.
 */
async function models() {
    if (listed.models && Date.now() - listed.at < LIST_MS) return { models: listed.models };
    try {
        const response = await fetchImpl(`${API}/models?output_modalities=speech`, { headers: HEADERS });
        if (!response.ok) return { error: await refusal(response) };
        const body = await response.json();
        const rows = (body?.data || [])
            .filter(row => MODEL_ID.test(String(row?.id || '')))
            .map(row => ({
                id: row.id,
                name: String(row.name || row.id).slice(0, 120),
                voices: (Array.isArray(row.supported_voices) ? row.supported_voices : [])
                    .map(String)
                    .filter(voice => VOICE.test(voice))
                    .slice(0, 300),
                price: priceOf(row.pricing),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        listed = { at: Date.now(), models: rows };
        return { models: rows };
    } catch (error) {
        return { error: `Could not reach OpenRouter: ${error.message}` };
    }
}

/**
 * Dollars per million characters of text, when the model is priced by its
 * input (most are); null when it is priced otherwise (by the second of
 * audio, by output tokens on top) or not at all. Free is 0.
 */
function priceOf(pricing) {
    const input = Number(pricing?.prompt);
    const output = Number(pricing?.completion);
    if (!Number.isFinite(input) || !Number.isFinite(output) || output > 0) return null;
    return Math.round(input * 1e6 * 100) / 100;
}

module.exports = {
    DEFAULT_MODEL,
    RATE,
    SECRET,
    MODEL_ID,
    VOICE,
    stream,
    models,
    _test: {
        useFetch: (fn) => {
            fetchImpl = fn;
            listed = { at: 0, models: null };
        },
        rateOf,
        priceOf,
    },
};

/**
 * ElevenLabs text to speech, for the buddy's spoken recap (buddy.js).
 *
 * The key is the user's, kept in the keychain as the secret `elevenlabs`
 * (secrets.js): read here, in this process, at the moment of use, and sent
 * to ElevenLabs and nowhere else. The audio is asked for as raw 16-bit PCM
 * and handed on chunk by chunk as it arrives, so the buddy starts talking
 * while the rest of the sentence is still being made rather than after the
 * whole of it has downloaded. The renderer plays it through Web Audio (the
 * app's content security policy keeps <audio> off blob URLs).
 */

const API = 'https://api.elevenlabs.io';

/**
 * The models offered, by ElevenLabs' id: Eleven v4 by default, and Flash
 * v2.5 for the quickest start. (v4 Turbo is documented only on the Text to
 * Dialogue websocket, not on this endpoint, so it is not offered here.)
 */
const MODELS = ['eleven_v4', 'eleven_flash_v2_5'];
const DEFAULT_MODEL = 'eleven_v4';

/** Raw signed 16-bit little-endian mono at this rate: playable as it comes, on every plan. */
const RATE = 24000;
const FORMAT = `pcm_${RATE}`;

/** The name the key is kept under in the keychain. */
const SECRET = 'elevenlabs';

/** A recap is a sentence; anything longer is cut, so no reply runs up the bill. */
const MAX_CHARS = 400;

const VOICE_ID = /^[A-Za-z0-9]{8,40}$/;

let fetchImpl = (...args) => globalThis.fetch(...args);

/**
 * What ElevenLabs said was wrong, as a person would want it put. Its errors
 * carry `detail.code` now and `detail.status` in older answers; a request it
 * could not read (422) has a list there instead.
 */
async function refusal(response) {
    let detail = null;
    try {
        detail = (await response.json())?.detail;
    } catch {
        detail = null;
    }
    const first = Array.isArray(detail) ? detail[0] : detail;
    const code = first && typeof first === 'object' ? String(first.code || first.status || '') : '';
    const message = typeof detail === 'string' ? detail : String(first?.message || first?.msg || '');
    if (response.status === 401 || code === 'invalid_api_key' || code === 'missing_api_key') return 'ElevenLabs refused the key. Check it in Settings.';
    // A free account may not use the Voice Library's voices through the API (a 402 too, but not about credits).
    if (code === 'paid_plan_required') return 'Free ElevenLabs accounts cannot use Voice Library voices here. Pick a premade voice or one of your own in Settings.';
    if (code === 'insufficient_credits' || code === 'quota_exceeded') return 'Your ElevenLabs credits are used up.';
    if (response.status === 402) return `ElevenLabs wants a paid plan for that${message ? `: ${message.slice(0, 200)}` : '.'}`;
    if (code === 'voice_not_found' || response.status === 404) return 'That ElevenLabs voice is gone. Pick another in Settings.';
    if (code === 'model_access_denied' || code === 'feature_not_available') return 'Your ElevenLabs plan does not include that model. Pick another in Settings.';
    if (response.status === 429) return 'ElevenLabs is busy (too many requests). Try again in a moment.';
    return `ElevenLabs answered ${response.status}${message ? `: ${message.slice(0, 200)}` : ''}.`;
}

// The voice used when none has been picked: there is no voice every account
// has (ElevenLabs' defaults are only on older accounts, and go at the end of
// 2026), so it is the best on the account's own list, found once per key.
let fallback = { key: '', id: '' };

/**
 * Voices any plan can speak with come first: premade ones, then the
 * account's own (designed or cloned). Voices added from the Voice Library
 * (professional, famous, high quality) come last: a free account is refused
 * them through the API (402 paid_plan_required).
 */
const RANK = { premade: 0, generated: 1, cloned: 1 };
const rankOf = voice => RANK[voice.category] ?? 2;

async function voiceFor(key, voiceId) {
    if (VOICE_ID.test(String(voiceId || ''))) return voiceId;
    if (fallback.key === key && fallback.id) return fallback.id;
    const listed = await voices(key);
    if (listed.error) throw new Error(listed.error);
    const id = listed.voices[0]?.id;
    if (!id) throw new Error('There are no voices on this ElevenLabs account. Add one at elevenlabs.io, then pick it in Settings.');
    fallback = { key, id };
    return id;
}

/**
 * Speak `text`: the audio streamed to `onAudio(Uint8Array)` as it comes.
 * Resolves when it has all come, rejects with a plain message when it
 * cannot; `signal` stops it (someone started talking over it).
 */
async function stream({ key, text, voiceId = '', model = DEFAULT_MODEL, signal, onAudio }) {
    if (!key) throw new Error('There is no ElevenLabs key. Add it in Settings, under the buddy.');
    const words = String(text || '').trim().slice(0, MAX_CHARS);
    if (!words) return { rate: RATE, bytes: 0 };
    const voice = await voiceFor(key, voiceId);
    const response = await fetchImpl(`${API}/v1/text-to-speech/${voice}/stream?output_format=${FORMAT}`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: words, model_id: MODELS.includes(model) ? model : DEFAULT_MODEL }),
        signal,
    });
    if (!response.ok) throw new Error(await refusal(response));
    let bytes = 0;
    const reader = response.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) {
            bytes += value.length;
            onAudio?.(value);
        }
    }
    return { rate: RATE, bytes };
}

/** The voices on the account, for picking one in Settings. */
async function voices(key) {
    if (!key) return { error: 'There is no ElevenLabs key yet.' };
    try {
        const response = await fetchImpl(`${API}/v2/voices?page_size=100`, { headers: { 'xi-api-key': key } });
        if (!response.ok) return { error: await refusal(response) };
        const body = await response.json();
        return {
            voices: (body?.voices || [])
                .filter(voice => VOICE_ID.test(String(voice?.voice_id || '')))
                .map(voice => ({ id: voice.voice_id, name: String(voice.name || voice.voice_id), category: String(voice.category || '') }))
                // Stable: within a rank, the account's own order.
                .map((voice, index) => ({ voice, index }))
                .sort((a, b) => rankOf(a.voice) - rankOf(b.voice) || a.index - b.index)
                .map(({ voice }) => voice),
        };
    } catch (error) {
        return { error: `Could not reach ElevenLabs: ${error.message}` };
    }
}

module.exports = {
    MODELS,
    DEFAULT_MODEL,
    RATE,
    SECRET,
    VOICE_ID,
    stream,
    voices,
    _test: {
        useFetch: (fn) => {
            fetchImpl = fn;
            fallback = { key: '', id: '' };
        },
    },
};

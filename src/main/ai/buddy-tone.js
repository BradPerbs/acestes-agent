/**
 * The buddy's tone: how what it says aloud sounds. Plain, friendly, funny,
 * full meme, hype or serious, and whatever the person adds in their own
 * words ("emphatic, cracks a joke now and then").
 *
 * It is two things at once:
 *
 *   the words     the agent writes the spoken recap (and the questions it
 *                 asks), so the tone is part of what it is told: see `brief`.
 *   the delivery  how the voice says them. ElevenLabs' Eleven v4 takes audio
 *                 tags ([laughs], [excited]) and a stability setting, lower
 *                 being livelier; Flash v2.5 takes a style and a speed; this
 *                 computer's own voice a pitch and a rate.
 *
 * Delivery cues are written by the agent in curly braces, {laughs}, since
 * the recap itself sits in a [SAY: ...] tag that square brackets would end.
 * They become Eleven v4's audio tags, and are taken out for every other
 * voice and for the notch, where they would only be noise.
 */

const TONES = {
    neutral: {
        words: '',
        // ElevenLabs: stability (lower is livelier), and Flash's style and speed.
        stability: 0.5,
        style: 0,
        speed: 1,
        // This computer's voice.
        pace: 1.05,
        pitch: 1,
        sample: "Hi, I'm your buddy. Hold Control and Alt, and tell me what to do.",
    },
    friendly: {
        words: 'warm and friendly, like a colleague who is glad to help',
        stability: 0.45,
        style: 0.25,
        speed: 1,
        pace: 1.05,
        pitch: 1.03,
        sample: "Hey there! I'm your buddy. {warmly} Hold Control and Alt whenever you need a hand.",
    },
    funny: {
        words: 'funny and playful: a quick joke or a witty aside, while still saying plainly what happened',
        stability: 0.35,
        style: 0.5,
        speed: 1.05,
        pace: 1.08,
        pitch: 1.05,
        sample: "Hi, I'm your buddy. {laughs} Hold Control and Alt, and I'll do the boring clicking for you.",
    },
    memer: {
        words: 'full meme energy: internet slang and meme references, playful and a little unhinged, but the facts still come through',
        stability: 0.3,
        style: 0.65,
        speed: 1.08,
        pace: 1.1,
        pitch: 1.08,
        sample: "Yo, it's your buddy. {excited} Hold Control and Alt and we cook. No cap.",
    },
    hype: {
        words: 'emphatic and full of energy, like an excited sports commentator',
        stability: 0.25,
        style: 0.7,
        speed: 1.08,
        pace: 1.12,
        pitch: 1.06,
        sample: "{excited} Let's go! Your buddy is here! Hold Control and Alt and watch me work!",
    },
    serious: {
        words: 'serious and to the point: calm, professional, no jokes',
        stability: 0.7,
        style: 0,
        speed: 1,
        pace: 1,
        pitch: 0.97,
        sample: 'Your buddy is ready. Hold Control and Alt to give an instruction.',
    },
};

const NAMES = Object.keys(TONES);
const DEFAULT = 'neutral';
/** The most of the person's own words kept. */
const NOTE_CHARS = 200;

/** A setting's tone, as one of the names, and the person's words, tidied. */
function toneOf(settings = {}) {
    const name = NAMES.includes(settings.buddyTone) ? settings.buddyTone : DEFAULT;
    const note = cleanNote(settings.buddyToneNote);
    return { name, note, ...TONES[name] };
}

function cleanNote(value) {
    return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_CHARS);
}

/** Whether the tone wants a livelier delivery than the plain one: cues are offered then. */
function expressive(tone) {
    return Boolean(tone.note) || !['neutral', 'serious'].includes(tone.name);
}

/**
 * What the agent is told about its spoken lines: how many words, in what
 * voice, and whether it may add delivery cues (only when the voice can
 * perform them). `short` is the one-line form for a conversation already
 * told the rest.
 */
function brief(tone, { cues = false } = {}) {
    const length = expressive(tone) ? 'ten to twenty words' : 'ten to fifteen words';
    const voice = [tone.words, tone.note ? `in their own words: ${tone.note}` : ''].filter(Boolean).join('; ');
    const cueLine = cues
        ? 'You may put a delivery cue or two inside it in curly braces, such as {laughs}, {excited}, {whispers} or {sighs}: they are performed by the voice, not read out.'
        : '';
    return {
        length,
        voice,
        cueLine,
        short: `End with [SAY: a spoken recap of ${length}${voice ? `, ${voice}` : ''}]${cues ? ', cues in {curly braces} if you like' : ''}`,
    };
}

const CUE = /\{\s*([A-Za-z][A-Za-z \-]{0,24}?)\s*\}/g;

/** The words without their cues: for the notch, and for a voice that cannot perform them. */
function withoutCues(text) {
    return String(text || '').replace(CUE, ' ').replace(/\{[^}]*\}/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/\s+/g, ' ').trim();
}

/** The cues as Eleven v4's audio tags, [laughs]; anything else in braces taken out. */
function cuesAsTags(text) {
    return String(text || '').replace(CUE, (all, cue) => `[${cue.trim().toLowerCase()}]`).replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
}

/** ElevenLabs' voice_settings for a tone and model. */
function voiceSettings(tone, model) {
    const settings = { stability: tone.stability, similarity_boost: 0.75 };
    // Eleven v4 has Stability and Similarity only; Flash has style and speed too.
    if (model !== 'eleven_v4') {
        settings.style = tone.style;
        settings.speed = tone.speed;
    }
    return settings;
}

module.exports = {
    TONES,
    NAMES,
    DEFAULT,
    NOTE_CHARS,
    toneOf,
    cleanNote,
    expressive,
    brief,
    withoutCues,
    cuesAsTags,
    voiceSettings,
};

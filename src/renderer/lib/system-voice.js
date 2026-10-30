/**
 * This computer's own voice (speechSynthesis), for the buddy: its recap when
 * ElevenLabs is not used, and Settings' "Try it" for that voice. At the
 * tone's pace and pitch (main/ai/buddy-tone.js).
 */
import { getLanguage } from '../i18n';

/** This computer's voice for the app's language, a natural one when there is one. */
function pickVoice(voices) {
    const language = (getLanguage() || 'en').slice(0, 2).toLowerCase();
    const mine = voices.filter(voice => String(voice.lang || '').toLowerCase().startsWith(language));
    const pool = mine.length ? mine : voices;
    return pool.find(voice => /natural|online/i.test(voice.name))
        || pool.find(voice => /aria|jenny|guy|sonia|libby|zira|david|mark/i.test(voice.name))
        || pool.find(voice => voice.default)
        || pool[0]
        || null;
}

/** Said in this computer's voice; `end` when it has been, or could not be. Returns a way to hush it. */
export function speakSystem(text, end = () => {}, { pace = 1.05, pitch = 1 } = {}) {
    const synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
        end();
        return () => {};
    }
    const speak = () => {
        synth.cancel();
        const utterance = new window.SpeechSynthesisUtterance(text);
        const voice = pickVoice(synth.getVoices() || []);
        if (voice) {
            utterance.voice = voice;
            utterance.lang = voice.lang;
        }
        utterance.rate = Math.min(1.4, Math.max(0.7, Number(pace) || 1.05));
        utterance.pitch = Math.min(1.5, Math.max(0.6, Number(pitch) || 1));
        utterance.onend = end;
        utterance.onerror = end;
        synth.speak(utterance);
    };
    // The voices load a moment after the page; the first one waits for them, briefly.
    let waiting = 0;
    if ((synth.getVoices() || []).length) speak();
    else waiting = setTimeout(speak, 350);
    return () => {
        clearTimeout(waiting);
        synth.cancel();
    };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { bytesOf, createPcmPlayer } from '../../lib/pcm-player';
import { speakSystem } from '../../lib/system-voice';

/** The voices the spoken recap can be said in, by the name main knows them by (main/ai/buddy.js). */
export const SPOKEN_ENGINES = ['system', 'elevenlabs', 'openrouter'];

/** The engine set, or this computer's voice for anything else. */
export const spokenEngine = settings => (SPOKEN_ENGINES.includes(settings?.buddyVoice) ? settings.buddyVoice : 'system');

/**
 * What "Try it" sends for the voice as set: the engine, and its own model
 * and voice (ElevenLabs' and OpenRouter's are kept apart, so switching
 * between them loses neither).
 */
export function voiceOptions(settings) {
    const engine = spokenEngine(settings);
    if (engine === 'openrouter') {
        return { engine, model: settings.buddyOpenRouterModel || '', voiceId: settings.buddyOpenRouterVoice || '' };
    }
    return { engine, model: settings.buddyVoiceModel || 'eleven_v4', voiceId: settings.buddyVoiceId || '' };
}

/**
 * A sentence said the way the buddy would say it, from Settings: main hands
 * back ElevenLabs' or OpenRouter's audio whole, with its rate, or the words
 * with a pace and pitch for this computer's voice, which is said here.
 */
export default function useTrySay() {
    const [trying, setTrying] = useState(false);
    const [error, setError] = useState('');
    const player = useRef(null);
    const quiet = useRef(null);

    const hush = useCallback(() => {
        player.current?.stop();
        player.current = null;
        quiet.current?.();
        quiet.current = null;
    }, []);

    useEffect(() => hush, [hush]);

    const run = useCallback(async (options) => {
        setTrying(true);
        setError('');
        hush();
        try {
            const result = await window.api.buddy.tryVoice(options);
            if (result?.error) {
                setError(result.error);
                return;
            }
            if (result?.system) {
                quiet.current = speakSystem(result.system.text, () => {}, result.system);
                return;
            }
            const next = createPcmPlayer(result.rate || 24000);
            player.current = next;
            next.push(bytesOf(result.data));
            next.end(() => {});
        } finally {
            setTrying(false);
        }
    }, [hush]);

    return { trying, error, run };
}

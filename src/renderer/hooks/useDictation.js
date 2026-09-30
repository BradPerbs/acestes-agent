import { useCallback, useEffect, useRef, useState } from 'react';
import { getLanguage, useT } from '../i18n';

/**
 * Speaking a message instead of typing it.
 *
 * Two ways, by engine (see main/ai/speech.js):
 *
 *   live      Parakeet. The microphone runs through an AudioContext at
 *             16 kHz, and its samples are streamed to the main process as
 *             they come; the words so far come back while the user talks and
 *             go straight into the message, so stopping only waits for the
 *             last of them.
 *   recorded  The Whispers. The recording is made whole, and on stop turned
 *             into 16 kHz mono samples (an AudioContext at that rate
 *             resamples as it decodes) and written down in one go.
 *
 * Either way `onText(text, { final })` hears the words: while live, each
 * time they change, and once with `final` at the end, empty when nothing was
 * said or the recording was thrown away.
 *
 * The samples are taken with a ScriptProcessorNode rather than an audio
 * worklet: a worklet's module is fetched, and a packaged build is served from
 * file://, where that fetch is refused.
 *
 * `meterRef` is an element whose `--level` CSS variable follows how loud the
 * microphone is, set straight on the element each frame rather than through
 * state, so a live meter costs no renders.
 */

const RATE = 16000;
/** A message, not a meeting. */
const LIMIT_MS = 5 * 60 * 1000;
/** Samples per chunk streamed: 128 ms at 16 kHz. */
const CHUNK = 2048;

async function toSamples(blob) {
    const context = new AudioContext({ sampleRate: RATE });
    try {
        const decoded = await context.decodeAudioData(await blob.arrayBuffer());
        if (decoded.numberOfChannels === 1) return decoded.getChannelData(0);
        const mono = new Float32Array(decoded.length);
        for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
            const data = decoded.getChannelData(channel);
            for (let index = 0; index < data.length; index += 1) mono[index] += data[index] / decoded.numberOfChannels;
        }
        return mono;
    } finally {
        context.close().catch(() => {});
    }
}

/** The meter's level, read off an analyser each frame and eased. */
function startMeter(analyser, current, meterRef) {
    analyser.fftSize = 512;
    const buffer = new Float32Array(analyser.fftSize);
    let eased = 0;
    const tick = () => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let index = 0; index < buffer.length; index += 1) sum += buffer[index] * buffer[index];
        const level = Math.min(1, Math.sqrt(sum / buffer.length) * 6);
        eased = eased * 0.7 + level * 0.3;
        meterRef?.current?.style.setProperty('--level', eased.toFixed(3));
        current.frame = requestAnimationFrame(tick);
    };
    current.frame = requestAnimationFrame(tick);
}

export default function useDictation({ live = false, onText, onNotice, meterRef }) {
    const t = useT();
    // idle, starting, recording, transcribing
    const [state, setState] = useState('idle');
    const [seconds, setSeconds] = useState(0);
    // The first use downloads the model: how far, while it does.
    const [download, setDownload] = useState(null);

    const session = useRef(null);

    useEffect(() => window.api.ai.onSpeech?.((next) => {
        setDownload(next?.state === 'downloading' ? next.percent : null);
    }), []);

    // The words so far, for the recording under way in this composer.
    useEffect(() => window.api.ai.onDictation?.((update) => {
        const current = session.current;
        if (!current?.id || update?.id !== current.id || current.done) return;
        if (update.error) {
            current.error = update.error;
            return;
        }
        current.heard = update.text || '';
        onText(current.heard, { final: false });
    }), [onText]);

    /** Microphone, meter and clock let go of, whichever way the recording ended. */
    const release = useCallback(() => {
        const current = session.current;
        if (!current) return;
        clearInterval(current.clock);
        cancelAnimationFrame(current.frame);
        if (current.processor) current.processor.onaudioprocess = null;
        current.stream?.getTracks().forEach(track => track.stop());
        current.context?.close().catch(() => {});
        meterRef?.current?.style.setProperty('--level', '0');
    }, [meterRef]);

    const settle = useCallback(() => {
        session.current = null;
        setState('idle');
        setSeconds(0);
    }, []);

    /** A recorded one: written down in one go, once it has stopped. */
    const finishRecorded = useCallback(async (current) => {
        if (current.cancelled) {
            settle();
            return;
        }
        setState('transcribing');
        try {
            const blob = new Blob(current.chunks, { type: current.chunks[0]?.type || 'audio/webm' });
            const samples = await toSamples(blob);
            const result = await window.api.ai.transcribe(samples, { language: getLanguage() });
            if (result?.error) onNotice?.(t('assistant.dictationFailed', { message: result.error }));
            else if (!result?.text) onNotice?.(t('assistant.nothingHeard'));
            else onText(result.text, { final: true });
        } catch (error) {
            onNotice?.(t('assistant.dictationFailed', { message: error.message }));
        } finally {
            settle();
        }
    }, [onNotice, onText, settle, t]);

    /** A live one: the last words, which are all that is left to do. */
    const finishLive = useCallback(async (current) => {
        if (current.cancelled) {
            current.done = true;
            window.api.ai.dictationCancel?.(current.id);
            onText('', { final: true });
            settle();
            return;
        }
        setState('transcribing');
        try {
            const result = await window.api.ai.dictationStop(current.id);
            current.done = true;
            const error = result?.error || current.error;
            const text = result?.text || '';
            onText(text, { final: true });
            if (!text) onNotice?.(error ? t('assistant.dictationFailed', { message: error }) : t('assistant.nothingHeard'));
        } catch (error) {
            current.done = true;
            onText(current.heard || '', { final: true });
            onNotice?.(t('assistant.dictationFailed', { message: error.message }));
        } finally {
            settle();
        }
    }, [onNotice, onText, settle, t]);

    const finish = useCallback(async () => {
        const current = session.current;
        if (!current || current.finishing) return;
        current.finishing = true;
        // The chunk still on its way from the microphone is let through, so
        // the end of the last word is not clipped.
        if (current.live && !current.cancelled) {
            setState('transcribing');
            await new Promise(resolve => setTimeout(resolve, 160));
        }
        release();
        if (current.live) finishLive(current);
        else finishRecorded(current);
    }, [finishLive, finishRecorded, release]);

    /** Stop listening and write down what was said. */
    const stop = useCallback(() => {
        const current = session.current;
        if (!current) return;
        // A recorder hands over its last chunk first, then finishes.
        if (current.recorder) {
            if (current.recorder.state === 'recording') current.recorder.stop();
        } else {
            finish();
        }
    }, [finish]);

    const start = useCallback(async () => {
        if (session.current || state !== 'idle') return;
        setState('starting');
        onNotice?.('');
        // Live, the recording is opened in main while the microphone opens
        // here, so neither waits on the other.
        const opening = live
            ? Promise.resolve(window.api.ai.dictationStart()).catch(error => ({ error: error.message }))
            : null;
        // And the audio graph is readied meanwhile, so the first syllable
        // is not lost to it being built after the microphone is on.
        const context = live ? new AudioContext({ sampleRate: RATE }) : null;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
        } catch (error) {
            setState('idle');
            context?.close().catch(() => {});
            opening?.then(opened => opened?.id && window.api.ai.dictationCancel?.(opened.id));
            onNotice?.(error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
                ? t('assistant.micDenied')
                : t('assistant.noMic'));
            return;
        }

        const current = { live, stream, chunks: [], early: [], cancelled: false, started: Date.now(), heard: '' };
        session.current = current;

        if (live) {
            // Listening starts the moment the microphone is open: people
            // start talking as they press. Until main has said which
            // recording this is, the chunks wait here.
            current.context = context;
            const source = context.createMediaStreamSource(stream);
            const processor = context.createScriptProcessor(CHUNK, 1, 1);
            processor.onaudioprocess = (event) => {
                const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
                if (current.id) window.api.ai.dictationAudio(current.id, chunk);
                else current.early.push(chunk);
            };
            // It only runs when connected through to the speakers; silenced.
            const mute = context.createGain();
            mute.gain.value = 0;
            source.connect(processor);
            processor.connect(mute);
            mute.connect(context.destination);
            current.processor = processor;
            const analyser = context.createAnalyser();
            source.connect(analyser);
            startMeter(analyser, current, meterRef);

            const opened = await opening;
            if (!opened?.id || session.current !== current) {
                release();
                if (session.current === current) settle();
                if (opened?.error) onNotice?.(t('assistant.dictationFailed', { message: opened.error }));
                if (opened?.id) window.api.ai.dictationCancel?.(opened.id);
                return;
            }
            for (const chunk of current.early) window.api.ai.dictationAudio(opened.id, chunk);
            current.early = [];
            current.id = opened.id;
        } else {
            const recorder = new MediaRecorder(stream);
            current.recorder = recorder;
            recorder.ondataavailable = (event) => {
                if (event.data?.size) current.chunks.push(event.data);
            };
            recorder.onstop = () => { finish(); };
            recorder.start(250);
            try {
                const context = new AudioContext();
                current.context = context;
                const analyser = context.createAnalyser();
                context.createMediaStreamSource(stream).connect(analyser);
                startMeter(analyser, current, meterRef);
            } catch {
                // No meter is no loss: the clock still says it is listening.
            }
        }

        current.clock = setInterval(() => {
            const elapsed = Date.now() - current.started;
            setSeconds(Math.floor(elapsed / 1000));
            if (elapsed >= LIMIT_MS) stop();
        }, 250);
        setState('recording');
    }, [finish, live, meterRef, onNotice, release, settle, state, stop, t]);

    /** Stop listening and throw it away. */
    const cancel = useCallback(() => {
        if (!session.current) return;
        session.current.cancelled = true;
        stop();
    }, [stop]);

    // A tab closed mid-sentence still lets go of the microphone.
    useEffect(() => () => {
        const current = session.current;
        if (!current) return;
        current.cancelled = true;
        if (current.id) window.api.ai.dictationCancel?.(current.id);
        release();
    }, [release]);

    return { state, seconds, download, start, stop, cancel };
}

/**
 * Raw 16-bit little-endian mono PCM, played as it arrives: ElevenLabs'
 * voice for the buddy (main/ai/elevenlabs.js), which streams in chunk by
 * chunk while the rest of the sentence is still being made.
 *
 * Each chunk becomes a buffer scheduled right after the last one, through
 * Web Audio, which the app's content security policy leaves alone (an
 * <audio> element would want a blob: URL it refuses). A chunk can end half
 * way through a sample; the odd byte is carried into the next.
 */

/** How far ahead the first sound starts, so a slow second chunk does not leave a gap after it. */
const LEAD = 0.12;
/** How far ahead a late chunk starts, once the one before it has finished. */
const CATCH_UP = 0.03;

export function createPcmPlayer(rate) {
    const context = new AudioContext({ sampleRate: rate });
    context.resume?.().catch(() => {});
    const playing = new Set();
    let at = 0;
    let carry = null;
    let ended = false;
    let closed = false;
    let onDone = null;

    const settle = () => {
        if (!ended || playing.size > 0 || !onDone) return;
        const done = onDone;
        onDone = null;
        done();
    };

    /** A chunk of audio, scheduled after what is already queued. */
    function push(chunk) {
        if (closed || !chunk) return;
        let bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        if (carry !== null) {
            const joined = new Uint8Array(bytes.length + 1);
            joined[0] = carry;
            joined.set(bytes, 1);
            bytes = joined;
            carry = null;
        }
        if (bytes.length % 2) {
            carry = bytes[bytes.length - 1];
            bytes = bytes.subarray(0, bytes.length - 1);
        }
        const count = bytes.length / 2;
        if (!count) return;
        const buffer = context.createBuffer(1, count, rate);
        const samples = buffer.getChannelData(0);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let index = 0; index < count; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        at = at === 0 ? context.currentTime + LEAD : Math.max(at, context.currentTime + CATCH_UP);
        source.start(at);
        at += buffer.duration;
        playing.add(source);
        source.onended = () => {
            playing.delete(source);
            settle();
        };
    }

    /** No more is coming: `callback` once what is queued has been heard. */
    function end(callback) {
        ended = true;
        onDone = callback;
        settle();
    }

    /** Silence now, and let go of the audio device. */
    function stop() {
        if (closed) return;
        closed = true;
        onDone = null;
        for (const source of playing) {
            try {
                source.stop();
            } catch {
                // Not started yet, or already over.
            }
        }
        playing.clear();
        context.close().catch(() => {});
    }

    return { push, end, stop };
}

/** Base64 to bytes, for audio handed over whole (Settings' "Try the voice"). */
export function bytesOf(base64) {
    const text = atob(String(base64 || ''));
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
    return bytes;
}

const path = require('path');
const { createLiveEngine } = require('./live-speech');

/**
 * Parakeet: live dictation, written down while the user is still talking.
 *
 * NVIDIA's Parakeet TDT 0.6B v3 in sherpa-onnx's int8 build: as accurate as
 * Whisper's large model, several times quicker than Whisper's base on a CPU,
 * with punctuation and capitals of its own, in 25 European languages it
 * tells apart by itself. It is not a streaming model, so the worker cuts the
 * audio where the user pauses (Silero's voice detector) and writes each piece
 * down as it closes, with drafts of the piece under way in between.
 *
 * The model is about 670 MB, fetched once. The download, the process and the
 * recordings are live-speech.js's; this names the model.
 */

module.exports = createLiveEngine({
    name: 'parakeet',
    repo: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    revision: '2bda32ec70b097a55adaa07d9a7173915b43cc78',
    folder: 'parakeet-tdt-0.6b-v3-int8',
    files: [
        { name: 'tokens.txt', size: 93939 },
        { name: 'decoder.int8.onnx', size: 11845275 },
        { name: 'joiner.int8.onnx', size: 6355277 },
        { name: 'encoder.int8.onnx', size: 652184281 },
        {
            name: 'silero_vad.onnx',
            size: 643854,
            url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
        },
    ],
    load: dir => ({
        kind: 'pieces',
        model: {
            encoder: path.join(dir, 'encoder.int8.onnx'),
            decoder: path.join(dir, 'decoder.int8.onnx'),
            joiner: path.join(dir, 'joiner.int8.onnx'),
            tokens: path.join(dir, 'tokens.txt'),
        },
        vad: path.join(dir, 'silero_vad.onnx'),
    }),
});

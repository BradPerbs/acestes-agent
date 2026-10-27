const path = require('path');
const { createLiveEngine } = require('./live-speech');

/**
 * Nemotron: true streaming dictation, the words written as they are heard.
 *
 * NVIDIA's Nemotron 3.5 ASR Streaming 0.6B (June 2026), multilingual, in
 * sherpa-onnx's int8 build at its 560 ms setting: it hears in steps of about
 * half a second and carries what it heard before into each one (a cache-aware
 * streaming model), so the words grow as the user speaks and are never cut at
 * a pause and written down without what came before, which is what lost
 * Parakeet its accuracy on short phrases. 40 languages, with punctuation and
 * capitals; the language can be pinned (Settings, Voice input, Language),
 * which stops a sentence of accented English being heard as another
 * language. Left empty, it tells for itself.
 *
 * The model is about 680 MB, fetched once. The download, the process and the
 * recordings are live-speech.js's; this names the model.
 */

module.exports = createLiveEngine({
    name: 'nemotron',
    repo: 'csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11',
    revision: 'ab43d895f5985b1bbab8b6eac8607fcdc05343f3',
    folder: 'nemotron-3.5-asr-streaming-0.6b-560ms-int8',
    files: [
        { name: 'tokens.txt', size: 131440 },
        { name: 'decoder.int8.onnx', size: 14978075 },
        { name: 'joiner.int8.onnx', size: 9504438 },
        { name: 'encoder.int8.onnx', size: 657601403 },
    ],
    load: dir => ({
        kind: 'streaming',
        model: {
            encoder: path.join(dir, 'encoder.int8.onnx'),
            decoder: path.join(dir, 'decoder.int8.onnx'),
            joiner: path.join(dir, 'joiner.int8.onnx'),
            tokens: path.join(dir, 'tokens.txt'),
        },
    }),
});

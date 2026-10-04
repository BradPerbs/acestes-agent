/**
 * The sounds the agent makes when it gets back to you.
 *
 * Every one is drawn with Web Audio rather than shipped as a file, so there is
 * nothing to bundle or load and nobody's recording to license. The funny ones
 * are impressions of sounds everyone knows (a coin, a sad trombone, a
 * rimshot), built from oscillators and noise, not samples of them.
 *
 * `chime` is the app's own and the default: two soft notes a fifth apart,
 * quiet enough to sit under whatever else is playing. The rest are picked in
 * Settings, Chat, for when a task is done. Questions and approvals keep the
 * chime whatever is picked, so "needs you" never sounds like "finished".
 *
 * Each sound is written at full volume; `volume` (0-100) scales the lot
 * through one gain, so a loud one and a quiet one move together.
 */

/**
 * The sounds by the heading the settings page lists them under. The memes
 * and the dark ones are impressions too: the voices ("bruh", "oof") are a
 * buzz pushed through vowel filters, and the two tunes in "dark" (Bach's
 * Toccata, Chopin's funeral march) are long out of copyright.
 */
export const SOUND_GROUPS = [
    { id: 'classic', sounds: ['chime', 'ding', 'pop', 'marimba'] },
    { id: 'games', sounds: ['coin', 'powerup', 'levelup', 'fanfare', 'tada', 'alert'] },
    {
        id: 'funny',
        sounds: ['sadtrombone', 'rimshot', 'kaching', 'microwave', 'boing', 'slidewhistle',
            'quack', 'crickets', 'airhorn', 'recordscratch', 'drumroll', 'buzzer'],
    },
    {
        id: 'memes',
        sounds: ['vineboom', 'bruh', 'oof', 'metalpipe', 'bong', 'bonk', 'fart', 'fartreverb',
            'dialup', 'dundundun', 'braaam'],
    },
    { id: 'dark', sounds: ['flatline', 'funeral', 'toccata', 'youdied', 'kaboom'] },
];

/** Every id, in the order the settings page lists them. Mirrored in main's settings.js. */
export const SOUND_IDS = [...SOUND_GROUPS.flatMap(group => group.sounds), 'off'];

export const DEFAULT_SOUND = 'chime';
export const DEFAULT_VOLUME = 70;

// One context for the window's life: browsers cap how many can be open.
let context = null;
// Shared white noise, made once: a second of it covers every burst here.
let noiseBuffer = null;
// The master gain of the sound still ringing, if any.
let playing = null;

function audio() {
    context = context || new AudioContext();
    // Suspended by a window that has not made a sound yet.
    if (context.state === 'suspended') context.resume().catch(() => {});
    return context;
}

/**
 * One note: an oscillator through an envelope with a quick rise and a fall to
 * nothing, so neither end clicks. `glide` slides the pitch to a frequency by
 * the end; `vibrato` wobbles it, in Hz of depth at `rate` per second.
 */
function note(ctx, out, {
    freq, at = 0, length = 0.3, type = 'sine', gain = 0.3,
    attack = 0.01, release = null, glide = null, glideCurve = 'exp',
    vibrato = 0, rate = 6, filter = null,
}) {
    const start = ctx.currentTime + 0.02 + at;
    const end = start + length;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (glide) {
        if (glideCurve === 'linear') osc.frequency.linearRampToValueAtTime(glide, end);
        else osc.frequency.exponentialRampToValueAtTime(glide, end);
    }
    if (vibrato) {
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.value = rate;
        depth.gain.value = vibrato;
        lfo.connect(depth).connect(osc.frequency);
        lfo.start(start);
        lfo.stop(end + 0.05);
    }

    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain, start + attack);
    if (release === null) {
        // Struck: falls away from the top straight off.
        env.gain.exponentialRampToValueAtTime(0.0001, end);
    } else {
        // Held: stays up, then lets go over `release` seconds.
        env.gain.setValueAtTime(gain, Math.max(start + attack, end - release));
        env.gain.linearRampToValueAtTime(0, end);
    }

    let chain = osc;
    if (filter) {
        const shape = ctx.createBiquadFilter();
        shape.type = filter.type || 'lowpass';
        shape.frequency.value = filter.freq;
        if (filter.q) shape.Q.value = filter.q;
        chain = chain.connect(shape);
    }
    chain.connect(env).connect(out);
    osc.start(start);
    osc.stop(end + 0.05);
}

/**
 * A burst of filtered noise: a cymbal, a rattle, a puff of air. `to` sweeps
 * the filter there by the end (a record scratch); `held` keeps it up and lets
 * go over that many seconds instead of dying away from the start.
 */
function noise(ctx, out, {
    at = 0, length = 0.2, gain = 0.2, type = 'highpass', freq = 6000, q = 0.7,
    to = null, attack = 0.005, held = null,
}) {
    if (!noiseBuffer) {
        noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    }
    const start = ctx.currentTime + 0.02 + at;
    const end = start + length;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = true;
    const shape = ctx.createBiquadFilter();
    shape.type = type;
    shape.frequency.setValueAtTime(freq, start);
    if (to) shape.frequency.exponentialRampToValueAtTime(to, end);
    shape.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain, start + attack);
    if (held === null) {
        env.gain.exponentialRampToValueAtTime(0.0001, end);
    } else {
        env.gain.setValueAtTime(gain, Math.max(start + attack, end - held));
        env.gain.linearRampToValueAtTime(0, end);
    }
    source.connect(shape).connect(env).connect(out);
    source.start(start, Math.random() * 0.5);
    source.stop(end + 0.05);
}

/** A drum: a sine that drops in pitch as it dies. */
function drum(ctx, out, { at = 0, freq = 180, to = 60, length = 0.25, gain = 0.6 }) {
    note(ctx, out, { freq, glide: to, at, length, gain, attack: 0.003 });
}

/** A frequency from a MIDI note number: 69 is A4, 60 middle C. */
const midi = (number) => 440 * 2 ** ((number - 69) / 12);

/**
 * Overdrive: whatever goes in comes out squashed and buzzing, at `level`.
 * Returns the node to play into. What makes a boom read on laptop speakers
 * that cannot reproduce the boom itself: the harmonics it grows can be heard.
 */
function overdrive(ctx, out, { amount = 8, level = 0.5 } = {}) {
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i += 1) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
    }
    shaper.curve = curve;
    const gain = ctx.createGain();
    gain.gain.value = level;
    shaper.connect(gain).connect(out);
    return shaper;
}

/**
 * A big room: the dry sound plus a tail of decaying noise convolved over it.
 * Returns the node to play into. The "with reverb" of the memes.
 */
function reverb(ctx, out, { seconds = 2.5, wet = 0.7 } = {}) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
        const data = impulse.getChannelData(channel);
        for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    }
    const input = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse;
    const tail = ctx.createGain();
    tail.gain.value = wet;
    input.connect(out);
    input.connect(convolver).connect(tail).connect(out);
    return input;
}

/**
 * A voice, of a sort: a buzz at the pitch of a throat, pushed through band
 * filters at a vowel's formants. `formants` is `[[frequency, level], ...]`;
 * `trill` flutters the volume that many times a second, for a rolled "br".
 */
function voice(ctx, out, {
    at = 0, length = 0.4, f0 = 110, to = f0, formants, gain = 0.5,
    attack = 0.03, release = 0.1, trill = 0, q = 7,
}) {
    const start = ctx.currentTime + 0.02 + at;
    const end = start + length;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0, start);
    osc.frequency.exponentialRampToValueAtTime(to, end);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain, start + attack);
    env.gain.setValueAtTime(gain, Math.max(start + attack, end - release));
    env.gain.linearRampToValueAtTime(0, end);
    for (const [frequency, level] of formants) {
        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.frequency.value = frequency;
        band.Q.value = q;
        const amount = ctx.createGain();
        amount.gain.value = level;
        osc.connect(band).connect(amount).connect(env);
    }
    let chain = env;
    if (trill) {
        const flutter = ctx.createGain();
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        flutter.gain.value = 0.5;
        lfo.frequency.value = trill;
        depth.gain.value = 0.5;
        lfo.connect(depth).connect(flutter.gain);
        lfo.start(start);
        lfo.stop(end + 0.05);
        chain = env.connect(flutter);
    }
    chain.connect(out);
    osc.start(start);
    osc.stop(end + 0.05);
}

/** A pipe organ note: a sine per drawbar, an octave below to four above. */
function organ(ctx, out, { freq, at = 0, length = 0.4, gain = 0.1 }) {
    for (const [multiple, level] of [[0.5, 0.8], [1, 1], [2, 0.6], [3, 0.35], [4, 0.3], [6, 0.12]]) {
        note(ctx, out, { freq: freq * multiple, at, length, gain: gain * level, attack: 0.015, release: 0.06 });
    }
}

/** A whoopee cushion: a low buzz that wobbles as it runs out of air. */
function drawFart(ctx, out) {
    const buzz = { type: 'sawtooth', attack: 0.02, filter: { freq: 420, q: 4 } };
    note(ctx, out, { ...buzz, freq: 92, glide: 64, length: 0.75, gain: 0.55, release: 0.25, vibrato: 18, rate: 13 });
    note(ctx, out, { ...buzz, freq: 140, glide: 96, length: 0.6, gain: 0.2, release: 0.2, vibrato: 25, rate: 21 });
    noise(ctx, out, { length: 0.7, gain: 0.12, type: 'lowpass', freq: 350, attack: 0.02, held: 0.25 });
}

/** A struck metal thing: inharmonic partials, each ringing for its own time. */
function metal(ctx, out, { freq, at = 0, partials, gain = 0.2, length = 1.5 }) {
    for (const [ratio, level, ring] of partials) {
        note(ctx, out, { freq: freq * ratio, at, length: length * ring, gain: gain * level, attack: 0.002 });
    }
}

const NOTE = {
    G3: 196.0, A3: 220.0, Bb3: 233.08, B3: 246.94,
    C4: 261.63, Db4: 277.18, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, Bb4: 466.16, B4: 493.88,
    C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77,
    C6: 1046.5, E6: 1318.51, G6: 1567.98, C7: 2093.0, E7: 2637.02,
};

/** How each sound is drawn, given a context and the gain node to play into. */
const DRAW = {
    chime(ctx, out) {
        // 0.24 at the default volume of 70 is the 0.12 a note it always had.
        note(ctx, out, { freq: NOTE.A5, length: 0.42, gain: 0.24, attack: 0.012 });
        note(ctx, out, { freq: NOTE.E6, at: 0.11, length: 0.42, gain: 0.24, attack: 0.012 });
    },

    ding(ctx, out) {
        // A desk bell: one partial and a fainter, higher one beside it.
        note(ctx, out, { freq: NOTE.E6, length: 1.4, gain: 0.2, attack: 0.004 });
        note(ctx, out, { freq: NOTE.E6 * 2.76, length: 0.6, gain: 0.05, attack: 0.004 });
    },

    pop(ctx, out) {
        note(ctx, out, { freq: 300, glide: 1200, length: 0.09, gain: 0.35, attack: 0.003 });
    },

    marimba(ctx, out) {
        [NOTE.C5, NOTE.E5, NOTE.G5].forEach((freq, i) => {
            note(ctx, out, { freq, at: i * 0.09, length: 0.35, gain: 0.25, attack: 0.003 });
            note(ctx, out, { freq: freq * 4, at: i * 0.09, length: 0.06, gain: 0.04, attack: 0.002 });
        });
    },

    // The coin from every 8-bit platformer: a blip, then a held note a fourth up.
    coin(ctx, out) {
        note(ctx, out, { freq: NOTE.B5, length: 0.08, type: 'square', gain: 0.12, attack: 0.002, release: 0.01 });
        note(ctx, out, { freq: NOTE.E6, at: 0.08, length: 0.45, type: 'square', gain: 0.12, attack: 0.002 });
    },

    // A mushroom's worth of rising arpeggio.
    powerup(ctx, out) {
        const steps = [NOTE.C5, NOTE.G5, NOTE.C6, NOTE.E5, NOTE.B5, NOTE.E6, NOTE.G5, NOTE.D5 * 2, NOTE.G6];
        steps.forEach((freq, i) => {
            note(ctx, out, { freq, at: i * 0.045, length: 0.06, type: 'square', gain: 0.1, attack: 0.002, release: 0.01 });
        });
    },

    levelup(ctx, out) {
        [NOTE.C5, NOTE.E5, NOTE.G5].forEach((freq, i) => {
            note(ctx, out, { freq, at: i * 0.08, length: 0.08, type: 'square', gain: 0.1, attack: 0.002, release: 0.01 });
        });
        note(ctx, out, { freq: NOTE.C6, at: 0.24, length: 0.5, type: 'square', gain: 0.1, attack: 0.002, release: 0.2, vibrato: 8, rate: 7 });
    },

    // Three quick, one long, then up: the shape of every battle-won jingle.
    fanfare(ctx, out) {
        const brass = { type: 'sawtooth', gain: 0.12, attack: 0.01, filter: { freq: 2400 } };
        note(ctx, out, { ...brass, freq: NOTE.G4, at: 0, length: 0.1, release: 0.02 });
        note(ctx, out, { ...brass, freq: NOTE.G4, at: 0.12, length: 0.1, release: 0.02 });
        note(ctx, out, { ...brass, freq: NOTE.G4, at: 0.24, length: 0.1, release: 0.02 });
        note(ctx, out, { ...brass, freq: NOTE.C5, at: 0.36, length: 0.4, release: 0.05 });
        note(ctx, out, { ...brass, freq: NOTE.E5, at: 0.8, length: 0.16, release: 0.03 });
        note(ctx, out, { ...brass, freq: NOTE.G5, at: 0.98, length: 0.8, release: 0.4, vibrato: 4, rate: 6 });
    },

    tada(ctx, out) {
        const brass = { type: 'sawtooth', gain: 0.08, attack: 0.01, filter: { freq: 3000 } };
        for (const freq of [NOTE.C4, NOTE.E4, NOTE.G4, NOTE.C5]) {
            note(ctx, out, { ...brass, freq, length: 0.12, release: 0.03 });
            note(ctx, out, { ...brass, freq, at: 0.16, length: 0.9, release: 0.4, vibrato: 3, rate: 5.5 });
        }
        noise(ctx, out, { at: 0.16, length: 0.6, gain: 0.08, freq: 7000 });
    },

    // Wah, wah, wah, waaaah.
    sadtrombone(ctx, out) {
        const horn = { type: 'sawtooth', gain: 0.18, attack: 0.04, filter: { freq: 900, q: 2 } };
        note(ctx, out, { ...horn, freq: NOTE.D4, at: 0, length: 0.36, release: 0.08 });
        note(ctx, out, { ...horn, freq: NOTE.Db4, at: 0.42, length: 0.36, release: 0.08 });
        note(ctx, out, { ...horn, freq: NOTE.C4, at: 0.84, length: 0.36, release: 0.08 });
        note(ctx, out, { ...horn, freq: NOTE.B3, at: 1.26, length: 1.3, release: 0.4, vibrato: 6, rate: 5 });
    },

    // Ba-dum-tss.
    rimshot(ctx, out) {
        drum(ctx, out, { at: 0, freq: 220, to: 110, length: 0.18, gain: 0.5 });
        drum(ctx, out, { at: 0.16, freq: 160, to: 70, length: 0.22, gain: 0.55 });
        drum(ctx, out, { at: 0.36, freq: 90, to: 45, length: 0.25, gain: 0.5 });
        noise(ctx, out, { at: 0.36, length: 0.9, gain: 0.22, freq: 7000 });
    },

    // A till drawer: the rattle of the coins, then the bell.
    kaching(ctx, out) {
        noise(ctx, out, { length: 0.12, gain: 0.25, type: 'bandpass', freq: 3500, q: 1.5 });
        noise(ctx, out, { at: 0.05, length: 0.1, gain: 0.2, type: 'bandpass', freq: 5000, q: 2 });
        note(ctx, out, { freq: NOTE.C7, at: 0.12, length: 1.0, gain: 0.14, attack: 0.003 });
        note(ctx, out, { freq: NOTE.E7, at: 0.12, length: 0.9, gain: 0.12, attack: 0.003 });
    },

    microwave(ctx, out) {
        for (let i = 0; i < 3; i += 1) {
            note(ctx, out, { freq: 1000, at: i * 0.32, length: 0.2, type: 'square', gain: 0.07, attack: 0.003, release: 0.01 });
        }
    },

    boing(ctx, out) {
        note(ctx, out, { freq: 90, glide: 420, length: 0.55, type: 'triangle', gain: 0.4, attack: 0.005, vibrato: 30, rate: 18 });
    },

    slidewhistle(ctx, out) {
        note(ctx, out, { freq: 500, glide: 1800, length: 0.35, gain: 0.18, attack: 0.03, release: 0.02, vibrato: 12, rate: 7 });
        note(ctx, out, { freq: 1800, glide: 600, at: 0.37, length: 0.45, gain: 0.18, attack: 0.01, release: 0.1, vibrato: 12, rate: 7 });
    },

    quack(ctx, out) {
        const duck = { type: 'sawtooth', gain: 0.3, attack: 0.01, release: 0.05, filter: { type: 'bandpass', freq: 1100, q: 4 } };
        note(ctx, out, { ...duck, freq: 420, glide: 300, length: 0.16 });
        note(ctx, out, { ...duck, freq: 440, glide: 290, at: 0.22, length: 0.2 });
    },

    // The joke is the silence around them.
    crickets(ctx, out) {
        for (const at of [0, 0.7]) {
            for (let i = 0; i < 4; i += 1) {
                note(ctx, out, { freq: 4400, at: at + i * 0.045, length: 0.03, gain: 0.08, attack: 0.004 });
            }
        }
    },

    // The "!" a guard makes on spotting you.
    alert(ctx, out) {
        note(ctx, out, { freq: 1400, length: 0.07, type: 'square', gain: 0.1, attack: 0.002, release: 0.01 });
        note(ctx, out, { freq: 2100, at: 0.07, length: 0.4, type: 'square', gain: 0.1, attack: 0.002, release: 0.25 });
    },

    airhorn(ctx, out) {
        const horn = { type: 'sawtooth', gain: 0.07, attack: 0.02, release: 0.03, filter: { freq: 2600 } };
        const blasts = [[0, 0.14], [0.18, 0.14], [0.36, 0.7]];
        for (const [at, length] of blasts) {
            for (const freq of [466, 470, 588, 699]) note(ctx, out, { ...horn, freq, at, length });
        }
    },

    // Rewind, then stop dead: "yep, that's me".
    recordscratch(ctx, out) {
        noise(ctx, out, { length: 0.11, gain: 0.5, type: 'bandpass', freq: 700, to: 3200, q: 3, attack: 0.01, held: 0.02 });
        noise(ctx, out, { at: 0.11, length: 0.16, gain: 0.5, type: 'bandpass', freq: 3200, to: 500, q: 3, attack: 0.005, held: 0.03 });
        note(ctx, out, { freq: 300, glide: 900, length: 0.11, type: 'sawtooth', gain: 0.06, attack: 0.01, release: 0.02 });
        note(ctx, out, { freq: 900, glide: 200, at: 0.11, length: 0.16, type: 'sawtooth', gain: 0.06, attack: 0.005, release: 0.03 });
    },

    drumroll(ctx, out) {
        const hits = 34;
        for (let i = 0; i < hits; i += 1) {
            noise(ctx, out, { at: i * 0.035, length: 0.05, gain: 0.08 + (i / hits) * 0.2, type: 'bandpass', freq: 2200, q: 0.8 });
        }
        drum(ctx, out, { at: 1.22, freq: 120, to: 45, length: 0.4, gain: 0.7 });
        noise(ctx, out, { at: 1.22, length: 1.4, gain: 0.3, freq: 5500 });
    },

    // The game show's wrong answer.
    buzzer(ctx, out) {
        const buzz = { type: 'square', length: 0.75, gain: 0.08, attack: 0.01, release: 0.05, filter: { freq: 1600 } };
        note(ctx, out, { ...buzz, freq: 140 });
        note(ctx, out, { ...buzz, freq: 146 });
    },

    // The boom under every video that just said something unhinged.
    vineboom(ctx, out) {
        const drive = overdrive(ctx, out, { amount: 6, level: 0.55 });
        note(ctx, drive, { freq: 110, glide: 38, length: 1.3, gain: 0.9, attack: 0.004 });
        note(ctx, drive, { freq: 220, glide: 70, length: 0.5, gain: 0.4, attack: 0.004 });
        noise(ctx, out, { length: 0.35, gain: 0.35, type: 'lowpass', freq: 500 });
    },

    // A rolled "br", then a falling "uh".
    bruh(ctx, out) {
        voice(ctx, out, { length: 0.16, f0: 100, formants: [[320, 5], [700, 2]], gain: 0.7, trill: 28, attack: 0.01, release: 0.03 });
        voice(ctx, out, {
            at: 0.13, length: 0.5, f0: 118, to: 82, gain: 0.8, attack: 0.02, release: 0.18,
            formants: [[680, 5], [1180, 3], [2550, 1.2]],
        });
    },

    // A short, pained "oof".
    oof(ctx, out) {
        voice(ctx, out, {
            length: 0.24, f0: 230, to: 150, gain: 0.8, attack: 0.008, release: 0.08,
            formants: [[330, 6], [850, 2.5], [2300, 0.6]],
        });
        noise(ctx, out, { at: 0.2, length: 0.12, gain: 0.06, freq: 2500, held: 0.08 });
    },

    // Something long and steel hitting a concrete floor, and bouncing.
    metalpipe(ctx, out) {
        const room = reverb(ctx, out, { seconds: 1.8, wet: 0.5 });
        const pipe = [[1, 1, 1], [2.76, 0.8, 0.8], [5.4, 0.6, 0.6], [8.93, 0.45, 0.4], [13.34, 0.3, 0.25]];
        metal(ctx, room, { freq: 410, partials: pipe, gain: 0.22, length: 2.2 });
        noise(ctx, room, { length: 0.08, gain: 0.6, type: 'bandpass', freq: 3000, q: 1 });
        metal(ctx, room, { freq: 410, at: 0.32, partials: pipe, gain: 0.09, length: 0.8 });
        metal(ctx, room, { freq: 410, at: 0.52, partials: pipe, gain: 0.04, length: 0.5 });
    },

    // A deep, solemn bell, as heard at the end of a fast-food ad.
    bong(ctx, out) {
        const room = reverb(ctx, out, { seconds: 2.5, wet: 0.4 });
        metal(ctx, room, {
            freq: 190, gain: 0.3, length: 3,
            partials: [[0.5, 0.7, 1], [1, 1, 0.9], [1.19, 0.5, 0.7], [1.5, 0.35, 0.6], [2, 0.4, 0.5], [2.74, 0.2, 0.35]],
        });
    },

    // The cartoon mallet on the head.
    bonk(ctx, out) {
        note(ctx, out, { freq: 620, glide: 260, length: 0.12, type: 'triangle', gain: 0.6, attack: 0.002 });
        noise(ctx, out, { length: 0.07, gain: 0.5, type: 'bandpass', freq: 1000, q: 2.5 });
        note(ctx, out, { freq: 1240, length: 0.05, gain: 0.15, attack: 0.001 });
    },

    fart(ctx, out) {
        drawFart(ctx, out);
    },

    // The same, in a cathedral.
    fartreverb(ctx, out) {
        drawFart(ctx, reverb(ctx, out, { seconds: 3.5, wet: 1.1 }));
    },

    // Connecting to the internet, 1999.
    dialup(ctx, out) {
        const keys = [[697, 1209], [770, 1336], [852, 1477], [941, 1336], [697, 1477], [770, 1209]];
        keys.forEach(([low, high], i) => {
            for (const freq of [low, high]) note(ctx, out, { freq, at: i * 0.1, length: 0.07, gain: 0.08, attack: 0.003, release: 0.01 });
        });
        note(ctx, out, { freq: 2100, at: 0.7, length: 0.4, gain: 0.08, attack: 0.01, release: 0.02 });
        for (let i = 0; i < 8; i += 1) {
            note(ctx, out, { freq: i % 2 ? 2250 : 1650, at: 1.15 + i * 0.06, length: 0.055, type: 'square', gain: 0.04, attack: 0.002, release: 0.01 });
        }
        noise(ctx, out, { at: 1.65, length: 0.9, gain: 0.25, type: 'bandpass', freq: 1800, q: 0.6, attack: 0.02, held: 0.1 });
        note(ctx, out, { freq: 980, glide: 1180, glideCurve: 'linear', at: 1.65, length: 0.9, type: 'square', gain: 0.03, release: 0.1, vibrato: 200, rate: 30 });
    },

    // Dun, dun, DUNNN.
    dundundun(ctx, out) {
        const brass = { type: 'sawtooth', gain: 0.1, attack: 0.02, filter: { freq: 1400 } };
        const chord = (root, at, length, extra = {}) => {
            for (const step of [0, 7, 12]) note(ctx, out, { ...brass, ...extra, freq: midi(root + step), at, length, release: Math.min(0.3, length / 3) });
        };
        chord(45, 0, 0.22);
        drum(ctx, out, { freq: 110, to: 55, length: 0.3, gain: 0.5 });
        chord(46, 0.35, 0.22);
        drum(ctx, out, { at: 0.35, freq: 110, to: 55, length: 0.3, gain: 0.5 });
        chord(42, 0.75, 1.5, { vibrato: 3, rate: 5 });
        drum(ctx, out, { at: 0.75, freq: 90, to: 40, length: 0.9, gain: 0.7 });
    },

    // The trailer horn that means the stakes just went up.
    braaam(ctx, out) {
        const drive = overdrive(ctx, out, { amount: 3, level: 0.3 });
        const start = ctx.currentTime + 0.02;
        const shape = ctx.createBiquadFilter();
        shape.type = 'lowpass';
        shape.frequency.setValueAtTime(250, start);
        shape.frequency.exponentialRampToValueAtTime(1800, start + 0.35);
        shape.frequency.exponentialRampToValueAtTime(600, start + 1.8);
        shape.connect(drive);
        for (const [root, detune] of [[36, 0], [36, 0.6], [43, 0], [48, -0.5], [51, 0.4]]) {
            note(ctx, shape, { freq: midi(root) + detune, length: 1.9, type: 'sawtooth', gain: 0.25, attack: 0.06, release: 0.7 });
        }
    },

    // A heart monitor: two beats, then the long one.
    flatline(ctx, out) {
        const beep = { freq: 960, type: 'sine', gain: 0.22, attack: 0.005, release: 0.02 };
        note(ctx, out, { ...beep, length: 0.12 });
        note(ctx, out, { ...beep, at: 0.55, length: 0.12 });
        note(ctx, out, { ...beep, at: 1.1, length: 2.0, release: 0.15 });
    },

    // Chopin, Sonata No. 2, third movement: dum, dum-da-dum.
    funeral(ctx, out) {
        const beat = 0.5;
        const tune = [
            [58, 1], [58, 0.75], [58, 0.25], [58, 1],
            [61, 0.75], [60, 0.25], [60, 0.75], [58, 0.25], [58, 0.75], [57, 0.25], [58, 1.5],
        ];
        let at = 0;
        for (const [number, beats] of tune) {
            const length = Math.max(beats * beat * 1.6, 0.5);
            note(ctx, out, { freq: midi(number), at, length, type: 'triangle', gain: 0.28, attack: 0.008 });
            note(ctx, out, { freq: midi(number + 12), at, length: length * 0.6, gain: 0.06, attack: 0.008 });
            at += beats * beat;
        }
        // The left hand: B-flat minor, then G-flat, twice over.
        [[46, 53], [42, 49], [46, 53], [42, 49]].forEach(([low, high], i) => {
            for (const number of [low, high]) note(ctx, out, { freq: midi(number), at: i * 2 * beat, length: 1.2, type: 'triangle', gain: 0.14, attack: 0.01 });
        });
    },

    // Bach, BWV 565: the opening every haunted house plays.
    toccata(ctx, out) {
        const room = reverb(ctx, out, { seconds: 2.5, wet: 0.5 });
        const tune = [
            [69, 0.09], [67, 0.09], [69, 0.8], [null, 0.25],
            [67, 0.13], [65, 0.13], [64, 0.13], [62, 0.13], [61, 0.4], [62, 1.1],
        ];
        let at = 0;
        for (const [number, length] of tune) {
            if (number !== null) organ(ctx, room, { freq: midi(number), at, length: length + 0.02, gain: 0.07 });
            at += length;
        }
    },

    // The screen goes red and the words come up.
    youdied(ctx, out) {
        drum(ctx, out, { freq: 80, to: 30, length: 1.4, gain: 0.8 });
        noise(ctx, out, { length: 1.2, gain: 0.25, type: 'lowpass', freq: 300 });
        const room = reverb(ctx, out, { seconds: 3, wet: 0.6 });
        for (const number of [38, 41, 45, 50]) {
            note(ctx, room, {
                freq: midi(number), at: 0.05, length: 2.6, type: 'sawtooth', gain: 0.06,
                attack: 0.5, release: 1.2, filter: { freq: 700 }, vibrato: 1.5, rate: 4,
            });
        }
    },

    kaboom(ctx, out) {
        const drive = overdrive(ctx, out, { amount: 4, level: 0.6 });
        noise(ctx, drive, { length: 1.8, gain: 0.9, type: 'lowpass', freq: 1200, to: 80, attack: 0.003 });
        note(ctx, drive, { freq: 90, glide: 28, length: 1.4, gain: 0.8, attack: 0.003 });
    },

    off() {},
};

/**
 * Draw a sound into any context and node, a live one or an offline render.
 * Anything unknown draws the chime.
 */
export function drawSound(ctx, out, id) {
    const name = isSound(id) ? id : DEFAULT_SOUND;
    const db = TRIM[name] || 0;
    if (!db) {
        DRAW[name](ctx, out);
        return;
    }
    const trim = ctx.createGain();
    trim.gain.value = 10 ** (db / 20);
    trim.connect(out);
    DRAW[name](ctx, trim);
}

/**
 * Corrections in dB, so a meme does not come in twice as loud as the chime
 * at the same setting. Measured from offline renders: the loudest 50 ms of
 * each brought to within a few dB of the others, with the booms left a touch
 * hotter since most of their energy is bass a laptop speaker cannot play.
 */
const TRIM = {
    oof: -10, bruh: -5, vineboom: -4, kaboom: -4, youdied: -4, dundundun: -4,
    fart: -3.5, fartreverb: -4, drumroll: -3.5, bong: -2,
    crickets: 8, quack: 6, microwave: 4, fanfare: 4, recordscratch: 4, dialup: 3, toccata: 3,
};

/** Whether `id` names a sound here. */
export function isSound(id) {
    return Object.prototype.hasOwnProperty.call(DRAW, id);
}

/**
 * Play a sound by id, at a volume from 0 to 100. Anything unknown plays the
 * chime, so a setting written by a newer version still makes a noise.
 */
export function playSound(id = DEFAULT_SOUND, volume = DEFAULT_VOLUME) {
    const level = Math.min(Math.max(Number(volume), 0), 100);
    if (id === 'off' || !Number.isFinite(level) || level === 0) return;
    try {
        const ctx = audio();
        // The newest sound wins: auditioning the list in Settings would
        // otherwise pile a funeral march under an air horn.
        try { playing?.disconnect(); } catch { /* already gone */ }
        const master = ctx.createGain();
        // Squared, so the bottom half of the slider is not all "loud".
        master.gain.value = (level / 100) ** 2;
        master.connect(ctx.destination);
        playing = master;
        drawSound(ctx, master, id);
        // Let go of the master gain once everything has rung out: the
        // longest tune and its reverb are done well inside this.
        setTimeout(() => {
            try { master.disconnect(); } catch { /* gone */ }
            if (playing === master) playing = null;
        }, 9000);
    } catch {
        // No audio device, or no Web Audio: the notification still says it.
    }
}

/** The app's own chime, at the default volume: questions and approvals. */
export function playChime() {
    playSound(DEFAULT_SOUND, DEFAULT_VOLUME);
}

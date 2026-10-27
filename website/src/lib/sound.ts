"use client";

/**
 * The site's sound: recorded effects, played with the Web Audio API.
 *
 *   The music     "Processor Pulses", dark pulsing electronic: its intro
 *                 once, then 48 bars looped on the beat; loudest over the
 *                 hero and quieter further down the page.
 *   One-shots     the comet's whoosh, panned the way it flies; a tick for
 *                 links and buttons, a click to press them; keys for the
 *                 typed labels; drops, plucks and a chime in the demos.
 *
 * On by default, like the dark theme: the visitor can turn it off, and that
 * is remembered. Browsers let a page make sound only once someone has
 * clicked, tapped or pressed a key on it, so that first gesture is what
 * starts it. The files load only then, and nothing plays while the tab is
 * hidden.
 *
 * The effects are CC0 (public domain) and the music is under the Pixabay
 * Content License; where each comes from is in public/sounds/CREDITS.md.
 */

export type Sound = "tick" | "press" | "type" | "blip" | "send" | "chime" | "step";

type Clip = Sound | "on" | "off" | "whoosh";

const KEY = "acestes-sound";

/** Each sound's files (one is picked at random) and how loud it plays. */
const CLIPS: Record<Clip, { files: string[]; gain: number; vary?: number }> = {
  tick: { files: ["tick.wav"], gain: 0.12, vary: 0.06 },
  press: { files: ["press.wav"], gain: 0.22, vary: 0.05 },
  type: { files: [1, 2, 3, 4, 5, 6].map((n) => `key-${n}.wav`), gain: 0.22, vary: 0.04 },
  step: { files: ["step.wav"], gain: 0.18, vary: 0.05 },
  blip: { files: ["blip.wav"], gain: 0.28 },
  send: { files: ["send.wav"], gain: 0.26 },
  chime: { files: ["chime.wav"], gain: 0.3 },
  on: { files: ["on.wav"], gain: 0.3 },
  off: { files: ["off.wav"], gain: 0.26 },
  whoosh: { files: ["comet.mp3"], gain: 0.38 },
};

/**
 * The music: the intro plays once, then 48 bars (115.2 s at 100 BPM) loop,
 * the last of them blended into the bar before the loop starts, so the wrap
 * sounds like the track going on. Times are in the file.
 */
const MUSIC = "music.mp3";
const MUSIC_LOOP = { start: 28.805, end: 144.0049 };
/** How loud the music is over the hero, and how much of that it keeps further down. */
const MUSIC_GAIN = 0.36;
const MUSIC_BELOW = 0.4;

const url = (file: string) => `/sounds/${file}`;

let ctx: AudioContext | null = null;
let master: GainNode;
let fx: GainNode;
let bed: GainNode;
let enabled = true;
const buffers = new Map<string, AudioBuffer>();
const listeners = new Set<() => void>();
const last: Partial<Record<Clip, number>> = {};

const notify = () => listeners.forEach((l) => l());

/* ------------------------------------------------------------------ */
/* The graph                                                           */
/* ------------------------------------------------------------------ */

async function load(name: string) {
  if (!ctx || buffers.has(name)) return;
  try {
    const res = await fetch(url(name));
    if (!res.ok) return;
    buffers.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
  } catch {
    // A sound that fails to load just stays quiet.
  }
}

function build() {
  if (ctx) return ctx;
  const AC =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  const c = new AC();
  ctx = c;

  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 3;
  comp.connect(c.destination);

  master = c.createGain();
  master.gain.value = 0;
  master.connect(comp);

  fx = c.createGain();
  fx.connect(master);

  bed = c.createGain();
  bed.gain.value = 0;
  bed.connect(master);

  // The one-shots are a few kilobytes each; the music follows, and starts when it arrives.
  const names = new Set(Object.values(CLIPS).flatMap((clip) => clip.files));
  void Promise.all([...names].map(load)).then(() => load(MUSIC).then(startMusic));

  document.addEventListener("visibilitychange", () => {
    if (!ctx) return;
    if (document.hidden) void ctx.suspend();
    else if (enabled) void ctx.resume();
  });
  window.addEventListener("scroll", level, { passive: true });
  return c;
}

/** From the top of the track, intro and all, fading in as the bed comes up. */
function startMusic() {
  const buf = buffers.get(MUSIC);
  if (!ctx || !buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.loopStart = MUSIC_LOOP.start;
  src.loopEnd = Math.min(MUSIC_LOOP.end, buf.duration);
  src.connect(bed);
  src.start(0, 0);
  level();
}

/** Full over the hero, a little under half of that from a screen further down. */
function level() {
  if (!ctx || !bed) return;
  const hero = Math.max(0, 1 - window.scrollY / Math.max(1, window.innerHeight));
  const target = enabled ? MUSIC_GAIN * (MUSIC_BELOW + (1 - MUSIC_BELOW) * hero) : 0;
  bed.gain.setTargetAtTime(target, ctx.currentTime, 0.6);
}

/** Plays a clip now: a random take, a touch higher or lower each time, at its level, placed in the stereo field. */
function fire(name: Clip, pan = 0, rate = 1) {
  const c = ctx!;
  const clip = CLIPS[name];
  const buf = buffers.get(clip.files[Math.floor(Math.random() * clip.files.length)]);
  if (!buf) return null;
  const src = c.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate * (1 + (clip.vary ? (Math.random() * 2 - 1) * clip.vary : 0));
  const g = c.createGain();
  g.gain.value = clip.gain;
  const p = c.createStereoPanner();
  p.pan.value = pan;
  src.connect(g).connect(p).connect(fx);
  src.start();
  return { src, pan: p, buf };
}

/** How close together the same sound may play, in seconds. */
const GAP: Partial<Record<Clip, number>> = { tick: 0.05, type: 0.035, press: 0.05, whoosh: 1 };

function ready() {
  return enabled && !!ctx && ctx.state === "running";
}

function throttled(name: Clip) {
  const t = ctx!.currentTime;
  if (t - (last[name] ?? -10) < (GAP[name] ?? 0.02)) return true;
  last[name] = t;
  return false;
}

/* ------------------------------------------------------------------ */
/* On and off                                                          */
/* ------------------------------------------------------------------ */

/** `announce` plays the switch's own sound; the gesture that starts a default-on visit doesn't. */
function setEnabled(on: boolean, announce = true) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Private mode: it just won't be remembered.
  }
  notify();
  if (on) {
    const c = build();
    if (!c) return;
    void c.resume().then(() => {
      master.gain.cancelScheduledValues(c.currentTime);
      master.gain.setTargetAtTime(1, c.currentTime, 0.2);
      level();
      if (announce) fire("on");
    });
  } else if (ctx) {
    const c = ctx;
    if (announce && c.state === "running") fire("off");
    master.gain.cancelScheduledValues(c.currentTime);
    master.gain.setTargetAtTime(0, c.currentTime + 0.15, 0.12);
    setTimeout(() => {
      if (!enabled) void c.suspend();
    }, 900);
  }
}

export const sound = {
  get enabled() {
    return enabled;
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  toggle() {
    setEnabled(!enabled);
  },

  play(name: Sound) {
    if (!ready() || throttled(name)) return;
    fire(name, name === "send" ? -0.15 : name === "blip" ? 0.15 : 0);
  },

  /**
   * The comet: its whoosh, sped up or slowed a little to last as long as the
   * pass, and panned from the edge it comes in at to the one it leaves by.
   */
  whoosh(duration: number, from: number, to: number) {
    if (!ready() || throttled("whoosh")) return;
    const buf = buffers.get(CLIPS.whoosh.files[0]);
    if (!buf) return;
    const rate = Math.min(1.25, Math.max(0.8, buf.duration / Math.max(0.5, duration)));
    const shot = fire("whoosh", from, rate);
    if (!shot) return;
    const t = ctx!.currentTime;
    shot.pan.pan.setValueAtTime(from, t);
    shot.pan.pan.linearRampToValueAtTime(to, t + buf.duration / rate);
  },
};

/* ------------------------------------------------------------------ */
/* On every page: the remembered choice, the first gesture, the ticks  */
/* ------------------------------------------------------------------ */

const INTERACTIVE = 'a[href], button:not(:disabled), [role="tab"], [role="radio"], summary';
const GESTURES = ["pointerdown", "pointerup", "keydown", "touchend"] as const;

if (typeof window !== "undefined") {
  try {
    enabled = localStorage.getItem(KEY) !== "off";
  } catch {
    // No storage: on, as by default.
  }

  // On by default, but a browser only allows sound after a gesture: the
  // first click, tap or key anywhere starts it. A press on the switch itself
  // is left to the switch, which may be turning it off.
  const wake = (e: Event) => {
    if ((e.target as Element | null)?.closest?.("[data-sound-skip]")) return;
    if (enabled && !(ctx && ctx.state === "running")) setEnabled(true, false);
    if (ctx?.state === "running" || !enabled) GESTURES.forEach((g) => window.removeEventListener(g, wake, true));
  };
  GESTURES.forEach((g) => window.addEventListener(g, wake, true));

  let hovered: Element | null = null;
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const el = (e.target as Element | null)?.closest?.(INTERACTIVE) ?? null;
    if (el && el !== hovered && !el.closest("[data-sound-skip]")) sound.play("tick");
    hovered = el;
  });
  document.addEventListener("click", (e) => {
    const el = (e.target as Element | null)?.closest?.(INTERACTIVE);
    if (el && !el.closest("[data-sound-skip]")) sound.play("press");
  });
}

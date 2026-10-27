"use client";

import { useRef } from "react";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/gsap";
import { sound } from "@/lib/sound";

/*
 * The hero's landscape: night over a range of mountains, an eclipse rising
 * behind them with its rim on fire, an aurora, mist in the valleys and, now
 * and then, a falling star crossing the whole sky: Acestes' arrow, which
 * caught fire in flight (Aeneid V).
 *
 * Drawn by one fragment shader. Every range moves on its own with the
 * pointer and the scroll, which is the depth. It runs only while the hero is
 * on screen, renders once and holds still under reduced motion, and falls
 * back to the panel's gradient where there is no WebGL.
 */

/* ------------------------------------------------------------------ */
/* The range                                                           */
/* ------------------------------------------------------------------ */

type Layer = {
  /** Height of the range, in scene units (one unit is about the hero's height). */
  base: number;
  amp: number;
  freq: number;
  off: number;
  /** How much higher it climbs at the edges, so the range frames the middle. */
  valley: number;
  /** How far it slides with the pointer. Nearer ranges slide further. */
  par: number;
  /** How fast it moves with the scroll, against the panel. */
  scroll: number;
  /** How far below it starts, before it rises in. */
  rise: number;
  tint: [number, number, number];
  /** The hairline of light on its crest, and the backlit haze down its face. */
  edge: number;
  haze: number;
};

const LAYERS: Layer[] = [
  {
    base: 0.225,
    amp: 0.11,
    freq: 2.3,
    off: 0.6,
    valley: 0.05,
    par: 0.006,
    scroll: -0.07,
    rise: 0.12,
    tint: [0.064, 0.04, 0.13],
    edge: 1.0,
    haze: 0.5,
  },
  {
    base: 0.15,
    amp: 0.1,
    freq: 3.2,
    off: 2.9,
    valley: 0.1,
    par: 0.014,
    scroll: -0.03,
    rise: 0.16,
    tint: [0.032, 0.021, 0.068],
    edge: 0.6,
    haze: 0.32,
  },
  {
    base: 0.075,
    amp: 0.09,
    freq: 4.4,
    off: 5.2,
    valley: 0.16,
    par: 0.026,
    scroll: 0.02,
    rise: 0.2,
    tint: [0.018, 0.012, 0.038],
    edge: 0.36,
    haze: 0.14,
  },
  {
    base: -0.02,
    amp: 0.075,
    freq: 6.1,
    off: 1.9,
    valley: 0.27,
    par: 0.046,
    scroll: 0.08,
    rise: 0.26,
    tint: [0.004, 0.003, 0.009],
    edge: 0.2,
    haze: 0.04,
  },
];

/** The eclipse: a disc this wide whose top sits this high at rest. */
const PLANET = { r: 1.55, top: 0.37 };

/** Scene units in CSS px for a panel this wide. The hero's copy keeps clear of 0.38 of it. */
export const sceneUnit = (width: number) => Math.min(820, Math.max(500, width * 0.62));

/* ------------------------------------------------------------------ */
/* The shader                                                          */
/* ------------------------------------------------------------------ */

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const v3 = (c: number[]) => `vec3(${c.map(f).join(", ")})`;
const SWZ = "xyzw";

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;

uniform vec2 uRes;
uniform float uUnit;
uniform float uDpr;
uniform float uTime;
uniform vec2 uMouse;
uniform vec4 uLX;
uniform vec4 uLY;
uniform vec3 uPlanet;   // x, y offset, glow
uniform vec4 uFx;       // stars, aurora, mist, grain
uniform vec4 uMeteor;   // head x, head y, heading, strength
uniform float uTail;    // how long its tail has grown, in CSS px

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return v;
}

float peaks(float t) {
  return (1.0 - abs(sin(t))) * 0.55
       + (1.0 - abs(sin(t * 2.3 + 1.1))) * 0.28
       + (1.0 - abs(sin(t * 5.1 + 0.4))) * 0.12
       + sin(t * 11.7 + 2.0) * 0.03;
}

// One range over what is behind it: the crest lit from behind, a haze down
// its face where the eclipse shines through, anti-aliased to a device pixel.
vec3 range(vec3 col, float y, float h, vec3 tint, float edge, float haze, float light, float pxu) {
  float d = (h - y) * pxu;
  float cover = clamp(d * uDpr + 0.5, 0.0, 1.0);
  if (cover <= 0.0) return col;
  vec3 c = tint;
  c += vec3(0.62, 0.5, 1.0) * edge * light * exp(-max(d, 0.0) / 1.4);
  c += vec3(0.32, 0.19, 0.68) * haze * light * exp(-max(d, 0.0) / 55.0) * 0.5;
  return mix(col, c, cover);
}

vec3 mist(vec3 col, vec2 p, float at, float spread, float speed, float light, float t) {
  float m = fbm(vec2(p.x * 1.4 - t * speed, p.y * 9.0 + t * 0.01));
  float band = exp(-pow((p.y - at) / spread, 2.0));
  return col + vec3(0.5, 0.4, 0.82) * smoothstep(0.38, 0.92, m) * band * (0.35 + 0.65 * light) * 0.24 * uFx.z;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  float hw = uRes.x * 0.5 / uUnit;
  float top = uRes.y / uUnit;
  float pxu = uUnit / uDpr;
  vec2 p = vec2((frag.x - uRes.x * 0.5) / uUnit, frag.y / uUnit);
  vec2 css = frag / uDpr;
  float t = uTime;

  // The eclipse
  float R = ${f(PLANET.r)};
  vec2 pc = vec2(uPlanet.x, ${f(PLANET.top)} - R + uPlanet.y);
  vec2 dp = p - pc;
  float dist = length(dp) - R;
  vec2 n = dp / max(length(dp), 1e-4);
  float lit = pow(max(n.y, 0.0), 6.0);
  float glow = uPlanet.z;
  float outside = max(dist, 0.0);
  float light = exp(-abs(p.x - uPlanet.x) * 1.1) * glow;

  // Sky
  vec3 col = mix(vec3(0.04, 0.024, 0.08), vec3(0.008, 0.006, 0.018), smoothstep(0.1, top * 0.9, p.y));
  col += vec3(0.34, 0.15, 0.74) * exp(-outside * 2.8) * 0.4 * glow * (0.25 + 0.75 * lit);
  col += vec3(0.6, 0.42, 1.0) * exp(-outside * 8.0) * 0.5 * glow * lit;

  // Rays fanning up out of the rim
  float ang = atan(dp.x, dp.y);
  float rays = fbm(vec2(ang * 22.0, t * 0.04));
  col += vec3(0.55, 0.4, 1.0) * smoothstep(0.45, 0.85, rays) * exp(-outside * 1.6) * lit * glow * 0.16;

  // Stars: a dense field of small ones, and a few bright ones with a cross
  vec2 sp = css + uMouse * vec2(-4.0, 3.0);
  float st = 0.0;
  {
    vec2 c = floor(sp / 11.0);
    vec2 fr = sp - c * 11.0;
    float h = hash12(c);
    if (h > 0.8) {
      vec2 o = hash22(c) * 9.0 + 1.0;
      float d = length(fr - o);
      float s = 0.35 + 0.9 * pow(hash12(c + 7.7), 6.0);
      float tw = 0.55 + 0.45 * sin(t * (0.6 + 2.4 * hash12(c + 3.3)) + 6.2831 * h);
      st += smoothstep(s + 0.9, s - 0.3, d) * tw * (0.3 + 0.7 * hash12(c + 1.9));
    }
  }
  {
    vec2 c = floor(sp / 61.0);
    vec2 fr = sp - c * 61.0;
    float h = hash12(c + 19.0);
    if (h > 0.74) {
      vec2 o = hash22(c + 5.0) * 49.0 + 6.0;
      vec2 a = abs(fr - o);
      float d = length(fr - o);
      float tw = 0.6 + 0.4 * sin(t * (0.7 + 1.5 * h) + 12.0 * h);
      float core = smoothstep(1.7, 0.2, d);
      float flare = (exp(-a.x * 1.3) * exp(-a.y * 0.28) + exp(-a.y * 1.3) * exp(-a.x * 0.28)) * 0.3;
      st += (core + flare) * tw;
    }
  }
  col += vec3(0.88, 0.86, 1.0) * st * smoothstep(0.2, 0.6, p.y) * uFx.x;

  // Aurora: curtains hung from a wavering edge, brightest along it, rising to
  // the left and right of the headline rather than behind it
  float ab = top * 0.6 + 0.07 * sin(p.x * 1.7 + t * 0.07) + 0.14 * (fbm(vec2(p.x * 0.7 - t * 0.02, 3.0)) - 0.5) + 0.08 * p.x;
  float ady = p.y - ab;
  float curtain = ady > 0.0 ? exp(-ady * 3.6) : exp(ady * 26.0);
  float folds = fbm(vec2(p.x * 6.0 + 1.3 * fbm(vec2(p.x * 1.3, t * 0.045)), t * 0.06));
  folds = smoothstep(0.32, 0.86, folds);
  float aside = mix(0.3, 1.0, smoothstep(0.1, 0.85, abs(p.x) / hw));
  vec3 aCol = mix(vec3(0.42, 0.24, 0.95), vec3(0.86, 0.64, 1.0), clamp(ady * 2.4, 0.0, 1.0));
  col += aCol * curtain * folds * aside * 0.44 * uFx.y;

  // The disc hides what is behind it; its rim is a hairline of white fire
  if (dist < 0.0) {
    vec3 face = mix(vec3(0.016, 0.01, 0.032), vec3(0.075, 0.045, 0.15), exp(dist * 5.0) * lit);
    face += vec3(0.03, 0.02, 0.06) * (fbm(vec2(dp.x * 3.0, dp.y * 16.0)) - 0.5) * exp(dist * 3.0);
    col = face + vec3(0.8, 0.68, 1.0) * exp(dist * pxu / 3.0) * lit * glow * 0.7;
  }
  col += vec3(0.97, 0.94, 1.0) * exp(-abs(dist) * pxu / 1.3) * lit * glow * 1.25;
  col += vec3(0.74, 0.58, 1.0) * exp(-outside * pxu / 16.0) * lit * glow * 0.55;

  // A falling star, its tail growing out behind it as it goes
  if (uMeteor.w > 0.001) {
    vec2 dir = vec2(cos(uMeteor.z), sin(uMeteor.z));
    vec2 v = (p - uMeteor.xy) * pxu;
    float along = -dot(v, dir);
    float perp = dot(v, vec2(-dir.y, dir.x));
    float L = max(uTail, 1.0);
    float tail = 0.0;
    if (along > 0.0 && along < L) {
      float k = along / L;
      float w = 0.55 + 1.9 * k;
      tail = pow(1.0 - k, 2.2) * exp(-perp * perp / (w * w));
    }
    float r = length(v);
    float head = exp(-r / 1.8) + 0.3 * exp(-r / 10.0);
    vec3 mc = mix(vec3(1.0, 0.9, 0.78), vec3(0.6, 0.46, 1.0), clamp(along / L, 0.0, 1.0));
    col += (mc * tail * 0.95 + vec3(1.0, 0.97, 0.93) * head) * uMeteor.w;
  }

  // The range, far to near, with mist lying between
${LAYERS.map((l, i) => {
  const s = SWZ[i];
  return `  {
    float x = p.x - uLX.${s};
    float k = x / hw;
    float h = ${f(l.base)} + ${f(l.amp)} * peaks(x * ${f(l.freq)} + ${f(l.off)}) + ${f(l.valley)} * k * k + uLY.${s}
      + 0.005 * (noise(vec2(x * ${f(l.freq * 11)}, ${f(i + 0.5)})) - 0.5);
    col = range(col, p.y, h, ${v3(l.tint)}, ${f(l.edge)}, ${f(l.haze)}, light, pxu);
  }${i === 0 ? "\n  col = mist(col, p, 0.17 + uLY.y * 0.5, 0.055, 0.022, light, t);" : ""}${
    i === 2 ? "\n  col = mist(col, p, 0.07 + uLY.w * 0.5, 0.05, 0.035, light, t);" : ""
  }`;
}).join("\n")}

  // Darker toward the corners, and a fine grain so the gradients never band
  float side = abs(p.x) / hw;
  col *= 1.0 - 0.28 * smoothstep(0.55, 1.05, side) * smoothstep(0.0, 0.6, p.y / top);
  col += (hash12(css + fract(t * 7.13) * 91.0) - 0.5) * 0.028 * uFx.w;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

/** WebGL drawn on the CPU: SwiftShader, llvmpipe, Windows' basic render driver. */
function software(gl: WebGLRenderingContext) {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn("hero scene:", gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function HeroScene({ className = "" }: { className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      const c = canvas.current;
      if (!el || !c) return;
      const panel = el.parentElement ?? el;
      const reduced = prefersReducedMotion();

      const gl = c.getContext("webgl", { antialias: false, alpha: false, depth: false, stencil: false });
      if (!gl) return;
      const vs = compile(gl, gl.VERTEX_SHADER, VERT);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
      const prog = gl.createProgram();
      if (!vs || !fs || !prog) return;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
      gl.useProgram(prog);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      const u = Object.fromEntries(
        ["uRes", "uUnit", "uDpr", "uTime", "uMouse", "uLX", "uLY", "uPlanet", "uFx", "uMeteor", "uTail"].map((n) => [
          n,
          gl.getUniformLocation(prog, n),
        ]),
      ) as Record<string, WebGLUniformLocation | null>;

      /* Size --------------------------------------------------------- */
      let w = 0;
      let h = 0;
      let dpr = 1;
      let unit = 600;
      let hw = 1;
      let cap = Math.min(window.devicePixelRatio || 1, 1.5);

      const resize = () => {
        const r = c.getBoundingClientRect();
        w = Math.max(1, r.width);
        h = Math.max(1, r.height);
        dpr = cap;
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        gl.viewport(0, 0, c.width, c.height);
        unit = sceneUnit(w);
        hw = (w * 0.5) / unit;
      };

      /* State the intro and the pointer drive ------------------------ */
      // Per range, how far it has risen in: an object, since GSAP takes an array as a list of targets.
      const rise: Record<number, number> = Object.fromEntries(LAYERS.map((_, i) => [i, reduced ? 1 : 0]));
      const s = {
        planet: reduced ? 1 : 0,
        glow: reduced ? 1 : 0,
        stars: reduced ? 1 : 0,
        aurora: reduced ? 1 : 0,
        mist: reduced ? 1 : 0,
      };
      const pointer = { x: 0, y: 0 };
      const mouse = { x: 0, y: 0 };
      const meteor = { x: 0, y: 0, heading: 0, strength: 0, tail: 0 };
      let time = reduced ? 14 : 0;

      const lx = [0, 0, 0, 0];
      const ly = [0, 0, 0, 0];

      /* A frame ------------------------------------------------------ */
      const draw = () => {
        const rect = panel.getBoundingClientRect();
        const scroll = Math.max(0, -rect.top) / unit;
        LAYERS.forEach((l, i) => {
          lx[i] = -mouse.x * l.par;
          ly[i] = mouse.y * l.par * 0.4 - (1 - rise[i]) * l.rise + scroll * l.scroll;
        });
        gl.uniform2f(u.uRes, c.width, c.height);
        gl.uniform1f(u.uUnit, unit * dpr);
        gl.uniform1f(u.uDpr, dpr);
        gl.uniform1f(u.uTime, time);
        gl.uniform2f(u.uMouse, mouse.x, mouse.y);
        gl.uniform4f(u.uLX, lx[0], lx[1], lx[2], lx[3]);
        gl.uniform4f(u.uLY, ly[0], ly[1], ly[2], ly[3]);
        gl.uniform3f(u.uPlanet, -mouse.x * 0.004, -(1 - s.planet) * 0.32 - scroll * 0.12 + mouse.y * 0.002, s.glow);
        gl.uniform4f(u.uFx, s.stars, s.aurora, s.mist, 1);
        gl.uniform4f(u.uMeteor, meteor.x, meteor.y, meteor.heading, meteor.strength);
        gl.uniform1f(u.uTail, meteor.tail);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };

      resize();
      draw();

      const ro = new ResizeObserver(() => {
        resize();
        draw();
      });
      ro.observe(c);

      const lost = (e: Event) => {
        e.preventDefault();
        gsap.set(c, { autoAlpha: 0 });
      };
      c.addEventListener("webglcontextlost", lost);

      if (reduced) {
        return () => {
          ro.disconnect();
          c.removeEventListener("webglcontextlost", lost);
        };
      }

      /* Pointer: each range leans away from it, a beat behind -------- */
      const onMove = (e: PointerEvent) => {
        const r = panel.getBoundingClientRect();
        pointer.x = gsap.utils.clamp(-1, 1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2));
        pointer.y = gsap.utils.clamp(-1, 1, -(e.clientY - (r.top + r.height / 2)) / (r.height / 2));
      };
      window.addEventListener("pointermove", onMove, { passive: true });

      /* Frames -------------------------------------------------------- */
      // A machine that can't keep up draws at a lower resolution, a rung at a
      // time, and below the last rung holds the scene still. Software WebGL
      // (a VM, a remote desktop) starts at the bottom. The first frames, while
      // the page is still loading, don't count.
      const ladder = [cap, 1, 0.75, 0.5].filter((r, i, all) => r <= cap && all.indexOf(r) === i);
      let rung = software(gl) ? ladder.length - 1 : 0;
      if (rung) {
        cap = ladder[rung];
        resize();
      }
      let judging = true;
      let frames = 0;
      let slow = 0;
      let still = false;
      const tick = (_: number, delta: number) => {
        const dt = Math.min(delta, 50) / 1000;
        time += dt;
        const drift = Math.sin(time * 0.13) * 0.18;
        mouse.x += (pointer.x + drift - mouse.x) * Math.min(1, dt * 2.6);
        mouse.y += (pointer.y - mouse.y) * Math.min(1, dt * 2.6);
        draw();
        if (!judging || ++frames < 15) return;
        if (delta > 30) slow++;
        if (frames < 75) return;
        if (slow < 30) {
          judging = false;
        } else if (++rung < ladder.length) {
          cap = ladder[rung];
          resize();
        } else {
          still = true;
          run(false);
          stars.kill();
          tl.progress(1, true);
          draw();
        }
        frames = 0;
        slow = 0;
      };

      /* The intro ---------------------------------------------------- */
      const tl = gsap.timeline({ delay: 0.15 });
      tl.to(s, { planet: 1, duration: 2.8, ease: "expo.out" }, 0)
        .to(s, { glow: 1, duration: 2.4, ease: "power2.inOut" }, 0.15)
        .to(s, { stars: 1, duration: 2.6, ease: "power1.out" }, 0.4)
        .to(s, { aurora: 1, duration: 3.2, ease: "sine.inOut" }, 0.9)
        .to(s, { mist: 1, duration: 2.4, ease: "sine.inOut" }, 1.1);
      LAYERS.forEach((_, i) => {
        tl.to(rise, { [i]: 1, duration: 2.1, ease: "expo.out" }, 0.1 + i * 0.13);
      });

      // Falling stars, now and then, the first as the scene settles. Each
      // crosses the whole sky at a meteor's even speed, from just past one
      // edge until its tail has cleared the other, shallow enough to stay
      // above the copy, and only fades once it is out.
      const TAIL = 280;
      const shoot = (first = false) => {
        const top = h / unit;
        const ltr = first || Math.random() < 0.6;
        const slope = first ? 0.06 : gsap.utils.random(0.03, 0.08);
        const heading = ltr ? -slope : Math.PI + slope;
        const margin = 0.06;
        const tail = TAIL / unit;
        const sx = (ltr ? -1 : 1) * (hw + margin);
        const sy = first ? top * 0.975 : gsap.utils.random(top * 0.95, top * 0.985);
        const dist = (2 * (hw + margin) + tail) / Math.cos(slope);
        const speed = first ? 1.35 : gsap.utils.random(1.4, 1.9);
        const duration = dist / speed;
        gsap.killTweensOf(meteor);
        sound.whoosh(duration, ltr ? -0.85 : 0.85, ltr ? 0.85 : -0.85);
        gsap
          .timeline()
          .set(meteor, { x: sx, y: sy, heading, strength: 0, tail: 0 })
          .to(meteor, { x: sx + Math.cos(heading) * dist, y: sy + Math.sin(heading) * dist, duration, ease: "none" }, 0)
          .to(meteor, { tail: TAIL, duration: tail / speed, ease: "none" }, 0)
          .to(meteor, { strength: first ? 1 : gsap.utils.random(0.7, 0.95), duration: 0.15, ease: "power2.out" }, 0)
          .to(meteor, { strength: 0, duration: 0.25, ease: "power1.in" }, duration - 0.25);
      };
      tl.call(() => shoot(true), [], 2.3);
      // Only over a hero someone can see (and hear).
      let stars = gsap.delayedCall(10, function fall() {
        if (running) shoot();
        stars = gsap.delayedCall(gsap.utils.random(7, 13), fall);
      });

      /* Only while the hero is on screen ----------------------------- */
      let running = false;
      function run(on: boolean) {
        if (still) on = false;
        if (on === running) return;
        running = on;
        if (on) gsap.ticker.add(tick);
        else gsap.ticker.remove(tick);
      }
      const st = ScrollTrigger.create({
        trigger: panel,
        start: "top bottom",
        end: "bottom top",
        onToggle: (self) => run(self.isActive),
      });
      run(st.isActive);

      return () => {
        run(false);
        st.kill();
        tl.kill();
        stars.kill();
        gsap.killTweensOf(meteor);
        ro.disconnect();
        window.removeEventListener("pointermove", onMove);
        c.removeEventListener("webglcontextlost", lost);
      };
    },
    { scope: root },
  );

  return (
    <div ref={root} aria-hidden="true" className={`pointer-events-none ${className}`}>
      <canvas ref={canvas} className="absolute inset-0 block size-full" />
    </div>
  );
}

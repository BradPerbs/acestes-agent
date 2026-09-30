/**
 * The helmet, drawn live in WebGL2 as ink line art, from any angle, cheaply
 * enough to turn with the pointer.
 *
 * One context serves every mark on screen: it draws into a canvas of its own
 * and each mark copies its picture out into a 2D canvas. A context per mark
 * would run into the browser's limit on live contexts.
 *
 * Two passes:
 *
 * 1. Into a texture: the shell, as the direction each face points and
 *    whether it is metal or the inside, with its depth; then the creases (the
 *    edges where the surface folds sharply: rims, bands, the crest's corners,
 *    worked out once when the mesh was packed) and the crest's strands, as
 *    thin quads marked as ink, kept where the shell does not stand in front.
 * 2. The ink, read off the texture: the marked lines, the outline wherever
 *    the helmet meets nothing, a line wherever one part passes in front of
 *    another (a jump in depth), the inside seen through the face filled in,
 *    and the metal left as paper or as nothing.
 *
 * Both run at twice the size of the mark and the copy out scales them down,
 * which is the anti-aliasing.
 *
 * Small marks are drawn as a glyph instead: the silhouette solid, with the
 * face openings cut out of it and a hair of space where the helmet passes in
 * front of its crest. Lines at that size are only a grey smudge.
 *
 * Each helmet's mesh (`meshes/`, made by `scripts/helmets`) is loaded the
 * first time a mark wears it, in a chunk of its own: at a few hundred
 * kilobytes each they have no business in the bundle every window starts
 * with, and most people only ever see one or two of them.
 */

const INSIDE = 1, CREST = 2, PATCH = 4;

/** The helmets, by the id an agent's look stores (see `lib/agent-look.js`). */
const MESHES = {
    corinthian: () => import('./meshes/corinthian.js'),
    trojan: () => import('./meshes/trojan.js'),
    attic: () => import('./meshes/attic.js'),
    galea: () => import('./meshes/galea.js'),
    viking: () => import('./meshes/viking.js'),
    greathelm: () => import('./meshes/greathelm.js'),
    barbute: () => import('./meshes/barbute.js'),
    morion: () => import('./meshes/morion.js'),
    kabuto: () => import('./meshes/kabuto.js'),
};
const FIRST = 'corinthian';

/** The pose a mark rests in: the face turned a little under half way, looked on from a little above. */
export const REST = { yaw: 48, pitch: 14 };

/**
 * A crest fitted to a helmet (`crests` in its mesh file) is packed at half
 * its size: in the helmet's frame it can stand taller than the helmet, and
 * the packing only holds -1 to 1.
 */
const PIECE_SCALE = 2;

function decode(base64, scale = 1) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    let o = 0;
    const u32 = () => { const v = view.getUint32(o, true); o += 4; return v; };
    u32(); // magic
    const nV = u32(), nF = u32(), nMend = u32(), nCP = u32(), nCB = u32(), nS = u32(), nSP = u32();
    const pad4 = (n) => Math.ceil(n / 4) * 4;
    const positions = new Float32Array(nV * 3);
    for (let i = 0; i < nV * 3; i++) { positions[i] = (view.getInt16(o, true) / 32767) * scale; o += 2; }
    const faces = new Uint16Array(nF * 3);
    for (let i = 0; i < nF * 3; i++) { faces[i] = view.getUint16(o, true); o += 2; }
    const flags = bytes.slice(o, o + nF);
    o += pad4(nF);
    const mended = new Map();
    for (let i = 0; i < nMend; i++) {
        mended.set(view.getUint32(o, true), [view.getInt8(o + 4) / 127, view.getInt8(o + 5) / 127, view.getInt8(o + 6) / 127]);
        o += 8;
    }
    const creases = new Uint16Array(bytes.buffer.slice(o, o + (nCP + nCB) * 4));
    o += (nCP + nCB) * 4;
    const counts = [];
    for (let i = 0; i < nS; i++) counts.push(view.getUint16(o + i * 2, true));
    o += pad4(nS * 2);
    const strandPts = new Float32Array(nSP * 3);
    for (let i = 0; i < nSP * 3; i++) { strandPts[i] = (view.getInt16(o, true) / 32767) * scale; o += 2; }
    return { nV, nF, positions, faces, flags, mended, creases, nCP, nCB, counts, strandPts };
}

const SHELL_VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in float aKind;
uniform mat4 uMVP;
uniform mat3 uRot;
out vec3 vNormal;
flat out int vKind;
void main() {
    vNormal = uRot * aNormal;
    vKind = int(aKind + 0.5);
    gl_Position = uMVP * vec4(aPos, 1.0);
}`;

// Alpha is the kind of pixel: 0 nothing, 0.25 the helmet's metal, 0.4 the
// crest, 0.6 a line, 1 the inside. The ink pass reads the kinds back.
const SHELL_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
flat in int vKind;
out vec4 color;
void main() {
    float kind = vKind == 1 ? 1.0 : (vKind == 2 ? 0.4 : 0.25);
    color = vec4(normalize(vNormal) * 0.5 + 0.5, kind);
}`;

const SEG_VS = `#version 300 es
in vec2 aCorner;
in vec3 aA;
in vec3 aB;
uniform mat4 uMVP;
uniform vec2 uHalf;
uniform float uWidth;
uniform float uBias;
void main() {
    vec4 ca = uMVP * vec4(aA, 1.0);
    vec4 cb = uMVP * vec4(aB, 1.0);
    vec2 sa = ca.xy * uHalf, sb = cb.xy * uHalf;
    vec2 d = sb - sa;
    float len = length(d);
    vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float w = uWidth * 0.5;
    vec2 p = mix(sa, sb, aCorner.x) + nrm * aCorner.y * w + dir * (aCorner.x * 2.0 - 1.0) * w;
    gl_Position = vec4(p / uHalf, mix(ca.z, cb.z, aCorner.x) - uBias, 1.0);
}`;

const SEG_FS = `#version 300 es
precision highp float;
out vec4 color;
void main() { color = vec4(0.5, 0.5, 1.0, 0.6); }`;

const QUAD_VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const INK_FS = `#version 300 es
precision highp float;
uniform sampler2D uG;
uniform sampler2D uDepth;
uniform vec2 uTexel;
uniform vec2 uOrigin;
uniform float uLine;      // half width of an inner line, in texels
uniform float uOutline;   // half width of the outline
uniform float uJump;      // how far depth may bend over uLine before it is a step
uniform float uGlyph;     // 1 for the solid small mark
uniform vec4 uInk;
uniform vec4 uPaper;
out vec4 color;

bool isCrest(float a) { return abs(a - 0.4) < 0.07; }
bool isMark(float a) { return abs(a - 0.6) < 0.1; }

void main() {
    vec2 uv = (gl_FragCoord.xy - uOrigin) * uTexel;
    vec4 g0 = texture(uG, uv);
    float d0 = texture(uDepth, uv).r;
    bool fg = g0.a > 0.05;
    bool mark = isMark(g0.a);
    bool inside = g0.a > 0.9;
    bool crest = isCrest(g0.a);

    bool outline = false, jump = false, rim = false, meet = false;
    for (int i = 0; i < 12; i++) {
        float a = float(i) * 0.5235988;
        vec2 dir = vec2(cos(a), sin(a));
        // the outline: the helmet against nothing, sampled at its own width
        bool fgO = texture(uG, uv + dir * uOutline * uTexel).a > 0.05;
        if (fgO != fg) outline = true;
        if (i >= 6) continue;
        vec2 o = dir * uLine * uTexel;
        vec4 ga = texture(uG, uv + o), gb = texture(uG, uv - o);
        if (!fg || ga.a < 0.05 || gb.a < 0.05) continue;
        // where the crest meets the helmet, whichever is in front
        if (!mark && ((!isMark(ga.a) && isCrest(ga.a) != crest) || (!isMark(gb.a) && isCrest(gb.a) != crest))) meet = true;
        // one part passing in front of another: depth that does not run on smoothly
        float da = texture(uDepth, uv + o).r, db = texture(uDepth, uv - o).r;
        if (abs(da + db - 2.0 * d0) > uJump) jump = true;
        // the edge of the dark inside
        if ((ga.a > 0.9) != inside || (gb.a > 0.9) != inside) rim = true;
    }

    if (uGlyph > 0.5) {
        // solid, but for the inside and a hair of space where the crest meets the helmet
        color = (fg && !inside && !meet) ? uInk : vec4(0.0);
        return;
    }
    bool line = mark || outline || jump || rim || meet;
    vec4 base = fg ? (inside ? uInk : uPaper) : vec4(0.0);
    color = line ? uInk : base;
}`;

function compile(gl, vs, fs) {
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    return prog;
}

const uniforms = (gl, prog, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(prog, n)]));

/** A buffer of line segments as instanced quads: two points per segment. */
function segmentVao(gl, prog, corner, data) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, corner);
    const aCorner = gl.getAttribLocation(prog, 'aCorner');
    gl.enableVertexAttribArray(aCorner);
    gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    for (const [name, off] of [['aA', 0], ['aB', 12]]) {
        const loc = gl.getAttribLocation(prog, name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 24, off);
        gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    return { vao, count: data.length / 6 };
}

/** The context every mark shares, and what it draws with; null where there is no WebGL2. */
function context() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: false });
    if (!gl) return null;

    const shellProg = compile(gl, SHELL_VS, SHELL_FS);
    const segProg = compile(gl, SEG_VS, SEG_FS);
    const inkProg = compile(gl, QUAD_VS, INK_FS);

    const corner = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);

    const quad = gl.createVertexArray();
    gl.bindVertexArray(quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aQuad = gl.getAttribLocation(inkProg, 'aPos');
    gl.enableVertexAttribArray(aQuad);
    gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);

    return {
        canvas, gl, shellProg, segProg, inkProg, corner, quad, target: null,
        helmets: {},
        frames: new Map(),
        u: {
            shell: uniforms(gl, shellProg, ['uMVP', 'uRot']),
            seg: uniforms(gl, segProg, ['uMVP', 'uHalf', 'uWidth', 'uBias']),
            ink: uniforms(gl, inkProg, ['uG', 'uDepth', 'uTexel', 'uOrigin', 'uLine', 'uOutline', 'uJump', 'uGlyph', 'uInk', 'uPaper']),
        },
    };
}

/**
 * The shell and lines of the faces of `mesh` that `keep` keeps, in the shared
 * context: one part of what a mark draws, a helmet or a crest standing on it.
 */
function part(s, mesh, keep, creasePairs, withStrands) {
    const { gl, shellProg, segProg, corner } = s;
    const { positions: P, faces: F, flags, nF } = mesh;

    const segments = (pairs) => {
        const out = new Float32Array(pairs.length * 3);
        for (let i = 0; i < pairs.length; i++) {
            const v = pairs[i] * 3;
            out[i * 3] = P[v]; out[i * 3 + 1] = P[v + 1]; out[i * 3 + 2] = P[v + 2];
        }
        return out;
    };

    const list = [];
    for (let f = 0; f < nF; f++) if (keep(flags[f])) list.push(f);
    const data = new Float32Array(list.length * 3 * 7);
    let o = 0;
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const f of list) {
        const a = F[f * 3] * 3, b = F[f * 3 + 1] * 3, c = F[f * 3 + 2] * 3;
        let n = mesh.mended.get(f);
        if (!n) {
            const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
            const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const l = Math.hypot(nx, ny, nz) || 1;
            n = [nx / l, ny / l, nz / l];
        }
        const kind = flags[f] & INSIDE ? 1 : (flags[f] & CREST ? 2 : 0);
        for (const v of [a, b, c]) {
            data[o++] = P[v]; data[o++] = P[v + 1]; data[o++] = P[v + 2];
            data[o++] = n[0]; data[o++] = n[1]; data[o++] = n[2];
            data[o++] = kind;
            for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], P[v + k]); max[k] = Math.max(max[k], P[v + k]); }
        }
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    for (const [name, size, off] of [['aPos', 3, 0], ['aNormal', 3, 12], ['aKind', 1, 24]]) {
        const loc = gl.getAttribLocation(shellProg, name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 28, off);
    }
    gl.bindVertexArray(null);

    // The strands are packed so that any first few are spread evenly
    // along the crest, and `ends` says where each one's segments stop,
    // so a smaller mark can draw fewer of them and still cover it.
    const strands = [];
    const ends = [0];
    if (withStrands) {
        let p = 0;
        for (const n of mesh.counts) {
            for (let k = 0; k < n - 1; k++) {
                const s = mesh.strandPts;
                const a = (p + k) * 3, b = (p + k + 1) * 3;
                strands.push(s[a], s[a + 1], s[a + 2], s[b], s[b + 1], s[b + 2]);
            }
            ends.push(strands.length / 6);
            p += n;
        }
    }
    // points to fit the frame to: every tenth vertex is plenty
    const fitPoints = [];
    for (let i = 0; i < data.length; i += 7 * 10) fitPoints.push([data[i], data[i + 1], data[i + 2]]);
    return {
        shell: { vao, count: list.length * 3 },
        creases: segmentVao(gl, segProg, corner, segments(creasePairs)),
        strands: { ...segmentVao(gl, segProg, corner, new Float32Array(strands)), ends },
        fitPoints,
    };
}

/**
 * One helmet's shell and lines, for each crest it can wear, in the shared
 * context: its own crest (the Corinthian's and the Trojan's plume), none,
 * and each of `crests`, the other crests fitted to it, which stand on the
 * helmet without its own.
 */
function helmetFrom(s, meshBase64, crests = {}) {
    const mesh = decode(meshBase64);
    const own = part(s, mesh, fl => !(fl & PATCH), mesh.creases.subarray(0, mesh.nCP * 2), true);
    // A helmet with no crest to take off draws the same either way.
    const bare = mesh.flags.some(fl => fl & CREST)
        ? part(s, mesh, fl => !(fl & CREST), mesh.creases.subarray(mesh.nCP * 2), false)
        : own;
    const kinds = { plume: drawn([own]), none: drawn([bare]) };
    for (const [crest, pieceBase64] of Object.entries(crests)) {
        const piece = decode(pieceBase64, PIECE_SCALE);
        kinds[crest] = drawn([bare, part(s, piece, () => true, piece.creases.subarray(0, piece.nCP * 2), true)]);
    }
    return kinds;
}

/** What a mark draws for one crest: its parts, and the points its frame is fitted to. */
const drawn = parts => ({ parts, fitPoints: parts.flatMap(p => p.fitPoints) });

function ensureTarget(s, size) {
    const { gl } = s;
    if (s.target && s.target.size >= size) return s.target;
    if (s.target) { gl.deleteTexture(s.target.color); gl.deleteTexture(s.target.depth); gl.deleteFramebuffer(s.target.fb); }
    const dim = Math.max(256, Math.ceil(size / 64) * 64);
    const tex = (format) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texStorage2D(gl.TEXTURE_2D, 1, format, dim, dim);
        for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
        for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
        return t;
    };
    const color = tex(gl.RGBA8), depth = tex(gl.DEPTH_COMPONENT24);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    s.target = { color, depth, fb, size: dim };
    if (s.canvas.width < dim) s.canvas.width = s.canvas.height = dim;
    return s.target;
}

/** The rotation that turns the face `yaw` degrees to the side and tilts it `pitch` degrees towards the viewer. */
function rotation(yaw, pitch) {
    const a = (yaw * Math.PI) / 180, b = (pitch * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    // rows: screen x, screen y, towards the viewer
    return [ca, 0, sa, sa * sb, cb, -ca * sb, -sa * cb, sb, ca * cb];
}

/**
 * The square the helmet is framed in: centred on it and just big enough for
 * every angle in `angles`, so a mark that turns never runs off its canvas.
 */
function frame(variant, angles) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [yaw, pitch] of angles) {
        const R = rotation(yaw, pitch);
        for (const [x, y, z] of variant.fitPoints) {
            const sx = R[0] * x + R[1] * y + R[2] * z, sy = R[3] * x + R[4] * y + R[5] * z;
            minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
        }
    }
    const half = Math.max(maxX - minX, maxY - minY) / 2 * 1.04;
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, half, scale: 1 / half };
}

/** One helmet in one crest, or null while its mesh loads or where nothing can be drawn. */
function variantOf(s, helmet, crest) {
    const kinds = s && s.helmets[helmet];
    return kinds ? kinds[crest] || kinds.plume : null;
}

/** The frame for one helmet, crest and set of angles, worked out once. */
function frameFor(s, helmet, crest, angles) {
    const key = `${helmet}|${crest}|${JSON.stringify(angles)}`;
    let found = s.frames.get(key);
    if (!found) {
        found = frame(variantOf(s, helmet, crest), angles);
        s.frames.set(key, found);
    }
    return found;
}

/**
 * How a mark that turns through `range` has to be placed so that at rest it
 * lies exactly where a still one would: its canvas `grow` times the size of
 * the mark, and moved by `dx`, `dy` (as shares of the mark's size), since
 * the frame that holds every angle is bigger than the one that holds the
 * resting pose, and not centred on the same point.
 */
export function framing(helmet, crest, range) {
    if (!variantOf(shared, helmet, crest)) return { grow: 1, dx: 0, dy: 0 };
    const rest = frameFor(shared, helmet, crest, [[REST.yaw, REST.pitch]]);
    const all = frameFor(shared, helmet, crest, range);
    return {
        grow: all.half / rest.half,
        dx: (all.cx - rest.cx) / (2 * rest.half),
        dy: (rest.cy - all.cy) / (2 * rest.half),
    };
}

/**
 * A colour as premultiplied [r, g, b, a], from '#rrggbb' or the 'rgb()' and
 * 'rgba()' a computed style hands back; nothing for null.
 */
function toRgba(colour) {
    if (!colour) return [0, 0, 0, 0];
    if (colour[0] === '#') {
        const v = parseInt(colour.slice(1, 7), 16);
        return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1];
    }
    const [r = 0, g = 0, b = 0, a = 1] = (colour.match(/[\d.]+/g) || []).map(Number);
    return [(r / 255) * a, (g / 255) * a, (b / 255) * a, a];
}

// The context: undefined until the first helmet loads, null where there is no WebGL2.
let shared;
const loading = new Map();

/**
 * Load one helmet's mesh, once, setting up the context with the first.
 * Resolves to whether it can be drawn: false where there is no WebGL2 to
 * draw it with. An id it does not know loads the Corinthian.
 */
export function whenHelmetReady(helmet = FIRST) {
    const id = MESHES[helmet] ? helmet : FIRST;
    if (!loading.has(id)) {
        loading.set(id, MESHES[id]()
            .then(({ default: mesh, crests }) => {
                if (shared === undefined) shared = context();
                if (!shared) return false;
                shared.helmets[id] = helmetFrom(shared, mesh, crests);
                return true;
            })
            .catch((error) => {
                console.warn(`The ${id} helmet could not be drawn:`, error);
                if (shared === undefined) shared = null;
                return false;
            }));
    }
    return loading.get(id);
}

/**
 * Draw a helmet into `out`, a 2D canvas, filling it.
 *
 * - `helmet`: which one (see `MESHES`), loaded first with `whenHelmetReady`.
 * - `crest`: which crest it wears, or 'none' (see `lib/agent-look.js`); one
 *   it was not given draws as its own.
 * - `yaw`, `pitch`: in degrees, how far the face is turned to the side and
 *   how far down the viewer looks on it.
 * - `range`: the angles the frame must hold, as [[yaw, pitch], ...]; by
 *   default just the one drawn.
 * - `line`, `paper`: the ink, and the fill of the metal or null for none, as
 *   '#rrggbb' or 'rgb(...)'.
 * - `canvasSize`: the canvas's size in CSS pixels, where it is not `size`:
 *   a mark that turns is drawn on a canvas bigger than itself (see `framing`).
 * - `size`: the mark's size in CSS pixels, which sets the line weights and
 *   whether it is drawn as lines or as a glyph.
 */
export function drawHelmet(out, { helmet = FIRST, crest = 'plume', yaw = REST.yaw, pitch = REST.pitch, range = null, line = '#111111', paper = null, size = 64, canvasSize = size } = {}) {
    const variant = variantOf(shared, helmet, crest);
    if (!variant) return false;
    const s = shared;
    const { gl } = s;
    const px = out.width * 2; // drawn at twice the size of the canvas, copied down
    const t = ensureTarget(s, px);
    const scalePx = px / canvasSize; // internal pixels per CSS pixel

    const fr = frameFor(s, helmet, crest, range || [[yaw, pitch]]);

    const R = rotation(yaw, pitch);
    const k = fr.scale;
    // column-major; x and y are framed, depth is towards the viewer and flipped for GL
    const mvp = new Float32Array([
        R[0] * k, R[3] * k, -R[6] * 0.4, 0,
        R[1] * k, R[4] * k, -R[7] * 0.4, 0,
        R[2] * k, R[5] * k, -R[8] * 0.4, 0,
        -fr.cx * k, -fr.cy * k, 0, 1,
    ]);
    const rot = new Float32Array([R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]);

    const glyph = size < 26;
    // line weights in CSS pixels
    const outlineW = Math.max(1.15, Math.min(3.2, size * 0.021));
    const lineW = Math.max(0.75, outlineW * 0.5);
    const strandW = Math.max(0.6, outlineW * 0.36);

    // pass 1
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.viewport(0, 0, px, px);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.useProgram(s.shellProg);
    gl.uniformMatrix4fv(s.u.shell.uMVP, false, mvp);
    gl.uniformMatrix3fv(s.u.shell.uRot, false, rot);
    for (const { shell } of variant.parts) {
        gl.bindVertexArray(shell.vao);
        gl.drawArrays(gl.TRIANGLES, 0, shell.count);
    }
    if (!glyph) {
        gl.depthMask(false);
        gl.useProgram(s.segProg);
        gl.uniformMatrix4fv(s.u.seg.uMVP, false, mvp);
        gl.uniform2f(s.u.seg.uHalf, px / 2, px / 2);
        gl.uniform1f(s.u.seg.uBias, 0.006);
        // all the strands on a big mark; fewer as it shrinks, or they close up into grey
        const share = Math.max(0.2, Math.min(1, (size - 30) / 190));
        for (const { creases, strands } of variant.parts) {
            gl.uniform1f(s.u.seg.uWidth, lineW * scalePx);
            gl.bindVertexArray(creases.vao);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, creases.count);
            const shown = strands.ends[Math.round((strands.ends.length - 1) * share)];
            if (size >= 44 && shown) {
                gl.uniform1f(s.u.seg.uWidth, strandW * scalePx);
                gl.bindVertexArray(strands.vao);
                gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, shown);
            }
        }
        gl.depthMask(true);
    }

    // pass 2
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const H = s.canvas.height;
    gl.enable(gl.SCISSOR_TEST);
    gl.viewport(0, H - px, px, px);
    gl.scissor(0, H - px, px, px);
    gl.disable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(s.inkProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.color);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, t.depth);
    gl.uniform1i(s.u.ink.uG, 0);
    gl.uniform1i(s.u.ink.uDepth, 1);
    gl.uniform2f(s.u.ink.uTexel, 1 / t.size, 1 / t.size);
    gl.uniform2f(s.u.ink.uOrigin, 0, H - px);
    const lineTexels = glyph ? 1.0 * scalePx : (lineW * scalePx) / 2;
    gl.uniform1f(s.u.ink.uLine, lineTexels);
    // A smooth surface bends its depth by about its curvature times the step
    // squared, and the step, in the model's units, grows as the mark shrinks;
    // anything well past that is one part standing in front of another.
    // Depth is stored at 0.2 of the model's units (see the matrix above).
    const step = (lineTexels * 2) / (px * k);
    gl.uniform1f(s.u.ink.uJump, 0.2 * Math.max(0.03, 2.5 * step * step));
    gl.uniform1f(s.u.ink.uOutline, (outlineW * scalePx) / 2);
    gl.uniform1f(s.u.ink.uGlyph, glyph ? 1 : 0);
    gl.uniform4fv(s.u.ink.uInk, toRgba(line));
    gl.uniform4fv(s.u.ink.uPaper, toRgba(paper));
    gl.bindVertexArray(s.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);

    const ctx = out.getContext('2d');
    ctx.clearRect(0, 0, out.width, out.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s.canvas, 0, 0, px, px, 0, 0, out.width, out.height);
    return true;
}

const masks = new Map();
let scratch = null;

/**
 * The helmet as a mask image: white where there is ink, or, for the `paper`
 * layer, wherever there is helmet at all. A static mark is these two stacked
 * and coloured by CSS, so its colour follows the theme and the text around it
 * without being drawn again, and every mark of one size shares one picture.
 *
 * `pixels` is the size in device pixels, `size` in CSS pixels (which sets
 * the line weights). Null until the helmet is ready, or where it cannot be
 * drawn.
 */
export function helmetMask({ helmet = FIRST, crest = 'plume', size, pixels, layer = 'ink' }) {
    if (!variantOf(shared, helmet, crest)) return null;
    const key = `${helmet}|${crest}|${size}|${pixels}|${layer}`;
    let url = masks.get(key);
    if (!url) {
        if (!scratch) scratch = document.createElement('canvas');
        scratch.width = scratch.height = pixels;
        drawHelmet(scratch, { helmet, crest, size, line: '#ffffff', paper: layer === 'paper' ? '#ffffff' : null });
        url = scratch.toDataURL('image/png');
        masks.set(key, url);
    }
    return url;
}

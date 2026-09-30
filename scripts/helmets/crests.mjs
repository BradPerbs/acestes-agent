/**
 * The crests a helmet can wear besides its own, each fitted to the helmet.
 *
 * Two are the Corinthian's crest (`source.mjs`), horsehair standing on a rail
 * over the bowl, lifted off it with its strands and laid on another helmet:
 *
 * - `plume`: front to back, as the Corinthian wears it, bent to the other
 *   helmet's bowl so it stands as high above it all the way along.
 * - `transverse`: the same turned across the head from ear to ear, the way
 *   a centurion wore his.
 *
 * The rest are models of their own (`CREST_SOURCES`):
 *
 * - `horns`: a horn on either side of the bowl, rising outwards and curling up.
 * - `crown`: a king's crown, stretched round the top of the bowl to fit it.
 * - `feathers`: three feathers fanned up from the back of the bowl.
 *
 * Every fit is worked out from where the head would be, the middle of the
 * helmet: how far out its surface is in each direction round that point
 * (`profile`), and where along a direction it is last (`caster`). A crest is
 * then placed by those distances rather than by numbers for each helmet, so
 * the same crest sits right on a tall great helm and a flat morion.
 *
 * A crest is kept as a separate piece and packed on its own (`packPiece`),
 * in the helmet's frame: the renderer draws it on the helmet without its own
 * crest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { unzip, readSTL, weld } from './source.mjs';
import { fetchModel, readGLB } from './gltf.mjs';
import { simplify } from './model.mjs';
import { faceNormals, crestFaces, crestPatches, strands } from './parts.mjs';

export const CREST_SOURCES = {
    horns: {
        title: 'Viking Helmet Horns - Cracked Horn',
        author: 'pittance',
        url: 'https://www.thingiverse.com/thing:1374884',
        licence: 'CC BY 3.0',
        licenceUrl: 'https://creativecommons.org/licenses/by/3.0/',
        archive: 'https://archive.org/download/thingiverse-1374884/Viking_Helmet_Horns_-_Cracked_Horn_1374884.zip',
        file: 'files/HORN.STL',
    },
    crown: {
        title: 'Royal Crown',
        author: 'gizacorp01',
        url: 'https://sketchfab.com/3d-models/royal-crown-36edb23a404349709c9da94f136351e9',
        licence: 'CC BY 4.0',
        licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
        record: 10266101,
        file: '36edb23a404349709c9da94f136351e9.glb',
    },
    feathers: {
        title: 'Golden Plume/ Feather',
        author: 'syngineer',
        url: 'https://www.thingiverse.com/thing:4209542',
        licence: 'CC BY 4.0',
        licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
        archive: 'https://archive.org/download/thingiverse-4209542/_Feather_4209542.zip',
        file: 'files/feather.stl',
    },
};

/** Every crest there is besides none, in the order they are offered. */
export const CREST_IDS = ['plume', 'transverse', 'horns', 'crown', 'feathers'];

const DEG = Math.PI / 180;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/* ---- Getting the models ---------------------------------------------------- */

/** A file out of a Thingiverse upload kept by the Internet Archive, cached. */
async function fetchArchived(source, cacheDir) {
    const cached = path.join(cacheDir, `${path.basename(source.archive, '.zip')}-${path.basename(source.file)}`);
    if (fs.existsSync(cached)) return fs.readFileSync(cached);
    const response = await fetch(source.archive);
    if (!response.ok) throw new Error(`Could not download ${source.title}: ${response.status} ${response.statusText}`);
    const file = unzip(Buffer.from(await response.arrayBuffer()), source.file);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cached, file);
    return file;
}

/** A crest model as one welded mesh, simplified to about `faces`. */
async function loadSource(source, cacheDir, faces) {
    const triangles = source.record
        ? readGLB(await fetchModel(source, cacheDir)).flat()
        // printed models stand on their Z axis
        : readSTL(await fetchArchived(source, cacheDir)).map(t => t.map(([x, y, z]) => [x, z, -y]));
    let lo = Infinity, hi = -Infinity;
    for (const t of triangles) for (const p of t) for (const c of p) { lo = Math.min(lo, c); hi = Math.max(hi, c); }
    return simplify(weld(triangles, (hi - lo) * 1e-3), faces);
}

/* ---- Looking at a helmet from the head ------------------------------------- */

/**
 * The faces of a mesh as something to cast rays at: how far along the ray
 * from `o` in direction `d` the surface is last, or null where it misses.
 * The last, so a ray from inside the bowl finds its outside, and a crest
 * stands on the rail or knob a helmet carries for one.
 */
function caster(verts, faces) {
    const T = new Float64Array(faces.length * 9);
    faces.forEach((face, i) => face.forEach((v, k) => { T[i * 9 + k * 3] = verts[v][0]; T[i * 9 + k * 3 + 1] = verts[v][1]; T[i * 9 + k * 3 + 2] = verts[v][2]; }));
    return ([ox, oy, oz], [dx, dy, dz]) => {
        let far = 0;
        for (let i = 0; i < T.length; i += 9) {
            const ax = T[i], ay = T[i + 1], az = T[i + 2];
            const e1x = T[i + 3] - ax, e1y = T[i + 4] - ay, e1z = T[i + 5] - az;
            const e2x = T[i + 6] - ax, e2y = T[i + 7] - ay, e2z = T[i + 8] - az;
            const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
            const det = e1x * px + e1y * py + e1z * pz;
            if (Math.abs(det) < 1e-12) continue;
            const sx = ox - ax, sy = oy - ay, sz = oz - az;
            const u = (sx * px + sy * py + sz * pz) / det;
            if (u < 0 || u > 1) continue;
            const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
            const v = (dx * qx + dy * qy + dz * qz) / det;
            if (v < 0 || u + v > 1) continue;
            const t = (e2x * qx + e2y * qy + e2z * qz) / det;
            if (t > far) far = t;
        }
        return far || null;
    };
}

/**
 * How far out the surface is from `centre` every degree from `from` to `to`
 * along `direction(angle)`, as a function of the angle in radians. Smoothed
 * over a dozen degrees, so a spike or a knob narrower than that does not
 * throw a crest up over it; where a ray misses (an eye slit, past the rim)
 * the nearest angle that did not stands in.
 */
function profile(cast, centre, direction, from, to) {
    const raw = [];
    for (let a = from; a <= to; a++) raw.push(cast(centre, direction(a * DEG)));
    const smooth = raw.map((r, i) => {
        const near = raw.slice(Math.max(0, i - 6), i + 7).filter(v => v !== null).sort((p, q) => p - q);
        return near.length ? near[near.length >> 1] : null;
    });
    const known = smooth.map((r, i) => (r === null ? -1 : i)).filter(i => i >= 0);
    if (!known.length) throw new Error('The helmet is nowhere to be found from its middle.');
    const filled = smooth.map((r, i) => (r !== null ? r : smooth[known.reduce((best, k) => (Math.abs(k - i) < Math.abs(best - i) ? k : best))]));
    return (angle) => {
        const f = Math.max(0, Math.min(filled.length - 1, angle / DEG - from));
        const i = Math.floor(f), t = f - i;
        return filled[i] * (1 - t) + filled[Math.min(filled.length - 1, i + 1)] * t;
    };
}

/** Direction in the helmet's middle plane: 0 the way the face looks, 90 straight up, 180 behind. */
const along = a => [0, Math.sin(a), Math.cos(a)];
/** Direction across the head: 0 to the right, 90 straight up, 180 to the left. */
const across = a => [Math.cos(a), Math.sin(a), 0];

/**
 * A helmet seen from its middle: that point, how far out its bowl is along
 * the middle plane and across it, and its size (the bowl's reach from the
 * middle over the top).
 */
export function survey(verts, faces, centre = null) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const face of faces) for (const v of face) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], verts[v][k]); hi[k] = Math.max(hi[k], verts[v][k]); }
    const middle = centre || [0, 1, 2].map(k => (lo[k] + hi[k]) / 2);
    const cast = caster(verts, faces);
    const lengthwise = profile(cast, middle, along, -40, 280);
    const crosswise = profile(cast, middle, across, 0, 180);
    let size = 0;
    for (let a = 45; a <= 135; a += 5) size += lengthwise(a * DEG) / 19;
    return { centre: middle, cast, lengthwise, crosswise, size, top: hi[1] };
}

/* ---- The Corinthian's crest -------------------------------------------------- */

/**
 * The crest lifted off the Corinthian: its faces and strands, and the
 * Corinthian without it (the patches closing where it stood), seen from the
 * point low in the bowl that `parts.mjs` measures the crest round.
 */
export function corinthianCrest(mesh) {
    const normals = faceNormals(mesh.verts, mesh.faces);
    const crest = crestFaces(mesh, normals);
    const body = mesh.faces.filter((face, i) => !crest[i]).concat(crestPatches(mesh, crest));
    return {
        verts: mesh.verts,
        faces: mesh.faces.filter((face, i) => crest[i]),
        hair: strands(mesh, normals, crest),
        seen: survey(mesh.verts, body, [0, -0.05, 0.05]),
    };
}

/** Where a point stands in the source's middle plane: angle round its middle, height above its bowl, and to the side. */
function lengthwiseOf(p, seen) {
    const [cx, cy, cz] = seen.centre;
    let a = Math.atan2(p[1] - cy, p[2] - cz);
    if (a < -Math.PI / 2) a += 2 * Math.PI; // on past the back rather than round to the front
    return { a, height: Math.hypot(p[1] - cy, p[2] - cz) - seen.lengthwise(a), side: p[0] - cx };
}

/**
 * The crest on `target`: front to back, or turned across (`transverse`).
 * Across, only the part over the top is used, stretched from one side of
 * the bowl to the other; the tail that hangs behind the neck and the low
 * front would have nowhere to go.
 */
export function bendCrest(crest, target, { transverse = false } = {}) {
    const k = target.size / crest.seen.size;
    const [cx, cy, cz] = target.centre;
    const FROM = 55 * DEG, TO = 200 * DEG; // the part over the top, when turned across
    // Not out along a brim: a morion's reaches far past its bowl, front and back.
    let over = 0;
    for (let a = 60; a <= 120; a += 5) over = Math.max(over, target.lengthwise(a * DEG));
    const bowl = a => Math.min(target.lengthwise(a), over * 1.1);
    const place = (p) => {
        const { a, height, side } = lengthwiseOf(p, crest.seen);
        const h = (height - 0.012) * k; // a hair into the bowl, so it stands in it and not on it
        if (!transverse) {
            const r = bowl(a) + h;
            return { at: [cx + side * k, cy + r * Math.sin(a), cz + r * Math.cos(a)], kept: true };
        }
        // from above one ear to above the other
        const b = (25 + ((a - FROM) / (TO - FROM)) * 130) * DEG;
        const r = target.crosswise(b) + h;
        return { at: [cx + r * Math.cos(b), cy + r * Math.sin(b), cz + side * k], kept: a >= FROM && a <= TO };
    };

    const placed = new Map();
    const at = (v) => { if (!placed.has(v)) placed.set(v, place(crest.verts[v])); return placed.get(v); };
    const index = new Map();
    const verts = [];
    const faces = [];
    for (const face of crest.faces) {
        if (face.some(v => !at(v).kept)) continue;
        const f = face.map((v) => {
            if (!index.has(v)) { index.set(v, verts.length); verts.push(at(v).at); }
            return index.get(v);
        });
        // turned across, the crest is its own mirror image: wound the other way round
        faces.push(transverse ? [f[0], f[2], f[1]] : f);
    }

    const hair = [];
    for (const strand of crest.hair) {
        let run = [];
        for (const p of strand) {
            const q = place(p);
            if (q.kept) run.push(q.at);
            else { if (run.length > 1) hair.push(run); run = []; }
        }
        if (run.length > 1) hair.push(run);
    }
    return { verts, faces, hair };
}

/* ---- Pieces that stand on a helmet ------------------------------------------ */

/** A rotation taking the perpendicular unit vectors (a1, a2) to (b1, b2). */
function turning(a1, a2, b1, b2) {
    const a3 = cross(a1, a2), b3 = cross(b1, b2);
    return p => add(add(scale(b1, dot(p, a1)), scale(b2, dot(p, a2))), scale(b3, dot(p, a3)));
}

/** The part of `v` across `axis`, made unit. */
const across1 = (v, axis) => unit(sub(v, scale(axis, dot(v, axis))));

/**
 * A model's shape along its length: its two ends, the one it stands on
 * first (the wider, the root of a horn, or with `quill` the narrower, the
 * quill of a feather), and the way it bends away from the line between
 * them. A `flat` one (a feather) bends within the plane it is thinnest
 * across, whatever its curl out of it.
 */
function measure(piece, { flat = false, quill = false } = {}) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of piece.verts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const axis = [0, 1, 2].reduce((best, k) => (hi[k] - lo[k] > hi[best] - lo[best] ? k : best), 0);
    const length = hi[axis] - lo[axis];
    const near = end => piece.verts.filter(p => Math.abs(p[axis] - end) < length * 0.04);
    const mean = ps => scale(ps.reduce((m, q) => add(m, q), [0, 0, 0]), 1 / ps.length);
    const spread = (ps) => { const m = mean(ps); return ps.reduce((s, p) => s + Math.hypot(...sub(p, m)), 0) / ps.length; };
    const [a, b] = [near(lo[axis]), near(hi[axis])];
    const [root, tipEnd] = (spread(a) <= spread(b)) === quill ? [a, b] : [b, a];
    const base = mean(root), tip = mean(tipEnd);
    const line = unit(sub(tip, base));
    const middle = mean(piece.verts);
    let bend = across1(sub(middle, base), line);
    if (flat) {
        const thin = [0, 1, 2].reduce((best, k) => (hi[k] - lo[k] < hi[best] - lo[best] ? k : best), 0);
        const width = unit(cross([0, 1, 2].map(k => (k === thin ? 1 : 0)), line));
        bend = dot(sub(middle, base), width) < 0 ? scale(width, -1) : width;
    }
    return { base, line, bend, length: Math.hypot(...sub(tip, base)) };
}

/** Copies of a model placed on a helmet: each a length and where its root, line and bend go. */
function placeCopies(piece, copies, options) {
    const m = measure(piece, options);
    const verts = [], faces = [];
    for (const copy of copies) {
        const turn = turning(m.line, m.bend, copy.line, across1(copy.bend, copy.line));
        const k = copy.length / m.length;
        const offset = verts.length;
        for (const p of piece.verts) verts.push(add(copy.root, turn(scale(sub(p, m.base), k))));
        for (const face of piece.faces) faces.push(face.map(v => v + offset));
    }
    return { verts, faces, hair: [] };
}

/** Where the bowl's surface is from the middle in direction `d`, a little way in. */
function onBowl(target, d, sink = 0.03) {
    const r = target.cast(target.centre, d) || target.size;
    return add(target.centre, scale(d, r - sink * target.size));
}

/**
 * A horn either side, from the temples, going out and up and curling up and
 * a little forward. Set deep enough that the flat foot the model was printed
 * on is inside the bowl.
 */
export function hornsOn(horn, target) {
    const length = target.size * 1.15;
    return placeCopies(horn, [1, -1].map((side) => {
        const out = unit([side * Math.cos(30 * DEG), Math.sin(30 * DEG), 0]);
        const line = unit([side * Math.cos(38 * DEG), Math.sin(38 * DEG), 0]);
        return {
            root: sub(onBowl(target, out), scale(line, length * 0.1)),
            line,
            bend: unit([0, 1, 0.5]),
            length,
        };
    }));
}

/** Three feathers from the back of the top of the bowl, fanned from upright to back, curling backwards. */
export function feathersOn(feather, target) {
    const root = onBowl(target, along(110 * DEG), 0.05);
    return placeCopies(feather, [[70, 1.5], [100, 1.8], [130, 1.45]].map(([a, k], i) => ({
        root: add(root, [(i - 1) * 0.02 * target.size, 0, 0]),
        line: along(a * DEG),
        bend: along((a + 90) * DEG),
        length: target.size * k,
    })), { flat: true, quill: true });
}

/**
 * The crown round the top of the bowl: its band laid against the bowl all
 * the way round, at the height a circlet sits, and everything standing up
 * from the band as it stood, in proportion to how far round the bowl is.
 */
export function crownOn(crown, target) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of crown.verts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const [ax, az] = [(lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2];
    const polar = p => ({ a: Math.atan2(p[0] - ax, p[2] - az), r: Math.hypot(p[0] - ax, p[2] - az), y: p[1] - lo[1] });
    const inner = Math.min(...crown.verts.map(p => polar(p).r));

    const [cx, cy, cz] = target.centre;
    const band = cy + (target.top - cy) * 0.45;
    const round = profile(target.cast, [cx, band, cz], a => [Math.sin(a), 0, Math.cos(a)], -180, 180);
    let reach = 0;
    for (let a = -180; a < 180; a += 10) reach += round(a * DEG) / 36;
    const k = reach / inner;
    const verts = crown.verts.map((p) => {
        const { a, r, y } = polar(p);
        const out = round(a) + (r - inner) * k;
        return [cx + out * Math.sin(a), band + y * k * 0.8, cz + out * Math.cos(a)];
    });
    return { verts, faces: crown.faces, hair: [] };
}

/** Every crest model, loaded once. */
export async function loadCrestSources(corinthianMesh, cacheDir) {
    return {
        crest: corinthianCrest(corinthianMesh),
        horn: await loadSource(CREST_SOURCES.horns, cacheDir, 1100),
        crown: await loadSource(CREST_SOURCES.crown, cacheDir, 3500),
        feather: await loadSource(CREST_SOURCES.feathers, cacheDir, 700),
    };
}

/**
 * Each crest fitted to one helmet, by id, as { verts, faces, hair } in the
 * helmet's frame. `skip` are the crests the helmet brings itself.
 */
export function crestsFor(sources, verts, bodyFaces, skip = []) {
    const target = survey(verts, bodyFaces);
    const fits = {
        plume: () => bendCrest(sources.crest, target),
        transverse: () => bendCrest(sources.crest, target, { transverse: true }),
        horns: () => hornsOn(sources.horn, target),
        crown: () => crownOn(sources.crown, target),
        feathers: () => feathersOn(sources.feather, target),
    };
    return Object.fromEntries(CREST_IDS.filter(id => !skip.includes(id)).map(id => [id, fits[id]()]));
}

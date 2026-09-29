/**
 * What each face of the helmet is: the crest or not, the inside or not; how
 * to close the helmet once the crest is off; the strands drawn on the crest;
 * and the creases the line art follows.
 *
 * Most of this is about the crest. It stands on a rail that runs over the
 * bowl from the forehead to the back of the head, so it is described in the
 * helmet's middle plane, as an angle and a distance round a point low in the
 * bowl (`O`): from the front (0 degrees) over the top (90) to the back (180)
 * and on down behind the neck, where the tail hangs.
 */

const O = [0.05, -0.05]; // (z, y)
const DEG = Math.PI / 180;

/** Angle round O, unwrapped so it runs on past the back instead of jumping. */
const angle = (z, y) => {
    const a = Math.atan2(y - O[1], z - O[0]);
    return a < -Math.PI / 2 ? a + 2 * Math.PI : a;
};
const radius = (z, y) => Math.hypot(y - O[1], z - O[0]);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export function faceNormals(verts, faces) {
    return faces.map(([a, b, c]) => unit(cross(sub(verts[b], verts[a]), sub(verts[c], verts[a]))));
}

const edgeKey = (a, b) => (a < b ? a * 65536 + b : b * 65536 + a);

/* ---- The crest ------------------------------------------------------------ */

const BINS = 360;
const binOf = (a) => Math.max(0, Math.min(BINS - 1, Math.floor((a + Math.PI / 2) / DEG)));

/**
 * The highest radius per degree among some vertices, spread over a few
 * degrees either way. The sides of the rail are long slivers with vertices
 * only at their ends, so a degree on its own often sees none of the top.
 */
function envelope(mesh, normals, pick, spread = 4) {
    const raw = new Float32Array(BINS).fill(-1);
    mesh.faces.forEach((face, i) => {
        for (const v of face) {
            const p = mesh.verts[v];
            if (!pick(p, normals[i])) continue;
            const k = binOf(angle(p[2], p[1]));
            raw[k] = Math.max(raw[k], radius(p[2], p[1]));
        }
    });
    const out = new Float32Array(BINS).fill(-1);
    for (let k = 0; k < BINS; k++) {
        for (let d = -spread; d <= spread; d++) if (k + d >= 0 && k + d < BINS) out[k] = Math.max(out[k], raw[k + d]);
    }
    return out;
}

/**
 * Which faces are the crest: anything standing clear of the rail's top, or
 * hanging behind the neck clear of the helmet's back. Every corner is
 * tested, not the middle of the face, since a sliver reaching from the rail
 * to the top of the crest has its middle low down.
 */
export function crestFaces(mesh, normals) {
    const rail = envelope(mesh, normals, (p, n) => Math.abs(n[0]) > 0.97 && Math.abs(p[0]) >= 0.15 && Math.abs(p[0]) < 0.175 && p[1] > 0.1);
    const back = envelope(mesh, normals, p => Math.abs(p[0]) > 0.18 && Math.abs(p[0]) < 0.25);
    const surface = (p) => {
        const a = angle(p[2], p[1]);
        const k = binOf(a);
        if (a < 12 * DEG) return Infinity; // the face: none of it is crest
        if (a <= 166 * DEG && rail[k] > 0) return rail[k];
        if (back[k] > 0) return back[k] + 0.03; // behind the neck
        return Infinity;
    };
    return mesh.faces.map((face) => {
        const corners = face.map(v => mesh.verts[v]);
        if (corners.some(p => Math.abs(p[0]) > 0.155)) return false;
        return corners.some(p => radius(p[2], p[1]) > surface(p) + 0.015);
    });
}

/**
 * Which faces are the inside of the shell: turned towards the middle of the
 * helmet rather than away from it. The crest is never the inside, however
 * its faces turn.
 */
export function insideFaces(mesh, normals, crest) {
    const centre = [0, 0, 0];
    for (const p of mesh.verts) for (let k = 0; k < 3; k++) centre[k] += p[k] / mesh.verts.length;
    return mesh.faces.map((face, i) => {
        if (crest[i]) return false;
        const middle = [0, 1, 2].map(k => (mesh.verts[face[0]][k] + mesh.verts[face[1]][k] + mesh.verts[face[2]][k]) / 3);
        return dot(normals[i], sub(middle, centre)) < 0;
    });
}

/* ---- Closing the helmet once the crest is off ---------------------------- */

/** The holes in a set of faces: loops of edges that only one face uses. */
function holes(faces) {
    const count = new Map();
    for (const face of faces) {
        for (let k = 0; k < 3; k++) {
            const a = face[k], b = face[(k + 1) % 3];
            const key = edgeKey(a, b);
            const edge = count.get(key);
            if (edge) edge.n += 1;
            else count.set(key, { a, b, n: 1 });
        }
    }
    const next = new Map();
    for (const edge of count.values()) if (edge.n === 1) next.set(edge.b, edge.a);
    const loops = [];
    const seen = new Set();
    for (const start of next.keys()) {
        if (seen.has(start)) continue;
        const loop = [];
        for (let v = start; v !== undefined && !seen.has(v); v = next.get(v)) { seen.add(v); loop.push(v); }
        if (loop.length > 2) loops.push(loop);
    }
    return loops;
}

/**
 * Close one hole. The long seam the crest leaves along the rail is zipped
 * side to side, each side's vertices taken in order along the rail; anything
 * small is fanned from a corner.
 */
function close(verts, loop) {
    const along = (v) => angle(verts[v][2], verts[v][1]);
    const left = loop.filter(v => verts[v][0] <= 0).sort((a, b) => along(a) - along(b));
    const right = loop.filter(v => verts[v][0] > 0).sort((a, b) => along(a) - along(b));
    const faces = [];
    if (left.length < 2 || right.length < 2) {
        for (let k = 1; k < loop.length - 1; k++) faces.push([loop[0], loop[k], loop[k + 1]]);
        return faces;
    }
    let i = 0, j = 0;
    while (i < left.length - 1 || j < right.length - 1) {
        const stepLeft = j >= right.length - 1 || (i < left.length - 1 && along(left[i + 1]) <= along(right[j + 1]));
        if (stepLeft) { faces.push([left[i], left[i + 1], right[j]]); i += 1; }
        else { faces.push([left[i], right[j + 1], right[j]]); j += 1; }
    }
    return faces;
}

/** Turned outwards, away from O, like the rest of the rail's top. */
function outwards(verts, faces) {
    return faces.map((face) => {
        const [a, b, c] = face.map(v => verts[v]);
        const n = cross(sub(b, a), sub(c, a));
        const out = [0, (a[1] + b[1] + c[1]) / 3 - O[1], (a[2] + b[2] + c[2]) / 3 - O[0]];
        return dot(n, out) < 0 ? [face[0], face[2], face[1]] : face;
    });
}

/** The faces that close the helmet where the crest stood. */
export function crestPatches(mesh, crest) {
    const kept = mesh.faces.filter((face, i) => !crest[i]);
    return outwards(mesh.verts, holes(kept).flatMap(loop => close(mesh.verts, loop)));
}

/* ---- Strands ---------------------------------------------------------------- */

/**
 * The hair drawn on both sides of the crest: strokes running in from its
 * outer edge towards the rail, of uneven length, fanned the way horsehair
 * fans from the clamp that holds it, and spaced evenly along the crest.
 *
 * The crest's sides are flat but not parallel: the crest is thicker at the
 * front than at the tail, so each side is a tilted plane, fitted here, and
 * the strands follow it. The holder it stands in is a separate, wider box,
 * and a face belongs to the crest's side only if it lies on that plane.
 *
 * The sides are a few long slivers, often one corner at the holder and a run
 * of them along the top, so the crest's profile (how far in and out it
 * reaches at each angle) is taken from points all along their edges, not
 * from the corners, which would leave most angles seeing only one side.
 */
export function strands(mesh, normals, crest, { every = 1.6 } = {}) {
    const flatSide = mesh.faces.map((face, i) => crest[i] && Math.abs(normals[i][0]) > 0.97);
    // |x| = a + b y + c z, fitted to the side where it is surely the crest: well above the holder
    const rows = [];
    mesh.faces.forEach((face, i) => {
        if (!flatSide[i]) return;
        for (const v of face) {
            const [x, y, z] = mesh.verts[v];
            if (radius(z, y) > 0.8) rows.push([1, y, z, Math.abs(x)]);
        }
    });
    const plane = leastSquares(rows);
    const sideAt = (y, z) => plane[0] + plane[1] * y + plane[2] * z;

    const raw = Array.from({ length: BINS }, () => ({ inner: Infinity, outer: -Infinity }));
    mesh.faces.forEach((face, i) => {
        if (!flatSide[i]) return;
        const corners = face.map(v => mesh.verts[v]);
        if (corners.some(([x, y, z]) => Math.abs(Math.abs(x) - sideAt(y, z)) > 0.006)) return;
        for (let k = 0; k < 3; k++) {
            const a = corners[k], b = corners[(k + 1) % 3];
            const steps = Math.max(1, Math.ceil(Math.hypot(b[1] - a[1], b[2] - a[2]) / 0.01));
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
                const bin = raw[binOf(angle(z, y))];
                const r = radius(z, y);
                bin.inner = Math.min(bin.inner, r);
                bin.outer = Math.max(bin.outer, r);
            }
        }
    });
    const SPREAD = 3;
    const profile = (k) => {
        let inner = Infinity, outer = -Infinity;
        for (let d = -SPREAD; d <= SPREAD; d++) {
            const bin = raw[k + d];
            if (!bin) continue;
            inner = Math.min(inner, bin.inner);
            outer = Math.max(outer, bin.outer);
        }
        return { inner, outer };
    };
    const used = raw.map((bin, k) => (bin.outer > 0 ? k : -1)).filter(k => k >= 0);
    const lengths = [0.62, 0.44, 0.72, 0.52, 0.66, 0.4, 0.58];
    const places = [];
    for (let a = used[0] + SPREAD; a <= used[used.length - 1] - SPREAD; a += every) {
        const { inner, outer } = profile(Math.round(a));
        const span = outer - inner;
        if (!(span >= 0.05)) continue;
        const length = span * lengths[places.length % lengths.length];
        const phi = (a + 0.5) * DEG - Math.PI / 2;
        const pair = [-1, 1].map((side) => {
            const points = [];
            for (let t = 0; t <= 1.0001; t += 1 / 8) {
                const r = outer - 0.012 - length * t;
                const p = phi + Math.sin(Math.PI * t) * 0.012; // a slight sweep towards the tail
                const y = O[1] + r * Math.sin(p), z = O[0] + r * Math.cos(p);
                points.push([side * (sideAt(y, z) + 0.0015), y, z]); // just proud of the side
            }
            return points;
        });
        places.push(pair);
    }
    // In an order where every prefix is spread evenly along the crest, so a
    // small mark can draw the first few and still cover the whole of it.
    return byEvenPrefix(places.length).flatMap(i => places[i]);
}

/** 0..n-1 in bit-reversed order: 0, n/2, n/4, 3n/4, ..., so any first k are evenly spread. */
function byEvenPrefix(n) {
    const bits = Math.ceil(Math.log2(Math.max(2, n)));
    const order = [];
    for (let i = 0; i < 1 << bits; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
        if (r < n) order.push(r);
    }
    return order;
}

/** The least-squares solution of rows [...coefficients, value], by the normal equations. */
function leastSquares(rows) {
    const n = rows[0].length - 1;
    const A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
    for (const row of rows) {
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) A[i][j] += row[i] * row[j];
            A[i][n] += row[i] * row[n];
        }
    }
    // Gauss-Jordan with partial pivoting
    for (let c = 0; c < n; c++) {
        let pivot = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
        [A[c], A[pivot]] = [A[pivot], A[c]];
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = A[r][c] / A[c][c];
            for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
        }
    }
    return A.map((row, i) => row[n] / row[i]);
}

/* ---- Normals and creases --------------------------------------------------- */

/**
 * Face normals, with the odd broken sliver mended: a face whose normal
 * disagrees with every one of its neighbours is a flaw in the mesh (its
 * author warns of a few on the inside), and left alone it shows as a speck
 * of ink where the surface is smooth. It takes its neighbours' average.
 */
export function mendNormals(verts, faces) {
    const normals = faceNormals(verts, faces);
    const byEdge = new Map();
    const neighbours = faces.map(() => []);
    faces.forEach((face, i) => {
        for (let k = 0; k < 3; k++) {
            const key = edgeKey(face[k], face[(k + 1) % 3]);
            const other = byEdge.get(key);
            if (other === undefined) byEdge.set(key, i);
            else { neighbours[i].push(other); neighbours[other].push(i); }
        }
    });
    const mended = new Map();
    faces.forEach((face, i) => {
        if (neighbours[i].length < 2) return;
        if (neighbours[i].some(g => dot(normals[i], normals[g]) > 0.6)) return;
        mended.set(i, unit(neighbours[i].reduce((sum, g) => [sum[0] + normals[g][0], sum[1] + normals[g][1], sum[2] + normals[g][2]], [0, 0, 0])));
    });
    return { normals: normals.map((n, i) => mended.get(i) || n), mended };
}

/** The edges where the surface folds by more than `degrees`, and the open edges, as vertex pairs. */
export function creases(faces, normals, degrees = 38) {
    const cos = Math.cos(degrees * DEG);
    const edges = new Map();
    faces.forEach((face, i) => {
        for (let k = 0; k < 3; k++) {
            const a = face[k], b = face[(k + 1) % 3];
            const key = edgeKey(a, b);
            const edge = edges.get(key);
            if (edge) edge.faces.push(i);
            else edges.set(key, { a: Math.min(a, b), b: Math.max(a, b), faces: [i] });
        }
    });
    const out = [];
    for (const { a, b, faces: [f1, f2] } of edges.values()) {
        if (f2 === undefined || dot(normals[f1], normals[f2]) < cos) out.push([a, b]);
    }
    return out;
}

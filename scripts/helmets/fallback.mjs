/**
 * The helmet drawn once, in its resting pose, as SVG paths: what a mark
 * shows where there is no WebGL2 to draw it live.
 *
 * The same picture the renderer makes, made the slow way: the mesh is
 * rasterized with a depth buffer, the silhouette and the dark inside are
 * traced with potrace, and the lines (the outline where the surface turns
 * away, and the creases) are kept where nothing stands in front of them and
 * fitted as curves. Everything is on a 240 x 240 grid.
 */
import { createRequire } from 'node:module';
import { faceNormals, creases } from './parts.mjs';

const require = createRequire(import.meta.url);

const GRID = 240;
const round = (n) => Math.round(n * 10) / 10;

function rotation(yaw, pitch) {
    const a = (yaw * Math.PI) / 180, b = (pitch * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    return [[ca, 0, sa], [sa * sb, cb, -ca * sb], [-sa * cb, sb, ca * cb]];
}

/** A mask traced into path data, with the raster's stair-steps softened first. */
function trace(mask, W) {
    const { PNG } = require('pngjs');
    const potrace = require('potrace');
    const R = 2;
    const along = new Float32Array(W * W), soft = new Float32Array(W * W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        let sum = 0, n = 0;
        for (let d = -R; d <= R; d++) if (x + d >= 0 && x + d < W) { sum += mask[y * W + x + d]; n += 1; }
        along[y * W + x] = sum / n;
    }
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        let sum = 0, n = 0;
        for (let d = -R; d <= R; d++) if (y + d >= 0 && y + d < W) { sum += along[(y + d) * W + x]; n += 1; }
        soft[y * W + x] = sum / n;
    }
    const png = new PNG({ width: W, height: W });
    for (let i = 0; i < W * W; i++) {
        const v = soft[i] >= 0.5 ? 0 : 255;
        png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = v;
        png.data[i * 4 + 3] = 255;
    }
    return new Promise((resolve, reject) => {
        const tracer = new potrace.Potrace({ turdSize: 30, alphaMax: 0.95, optCurve: true, optTolerance: 0.6, threshold: 128, blackOnWhite: true });
        tracer.loadImage(PNG.sync.write(png), (error) => {
            if (error) reject(error);
            else resolve((tracer.getPathTag().match(/d="([^"]*)"/) || [])[1] || '');
        });
    });
}

/** A polyline fitted as cubic curves. */
function fit(points) {
    const fitCurve = require('fit-curve');
    const clean = [points[0]];
    for (const p of points) {
        const q = clean[clean.length - 1];
        if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 1.2) clean.push(p);
    }
    if (clean.length < 2) return '';
    const curves = fitCurve(clean, 1.2);
    let d = `M ${round(curves[0][0][0])} ${round(curves[0][0][1])}`;
    for (const [, c1, c2, end] of curves) d += ` C ${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(end[0])} ${round(end[1])}`;
    return d;
}

/** Every number in path data scaled by k. */
const rescale = (d, k) => d.replace(/-?\d*\.?\d+(?:e-?\d+)?/gi, n => String(round(Number(n) * k))).replace(/,/g, '').replace(/\s+/g, ' ').trim();

/**
 * The drawing for one set of faces (`inside` marks the faces that are the
 * shell's inside). Returns { outline, inside, lines } on the 240 grid.
 */
export async function drawStill(verts, faces, inside, { yaw = 48, pitch = 14, px = 1100 } = {}) {
    const normals = faceNormals(verts, faces);
    const [rx, ry, rz] = rotation(yaw, pitch);
    const project = p => [rx[0] * p[0] + rx[1] * p[1] + rx[2] * p[2], ry[0] * p[0] + ry[1] * p[1] + ry[2] * p[2], rz[0] * p[0] + rz[1] * p[1] + rz[2] * p[2]];
    const used = new Set(faces.flat());
    const projected = new Map();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const v of used) {
        const q = project(verts[v]);
        projected.set(v, q);
        minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1]);
    }
    const half = (Math.max(maxX - minX, maxY - minY) / 2) * 1.04;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const W = px;
    const screen = new Map();
    for (const [v, [x, y, z]] of projected) screen.set(v, [W / 2 + ((x - cx) / half) * (W / 2), W / 2 - ((y - cy) / half) * (W / 2), z]);

    // the nearest face at every pixel
    const depth = new Float32Array(W * W).fill(-Infinity);
    const owner = new Int32Array(W * W).fill(-1);
    faces.forEach((face, fi) => {
        const [A, B, C] = face.map(v => screen.get(v));
        const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
        if (Math.abs(area) < 1e-9) return;
        const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
        const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), y1 = Math.min(W - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const qx = x + 0.5, qy = y + 0.5;
            const w0 = ((B[0] - qx) * (C[1] - qy) - (B[1] - qy) * (C[0] - qx)) / area;
            const w1 = ((C[0] - qx) * (A[1] - qy) - (C[1] - qy) * (A[0] - qx)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
            const z = w0 * A[2] + w1 * B[2] + w2 * C[2];
            const i = y * W + x;
            if (z > depth[i]) { depth[i] = z; owner[i] = fi; }
        }
    });
    const cover = new Uint8Array(W * W), dark = new Uint8Array(W * W);
    for (let i = 0; i < W * W; i++) {
        if (owner[i] < 0) continue;
        cover[i] = 1;
        if (inside[owner[i]]) dark[i] = 1;
    }

    // lines: where the surface turns away from the viewer, and the creases
    const facing = normals.map(n => rz[0] * n[0] + rz[1] * n[1] + rz[2] * n[2] > 0);
    const edges = new Map();
    faces.forEach((face, fi) => {
        for (let k = 0; k < 3; k++) {
            const a = face[k], b = face[(k + 1) % 3];
            const key = a < b ? `${a}_${b}` : `${b}_${a}`;
            const e = edges.get(key);
            if (e) e.faces.push(fi); else edges.set(key, { a: Math.min(a, b), b: Math.max(a, b), faces: [fi] });
        }
    });
    const folds = new Set(creases(faces, normals).map(([a, b]) => `${a}_${b}`));
    const visible = ([x, y, z]) => {
        let best = -Infinity;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.round(x - 0.5) + dx, yy = Math.round(y - 0.5) + dy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < W) best = Math.max(best, depth[yy * W + xx]);
        }
        return z >= best - 0.02;
    };
    const segments = [];
    for (const [key, { a, b, faces: [f1, f2] }] of edges) {
        if (f2 === undefined) continue;
        const turn = facing[f1] !== facing[f2];
        const fold = folds.has(key) && (facing[f1] || facing[f2]);
        if (!turn && !fold) continue;
        const A = screen.get(a), B = screen.get(b);
        const n = Math.max(2, Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1]) / 2));
        let seen = 0;
        for (let k = 0; k <= n; k++) {
            const t = k / n;
            if (visible([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t])) seen += 1;
        }
        if (seen / (n + 1) > 0.6) segments.push([a, b]);
    }
    // chained into polylines through vertices where only two segments meet
    const at = new Map();
    segments.forEach(([a, b], i) => { for (const v of [a, b]) { if (!at.has(v)) at.set(v, []); at.get(v).push(i); } });
    const done = new Uint8Array(segments.length);
    const chains = [];
    for (let i = 0; i < segments.length; i++) {
        if (done[i]) continue;
        done[i] = 1;
        const chain = [...segments[i]];
        for (const forward of [true, false]) {
            let end = forward ? chain[chain.length - 1] : chain[0];
            for (;;) {
                const next = (at.get(end) || []).filter(j => !done[j]);
                if (next.length !== 1 || at.get(end).length > 2) break;
                done[next[0]] = 1;
                const other = segments[next[0]][0] === end ? segments[next[0]][1] : segments[next[0]][0];
                if (forward) chain.push(other); else chain.unshift(other);
                end = other;
            }
        }
        chains.push(chain.map(v => screen.get(v)));
    }

    const k = GRID / W;
    const [outline, darkPath] = await Promise.all([trace(cover, W), trace(dark, W)]);
    return {
        outline: rescale(outline, k),
        inside: rescale(darkPath, k),
        lines: chains.filter(c => c.length > 1).map(fit).filter(Boolean).map(d => rescale(d, k)),
    };
}

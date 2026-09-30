/**
 * A helmet from the catalogue as a mesh in the frame everything else uses:
 * X to the side, Y up, Z the way the face points, centred, and scaled so its
 * longest side runs from -1 to 1, with which faces are its crest.
 *
 * Each part (the helmet, and its crest if it has one) is welded and
 * simplified on its own, so the crest keeps its faces apart and simplifying
 * never joins the two. Heavy models are simplified with meshoptimizer, a
 * package the app does not need, so it is installed alongside the others the
 * build uses (see `build.mjs`).
 */
import { readGLB } from './gltf.mjs';
import { weld } from './source.mjs';

/** Down to about `target` faces, keeping the open edges (rims, eye slits) where they are. */
export async function simplify(mesh, target) {
    if (mesh.faces.length <= target) return mesh;
    const { MeshoptSimplifier } = await import('meshoptimizer');
    await MeshoptSimplifier.ready;
    const kept = MeshoptSimplifier.simplify(
        new Uint32Array(mesh.faces.flat()), new Float32Array(mesh.verts.flat()), 3, target * 3, 0.01, ['LockBorder'],
    )[0];
    const index = new Map();
    const verts = [];
    const faces = [];
    for (let i = 0; i < kept.length; i += 3) {
        const face = [kept[i], kept[i + 1], kept[i + 2]].map((v) => {
            if (!index.has(v)) { index.set(v, verts.length); verts.push(mesh.verts[v]); }
            return index.get(v);
        });
        if (face[0] !== face[1] && face[1] !== face[2] && face[0] !== face[2]) faces.push(face);
    }
    return { verts, faces };
}

export async function loadModel(helmet, glb, { faces: budget = 22000 } = {}) {
    const a = ((helmet.turn || 0) * Math.PI) / 180;
    const turn = ([x, y, z]) => [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
    const meshes = readGLB(glb).map(triangles => triangles.map(t => t.map(turn)));
    const crestMeshes = new Set(helmet.crest || []);

    let min = Infinity, max = -Infinity;
    for (const triangles of meshes) for (const t of triangles) for (const p of t) for (const c of p) { min = Math.min(min, c); max = Math.max(max, c); }
    const tolerance = (max - min) * 1e-3;
    const parts = [false, true].map(crest => weld(meshes.filter((m, i) => crestMeshes.has(i) === crest).flat(), tolerance));
    const total = parts[0].faces.length + parts[1].faces.length;

    const verts = [], faces = [], crest = [];
    for (const [k, part] of parts.entries()) {
        if (!part.faces.length) continue;
        const kept = await simplify(part, Math.round((budget * part.faces.length) / total));
        const offset = verts.length;
        verts.push(...kept.verts);
        for (const face of kept.faces) { faces.push(face.map(v => v + offset)); crest.push(k === 1); }
    }

    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of verts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const centre = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2);
    const scale = 2 / Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    return { verts: verts.map(p => p.map((c, k) => (c - centre[k]) * scale)), faces, crest };
}

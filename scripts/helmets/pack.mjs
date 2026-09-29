/**
 * The helmet packed for the app: one binary blob holding both crest options.
 *
 * Layout, little-endian:
 *
 *   u32 x 8     magic 'HLM2', vertices, faces, mended faces, creases with the
 *               crest, creases without it, strands, strand points
 *   i16 x 3     per vertex: position, in [-1, 1]
 *   u16 x 3     per face: the whole helmet, then the patches that close it
 *               once the crest is off
 *   u8          per face, padded to 4: 1 the inside, 2 the crest, 4 a patch
 *   8 bytes     per mended face: u32 face, i8 x 3 normal, one spare
 *   u16 x 2     per crease: with the crest on, then with it off
 *   u16         per strand, padded to 4: how many points it has
 *   i16 x 3     per strand point
 *
 * The renderer (`src/renderer/components/assistant/helmet/renderer.js`)
 * reads it back.
 */
import { faceNormals, crestFaces, insideFaces, crestPatches, strands, mendNormals, creases } from './parts.mjs';

export const INSIDE = 1, CREST = 2, PATCH = 4;
const MAGIC = 0x324d4c48;

export function pack(mesh) {
    const normals = faceNormals(mesh.verts, mesh.faces);
    const crest = crestFaces(mesh, normals);
    const inside = insideFaces(mesh, normals, crest);
    const patches = crestPatches(mesh, crest);
    const faces = mesh.faces.concat(patches);
    const flags = faces.map((face, i) => (i >= mesh.faces.length ? PATCH : (inside[i] ? INSIDE : 0) | (crest[i] ? CREST : 0)));

    const { normals: mendedNormals, mended } = mendNormals(mesh.verts, faces);
    const pick = (keep) => {
        const list = faces.map((face, i) => i).filter(i => keep(flags[i]));
        return creases(list.map(i => faces[i]), list.map(i => mendedNormals[i]));
    };
    const withCrest = pick(flag => !(flag & PATCH));
    const withoutCrest = pick(flag => !(flag & CREST));
    const hair = strands(mesh, normals, crest);
    const hairPoints = hair.reduce((sum, s) => sum + s.length, 0);

    const pad4 = (n) => Math.ceil(n / 4) * 4;
    const size = 32 + mesh.verts.length * 6 + faces.length * 6 + pad4(faces.length) + mended.size * 8
        + (withCrest.length + withoutCrest.length) * 4 + pad4(hair.length * 2) + hairPoints * 6;
    const buffer = Buffer.alloc(size);
    let at = 0;
    for (const v of [MAGIC, mesh.verts.length, faces.length, mended.size, withCrest.length, withoutCrest.length, hair.length, hairPoints]) {
        buffer.writeUInt32LE(v, at);
        at += 4;
    }
    const q16 = (v) => Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
    for (const p of mesh.verts) for (const c of p) { buffer.writeInt16LE(q16(c), at); at += 2; }
    for (const face of faces) for (const v of face) { buffer.writeUInt16LE(v, at); at += 2; }
    flags.forEach((flag, i) => buffer.writeUInt8(flag, at + i));
    at += pad4(faces.length);
    for (const [face, n] of mended) {
        buffer.writeUInt32LE(face, at);
        n.forEach((c, k) => buffer.writeInt8(Math.max(-127, Math.min(127, Math.round(c * 127))), at + 4 + k));
        at += 8;
    }
    for (const [a, b] of withCrest.concat(withoutCrest)) {
        buffer.writeUInt16LE(a, at);
        buffer.writeUInt16LE(b, at + 2);
        at += 4;
    }
    hair.forEach((s, i) => buffer.writeUInt16LE(s.length, at + i * 2));
    at += pad4(hair.length * 2);
    for (const s of hair) for (const p of s) for (const c of p) { buffer.writeInt16LE(q16(c), at); at += 2; }
    if (at !== size) throw new Error(`Packed ${at} of ${size} bytes.`);

    return {
        buffer,
        flags,
        faces,
        stats: {
            vertices: mesh.verts.length,
            faces: faces.length,
            patches: patches.length,
            mended: mended.size,
            creases: [withCrest.length, withoutCrest.length],
            strands: hair.length,
            bytes: size,
        },
    };
}

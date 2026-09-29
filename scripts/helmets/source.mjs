/**
 * The helmet the agent mark is drawn from, and how to get it.
 *
 * "Spartan Helm" by HeadlessMoose, a Corinthian helmet with its crest, from
 * Thingiverse (thing 1643968), licensed CC BY 3.0 by its author. It is read
 * from the Internet Archive's copy of the Thingiverse upload, which is the
 * one that can be fetched without an account, and cached next to this file
 * so it is downloaded once.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const SOURCE = {
    title: 'Spartan Helm',
    author: 'HeadlessMoose',
    url: 'https://www.thingiverse.com/thing:1643968',
    licence: 'CC BY 3.0',
    licenceUrl: 'https://creativecommons.org/licenses/by/3.0/',
    archive: 'https://archive.org/download/thingiverse-1643968/Spartan_Helm_1643968.zip',
    file: 'files/Helm.stl',
};

/** One file out of a zip archive, by name. Only what this archive needs: stored or deflated entries. */
function unzip(buffer, name) {
    // the end of central directory record, searched for from the back
    let end = buffer.length - 22;
    while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
    if (end < 0) throw new Error('Not a zip archive.');
    const entries = buffer.readUInt16LE(end + 10);
    let at = buffer.readUInt32LE(end + 16);
    for (let i = 0; i < entries; i++) {
        const method = buffer.readUInt16LE(at + 10);
        const compressed = buffer.readUInt32LE(at + 20);
        const nameLength = buffer.readUInt16LE(at + 28);
        const extra = buffer.readUInt16LE(at + 30);
        const comment = buffer.readUInt16LE(at + 32);
        const local = buffer.readUInt32LE(at + 42);
        const entry = buffer.toString('utf8', at + 46, at + 46 + nameLength);
        if (entry === name) {
            const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
            const data = buffer.subarray(start, start + compressed);
            if (method === 0) return Buffer.from(data);
            if (method === 8) return zlib.inflateRawSync(data);
            throw new Error(`Unsupported compression in ${name}.`);
        }
        at += 46 + nameLength + extra + comment;
    }
    throw new Error(`${name} is not in the archive.`);
}

/** The STL, from the cache or the archive. */
export async function fetchSource(cacheDir) {
    const cached = path.join(cacheDir, 'Helm.stl');
    if (fs.existsSync(cached)) return fs.readFileSync(cached);
    const response = await fetch(SOURCE.archive);
    if (!response.ok) throw new Error(`Could not download the helmet: ${response.status} ${response.statusText}`);
    const stl = unzip(Buffer.from(await response.arrayBuffer()), SOURCE.file);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cached, stl);
    return stl;
}

/** Triangles out of an STL, binary or text. */
function readSTL(buffer) {
    const count = buffer.readUInt32LE(80);
    const triangles = [];
    if (84 + count * 50 === buffer.length) {
        for (let i = 0; i < count; i++) {
            const at = 84 + i * 50 + 12;
            const corners = [];
            for (let k = 0; k < 3; k++) {
                corners.push([buffer.readFloatLE(at + k * 12), buffer.readFloatLE(at + k * 12 + 4), buffer.readFloatLE(at + k * 12 + 8)]);
            }
            triangles.push(corners);
        }
        return triangles;
    }
    const text = buffer.toString('utf8');
    const pattern = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let corners = [];
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        corners.push([Number(match[1]), Number(match[2]), Number(match[3])]);
        if (corners.length === 3) { triangles.push(corners); corners = []; }
    }
    return triangles;
}

/** Shared corners made one vertex: an STL stores every triangle's corners separately. */
function weld(triangles, tolerance) {
    const index = new Map();
    const verts = [];
    const faces = [];
    const key = (p) => p.map(c => Math.round(c / tolerance)).join(',');
    for (const triangle of triangles) {
        const face = triangle.map((p) => {
            const k = key(p);
            let i = index.get(k);
            if (i === undefined) {
                i = verts.length;
                verts.push(p.slice());
                index.set(k, i);
            }
            return i;
        });
        if (face[0] !== face[1] && face[1] !== face[2] && face[0] !== face[2]) faces.push(face);
    }
    return { verts, faces };
}

/**
 * The helmet as a mesh in the frame everything else uses: X to the side, Y
 * up, Z the way the face points, centred, and scaled so its longest side
 * runs from -1 to 1.
 */
export function loadHelmet(stl) {
    // the model stands on its Z axis with the face looking down -X
    const triangles = readSTL(stl).map(t => t.map(([x, y, z]) => [-y, z, -x]));
    const mesh = weld(triangles, 1e-2);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of mesh.verts) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
    const centre = [0, 1, 2].map(k => (min[k] + max[k]) / 2);
    const scale = 2 / Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    mesh.verts = mesh.verts.map(p => p.map((c, k) => (c - centre[k]) * scale));
    return mesh;
}

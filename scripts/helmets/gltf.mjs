/**
 * Getting a helmet from the catalogue (`catalogue.mjs`): downloaded from
 * Zenodo once and cached, then read as triangles.
 *
 * Only as much glTF as these files use: one binary buffer, float positions,
 * indexed triangles, and nodes placed by a matrix or by translation, rotation
 * and scale. Anything else is refused rather than read wrong.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The GLB, from the cache or from Zenodo. */
export async function fetchModel(helmet, cacheDir) {
    const cached = path.join(cacheDir, helmet.file);
    if (fs.existsSync(cached)) return fs.readFileSync(cached);
    const url = `https://zenodo.org/api/records/${helmet.record}/files/${helmet.file}/content`;
    // Zenodo turns away requests that do not say what they are.
    const response = await fetch(url, { headers: { 'User-Agent': 'acestes-helmets/1 (+https://github.com)' } });
    if (!response.ok) throw new Error(`Could not download ${helmet.title}: ${response.status} ${response.statusText}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cached, buffer);
    return buffer;
}

const multiply = (a, b) => {
    const out = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return out;
};

/** A node's own matrix, column-major, from `matrix` or from translation, rotation and scale. */
function local(node) {
    if (node.matrix) return node.matrix.slice();
    const [tx, ty, tz] = node.translation || [0, 0, 0];
    const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale || [1, 1, 1];
    return [
        (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
        2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
        2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
        tx, ty, tz, 1,
    ];
}

/**
 * The meshes in a GLB's scene, in the order a depth-first walk of it meets
 * them, each as a list of triangles ([[x, y, z] x 3]) where the scene puts
 * them.
 */
export function readGLB(buffer) {
    if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('Not a GLB file.');
    const jsonLength = buffer.readUInt32LE(12);
    const json = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength));
    const binAt = 20 + jsonLength + 8;
    // Materials and textures are no matter; what changes how the shape is stored is.
    const unread = (json.extensionsRequired || []).filter(name => !/^KHR_(materials|texture)_/.test(name));
    if (unread.length) throw new Error(`Needs ${unread.join(', ')}.`);

    const read = (index) => {
        const accessor = json.accessors[index];
        if (accessor.sparse) throw new Error('Sparse accessors are not read here.');
        const view = json.bufferViews[accessor.bufferView];
        const size = { SCALAR: 1, VEC3: 3 }[accessor.type];
        const bytes = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[accessor.componentType];
        if (!size || !bytes) throw new Error(`Accessor ${index} is ${accessor.type} of ${accessor.componentType}.`);
        const stride = view.byteStride || size * bytes;
        const start = binAt + (view.byteOffset || 0) + (accessor.byteOffset || 0);
        const get = {
            5126: at => buffer.readFloatLE(at), 5125: at => buffer.readUInt32LE(at),
            5123: at => buffer.readUInt16LE(at), 5121: at => buffer.readUInt8(at),
        }[accessor.componentType];
        return Array.from({ length: accessor.count }, (_, i) => {
            const at = start + i * stride;
            return size === 1 ? get(at) : [get(at), get(at + bytes), get(at + 2 * bytes)];
        });
    };

    const meshes = [];
    const walk = (index, parent) => {
        const node = json.nodes[index];
        const m = multiply(parent, local(node));
        if (node.mesh !== undefined) {
            const place = ([x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
            const triangles = [];
            for (const primitive of json.meshes[node.mesh].primitives) {
                if ((primitive.mode ?? 4) !== 4) continue;
                const positions = read(primitive.attributes.POSITION).map(place);
                const indices = primitive.indices === undefined ? positions.map((p, i) => i) : read(primitive.indices);
                for (let i = 0; i + 2 < indices.length; i += 3) triangles.push([positions[indices[i]], positions[indices[i + 1]], positions[indices[i + 2]]]);
            }
            meshes.push(triangles);
        }
        for (const child of node.children || []) walk(child, m);
    };
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const root of json.scenes[json.scene || 0].nodes) walk(root, identity);
    return meshes;
}

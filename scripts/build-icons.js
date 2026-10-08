/**
 * Build the app icons from the source art, `acestesicon.png` in the repo root.
 *
 * The packaged apps never read that file. Windows and Linux take
 * `build/icon.png` (electron-builder makes the exe's icon from it), the
 * Windows windows and taskbar take `build/icon.ico`, and macOS takes
 * `build/icon.icon`. Replacing the source art without running this left every
 * release shipping the previous icon, so all of them come from here:
 *
 *   build/icon.png   1024px, the source scaled up (it is 750px, and the macOS
 *                    target wants 1024)
 *   build/icon.ico   16 to 256px, the sizes the shell actually paints. Handed
 *                    only the 1024px PNG the taskbar draws Electron's logo
 *   build/icon.icon  through build-mac-icon.js, from the new build/icon.png
 *
 * Run `npm run build:icons` whenever `acestesicon.png` changes, and commit what
 * it writes: the release builds use the files as they are.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'acestesicon.png');
const PNG = path.join(ROOT, 'build', 'icon.png');
const ICO = path.join(ROOT, 'build', 'icon.ico');

const SIZE = 1024;
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/**
 * An .ico whose every entry is a PNG, which Windows has read since Vista and
 * which keeps the alpha edge exactly as sharp drew it.
 */
function ico(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    const entries = [];
    let offset = 6 + images.length * 16;
    for (const { size, data } of images) {
        const entry = Buffer.alloc(16);
        entry[0] = size >= 256 ? 0 : size;
        entry[1] = size >= 256 ? 0 : size;
        entry.writeUInt16LE(1, 4);
        entry.writeUInt16LE(32, 6);
        entry.writeUInt32LE(data.length, 8);
        entry.writeUInt32LE(offset, 12);
        entries.push(entry);
        offset += data.length;
    }
    return Buffer.concat([header, ...entries, ...images.map(image => image.data)]);
}

async function main() {
    const meta = await sharp(SOURCE).metadata();
    if (meta.width !== meta.height) throw new Error(`${path.basename(SOURCE)} is ${meta.width}x${meta.height}, not square`);

    await sharp(SOURCE)
        .ensureAlpha()
        .resize(SIZE, SIZE, { kernel: 'lanczos3' })
        .png({ compressionLevel: 9 })
        .toFile(PNG);

    const images = [];
    for (const size of ICO_SIZES) {
        const data = await sharp(PNG).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
        images.push({ size, data });
    }
    fs.writeFileSync(ICO, ico(images));
    console.log(`build-icons: wrote build/icon.png (${SIZE}px) and build/icon.ico (${ICO_SIZES.join(', ')}px) from ${path.basename(SOURCE)}.`);

    const mac = spawnSync(process.execPath, [path.join(__dirname, 'build-mac-icon.js')], { stdio: 'inherit' });
    if (mac.status !== 0) throw new Error('build-mac-icon.js failed');
}

main().catch((error) => {
    console.error('build-icons:', error.message);
    process.exit(1);
});

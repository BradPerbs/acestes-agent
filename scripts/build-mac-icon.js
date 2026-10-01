/**
 * Build the macOS app icon, `build/icon.icon`, from `build/icon.png`.
 *
 * macOS 26 draws every app icon itself, as a rounded square it cuts to its own
 * shape. An app that only ships a legacy `.icns` gets its picture shrunk and
 * set inside a grey tile of the system's, which is how the Dock was showing
 * ours: a small black tile inside a larger grey one, next to icons that fill
 * the space. The way out is an Icon Composer `.icon`, which says what the
 * background is and what sits on it, and leaves the shape to the system.
 * electron-builder compiles it with Xcode 26's `actool` into the bundle's
 * `Assets.car`, and makes the `.icns` that older macOS reads from it as well.
 *
 * So this splits the PNG into those two parts. The background is the flat
 * `#0E0E10` the tile is painted in (see resources/README.md), which becomes
 * the fill. The artwork is lifted off it: each pixel's opacity is how far it
 * rises above the background and its colour is what it would be at full
 * opacity, so over the same fill it comes back exactly as it was, and it stays
 * a separate layer for the tinted and clear icon styles to work with.
 *
 * Run by `npm run build:mac-icon` whenever `build/icon.png` changes. The
 * output is committed, because the release builds compile it as it is.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'build', 'icon.png');
const OUTPUT = path.join(ROOT, 'build', 'icon.icon');
const LAYER = 'acestes.png';

const BACKGROUND = [0x0e, 0x0e, 0x10];
// The tile is not perfectly flat: it has a few levels of grain above the
// background, which would otherwise come through as a faint speckle.
const GRAIN = 0.035;

async function main() {
    const { data, info } = await sharp(SOURCE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const out = Buffer.alloc(info.width * info.height * 4);

    for (let i = 0; i < out.length; i += 4) {
        // The PNG's corners are transparent. Flatten them onto the background
        // first, so they come out as nothing rather than as a dark edge.
        const coverage = data[i + 3] / 255;
        const colour = BACKGROUND.map((b, k) => data[i + k] * coverage + b * (1 - coverage));
        const lift = Math.max(...colour.map((c, k) => (c - BACKGROUND[k]) / (255 - BACKGROUND[k])));
        const alpha = Math.min(1, (lift - GRAIN) / (1 - GRAIN));
        if (alpha <= 0) continue;
        for (let k = 0; k < 3; k++) {
            out[i + k] = Math.round(Math.min(255, BACKGROUND[k] + (colour[k] - BACKGROUND[k]) / lift));
        }
        out[i + 3] = Math.round(alpha * 255);
    }

    fs.mkdirSync(path.join(OUTPUT, 'Assets'), { recursive: true });
    await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png({ compressionLevel: 9 })
        .toFile(path.join(OUTPUT, 'Assets', LAYER));

    // Glass, translucency and specular are off: they are for flat shapes, and
    // would turn the engraved silver into frosted glass.
    const srgb = BACKGROUND.map(c => (c / 255).toFixed(5)).join(',');
    const icon = {
        fill: { solid: `srgb:${srgb},1.00000` },
        groups: [
            {
                'blur-material': null,
                layers: [
                    {
                        glass: false,
                        hidden: false,
                        'image-name': LAYER,
                        name: path.basename(LAYER, '.png'),
                        position: { scale: 1, 'translation-in-points': [0, 0] },
                    },
                ],
                lighting: 'individual',
                shadow: { kind: 'neutral', opacity: 0.5 },
                specular: false,
                translucency: { enabled: false, value: 0.5 },
            },
        ],
        'supported-platforms': { circles: ['watchOS'], squares: 'shared' },
    };
    fs.writeFileSync(path.join(OUTPUT, 'icon.json'), JSON.stringify(icon, null, 2) + '\n');

    console.log(`build-mac-icon: wrote ${path.relative(ROOT, OUTPUT)} from ${path.relative(ROOT, SOURCE)}.`);
}

main().catch(error => {
    console.error('build-mac-icon:', error.message);
    process.exit(1);
});

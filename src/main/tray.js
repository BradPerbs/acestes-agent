const { Tray, Menu, nativeImage, app } = require('electron');
const zlib = require('zlib');

/**
 * The tray icon, for the app running with no window.
 *
 * A scheduled job needs the process up after the last window closes, and
 * a process with no window and no icon is one the person cannot find to
 * quit. So there is an icon, with the two things it needs to offer: open
 * the window, and quit for real.
 *
 * The image is drawn here rather than shipped: a filled circle in the
 * agent's ember, at two sizes for ordinary and high-density displays. It
 * is encoded as a PNG by hand because the app carries no image library in
 * the main process, and a 16px circle is forty lines of code, not a
 * dependency.
 */

let tray = null;

function crc32(buffer) {
    let crc = ~0;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return ~crc >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/** A PNG of a filled circle, `size` pixels square, in the colour given. */
function circlePng(size, [red, green, blue]) {
    const rows = [];
    const centre = (size - 1) / 2;
    const radius = size / 2 - 0.5;
    for (let y = 0; y < size; y += 1) {
        const row = Buffer.alloc(1 + size * 4);
        row[0] = 0; // filter: none
        for (let x = 0; x < size; x += 1) {
            const distance = Math.hypot(x - centre, y - centre);
            // One pixel of anti-aliasing at the edge.
            const alpha = Math.max(0, Math.min(1, radius + 0.5 - distance));
            const at = 1 + x * 4;
            row[at] = red;
            row[at + 1] = green;
            row[at + 2] = blue;
            row[at + 3] = Math.round(alpha * 255);
        }
        rows.push(row);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;  // bit depth
    header[9] = 6;  // colour type: RGBA
    header[10] = 0; // compression
    header[11] = 0; // filter
    header[12] = 0; // interlace
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const EMBER = [194, 65, 12];

function icon() {
    const image = nativeImage.createFromBuffer(circlePng(16, EMBER), { scaleFactor: 1 });
    image.addRepresentation({ scaleFactor: 2, buffer: circlePng(32, EMBER) });
    return image;
}

/**
 * Show the icon. `onOpen` brings a window up; `onQuit` really quits, which
 * on a machine with jobs is the only way to, since closing the window no
 * longer does.
 */
function show({ onOpen, onQuit }) {
    if (tray) return tray;
    try {
        tray = new Tray(icon());
    } catch (error) {
        console.error('Could not create the tray icon:', error.message);
        return null;
    }
    tray.setToolTip('Acestes Agent');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open Acestes Agent', click: () => onOpen?.() },
        { type: 'separator' },
        { label: 'Quit', click: () => (onQuit ? onQuit() : app.quit()) },
    ]));
    tray.on('click', () => onOpen?.());
    tray.on('double-click', () => onOpen?.());
    return tray;
}

function hide() {
    if (!tray) return;
    try { tray.destroy(); } catch { /* gone */ }
    tray = null;
}

module.exports = { show, hide, circlePng };

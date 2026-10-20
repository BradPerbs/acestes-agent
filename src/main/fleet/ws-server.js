const crypto = require('crypto');

/**
 * Just enough of a WebSocket server (RFC 6455) for the relay: text frames,
 * fragmentation, ping and pong, close. Node has had a WebSocket client built in
 * since 22, but no server, and this is small enough not to want a dependency
 * for.
 *
 * `attach(server, { path, maxPayload, onConnection })` takes over the HTTP
 * server's upgrades on paths starting with `path`. `onConnection(conn, req)`
 * gets `{ send(text), close(code, reason), onMessage, onClose }`; set the two
 * handlers on it. Binary frames are refused (close 1003): the relay speaks
 * JSON.
 *
 * Idle peers are pinged every 30 seconds and dropped when one goes unanswered
 * for a minute, so a laptop that vanished from the network shows offline to
 * the others within that.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PING_MS = 30 * 1000;
const DEAD_MS = 65 * 1000;

function frame(opcode, payload = Buffer.alloc(0)) {
    const length = payload.length;
    let header;
    if (length < 126) {
        header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    return Buffer.concat([header, payload]);
}

function accept(req, socket, { maxPayload, onConnection }) {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
    }
    const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '', '',
    ].join('\r\n'));
    socket.setNoDelay(true);

    let buffer = Buffer.alloc(0);
    let pieces = [];
    let pieceOpcode = 0;
    let closed = false;
    let lastSeen = Date.now();

    const conn = {
        onMessage: () => {},
        onClose: () => {},
        send(text) {
            if (closed) return;
            socket.write(frame(0x1, Buffer.from(String(text), 'utf8')));
        },
        close(code = 1000, reason = '') {
            if (closed) return;
            const body = Buffer.alloc(2 + Buffer.byteLength(reason));
            body.writeUInt16BE(code, 0);
            body.write(reason, 2);
            try {
                socket.write(frame(0x8, body));
            } catch {
                // Gone already.
            }
            finish();
            socket.end();
        },
    };

    const pinger = setInterval(() => {
        if (Date.now() - lastSeen > DEAD_MS) {
            socket.destroy();
            return;
        }
        try {
            socket.write(frame(0x9));
        } catch {
            socket.destroy();
        }
    }, PING_MS);
    pinger.unref?.();

    function finish() {
        if (closed) return;
        closed = true;
        clearInterval(pinger);
        try {
            conn.onClose();
        } catch (error) {
            console.error('Relay socket close handler failed:', error.message);
        }
    }

    function parse() {
        while (buffer.length >= 2) {
            const first = buffer[0];
            const second = buffer[1];
            const fin = (first & 0x80) !== 0;
            const opcode = first & 0x0f;
            const masked = (second & 0x80) !== 0;
            let length = second & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (buffer.length < 4) return;
                length = buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (buffer.length < 10) return;
                const big = buffer.readBigUInt64BE(2);
                if (big > BigInt(maxPayload)) return conn.close(1009, 'too large');
                length = Number(big);
                offset = 10;
            }
            if (!masked) return conn.close(1002, 'unmasked');
            if (length > maxPayload) return conn.close(1009, 'too large');
            if (buffer.length < offset + 4 + length) return;
            const mask = buffer.subarray(offset, offset + 4);
            const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
            for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
            buffer = buffer.subarray(offset + 4 + length);
            lastSeen = Date.now();

            if (opcode === 0x8) return conn.close(1000, '');
            if (opcode === 0x9) {
                socket.write(frame(0xA, payload));
                continue;
            }
            if (opcode === 0xA) continue;
            if (opcode === 0x2 || (opcode === 0x0 && pieceOpcode === 0x2)) return conn.close(1003, 'text only');
            if (opcode === 0x1 || opcode === 0x0) {
                if (opcode === 0x1) {
                    pieces = [];
                    pieceOpcode = 0x1;
                }
                pieces.push(payload);
                if (pieces.reduce((sum, piece) => sum + piece.length, 0) > maxPayload) return conn.close(1009, 'too large');
                if (fin) {
                    const text = Buffer.concat(pieces).toString('utf8');
                    pieces = [];
                    pieceOpcode = 0;
                    try {
                        conn.onMessage(text);
                    } catch (error) {
                        console.error('Relay message handler failed:', error.message);
                    }
                }
                continue;
            }
            return conn.close(1002, 'bad opcode');
        }
        return undefined;
    }

    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > maxPayload + 14) {
            parse();
            if (buffer.length > maxPayload + 14) conn.close(1009, 'too large');
            return;
        }
        parse();
    });
    socket.on('close', finish);
    socket.on('error', () => socket.destroy());

    onConnection(conn, req);
}

function attach(server, { path = '/', maxPayload = 1024 * 1024, onConnection }) {
    server.on('upgrade', (req, socket) => {
        const url = String(req.url || '');
        if (!url.startsWith(path)) {
            socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
            return;
        }
        accept(req, socket, { maxPayload, onConnection });
    });
}

module.exports = { attach };

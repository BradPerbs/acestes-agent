/**
 * The channel between one live session and the pane drawing it.
 *
 * Every transport ends up doing the same four things with its bytes, and doing
 * them slightly differently in three files is how a transcript ends up with a
 * hole in it that nobody notices for months. So they are done once, here:
 *
 *   a MessagePort per session, rather than IPC. Terminal output is the highest
 *   rate traffic in the app and the only thing on this channel, so it does not
 *   queue behind a transfer's progress updates the way a shared channel would;
 *
 *   output coalesced to one post per tick. A verbose command is thousands of
 *   small reads, and one message each pins the renderer;
 *
 *   the transcript fed from the arriving bytes rather than from the flush, so
 *   it records what the far end sent even when the port has gone away. A
 *   window reload leaves the session perfectly alive and unable to be drawn;
 *
 *   multi-byte characters held across reads. A UTF-8 sequence split down the
 *   middle by a socket read is not an edge case at 9600 baud, and decoding each
 *   half on its own puts a replacement character in the middle of a word.
 *
 * ssh.js predates this and carries its own copy. It is left alone deliberately:
 * it is the path every session in the app takes today, and a refactor of it is
 * not part of adding two more transports.
 */

const { MessageChannelMain } = require('electron');
const { StringDecoder } = require('string_decoder');
const sessionLog = require('./session-log');
const transcript = require('./transcript');

/**
 * Wire up a session's data path.
 *
 *   tabId     the pane's id, which is the session key everywhere else too
 *   window    where to hand the far end of the port
 *   label     what the transcript header and the log lines name this session
 *   protocol  which transport this is ('telnet', 'serial'), so the transcript
 *             settings can decide whether this kind of session is recorded
 *   onInput   bytes typed in the pane, already a string
 *   onResize  the pane's new geometry; transports with no concept of one
 *             simply leave it out
 */
function createPipe({ tabId, window, label = {}, protocol = '', onInput, onResize }) {
    const decoder = new StringDecoder('utf8');
    // Replaced by `attach`, so everything below reads it at the moment of use.
    let port1 = null;

    let closed = false;

    // Started before a single byte can arrive, so a transcript never begins
    // half way through the far end's banner.
    sessionLog.start(tabId, {
        hostName: label.hostName || '',
        address: label.address || '',
        hostId: label.hostId || '',
        protocol,
    });

    // The bounded in-memory tail the assistant reads. Unlike the transcript
    // above it is not a setting: it is never written down and dies with the
    // session, so there is nothing to opt into.
    transcript.open(tabId, {
        hostName: label.hostName || '',
        address: label.address || '',
        hostId: label.hostId || '',
        protocol,
    });

    const onMessage = (event) => {
        const message = event.data;
        if (closed) return;

        if (message?.type === 'input') {
            onInput?.(message.data);
        } else if (message?.type === 'resize') {
            onResize?.(message.cols, message.rows);
        }
    };

    /** A fresh port, bound here and handed to `target`; the old one is let go. */
    const bind = (target) => {
        const channel = new MessageChannelMain();
        const previous = port1;
        port1 = channel.port1;
        port1.on('message', onMessage);
        port1.start();
        if (previous) {
            try {
                previous.close();
            } catch {
                // Already closed with the window that held it.
            }
        }
        if (target && !target.isDestroyed()) {
            target.webContents.postMessage('ssh-port', { tabId }, [channel.port2]);
        }
    };

    let buffer = '';
    let scheduled = false;

    const flush = () => {
        scheduled = false;
        if (!buffer) return;
        try {
            port1.postMessage(buffer);
        } catch {
            // The port went away while data was in flight. The transcript
            // already has this text; there is nothing left to do with it.
        }
        buffer = '';
    };

    /**
     * Bytes arrived from the far end. Takes a Buffer or a string; a transport
     * that has already decoded its own text (an error line this app wrote, say)
     * can hand it straight over.
     */
    const deliver = (chunk) => {
        if (closed || chunk === null || chunk === undefined) return;

        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        if (!text) return;

        buffer += text;
        sessionLog.write(tabId, text);
        transcript.record(tabId, text);

        if (!scheduled) {
            scheduled = true;
            setImmediate(flush);
        }
    };

    /** The session ended. Tells the pane, which is what starts its backoff. */
    const disconnected = () => {
        if (closed) return;
        // Anything still buffered is output the far end produced before it
        // went, and is usually the reason it went: the "Connection closed by
        // foreign host" line is the last thing on the wire.
        const tail = decoder.end();
        if (tail) {
            buffer += tail;
            sessionLog.write(tabId, tail);
            transcript.record(tabId, tail);
        }
        flush();
        try {
            port1.postMessage({ type: 'disconnected' });
        } catch {
            // Already closed with the window.
        }
    };

    const close = () => {
        if (closed) return;
        closed = true;
        transcript.close(tabId);
        try {
            port1.close();
        } catch {
            // Already closed with the session it belonged to.
        }
    };

    /**
     * Hand a session that never stopped to a window again: a pane that was
     * remounted, or a window that reloaded. The new port carries `backlog`
     * first, which is what the session has shown so far, so the pane does not
     * come back blank; anything still waiting for a flush is already in it.
     */
    const attach = (target, backlog = '') => {
        if (closed) return false;
        buffer = '';
        bind(target);
        if (backlog) {
            try {
                port1.postMessage(backlog);
            } catch {
                // The window went away again before it could be drawn.
            }
        }
        return true;
    };

    bind(window);

    return { get port() { return port1; }, deliver, disconnected, close, attach };
}

module.exports = { createPipe };

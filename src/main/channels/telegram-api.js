/**
 * The handful of Telegram Bot API calls the gateway needs, over plain fetch.
 *
 * No library: the Bot API is JSON over HTTPS, and the gateway uses eight of
 * its methods. What a library would add is a dependency to keep up to date
 * for a protocol that has not changed shape in years.
 *
 * Every call resolves to the `result` Telegram sent, or throws a
 * `TelegramError` carrying the HTTP status and Telegram's own description,
 * which is what the gateway decides on: 401 is a token that no longer works,
 * 409 is another program reading this bot's updates, 429 is a rate limit
 * (waited out here, a couple of times, before it is thrown).
 *
 * The base URL is a parameter so the tests can point it at a fake server.
 */

const DEFAULT_BASE = 'https://api.telegram.org';

/** How long a call other than the long poll may take. */
const CALL_TIMEOUT = 20000;

/** How many times a rate-limited call is retried after waiting. */
const RATE_RETRIES = 2;

/** The longest wait a rate limit is honoured for before the call is given up. */
const MAX_RATE_WAIT = 30;

class TelegramError extends Error {
    constructor(status, description, parameters = {}) {
        super(description || `Telegram answered ${status}`);
        this.name = 'TelegramError';
        this.status = status;
        this.description = description || '';
        this.retryAfter = Number(parameters.retry_after) || 0;
    }
}

const sleep = (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
        clearTimeout(timer);
        resolve();
    }, { once: true });
});

/** A signal that aborts on the caller's signal or after `ms`, whichever is first. */
function deadline(ms, signal) {
    const timeout = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function createTelegramApi({ token, base = DEFAULT_BASE, fetchImpl = globalThis.fetch } = {}) {
    if (!token) throw new Error('A bot token is needed');
    const root = `${String(base).replace(/\/+$/, '')}/bot${token}`;
    const fileRoot = `${String(base).replace(/\/+$/, '')}/file/bot${token}`;

    async function once(method, payload, { timeout = CALL_TIMEOUT, signal, form = null } = {}) {
        const init = {
            method: 'POST',
            signal: deadline(timeout, signal),
        };
        if (form) {
            init.body = form;
        } else {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(payload || {});
        }
        let response;
        try {
            response = await fetchImpl(`${root}/${method}`, init);
        } catch (error) {
            // Never the URL: it carries the token.
            const reason = error?.name === 'TimeoutError' ? 'timed out' : (error?.cause?.code || error?.message || 'failed');
            const wrapped = new Error(`Could not reach Telegram (${reason})`);
            wrapped.network = true;
            wrapped.aborted = Boolean(signal?.aborted);
            throw wrapped;
        }
        let body = null;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        if (!body || body.ok !== true) {
            throw new TelegramError(body?.error_code || response.status, body?.description || '', body?.parameters || {});
        }
        return body.result;
    }

    async function call(method, payload, options = {}) {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await once(method, payload, options);
            } catch (error) {
                const limited = error instanceof TelegramError && error.status === 429;
                if (!limited || attempt >= RATE_RETRIES || error.retryAfter > MAX_RATE_WAIT) throw error;
                await sleep(Math.max(1, error.retryAfter) * 1000, options.signal);
                if (options.signal?.aborted) throw error;
            }
        }
    }

    return {
        call,
        getMe: () => call('getMe'),
        /**
         * The long poll. `timeout` is Telegram's (seconds it holds the request
         * open with nothing to say); ours is a little longer so a quiet poll
         * ends on its answer rather than on our abort.
         */
        getUpdates: ({ offset = 0, timeout = 30, signal } = {}) => call('getUpdates', {
            offset,
            timeout,
            allowed_updates: ['message', 'callback_query'],
        }, { timeout: (timeout + 15) * 1000, signal }),
        sendMessage: (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, ...extra }),
        editMessageText: (chatId, messageId, text, extra = {}) => call('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text,
            ...extra,
        }),
        editMessageReplyMarkup: (chatId, messageId, replyMarkup) => call('editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: replyMarkup || { inline_keyboard: [] },
        }),
        deleteMessage: (chatId, messageId) => call('deleteMessage', { chat_id: chatId, message_id: messageId }),
        answerCallbackQuery: (id, text = '') => call('answerCallbackQuery', {
            callback_query_id: id,
            ...(text ? { text: String(text).slice(0, 190) } : {}),
        }),
        sendChatAction: (chatId, action = 'typing') => call('sendChatAction', { chat_id: chatId, action }),
        setMyCommands: (commands) => call('setMyCommands', { commands }),
        /** A text file, for a reply too long to read as messages. */
        sendDocument: (chatId, { name, text, caption = '' }) => {
            const form = new FormData();
            form.append('chat_id', String(chatId));
            if (caption) form.append('caption', caption);
            form.append('document', new Blob([String(text)], { type: 'text/markdown' }), name);
            return call('sendDocument', null, { form, timeout: 60000 });
        },
        getFile: (fileId) => call('getFile', { file_id: fileId }),
        /** The bytes of a file `getFile` described, capped at `maxBytes`. */
        async download(filePath, { maxBytes = 20 * 1024 * 1024, signal } = {}) {
            let response;
            try {
                response = await fetchImpl(`${fileRoot}/${filePath}`, { signal: deadline(60000, signal) });
            } catch (error) {
                throw new Error(`Could not download the file (${error?.cause?.code || error?.message || 'failed'})`);
            }
            if (!response.ok) throw new Error(`Could not download the file (${response.status})`);
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length > maxBytes) throw new Error('The file is too large');
            return buffer;
        },
    };
}

module.exports = { createTelegramApi, TelegramError, DEFAULT_BASE };

const { createTelegramApi, TelegramError } = require('./telegram-api');
const { createGateway } = require('./gateway');
const format = require('./format');

/**
 * Telegram, as a channel: the user's own bot from @BotFather, reached with
 * the Bot API's long poll, so it works from behind any NAT with nothing to
 * open. The offset is saved before each update is handled, so an update
 * that takes the app down with it is not run a second time on the way up,
 * and Telegram holds what arrives while the app is closed for a day.
 *
 * Buttons are inline keyboards, a press is a callback query, and the reply
 * is Telegram's HTML subset (see format.js). The gateway does the rest.
 */

const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

const COMMANDS = [
    { command: 'new', description: 'Start a new conversation' },
    { command: 'list', description: 'Pick up a recent conversation' },
    { command: 'stop', description: 'Stop the agent' },
    { command: 'status', description: 'What the agent is doing, on which model' },
    { command: 'model', description: 'Choose the model' },
    { command: 'effort', description: 'How hard the model thinks' },
    { command: 'mode', description: 'What it may do without asking (yolo and the rest)' },
    { command: 'agent', description: 'Choose which agent to talk to' },
    { command: 'help', description: 'What this bot can do' },
];

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function failure(message, kind) {
    const error = new Error(message);
    if (kind) error.kind = kind;
    return error;
}

/** A Telegram message as the gateway reads one. */
function readMessage(message) {
    const attachments = [];
    if (Array.isArray(message.photo) && message.photo.length) {
        const sizes = [...message.photo].sort((a, b) => (b.width * b.height) - (a.width * a.height));
        const fitting = sizes.find(size => !size.file_size || size.file_size <= MAX_IMAGE_BYTES) || sizes[0];
        attachments.push({ kind: 'image', name: 'photo.jpg', mediaType: 'image/jpeg', size: fitting.file_size || 0, ref: fitting.file_id });
    }
    if (message.document) {
        const type = String(message.document.mime_type || '').toLowerCase();
        attachments.push({
            kind: IMAGE_TYPES.has(type) ? 'image' : 'file',
            name: message.document.file_name || 'file',
            mediaType: type,
            size: message.document.file_size || 0,
            ref: message.document.file_id,
        });
    }
    if (message.voice || message.audio || message.video_note) attachments.push({ kind: 'voice' });
    const from = message.from || {};
    return {
        type: 'message',
        id: String(message.message_id),
        chatId: String(message.chat.id),
        private: message.chat.type === 'private',
        from: {
            id: String(from.id),
            name: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '',
            username: from.username || '',
            bot: Boolean(from.is_bot),
        },
        text: message.text || message.caption || '',
        date: Number(message.date || 0) * 1000,
        attachments,
    };
}

const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

const keyboard = buttons => ({
    inline_keyboard: (buttons || []).map(row => row.map(button => ({ text: button.text, callback_data: button.data }))),
});

const unparsable = error => error instanceof TelegramError && error.status === 400 && /parse|entit|tag/i.test(error.description);

function createTelegramAdapter({ apiFactory = token => createTelegramApi({ token }), pollTimeout = 30 } = {}) {
    return {
        name: 'telegram',
        label: 'Telegram',
        target: 'telegram',
        prefix: '/',
        typing: true,

        prepare(raw) {
            const token = String(raw?.token || '').trim();
            if (!TOKEN_SHAPE.test(token)) {
                return { error: 'That does not look like a bot token. @BotFather gives one shaped like 123456789:AA...' };
            }
            return { credentials: { token } };
        },

        async verify({ token }) {
            let me;
            try {
                me = await apiFactory(token).getMe();
            } catch (error) {
                if (error instanceof TelegramError && (error.status === 401 || error.status === 404)) {
                    throw failure('Telegram did not accept that token. Copy it again from @BotFather.');
                }
                throw failure(error?.message || 'Telegram could not be reached.');
            }
            if (!me?.is_bot || !me.username) throw failure('That token does not belong to a bot.');
            return { id: String(me.id), username: me.username, name: me.first_name || me.username };
        },

        pairLink: (identity, code) => `https://t.me/${identity.username}?start=${code}`,
        pairText: (identity, code) => `/start ${code}`,

        client({ token }) {
            const api = apiFactory(token);

            async function sendHtml(chatId, html, extra) {
                try {
                    return await api.sendMessage(chatId, html, { parse_mode: 'HTML', ...NO_PREVIEW, ...extra });
                } catch (error) {
                    if (!unparsable(error)) throw error;
                    return api.sendMessage(chatId, format.htmlToText(html).slice(0, 4096), { ...NO_PREVIEW, ...extra });
                }
            }

            return {
                async listen({ signal, cursor, emit, setCursor, onReady }) {
                    api.setMyCommands(COMMANDS).catch(() => {});
                    let offset = Number(cursor) || 0;
                    while (!signal.aborted) {
                        let updates;
                        try {
                            updates = await api.getUpdates({ offset, timeout: pollTimeout, signal });
                        } catch (error) {
                            if (signal.aborted) return;
                            if (error instanceof TelegramError && (error.status === 401 || error.status === 404)) {
                                throw failure('Telegram no longer accepts this bot\'s token. Connect the bot again.', 'auth');
                            }
                            if (error instanceof TelegramError && error.status === 409) {
                                throw /webhook/i.test(error.description)
                                    ? failure('This bot has a webhook set, so its messages go somewhere else. Remove the webhook, or use another bot.', 'webhook')
                                    : failure('Another device or program is reading this bot\'s messages. Only one can at a time.', 'conflict');
                            }
                            throw error;
                        }
                        if (signal.aborted) return;
                        onReady();
                        for (const update of Array.isArray(updates) ? updates : []) {
                            // Moved past before it is handled: an update that
                            // takes the app down with it is not run again.
                            offset = Number(update.update_id) + 1;
                            setCursor(offset);
                            if (update.callback_query) {
                                const query = update.callback_query;
                                const from = query.from || {};
                                await emit({
                                    type: 'button',
                                    chatId: String(query.message?.chat?.id ?? from.id),
                                    from: { id: String(from.id), name: from.first_name || '', username: from.username || '' },
                                    data: query.data || '',
                                    messageId: query.message?.message_id ? String(query.message.message_id) : '',
                                    ack: text => api.answerCallbackQuery(query.id, text),
                                });
                            } else if (update.message?.chat && update.message.from) {
                                await emit(readMessage(update.message));
                            }
                        }
                    }
                },

                async send(chatId, { markdown, formatted, buttons, silent }) {
                    const html = formatted ?? format.toText(markdown, 'telegram');
                    const sent = await sendHtml(chatId, html, {
                        ...(buttons ? { reply_markup: keyboard(buttons) } : {}),
                        ...(silent ? { disable_notification: true } : {}),
                    });
                    return { id: sent?.message_id ? String(sent.message_id) : '' };
                },

                async edit(chatId, messageId, { markdown, formatted, buttons }) {
                    const html = formatted ?? format.toText(markdown, 'telegram');
                    const extra = { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: keyboard(buttons) };
                    try {
                        await api.editMessageText(chatId, messageId, html, extra);
                    } catch (error) {
                        if (!unparsable(error)) throw error;
                        await api.editMessageText(chatId, messageId, format.htmlToText(html).slice(0, 4096), { ...NO_PREVIEW, reply_markup: keyboard(buttons) });
                    }
                },

                typing: chatId => api.sendChatAction(chatId, 'typing'),

                sendFile: (chatId, file) => api.sendDocument(chatId, file),

                async fetch(attachment, maxBytes) {
                    const file = await api.getFile(attachment.ref);
                    if (!file?.file_path) throw new Error('Telegram did not say where the file is');
                    return api.download(file.file_path, { maxBytes });
                },
            };
        },
    };
}

/** A gateway on Telegram, as the app and the tests build one. */
function createTelegramGateway({ apiFactory, pollTimeout, ...deps } = {}) {
    return createGateway({ ...deps, adapter: createTelegramAdapter({ apiFactory, pollTimeout }) });
}

module.exports = { createTelegramAdapter, createTelegramGateway, COMMANDS, TOKEN_SHAPE };

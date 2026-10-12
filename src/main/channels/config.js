const fs = require('fs');
const path = require('path');

/**
 * What the channels keep between launches, in `channels.json` beside the
 * rest of the app's data.
 *
 * The bot token is the one secret here, and it is kept out of the agent's
 * keychain on purpose. A secret there can be named by any agent as
 * `{{secret:name}}` in a command, and a bot token in a command is an agent
 * able to read the user's messages to it, or send as it. So it is encrypted
 * under the vault key instead, like a host's password: unreadable while the
 * app is locked, and never in a backup or a cloud snapshot, which is also
 * what keeps a restore on a second machine from polling the same bot.
 *
 * Everything else is plain: who the bot is, who it answers, which
 * conversation each chat is in, and the update offset, so a restart does
 * not read the same messages twice.
 */

const VERSION = 1;

/** Phone approvals: every change asks, or the agent's own setting applies. */
const APPROVALS = new Set(['ask', 'agent']);

function blankTelegram() {
    return {
        enabled: false,
        token: '',
        bot: null,
        owner: null,
        offset: 0,
        agentId: '',
        approvals: 'ask',
        chats: {},
    };
}

function cleanTelegram(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const out = blankTelegram();
    out.enabled = Boolean(source.enabled);
    out.token = typeof source.token === 'string' ? source.token : '';
    if (source.bot && typeof source.bot === 'object' && source.bot.id) {
        out.bot = {
            id: Number(source.bot.id) || 0,
            username: String(source.bot.username || '').slice(0, 64),
            name: String(source.bot.name || '').slice(0, 128),
        };
    }
    if (source.owner && typeof source.owner === 'object' && Number(source.owner.userId) > 0) {
        out.owner = {
            userId: Number(source.owner.userId) || 0,
            chatId: Number(source.owner.chatId) || Number(source.owner.userId) || 0,
            name: String(source.owner.name || '').slice(0, 128),
            username: String(source.owner.username || '').slice(0, 64),
            pairedAt: Number(source.owner.pairedAt) || 0,
        };
    }
    out.offset = Math.max(0, Number(source.offset) || 0);
    out.agentId = String(source.agentId || '').slice(0, 120);
    out.approvals = APPROVALS.has(source.approvals) ? source.approvals : 'ask';
    if (source.chats && typeof source.chats === 'object') {
        for (const [chatId, chat] of Object.entries(source.chats)) {
            if (!/^-?\d+$/.test(chatId) || !chat || typeof chat !== 'object') continue;
            out.chats[chatId] = {
                conversationId: String(chat.conversationId || '').slice(0, 120),
                agentId: String(chat.agentId || '').slice(0, 120),
            };
        }
    }
    return out;
}

/**
 * The store. `dir` is where the file lives; `crypt` encrypts and decrypts
 * the token (the vault in the app, a stand-in in the tests).
 */
function createConfig({ dir, crypt }) {
    const file = () => path.join(typeof dir === 'function' ? dir() : dir, 'channels.json');
    let state = null;

    function load() {
        if (state) return state;
        let parsed = {};
        try {
            parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
        } catch {
            parsed = {};
        }
        state = { version: VERSION, telegram: cleanTelegram(parsed.telegram) };
        return state;
    }

    function save() {
        const current = load();
        try {
            fs.mkdirSync(path.dirname(file()), { recursive: true });
            const temp = `${file()}.tmp`;
            fs.writeFileSync(temp, JSON.stringify(current, null, 2), 'utf8');
            fs.renameSync(temp, file());
        } catch (error) {
            console.error('Could not save the channels:', error.message);
        }
    }

    return {
        telegram: () => load().telegram,
        update(patch) {
            const current = load();
            current.telegram = cleanTelegram({ ...current.telegram, ...patch });
            save();
            return current.telegram;
        },
        /** The token in the clear, or '' while locked or when there is none. */
        token() {
            const stored = load().telegram.token;
            if (!stored) return '';
            try {
                return crypt.decrypt(stored) || '';
            } catch {
                return '';
            }
        },
        /** Throws when the vault is locked: a token that was not stored must not look stored. */
        setToken(token) {
            const current = load();
            current.telegram = cleanTelegram({ ...current.telegram, token: token ? crypt.encrypt(token) : '' });
            save();
        },
        chat(chatId) {
            return load().telegram.chats[String(chatId)] || { conversationId: '', agentId: '' };
        },
        setChat(chatId, patch) {
            const current = load();
            const key = String(chatId);
            current.telegram.chats[key] = { ...(current.telegram.chats[key] || { conversationId: '', agentId: '' }), ...patch };
            save();
            return current.telegram.chats[key];
        },
        /** For the tests: read the file again. */
        reload() {
            state = null;
            return load();
        },
    };
}

module.exports = { createConfig, cleanTelegram, APPROVALS };

const fs = require('fs');
const path = require('path');

/**
 * What the channels keep between launches, in `channels.json` beside the
 * rest of the app's data: one section per chat app.
 *
 * Each section's credentials (a bot token, a Slack app's two tokens, a
 * Matrix access token) are the one secret, kept out of the agent's keychain
 * on purpose. A secret there can be named by any agent as `{{secret:name}}`
 * in a command, and a bot token in a command is an agent able to read the
 * user's messages to it, or send as it. So they are encrypted under the
 * vault key instead, like a host's password: unreadable while the app is
 * locked, and never in a backup or a cloud snapshot, which is also what
 * keeps a restore on a second machine from answering as the same bot.
 *
 * Everything else is plain: who the bot is, who it answers, which
 * conversation each chat is in, and the cursor (an update offset, a message
 * id, a sync token), so a restart neither reads the same messages twice nor
 * loses the ones that came while the app was closed.
 */

const VERSION = 2;

const NAMES = ['telegram', 'discord', 'slack', 'matrix'];

const text = (value, max) => String(value ?? '').slice(0, max);

function blank() {
    return {
        enabled: false,
        secret: '',
        identity: null,
        owner: null,
        cursor: '',
        agentId: '',
        chats: {},
    };
}

function cleanSection(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const out = blank();
    out.enabled = Boolean(source.enabled);
    // Version 1 kept Telegram's token, bot and offset under these names.
    out.secret = typeof source.secret === 'string' ? source.secret : (typeof source.token === 'string' ? source.token : '');
    const identity = source.identity || source.bot;
    if (identity && typeof identity === 'object' && identity.id) {
        out.identity = {};
        for (const [key, value] of Object.entries(identity).slice(0, 12)) {
            if (/^[A-Za-z]{1,32}$/.test(key) && ['string', 'number'].includes(typeof value)) out.identity[key] = text(value, 300);
        }
        out.identity.id = text(identity.id, 200);
    }
    const owner = source.owner;
    if (owner && typeof owner === 'object' && owner.userId && String(owner.userId) !== 'NaN' && !/^0*$/.test(String(owner.userId))) {
        out.owner = {
            userId: text(owner.userId, 200),
            chatId: text(owner.chatId || owner.userId, 200),
            name: text(owner.name, 128),
            username: text(owner.username, 128),
            pairedAt: Number(owner.pairedAt) || 0,
        };
    }
    const cursor = source.cursor ?? (Number(source.offset) > 0 ? String(source.offset) : '');
    out.cursor = text(cursor, 2000);
    out.agentId = text(source.agentId, 120);
    // `approvals` (ask / agent), from before turns from a chat simply ran in
    // the conversation's mode, is dropped here.
    if (source.chats && typeof source.chats === 'object') {
        for (const [chatId, chat] of Object.entries(source.chats)) {
            if (!/^[\w!:.@+=-]{1,200}$/.test(chatId) || !chat || typeof chat !== 'object') continue;
            out.chats[chatId] = {
                conversationId: text(chat.conversationId, 120),
                agentId: text(chat.agentId, 120),
            };
        }
    }
    return out;
}

/**
 * The store. `dir` is where the file lives; `crypt` encrypts and decrypts
 * the credentials (the vault in the app, a stand-in in the tests).
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
        state = { version: VERSION };
        for (const name of NAMES) state[name] = cleanSection(parsed?.[name]);
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

    /** One channel's section, with the same calls each gateway uses. */
    function section(name) {
        if (!NAMES.includes(name)) throw new Error(`No channel called ${name}`);
        return {
            get: () => load()[name],
            update(patch) {
                const current = load();
                current[name] = cleanSection({ ...current[name], ...patch });
                save();
                return current[name];
            },
            /** The credentials in the clear, or null while locked or when there are none. */
            credentials() {
                const stored = load()[name].secret;
                if (!stored) return null;
                try {
                    const plain = crypt.decrypt(stored);
                    if (!plain) return null;
                    // Version 1 sealed Telegram's bare token.
                    if (!plain.startsWith('{')) return { token: plain };
                    return JSON.parse(plain);
                } catch {
                    return null;
                }
            },
            /** Throws when the vault is locked: credentials that were not stored must not look stored. */
            setCredentials(credentials) {
                const current = load();
                const sealed = credentials ? crypt.encrypt(JSON.stringify(credentials)) : '';
                current[name] = cleanSection({ ...current[name], secret: sealed });
                save();
            },
            chat(chatId) {
                return load()[name].chats[String(chatId)] || { conversationId: '', agentId: '' };
            },
            setChat(chatId, patch) {
                const current = load();
                const key = String(chatId);
                current[name].chats[key] = { ...(current[name].chats[key] || { conversationId: '', agentId: '' }), ...patch };
                save();
                return current[name].chats[key];
            },
        };
    }

    return {
        section,
        /** For the tests: read the file again. */
        reload() {
            state = null;
            return load();
        },
    };
}

module.exports = { createConfig, cleanSection, NAMES };

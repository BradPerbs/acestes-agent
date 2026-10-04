/**
 * What a new conversation starts on, per agent.
 *
 * First an explicitly chosen default, set on the settings page: it is the
 * newer decision, made for exactly this purpose, so it wins over the
 * remembered pick. A model picked inside a chat then applies to that chat
 * only. With no default set, the chip's last pick wins, and before any pick
 * the agent's own default answers.
 *
 * The remembered pick is held beside the agent's settings rather than written
 * over them: the chip still never moves the agent's settings. The default it
 * was picked against is kept with it, and once that default changes on the
 * settings page the remembered pick gives way to it, since that is the newer
 * decision.
 */

const KEY = 'assistant.lastModel';

const base = (settings) => `${settings?.provider || ''}|${settings?.model || ''}`;

function readAll() {
    try {
        const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

/** The pick to start a new conversation on, or null for the agent's default. */
export function lastModel(agentId, settings) {
    if (!agentId || !settings) return null;
    const on = settings.providers?.length ? settings.providers : [settings.provider];
    // An explicitly chosen default model is what new conversations start on,
    // whatever was picked inside some other chat since.
    if (settings.model && on.includes(settings.provider)) {
        return { provider: settings.provider, model: settings.model, effort: settings.effort };
    }
    const entry = readAll()[agentId];
    if (!entry?.pin?.model || entry.base !== base(settings)) return null;
    // A runtime switched off since is not one to start on.
    if (entry.pin.provider && !on.includes(entry.pin.provider)) return null;
    // Nor an account taken out of the menu since: the new conversation goes
    // on the agent's own choice instead.
    if (entry.pin.account) {
        const provider = entry.pin.provider || settings.provider;
        // Nothing chosen is the machine's own login, which is `default`.
        const offered = entry.pin.account === (settings.accounts?.[provider] || 'default')
            || (settings.menuAccounts?.[provider] || []).includes(entry.pin.account);
        if (!offered) {
            const rest = { ...entry.pin };
            delete rest.account;
            return rest;
        }
    }
    return entry.pin;
}

/** `pin` is `{ provider, model, effort, account }`, as the chip pins a conversation. */
export function rememberModel(agentId, settings, pin) {
    if (!agentId || !settings || !pin?.model) return;
    const clean = Object.fromEntries(
        ['provider', 'model', 'effort', 'account'].filter(field => pin[field]).map(field => [field, pin[field]]),
    );
    try {
        localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [agentId]: { pin: clean, base: base(settings) } }));
    } catch {
        // Storage refused: the next conversation starts on the default.
    }
}

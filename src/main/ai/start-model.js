const { app } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * The model a new conversation starts on, for the whole app.
 *
 * Two picks, kept apart from any agent's settings:
 *
 *   starred  the default someone pinned with the star in the model menu
 *   last     the model last picked in a composer, or last sent with
 *
 * A conversation someone opens (a new tab of any agent, a fresh chat in a
 * tab, a fork of another) starts on the starred one, else the last one, else
 * its agent's own default. Neither is held per agent: the model somebody is
 * working with is the one they want in the next tab, whichever agent that is.
 * A pick whose runtime has been switched off since is passed over, and a
 * sign-in the agent does not have ticked is dropped from it, so the
 * conversation runs on that runtime under the agent's own account instead.
 *
 * Only a named model is kept. A pin with no model would take the agent's
 * default model, which can belong to another runtime altogether.
 */

const FIELDS = ['provider', 'model', 'effort', 'account'];
const file = () => path.join(app.getPath('userData'), 'start-model.json');

let held = null;
const listeners = new Set();

/** `{ provider, model, effort?, account? }`, or null when it does not name a model. */
function clean(pin) {
    if (!pin || typeof pin !== 'object') return null;
    const out = {};
    for (const field of FIELDS) {
        const value = pin[field];
        if (typeof value === 'string' && value.trim()) out[field] = value.trim().slice(0, field === 'model' ? 120 : 80);
    }
    return out.provider && out.model ? out : null;
}

function load() {
    if (held) return held;
    held = { starred: null, last: null };
    try {
        const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
        held = { starred: clean(raw?.starred), last: clean(raw?.last) };
    } catch {
        // Nothing yet, or unreadable: every agent starts on its own default.
    }
    return held;
}

function persist() {
    const target = file();
    const tmp = `${target}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(held, null, 2), 'utf8');
        fs.renameSync(tmp, target);
    } catch (error) {
        console.error('Could not save the start model:', error.message);
    }
}

const same = (a, b) => FIELDS.every(field => (a?.[field] || '') === (b?.[field] || ''));

function change(field, pin) {
    load();
    if (same(held[field], pin)) return false;
    held = { ...held, [field]: pin };
    persist();
    for (const listener of listeners) {
        try { listener(get()); } catch { /* a listener never fails the write */ }
    }
    return true;
}

/** Both picks, as stored. */
function get() {
    const current = load();
    return { starred: current.starred ? { ...current.starred } : null, last: current.last ? { ...current.last } : null };
}

/** The model just picked or sent with. A pin naming no model leaves the last one. */
function remember(pin) {
    const next = clean(pin);
    return next ? change('last', next) : false;
}

/** Pin a default for every new conversation, or let go of it with null. */
function star(pin) {
    return change('starred', pin ? clean(pin) : null);
}

/**
 * What a new conversation of an agent with these settings starts on, or null
 * for the agent's own default. `accountOk(provider, account)` says whether
 * the agent can run on that sign-in.
 */
function pickFor(current, accountOk = () => true) {
    const on = current?.providers?.length ? current.providers : [current?.provider].filter(Boolean);
    const { starred, last } = load();
    for (const pin of [starred, last]) {
        if (!pin || !on.includes(pin.provider)) continue;
        const out = { provider: pin.provider, model: pin.model };
        if (pin.effort) out.effort = pin.effort;
        if (pin.account && accountOk(pin.provider, pin.account)) out.account = pin.account;
        return out;
    }
    return null;
}

/** Told `{ starred, last }` whenever either changes. Returns the way to stop. */
function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

module.exports = {
    get,
    remember,
    star,
    pickFor,
    onChange,
    _test: { reset: () => { held = null; listeners.clear(); } },
};

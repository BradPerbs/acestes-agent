const { app } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * What a new conversation starts on: the model, the effort and the mode.
 *
 * Held for the whole app, apart from any agent's settings:
 *
 *   last     the model last picked in a composer, or last sent with
 *   effort   the effort last picked or sent with, on any model
 *   mode     the approval mode last picked or sent with
 *
 * And per agent, in its settings: `starred`, the model, effort and mode
 * someone pinned with the star in that agent's model menu.
 *
 * A conversation someone opens (a new tab, a fresh chat in a tab, a fork of
 * another) starts on its agent's star when it has one: that model, at that
 * effort, in that mode. Otherwise on the last model used in any tab of any
 * agent, at the last effort and in the last mode, since what somebody is
 * working with is what they want in the next tab; and before anything has
 * been used, on the agent's own defaults. A level the model does not take is
 * rounded down by the runtime, as the chip shows it.
 *
 * Older builds kept one star for the whole app here. It is handed to the
 * agents once (`takeLegacyStar`) and not kept.
 *
 * A model pick whose runtime has been switched off since is passed over, and
 * a sign-in the agent does not have ticked is dropped from it, so the
 * conversation runs on that runtime under the agent's own account instead.
 * Only a named model is kept as a pick: a pin with no model would take the
 * agent's default model, which can belong to another runtime altogether.
 *
 * Conversations a job makes are not started here: a job runs under its own
 * policy. One an agent opens takes the mode of the conversation it came from
 * when it is the same agent's, and its own agent's mode otherwise.
 */

const FIELDS = ['provider', 'model', 'effort', 'account'];
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const MODES = new Set(['always', 'writes', 'never', 'full']);
const file = () => path.join(app.getPath('userData'), 'start-model.json');

let held = null;
/** A whole-app star an older build left in the file, until it is handed on. */
let legacyStar = null;
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

const effortOf = value => (EFFORTS.has(value) ? value : '');
const modeOf = value => (MODES.has(value) ? value : '');

function load() {
    if (held) return held;
    held = { last: null, effort: '', mode: '' };
    try {
        const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
        const last = clean(raw?.last);
        legacyStar = clean(raw?.starred);
        held = {
            last,
            // A file from before the effort was kept on its own still has
            // the last one, on the last model.
            effort: effortOf(raw?.effort) || effortOf(last?.effort),
            mode: modeOf(raw?.mode),
        };
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

/** Keep `next` and tell the listeners, unless it is what is held already. */
function commit(next) {
    load();
    const moved = !same(held.last, next.last)
        || held.effort !== next.effort || held.mode !== next.mode;
    if (!moved) return false;
    held = next;
    persist();
    announce();
    return true;
}

/** Tell the listeners what is held now. A star moving on an agent says so too. */
function announce() {
    for (const listener of listeners) {
        try { listener(get()); } catch { /* a listener never fails the write */ }
    }
}

/** Everything held, as stored. */
function get() {
    const current = load();
    return {
        last: current.last ? { ...current.last } : null,
        effort: current.effort || '',
        mode: current.mode || '',
    };
}

/**
 * What was just picked or sent with: `{ provider, model, effort, account,
 * approval }`, any of them. A named model becomes the last model; an effort
 * and a mode are kept on their own, so a pick of either alone counts too.
 */
function remember(pin) {
    load();
    const next = { ...held };
    const model = clean(pin);
    if (model) next.last = model;
    const effort = effortOf(pin?.effort);
    if (effort) next.effort = effort;
    const mode = modeOf(pin?.approval);
    if (mode) next.mode = mode;
    return commit(next);
}

/**
 * The whole-app star an older build kept, once, and then gone from the file:
 * whoever asks hands it to the agents. Null when there was none.
 */
function takeLegacyStar() {
    load();
    const star = legacyStar;
    if (!star) return null;
    legacyStar = null;
    persist();
    return { ...star };
}

/**
 * What a new conversation of an agent with these settings starts on, as a
 * pin for setConversationModel (`{ provider?, model?, effort?, account?,
 * approval? }`), or null for the agent's own defaults throughout.
 * `accountOk(provider, account)` says whether the agent can run on that
 * sign-in.
 *
 * The agent's star, when its runtime is on, decides all three: its model,
 * and its effort and mode where it names them, else the last ones used. A
 * star on a runtime switched off is passed over whole.
 */
function pickFor(current, accountOk = () => true) {
    // An empty list is nothing switched on, not "fall back to the selected one".
    const on = Array.isArray(current?.providers) ? current.providers : [current?.provider].filter(Boolean);
    const { last, effort, mode } = load();
    const own = clean(current?.starred);
    const star = own && on.includes(own.provider) ? own : null;
    const out = {};
    for (const pin of [star, last]) {
        if (!pin || !on.includes(pin.provider)) continue;
        out.provider = pin.provider;
        out.model = pin.model;
        if (pin.account && accountOk(pin.provider, pin.account)) out.account = pin.account;
        break;
    }
    const chosenEffort = effortOf(star?.effort) || effort;
    const chosenMode = (star && modeOf(current.starred.approval)) || mode;
    if (chosenEffort) out.effort = chosenEffort;
    if (chosenMode) out.approval = chosenMode;
    return Object.keys(out).length ? out : null;
}

/** Told what `get` says whenever any of it changes. Returns the way to stop. */
function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

module.exports = {
    get,
    remember,
    takeLegacyStar,
    pickFor,
    onChange,
    announce,
    _test: { reset: () => { held = null; legacyStar = null; listeners.clear(); } },
};

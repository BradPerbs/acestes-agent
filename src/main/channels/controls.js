const modelMatch = require('../ai/model-match');

/**
 * What a chat can see and change of how its conversation runs: the model,
 * how hard it thinks, and what it may do before asking. The same three
 * things the composer's chips hold, held the same way:
 *
 *   - the model and the effort are pinned on the conversation
 *     (setConversationModel), so the chat moving them leaves every other
 *     conversation on its own, as a pick in one tab does
 *   - the mode is the agent's, one switch the desktop and the phone both
 *     read, as the approval chip is
 *
 * Built on the assistant core and its settings, given rather than required,
 * so the tests can stand them in.
 */

/** Named as the composer names them (assistant.effort* in the locales). */
const EFFORTS = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max' },
    { value: 'ultra', label: 'Ultra' },
];

/** Named as the composer's approval menu names them (assistant.approval*). */
const MODES = [
    { value: 'always', label: 'Ask every time', hint: 'every tool call waits for you' },
    { value: 'writes', label: 'Workspace only', hint: 'only stop external calls' },
    { value: 'never', label: 'Yolo Mode', hint: 'nothing stops, deletes included' },
    { value: 'full', label: 'Full Access', hint: 'any folder, any command; only blocked ones stop' },
];

/** The words a mode is typed as, after `/mode`. */
const MODE_WORDS = {
    always: 'always', ask: 'always', askeverytime: 'always', every: 'always', strict: 'always',
    writes: 'writes', workspace: 'writes', workspaceonly: 'writes', default: 'writes', normal: 'writes',
    never: 'never', yolo: 'never', yolomode: 'never', auto: 'never',
    full: 'full', fullaccess: 'full', unrestricted: 'full',
};

/** What each runtime is called (PROVIDER_NAMES in the renderer's ai-catalog). */
const PROVIDER_NAMES = {
    'claude-code': 'Claude Code',
    'claude-desktop': 'Claude Desktop',
    codex: 'Codex',
    cursor: 'Cursor',
    antigravity: 'Antigravity',
    muse: 'Muse Code',
    opencode: 'OpenCode',
    grok: 'Grok Build',
    kimi: 'Kimi Code',
    qwen: 'Qwen Code',
    vibe: 'Mistral Vibe',
    pi: 'Pi',
    local: 'Local model',
    openai: 'OpenAI-compatible API',
};
const PROVIDER_ORDER = Object.keys(PROVIDER_NAMES);

/** The most rows a model menu offers; the rest are reached by name. */
const MENU_ROWS = 30;
/** How long a menu waits on a runtime that has to start to say its models. */
const CATALOG_WAIT = 8000;

const fold = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** An alias with its context window dropped: `opus[1m]` is `opus`. */
const bare = id => String(id || '').replace(/\[[^\]]*\]/g, '');

/** Whether a row is the one a saved model id names (covers() in ai-catalog). */
function covers(row, value) {
    if (row.value === value) return true;
    const target = bare(value);
    if (!target) return false;
    const resolved = bare(row.resolved || row.value);
    return resolved === target || resolved.startsWith(`${target}-`);
}

/** The row a saved model id names, or the runtime's preferred one for none. */
function modelRow(rows, value) {
    if (!Array.isArray(rows)) return null;
    if (!value) return rows.find(row => row.preferred) || null;
    return rows.find(row => row.value === value) || rows.find(row => covers(row, value)) || null;
}

/** The levels a model takes; all of them when it does not say. */
function effortStops(row) {
    if (!row || !Array.isArray(row.effort)) return EFFORTS;
    return EFFORTS.filter(option => row.effort.includes(option.value));
}

/** A saved level rounded down onto a model's scale, as the runtime does. */
function nearestEffort(stops, value) {
    if (stops.length === 0) return value;
    if (stops.some(option => option.value === value)) return value;
    const wanted = EFFORTS.findIndex(option => option.value === value);
    const target = wanted < 0 ? EFFORTS.length - 1 : wanted;
    for (let index = stops.length - 1; index >= 0; index -= 1) {
        if (EFFORTS.findIndex(option => option.value === stops[index].value) <= target) return stops[index].value;
    }
    return stops[0].value;
}

/** An effort as typed ("extra high", "x-high", "xhigh"), or ''. */
function readEffort(text) {
    const word = fold(text);
    if (word === 'extrahigh' || word === 'veryhigh') return 'xhigh';
    if (word === 'med') return 'medium';
    if (word === 'maximum') return 'max';
    return EFFORTS.find(option => option.value === word)?.value || '';
}

/** A mode as typed ("yolo", "full access", "ask"), or ''. */
const readMode = text => MODE_WORDS[fold(text)] || '';

const modeOf = value => MODES.find(mode => mode.value === value) || MODES[1];
const effortOf = value => EFFORTS.find(option => option.value === value) || null;

/**
 * The controls, given what they drive.
 *
 *   ai          history, startPick, models, setConversationModel: the core
 *   settings    get(agentId), set(patch, agentId), takePropagation()
 *   reconfigure the core's, told when a mode changes so live runs follow it
 *   notify      the window's broadcast, so the composer's chip moves too
 *   record      an activity-log entry, for a mode changed from a chat
 */
function createControls({ ai, settings, reconfigure = () => {}, notify = () => {}, record = () => {}, catalogWait = CATALOG_WAIT } = {}) {
    const runtimeName = provider => PROVIDER_NAMES[provider] || provider || 'the agent';

    /** One runtime's model rows, or null when it has not said in time. */
    async function rowsFor(provider) {
        let timer = null;
        try {
            const rows = await Promise.race([
                Promise.resolve(ai.models({ provider })),
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve(null), catalogWait);
                    timer.unref?.();
                }),
            ]);
            return Array.isArray(rows) && rows.length ? rows : null;
        } catch {
            return null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * What a chat's next message runs on: the agent's settings with the
     * conversation's pin over them, or, before there is a conversation, the
     * pick a new one starts on (see conversationFor in gateway.js).
     */
    function current({ agentId, conversationId }) {
        const found = conversationId ? ai.history(conversationId) : null;
        const own = settings.get(found?.found ? found.agentId : agentId);
        const pin = (found?.found ? found.pinned : ai.startPick?.(own.agentId)) || {};
        const provider = pin.provider || own.provider;
        // A pin onto another runtime with no model named runs on that
        // runtime's own default, not on the agent's model for its own.
        const model = pin.model || (provider === own.provider ? own.model : '');
        return {
            agentId: own.agentId,
            conversationId: found?.found ? conversationId : '',
            provider,
            model: model || '',
            effort: pin.effort || own.effort || '',
            approval: own.approval,
            providers: Array.isArray(own.providers) && own.providers.length ? own.providers : [provider],
            hiddenModels: own.hiddenModels || {},
        };
    }

    /**
     * The three settings as a chat shows them. `strict` is the channel's
     * own rule (approvals 'ask'): a mode that asks nothing is held to
     * Workspace only for turns from the chat. See channelSettings in
     * ai/index.js.
     */
    async function describe({ agentId, conversationId, strict = true }) {
        const now = current({ agentId, conversationId });
        const row = modelRow(await rowsFor(now.provider), now.model);
        const stops = effortStops(row);
        const effort = stops.length ? nearestEffort(stops, now.effort) : '';
        const mode = modeOf(now.approval);
        const held = Boolean(strict) && (mode.value === 'never' || mode.value === 'full');
        return {
            agentId: now.agentId,
            provider: now.provider,
            runtime: runtimeName(now.provider),
            model: row?.value || now.model,
            modelLabel: row?.label || now.model || `${runtimeName(now.provider)} default`,
            effort,
            effortLabel: effortOf(effort)?.label || '',
            efforts: stops.map(option => ({ ...option })),
            mode: mode.value,
            modeLabel: mode.label,
            modeHint: mode.hint,
            heldTo: held ? { ...MODES[1] } : null,
            runtimes: now.providers.length,
        };
    }

    /** The catalogs of every runtime the agent has on, in the menu's order. */
    async function catalogs(now) {
        const order = [
            ...PROVIDER_ORDER.filter(provider => now.providers.includes(provider)),
            ...now.providers.filter(provider => !PROVIDER_ORDER.includes(provider)),
        ];
        return Promise.all(order.map(async provider => ({ provider, rows: (await rowsFor(provider)) || [] })));
    }

    /**
     * The rows for a chat's model menu: every runtime the agent has on, the
     * models hidden on the settings page left out, the current one kept.
     */
    async function models({ agentId, conversationId }) {
        const now = current({ agentId, conversationId });
        const lists = await catalogs(now);
        const several = lists.filter(list => list.rows.length > 0).length > 1;
        const rows = [];
        for (const { provider, rows: list } of lists) {
            const hidden = Array.isArray(now.hiddenModels[provider]) ? now.hiddenModels[provider] : [];
            const chosen = provider === now.provider ? modelRow(list, now.model) : null;
            for (const row of list) {
                const isCurrent = row === chosen;
                if (hidden.includes(row.value) && !isCurrent) continue;
                rows.push({
                    provider,
                    value: row.value,
                    label: several ? `${runtimeName(provider)}: ${row.label || row.value}` : (row.label || row.value),
                    current: isCurrent,
                });
            }
        }
        // The current one is never cut off the end of a long list.
        const shown = rows.slice(0, MENU_ROWS);
        const chosen = rows.find(row => row.current);
        if (chosen && !shown.includes(chosen)) shown[shown.length - 1] = chosen;
        return { rows: shown, total: rows.length };
    }

    /**
     * Put a conversation on a model, the effort carried over and rounded
     * onto the new model's scale unless one is named.
     */
    async function setModel({ conversationId, provider, model, effort = '' }) {
        if (!conversationId) return { error: 'There is no conversation to set it on.' };
        const now = current({ conversationId });
        const row = modelRow(await rowsFor(provider), model);
        const stops = effortStops(row);
        const level = effort && stops.some(option => option.value === effort) ? effort : nearestEffort(stops, now.effort);
        const result = ai.setConversationModel(conversationId, { provider, model, ...(level ? { effort: level } : {}) });
        if (result?.error) return { error: result.error };
        return describe({ conversationId, strict: false });
    }

    /** A model as typed ("opus", "gpt-5 codex high"), matched like start_task's. */
    async function findModel({ agentId, conversationId, query }) {
        const now = current({ agentId, conversationId });
        const lists = await catalogs(now);
        if (lists.every(list => list.rows.length === 0)) {
            return { error: `${runtimeName(now.provider)} has not said which models it has yet. Try again in a moment.` };
        }
        return modelMatch.matchModel(lists, query, { providerOrder: now.providers });
    }

    /** Set a conversation's effort, if its model takes that level. */
    async function setEffort({ conversationId, effort }) {
        if (!conversationId) return { error: 'There is no conversation to set it on.' };
        const level = readEffort(effort);
        if (!level) return { error: `"${effort}" is not an effort. Try low, medium, high, xhigh or max.` };
        const shown = await describe({ conversationId, strict: false });
        if (shown.efforts.length === 0) return { error: `${shown.modelLabel} has no effort setting.` };
        if (!shown.efforts.some(option => option.value === level)) {
            return { error: `${shown.modelLabel} takes ${shown.efforts.map(option => option.label.toLowerCase()).join(', ')}.` };
        }
        const result = ai.setConversationModel(conversationId, { effort: level });
        if (result?.error) return { error: result.error };
        return { ...shown, effort: level, effortLabel: effortOf(level).label };
    }

    /**
     * Change the agent's mode, as the approval chip does: the agent's own
     * setting, so the desktop shows it too, logged like any widening.
     */
    function setMode({ agentId, mode, via = 'a chat' }) {
        const value = readMode(mode) || (MODES.some(entry => entry.value === mode) ? mode : '');
        if (!value) return { error: `"${mode}" is not a mode. Try ask, workspace, yolo or full.` };
        const before = settings.get(agentId);
        if (before.approval !== value) {
            const next = settings.set({ approval: value }, before.agentId);
            reconfigure(before, next, next.agentId);
            // A change on the Acestes agent fans out to the agents that
            // follow it (see settings.set); their live runs are told too.
            for (const moved of settings.takePropagation?.() || []) {
                if (moved.agentId !== next.agentId) reconfigure(moved.before, moved.after, moved.agentId);
            }
            record({
                detail: `Approvals: ${next.approval}, changed from ${via}`,
                changes: [{ field: 'approvals', from: before.approval, to: next.approval }],
            });
            // The selected agent's, which is what the panels hold; each
            // re-reads its own agent's on hearing it.
            notify('ai-settings', settings.get());
        }
        const shown = modeOf(value);
        return { mode: shown.value, modeLabel: shown.label, modeHint: shown.hint, changed: before.approval !== value };
    }

    return { describe, models, setModel, findModel, setEffort, setMode, runtimeName };
}

module.exports = {
    createControls,
    EFFORTS,
    MODES,
    PROVIDER_NAMES,
    readEffort,
    readMode,
    effortStops,
    nearestEffort,
    modelRow,
};

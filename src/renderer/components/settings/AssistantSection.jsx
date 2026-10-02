import { useCallback, useEffect, useRef, useState } from 'react';
import { PROVIDER_ORDER } from '../../lib/ai-catalog';
import ProviderPicker from './ProviderPicker';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import Toggle from './ui/Toggle';
import Slider from './ui/Slider';
import SegmentedControl from '../ui/SegmentedControl';
import Button from '../ui/Button';
import Reveal from '../ui/Reveal';
import SandboxCard from './SandboxCard';
import HooksCard from './HooksCard';
import AccountsCard from './AccountsCard';
import VoiceCard from './VoiceCard';
import { useT } from '../../i18n';

/**
 * How the assistant is set up.
 *
 * Every control here changes something that outlives the conversation it was
 * changed during, which is what makes this a settings page rather than a menu
 * on the panel: the approval policy is a property of the app, not of the chat
 * that happens to be open.
 *
 * The model and the effort are not here, though they are stored the same way.
 * They live in the composer, because they are the two people change mid
 * conversation and walking to a settings page to do it costs the thread they
 * were pulling on. Having them in both places meant two controls for one
 * setting, each having to be told when the other moved.
 *
 * There is no API key on this page and no card for signing in. The assistant
 * runs the agents that are already installed and already signed in on this
 * machine, and nothing else: an agent that is not there is refused when it is
 * ticked, rather than accepted on the promise of a credential typed in
 * afterwards. A key box invited exactly that, and an agent switched on with
 * nothing behind it is a failure saved up for the middle of a question.
 */

/** The field look this page uses: the two text areas and the address box. */
const FIELD_CLASS = `w-full px-3 py-2 rounded-xl text-sm bg-white dark:bg-neutral-800
    border border-gray-300 dark:border-neutral-700
    text-gray-900 dark:text-gray-100 outline-none
    focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25`;

const APPROVALS = ['always', 'writes', 'never'];

const COMMAND_MODES = ['terminal', 'background'];

/** How fast the agent's cursor and typing go. See main/ai/computer.js. */
const COMPUTER_PACES = ['slow', 'normal', 'fast'];

/**
 * The shortest a "is this agent here" check is allowed to take.
 *
 * The work behind it is a walk over a few directories, which is a couple of
 * milliseconds, and a spinner that appears and disappears inside one frame is
 * not feedback, it is a flicker. The card would simply tick, or simply not,
 * with nothing on screen saying that anything had been looked for. This is long
 * enough to read as an answer and short enough not to be a wait.
 */
const CHECK_FLOOR = 400;

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default function AssistantSection() {
    const t = useT();
    const [settings, setSettings] = useState(null);
    // Which agents the main process actually has, so the picker offers what
    // exists rather than what is planned.
    const [providers, setProviders] = useState([]);
    const [tools, setTools] = useState([]);
    /** The agent being looked for right now, so its card can say so. */
    const [checking, setChecking] = useState('');
    /** The agent whose tick was refused, and why: `{ provider, reason }`. */
    const [rejected, setRejected] = useState(null);
    const [endpoint, setEndpoint] = useState('');
    const [endpointState, setEndpointState] = useState('');
    // The OpenAI-compatible API: its address, the key being typed (never
    // read back; the page only learns whether one is stored), and the result
    // of the last check.
    const [apiBase, setApiBase] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [apiState, setApiState] = useState('');
    const [commands, setCommands] = useState('');
    const [blocked, setBlocked] = useState('');
    const [prompts, setPrompts] = useState('');

    /**
     * The card a jump from the chat asked for. "Create quick prompts" on an
     * empty conversation lands here, and this page is long enough that
     * landing at its top would leave the person hunting. The card is scrolled
     * into view, lit for a moment, and its box given focus, once the settings
     * are in and the card exists.
     */
    const promptsRef = useRef(null);
    const promptsBoxRef = useRef(null);
    const [litPrompts, setLitPrompts] = useState(false);

    useEffect(() => {
        if (!settings) return undefined;
        let wanted = '';
        try {
            wanted = window.sessionStorage.getItem('settings.focus') || '';
            if (wanted) window.sessionStorage.removeItem('settings.focus');
        } catch {
            // No session storage: nothing to land on.
        }
        if (wanted !== 'quickPrompts') return undefined;

        promptsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        promptsBoxRef.current?.focus({ preventScroll: true });
        setLitPrompts(true);
        const timer = setTimeout(() => setLitPrompts(false), 1800);
        return () => clearTimeout(timer);
    }, [settings]);

    useEffect(() => {
        let cancelled = false;
        window.api.ai.status().then((status) => {
            if (cancelled || !status) return;
            setSettings(status.settings);
            setProviders(status.providers || []);
            setTools(status.tools || []);
            setEndpoint(status.settings.localBaseUrl || '');
            setApiBase(status.settings.apiBaseUrl || '');
            setCommands((status.settings.autoApproveCommands || []).join('\n'));
            setBlocked((status.settings.blockedCommands || []).join('\n'));
            setPrompts((status.settings.quickPrompts || []).join('\n'));
        }).catch(() => {});

        return () => { cancelled = true; };
    }, []);

    // The composer changes the model, the effort and the approvals from its own
    // controls while this page is open behind it. The two text areas are left
    // alone deliberately: resyncing them would take away what someone is
    // halfway through typing.
    useEffect(() => window.api.ai.onSettings(setSettings), []);

    const update = useCallback(async (patch) => {
        const next = await window.api.ai.setSettings(patch);
        setSettings(next);
        return next;
    }, []);

    /**
     * Switch one agent on or off.
     *
     * The list is what goes over, not the agent that was clicked, so main is
     * never left working out which of two states a name meant. Switching off
     * the agent that is answering is allowed: main moves the conversation to
     * the first one still on, since the alternative is a model menu offering
     * nothing that can run.
     *
     * Switching one on asks main whether it is there first, and the tick does
     * not take if it is not. An agent that was never installed used to be
     * switchable on, and said so days later in the middle of a question; the
     * one moment a person can do anything about it is the moment they are
     * looking at the setting.
     *
     * Switching off asks nothing. An agent that has gone missing is exactly
     * the one you would want to be able to untick.
     */
    const toggleProvider = useCallback(async (provider) => {
        const on = settings?.providers || [];
        setRejected(null);

        if (on.includes(provider)) {
            const next = on.filter(name => name !== provider);
            // The picker will not offer the click that empties the list, and
            // main would refuse it anyway. Guarded here as well so the three of
            // them agree rather than relying on the one furthest from it.
            if (next.length === 0) return;
            update({ providers: next });
            return;
        }

        setChecking(provider);
        const [verdict] = await Promise.all([
            window.api.ai.detect(provider).catch(() => null),
            pause(CHECK_FLOOR),
        ]);
        setChecking('');

        if (!verdict?.ok) {
            setRejected({ provider, reason: verdict?.reason || 'error' });
            return;
        }
        update({ providers: [...on, provider] });
    }, [settings?.providers, update]);

    /**
     * Save the address, then say what is listening at it.
     *
     * The check is the point of the button. An address that is one digit out
     * looks exactly like a correct one until a conversation fails several
     * minutes later, and asking the server for its model list is the cheapest
     * question that can tell the two apart.
     */
    const saveEndpoint = useCallback(async () => {
        const next = await update({ localBaseUrl: endpoint });
        setEndpoint(next.localBaseUrl || '');
        setEndpointState(t('settings.assistant.endpointChecking'));

        // Named, because the local server is not necessarily the agent that is
        // answering: it can be switched on beside three others and still be the
        // one whose address is being checked.
        const rows = await window.api.ai.models({ provider: 'local', refresh: true }).catch(() => null);
        setEndpointState(rows?.length
            ? t('settings.assistant.endpointFound', { count: rows.length })
            : t('settings.assistant.endpointNone'));
    }, [endpoint, update, t]);

    /**
     * Save the API's address and, if one was typed, its key, then ask it
     * for its models. The key field is emptied once stored: the page never
     * holds a secret longer than the save.
     */
    const saveApi = useCallback(async () => {
        const patch = { apiBaseUrl: apiBase };
        if (apiKey.trim()) {
            patch.apiKey = apiKey.trim();
            patch.apiKeyFor = 'openai';
        }
        const next = await update(patch);
        setApiBase(next.apiBaseUrl || '');
        if (next.keyError) {
            setApiState(next.keyError);
            return;
        }
        setApiKey('');
        if (!next.apiKeys?.openai) {
            setApiState(t('settings.assistant.apiNoKey'));
            return;
        }
        setApiState(t('settings.assistant.endpointChecking'));
        const rows = await window.api.ai.models({ provider: 'openai', refresh: true }).catch(() => null);
        setApiState(rows?.length
            ? t('settings.assistant.endpointFound', { count: rows.length })
            : t('settings.assistant.apiNone'));
    }, [apiBase, apiKey, update, t]);

    const clearApiKey = useCallback(async () => {
        const next = await update({ apiKey: '', apiKeyFor: 'openai' });
        setApiKey('');
        setApiState(next.apiKeys?.openai ? '' : t('settings.assistant.apiCleared'));
    }, [update, t]);

    const saveCommands = useCallback(async () => {
        const list = commands.split('\n').map(line => line.trim()).filter(Boolean);
        const next = await update({ autoApproveCommands: list });
        setCommands((next.autoApproveCommands || []).join('\n'));
    }, [commands, update]);

    const saveBlocked = useCallback(async () => {
        const list = blocked.split('\n').map(line => line.trim()).filter(Boolean);
        const next = await update({ blockedCommands: list });
        setBlocked((next.blockedCommands || []).join('\n'));
    }, [blocked, update]);

    /**
     * Back to what the app shipped with.
     *
     * Both lists are free to be emptied or rewritten, which is the point of
     * them. What that leaves is no way back: once the seeded entries are gone
     * there is nothing on screen that remembers what they were. Main sends the
     * defaults with the settings so this does not need its own copy of them.
     */
    const restoreCommands = useCallback(async () => {
        const next = await update({ autoApproveCommands: settings.defaults.autoApproveCommands });
        setCommands((next.autoApproveCommands || []).join('\n'));
    }, [settings?.defaults, update]);

    const restoreBlocked = useCallback(async () => {
        const next = await update({ blockedCommands: settings.defaults.blockedCommands });
        setBlocked((next.blockedCommands || []).join('\n'));
    }, [settings?.defaults, update]);

    const savePrompts = useCallback(async () => {
        const list = prompts.split('\n').map(line => line.trim()).filter(Boolean);
        const next = await update({ quickPrompts: list });
        setPrompts((next.quickPrompts || []).join('\n'));
    }, [prompts, update]);

    if (!settings) {
        return (
            <SettingCard>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('settings.assistant.loading')}
                </p>
            </SettingCard>
        );
    }

    const readOnlyTools = tools.filter(tool => tool.readOnly).length;

    // In the order the cards are drawn rather than the order they were switched
    // on in, so the set the page shows and the set the composer's menu offers
    // read as one list rather than two.
    const activated = PROVIDER_ORDER.filter(name => (settings.providers || []).includes(name));

    // Offered only once a list has actually moved away from the shipped one,
    // so the row is not carrying a button that would do nothing. Compared
    // against what is saved rather than what is in the box, because a list
    // someone is halfway through typing has not changed anything yet.
    const sameAsDefault = (list, fallback) => (list || []).join('\n') === (fallback || []).join('\n');
    const canRestoreCommands = settings.defaults
        && !sameAsDefault(settings.autoApproveCommands, settings.defaults.autoApproveCommands);
    const canRestoreBlocked = settings.defaults
        && !sameAsDefault(settings.blockedCommands, settings.defaults.blockedCommands);

    return (
        <>
            {/* Before everything, because it decides whether any of it is on
                screen. Its own card rather than a row on the one below, since
                it is not a property of the agents: it is whether the app has an
                assistant in it at all.

                The page stays as it is when this goes off. Somebody switching
                it off has not asked to lose what they set up, and somebody
                switching it back on should find it the way they left it. */}
            <SettingCard>
                <SettingRow
                    align="center"
                    title={t('settings.assistant.show')}
                    description={t('settings.assistant.showDesc')}
                    control={
                        <Toggle
                            ariaLabel={t('settings.assistant.show')}
                            checked={settings.enabled}
                            onChange={(value) => update({ enabled: value })}
                        />
                    }
                />
            </SettingCard>

            {/* First of the agent settings, because it decides what everything
                under it means: the models, the effort scale and the shape of a
                tool call all belong to whichever agent is running. */}
            <SettingCard>
                <SettingRow
                    title={t('settings.assistant.agent')}
                    description={t('settings.assistant.agentDesc')}
                >
                    <ProviderPicker
                        values={activated}
                        available={providers}
                        checking={checking}
                        rejected={rejected}
                        onToggle={toggleProvider}
                    />
                </SettingRow>

                {/* Only for the one agent that has no installer to find it by.
                    The other five are somewhere on the machine or they are
                    not; this one is wherever the user said it is. It opens
                    rather than appearing, because it belongs to the card
                    above it and a row that blinks into existence reads as the
                    page having been rebuilt.

                    Open on a refusal as well as on the tick, because this row
                    is the only thing that can answer one: a server listening on
                    some other port is refused for an address the user cannot
                    reach, which is a dead end rather than a check. */}
                <Reveal open={activated.includes('local') || rejected?.provider === 'local'}>
                    <SettingRow
                        className={DIVIDED}
                        title={t('settings.assistant.endpoint')}
                        description={t('settings.assistant.endpointDesc')}
                    >
                        <div className="space-y-3">
                            <div className="flex gap-3">
                                <input
                                    type="text"
                                    aria-label={t('settings.assistant.endpoint')}
                                    autoComplete="off"
                                    spellCheck={false}
                                    placeholder="http://localhost:1234/v1"
                                    className={`${FIELD_CLASS} flex-1 font-jetbrains text-xs`}
                                    value={endpoint}
                                    onChange={(event) => {
                                        setEndpoint(event.target.value);
                                        setEndpointState('');
                                    }}
                                />
                                <Button size="md" variant="secondary" onClick={saveEndpoint}>
                                    {t('common.save')}
                                </Button>
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {endpointState || t('settings.assistant.endpointNote')}
                            </p>
                        </div>
                    </SettingRow>
                </Reveal>

                {/* The other runtime with nothing on the machine to find: an
                    address and a key. OpenRouter is the placeholder because it
                    reaches every model; any OpenAI-shaped API does. */}
                <Reveal open={activated.includes('openai') || rejected?.provider === 'openai'}>
                    <SettingRow
                        className={DIVIDED}
                        title={t('settings.assistant.api')}
                        description={t('settings.assistant.apiDesc')}
                    >
                        <div className="space-y-3">
                            <input
                                type="text"
                                aria-label={t('settings.assistant.apiAddress')}
                                autoComplete="off"
                                spellCheck={false}
                                placeholder="https://openrouter.ai/api/v1"
                                className={`${FIELD_CLASS} w-full font-jetbrains text-xs`}
                                value={apiBase}
                                onChange={(event) => { setApiBase(event.target.value); setApiState(''); }}
                            />
                            <div className="flex gap-3">
                                <input
                                    type="password"
                                    aria-label={t('settings.assistant.apiKey')}
                                    autoComplete="off"
                                    spellCheck={false}
                                    placeholder={settings.apiKeys?.openai ? t('settings.assistant.apiKeyStored') : t('settings.assistant.apiKeyPlaceholder')}
                                    className={`${FIELD_CLASS} flex-1 font-jetbrains text-xs`}
                                    value={apiKey}
                                    onChange={(event) => { setApiKey(event.target.value); setApiState(''); }}
                                />
                                <Button size="md" variant="secondary" onClick={saveApi}>
                                    {t('common.save')}
                                </Button>
                                {settings.apiKeys?.openai && (
                                    <Button size="md" variant="ghost" onClick={clearApiKey}>
                                        {t('settings.assistant.apiKeyClear')}
                                    </Button>
                                )}
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {apiState || t('settings.assistant.apiNote')}
                            </p>
                        </div>
                    </SettingRow>
                </Reveal>
            </SettingCard>

            {/* Straight after the agents, because it is about them: which
                sign-in each one runs under, and how much of its plan is left. */}
            <AccountsCard providers={activated} settings={settings} onSettings={update} />

            <SettingCard>
                <SettingRow
                    title={t('settings.assistant.commandMode')}
                    description={t(`settings.assistant.commandMode.${settings.commandMode}.note`)}
                >
                    <SegmentedControl
                        ariaLabel={t('settings.assistant.commandMode')}
                        segments={COMMAND_MODES.map(value => ({
                            value,
                            label: t(`settings.assistant.commandMode.${value}`),
                        }))}
                        value={settings.commandMode}
                        onChange={(value) => update({ commandMode: value })}
                    />
                </SettingRow>

                <SettingRow
                    className={DIVIDED}
                    title={t('settings.assistant.approval')}
                    description={t(`settings.assistant.approval.${settings.approval}.note`)}
                >
                    <SegmentedControl
                        ariaLabel={t('settings.assistant.approval')}
                        segments={APPROVALS.map(value => ({
                            value,
                            label: t(`settings.assistant.approval.${value}`),
                        }))}
                        value={settings.approval}
                        onChange={(value) => update({ approval: value })}
                    />
                </SettingRow>

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.assistant.localTools')}
                    description={t('settings.assistant.localToolsDesc')}
                    control={
                        <Toggle
                            ariaLabel={t('settings.assistant.localTools')}
                            checked={settings.allowLocalTools}
                            onChange={(value) => update({ allowLocalTools: value })}
                        />
                    }
                />

                {/* The desktop itself: Windows and macOS, the systems there is a
                    helper for (tools/DesktopHelper.cs, tools/mac/). */}
                {['win32', 'darwin'].includes(window.api.platform) && (
                    <>
                        <SettingRow
                            className={DIVIDED}
                            align="center"
                            title={t('settings.assistant.computerUse')}
                            description={window.api.platform === 'darwin'
                                ? `${t('settings.assistant.computerUseDesc')} ${t('settings.assistant.computerUseMac')}`
                                : t('settings.assistant.computerUseDesc')}
                            control={
                                <Toggle
                                    ariaLabel={t('settings.assistant.computerUse')}
                                    checked={Boolean(settings.computerUse)}
                                    onChange={(value) => update({ computerUse: value })}
                                />
                            }
                        />
                        <Reveal open={Boolean(settings.computerUse)}>
                            <SettingRow
                                className={DIVIDED}
                                title={t('settings.assistant.computerPace')}
                                description={t('settings.assistant.computerPaceDesc')}
                            >
                                <SegmentedControl
                                    ariaLabel={t('settings.assistant.computerPace')}
                                    segments={COMPUTER_PACES.map(value => ({
                                        value,
                                        label: t(`settings.assistant.computerPace.${value}`),
                                    }))}
                                    value={settings.computerPace || 'normal'}
                                    onChange={(value) => update({ computerPace: value })}
                                />
                            </SettingRow>
                        </Reveal>
                    </>
                )}

                <SettingRow
                    className={DIVIDED}
                    title={t('settings.assistant.autoRemember')}
                    description={t('settings.assistant.autoRememberDesc')}
                    control={
                        <Toggle
                            ariaLabel={t('settings.assistant.autoRemember')}
                            checked={Boolean(settings.autoRemember)}
                            onChange={(value) => update({ autoRemember: value })}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.assistant.groupToolCalls')}
                    description={t('settings.assistant.groupToolCallsDesc')}
                    control={
                        <Toggle
                            ariaLabel={t('settings.assistant.groupToolCalls')}
                            checked={settings.groupToolCalls !== false}
                            onChange={(value) => update({ groupToolCalls: value })}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    title={t('settings.assistant.allowList')}
                    description={t('settings.assistant.allowListDesc')}
                >
                    <div className="space-y-3">
                        <textarea
                            aria-label={t('settings.assistant.allowList')}
                            rows={6}
                            spellCheck={false}
                            className={`${FIELD_CLASS} font-jetbrains text-xs leading-relaxed resize-y`}
                            value={commands}
                            onChange={(event) => setCommands(event.target.value)}
                        />
                        <div className="flex items-center gap-3">
                            <Button size="sm" variant="secondary" onClick={saveCommands}>
                                {t('settings.assistant.saveList')}
                            </Button>
                            {canRestoreCommands && (
                                <Button size="sm" variant="ghost" onClick={restoreCommands}>
                                    {t('settings.assistant.restoreDefaults')}
                                </Button>
                            )}
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                                {t('settings.assistant.allowListNote', {
                                    mode: t('settings.assistant.approval.writes'),
                                })}
                            </span>
                        </div>
                    </div>
                </SettingRow>

                <SettingRow
                    className={DIVIDED}
                    title={t('settings.assistant.blockList')}
                    description={t('settings.assistant.blockListDesc')}
                >
                    <div className="space-y-3">
                        <textarea
                            aria-label={t('settings.assistant.blockList')}
                            rows={4}
                            spellCheck={false}
                            placeholder={'rm -rf\nshutdown\nmkfs'}
                            className={`${FIELD_CLASS} font-jetbrains text-xs leading-relaxed resize-y
                                placeholder:text-gray-500 dark:placeholder:text-neutral-400`}
                            value={blocked}
                            onChange={(event) => setBlocked(event.target.value)}
                        />
                        <div className="flex items-center gap-3">
                            <Button size="sm" variant="secondary" onClick={saveBlocked}>
                                {t('settings.assistant.saveList')}
                            </Button>
                            {canRestoreBlocked && (
                                <Button size="sm" variant="ghost" onClick={restoreBlocked}>
                                    {t('settings.assistant.restoreDefaults')}
                                </Button>
                            )}
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                                {t('settings.assistant.blockListEmpty')}
                            </span>
                        </div>
                        {/* Said plainly, because a list like this invites the
                            belief that it is a wall. It stops the destructive
                            command that arrives by mistake, which is nearly all
                            of them. It cannot stop one that is trying not to be
                            recognised, and nothing here should be relied on as
                            though it could. */}
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                            {t('settings.assistant.blockListWarning')}
                        </p>
                    </div>
                </SettingRow>
            </SettingCard>

            <SandboxCard agentId={settings.agentId} />
            <HooksCard agentId={settings.agentId} />
            <VoiceCard settings={settings} update={update} fieldClass={FIELD_CLASS} />

            <div
                ref={promptsRef}
                className={`rounded-xl transition-shadow duration-500 ${litPrompts
                    ? 'ring-2 ring-offset-2 ring-gray-900/40 dark:ring-white/50 ring-offset-white dark:ring-offset-neutral-900'
                    : ''}`}
            >
            <SettingCard>
                <SettingRow
                    title={t('settings.assistant.quickPrompts')}
                    description={t('settings.assistant.quickPromptsDesc')}
                >
                    <div className="space-y-3">
                        <textarea
                            ref={promptsBoxRef}
                            aria-label={t('settings.assistant.quickPrompts')}
                            rows={5}
                            spellCheck={false}
                            placeholder={t('settings.assistant.quickPromptsPlaceholder')}
                            className={`${FIELD_CLASS} text-xs leading-relaxed resize-y
                                placeholder:text-gray-500 dark:placeholder:text-neutral-400`}
                            value={prompts}
                            onChange={(event) => setPrompts(event.target.value)}
                        />
                        <div className="flex items-center gap-3">
                            <Button size="sm" variant="secondary" onClick={savePrompts}>
                                {t('settings.assistant.savePrompts')}
                            </Button>
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                                {t('settings.assistant.quickPromptsNote')}
                            </span>
                        </div>
                    </div>
                </SettingRow>
            </SettingCard>
            </div>

            <SettingCard>
                <SettingRow
                    align="center"
                    title={t('settings.assistant.steps')}
                    description={t('settings.assistant.stepsDesc')}
                    control={
                        <Slider
                            ariaLabel={t('settings.assistant.steps')}
                            value={settings.maxTurns}
                            min={5}
                            max={100}
                            step={5}
                            onChange={(value) => update({ maxTurns: value })}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.assistant.lines')}
                    description={t('settings.assistant.linesDesc')}
                    control={
                        <Slider
                            ariaLabel={t('settings.assistant.lines')}
                            value={settings.transcriptLines}
                            min={40}
                            max={1000}
                            step={20}
                            onChange={(value) => update({ transcriptLines: value })}
                        />
                    }
                />
            </SettingCard>

            <SettingCard>
                <SettingRow
                    title={t('settings.assistant.tools')}
                    description={t('settings.assistant.toolsDesc', {
                        count: tools.length,
                        readOnly: readOnlyTools,
                    })}
                >
                    {/* Two across at the card's full width, one once it has
                        less: these names truncate, and half of a narrow card is
                        where they start truncating to nothing. */}
                    <ul className="grid gap-x-6 gap-y-2 grid-cols-[repeat(auto-fill,minmax(min(15rem,100%),1fr))]">
                        {tools.map(tool => (
                            <li key={tool.name} className="flex items-center gap-2 min-w-0">
                                <span
                                    aria-hidden="true"
                                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                        tool.readOnly ? 'bg-emerald-500' : 'bg-amber-500'
                                    }`}
                                />
                                <span className="text-sm text-gray-700 dark:text-gray-300 truncate">
                                    {tool.title}
                                </span>
                            </li>
                        ))}
                    </ul>
                </SettingRow>
            </SettingCard>
        </>
    );
}

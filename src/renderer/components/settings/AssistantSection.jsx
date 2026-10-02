import { useCallback, useEffect, useState } from 'react';
import { PROVIDER_ORDER } from '../../lib/ai-catalog';
import ProviderPicker from './ProviderPicker';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import LoadingCard from './ui/LoadingCard';
import Toggle from './ui/Toggle';
import Button from '../ui/Button';
import Reveal from '../ui/Reveal';
import AccountsCard from './AccountsCard';
import useAssistantSettings, { FIELD_CLASS } from './useAssistantSettings';
import { useT } from '../../i18n';

/**
 * How the assistant is set up: whether it is in the app at all, which agents
 * answer, and which account each one runs under.
 *
 * The rest of what used to be on this page has pages of its own beside it in
 * the settings list: what the agent may do without asking (Permissions), what
 * it can reach and operate (Agentic Use), and the chat itself (Chat & Voice).
 * One page of twenty cards had stopped being something anyone could find a
 * setting on.
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
    // `providers` is which agents the main process actually has, so the
    // picker offers what exists rather than what is planned. The composer
    // changes the model, the effort and the approvals from its own controls
    // while this page is open behind it, and the hook follows those.
    const { settings, providers, update } = useAssistantSettings();
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

    // The two addresses are filled once, when the settings arrive, and left
    // alone after: resyncing them on every push would take away what someone
    // is halfway through typing.
    const loaded = Boolean(settings);
    useEffect(() => {
        if (!settings) return;
        setEndpoint(settings.localBaseUrl || '');
        setApiBase(settings.apiBaseUrl || '');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded]);

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

    if (!settings) return <LoadingCard />;

    // In the order the cards are drawn rather than the order they were switched
    // on in, so the set the page shows and the set the composer's menu offers
    // read as one list rather than two.
    const activated = PROVIDER_ORDER.filter(name => (settings.providers || []).includes(name));

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
        </>
    );
}

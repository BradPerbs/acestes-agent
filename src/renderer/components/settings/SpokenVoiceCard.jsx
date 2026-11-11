import { useCallback, useEffect, useMemo, useState } from 'react';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import Select from '../ui/Select';
import Button from '../ui/Button';
import Reveal from '../ui/Reveal';
import SegmentedControl from '../ui/SegmentedControl';
import useTrySay, { spokenEngine, voiceOptions } from './useTrySay';
import { FIELD_CLASS as FIELD } from './useAssistantSettings';
import { useT } from '../../i18n';

/**
 * The voice things are said in out loud: the buddy's recap and the questions
 * it asks. This computer's own voices; ElevenLabs, on its own key; or one of
 * OpenRouter's speech models (ElevenLabs, Gemini, Deepgram, Grok, Kokoro and
 * more), on an OpenRouter key. Each keyed voice has its key (typed once, kept
 * in the keychain as `elevenlabs` or `openrouter`, never shown again), a
 * model, and a voice; ElevenLabs' and OpenRouter's choices are kept apart,
 * so switching between them loses neither. See main/ai/buddy.js.
 *
 * The tone (plain, friendly, funny...) is the buddy's, set with it under
 * Agentic Use: it shapes the words as much as the voice.
 */

/** ElevenLabs' models, by id, as offered (see main/ai/elevenlabs.js). */
const ELEVEN_MODELS = [
    { value: 'eleven_v4', label: 'Eleven v4' },
    { value: 'eleven_flash_v2_5', label: 'Flash v2.5' },
];

/** OpenRouter's model when none is picked (main/ai/openrouter-tts.js). */
const OPENROUTER_DEFAULT = 'elevenlabs/eleven-flash-v2.5';

const ERROR_CLASS = 'text-xs text-red-600 dark:text-red-400';

/**
 * A voice's key: pasted once into the keychain, never read back. With none
 * in the keychain, OpenRouter's may come from the OpenAI-compatible API's
 * own key, when that API is OpenRouter (`source` 'provider').
 */
function KeyRow({ engine, has, source = '', onStatus }) {
    const t = useT();
    const [key, setKey] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const save = async (value) => {
        setSaving(true);
        setError('');
        try {
            const next = await window.api.buddy.setVoiceKey(value, engine);
            if (next?.keyError) setError(next.keyError);
            else setKey('');
            onStatus(next);
        } finally {
            setSaving(false);
        }
    };

    const described = source === 'provider'
        ? t(`settings.speech.${engine}.keyProvider`)
        : has ? t(`settings.speech.${engine}.keySaved`) : t(`settings.speech.${engine}.keyDesc`);

    return (
        <SettingRow className={DIVIDED} title={t(`settings.speech.${engine}.key`)} description={described}>
            <div className="space-y-2">
                <div className="flex items-center gap-2">
                    <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={key}
                        onChange={event => setKey(event.target.value)}
                        onKeyDown={(event) => { if (event.key === 'Enter' && key.trim()) save(key); }}
                        placeholder={has || source ? t('settings.speech.keyReplace') : (engine === 'openrouter' ? 'sk-or-v1-...' : 'sk_...')}
                        aria-label={t(`settings.speech.${engine}.key`)}
                        className={`${FIELD} max-w-sm`}
                    />
                    <Button size="sm" variant="secondary" onClick={() => save(key)} disabled={saving || !key.trim()}>
                        {t('settings.speech.keySave')}
                    </Button>
                    {source === 'keychain' && (
                        <Button size="sm" variant="secondary" onClick={() => save('')} disabled={saving}>
                            {t('settings.speech.keyRemove')}
                        </Button>
                    )}
                </div>
                {error && <p className={ERROR_CLASS}>{error}</p>}
            </div>
        </SettingRow>
    );
}

/** ElevenLabs: its key, Eleven v4 or Flash, and a voice from the account's own list. */
function ElevenLabsSettings({ active, settings, update, status, onStatus }) {
    const t = useT();
    const hasKey = Boolean(status?.voiceKey);
    const [voices, setVoices] = useState(null);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setError('');
        const result = await window.api.buddy.voices();
        if (result?.error) {
            setVoices(null);
            setError(result.error);
        } else {
            setVoices(result?.voices || []);
        }
    }, []);

    // Asked only while ElevenLabs is the voice picked: it is a call on the account.
    useEffect(() => {
        if (active && hasKey) load();
    }, [active, hasKey, load]);

    return (
        <>
            <KeyRow engine="elevenlabs" has={hasKey} source={hasKey ? 'keychain' : ''} onStatus={onStatus} />

            <SettingRow
                className={DIVIDED}
                title={t('settings.speech.model')}
                description={t('settings.speech.elevenlabs.modelDesc')}
            >
                <SegmentedControl
                    ariaLabel={t('settings.speech.model')}
                    segments={ELEVEN_MODELS}
                    value={settings.buddyVoiceModel || 'eleven_v4'}
                    onChange={(value) => update({ buddyVoiceModel: value })}
                />
            </SettingRow>

            {hasKey && (
                <SettingRow
                    className={DIVIDED}
                    title={t('settings.speech.voice')}
                    description={t('settings.speech.elevenlabs.voiceDesc')}
                >
                    <div className="space-y-2">
                        <div className="w-72 max-w-full">
                            <Select
                                value={settings.buddyVoiceId || ''}
                                onChange={(value) => update({ buddyVoiceId: value })}
                                className={FIELD}
                                aria-label={t('settings.speech.voice')}
                                options={[
                                    { value: '', label: t('settings.speech.voiceFirst') },
                                    ...(voices || []).map(voice => ({
                                        value: voice.id,
                                        label: voice.category ? `${voice.name} · ${voice.category}` : voice.name,
                                    })),
                                ]}
                            />
                        </div>
                        {error && <p className={ERROR_CLASS}>{error}</p>}
                    </div>
                </SettingRow>
            )}
        </>
    );
}

/** A voice id as it reads: Microsoft's carry their model after a colon, which says nothing here. */
const voiceLabel = voice => String(voice).replace(/:.*$/, '');

/**
 * OpenRouter: its key, one of its speech models (grouped by who makes it,
 * each with its price), and one of that model's voices. The list needs no
 * key, so the models can be looked through before one is pasted.
 */
function OpenRouterSettings({ active, settings, update, status, onStatus }) {
    const t = useT();
    const source = status?.openrouterKey || '';
    const [models, setModels] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!active || models) return undefined;
        let gone = false;
        window.api.buddy.speechModels().then((result) => {
            if (gone) return;
            if (result?.error) setError(result.error);
            else setModels(result?.models || []);
        }).catch((failure) => {
            if (!gone) setError(failure?.message || String(failure));
        });
        return () => { gone = true; };
    }, [active, models]);

    const model = settings.buddyOpenRouterModel || OPENROUTER_DEFAULT;
    const row = (models || []).find(entry => entry.id === model) || null;

    const priced = useCallback((entry) => {
        if (entry.price === 0) return t('settings.speech.openrouter.free');
        if (typeof entry.price === 'number') return t('settings.speech.openrouter.price', { price: entry.price });
        return '';
    }, [t]);

    // Grouped by maker, the part of the name before the colon ("Google: Gemini 3.8 Flash TTS").
    const modelOptions = useMemo(() => {
        const out = [];
        let maker = '';
        const sorted = [...(models || [])].sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of sorted) {
            const [head, ...rest] = entry.name.split(': ');
            const group = rest.length ? head : entry.id.split('/')[0];
            if (group !== maker) {
                maker = group;
                out.push({ value: `heading:${group}`, label: group, heading: true });
            }
            const price = priced(entry);
            const name = rest.length ? rest.join(': ') : entry.name;
            out.push({ value: entry.id, label: price ? `${name} · ${price}` : name });
        }
        // The model set, when the list does not have it (gone, or the list did not come).
        if (!sorted.some(entry => entry.id === model)) out.unshift({ value: model, label: model });
        return out;
    }, [models, model, priced]);

    const voices = row?.voices || [];

    return (
        <>
            <KeyRow engine="openrouter" has={Boolean(source)} source={source} onStatus={onStatus} />

            <SettingRow
                className={DIVIDED}
                title={t('settings.speech.model')}
                description={t('settings.speech.openrouter.modelDesc')}
            >
                <div className="space-y-2">
                    <div className="w-80 max-w-full">
                        <Select
                            value={model}
                            onChange={(value) => update({ buddyOpenRouterModel: value, buddyOpenRouterVoice: '' })}
                            className={FIELD}
                            aria-label={t('settings.speech.model')}
                            options={modelOptions}
                        />
                    </div>
                    {models === null && !error && <p className="text-xs text-gray-500 dark:text-gray-400">{t('settings.speech.openrouter.loading')}</p>}
                    {error && <p className={ERROR_CLASS}>{error}</p>}
                </div>
            </SettingRow>

            {row && (
                <SettingRow
                    className={DIVIDED}
                    title={t('settings.speech.voice')}
                    description={voices.length ? t('settings.speech.openrouter.voiceDesc') : t('settings.speech.openrouter.voiceOwn')}
                >
                    {voices.length > 0 && (
                        <div className="w-72 max-w-full">
                            <Select
                                value={voices.includes(settings.buddyOpenRouterVoice) ? settings.buddyOpenRouterVoice : ''}
                                onChange={(value) => update({ buddyOpenRouterVoice: value })}
                                className={FIELD}
                                aria-label={t('settings.speech.voice')}
                                options={[
                                    { value: '', label: t('settings.speech.openrouter.voiceFirst', { voice: voiceLabel(voices[0]) }) },
                                    ...voices.map(voice => ({ value: voice, label: voiceLabel(voice) })),
                                ]}
                            />
                        </div>
                    )}
                </SettingRow>
            )}
        </>
    );
}

export default function SpokenVoiceCard({ settings, update }) {
    const t = useT();
    const engine = spokenEngine(settings);
    const [status, setStatus] = useState(null);
    const trySay = useTrySay();

    // The keys are looked for as the buddy's agent sees them, so read again when that changes.
    const check = useCallback(() => {
        window.api.buddy?.status().then(setStatus).catch(() => setStatus(null));
    }, []);
    useEffect(() => {
        check();
    }, [check, settings.agentId, settings.buddyAgent, settings.apiBaseUrl]);

    // In the tone set with the buddy, so it is heard as it will be.
    const tryIt = () => trySay.run({
        ...voiceOptions(settings),
        tone: settings.buddyTone || 'neutral',
        note: settings.buddyToneNote || '',
    });

    return (
        <SettingCard>
            <SettingRow
                title={t('settings.speech.title')}
                description={t('settings.speech.desc')}
            />

            <SettingRow
                className={DIVIDED}
                title={t('settings.speech.engine')}
                description={t(`settings.speech.engine.${engine}`)}
            >
                <SegmentedControl
                    ariaLabel={t('settings.speech.engine')}
                    segments={[
                        { value: 'system', label: t('settings.speech.engineSystem') },
                        { value: 'elevenlabs', label: 'ElevenLabs' },
                        { value: 'openrouter', label: 'OpenRouter' },
                    ]}
                    value={engine}
                    onChange={(value) => update({ buddyVoice: value })}
                />
            </SettingRow>

            <Reveal open={engine === 'elevenlabs'}>
                <ElevenLabsSettings active={engine === 'elevenlabs'} settings={settings} update={update} status={status} onStatus={setStatus} />
            </Reveal>

            <Reveal open={engine === 'openrouter'}>
                <OpenRouterSettings active={engine === 'openrouter'} settings={settings} update={update} status={status} onStatus={setStatus} />
            </Reveal>

            <SettingRow
                className={DIVIDED}
                align="center"
                title={t('settings.speech.try')}
                description={t('settings.speech.tryDesc')}
                control={(
                    <Button size="sm" variant="secondary" onClick={tryIt} disabled={trySay.trying}>
                        {trySay.trying ? t('settings.speech.trying') : t('settings.speech.tryButton')}
                    </Button>
                )}
            />
            {trySay.error && <p className={`${ERROR_CLASS} px-4 pb-3`}>{trySay.error}</p>}
        </SettingCard>
    );
}

import { useCallback, useEffect, useState } from 'react';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import Toggle from './ui/Toggle';
import SegmentedControl from '../ui/SegmentedControl';
import Select from '../ui/Select';
import Button from '../ui/Button';
import Reveal from '../ui/Reveal';
import { useT } from '../../i18n';

/**
 * Voice input: the composer's microphone, and who turns speech into text.
 *
 * On from the start. Three engines, all on this machine (see
 * main/ai/speech.js): Parakeet, the default, which writes as the user talks
 * and downloads its model on the first use or from here; the built-in
 * Whisper, for the languages Parakeet does not know; and Faster-Whisper,
 * which runs through Python. For that one this card says whether Python and
 * the package are there, and offers to install the package, showing pip's
 * output as it goes. Model and language are the Whispers' to choose; Parakeet
 * has the one model and tells the language itself.
 */

const ENGINES = ['parakeet', 'whisper', 'faster-whisper'];

const megabytes = bytes => `${Math.round(bytes / 1e6)} MB`;

/** The sizes each engine offers: past small the built-in one is too slow on a CPU. */
const MODELS = {
    whisper: ['tiny', 'base', 'small'],
    'faster-whisper': ['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'],
};

/** Languages to pin it to, by Whisper's code. Empty is the default. */
const LANGUAGES = [
    ['en', 'English'], ['it', 'Italiano'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
    ['pt', 'Português'], ['ru', 'Русский'], ['vi', 'Tiếng Việt'], ['zh', '中文'], ['ja', '日本語'],
    ['ko', '한국어'], ['nl', 'Nederlands'], ['pl', 'Polski'], ['tr', 'Türkçe'], ['id', 'Bahasa Indonesia'],
    ['tl', 'Tagalog'], ['uk', 'Українська'], ['ar', 'العربية'], ['hi', 'हिन्दी'],
];

export default function VoiceCard({ settings, update, fieldClass }) {
    const t = useT();
    const engine = settings.voiceEngine || 'parakeet';
    const whispering = engine !== 'parakeet';
    const models = MODELS[engine] || MODELS.whisper;
    const model = models.includes(settings.voiceModel) ? settings.voiceModel : (models.includes('base') ? 'base' : models[0]);

    // Each engine's footing: Parakeet's model on disk; for Faster-Whisper,
    // Python found and the package in it.
    const [engines, setEngines] = useState(null);
    const status = engines?.fasterWhisper || null;
    const [installing, setInstalling] = useState(false);
    const [installLine, setInstallLine] = useState('');
    const [installError, setInstallError] = useState('');
    const [percent, setPercent] = useState(null);
    const [downloadError, setDownloadError] = useState('');

    const check = useCallback(async (fresh = false) => {
        try {
            setEngines(await window.api.ai.speechStatus?.({ fresh }) || null);
        } catch {
            setEngines(null);
        }
    }, []);

    useEffect(() => {
        if (settings.voiceInput && engine !== 'whisper') check();
    }, [settings.voiceInput, engine, check]);

    useEffect(() => window.api.ai.onSpeech?.((next) => {
        if (next?.state === 'installing') setInstallLine(next.line || '');
        if (next?.state === 'downloading') setPercent(next.percent);
        if (next?.state === 'downloaded') {
            setPercent(null);
            check();
        }
    }), [check]);

    const download = async () => {
        setDownloadError('');
        setPercent(0);
        const result = await window.api.ai.speechDownload?.();
        setPercent(null);
        if (!result?.ok) setDownloadError(result?.error || t('settings.voice.downloadFailed'));
        check();
    };

    const install = async () => {
        setInstalling(true);
        setInstallError('');
        setInstallLine('');
        try {
            const result = await window.api.ai.speechInstall?.();
            if (!result?.ok) setInstallError(result?.error || t('settings.voice.installFailed'));
        } finally {
            setInstalling(false);
            check(true);
        }
    };

    // A size the other engine does not offer is carried over as the nearest it does.
    const switchEngine = (next) => {
        const offered = MODELS[next];
        update({ voiceEngine: next, ...(!offered || offered.includes(settings.voiceModel) ? {} : { voiceModel: 'small' }) });
    };
    const parakeet = engines?.parakeet;

    const ready = engine !== 'faster-whisper' || Boolean(status?.installed);

    return (
        <SettingCard>
            <SettingRow
                align="center"
                title={t('settings.voice.title')}
                description={t('settings.voice.desc')}
                control={(
                    <Toggle
                        ariaLabel={t('settings.voice.title')}
                        checked={Boolean(settings.voiceInput)}
                        onChange={(value) => update({ voiceInput: value })}
                    />
                )}
            />

            <Reveal open={Boolean(settings.voiceInput)}>
                <SettingRow
                    className={DIVIDED}
                    title={t('settings.voice.engine')}
                    description={t(`settings.voice.engine.${engine}.note`)}
                >
                    <div className="space-y-3">
                        <SegmentedControl
                            ariaLabel={t('settings.voice.engine')}
                            segments={ENGINES.map(value => ({ value, label: t(`settings.voice.engine.${value}`) }))}
                            value={engine}
                            onChange={switchEngine}
                        />
                        {engine === 'parakeet' && parakeet && (
                            <div className="space-y-2 text-xs text-gray-500 dark:text-gray-400">
                                {parakeet.installed ? (
                                    <span>{t('settings.voice.parakeetReady', { size: megabytes(parakeet.size) })}</span>
                                ) : (
                                    <div className="flex items-center gap-3">
                                        <Button size="sm" variant="secondary" onClick={download} disabled={percent !== null}>
                                            {percent !== null ? t('settings.voice.downloading', { percent }) : t('settings.voice.download')}
                                        </Button>
                                        <span>{t('settings.voice.parakeetMissing', { size: megabytes(parakeet.size) })}</span>
                                    </div>
                                )}
                                {downloadError && (
                                    <div className="text-red-600 dark:text-red-400 whitespace-pre-wrap">{downloadError}</div>
                                )}
                            </div>
                        )}
                        {engine === 'faster-whisper' && (
                            <div className="space-y-2 text-xs text-gray-500 dark:text-gray-400">
                                {status === null ? (
                                    <span>{t('settings.voice.checking')}</span>
                                ) : !status.python ? (
                                    <span className="text-amber-600 dark:text-amber-400">{t('settings.voice.noPython')}</span>
                                ) : status.installed ? (
                                    <span>{t('settings.voice.installed', { version: status.installed, python: status.python })}</span>
                                ) : (
                                    <div className="flex items-center gap-3">
                                        <Button size="sm" variant="secondary" onClick={install} disabled={installing}>
                                            {installing ? t('settings.voice.installing') : t('settings.voice.install')}
                                        </Button>
                                        <span>{t('settings.voice.notInstalled', { python: status.python })}</span>
                                    </div>
                                )}
                                {installing && installLine && (
                                    <div className="font-jetbrains text-[11px] truncate">{installLine}</div>
                                )}
                                {installError && (
                                    <div className="text-red-600 dark:text-red-400 whitespace-pre-wrap">{installError}</div>
                                )}
                            </div>
                        )}
                    </div>
                </SettingRow>

                {whispering && (
                    <>
                        <SettingRow
                            className={DIVIDED}
                            title={t('settings.voice.model')}
                            description={t('settings.voice.modelDesc')}
                        >
                            <SegmentedControl
                                ariaLabel={t('settings.voice.model')}
                                segments={models.map(value => ({ value, label: t(`settings.voice.model.${value}`) }))}
                                value={model}
                                onChange={(value) => update({ voiceModel: value })}
                            />
                        </SettingRow>

                        <SettingRow
                            className={DIVIDED}
                            title={t('settings.voice.language')}
                            description={t(`settings.voice.languageDesc.${engine}`)}
                        >
                            <Select
                                value={settings.voiceLanguage || ''}
                                onChange={(value) => update({ voiceLanguage: value })}
                                className={fieldClass}
                                options={[
                                    { value: '', label: t(engine === 'faster-whisper' ? 'settings.voice.detect' : 'settings.voice.appLanguage') },
                                    ...LANGUAGES.map(([value, label]) => ({ value, label })),
                                ]}
                            />
                        </SettingRow>
                    </>
                )}

                {!ready && (
                    <div className="px-4 pb-3 text-xs text-amber-600 dark:text-amber-400">
                        {t('settings.voice.notReady')}
                    </div>
                )}
            </Reveal>
        </SettingCard>
    );
}

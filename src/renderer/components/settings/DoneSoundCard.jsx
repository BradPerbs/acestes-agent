import { useEffect, useRef, useState } from 'react';
import { PlayIcon } from 'hugeicons-react';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import Slider from './ui/Slider';
import Select from '../ui/Select';
import { IconButton } from '../ui/Button';
import { DEFAULT_SOUND, DEFAULT_VOLUME, SOUND_GROUPS, SOUND_IDS, playSound } from '../../lib/sounds';
import { useT } from '../../i18n';

/** How long the volume slider rests before the new level is saved and heard. */
const SETTLE_MS = 300;

/**
 * What a finished task sounds like, and how loud.
 *
 * Played with the notification for a task that finished while you were
 * looking elsewhere. Picking a sound plays it, so the list can be auditioned
 * from the keyboard; the button beside it plays it again. The volume is held
 * here while it is dragged and saved once the slider rests, so the store is
 * not written on every pixel.
 */
export default function DoneSoundCard({ settings, update, fieldClass }) {
    const t = useT();
    const sound = SOUND_IDS.includes(settings.doneSound) ? settings.doneSound : DEFAULT_SOUND;
    const saved = Number.isFinite(settings.doneSoundVolume) ? settings.doneSoundVolume : DEFAULT_VOLUME;

    const [volume, setVolume] = useState(saved);
    const timer = useRef(null);

    // Another window changing it lands here too, unless a drag is under way.
    useEffect(() => {
        if (!timer.current) setVolume(saved);
    }, [saved]);
    useEffect(() => () => clearTimeout(timer.current), []);

    const choose = (next) => {
        update({ doneSound: next });
        playSound(next, volume);
    };

    const slide = (next) => {
        setVolume(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            timer.current = null;
            update({ doneSoundVolume: next });
            playSound(sound, next);
        }, SETTLE_MS);
    };

    const off = sound === 'off';

    // Under a heading per group, "No sound" on its own at the end.
    const label = id => ({ value: id, label: t(`settings.chat.sound.${id}`) });
    const options = [
        ...SOUND_GROUPS.flatMap(group => [
            { value: `group:${group.id}`, label: t(`settings.chat.soundGroup.${group.id}`), heading: true },
            ...group.sounds.map(label),
        ]),
        { value: 'group:none', label: '', heading: true },
        label('off'),
    ];

    return (
        <SettingCard>
            <SettingRow
                title={t('settings.chat.doneSound')}
                description={t('settings.chat.doneSoundDesc')}
            >
                <div className="flex items-center gap-2 max-w-sm">
                    <Select
                        value={sound}
                        onChange={choose}
                        className={fieldClass}
                        containerClassName="flex-1"
                        aria-label={t('settings.chat.doneSound')}
                        options={options}
                    />
                    <IconButton
                        variant="outline"
                        title={t('settings.chat.doneSoundPlay')}
                        icon={<PlayIcon size={15} strokeWidth={2} />}
                        disabled={off}
                        onClick={() => playSound(sound, volume)}
                    />
                </div>
            </SettingRow>

            {!off && (
                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.chat.doneSoundVolume')}
                    control={
                        <Slider
                            min={0}
                            max={100}
                            step={5}
                            value={volume}
                            onChange={slide}
                            format={(value) => `${value}%`}
                            ariaLabel={t('settings.chat.doneSoundVolume')}
                        />
                    }
                />
            )}
        </SettingCard>
    );
}

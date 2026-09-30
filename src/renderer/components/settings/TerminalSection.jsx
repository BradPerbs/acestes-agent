import toast from 'react-hot-toast';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import Slider from './ui/Slider';
import Toggle from './ui/Toggle';
import SegmentedControl from '../ui/SegmentedControl';
import Select from '../ui/Select';
import {
    CUSTOM_THEME_ID,
    TERMINAL_THEMES,
    sanitizeCustomTheme,
} from '../../hooks/useTerminalTheme';
import {
    CURSOR_STYLES,
    DEFAULT_TERMINAL_SETTINGS,
    LIMITS,
    LINK_ACTIVATIONS,
    resolveFontFamily,
} from '../../hooks/useTerminalSettings';
import { MODIFIER_KEY } from '../../lib/platform';
import { toastOptions } from '../../lib/toast';
import { useT } from '../../i18n';

/**
 * What the sample renders, chosen so that every setting on this page shows up
 * in it: a ligature pair, a zero to tell apart from an O, and enough
 * punctuation for letter spacing to be visible.
 */
const SAMPLE = 'if (x != 0) => ~/.ssh/config';

export default function TerminalSection({
    terminalTheme,
    customTerminalTheme,
    terminalSettings = DEFAULT_TERMINAL_SETTINGS,
    terminalFonts = [],
    onTerminalSettingsChange,
    onTerminalSettingsReset,
}) {
    const t = useT();

    const customColors = sanitizeCustomTheme(customTerminalTheme);
    const customSelected = terminalTheme === CUSTOM_THEME_ID;

    // The sample is drawn on the scheme the terminal is actually using, so the
    // weight and spacing are judged against the background they will sit on.
    const themeColors = customSelected
        ? customColors
        : (TERMINAL_THEMES[terminalTheme] || TERMINAL_THEMES.dark || {});

    const chosenFont = terminalFonts.find(font => font.id === terminalSettings.fontFamily);
    const set = (patch) => onTerminalSettingsChange?.(patch);

    const isDefault = Object.keys(DEFAULT_TERMINAL_SETTINGS)
        .every(key => terminalSettings[key] === DEFAULT_TERMINAL_SETTINGS[key]);

    return (
        <>
            {/* ---------------- Type ---------------- */}
            <SettingCard>
                <SettingRow
                    title={t('settings.terminal.font')}
                    description={chosenFont?.available === false
                        ? t('settings.terminal.fontMissing')
                        : t('settings.terminal.fontDesc')}
                >
                    {/* The sample sits above the picker rather than beside it:
                        every control in this card changes how this line renders,
                        so it wants the full width and a fixed place on the page. */}
                    <div className="flex flex-col gap-3">
                        <div
                            className="rounded-xl px-4 py-3 overflow-x-auto border border-gray-200 dark:border-neutral-700"
                            style={{ backgroundColor: themeColors.background }}
                        >
                            <div
                                style={{
                                    color: themeColors.foreground,
                                    fontFamily: resolveFontFamily(terminalSettings.fontFamily),
                                    fontSize: `${terminalSettings.fontSize}px`,
                                    fontWeight: terminalSettings.fontWeight,
                                    lineHeight: terminalSettings.lineHeight,
                                    letterSpacing: `${terminalSettings.letterSpacing}px`,
                                    fontVariantLigatures: terminalSettings.ligatures ? 'contextual common-ligatures' : 'none',
                                    fontFeatureSettings: terminalSettings.ligatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0',
                                    whiteSpace: 'pre',
                                }}
                            >
                                {SAMPLE}
                            </div>
                        </div>

                        <Select
                            id="terminal-font-family"
                            aria-label={t('settings.terminal.fontAria')}
                            className="w-full px-3 py-2 rounded-xl text-sm bg-white dark:bg-neutral-800
                                border border-gray-300 dark:border-neutral-700
                                text-gray-900 dark:text-gray-100 outline-none
                                focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25"
                            value={terminalSettings.fontFamily}
                            onChange={(fontFamily) => set({ fontFamily })}
                            options={terminalFonts.map(font => ({
                                value: font.id,
                                label: font.label
                                    + (font.bundled ? ` (${t('settings.terminal.fontBundled')})` : '')
                                    + (font.available === false
                                        ? ` (${t('settings.terminal.fontNotInstalled')})`
                                        : ''),
                            }))}
                        />
                    </div>
                </SettingRow>

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.terminal.size')}
                    description={t('settings.terminal.sizeDesc')}
                    control={
                        <Slider
                            id="terminal-font-size"
                            ariaLabel={t('settings.terminal.sizeAria')}
                            value={terminalSettings.fontSize}
                            {...LIMITS.fontSize}
                            onChange={(fontSize) => set({ fontSize })}
                            format={(value) => `${value} px`}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.terminal.weight')}
                    description={t('settings.terminal.weightDesc')}
                    control={
                        <Slider
                            ariaLabel={t('settings.terminal.weightAria')}
                            value={terminalSettings.fontWeight}
                            {...LIMITS.fontWeight}
                            onChange={(fontWeight) => set({ fontWeight })}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.terminal.lineHeight')}
                    description={t('settings.terminal.lineHeightDesc')}
                    control={
                        <Slider
                            ariaLabel={t('settings.terminal.lineHeightAria')}
                            value={terminalSettings.lineHeight}
                            {...LIMITS.lineHeight}
                            onChange={(lineHeight) => set({ lineHeight })}
                            format={(value) => value.toFixed(2)}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.terminal.letterSpacing')}
                    description={t('settings.terminal.letterSpacingDesc')}
                    control={
                        <Slider
                            ariaLabel={t('settings.terminal.letterSpacingAria')}
                            value={terminalSettings.letterSpacing}
                            {...LIMITS.letterSpacing}
                            onChange={(letterSpacing) => set({ letterSpacing })}
                            format={(value) => `${value > 0 ? '+' : ''}${value.toFixed(1)}`}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.terminal.ligatures')}
                    description={chosenFont?.ligatures
                        ? t('settings.terminal.ligaturesDesc')
                        : t('settings.terminal.ligaturesNone', {
                            font: chosenFont?.label || t('settings.terminal.thisFont'),
                        })}
                    control={
                        <Toggle
                            checked={terminalSettings.ligatures}
                            onChange={(ligatures) => set({ ligatures })}
                            ariaLabel={t('settings.terminal.ligatures')}
                        />
                    }
                />
            </SettingCard>

            {/* ------------ Cursor, buffer, scrolling and links ------------ */}
            <SettingCard>
                <SettingRow
                    align="center"
                    title={t('settings.terminal.cursor')}
                    description={t('settings.terminal.cursorDesc')}
                    control={
                        <SegmentedControl
                            ariaLabel={t('settings.terminal.cursorAria')}
                            value={terminalSettings.cursorStyle}
                            onChange={(cursorStyle) => set({ cursorStyle })}
                            segments={CURSOR_STYLES.map(style => ({
                                value: style.id,
                                label: t(`settings.terminal.cursor.${style.id}`),
                            }))}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.terminal.blink')}
                    control={
                        <Toggle
                            checked={terminalSettings.cursorBlink}
                            onChange={(cursorBlink) => set({ cursorBlink })}
                            ariaLabel={t('settings.terminal.blink')}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.terminal.scrollback')}
                    description={t('settings.terminal.scrollbackDesc')}
                    control={
                        <Slider
                            ariaLabel={t('settings.terminal.scrollbackAria')}
                            value={terminalSettings.scrollback}
                            {...LIMITS.scrollback}
                            onChange={(scrollback) => set({ scrollback })}
                            format={(value) => (value >= 1000 ? `${Math.round(value / 1000)}k` : String(value))}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.terminal.smoothScroll')}
                    description={t('settings.terminal.smoothScrollDesc')}
                    control={
                        <Slider
                            ariaLabel={t('settings.terminal.smoothScrollAria')}
                            value={terminalSettings.smoothScrollDuration}
                            {...LIMITS.smoothScrollDuration}
                            onChange={(smoothScrollDuration) => set({ smoothScrollDuration })}
                            format={(value) => (value === 0
                                ? t('common.off')
                                : t('settings.terminal.smoothScrollMs', { value }))}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.terminal.links')}
                    description={t('settings.terminal.linksDesc', { modifier: MODIFIER_KEY })}
                    control={
                        <SegmentedControl
                            ariaLabel={t('settings.terminal.links')}
                            value={terminalSettings.linkActivation}
                            onChange={(linkActivation) => set({ linkActivation })}
                            segments={LINK_ACTIVATIONS.map(mode => ({
                                value: mode.id,
                                label: t(`settings.terminal.link.${mode.id}`, { modifier: MODIFIER_KEY }),
                            }))}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.terminal.reset')}
                    description={isDefault
                        ? t('settings.terminal.resetAlready')
                        : t('settings.terminal.resetDesc')}
                    control={
                        <button
                            className="px-4 py-2 rounded-xl text-sm font-semibold border border-gray-300
                                dark:border-neutral-700 text-gray-700 dark:text-gray-300 transition-all
                                active:scale-95 hover:bg-gray-50 dark:hover:bg-neutral-800
                                disabled:opacity-40 disabled:cursor-not-allowed"
                            disabled={isDefault}
                            onClick={() => {
                                onTerminalSettingsReset?.();
                                toast.success(t('settings.terminal.resetDone'), toastOptions());
                            }}
                        >
                            {t('common.reset')}
                        </button>
                    }
                />
            </SettingCard>
        </>
    );
}

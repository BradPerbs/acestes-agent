import { useState } from 'react';
import toast from 'react-hot-toast';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import CustomThemeDialog from './CustomThemeDialog';
import {
    CUSTOM_THEME_ID,
    TERMINAL_THEMES,
    TERMINAL_THEME_PRESETS,
    sanitizeCustomTheme,
} from '../../hooks/useTerminalTheme';
import { toastOptions } from '../../lib/toast';
import { useT } from '../../i18n';

const TERMINAL_THEME_OPTIONS = TERMINAL_THEME_PRESETS.map(option => ({
    ...option,
    ...TERMINAL_THEMES[option.id],
}));

// Themes light enough to vanish against the card need an outline of their own.
const LIGHT_THEMES = new Set(['light', 'github-light', 'solarized-light', 'gruvbox-light']);

/** The fake terminal on each tile: three lines of text over the background. */
function ThemeSwatch({ background, foreground, bordered, children }) {
    return (
        <div
            className={`w-full h-14 rounded-lg border overflow-hidden ${bordered ? 'border-gray-200' : 'border-transparent'}`}
            style={{ backgroundColor: background }}
        >
            <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <div style={{ height: '6px', width: '32px', borderRadius: '2px', backgroundColor: foreground }} />
                    <div style={{ height: '6px', width: '16px', borderRadius: '2px', backgroundColor: foreground }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <div style={{ height: '6px', width: '20px', borderRadius: '2px', backgroundColor: foreground }} />
                    <div style={{ height: '6px', width: '24px', borderRadius: '2px', backgroundColor: foreground }} />
                </div>
                {children || (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <div style={{ height: '6px', width: '40px', borderRadius: '2px', backgroundColor: foreground }} />
                    </div>
                )}
            </div>
        </div>
    );
}

const TILE_BASE = 'terminal-theme-option group flex flex-col items-center gap-2 p-2 rounded-xl border transition-all cursor-pointer';

const tileClass = (selected) => `${TILE_BASE} ${selected
    ? 'border-gray-900 dark:border-white ring-1 ring-gray-900 dark:ring-white'
    : 'border-gray-200 dark:border-neutral-700 hover:border-gray-300 dark:hover:border-neutral-600'}`;

const labelClass = (selected) => `text-xs text-center leading-tight ${selected
    ? 'font-bold text-gray-900 dark:text-white'
    : 'font-medium text-gray-600 dark:text-gray-400'}`;

/**
 * The terminal's colour scheme. Lives on the Appearance page beside the app's
 * own theme, since the two are chosen together: a shell drawn in one palette
 * inside a window drawn in another is the thing people come here to fix.
 */
export default function TerminalColorsCard({
    terminalTheme,
    customTerminalTheme,
    onTerminalThemeChange,
    onCustomTerminalThemeChange,
}) {
    const t = useT();
    const [editorOpen, setEditorOpen] = useState(false);

    const customColors = sanitizeCustomTheme(customTerminalTheme);
    const customSelected = terminalTheme === CUSTOM_THEME_ID;

    const applyCustomTheme = (colors) => {
        onCustomTerminalThemeChange(colors);
        setEditorOpen(false);
        if (!customSelected) onTerminalThemeChange(CUSTOM_THEME_ID);
        toast.success(t('settings.terminal.customApplied'), toastOptions());
    };

    return (
        <>
            <SettingCard>
                <SettingRow
                    title={t('settings.terminal.colors')}
                    description={t('settings.terminal.colorsDesc')}
                >
                    {/* Reflows on the column's own width rather than a fixed
                        count: at the 900px minimum window the content pane is
                        narrow enough that four fixed columns collide. The list
                        scrolls so the settings below it stay in reach. */}
                    <div
                        className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(104px,1fr))]
                            max-h-[26rem] overflow-y-auto pr-1 -mr-1"
                        id="terminal-theme-selector"
                    >
                        {TERMINAL_THEME_OPTIONS.map((option) => (
                            <button
                                key={option.id}
                                className={tileClass(terminalTheme === option.id)}
                                data-terminal-theme={option.id}
                                onClick={() => {
                                    onTerminalThemeChange(option.id);
                                    toast.success(
                                        t('settings.terminal.themeChanged', { theme: option.label }),
                                        toastOptions(),
                                    );
                                }}
                            >
                                <ThemeSwatch
                                    background={option.background}
                                    foreground={option.foreground}
                                    bordered={LIGHT_THEMES.has(option.id)}
                                />
                                <span className={labelClass(terminalTheme === option.id)}>
                                    {option.label}
                                </span>
                            </button>
                        ))}

                        {/* The user's own palette, shown with its ANSI colours so
                            it is recognisable rather than just "Custom". */}
                        <button
                            className={tileClass(customSelected)}
                            data-terminal-theme={CUSTOM_THEME_ID}
                            onClick={() => {
                                onTerminalThemeChange(CUSTOM_THEME_ID);
                                toast.success(
                                    t('settings.terminal.themeChanged', {
                                        theme: t('settings.terminal.custom'),
                                    }),
                                    toastOptions(),
                                );
                            }}
                        >
                            <ThemeSwatch
                                background={customColors.background}
                                foreground={customColors.foreground}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                                    {['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'].map(key => (
                                        <div
                                            key={key}
                                            style={{
                                                height: '6px',
                                                width: '6px',
                                                borderRadius: '999px',
                                                backgroundColor: customColors[key],
                                            }}
                                        />
                                    ))}
                                </div>
                            </ThemeSwatch>
                            <span className={labelClass(customSelected)}>
                                {t('settings.terminal.custom')}
                            </span>
                        </button>
                    </div>
                </SettingRow>

                <SettingRow
                    className={DIVIDED}
                    title={t('settings.terminal.customTheme')}
                    description={t('settings.terminal.customThemeDesc')}
                    align="center"
                    control={
                        <button
                            className="px-4 py-2 rounded-xl text-sm font-semibold border border-gray-300
                                dark:border-neutral-700 text-gray-700 dark:text-gray-300 transition-all
                                active:scale-95 hover:bg-gray-50 dark:hover:bg-neutral-800"
                            onClick={() => setEditorOpen(true)}
                        >
                            {t('settings.appearance.editColors')}
                        </button>
                    }
                />
            </SettingCard>

            {editorOpen && (
                <CustomThemeDialog
                    colors={customColors}
                    onSave={applyCustomTheme}
                    onClose={() => setEditorOpen(false)}
                />
            )}
        </>
    );
}

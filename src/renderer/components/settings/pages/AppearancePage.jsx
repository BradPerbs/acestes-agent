import { useState } from 'react';
import toast from 'react-hot-toast';
import SettingsPage from '../ui/SettingsPage';
import SettingCard from '../ui/SettingCard';
import SettingRow, { DIVIDED } from '../ui/SettingRow';
import AppColorsDialog from '../AppColorsDialog';
import TerminalColorsCard from '../TerminalColorsCard';
import { CUSTOM_THEME } from '../../../hooks/useTheme';
import {
    APP_COLOR_PRESETS,
    DEFAULT_APP_COLORS,
    matchPreset,
    sanitizeAppColors,
} from '../../../lib/app-colors';
import { toastOptions } from '../../../lib/toast';
import { useT } from '../../../i18n';

const THEME_OPTIONS = [
    { id: 'light', icon: 'sun' },
    { id: 'dark', icon: 'moon' },
    { id: 'system', icon: 'monitor' },
    { id: CUSTOM_THEME, icon: 'palette' },
];

function ThemeIcon({ type, colors }) {
    switch (type) {
        case 'sun':
            return (
                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="5" />
                    <line x1="12" y1="1" x2="12" y2="3" />
                    <line x1="12" y1="21" x2="12" y2="23" />
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                    <line x1="1" y1="12" x2="3" y2="12" />
                    <line x1="21" y1="12" x2="23" y2="12" />
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
            );
        case 'moon':
            return (
                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
            );
        case 'monitor':
            return (
                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
            );
        // Not a glyph but the palette itself, so the tile says which colours
        // choosing it would actually bring.
        case 'palette':
            return (
                <div className="w-6 h-6 rounded-lg overflow-hidden grid grid-cols-2 ring-1 ring-black/10 dark:ring-white/15">
                    {['base', 'raised', 'control', 'muted'].map(key => (
                        <div key={key} style={{ backgroundColor: colors[key] }} />
                    ))}
                </div>
            );
        default:
            return null;
    }
}

/** A palette as a small window: title bar, sidebar, card. */
function PaletteSwatch({ colors }) {
    return (
        <div
            className="w-full h-14 rounded-lg overflow-hidden p-1.5 flex flex-col gap-1"
            style={{ backgroundColor: colors.base }}
        >
            <div className="flex items-center gap-1">
                <div className="h-2.5 w-8 rounded" style={{ backgroundColor: colors.control }} />
                <div className="h-2.5 w-5 rounded" style={{ backgroundColor: colors.raised }} />
            </div>
            <div className="flex gap-1 flex-1">
                <div className="w-3 rounded" style={{ backgroundColor: colors.raised }} />
                <div className="flex-1 rounded p-1 flex flex-col gap-1" style={{ backgroundColor: colors.raised }}>
                    <div className="h-1 w-8 rounded-full" style={{ backgroundColor: colors.muted }} />
                    <div className="h-1.5 w-5 rounded" style={{ backgroundColor: colors.active }} />
                </div>
            </div>
        </div>
    );
}

const TILE_BASE = 'group flex flex-col items-center gap-2 p-2 rounded-xl border transition-all cursor-pointer';

const tileClass = (selected) => `${TILE_BASE} ${selected
    ? 'border-gray-900 dark:border-white ring-1 ring-gray-900 dark:ring-white'
    : 'border-gray-200 dark:border-neutral-700 hover:border-gray-300 dark:hover:border-neutral-600'}`;

const labelClass = (selected) => `text-xs text-center leading-tight ${selected
    ? 'font-bold text-gray-900 dark:text-white'
    : 'font-medium text-gray-600 dark:text-gray-400'}`;

export default function AppearancePage({
    theme,
    appColors,
    onThemeChange,
    onAppColorsChange,
    terminalTheme,
    customTerminalTheme,
    onTerminalThemeChange,
    onCustomTerminalThemeChange,
}) {
    const t = useT();
    const [editorOpen, setEditorOpen] = useState(false);

    const colors = sanitizeAppColors(appColors || DEFAULT_APP_COLORS);
    const customSelected = theme === CUSTOM_THEME;
    // On Light, Dark or System no palette is in use, so none is marked.
    const activePreset = customSelected ? matchPreset(colors) : null;

    const applyColors = (next, message) => {
        onAppColorsChange?.(next);
        // Setting colours is also how you choose them: leaving the app on Dark
        // after editing a palette would look like nothing had happened.
        if (!customSelected) onThemeChange?.(CUSTOM_THEME);
        toast.success(message, toastOptions());
    };

    return (
        <SettingsPage
            title={t('settings.appearance.title')}
            description={t('settings.appearance.desc')}
        >
            <SettingCard>
                <SettingRow
                    title={t('settings.appearance.theme')}
                    description={customSelected
                        ? t('settings.appearance.themeCustomDesc')
                        : t('settings.appearance.themeDesc')}
                >
                    {/* Reflows on the column's own width rather than a fixed
                        count: at the narrow end of the window four fixed
                        columns put the labels into each other. */}
                    <div
                        className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(112px,1fr))]"
                        id="theme-selector"
                    >
                        {THEME_OPTIONS.map((option) => (
                            <button
                                key={option.id}
                                className={`theme-option flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${theme === option.id
                                    ? 'border-gray-900 dark:border-white bg-gray-50 dark:bg-neutral-800'
                                    : 'border-gray-200 dark:border-neutral-700 hover:border-gray-300 dark:hover:border-neutral-600'
                                    }`}
                                data-theme={option.id}
                                onClick={() => {
                                    onThemeChange(option.id);
                                    toast.success(
                                        t('settings.appearance.themeChanged', {
                                            theme: t(`settings.appearance.themeToast.${option.id}`),
                                        }),
                                        toastOptions(),
                                    );
                                }}
                            >
                                <ThemeIcon type={option.icon} colors={colors} />
                                <span className="text-sm font-medium">
                                    {t(`settings.appearance.theme.${option.id}`)}
                                </span>
                            </button>
                        ))}
                    </div>
                </SettingRow>

                {/* Shown on every theme so the palettes can be found. They
                    stay honest on Light or Dark because picking one also
                    switches the app to Custom (see applyColors). */}
                <SettingRow
                    className={DIVIDED}
                    title={t('settings.appearance.appColors')}
                    description={t('settings.appearance.appColorsDesc')}
                >
                    <div
                        className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(104px,1fr))]
                            max-h-[22rem] overflow-y-auto pr-1 -mr-1"
                        id="app-palette-selector"
                    >
                        {APP_COLOR_PRESETS.map((option) => (
                            <button
                                key={option.id}
                                className={tileClass(activePreset === option.id)}
                                data-app-palette={option.id}
                                onClick={() => applyColors(
                                    option.colors,
                                    t('settings.appearance.appColorsChanged', { palette: option.label }),
                                )}
                            >
                                <PaletteSwatch colors={option.colors} />
                                <span className={labelClass(activePreset === option.id)}>
                                    {option.label}
                                </span>
                            </button>
                        ))}

                        {/* Where a hand-picked palette shows up, so colours
                            that match no preset are still shown as the one
                            in use. Nothing to click: it is already on. */}
                        {customSelected && !activePreset && (
                            <div className={`${tileClass(true)} cursor-default`} data-app-palette="custom">
                                <PaletteSwatch colors={colors} />
                                <span className={labelClass(true)}>
                                    {t('settings.appearance.yours')}
                                </span>
                            </div>
                        )}
                    </div>
                </SettingRow>

                {customSelected && (
                    <SettingRow
                        className={DIVIDED}
                        align="center"
                        title={t('settings.appearance.customColors')}
                        description={t('settings.appearance.customColorsDesc')}
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
                )}
            </SettingCard>

            <TerminalColorsCard
                terminalTheme={terminalTheme}
                customTerminalTheme={customTerminalTheme}
                onTerminalThemeChange={onTerminalThemeChange}
                onCustomTerminalThemeChange={onCustomTerminalThemeChange}
            />

            {editorOpen && (
                <AppColorsDialog
                    colors={colors}
                    onSave={(next) => {
                        setEditorOpen(false);
                        applyColors(next, t('settings.appearance.colorsApplied'));
                    }}
                    onClose={() => setEditorOpen(false)}
                />
            )}
        </SettingsPage>
    );
}

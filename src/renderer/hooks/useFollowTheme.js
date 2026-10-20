import { useEffect } from 'react';
import { INITIAL_THEME, applyAppColors, clearAppColors, readAppColors } from '../lib/app-colors';

const THEMES = new Set(['light', 'dark', 'system', 'custom']);

/**
 * The theme chosen in the main window, as it stands in the store: the `dark`
 * class, and for the custom theme its palette too, cleared again for the
 * others. The same rules as useTheme, which owns the setting.
 */
export function applyStoredTheme() {
    const saved = localStorage.getItem('theme');
    const theme = THEMES.has(saved) ? saved : INITIAL_THEME;
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle(
        'dark',
        theme === 'dark' || theme === 'custom' || (theme === 'system' && prefersDark),
    );
    if (theme !== 'custom') {
        clearAppColors();
        return;
    }
    try {
        applyAppColors(readAppColors(localStorage.getItem('appColors')));
    } catch {
        clearAppColors();
    }
}

/**
 * For the windows that are not the main one (the assistant in its own
 * window, the card in the corner of the screen): the theme and the palette
 * picked in the main window, followed here as they change, and the system's
 * own light or dark when the theme is set to follow it.
 */
export default function useFollowTheme() {
    useEffect(() => {
        const onStorage = (event) => {
            if (event.key === null || event.key === 'theme' || event.key === 'appColors') applyStoredTheme();
        };
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const onSystem = () => applyStoredTheme();
        window.addEventListener('storage', onStorage);
        media.addEventListener('change', onSystem);
        return () => {
            window.removeEventListener('storage', onStorage);
            media.removeEventListener('change', onSystem);
        };
    }, []);
}

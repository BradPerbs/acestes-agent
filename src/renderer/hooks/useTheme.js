import { useState, useLayoutEffect, useCallback } from 'react';
import {
    DEFAULT_APP_COLORS,
    applyAppColors,
    clearAppColors,
    sanitizeAppColors,
} from '../lib/app-colors';

/** The theme that is the user's own colours rather than one of ours. */
export const CUSTOM_THEME = 'custom';

const THEMES = new Set(['light', 'dark', 'system', CUSTOM_THEME]);

const THEME_KEY = 'theme';
const COLORS_KEY = 'appColors';

const readTheme = () => {
    const saved = localStorage.getItem(THEME_KEY);
    return THEMES.has(saved) ? saved : 'system';
};

const readColors = () => {
    try {
        const saved = localStorage.getItem(COLORS_KEY);
        return sanitizeAppColors(saved ? JSON.parse(saved) : null);
    } catch {
        return { ...DEFAULT_APP_COLORS };
    }
};

export function useTheme() {
    const [theme, setThemeState] = useState(readTheme);
    const [appColors, setAppColorsState] = useState(readColors);

    const applyTheme = useCallback((themeName, colors) => {
        const root = document.documentElement;
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

        // A custom palette is a retint of the dark ramp, so choosing one is also
        // choosing dark: the light surfaces are Tailwind's greys and would not
        // hear about it.
        root.classList.toggle(
            'dark',
            themeName === 'dark' || themeName === CUSTOM_THEME || (themeName === 'system' && prefersDark)
        );

        if (themeName === CUSTOM_THEME) applyAppColors(colors);
        else clearAppColors();
    }, []);

    const setTheme = useCallback((newTheme) => {
        setThemeState(newTheme);
        localStorage.setItem(THEME_KEY, newTheme);
    }, []);

    const setAppColors = useCallback((colors) => {
        const next = sanitizeAppColors(colors);
        setAppColorsState(next);
        localStorage.setItem(COLORS_KEY, JSON.stringify(next));
        return next;
    }, []);

    // Before the paint rather than after it: this is what decides whether the
    // window is black or white, and a frame of the wrong one is a flash.
    useLayoutEffect(() => {
        applyTheme(theme, appColors);

        // Listen for system theme changes
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const handleChange = () => {
            if (theme === 'system') applyTheme('system', appColors);
        };

        mediaQuery.addEventListener('change', handleChange);
        return () => mediaQuery.removeEventListener('change', handleChange);
    }, [theme, appColors, applyTheme]);

    return {
        theme, setTheme,
        appColors, setAppColors,
    };
}

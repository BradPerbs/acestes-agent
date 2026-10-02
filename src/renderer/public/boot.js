/*
 * Runs in <head>, before the page has painted and long before the bundle has
 * loaded, which in a big bundle is a second or more of blank window.
 *
 * Two things have to be known by the first frame rather than by the first
 * render. The theme, so the splash and everything after it come up in the
 * right one instead of in the frame's dark and then switching (main.jsx
 * applies it again, fully, once it runs). And whether this window shows the
 * boot splash at all: the screenshot viewer, the assistant's windows and the
 * corner card load this same page, and the card's is see-through.
 *
 * A classic script from public/, not part of the bundle: a module would wait
 * for the rest of it. Kept to what cannot wait; anything that throws here
 * leaves the page as it was without this.
 */
(function () {
    var root = document.documentElement;
    try {
        // Nothing stored is the Custom theme in Black, as INITIAL_THEME and
        // INITIAL_APP_COLORS in lib/app-colors.js say; keep in step.
        var stored = localStorage.getItem('theme') || 'custom';
        var custom = stored === 'custom';
        // Following the system is left to the stylesheet's media query: this
        // early, Electron has not yet told the page the system's scheme and
        // matchMedia says light whatever it is, where the media query catches
        // up by itself when it hears. A light theme chosen outright says so,
        // so that query leaves it alone.
        if (stored === 'dark' || custom) root.classList.add('dark');
        if (stored === 'light') root.classList.add('boot-light');
        // Only the background of a custom palette: it is all the splash shows.
        if (custom) {
            var saved = localStorage.getItem('appColors');
            var base = saved ? (JSON.parse(saved) || {}).base : '#000000';
            if (/^#[0-9a-f]{6}$/i.test(base || '')) {
                var v = parseInt(base.slice(1), 16);
                root.style.setProperty('--app-base', (v >> 16) + ' ' + ((v >> 8) & 255) + ' ' + (v & 255));
            }
        }
    } catch (error) {
        // No storage, or a palette that does not parse: the defaults stand.
    }
    var hash = location.hash;
    if (!/[#&](screenshot|assistant)=|[#&]activity\b/.test(hash)) root.classList.add('booting');
})();

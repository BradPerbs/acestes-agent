/**
 * The one style a section heading wears, wherever it is: a menu's "New
 * conversation with", a picker's groups, a panel's sections, a dialog's
 * groups of fields, a table's columns.
 *
 * Said the way the sidebar says "Conversations": sentence case, at the size
 * and weight of the text around it, rather than a tiny tracked-out capital
 * label stamped over the content.
 *
 * And in a grey, not in `neutral-500`. The neutral scale in this project is
 * the theme's surface ramp (see tailwind.config.js), and its 500 is each
 * theme's own muted tint: blue-violet in Tokyo Night, purple in Amethyst,
 * pink in Wine, and under 3:1 on a menu in the default theme. gray-500 and
 * gray-400 are the pair the tabs and the sidebar's buttons already use:
 * neutral in every theme, and readable in both (4.8:1 on white, 6.7:1 on the
 * dark raised surface).
 */
export const HEADING = 'text-xs font-medium text-gray-500 dark:text-gray-400';

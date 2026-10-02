import IconTile from '../hosts/IconTile';
import Reveal from '../ui/Reveal';
import { useStacked } from './ui/stacked';

/**
 * One thing the agent can use, as a row: an icon, a plain name, one line on
 * what it means, and the switch. What there is to set once it is on (a pace,
 * a window, a guide to installing what is missing) opens underneath, so a
 * capability that is off is one line to read and nothing else.
 *
 * Marked as a setting row, so the page's search finds it by its name and its
 * line like any other.
 */
export default function Capability({
    icon: Icon,
    title,
    description,
    control,
    open = false,
    className = '',
    children,
}) {
    const stacked = useStacked();

    return (
        <div data-setting-row="" className={className}>
            <div className="flex items-start gap-4">
                {!stacked && (
                    <IconTile className="mt-0.5 text-gray-700 dark:text-gray-200">
                        <Icon size={19} strokeWidth={1.6} />
                    </IconTile>
                )}
                <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-6">
                        <div className="min-w-0">
                            <h4 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h4>
                            {description && (
                                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{description}</p>
                            )}
                        </div>
                        {control && <div className="shrink-0 mt-0.5">{control}</div>}
                    </div>
                    {children && (
                        <Reveal open={open}>
                            <div className="pt-5">{children}</div>
                        </Reveal>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * The small "label + control" pairs inside an open capability. The control
 * keeps its own width, as it does everywhere else in settings, rather than
 * being stretched across the card.
 */
export function Detail({ title, description, children }) {
    return (
        <div className="flex flex-col items-start gap-2.5">
            <div>
                <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{title}</div>
                {description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>}
            </div>
            {children}
        </div>
    );
}

/**
 * A status line: a dot coloured by how things stand, and the words.
 * `tone` is ok, busy, warn or off.
 */
export function StatusLine({ tone = 'off', children }) {
    const dot = {
        ok: 'bg-emerald-500',
        busy: 'bg-sky-500 animate-pulse',
        warn: 'bg-amber-500',
        off: 'bg-gray-400 dark:bg-neutral-500',
    }[tone] || 'bg-gray-400';

    return (
        <p className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
            <span aria-hidden="true" className={`w-1.5 h-1.5 mt-[0.5rem] rounded-full shrink-0 ${dot}`} />
            <span className="min-w-0 break-words">{children}</span>
        </p>
    );
}

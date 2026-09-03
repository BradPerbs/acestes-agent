import { useT } from '../../i18n';

/**
 * What an edit changed, drawn the way a diff is read.
 *
 * A tool call that edits a file used to show its arguments: two long JSON
 * strings, the passage before and the passage after, which a person has to
 * compare by eye to see what moved. This is the same information laid out
 * as lines, removed above added, with the file it belongs to and the count
 * on the header. It appears on the tool row once the edit is made, and on
 * the approval card before it is, which is the more useful of the two: a
 * change worth stopping for is a change worth reading first.
 *
 * The main process works the lines out (see ai/diff.js); this only draws
 * them, so the same block serves whichever runtime made the edit.
 */

const ROW = 'flex leading-[1.55]';
const NUMBER = `w-9 shrink-0 select-none pr-2 text-right tabular-nums
    text-gray-400 dark:text-neutral-600`;

const TONE = {
    add: {
        line: 'bg-emerald-500/[0.10] text-emerald-800 dark:text-emerald-300',
        sign: 'text-emerald-600 dark:text-emerald-400',
    },
    remove: {
        line: 'bg-red-500/[0.09] text-red-800 dark:text-red-300',
        sign: 'text-red-600 dark:text-red-400',
    },
    same: {
        line: 'text-gray-500 dark:text-gray-500',
        sign: 'text-transparent',
    },
};

const SIGN = { add: '+', remove: '-', same: ' ' };

export default function DiffView({ diff, path = '', className = '' }) {
    const t = useT();
    if (!diff) return null;

    const name = path || diff.path || '';

    return (
        <div className={`overflow-hidden ${className}`}>
            <div className="px-2.5 py-1.5 flex items-center gap-2
                border-b border-black/[0.06] dark:border-white/[0.06]">
                {name && (
                    <span
                        className="min-w-0 flex-1 truncate font-jetbrains text-[11px] text-gray-600 dark:text-gray-400"
                        title={name}
                    >
                        {name}
                    </span>
                )}
                <span className="shrink-0 flex items-center gap-1.5 text-[11px] font-medium tabular-nums">
                    {diff.added > 0 && (
                        <span className="text-emerald-600 dark:text-emerald-400">+{diff.added}</span>
                    )}
                    {diff.removed > 0 && (
                        <span className="text-red-600 dark:text-red-400">-{diff.removed}</span>
                    )}
                </span>
            </div>

            {diff.tooLarge ? (
                <p className="px-2.5 py-2 text-[11px] text-gray-500 dark:text-gray-400">
                    {t('assistant.diffTooLarge')}
                </p>
            ) : (
                // Scrolls on its own in both directions: a long line must not
                // stretch the panel, and a long change must not bury the reply.
                <div className="max-h-72 overflow-auto font-jetbrains text-[11px]">
                    {diff.hunks.map((hunk, index) => (
                        <div key={`${hunk.before}-${hunk.after}-${index}`}>
                            {index > 0 && (
                                <div className="px-2.5 py-0.5 text-[10px] select-none
                                    text-gray-400 dark:text-neutral-600
                                    bg-gray-100/60 dark:bg-white/[0.03]">
                                    ⋯
                                </div>
                            )}
                            {hunk.lines.map((line, at) => {
                                const tone = TONE[line.type] || TONE.same;
                                return (
                                    <div key={at} className={`${ROW} ${tone.line}`}>
                                        {/* Only when the numbers mean something: a
                                            passage taken out of the middle of a file
                                            has none that would be true. */}
                                        {!diff.partial && (
                                            <span className={NUMBER} aria-hidden="true">
                                                {line.after ?? line.before ?? ''}
                                            </span>
                                        )}
                                        <span className={`w-3 shrink-0 select-none ${tone.sign}`} aria-hidden="true">
                                            {SIGN[line.type]}
                                        </span>
                                        <span className="whitespace-pre pr-2.5">{line.text || ' '}</span>
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

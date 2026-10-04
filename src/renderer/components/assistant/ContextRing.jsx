import Tooltip from '../ui/Tooltip';
import { localeTag, useT } from '../../i18n';

/**
 * How full the model's context is, as a small ring beside the model chip.
 *
 * The same figure OpenCode Desktop draws beside its composer: the latest
 * reply's tokens (what went in, cached or not, and what came back) over the
 * model's context window. It moves once per step of a turn and says, on
 * hover, the tokens and the window behind the percentage. Cost is left to the
 * Usage chip beside it, which shows it only when the account is billed per
 * token: on a plan the runtime's figure is not a real bill.
 *
 * Nothing is drawn until a runtime has reported a reading, and nothing for a
 * reading from another runtime than the one now answering: after a switch it
 * describes a model that is no longer in the conversation.
 */

const SIZE = 16;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Grey while there is room, amber as it fills, red when a compaction is near. */
function toneOf(percent) {
    if (percent >= 90) return 'text-red-500 dark:text-red-400';
    if (percent >= 70) return 'text-amber-500 dark:text-amber-400';
    return 'text-gray-500 dark:text-gray-400';
}

function Row({ name, value }) {
    return (
        <span className="flex items-center justify-between gap-4 tabular-nums">
            <span className="opacity-70">{name}</span>
            <span>{value}</span>
        </span>
    );
}

export default function ContextRing({ context, provider }) {
    const t = useT();
    if (!context || !context.used || (context.provider && provider && context.provider !== provider)) return null;

    const number = new Intl.NumberFormat(localeTag());
    const percent = Number.isFinite(context.percent) ? Math.max(0, Math.min(100, context.percent)) : null;
    const filled = percent === null ? 0 : (percent / 100) * CIRCUMFERENCE;
    const tokens = context.limit
        ? t('assistant.context.tokensOf', { used: number.format(context.used), limit: number.format(context.limit) })
        : number.format(context.used);
    const spoken = percent === null
        ? t('assistant.context.unknownLimit', { tokens })
        : t('assistant.context.label', { percent, tokens });

    const label = (
        <span className="flex flex-col gap-0.5 min-w-[11rem]">
            <Row name={t('assistant.context.usage')} value={percent === null ? '—' : `${percent}%`} />
            <Row name={t('assistant.context.tokens')} value={tokens} />
        </span>
    );

    return (
        <Tooltip label={label} placement="top">
            <span
                role="img"
                aria-label={spoken}
                className={`w-7 h-7 shrink-0 flex items-center justify-center ${toneOf(percent ?? 0)}`}
            >
                <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
                    <circle
                        cx={SIZE / 2}
                        cy={SIZE / 2}
                        r={RADIUS}
                        fill="none"
                        stroke="currentColor"
                        strokeOpacity="0.22"
                        strokeWidth={STROKE}
                    />
                    <circle
                        cx={SIZE / 2}
                        cy={SIZE / 2}
                        r={RADIUS}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={STROKE}
                        strokeLinecap="round"
                        strokeDasharray={`${filled} ${CIRCUMFERENCE}`}
                        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
                        style={{ transition: 'stroke-dasharray 600ms ease' }}
                    />
                </svg>
            </span>
        </Tooltip>
    );
}

import Tooltip from '../ui/Tooltip';
import PanelMenu from './PanelMenu';
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
 * Before any runtime has reported a reading the ring still shows, empty, so
 * the meter sits where the eye looks for it whether a turn is running or
 * not. Nothing is drawn for a reading from another runtime than the one now
 * answering: after a switch it describes a model that is no longer in the
 * conversation.
 *
 * With `onPickWindow` (the OpenAI-compatible runtimes, which do not get a
 * window from an agent CLI the way the others do) the ring is also a menu of
 * context sizes. The size picked is the window the ring is measured against
 * and the one the conversation's history is kept within; the default is what
 * the server lists for the model, as OpenRouter does, or a cautious size when
 * it lists nothing.
 */

/** The sizes the menu offers, in tokens. */
export const CONTEXT_SIZES = [16000, 32000, 64000, 128000, 200000, 256000, 400000, 1000000];

/** 32000 as "32k", 1048576 as "1M". */
export function shortTokens(tokens) {
    if (tokens >= 1000000) return `${Number((tokens / 1000000).toFixed(1))}M`;
    return `${Math.round(tokens / 1000)}k`;
}

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

export default function ContextRing({ context: reading, provider, windowPick = 0, onPickWindow }) {
    const t = useT();
    // A reading from another runtime than the one now answering describes a
    // model that is no longer in the conversation. With nothing to pick it is
    // not drawn at all; with a menu, the ring stays and starts empty.
    const foreign = Boolean(reading?.provider && provider && reading.provider !== provider);
    if (foreign && !onPickWindow) return null;
    const context = foreign ? null : reading;

    const number = new Intl.NumberFormat(localeTag());
    // No reading yet (nothing generated in this conversation): the ring still
    // shows, empty, rather than popping in the first time a reply streams in.
    const empty = !context || !context.used;
    // A size picked since the last reading is what the next one is measured
    // against, so the ring moves to it now rather than a turn later.
    const limit = onPickWindow && windowPick ? windowPick : (context?.limit || 0);
    const rawPercent = !empty && limit && onPickWindow
        ? Math.round((context.used / limit) * 100)
        : context?.percent;
    const percent = !empty && Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, rawPercent)) : null;
    const filled = percent === null ? 0 : (percent / 100) * CIRCUMFERENCE;
    // Counted from the characters, when the server sent no count of its own.
    const approx = context?.estimated ? '~' : '';
    const tokens = empty
        ? '—'
        : limit
            ? t('assistant.context.tokensOf', { used: `${approx}${number.format(context.used)}`, limit: number.format(limit) })
            : `${approx}${number.format(context.used)}`;
    // Cache-read tokens behind the reading, when the runtime reports them:
    // hits over what went in, as tokens and as a share of the reading.
    const cached = !empty && Number(context.cached) > 0 ? Number(context.cached) : 0;
    const hitRate = cached > 0 && context.used > 0 ? Math.max(0, Math.min(100, Math.round((cached / context.used) * 100))) : null;
    const spoken = empty
        ? t('assistant.context.empty')
        : percent === null
            ? t('assistant.context.unknownLimit', { tokens })
            : t('assistant.context.label', { percent, tokens });

    // The model's own window, as the server lists it, for the menu's default row.
    const modelLimit = Number(context?.modelLimit) || 0;
    const sizeName = windowPick
        ? t('assistant.context.sizePicked', { size: shortTokens(windowPick) })
        : modelLimit
            ? t('assistant.context.sizeModel', { size: shortTokens(modelLimit) })
            : t('assistant.context.sizeAuto');

    const label = (
        <span className="flex flex-col gap-0.5 min-w-[11rem]">
            <Row name={t('assistant.context.usage')} value={percent === null ? '—' : `${percent}%`} />
            <Row name={t('assistant.context.tokens')} value={tokens} />
            {cached > 0 && (
                <Row
                    name={t('assistant.context.cached')}
                    value={hitRate === null ? number.format(cached) : `${number.format(cached)} · ${hitRate}%`}
                />
            )}
            {onPickWindow && <Row name={t('assistant.context.size')} value={sizeName} />}
        </span>
    );

    const ring = (
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
    );

    if (!onPickWindow) {
        return (
            <Tooltip label={label} placement="top">
                <span
                    role="img"
                    aria-label={spoken}
                    className={`w-7 h-7 shrink-0 flex items-center justify-center ${toneOf(percent ?? 0)}`}
                >
                    {ring}
                </span>
            </Tooltip>
        );
    }

    const options = [
        {
            value: '',
            label: t('assistant.context.sizeAuto'),
            hint: modelLimit
                ? t('assistant.context.sizeAutoKnown', { size: shortTokens(modelLimit) })
                : t('assistant.context.sizeAutoUnknown'),
        },
        ...CONTEXT_SIZES.map(size => ({ value: String(size), label: t('assistant.context.sizeTokens', { size: shortTokens(size) }) })),
    ];
    // A size the list does not have (picked before the list changed) still
    // shows as the current one rather than leaving nothing ticked.
    if (windowPick && !CONTEXT_SIZES.includes(windowPick)) {
        options.push({ value: String(windowPick), label: t('assistant.context.sizeTokens', { size: shortTokens(windowPick) }) });
    }

    return (
        <PanelMenu
            direction="up"
            align="right"
            menuClassName="w-60"
            sections={[{
                heading: t('assistant.context.size'),
                value: windowPick ? String(windowPick) : '',
                onChange: value => onPickWindow(Number(value) || 0),
                options,
            }]}
            trigger={({ open, toggle }) => (
                <Tooltip label={label} placement="top" enabled={!open}>
                    <button
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={open}
                        aria-label={`${spoken}. ${t('assistant.context.size')}: ${sizeName}`}
                        onClick={toggle}
                        className={`w-7 h-7 shrink-0 flex items-center justify-center rounded-xl transition-colors
                            outline-none focus-visible:ring-2
                            focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25
                            ${open ? 'bg-gray-100 dark:bg-white/[0.08]' : 'hover:bg-gray-100 dark:hover:bg-white/[0.06]'}
                            ${toneOf(percent ?? 0)}`}
                    >
                        {ring}
                    </button>
                </Tooltip>
            )}
        />
    );
}

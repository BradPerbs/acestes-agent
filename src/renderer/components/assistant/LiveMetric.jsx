import { memo, useEffect, useMemo, useState } from 'react';
import { StopCircleIcon } from 'hugeicons-react';
import Chart from '../ui/Chart';
import Tooltip from '../ui/Tooltip';
import { formatValue } from '../../lib/chart-spec';
import { chartOf, clockLabel, mergePoints } from '../../lib/live-metric';
import { useT } from '../../i18n';

/**
 * A live chart (watch_metric), in the transcript where the call started it.
 *
 * While the watch runs, the points come from the main process a few times a
 * second on their own channel, never through the conversation's log: a chart
 * opened mid-watch asks for the points so far, then follows the stream. Once
 * the watch has ended, the transcript item carries the last window of points
 * and the figures, and the chart is drawn from those like any other.
 *
 * The drawing is the ordinary line chart's, with its entry animations off
 * (`live`), a state badge and a stop button beside the title, and the running
 * figures under the plot.
 */

/** Follow one running watch: the snapshot first, then every batch after it. */
function useLiveWatch(item) {
    const running = item.status === 'running';
    const size = item.spec?.window || 120;
    const [live, setLive] = useState({
        points: [], stats: null, status: 'running', reason: '', unmatched: '', lastError: '', found: null,
    });

    useEffect(() => {
        const api = window.api?.ai;
        if (!running || !api?.onMetric) return undefined;
        let cancelled = false;
        let ready = false;
        const queued = [];

        const apply = batch => setLive(previous => ({
            ...previous,
            points: mergePoints(previous.points, batch.points, size),
            stats: batch.stats || previous.stats,
            unmatched: batch.unmatched ?? previous.unmatched,
            lastError: batch.lastError ?? previous.lastError,
            ...(batch.ended ? { status: batch.ended.status, reason: batch.ended.reason } : {}),
        }));

        // Listening before asking, so a batch sent between the two is held
        // and applied after the snapshot rather than lost.
        const off = api.onMetric((batch) => {
            if (batch?.watchId !== item.watchId) return;
            if (ready) apply(batch);
            else queued.push(batch);
        });

        Promise.resolve(api.metricSnapshot?.(item.watchId)).then((snapshot) => {
            if (cancelled) return;
            if (snapshot?.found) {
                setLive({
                    points: (snapshot.points || []).slice(-size),
                    stats: snapshot.stats || null,
                    status: snapshot.status || 'running',
                    reason: snapshot.reason || '',
                    unmatched: snapshot.unmatched || '',
                    lastError: snapshot.lastError || '',
                    found: true,
                });
            } else {
                setLive(previous => ({ ...previous, found: false }));
            }
            ready = true;
            queued.splice(0).forEach(apply);
        }).catch(() => {
            ready = true;
            queued.splice(0).forEach(apply);
        });

        return () => {
            cancelled = true;
            off?.();
        };
    }, [item.watchId, running, size]);

    if (!running) {
        return { points: item.points || [], stats: item.stats, status: item.status, reason: item.reason, unmatched: '', lastError: '' };
    }
    // Running by the log, and unknown to the main process: the app closed
    // under it without the end being written down.
    if (live.found === false) return { ...live, status: 'gone' };
    return live;
}

const STATES = {
    running: { dot: 'bg-emerald-500 animate-pulse', key: 'assistant.metricLive' },
    done: { dot: 'bg-gray-400 dark:bg-white/40', key: 'assistant.metricFinished' },
    stopped: { dot: 'bg-gray-400 dark:bg-white/40', key: 'assistant.metricStopped' },
    failed: { dot: 'bg-red-500', key: 'assistant.metricFailed' },
    gone: { dot: 'bg-gray-400 dark:bg-white/40', key: 'assistant.metricGone' },
};

function Badge({ status, onStop }) {
    const t = useT();
    const state = STATES[status] || STATES.done;
    return (
        <div className="flex items-center gap-1 -mt-0.5 shrink-0">
            <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-full text-[10.5px] font-medium
                bg-gray-900/[0.05] dark:bg-white/[0.07] text-gray-600 dark:text-white/70">
                <span className={`w-1.5 h-1.5 rounded-full ${state.dot}`} />
                {t(state.key)}
            </span>
            {status === 'running' && (
                <Tooltip label={t('assistant.metricStop')} placement="top">
                    <button
                        type="button"
                        aria-label={t('assistant.metricStop')}
                        onClick={onStop}
                        className="w-6 h-6 flex items-center justify-center rounded-md outline-none transition-colors
                            text-gray-400 dark:text-white/40 hover:text-red-600 dark:hover:text-red-400
                            hover:bg-gray-900/[0.04] dark:hover:bg-white/[0.06]
                            focus-visible:ring-1 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25"
                    >
                        <StopCircleIcon size={14} strokeWidth={1.8} />
                    </button>
                </Tooltip>
            )}
        </div>
    );
}

/** The running figures, the command, and why it ended. */
function Footer({ spec, stats, status, reason, unmatched, lastError }) {
    const t = useT();
    const unit = spec.unit || '';
    const single = (spec.series || []).length <= 1;
    const own = stats?.series?.[0];
    const figures = [];
    if (single && own && Number.isFinite(own.avg)) {
        figures.push(t('assistant.metricFigures', {
            min: formatValue(own.min, unit),
            avg: formatValue(own.avg, unit),
            max: formatValue(own.max, unit),
        }));
    }
    if (stats) figures.push(t('assistant.metricSamples', { count: stats.samples || 0 }));
    if (stats?.gaps) figures.push(t('assistant.metricGaps', { count: stats.gaps }));
    if (status === 'running' && spec.endsAt) figures.push(t('assistant.metricEnds', { time: clockLabel(spec.endsAt).slice(0, 5) }));

    return (
        <div className="mt-3 pt-2.5 border-t border-black/[0.05] dark:border-white/[0.06] space-y-1">
            {figures.length > 0 && (
                <div className="text-[11px] tabular-nums text-gray-500 dark:text-white/50">{figures.join(' · ')}</div>
            )}
            <div className="font-jetbrains text-[10.5px] truncate text-gray-400 dark:text-white/35" title={spec.command}>
                {spec.command}
            </div>
            {/* Sent only while nothing has matched: a poll whose pattern is
                wrong still draws, as a row of gaps, so this is the one
                place that says why. */}
            {status === 'running' && unmatched && (
                <div className="text-[11px] text-amber-700 dark:text-amber-300/90 break-words">
                    {t('assistant.metricUnmatched', { line: unmatched })}
                </div>
            )}
            {status === 'running' && lastError && (
                <div className="text-[11px] text-amber-700 dark:text-amber-300/90 break-words">{lastError}</div>
            )}
            {status !== 'running' && reason && (
                <div className={`text-[11px] break-words ${status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-white/45'}`}>
                    {reason}
                </div>
            )}
            {status === 'gone' && (
                <div className="text-[11px] text-gray-500 dark:text-white/45">{t('assistant.metricGoneNote')}</div>
            )}
        </div>
    );
}

const NO_SPEC = {};

function LiveMetric({ item }) {
    const t = useT();
    const spec = item.spec || NO_SPEC;
    const { points, stats, status, reason, unmatched, lastError } = useLiveWatch(item);
    const chart = useMemo(() => (points.length ? chartOf(spec, points) : null), [spec, points]);
    const stop = () => window.api?.ai?.stopMetric?.(item.watchId);

    const badge = <Badge status={status} onStop={stop} />;
    const footer = (
        <Footer
            spec={spec}
            stats={stats}
            status={status}
            reason={reason}
            unmatched={unmatched}
            lastError={lastError}
        />
    );

    if (chart) return <Chart chart={chart} badge={badge} footer={footer} />;

    // Nothing to plot yet: the card, with what it is waiting for.
    return (
        <div className="px-4 pt-3.5 pb-3.5 rounded-xl border border-black/[0.07] dark:border-white/[0.07] bg-white dark:bg-white/[0.02]">
            <div className="flex items-start gap-2 mb-2">
                <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold leading-snug tracking-[-0.01em] text-gray-900 dark:text-white break-words">
                        {spec.title || spec.command}
                    </div>
                    {spec.where && (
                        <div className="mt-0.5 text-[11.5px] leading-snug text-gray-500 dark:text-white/45">{spec.where}</div>
                    )}
                </div>
                {badge}
            </div>
            {status === 'running' && (
                <div className="chart-shimmer h-16 rounded-lg flex items-center justify-center text-[11px] text-gray-400 dark:text-white/40">
                    {t('assistant.metricWaiting')}
                </div>
            )}
            {footer}
        </div>
    );
}

export default memo(LiveMetric);

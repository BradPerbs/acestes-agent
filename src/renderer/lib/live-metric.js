/**
 * A live chart's arithmetic, kept free of React so the test can load it:
 * the clock labels along its foot, the merge of what arrived into what is
 * held, and the line chart a set of points makes. See LiveMetric.jsx.
 */

const pad = value => String(value).padStart(2, '0');

/** A sample's time as the axis shows it. */
export function clockLabel(ms) {
    const at = new Date(ms);
    return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * What arrived, added to what is held: anything already held (by its number)
 * is skipped, so a batch overlapping the snapshot is not drawn twice, and the
 * oldest fall off the front past the window. Returns `held` itself when
 * nothing new came, so a chart with nothing to add is not drawn again.
 */
export function mergePoints(held, incoming, window) {
    if (!incoming?.length) return held;
    const last = held.length ? held[held.length - 1].n : 0;
    const fresh = incoming.filter(point => !(point.n <= last));
    if (fresh.length === 0) return held;
    const merged = held.concat(fresh);
    return merged.length > window ? merged.slice(merged.length - window) : merged;
}

/** The line chart for a set of points: one series per name, gaps as gaps. */
export function chartOf(spec, points) {
    const names = Array.isArray(spec.series) && spec.series.length ? spec.series : ['Value'];
    return {
        type: 'line',
        live: true,
        title: spec.title || spec.command || '',
        subtitle: [spec.where, spec.every ? `every ${spec.every}s` : ''].filter(Boolean).join(' · '),
        unit: spec.unit || '',
        labels: points.map(point => clockLabel(point.t)),
        series: names.map((name, index) => ({
            name,
            values: points.map(point => (Number.isFinite(point.v?.[index]) ? point.v[index] : null)),
        })),
        limits: Array.isArray(spec.limits) ? spec.limits : [],
        events: [],
        ...(Number.isFinite(spec.min) ? { min: spec.min } : {}),
        ...(Number.isFinite(spec.max) ? { max: spec.max } : {}),
    };
}

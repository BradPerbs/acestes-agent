/**
 * Captcha solving services, for computer use.
 *
 * On the desktop the agent has pixels and a real mouse, not a page's DOM, so
 * the token these services are best known for (site key in, token out) has
 * nowhere to go: it would have to be written into the page. What fits is the
 * other thing they sell: a picture in, and back either where to click or the
 * text it shows. computer.js takes the picture and does the clicking.
 *
 * 2Captcha, Anti-Captcha and CapSolver speak the same protocol: createTask
 * with the client key and a task, then getTaskResult until it is ready. The
 * key is a secret in the user's keychain, found by the service's name, so an
 * agent can store one itself when the user pastes it. The key existing is the
 * say-so to spend on it.
 */

const SERVICES = {
    '2captcha': {
        label: '2Captcha',
        base: 'https://api.2captcha.com',
        secrets: ['2captcha', 'twocaptcha'],
        points: 'CoordinatesTask',
        text: 'ImageToTextTask',
    },
    anticaptcha: {
        label: 'Anti-Captcha',
        base: 'https://api.anti-captcha.com',
        secrets: ['anticaptcha', 'anti-captcha'],
        points: 'ImageToCoordinatesTask',
        text: 'ImageToTextTask',
    },
    capsolver: {
        label: 'CapSolver',
        base: 'https://api.capsolver.com',
        secrets: ['capsolver'],
        // No task that answers "where to click" for an arbitrary picture.
        points: null,
        text: 'ImageToTextTask',
    },
};

const ORDER = ['2captcha', 'anticaptcha', 'capsolver'];

/** A service's id from what the agent or the user may call it. */
function serviceId(name) {
    const clean = String(name || '').toLowerCase().replace(/[\s_-]/g, '');
    if (!clean) return '';
    if (clean === '2captcha' || clean === 'twocaptcha') return '2captcha';
    if (clean === 'anticaptcha') return 'anticaptcha';
    if (clean === 'capsolver') return 'capsolver';
    return null;
}

/**
 * The service to use and its key, for a job needing `kind` ('points' or
 * 'text'). `resolve` fills in a `{{secret:name}}` reference, or hands it
 * back as written when there is no such secret. The first service in ORDER
 * that has a key and can do the job, or the one asked for.
 */
function pick({ resolve, kind, wanted = '' }) {
    const asked = serviceId(wanted);
    if (asked === null) return { error: `There is no captcha service called "${wanted}". Known: 2captcha, anticaptcha, capsolver.` };
    const candidates = asked ? [asked] : ORDER;
    const keyed = [];
    for (const id of candidates) {
        const service = SERVICES[id];
        for (const secret of service.secrets) {
            const reference = `{{secret:${secret}}}`;
            const value = typeof resolve === 'function' ? resolve(reference) : '';
            if (value && value !== reference && !value.includes('{{secret:')) {
                keyed.push({ id, service, key: value, secret });
                break;
            }
        }
    }
    const able = keyed.find(entry => entry.service[kind]);
    if (able) return { id: able.id, label: able.service.label, key: able.key, secret: able.secret };
    if (keyed.length) {
        return {
            error: `${keyed.map(entry => entry.service.label).join(' and ')} cannot say where to click on a picture: `
                + 'it reads text captchas only. Image challenges need a 2Captcha or Anti-Captcha key.',
        };
    }
    return {
        missing: true,
        error: asked
            ? `There is no ${SERVICES[asked].label} key. Store it as the secret "${SERVICES[asked].secrets[0]}".`
            : 'No captcha service key is stored. A 2Captcha or Anti-Captcha key saved as the secret "2captcha" or '
                + '"anticaptcha" lets the agent get through image challenges (CapSolver, as "capsolver", reads text ones only).',
    };
}

/** Where to click, from any of the shapes the services answer with, as { x, y } in the picture's pixels. */
function pointsOf(solution) {
    const raw = solution?.coordinates || solution?.points || [];
    const points = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
        let x;
        let y;
        if (Array.isArray(entry)) {
            // [x, y], or a rectangle [x1, y1, x2, y2] whose middle is the click.
            if (entry.length >= 4) {
                x = (Number(entry[0]) + Number(entry[2])) / 2;
                y = (Number(entry[1]) + Number(entry[3])) / 2;
            } else {
                x = Number(entry[0]);
                y = Number(entry[1]);
            }
        } else if (entry && typeof entry === 'object') {
            x = Number(entry.x);
            y = Number(entry.y);
        }
        if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x: Math.round(x), y: Math.round(y) });
    }
    return points;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A service's error, as a sentence. The key is never in it. */
function failure(label, body) {
    const code = body?.errorCode || `error ${body?.errorId}`;
    const text = body?.errorDescription ? `: ${body.errorDescription}` : '';
    if (/ZERO_BALANCE|NO_BALANCE/i.test(code)) return `${label} says the account has no balance left (${code}). The user has to top it up.`;
    if (/KEY_DOES_NOT_EXIST|WRONG_USER_KEY|INVALID.*KEY|KEY.*INVALID/i.test(code)) return `${label} does not recognise the key (${code}).`;
    if (/UNSOLVABLE/i.test(code)) return `${label}'s workers could not solve it (${code}).`;
    return `${label} refused it (${code}${text}).`;
}

/**
 * One picture solved: `kind` 'points' for where to click, 'text' for what it
 * says. Waits for the answer, checking `stopped` between polls so a user's
 * Esc is not held up behind a worker somewhere.
 */
async function solve({
    service, key, kind, image, comment = '', fetch: send = globalThis.fetch,
    timing = {}, stopped = () => '',
}) {
    const spec = SERVICES[service];
    if (!spec) return { error: `Unknown captcha service "${service}".` };
    const type = spec[kind];
    if (!type) return { error: `${spec.label} cannot do that kind of captcha.` };
    const first = timing.first ?? 4000;
    const every = timing.every ?? 3000;
    const limit = timing.limit ?? 180000;

    const task = { type, body: image };
    if (comment) task.comment = String(comment).slice(0, 500);
    if (kind === 'points' && service === 'anticaptcha') task.mode = 'points';

    const post = async (method, payload) => {
        let response;
        try {
            response = await send(`${spec.base}/${method}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientKey: key, ...payload }),
            });
        } catch (error) {
            return { error: `${spec.label} could not be reached: ${error.message}` };
        }
        let body;
        try {
            body = await response.json();
        } catch {
            return { error: `${spec.label} answered with something that is not JSON (HTTP ${response.status}).` };
        }
        if (body && body.errorId) return { error: failure(spec.label, body) };
        return { body };
    };

    const started = Date.now();
    const created = await post('createTask', { task });
    if (created.error) return created;
    let body = created.body;
    // CapSolver answers text at once, in the reply to createTask.
    if (body?.status !== 'ready') {
        const taskId = body?.taskId;
        if (!taskId) return { error: `${spec.label} did not say which task it made.` };
        await sleep(first);
        for (;;) {
            const stop = stopped();
            if (stop) return { error: stop, stopped: true };
            const polled = await post('getTaskResult', { taskId });
            if (polled.error) return polled;
            body = polled.body;
            if (body?.status === 'ready') break;
            if (Date.now() - started > limit) {
                return { error: `${spec.label} had no answer after ${Math.round(limit / 1000)} seconds.` };
            }
            await sleep(every);
        }
    }

    const solution = body.solution || {};
    const cost = body.cost !== undefined ? String(body.cost) : undefined;
    const seconds = Math.round((Date.now() - started) / 1000);
    if (kind === 'text') {
        const text = String(solution.text ?? '').trim();
        if (!text) return { error: `${spec.label} sent back no text.` };
        return { text, cost, seconds };
    }
    return { points: pointsOf(solution), cost, seconds };
}

/**
 * A captcha in a read, from the tree's own lines: a frame whose address is
 * one, or an image named as one. For read_screen to say what it is looking
 * at, so the agent reaches for solve_captcha rather than stalling on it.
 */
const FRAME = [
    { pattern: /\/recaptcha\/(api2|enterprise)\/(anchor|bframe)/i, name: 'a reCAPTCHA' },
    { pattern: /hcaptcha\.com.*frame=(checkbox|challenge)/i, name: 'an hCaptcha' },
    { pattern: /challenges\.cloudflare\.com/i, name: 'a Cloudflare check (Turnstile)' },
    { pattern: /(arkoselabs|funcaptcha)\.com/i, name: 'an Arkose (FunCaptcha) puzzle' },
];

function spotIn(nodes = []) {
    for (const node of nodes) {
        const value = String(node?.v || '');
        if (value.startsWith('http')) {
            const hit = FRAME.find(entry => entry.pattern.test(value));
            if (hit) return hit.name;
        }
        if (node?.r === 'image' && /\bcaptcha\b/i.test(String(node.n || ''))) return 'an image captcha';
    }
    return '';
}

module.exports = { SERVICES, pick, solve, pointsOf, serviceId, spotIn };

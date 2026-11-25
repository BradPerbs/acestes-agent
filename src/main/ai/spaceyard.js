/**
 * Spaceyard: a computer of the agent's own, in the cloud.
 *
 * A Spaceyard sandbox is a Linux or Windows desktop started with one API call
 * and billed by the minute (https://spaceyard.dev/docs). A conversation
 * pointed at one has its computer tools act there instead of on this
 * computer: the same read_screen, screenshot, click, type_text and the rest,
 * sent to POST /sandboxes/{uuid}/computer rather than to the desktop helper.
 * spaceyard-tools.js starts, stops and picks one; index.js decides, per tool
 * call, which of the two a conversation's computer tools reach.
 *
 * What is different from this computer, and why the rules are lighter:
 *
 *   nobody's desk   nothing of the user's is on it, so there is no question
 *                   per app and no pausing for their hand on the mouse. A
 *                   background run may use one too: no screen of theirs is
 *                   involved, and none is locked.
 *   one at a time   still one action at a time per sandbox, so two
 *                   conversations on the same one do not interleave.
 *   numbers         a Linux read numbers its controls afresh each time
 *                   (AT-SPI) and says where each one is, so an element is
 *                   clicked at its middle. A Windows sandbox lists its
 *                   controls without where they are; there it is pixels.
 *   pictures        a Windows sandbox's screenshot can come smaller than its
 *                   screen (its helper shrinks it), so pixels are reckoned
 *                   against the screen's real size, asked for once.
 *   secrets         Spaceyard logs the start of whatever is typed. A secret is
 *                   given to the sandbox when it is created, as one of its
 *                   encrypted environment variables, and typed from there by
 *                   name, so its value is in no request after that and no log.
 *   never here      a conversation pointed at a sandbox stays pointed at it,
 *                   across a restart, until the agent says otherwise: nothing
 *                   meant for the sandbox lands on this desktop by default.
 *
 * The API key is the user's, in the keychain as the secret `spaceyard`.
 */

// Read when a window is first shown, so archive.js can use readTarget
// without loading the desktop helper's module.
const formatTree = nodes => require('./computer').formatTree(nodes);

const API ='https://api.spaceyard.dev/v1';
const CONSOLE = 'https://console.spaceyard.dev';
const KEY_NAME = 'spaceyard';
const KEY_REFERENCE = `{{secret:${KEY_NAME}}}`;

/** The most a picture may be for the model: computer.js's IMAGE, the same limits. */
const IMAGE = { maxLong: 1568, maxPixels: 1150000 };

/** How long a sandbox may sit unused before it stops, and how long a stopped one is kept, by default (minutes). */
const IDLE_DEFAULT = 15;
const DESTROY_DEFAULT = 1440;

/** How much of a long text one answer carries, as in computer.js. */
const TEXT_PAGE = 30000;

const STOPPED = 'The user stopped this turn, so this was not done. Stop here and wait for them.';

const NO_KEY = 'There is no Spaceyard API key. The user can add one in Settings, Agentic Use, "Cloud sandboxes" '
    + '(it is kept in the keychain as the secret "spaceyard"), or with ask_user and secret "spaceyard". It is made on '
    + 'the console\'s API key page, https://console.spaceyard.dev/api-key.';

const SWITCHED_OFF = 'Spaceyard sandboxes are switched off for this agent. The user can switch them on in Settings, '
    + 'Agentic Use, "Cloud sandboxes". Say so rather than working around it.';

/** A secret's reference standing alone, with a new line after it or not. */
const SECRET_ALONE = /^\{\{\s*secret:([A-Za-z0-9_][A-Za-z0-9_.-]{0,59})\s*\}\}(\r?\n)?$/;
const SECRET_ANYWHERE = /\{\{\s*secret:[A-Za-z0-9_][A-Za-z0-9_.-]{0,59}\s*\}\}/;

let hooks = {
    fetch: (...args) => globalThis.fetch(...args),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    // Shrinking and cropping pictures. Electron's nativeImage unless a test
    // hands in its own; null where there is neither.
    imaging: undefined,
};

/** How often a starting sandbox is asked after, and for how long (ms). */
const TIMING = { poll: 2000, boot: 240000, ready: 90000 };
let timing = TIMING;

function configure(next = {}) {
    const { timing: times, ...rest } = next;
    hooks = { ...hooks, ...rest };
    if (times) timing = { ...TIMING, ...times };
}

/* ------------------------------------------------------------------ *
 * The API
 * ------------------------------------------------------------------ */

class SpaceyardError extends Error {
    constructor(message, { status = 0, code = '', data = null } = {}) {
        super(message);
        this.name = 'SpaceyardError';
        this.status = status;
        this.code = code;
        this.data = data;
    }
}

/**
 * The API, on one key. Every answer is `data` from Spaceyard's envelope (or
 * the whole body, for the lists that carry limits beside it); a failure is
 * thrown as a SpaceyardError with Spaceyard's own message. Too many requests
 * are waited out and tried again, and so, for what is safe to ask twice, is a
 * sandbox that has only just started and does not answer yet (503).
 */
function client(key) {
    const call = async (method, path, body = null, { raw = false, retry = true } = {}) => {
        for (let attempt = 0; ; attempt += 1) {
            let response;
            try {
                response = await hooks.fetch(API + path, {
                    method,
                    headers: {
                        Authorization: `Bearer ${key}`,
                        Accept: 'application/json',
                        ...(body ? { 'Content-Type': 'application/json' } : {}),
                    },
                    ...(body ? { body: JSON.stringify(body) } : {}),
                    signal: AbortSignal.timeout(120000),
                });
            } catch (error) {
                throw new SpaceyardError(`Spaceyard could not be reached: ${error.message}`);
            }
            let json = null;
            try {
                json = await response.json();
            } catch {
                // No body, or not JSON: the status says enough.
            }
            if (response.ok) return raw ? json : json?.data;
            const { status } = response;
            if ((status === 429 || (status === 503 && retry)) && attempt < 3) {
                const after = Number(response.headers?.get?.('retry-after'));
                await hooks.sleep((status === 429 && after > 0 ? Math.min(after, 20) : 2) * 1000);
                continue;
            }
            throw new SpaceyardError(json?.error?.message || `Spaceyard answered ${status}.`, {
                status,
                code: json?.error?.code || '',
                data: json?.data ?? null,
            });
        }
    };
    const at = uuid => `/sandboxes/${encodeURIComponent(uuid)}`;
    return {
        images: () => call('GET', '/sandboxes/images', null, { raw: true }),
        list: () => call('GET', '/sandboxes', null, { raw: true }),
        get: uuid => call('GET', at(uuid)),
        create: body => call('POST', '/sandboxes', body, { retry: false }),
        start: uuid => call('POST', `${at(uuid)}/start`, null, { retry: false }),
        stop: uuid => call('POST', `${at(uuid)}/stop`, null, { retry: false }),
        destroy: uuid => call('DELETE', at(uuid), null, { retry: false }),
        exec: (uuid, command) => call('POST', `${at(uuid)}/exec`, { command }, { retry: false }),
        computer: (uuid, action, { retry = false } = {}) => call('POST', `${at(uuid)}/computer`, action, { retry }),
    };
}

/** The user's key for an agent, or '' when there is none. */
function keyOf(state) {
    const value = state.resolveSecrets(KEY_REFERENCE);
    return value && value !== KEY_REFERENCE ? String(value).trim() : '';
}

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

const describeTarget = target => (target
    ? `sandbox "${target.name || String(target.uuid).slice(0, 8)}" (${target.os === 'windows' ? 'Windows' : 'Linux'}, ${target.uuid})`
    : 'this computer');

const watchUrl = uuid => `${CONSOLE}/sandboxes/${encodeURIComponent(uuid)}?tab=desktop`;

const euros = value => (Number.isFinite(Number(value)) ? `€${Number(value)}` : '');

/** A sandbox as the agent reads one. */
function summary(sandbox, target = null) {
    return {
        id: sandbox.uuid,
        ...(sandbox.name ? { name: sandbox.name } : {}),
        os: sandbox.os,
        image: sandbox.image,
        status: sandbox.status,
        ...(sandbox.desktop === false ? { desktop: 'none: computer use does not work on it, sandbox_command does' } : {}),
        price: `${euros(sandbox.hourly_price)}/h running, ${euros(sandbox.stopped_hourly_price)}/h stopped`,
        ...(Number.isFinite(Number(sandbox.billed_total)) ? { billedSoFar: euros(sandbox.billed_total) } : {}),
        ...(sandbox.stops_at ? { stopsWhenIdleAt: sandbox.stops_at } : {}),
        ...(sandbox.destroys_at ? { destroyedAt: sandbox.destroys_at } : {}),
        ...(sandbox.error ? { error: sandbox.error } : {}),
        ...(target?.uuid === sandbox.uuid ? { inUse: 'the computer tools in this conversation act on it' } : {}),
    };
}

/** A Spaceyard failure as the agent should read it: what happened, and what to do about it. */
function explain(error, target = null) {
    if (!(error instanceof SpaceyardError)) return `Spaceyard: ${error?.message || error}`;
    const which = target ? describeTarget(target) : 'The sandbox';
    switch (error.status) {
        case 401:
            return 'Spaceyard did not accept the API key. The user can set a new one in Settings, Agentic Use, "Cloud sandboxes".';
        case 404:
            return `${which} is not on the Spaceyard account any more: it was destroyed, or the id is wrong. list_sandboxes `
                + 'shows what there is; start_sandbox makes a new one; use_computer with target "this" goes back to this computer.';
        case 409:
            return `${which} is not running: a sandbox stops by itself after a while without use. start_sandbox with `
                + `sandbox "${target?.uuid || 'its id'}" starts it again, its disk as it was.`;
        case 429:
            return 'Spaceyard is limiting how fast requests come. Wait a little, then go on with fewer calls (do_steps batches them).';
        default: {
            const reported = error.data && typeof error.data.error === 'string' && error.data.error !== error.message
                ? ` The desktop reported: ${error.data.error}` : '';
            return `${error.message}${reported}`;
        }
    }
}

/** A secret's name as a sandbox environment variable: letters, digits and underscores, not starting with a digit. */
function envNameFor(name) {
    const clean = String(name || '').replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
    return (/^[0-9]/.test(clean) ? `_${clean}` : clean).slice(0, 128);
}

/** What a conversation keeps of the sandbox it works in, persisted with it. */
function targetOf(sandbox, secrets = {}) {
    return {
        kind: 'spaceyard',
        uuid: String(sandbox.uuid),
        name: String(sandbox.name || ''),
        os: sandbox.os === 'windows' ? 'windows' : 'linux',
        image: String(sandbox.image || ''),
        env: Array.isArray(sandbox.env) ? sandbox.env.map(String) : [],
        secrets,
    };
}

/** A stored target as it comes back from disk, or null. */
function readTarget(raw) {
    if (!raw || typeof raw !== 'object' || raw.kind !== 'spaceyard' || typeof raw.uuid !== 'string' || !raw.uuid) return null;
    const secrets = {};
    if (raw.secrets && typeof raw.secrets === 'object') {
        for (const [name, env] of Object.entries(raw.secrets)) if (typeof env === 'string') secrets[name] = env;
    }
    return {
        kind: 'spaceyard',
        uuid: raw.uuid,
        name: typeof raw.name === 'string' ? raw.name : '',
        os: raw.os === 'windows' ? 'windows' : 'linux',
        image: typeof raw.image === 'string' ? raw.image : '',
        env: Array.isArray(raw.env) ? raw.env.filter(name => typeof name === 'string') : [],
        secrets,
    };
}

/** What start_sandbox and use_computer say once the tools are pointed at a sandbox. */
function pointedNote(target) {
    return 'From now on the computer tools (read_screen, screenshot, click, type_text, press_keys, scroll, drag, do_steps, '
        + 'wait_for, open_app, list_windows, hover, mouse_button) act on this sandbox, not on this computer, until '
        + 'use_computer or stop_sandbox says otherwise. '
        + (target.os === 'windows'
            ? 'Its controls are listed without where they are, so click by x and y from a screenshot. '
            : 'Its controls are numbered afresh with every read: act on the numbers from the latest one. ')
        + 'sandbox_command runs a shell command on it. It is billed by the minute while it runs, so stop_sandbox it when '
        + 'the work is done. The user can watch it, or take over, at the watch link.';
}

/* ------------------------------------------------------------------ *
 * Pictures
 * ------------------------------------------------------------------ */

/** Shrinking and cropping, with Electron's nativeImage; null where it cannot be had. */
function imaging() {
    if (hooks.imaging !== undefined) return hooks.imaging;
    try {
        const { nativeImage } = require('electron');
        if (!nativeImage?.createFromBuffer) return null;
        const open = data => nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
        return {
            resize: (data, width, height) => open(data).resize({ width, height, quality: 'good' }).toJPEG(80).toString('base64'),
            crop: (data, rect) => open(data).crop(rect).toPNG().toString('base64'),
        };
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------ *
 * What each conversation keeps, and each sandbox
 * ------------------------------------------------------------------ */

const reads = new Map();     // conversation -> { uuid, nodes: Map(number -> node), window }
const frames = new Map();    // conversation -> latest screenshot: { uuid, width, height, scale, screenWidth, screenHeight }
const looks = new Map();     // conversation -> 'image' | 'tree': how the agent has been looking
const halted = new Set();    // conversations whose turn the user stopped
const pressed = new Map();   // conversation -> [{ uuid, key, button }] mouse buttons held down
const sizes = new Map();     // sandbox -> its screen { width, height }
const queues = new Map();    // sandbox -> the tail of its actions

/** One action at a time per sandbox, whoever sends it. */
function exclusive(uuid, work) {
    const before = queues.get(uuid) || Promise.resolve();
    const run = before.then(work, work);
    const tail = run.then(() => {}, () => {});
    queues.set(uuid, tail);
    tail.then(() => { if (queues.get(uuid) === tail) queues.delete(uuid); });
    return run;
}

/** A conversation done with its sandbox: its numbers and its picture mean nothing on the next. */
function forgetSandbox(conversationId) {
    reads.delete(conversationId);
    frames.delete(conversationId);
    looks.delete(conversationId);
}

/** The user stopped the turn: nothing more of it reaches the sandbox. */
function halt(conversationId) {
    halted.add(conversationId);
    release(conversationId);
}

/** A new turn may act again. */
function resume(conversationId) {
    halted.delete(conversationId);
}

/** The turn is over: a mouse button it pressed and never let go is let go. */
function release(conversationId) {
    const held = pressed.get(conversationId);
    if (!held) return;
    pressed.delete(conversationId);
    for (const { uuid, key, button } of held) {
        client(key).computer(uuid, { action: 'mouse_up', button }).catch(() => {});
    }
}

/** A conversation thrown away. */
function forget(conversationId) {
    halted.delete(conversationId);
    release(conversationId);
    forgetSandbox(conversationId);
}

/* ------------------------------------------------------------------ *
 * Reading a sandbox's screen
 * ------------------------------------------------------------------ */

/**
 * Spaceyard's controls in the shape computer.formatTree reads. A Linux read
 * (sandbox-a11y) gives `{ n: number, role, name, value?, states?, x, y, box }`;
 * a Windows one passes on the Acestes helper's own `{ id, d, r, n: name, v, s }`.
 */
function normaliseNodes(raw) {
    return (Array.isArray(raw) ? raw : []).filter(node => node && typeof node === 'object').map((node) => {
        if ('role' in node) {
            const box = Array.isArray(node.box) && node.box.length === 4 ? node.box.map(Number) : null;
            return {
                id: Number(node.n ?? node.id),
                d: Number(node.d ?? node.depth ?? 0) || 0,
                r: String(node.role || 'control'),
                n: String(node.name || ''),
                v: node.value == null ? '' : String(node.value),
                s: Array.isArray(node.states) ? node.states.join(', ') : String(node.states || ''),
                x: Number.isFinite(Number(node.x)) ? Number(node.x) : (box ? box[0] + box[2] / 2 : NaN),
                y: Number.isFinite(Number(node.y)) ? Number(node.y) : (box ? box[1] + box[3] / 2 : NaN),
                box,
            };
        }
        const rect = Array.isArray(node.rect) ? node.rect.map(Number) : null;
        return {
            ...node,
            x: rect ? rect[0] + rect[2] / 2 : NaN,
            y: rect ? rect[1] + rect[3] / 2 : NaN,
            box: rect,
        };
    });
}

/** A window as the agent reads one, from either system's answer. */
function briefWindow(window) {
    if (!window || typeof window !== 'object') return undefined;
    const id = window.hwnd ?? window.id;
    const app = window.process || window.app;
    return {
        ...(id != null ? { id: String(id) } : {}),
        title: String(window.title || ''),
        ...(app ? { app: String(app) } : {}),
    };
}

/** The open windows, from either system's answer, leaving out the desktop's own (a sticky panel, the desktop itself). */
function listWindows(raw) {
    return (Array.isArray(raw) ? raw : [])
        .filter(window => window && window.desktop !== -1 && !window.protected)
        .map(window => ({
            id: String(window.id ?? window.hwnd ?? ''),
            title: String(window.title || ''),
            app: String(window.process || window.app || (window.pid ? `pid ${window.pid}` : '')),
            front: Boolean(window.active ?? window.foreground),
            minimized: Boolean(window.minimized),
        }));
}

/** The words in a read, in order, each once: what read_text gives in a sandbox. */
function textOf(nodes) {
    const lines = [];
    const seen = new Set();
    for (const node of nodes) {
        for (const part of [node.n, node.v]) {
            const text = String(part || '').trim();
            if (!text || seen.has(text)) continue;
            seen.add(text);
            lines.push(text);
        }
    }
    return lines.join('\n');
}

/** At most `most` points of a path, its first and last kept. */
function thin(points, most) {
    if (points.length <= most) return points;
    const step = (points.length - 1) / (most - 1);
    return Array.from({ length: most }, (_, index) => points[Math.round(index * step)]);
}

const clamp = (value, low, high, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : fallback;
};

/* ------------------------------------------------------------------ *
 * One conversation's hands, in its sandbox
 * ------------------------------------------------------------------ */

/**
 * What the computer tools reach through for a conversation pointed at a
 * sandbox: the methods computer.apiFor has, by the same names and taking the
 * same input, so computer-tools.js does not know which it has. `state`:
 * `{ id, settings(), canSee(), resolveSecrets(text), target() }`.
 */
function computerFor(state) {
    const settings = () => state.settings() || {};
    const target = () => state.target();
    const name = () => describeTarget(target());

    const refusal = () => {
        if (!target()) return 'This conversation is not using a sandbox.';
        if (!settings().spaceyard) {
            return `This conversation works in ${name()}, but Spaceyard sandboxes are switched off for this agent. The user `
                + 'can switch them on in Settings, Agentic Use, "Cloud sandboxes"; use_computer with target "this" works on '
                + 'this computer instead. Say so rather than working around it.';
        }
        if (!keyOf(state)) return NO_KEY;
        return '';
    };

    /** One computer use action on the sandbox: its answer, or `{ error }`. */
    const act = async (action, payload = {}, { picture = false, retry = false } = {}) => {
        const current = target();
        try {
            const answer = await client(keyOf(state)).computer(current.uuid, {
                action,
                ...payload,
                ...(picture ? { screenshot: true, format: 'jpeg' } : {}),
            }, { retry });
            return answer && typeof answer === 'object' ? answer : {};
        } catch (error) {
            return { error: explain(error, current) };
        }
    };

    /** The sandbox's screen, in real pixels, asked for once. */
    const screenSize = async () => {
        const { uuid } = target();
        if (sizes.has(uuid)) return sizes.get(uuid);
        const answer = await act('size', {}, { retry: true });
        if (answer.error || !Number(answer.width) || !Number(answer.height)) return null;
        const size = { width: Number(answer.width), height: Number(answer.height) };
        sizes.set(uuid, size);
        return size;
    };

    /**
     * A screenshot as the agent gets it: shrunk to what a model takes, and
     * made the frame the next x and y are read against. The frame is
     * reckoned against the screen's real size, which a Windows sandbox's
     * picture may already be smaller than.
     */
    const shown = async (shot) => {
        if (!shot?.image) return { error: 'Spaceyard sent no picture.' };
        const screen = await screenSize();
        let data = String(shot.image);
        let mediaType = shot.format === 'png' ? 'image/png' : 'image/jpeg';
        let width = Number(shot.width) || screen?.width || 0;
        let height = Number(shot.height) || screen?.height || 0;
        if (!width || !height) return { error: 'Spaceyard sent a picture without its size.' };
        const fit = Math.min(1, IMAGE.maxLong / Math.max(width, height), Math.sqrt(IMAGE.maxPixels / (width * height)));
        const tools = imaging();
        if (fit < 0.999 && tools) {
            const smaller = { width: Math.max(1, Math.round(width * fit)), height: Math.max(1, Math.round(height * fit)) };
            try {
                data = tools.resize(data, smaller.width, smaller.height);
                mediaType = 'image/jpeg';
                ({ width, height } = smaller);
            } catch (error) {
                console.error('Could not shrink a sandbox screenshot:', error.message);
            }
        }
        const screenWidth = screen?.width || width;
        const screenHeight = screen?.height || height;
        frames.set(state.id, { uuid: target().uuid, width, height, scale: width / screenWidth, screenWidth, screenHeight });
        return {
            screenshot: {
                of: `the screen of ${name()}`,
                size: `${width}×${height}`,
                note: 'x and y for click, scroll and drag are pixels of this picture.',
            },
            image: { mediaType, data },
        };
    };

    /** A pixel of the latest screenshot, as a point on the sandbox's screen. */
    const toScreen = (x, y) => {
        const frame = frames.get(state.id);
        if (!frame || frame.uuid !== target().uuid) {
            return { error: 'x and y are pixels of a screenshot. Take one of the sandbox first, or name an element from read_screen.' };
        }
        if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
            return { error: `(${x}, ${y}) is outside your latest screenshot, which is ${frame.width}×${frame.height}.` };
        }
        return {
            x: Math.min(frame.screenWidth - 1, Math.round(x / frame.scale)),
            y: Math.min(frame.screenHeight - 1, Math.round(y / frame.scale)),
        };
    };

    /** Where an element or a pixel is on the sandbox's screen. */
    const aim = ({ element, x, y }) => {
        if (element) {
            const read = reads.get(state.id);
            if (!read || read.uuid !== target().uuid) {
                return { error: 'Element numbers come from read_screen: read the sandbox\'s screen first.' };
            }
            const node = read.nodes.get(Number(element));
            if (!node) return { error: `There is no element ${element} in your latest read. Read the screen again.` };
            if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
                return {
                    error: `Element ${element} came without a place on the screen (a Windows sandbox lists its controls `
                        + 'without one). Take a screenshot and give x and y.',
                };
            }
            return { x: Math.round(node.x), y: Math.round(node.y) };
        }
        if (Number.isFinite(x) && Number.isFinite(y)) return toScreen(x, y);
        return { error: 'Say where: an element number from read_screen, or x and y in your latest screenshot.' };
    };

    /** The open windows, or `{ error }`. */
    const windowsNow = async () => {
        const answer = await act('windows', {}, { retry: true });
        if (answer.error) return answer;
        return { windows: listWindows(answer.windows) };
    };

    /** A window by its id, its app, or part of its title. */
    const pickWindow = async (query) => {
        const listed = await windowsNow();
        if (listed.error) return listed;
        const wanted = String(query ?? '').trim();
        const lower = wanted.toLowerCase();
        const found = listed.windows.find(window => window.id === wanted)
            || listed.windows.find(window => window.app.toLowerCase() === lower)
            || listed.windows.find(window => window.title.toLowerCase().includes(lower));
        if (!found) return { error: `No window in ${name()} matches "${wanted}". list_windows shows what is open there.` };
        return { window: found };
    };

    /** A window brought to the front. */
    const focusWindow = async (query) => {
        const picked = await pickWindow(query);
        if (picked.error) return picked;
        const answer = await act('focus', { window: picked.window.id });
        return answer.error ? answer : picked;
    };

    /**
     * What read_screen takes as a window: on Linux part of its title (the
     * accessibility tree goes by title), on Windows its id.
     */
    const readArgument = window => (target().os === 'windows' ? window.id : window.title);

    /** A read of a window (the one in front when none is named), kept as the numbers the next action goes by. */
    const readWindow = async (window, maxNodes = 300) => {
        const answer = await act('read_screen', {
            ...(window ? { window } : {}),
            max_nodes: clamp(maxNodes, 20, 1500, 300),
        }, { retry: true });
        if (answer.error) return answer;
        const nodes = normaliseNodes(answer.nodes);
        reads.set(state.id, {
            uuid: target().uuid,
            nodes: new Map(nodes.filter(node => Number.isFinite(node.id)).map(node => [node.id, node])),
            window: answer.window || null,
        });
        return { answer, nodes };
    };

    const present = ({ answer, nodes }) => ({
        window: briefWindow(answer.window),
        elements: formatTree(nodes) || '(no controls)',
        ...(answer.truncated ? { truncated: 'Stopped at the limit: read_screen with a larger maxElements reads more.' } : {}),
        ...(nodes.length <= 6 ? {
            sparse: 'Very little is exposed here: some apps do not describe their insides to the accessibility API. '
                + 'Take a screenshot to see it; keyboard shortcuts may still work.',
        } : {}),
    });

    /** Whether the agent has been working from pictures, and so gets one back after an action. */
    const wantsPicture = () => looks.get(state.id) === 'image' && state.canSee();

    /**
     * The sandbox after an action, the way the agent has been looking at it:
     * the picture that came with the action, a fresh one, or a read of the
     * window in front. Nothing with read: false.
     */
    const after = async (answer, { read } = {}) => {
        if (read === false) return {};
        if (wantsPicture()) {
            if (answer?.screenshot?.image) return shown(answer.screenshot);
            const shot = await act('screenshot', { format: 'jpeg', quality: 80 }, { retry: true });
            if (shot.error) return {};
            const picture = await shown(shot);
            return picture.error ? {} : picture;
        }
        const fresh = await readWindow(undefined);
        return fresh.error ? {} : { screen: present(fresh) };
    };

    /** The middle of the window last read, where a scroll aimed at nothing goes. */
    const middle = () => {
        const read = reads.get(state.id);
        const box = read?.uuid === target().uuid ? read.window?.box : null;
        return Array.isArray(box) && box.length === 4
            ? { x: Math.round(box[0] + box[2] / 2), y: Math.round(box[1] + box[3] / 2) }
            : null;
    };

    /* The actions, each one step: `{ said, answer }` or `{ error }`. */

    const doClick = async ({ element, x, y, button, count, modifiers }, picture) => {
        if (modifiers) {
            return { error: 'A click with keys held is not possible in a sandbox yet. Use a shortcut, or press the keys and click apart.' };
        }
        const at = aim({ element, x, y });
        if (at.error) return at;
        const answer = await act('click', { x: at.x, y: at.y, ...(button ? { button } : {}), ...(count ? { count } : {}) }, { picture });
        if (answer.error) return answer;
        return { said: { clicked: element ? `element ${element}` : `${x},${y}` }, answer };
    };

    const doType = async ({ text, element, x, y, replace }, picture) => {
        const raw = String(text ?? '');
        if (!raw) return { error: 'Nothing to type.' };
        if (element || (Number.isFinite(x) && Number.isFinite(y))) {
            const at = aim({ element, x, y });
            if (at.error) return at;
            const clicked = await act('click', { x: at.x, y: at.y });
            if (clicked.error) return clicked;
        }
        if (replace) {
            const cleared = await act('key', { keys: 'ctrl+a' });
            if (cleared.error) return cleared;
        }
        const secret = SECRET_ALONE.exec(raw);
        if (secret) {
            const [, secretName, enter] = secret;
            const current = target();
            const env = current.secrets?.[secretName] || envNameFor(secretName);
            if (!current.env.includes(env)) {
                return {
                    error: `The secret "${secretName}" was not given to this sandbox. In a sandbox a secret is typed from the `
                        + `sandbox's own environment variables, so it is in no request and no log: start a new one with `
                        + `start_sandbox and secrets ["${secretName}"]. A sandbox's variables are set when it is created.`,
                };
            }
            const typed = await act('type', { env }, { picture: picture && !enter });
            if (typed.error) {
                return {
                    error: /text is required/i.test(typed.error)
                        ? 'This Spaceyard does not type a variable by name yet, so the secret was not typed. Ask the user to type it in the Spaceyard console.'
                        : typed.error,
                };
            }
            let answer = typed;
            if (enter) {
                answer = await act('key', { keys: 'enter' }, { picture });
                if (answer.error) return answer;
            }
            return { said: { typed: `the secret ${secretName}${enter ? ', then Enter' : ''}` }, answer };
        }
        if (SECRET_ANYWHERE.test(raw)) {
            return {
                error: 'In a sandbox a secret is typed on its own: type_text with text that is only its {{secret:name}} '
                    + 'reference (a new line after it presses Enter), and the words around it in calls of their own.',
            };
        }
        const answer = await act('type', { text: raw }, { picture });
        if (answer.error) return answer;
        return { said: { typed: `${answer.typed ?? raw.length} characters` }, answer };
    };

    const doKeys = async ({ keys, window, repeat }, picture) => {
        if (!keys) return { error: 'Name the keys, like "ctrl+s" or "enter".' };
        if (window) {
            const focused = await focusWindow(window);
            if (focused.error) return focused;
        }
        const answer = await act('key', { keys, ...(repeat ? { repeat } : {}) }, { picture });
        if (answer.error) return answer;
        return { said: { pressed: repeat > 1 ? `${keys} ${repeat} times` : keys }, answer };
    };

    const doScroll = async ({ element, x, y, direction, amount, toEnd }, picture) => {
        if (!direction) return { error: 'Say which way to scroll.' };
        if (toEnd) return { error: 'toEnd works on this computer only. In a sandbox, scroll with amount (up to 30) and look again.' };
        let at = null;
        if (element || (Number.isFinite(x) && Number.isFinite(y))) {
            at = aim({ element, x, y });
            if (at.error) return at;
        } else {
            at = middle();
        }
        const answer = await act('scroll', {
            ...(at ? { x: at.x, y: at.y } : {}),
            direction,
            ...(amount ? { amount } : {}),
        }, { picture });
        if (answer.error) return answer;
        return { said: { scrolled: `${direction} ${amount || 3}` }, answer };
    };

    const doDrag = async ({ fromElement, fromX, fromY, toElement, toX, toY, path }, picture) => {
        if (Array.isArray(path) && path.length) {
            if (path.length < 2) return { error: 'A path needs two points at least.' };
            const points = [];
            for (const point of path) {
                const at = toScreen(point.x, point.y);
                if (at.error) return at;
                points.push(at);
            }
            // Each point is a request of its own; a path of hundreds keeps its shape with a few dozen.
            const route = thin(points, 30);
            const down = await act('mouse_down', { x: route[0].x, y: route[0].y });
            if (down.error) return down;
            for (const point of route.slice(1)) {
                const moved = await act('move', { x: point.x, y: point.y });
                if (moved.error) {
                    await act('mouse_up', {});
                    return moved;
                }
            }
            const answer = await act('mouse_up', {}, { picture });
            if (answer.error) return answer;
            return { said: { dragged: `through ${points.length} points` }, answer };
        }
        const from = aim({ element: fromElement, x: fromX, y: fromY });
        if (from.error) return from;
        const to = aim({ element: toElement, x: toX, y: toY });
        if (to.error) return to;
        const answer = await act('drag', { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } }, { picture });
        if (answer.error) return answer;
        return { said: { dragged: true }, answer };
    };

    const doHover = async ({ element, x, y, seconds }) => {
        const at = aim({ element, x, y });
        if (at.error) return at;
        const moved = await act('move', { x: at.x, y: at.y });
        if (moved.error) return moved;
        const dwell = clamp(seconds ?? 0.8, 0, 10, 0.8);
        if (dwell > 0) await hooks.sleep(dwell * 1000);
        // The look after is taken fresh, once the hover has had its moment.
        return { said: { hovered: element ? `element ${element}` : `${x},${y}` }, answer: {} };
    };

    const doMouse = async ({ action, button = 'left', element, x, y }, picture) => {
        if (action !== 'down' && action !== 'up') return { error: 'Say down or up.' };
        const placed = element || (Number.isFinite(x) && Number.isFinite(y));
        if (action === 'down' && !placed) return { error: 'Say where to press: an element, or x and y in your latest screenshot.' };
        let at = null;
        if (placed) {
            at = aim({ element, x, y });
            if (at.error) return at;
        }
        const answer = await act(action === 'down' ? 'mouse_down' : 'mouse_up', {
            ...(at ? { x: at.x, y: at.y } : {}),
            button,
        }, { picture });
        if (answer.error) return answer;
        const held = (pressed.get(state.id) || []).filter(entry => entry.button !== button || entry.uuid !== target().uuid);
        if (action === 'down') held.push({ uuid: target().uuid, key: keyOf(state), button });
        if (held.length) pressed.set(state.id, held);
        else pressed.delete(state.id);
        const where = at ? ` at ${element ? `element ${element}` : `${x},${y}`}` : '';
        return {
            said: action === 'down' ? { pressed: `the ${button} button${where}, held down` } : { released: `the ${button} button${where}` },
            answer,
        };
    };

    const doWait = async ({ text, role, window, seconds, timeout, gone }) => {
        if (!text) return { error: 'Say what to wait for.' };
        let argument;
        if (window) {
            const picked = await pickWindow(window);
            if (picked.error) return picked;
            argument = readArgument(picked.window);
        }
        const limit = clamp(seconds || timeout || 10, 1, 60, 10);
        const deadline = hooks.now() + limit * 1000;
        const wanted = String(text).toLowerCase();
        const kind = String(role || '').toLowerCase();
        do {
            if (halted.has(state.id)) return { error: STOPPED };
            const read = await readWindow(argument, 500);
            if (read.error) return read;
            const match = read.nodes.find(node => (!kind || String(node.r || '').toLowerCase().includes(kind))
                && `${node.n || ''} ${node.v || ''}`.toLowerCase().includes(wanted));
            if (gone && !match) return { said: { gone: `nothing matching "${text}" is there now` }, read };
            if (!gone && match) return { said: { found: `${match.r} "${match.n || match.v}"` }, read };
            await hooks.sleep(700);
        } while (hooks.now() < deadline);
        const span = `${limit} second${limit === 1 ? '' : 's'}`;
        return { error: gone ? `"${text}" was still there after ${span}.` : `Nothing matching "${text}" appeared within ${span}.` };
    };

    const doPause = async ({ seconds }) => {
        const wait = clamp(seconds, 0.1, 30, 1);
        await hooks.sleep(wait * 1000);
        return { said: { paused: `${wait}s` }, answer: {} };
    };

    const notHere = (tool, why) => async () => ({ error: `${tool} works on this computer only: ${why}.` });

    const STEPS = {
        click: doClick,
        type: doType,
        keys: doKeys,
        scroll: doScroll,
        drag: doDrag,
        wait_for: doWait,
        pause: doPause,
        hover: doHover,
        mouse_down: (step, picture) => doMouse({ ...step, action: 'down' }, picture),
        mouse_up: (step, picture) => doMouse({ ...step, action: 'up' }, picture),
        hold_key: notHere('hold_key', 'Spaceyard has no way to keep a key held down yet'),
    };

    /** Every call: allowed, not stopped, and one at a time on the sandbox. */
    const guarded = work => async (input = {}) => {
        const refused = refusal();
        if (refused) return { error: refused };
        if (halted.has(state.id)) return { error: STOPPED };
        return exclusive(target().uuid, () => (halted.has(state.id) ? { error: STOPPED } : work(input || {})));
    };

    /** An action as a tool: done, then the sandbox as it is after. */
    const single = step => guarded(async (input) => {
        const picture = input.read !== false && wantsPicture();
        const outcome = await step(input, picture);
        if (outcome.error) return { error: outcome.error };
        return { ...outcome.said, ...(await after(outcome.answer, input)) };
    });

    return {
        windows: guarded(async () => {
            const listed = await windowsNow();
            if (listed.error) return listed;
            return {
                computer: name(),
                windows: listed.windows.map(window => ({
                    id: window.id,
                    title: window.title,
                    ...(window.app ? { app: window.app } : {}),
                    ...(window.front ? { front: true } : {}),
                    ...(window.minimized ? { minimized: true } : {}),
                })),
            };
        }),

        open: guarded(async ({ app, args = '' }) => {
            // Linux runs anything that is not a URL or a file as a command
            // line, arguments and all; Windows takes them apart.
            const linux = target().os !== 'windows';
            const answer = await act('open', {
                target: linux && args ? `${app} ${args}` : app,
                ...(!linux && args ? { args } : {}),
                wait: 2,
            });
            if (answer.error) return answer;
            return { opened: `${app} in ${name()}`, ...(await after(null, {})) };
        }),

        read: guarded(async ({ window, maxElements, under }) => {
            if (under) {
                return { error: 'under works on this computer only. In a sandbox read_screen reads the whole window; pass maxElements (up to 1500) for more.' };
            }
            let argument;
            if (window) {
                const picked = await pickWindow(window);
                if (picked.error) return picked;
                argument = readArgument(picked.window);
            }
            const read = await readWindow(argument, maxElements || 300);
            if (read.error) return read;
            looks.set(state.id, 'tree');
            return { computer: name(), ...present(read) };
        }),

        screenshot: guarded(async ({ window }) => {
            if (!state.canSee()) {
                return { error: 'The runtime this agent is on cannot see images. Use read_screen and read_text, or switch to one that can (Claude Code, Codex).' };
            }
            if (window) {
                const focused = await focusWindow(window);
                if (focused.error) return focused;
            }
            const shot = await act('screenshot', { format: 'jpeg', quality: 80 }, { retry: true });
            if (shot.error) return shot;
            const picture = await shown(shot);
            if (!picture.error) looks.set(state.id, 'image');
            return picture;
        }),

        zoom: guarded(async ({ x0, y0, x1, y1 }) => {
            if (!state.canSee()) return { error: 'The runtime this agent is on cannot see images.' };
            const frame = frames.get(state.id);
            if (!frame || frame.uuid !== target().uuid) return { error: 'Take a screenshot first: zoom looks closer at part of it.' };
            const tools = imaging();
            if (!tools) return { error: 'Zooming is not available here. Take a screenshot instead.' };
            const left = Math.max(0, Math.min(x0, x1));
            const top = Math.max(0, Math.min(y0, y1));
            const right = Math.min(frame.width, Math.max(x0, x1));
            const bottom = Math.min(frame.height, Math.max(y0, y1));
            if (right - left < 4 || bottom - top < 4) return { error: 'That region is too small, or outside the screenshot.' };
            const shot = await act('screenshot', { format: 'png' }, { retry: true });
            if (shot.error) return shot;
            // The fresh picture's own pixels per screen pixel: a Windows
            // sandbox's may be smaller than its screen.
            const per = (Number(shot.width) || frame.screenWidth) / frame.screenWidth;
            const rect = {
                x: Math.round((left / frame.scale) * per),
                y: Math.round((top / frame.scale) * per),
                width: Math.max(1, Math.round(((right - left) / frame.scale) * per)),
                height: Math.max(1, Math.round(((bottom - top) / frame.scale) * per)),
            };
            let data;
            try {
                data = tools.crop(String(shot.image || ''), rect);
            } catch (error) {
                return { error: `The picture could not be cropped: ${error.message}` };
            }
            return {
                zoomed: `(${left}, ${top}) to (${right}, ${bottom}) of your screenshot, at ${rect.width}×${rect.height}`,
                note: 'x and y for click, scroll and drag are still pixels of the full screenshot, not of this.',
                image: { mediaType: 'image/png', data },
            };
        }),

        text: guarded(async ({ element, window, offset = 0 }) => {
            let whole;
            if (element) {
                const read = reads.get(state.id);
                const node = read?.uuid === target().uuid ? read.nodes.get(Number(element)) : null;
                if (!node) return { error: `There is no element ${element} in your latest read. Read the screen again.` };
                whole = [node.n, node.v].filter(Boolean).join('\n');
            } else {
                let argument;
                if (window) {
                    const picked = await pickWindow(window);
                    if (picked.error) return picked;
                    argument = readArgument(picked.window);
                }
                const read = await readWindow(argument, 1500);
                if (read.error) return read;
                whole = textOf(read.nodes);
            }
            const start = Math.max(0, Math.min(Number(offset) || 0, whole.length));
            const end = Math.min(whole.length, start + TEXT_PAGE);
            return {
                length: whole.length,
                ...(start > 0 ? { offset: start } : {}),
                ...(end < whole.length ? { nextOffset: end } : {}),
                text: whole.slice(start, end),
                ...(element ? {} : { note: 'In a sandbox this is the words of the window\'s controls. A file\'s whole text is sandbox_command\'s to read.' }),
            };
        }),

        click: single(doClick),
        type: single(doType),
        keys: single(doKeys),
        scroll: single(doScroll),
        drag: single(doDrag),
        hover: single(doHover),
        mouse: single(doMouse),
        hold: notHere('hold_key', 'Spaceyard has no way to keep a key held down yet'),
        clipboard: notHere('read_clipboard', 'Spaceyard does not read a sandbox\'s clipboard. Paste into a field and read that, or use sandbox_command'),
        arrange: notHere('arrange_windows', 'a sandbox has one screen and Spaceyard does not place windows. Use keyboard shortcuts there'),
        captcha: async () => ({
            error: `solve_captcha works on this computer only for now. Ask the user to solve it in the sandbox: they can take over at ${watchUrl(target()?.uuid || '')}.`,
        }),

        waitFor: guarded(async (input) => {
            const result = await doWait(input);
            if (result.error) return result;
            return { ...result.said, ...(wantsPicture() ? await after(null, {}) : { screen: present(result.read) }) };
        }),

        steps: guarded(async ({ steps = [] }) => {
            const done = [];
            for (const [index, step] of steps.entries()) {
                const run = STEPS[step?.do];
                if (!run) return { error: `Step ${index + 1}: there is no action "${step?.do}".` };
                if (halted.has(state.id)) {
                    return { error: done.length ? `${STOPPED} The ${done.length} step${done.length === 1 ? '' : 's'} before it were done.` : STOPPED };
                }
                const outcome = await run(step || {}, false);
                if (outcome.error) {
                    // A failed batch is planned again from what is there now.
                    const now = wantsPicture() ? {} : await after(null, {});
                    const screen = now.screen ? `\n\nThe window now:\n${now.screen.elements}` : '';
                    return {
                        error: `Step ${index + 1} of ${steps.length} (${step.do}) failed: ${outcome.error}`
                            + `${done.length ? ` The ${done.length} before it were done.` : ''}${screen}`,
                    };
                }
                done.push(`${index + 1}. ${Object.entries(outcome.said || {}).map(([key, value]) => `${key} ${value}`).join(', ')}`);
            }
            return { done, ...(await after(null, {})) };
        }),
    };
}

/* ------------------------------------------------------------------ *
 * Starting, stopping and choosing a sandbox
 * ------------------------------------------------------------------ */

/** The image to start from: the one named, or the cheapest desktop of the system asked for (Linux by default). */
function pickImage(offer, { os, image } = {}) {
    const all = Array.isArray(offer?.data) ? offer.data : [];
    let candidates;
    if (image) {
        const wanted = String(image).trim().toLowerCase();
        candidates = all.filter(entry => String(entry.id) === wanted || String(entry.slug || '').toLowerCase() === wanted)
            .concat(all.filter(entry => String(entry.name || '').toLowerCase().includes(wanted)));
        if (!candidates.length) return { error: `No Spaceyard image matches "${image}". list_sandboxes shows the images there are.` };
        if (os) candidates = candidates.filter(entry => entry.os === os);
    } else {
        const system = os || 'linux';
        candidates = all.filter(entry => entry.desktop && entry.os === system);
        if (!candidates.length) return { error: `Spaceyard offers no ${system === 'windows' ? 'Windows' : 'Linux'} desktop image.` };
    }
    if (!candidates.length) return { error: `"${image}" is not a ${os === 'windows' ? 'Windows' : 'Linux'} image.` };
    const usable = candidates.filter(entry => entry.allowed !== false && entry.in_stock !== false);
    if (!usable.length) {
        const first = candidates[0];
        const why = first.allowed === false
            ? 'the account\'s level does not allow it yet (it rises with the credit added, on the console\'s Billing page)'
            : 'it is out of stock right now; try again in a while, or another image';
        return { error: `${first.name || 'That image'} cannot be started: ${why}.` };
    }
    usable.sort((a, b) => (Number(a.hourly_price) || 0) - (Number(b.hourly_price) || 0));
    return { image: usable[0] };
}

/**
 * Until a sandbox runs. A stopped one (after a stop that was still going)
 * is started again when `resume`. Gives up after a few minutes, saying what
 * state it was left in, since it is billed whether or not anyone waits.
 */
async function waitRunning(api, sandbox, { resume = false, stopped = () => false } = {}) {
    const deadline = hooks.now() + timing.boot;
    let current = sandbox;
    for (;;) {
        if (current.status === 'running') return current;
        if (current.status === 'failed') return { error: `The sandbox could not start: ${current.error || 'Spaceyard gave no reason'}.` };
        if (current.status === 'deleting' || current.status === 'deleted') return { error: 'The sandbox was destroyed.' };
        if (resume && current.status === 'stopped') {
            current = await api.start(current.uuid);
            continue;
        }
        if (stopped()) return { error: `${STOPPED} Sandbox ${current.uuid} was left ${current.status}.` };
        if (hooks.now() >= deadline) {
            return {
                error: `Sandbox ${current.uuid} is still ${current.status} after ${Math.round(timing.boot / 60000)} minutes. `
                    + `start_sandbox with sandbox "${current.uuid}" waits for it again; stop_sandbox with destroy removes it.`,
            };
        }
        await hooks.sleep(timing.poll);
        current = await api.get(current.uuid);
    }
}

/** Until the desktop answers: a few seconds after it runs, longer while Windows logs in. Its screen size, or null. */
async function waitDesktop(api, uuid, { stopped = () => false } = {}) {
    const deadline = hooks.now() + timing.ready;
    for (;;) {
        try {
            const size = await api.computer(uuid, { action: 'size' }, { retry: true });
            if (Number(size?.width) && Number(size?.height)) return { width: Number(size.width), height: Number(size.height) };
        } catch (error) {
            if (!(error instanceof SpaceyardError) || ![409, 422, 503].includes(error.status)) return null;
        }
        if (stopped() || hooks.now() >= deadline) return null;
        await hooks.sleep(timing.poll);
    }
}

/**
 * Managing sandboxes for one conversation: the tools in spaceyard-tools.js
 * call these. `state`: `{ id, title(), settings(), resolveSecrets(text),
 * scrub(text), target(), setTarget(target) }`.
 */
function managerFor(state) {
    const settings = () => state.settings() || {};
    const refusal = () => {
        if (!settings().spaceyard) return SWITCHED_OFF;
        if (!keyOf(state)) return NO_KEY;
        return '';
    };
    const api = () => client(keyOf(state));
    const stopped = () => halted.has(state.id);
    const local = () => (settings().computerUse
        ? 'this computer'
        : 'this computer, where computer use is switched off, so they are refused until a sandbox is picked again');

    /** Point this conversation's computer tools at a running sandbox. */
    const point = async (sandbox, secrets = {}) => {
        const target = targetOf(sandbox, secrets);
        const size = await waitDesktop(api(), target.uuid, { stopped });
        if (size) sizes.set(target.uuid, size);
        forgetSandbox(state.id);
        state.setTarget(target);
        return {
            using: describeTarget(target),
            sandbox: summary(sandbox, target),
            ...(size ? { screen: `${size.width}×${size.height}` } : {
                desktop: 'The desktop has not answered yet: it may still be logging in. Try again in a few seconds.',
            }),
            watch: watchUrl(target.uuid),
            note: pointedNote(target),
        };
    };

    return {
        async list() {
            const refused = refusal();
            if (refused) return { error: refused };
            try {
                const yard = api();
                const [mine, offer] = await Promise.all([yard.list(), yard.images()]);
                const current = state.target();
                const limits = offer?.limits;
                return {
                    using: describeTarget(current),
                    sandboxes: (Array.isArray(mine?.data) ? mine.data : []).map(sandbox => summary(sandbox, current)),
                    ...(limits ? { limit: `${limits.used} of the ${limits.max} sandboxes this account may run at once are in use` } : {}),
                    images: (Array.isArray(offer?.data) ? offer.data : []).map(image => ({
                        id: image.id,
                        name: image.name,
                        ...(image.slug ? { slug: image.slug } : {}),
                        os: image.os,
                        ...(image.desktop ? {} : { desktop: false }),
                        size: `${image.vcpu} vCPU, ${Math.round((Number(image.memory_mb) || 0) / 1024)} GB memory, ${image.disk_gb} GB disk`,
                        ...(image.location?.name ? { where: image.location.name } : {}),
                        price: `${euros(image.hourly_price)}/h`,
                        ...(image.allowed === false ? { allowed: 'not yet at this account\'s level' } : {}),
                        ...(image.in_stock === false ? { inStock: false } : {}),
                    })),
                };
            } catch (error) {
                return { error: explain(error) };
            }
        },

        async start({ sandbox, os, image, name, secrets: wanted = [], idleMinutes } = {}) {
            const refused = refusal();
            if (refused) return { error: refused };
            const yard = api();
            let current = null;
            try {
                let given = {};
                if (sandbox) {
                    if (wanted.length) {
                        return { error: 'A sandbox is given its secrets when it is created, and cannot be given more later. Start a new one with them.' };
                    }
                    current = await yard.get(String(sandbox));
                    const kept = state.target();
                    if (kept?.uuid === current.uuid) given = kept.secrets || {};
                    if (current.status === 'stopped') current = await yard.start(current.uuid);
                } else {
                    const offer = await yard.images();
                    const picked = pickImage(offer, { os, image });
                    if (picked.error) return picked;
                    const env = {};
                    for (const secretName of [...new Set(wanted.map(String))]) {
                        const reference = `{{secret:${secretName}}}`;
                        const value = state.resolveSecrets(reference);
                        if (!value || value === reference) {
                            return { error: `There is no secret "${secretName}" in the keychain. list_secrets shows the names there.` };
                        }
                        given[secretName] = envNameFor(secretName);
                        env[given[secretName]] = value;
                    }
                    const idle = clamp(idleMinutes ?? settings().spaceyardIdle, 5, 43200, IDLE_DEFAULT);
                    const destroy = Number.isFinite(Number(settings().spaceyardDestroy)) ? Number(settings().spaceyardDestroy) : DESTROY_DEFAULT;
                    current = await yard.create({
                        image_id: picked.image.id,
                        name: String(name || `Acestes: ${state.title() || 'a conversation'}`).slice(0, 60),
                        auto_stop_minutes: Math.round(idle),
                        auto_destroy_minutes: destroy,
                        ...(Object.keys(env).length ? { env } : {}),
                    });
                }
                const running = await waitRunning(yard, current, { resume: Boolean(sandbox), stopped });
                if (running.error) return running;
                if (running.desktop === false) {
                    return {
                        error: `${describeTarget(targetOf(running))} has no desktop, so the computer tools cannot use it. `
                            + 'sandbox_command runs commands on it.',
                        sandbox: summary(running),
                    };
                }
                return await point(running, given);
            } catch (error) {
                const made = current?.uuid ? ` Sandbox ${current.uuid} was made and may still be billed: stop_sandbox with destroy removes it.` : '';
                return { error: `${explain(error, current?.uuid ? targetOf(current) : null)}${sandbox ? '' : made}` };
            }
        },

        async stop({ sandbox, destroy = false } = {}) {
            const refused = refusal();
            if (refused) return { error: refused };
            const current = state.target();
            const uuid = String(sandbox || current?.uuid || '');
            if (!uuid) return { error: 'Which sandbox? This conversation is not using one; list_sandboxes shows them.' };
            try {
                const done = destroy ? await api().destroy(uuid) : await api().stop(uuid);
                const was = current?.uuid === uuid;
                if (was) {
                    state.setTarget(null);
                    forgetSandbox(state.id);
                }
                if (destroy || done?.status === 'deleting') sizes.delete(uuid);
                const which = describeTarget(was ? current : targetOf({ ...done, uuid }));
                return {
                    [destroy || done?.status === 'deleting' ? 'destroyed' : 'stopped']: which,
                    status: done?.status,
                    ...(!destroy && done?.status !== 'deleting'
                        ? { note: `Its disk is kept, at ${euros(done?.stopped_hourly_price)}/h. start_sandbox with sandbox "${uuid}" brings it back as it was.` }
                        : {}),
                    ...(was ? { computer: `The computer tools act on ${local()} again.` } : {}),
                };
            } catch (error) {
                return { error: explain(error, current?.uuid === uuid ? current : null) };
            }
        },

        async command({ command, sandbox } = {}) {
            const refused = refusal();
            if (refused) return { error: refused };
            const current = state.target();
            const uuid = String(sandbox || current?.uuid || '');
            if (!uuid) return { error: 'No sandbox to run it on: start_sandbox starts one, or name one from list_sandboxes.' };
            try {
                const ran = await api().exec(uuid, String(command || ''));
                // A secret the sandbox was given is one of its variables, and
                // a command can print it: masked here, as in the transcript.
                const clean = text => state.scrub(String(text ?? ''));
                return {
                    ...(ran?.finished === false
                        ? {
                            stillRunning: 'It went on past 60 seconds and is still running in the sandbox. For a long job, start it '
                                + 'in the background with its output in a file (nohup ... > /tmp/job.log 2>&1 &) and read the file after.',
                        }
                        : { exitCode: ran?.exit_code }),
                    ...(ran?.stdout ? { stdout: clean(ran.stdout) } : {}),
                    ...(ran?.stderr ? { stderr: clean(ran.stderr) } : {}),
                    ...(ran?.truncated ? { truncated: 'The output was cut at 64 KB.' } : {}),
                    ...(Number.isFinite(Number(ran?.seconds)) ? { seconds: Number(ran.seconds) } : {}),
                };
            } catch (error) {
                return { error: explain(error, current?.uuid === uuid ? current : null) };
            }
        },

        async use({ target: wanted } = {}) {
            const choice = String(wanted || '').trim();
            if (!choice || ['this', 'local', 'here', 'this computer'].includes(choice.toLowerCase())) {
                const previous = state.target();
                state.setTarget(null);
                forgetSandbox(state.id);
                return {
                    computer: `The computer tools act on ${local()}.`,
                    ...(previous ? {
                        note: `${describeTarget(previous)} keeps running, and is billed, until it stops by itself after a while `
                            + 'without use; stop_sandbox stops it now.',
                    } : {}),
                };
            }
            const refused = refusal();
            if (refused) return { error: refused };
            try {
                const found = await api().get(choice);
                if (found.desktop === false) {
                    return { error: `${describeTarget(targetOf(found))} has no desktop, so computer use does not work on it. sandbox_command still runs commands there.` };
                }
                if (found.status !== 'running') {
                    return { error: `It is ${found.status}. start_sandbox with sandbox "${found.uuid}" starts it and points the computer tools at it.` };
                }
                const kept = state.target();
                return await point(found, kept?.uuid === found.uuid ? kept.secrets || {} : {});
            } catch (error) {
                return { error: explain(error) };
            }
        },
    };
}

/**
 * The Settings page's check of a key: whether Spaceyard takes it, and what
 * it offers. For the main process, with the key read from the keychain.
 */
async function check(key) {
    if (!key) return { ok: false, error: 'No key yet.' };
    try {
        const offer = await client(key).images();
        const desktops = (offer?.data || []).filter(image => image.desktop);
        return {
            ok: true,
            images: desktops.length,
            startable: desktops.filter(image => image.allowed !== false && image.in_stock !== false).length,
            running: offer?.limits ? { used: offer.limits.used, max: offer.limits.max } : null,
            systems: [...new Set(desktops.map(image => image.os))],
        };
    } catch (error) {
        return { ok: false, error: explain(error) };
    }
}

module.exports = {
    KEY_NAME,
    IDLE_DEFAULT,
    DESTROY_DEFAULT,
    configure,
    client,
    computerFor,
    managerFor,
    check,
    readTarget,
    describeTarget,
    envNameFor,
    halt,
    resume,
    release,
    forget,
    SpaceyardError,
    _test: {
        normaliseNodes,
        pickImage,
        reset: () => {
            reads.clear();
            frames.clear();
            looks.clear();
            halted.clear();
            pressed.clear();
            sizes.clear();
            queues.clear();
            timing = TIMING;
        },
    },
};

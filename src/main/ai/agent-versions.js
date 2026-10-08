const spawn = require('cross-spawn');

/**
 * Whether each agent's CLI on this machine is the newest one out.
 *
 * Asked from the settings page, never on its own: the answer means starting
 * every installed runtime once with `--version` and one request per agent to
 * the registry it is published to, which is fine behind a button and not
 * something to do every time a page opens.
 *
 * This only reads. Updating is the runtime's own business (most of them update
 * themselves, and an editor updates its bundled copy), so the page is handed
 * the command that does it and runs nothing.
 *
 * Where the newest version is read from, per agent:
 *   npm      the registry's `latest` tag for the package the CLI ships in
 *   pypi     the package's current release on PyPI
 *   command  the CLI's own check, where it has one that installs nothing
 *   none     nowhere public: the installed version is reported on its own
 */
const SOURCES = {
    'claude-code': { registry: 'npm', package: '@anthropic-ai/claude-code', update: 'claude update' },
    codex: { registry: 'npm', package: '@openai/codex', update: 'npm install -g @openai/codex@latest' },
    cursor: { registry: 'none', update: 'cursor-agent update' },
    antigravity: { registry: 'none', update: '' },
    muse: { registry: 'none', update: '' },
    opencode: { registry: 'npm', package: 'opencode-ai', update: 'opencode upgrade' },
    grok: { registry: 'command', args: ['update', '--check', '--json'], update: 'grok update' },
    kimi: { registry: 'npm', package: '@moonshot-ai/kimi-code', update: 'npm install -g @moonshot-ai/kimi-code@latest' },
    qwen: { registry: 'npm', package: '@qwen-code/qwen-code', update: 'npm install -g @qwen-code/qwen-code@latest' },
    vibe: { registry: 'pypi', package: 'mistral-vibe', update: 'uv tool upgrade mistral-vibe' },
    pi: { registry: 'npm', package: '@earendil-works/pi-coding-agent', update: 'npm install -g @earendil-works/pi-coding-agent@latest' },
};

/** How long one `--version` or one registry request may take. */
const TIMEOUT = 15000;

/** A CLI inside an editor's extensions folder, which the editor keeps updated. */
const EDITOR_COPY = /[\\/]\.(?:vscode|vscode-insiders|cursor|windsurf)[\\/]extensions[\\/]/i;

/** The first dotted version in some text, `2.1.287` out of `2.1.287 (Claude Code)`. */
function parseVersion(text) {
    const found = /(\d+\.\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(String(text || ''));
    if (!found) return '';
    return found[2] ? `${found[1]}-${found[2]}` : found[1];
}

/**
 * Segment by segment, so 2.1.293 sorts above 2.1.99. A pre-release sorts below
 * the release it leads up to, the way semver has it, so an alpha installed
 * ahead of the stable channel never reads as needing an update to the stable.
 */
function compareVersions(left, right) {
    const [leftCore, leftPre = ''] = String(left).split('-');
    const [rightCore, rightPre = ''] = String(right).split('-');
    const a = leftCore.split('.').map(Number);
    const b = rightCore.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const difference = (a[i] || 0) - (b[i] || 0);
        if (difference) return difference;
    }
    if (leftPre === rightPre) return 0;
    if (!leftPre) return 1;
    if (!rightPre) return -1;
    return leftPre < rightPre ? -1 : 1;
}

/** Run a command and hand back what it printed, or '' if it failed to. */
function runCommand({ command, args = [] }, { timeout = TIMEOUT } = {}) {
    return new Promise((resolve) => {
        let output = '';
        let child;
        try {
            child = spawn(command, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                // Asked for its version, not to update: a runtime that checks
                // for one on start is told not to, where it reads these.
                env: { ...process.env, NO_UPDATE_NOTIFIER: '1', DISABLE_AUTOUPDATER: '1' },
            });
        } catch {
            resolve('');
            return;
        }
        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* already gone */ }
            resolve(output);
        }, timeout);
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => { output += chunk; });
        // Some CLIs print their version on stderr.
        child.stderr?.on('data', (chunk) => { output += chunk; });
        child.on('error', () => { clearTimeout(timer); resolve(''); });
        child.on('close', () => { clearTimeout(timer); resolve(output); });
    });
}

async function fetchJson(url, { timeout = TIMEOUT } = {}) {
    const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.json();
}

/** The newest published version for one agent, or '' when there is none to read. */
async function latestVersion(source, { fetchJson: getJson = fetchJson, run = runCommand, launch } = {}) {
    if (source.registry === 'npm') {
        const body = await getJson(`https://registry.npmjs.org/${source.package}/latest`);
        return parseVersion(body?.version);
    }
    if (source.registry === 'pypi') {
        const body = await getJson(`https://pypi.org/pypi/${encodeURIComponent(source.package)}/json`);
        return parseVersion(body?.info?.version);
    }
    if (source.registry === 'command' && launch) {
        const text = await run({ command: launch.command, args: [...(launch.prefix || []), ...source.args] });
        try {
            const line = text.split(/\r?\n/).find(entry => entry.trim().startsWith('{'));
            return parseVersion(JSON.parse(line)?.latestVersion);
        } catch {
            return '';
        }
    }
    return '';
}

/**
 * The checker, with how it finds each CLI handed in. `locate(provider)`
 * answers null when the agent is not installed, or `{ command, prefix }`: the
 * executable, and any arguments that come before the CLI's own, which is how
 * Cursor's node launcher starts it. It may also carry `version`, already read
 * off disk, and `managedBy: 'app'` for a copy a desktop app keeps updated.
 */
function createVersionChecker({ locate, run = runCommand, fetchJson: getJson = fetchJson } = {}) {
    async function checkOne(provider) {
        const source = SOURCES[provider];
        if (!source) return { provider, status: 'unsupported' };

        let launch = null;
        try { launch = locate(provider); } catch { launch = null; }
        if (!launch?.command) return { provider, status: 'missing', update: source.update };

        const [installed, latest] = await Promise.all([
            // Read off disk where the locator could (a desktop app's own
            // package), and asked of the CLI otherwise. Never run when the
            // locator answered for it, even with nothing: `--version` on a
            // desktop app's executable would open the app.
            'version' in launch
                ? Promise.resolve(parseVersion(launch.version))
                : run({ command: launch.command, args: [...(launch.prefix || []), '--version'] })
                    .then(parseVersion)
                    .catch(() => ''),
            latestVersion(source, { fetchJson: getJson, run, launch })
                .catch(() => null),
        ]);

        // A copy an editor extension carries is updated by the editor, and one
        // inside a desktop app by that app. The CLI's own update command would
        // install a second copy beside either rather than touch the one in use.
        const managedBy = launch.managedBy || (EDITOR_COPY.test(launch.command) ? 'editor' : '');
        const result = {
            provider,
            path: launch.command,
            installed,
            latest: latest || '',
            update: managedBy ? '' : source.update,
            managedBy,
        };
        if (latest === null) return { ...result, status: 'error' };
        if (!installed || !latest) return { ...result, status: 'unknown' };
        return { ...result, status: compareVersions(latest, installed) > 0 ? 'available' : 'current' };
    }

    /** Every named agent at once, each answered fresh. */
    function check(providers = []) {
        const wanted = [...new Set((providers || []).filter(name => typeof name === 'string'))];
        return Promise.all(wanted.map(checkOne));
    }

    return { check, checkOne };
}

module.exports = {
    SOURCES,
    parseVersion,
    compareVersions,
    latestVersion,
    createVersionChecker,
};

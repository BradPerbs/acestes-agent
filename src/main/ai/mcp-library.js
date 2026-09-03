/**
 * The MCP server library: servers worth having, ready to switch on.
 *
 * Two shelves. The first is curated here: the reference servers and the
 * vendor ones people actually reach for, each written as a template with
 * the fields it needs (a folder, a token, a URL) so switching one on is
 * filling in two boxes rather than reading a README. The second is the
 * official registry at registry.modelcontextprotocol.io, searched live and
 * read into the same template shape, so a server this file has never heard
 * of is one search away.
 *
 * A template becomes a server record (the shape agents.js keeps) through
 * `instantiate`, which puts the values into the arguments, the environment
 * and the headers where the template says they go. Nothing here runs
 * anything; a template is a description, and the record it makes is what
 * the runtime launches.
 *
 * Package names and commands were checked against the projects' own pages
 * on 3 September 2026. Servers that need an OAuth flow in a browser are left
 * out: the app has no way to complete one for a headless runtime.
 */

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const REGISTRY_TIMEOUT = 15000;

/**
 * A field a template asks for: `{ key, label, help, kind, required, secret,
 * placeholder, default }`. `kind` says where the value goes:
 *   env      an environment variable named `key`
 *   arg      a `{{key}}` placeholder in the arguments
 *   header   an HTTP header named `key` (http transport)
 *   url      a `{{key}}` placeholder in the URL
 */
const CURATED = [
    {
        id: 'filesystem',
        name: 'Filesystem',
        category: 'files',
        description: 'Read, write, search and move files under the folders you name. The reference server.',
        homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '{{root}}'],
        fields: [
            { key: 'root', label: 'Folder', kind: 'arg', required: true, placeholder: 'C:\\projects\\site', help: 'The server sees this folder and nothing above it.' },
        ],
    },
    {
        id: 'git',
        name: 'Git',
        category: 'code',
        description: 'Status, log, diff, commit and branch operations on one repository. Needs uv (Python).',
        homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-git', '--repository', '{{repo}}'],
        fields: [
            { key: 'repo', label: 'Repository', kind: 'arg', required: true, placeholder: 'C:\\projects\\site' },
        ],
    },
    {
        id: 'github',
        name: 'GitHub',
        category: 'code',
        description: 'Repositories, issues, pull requests, code search and workflows, on GitHub\'s hosted server.',
        homepage: 'https://github.com/github/github-mcp-server',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        fields: [
            { key: 'Authorization', label: 'Personal access token', kind: 'header', required: true, secret: true, placeholder: 'github_pat_…', prefix: 'Bearer ', help: 'A fine-grained token with the repository scopes you want the agent to have.' },
        ],
    },
    {
        id: 'github-local',
        name: 'GitHub (local, Docker)',
        category: 'code',
        description: 'The same GitHub server run locally in Docker, for a token that must not leave this machine.',
        homepage: 'https://github.com/github/github-mcp-server',
        transport: 'stdio',
        command: 'docker',
        args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'],
        fields: [
            { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'Personal access token', kind: 'env', required: true, secret: true, placeholder: 'github_pat_…' },
        ],
    },
    {
        id: 'fetch',
        name: 'Fetch',
        category: 'web',
        description: 'Fetch a web page and hand it back as Markdown. The reference server.',
        homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-fetch'],
        fields: [],
    },
    {
        id: 'brave-search',
        name: 'Brave Search',
        category: 'web',
        description: 'Web, news, image and local search through the Brave Search API. Needs a key from brave.com/search/api.',
        homepage: 'https://github.com/brave/brave-search-mcp-server',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
        fields: [
            { key: 'BRAVE_API_KEY', label: 'API key', kind: 'env', required: true, secret: true, placeholder: 'BSA…' },
        ],
    },
    {
        id: 'playwright',
        name: 'Playwright',
        category: 'web',
        description: 'Drive a real browser: open pages, click, type, fill forms, read the page, take screenshots. The window is visible, so you can step in for a captcha or a code.',
        homepage: 'https://github.com/microsoft/playwright-mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '{{headless}}'],
        fields: [
            { key: 'headless', label: 'Hide the browser window', kind: 'flag', flag: '--headless', required: false, placeholder: 'no', help: 'Leave empty, or say no, to watch it work. Say yes for an unattended run.' },
        ],
    },
    {
        id: 'context7',
        name: 'Context7',
        category: 'code',
        description: 'Current documentation and code examples for any library, so the agent stops guessing at APIs.',
        homepage: 'https://github.com/upstash/context7',
        transport: 'http',
        url: 'https://mcp.context7.com/mcp',
        fields: [
            { key: 'Authorization', label: 'API key (optional)', kind: 'header', required: false, secret: true, placeholder: 'ctx7sk-…', prefix: 'Bearer ', help: 'Without one the free rate limit applies.' },
        ],
    },
    {
        id: 'memory',
        name: 'Memory (knowledge graph)',
        category: 'agent',
        description: 'A persistent knowledge graph the agent can write entities and relations into. The reference server.',
        homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        fields: [
            { key: 'MEMORY_FILE_PATH', label: 'Graph file (optional)', kind: 'env', required: false, placeholder: 'C:\\Users\\me\\agent-graph.json' },
        ],
    },
    {
        id: 'sequential-thinking',
        name: 'Sequential Thinking',
        category: 'agent',
        description: 'A scratchpad for step-by-step reasoning on hard problems. The reference server.',
        homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequentialthinking'],
        fields: [],
    },
    {
        id: 'time',
        name: 'Time',
        category: 'agent',
        description: 'The current time and timezone conversion. The reference server.',
        homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-time'],
        fields: [],
    },
    {
        id: 'postgres',
        name: 'PostgreSQL (read-only)',
        category: 'data',
        description: 'Inspect schemas and run read-only queries against one database. The archived reference server, still published.',
        homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres', '{{dsn}}'],
        fields: [
            { key: 'dsn', label: 'Connection string', kind: 'arg', required: true, secret: true, placeholder: 'postgresql://user:pass@host:5432/db' },
        ],
    },
    {
        id: 'sqlite',
        name: 'SQLite',
        category: 'data',
        description: 'Query and change one SQLite file. Needs uv (Python).',
        homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/sqlite',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-sqlite', '--db-path', '{{db}}'],
        fields: [
            { key: 'db', label: 'Database file', kind: 'arg', required: true, placeholder: 'C:\\data\\app.db' },
        ],
    },
    {
        id: 'kubernetes',
        name: 'Kubernetes',
        category: 'ops',
        description: 'Pods, deployments, services, logs and events through your kubeconfig.',
        homepage: 'https://github.com/Flux159/mcp-server-kubernetes',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-server-kubernetes'],
        fields: [
            { key: 'KUBECONFIG', label: 'Kubeconfig (optional)', kind: 'env', required: false, placeholder: 'C:\\Users\\me\\.kube\\config' },
        ],
    },
    {
        id: 'grafana',
        name: 'Grafana',
        category: 'ops',
        description: 'Dashboards, datasources, Prometheus and Loki queries, alerts and incidents, in Docker.',
        homepage: 'https://github.com/grafana/mcp-grafana',
        transport: 'stdio',
        command: 'docker',
        args: ['run', '-i', '--rm', '-e', 'GRAFANA_URL', '-e', 'GRAFANA_API_KEY', 'mcp/grafana', '-t', 'stdio'],
        fields: [
            { key: 'GRAFANA_URL', label: 'Grafana URL', kind: 'env', required: true, placeholder: 'https://grafana.example.com' },
            { key: 'GRAFANA_API_KEY', label: 'Service account token', kind: 'env', required: true, secret: true, placeholder: 'glsa_…' },
        ],
    },
    {
        id: 'slack',
        name: 'Slack',
        category: 'chat',
        description: 'Read channels and post messages with a bot token. The archived reference server, still published.',
        homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-slack'],
        fields: [
            { key: 'SLACK_BOT_TOKEN', label: 'Bot token', kind: 'env', required: true, secret: true, placeholder: 'xoxb-…' },
            { key: 'SLACK_TEAM_ID', label: 'Team id', kind: 'env', required: true, placeholder: 'T0…' },
        ],
    },
    {
        id: 'custom-http',
        name: 'Any remote server',
        category: 'other',
        description: 'A server reached over HTTP at a URL you have, with a bearer token if it wants one.',
        homepage: '',
        transport: 'http',
        url: '{{url}}',
        fields: [
            { key: 'url', label: 'URL', kind: 'url', required: true, placeholder: 'https://mcp.example.com/mcp' },
            { key: 'Authorization', label: 'Bearer token (optional)', kind: 'header', required: false, secret: true, prefix: 'Bearer ' },
        ],
    },
];

const CATEGORIES = ['files', 'code', 'web', 'data', 'ops', 'chat', 'agent', 'other'];

const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);

/* ------------------------------------------------------------------ *
 * Templates to records
 * ------------------------------------------------------------------ */

/** Everything a page or the agent needs to draw a template; no values in it. */
function publicTemplate(template) {
    return {
        id: template.id,
        name: template.name,
        category: template.category,
        description: template.description,
        homepage: template.homepage || '',
        transport: template.transport,
        command: template.command || '',
        args: template.args || [],
        url: template.url || '',
        source: template.source || 'curated',
        fields: (template.fields || []).map(field => ({
            key: field.key,
            label: field.label,
            help: field.help || '',
            kind: field.kind,
            required: Boolean(field.required),
            secret: Boolean(field.secret),
            placeholder: field.placeholder || '',
            default: field.default || '',
        })),
    };
}

function list({ query = '', category = '' } = {}) {
    const needle = clean(query).toLowerCase();
    return CURATED
        .filter(template => !category || template.category === category)
        .filter(template => !needle || [template.name, template.description, template.id, template.category]
            .join(' ').toLowerCase().includes(needle))
        .map(publicTemplate);
}

function get(id) {
    const found = CURATED.find(template => template.id === id);
    return found ? publicTemplate(found) : null;
}

/**
 * Fill a template in. `values` is keyed by field key. Answers the server
 * record the registry keeps, or `{ error }` naming the first missing field.
 */
/** Whether a value a person or an agent typed for a switch means on. */
const isYes = (value) => /^(y|yes|true|on|1)$/i.test(String(value || '').trim());

function instantiate(template, values = {}, { name = '' } = {}) {
    if (!template) return { error: 'No such template.' };
    const given = values && typeof values === 'object' ? values : {};
    const fill = (text) => String(text).replace(/\{\{(\w+)\}\}/g, (match, key) => {
        const field = (template.fields || []).find(entry => entry.key === key);
        const value = clean(given[key] ?? field?.default ?? '', 2000);
        // A flag is a yes or a no, however it was said: "false" is not an
        // argument to hand a server, it is the flag left out.
        if (field?.kind === 'flag') return isYes(value) || value === field.flag ? field.flag : '';
        return value;
    });

    for (const field of template.fields || []) {
        const value = clean(given[field.key] ?? field.default ?? '', 2000);
        if (field.required && !value) return { error: `${field.label || field.key} is needed.` };
    }

    const env = {};
    const headers = {};
    for (const field of template.fields || []) {
        const value = clean(given[field.key] ?? field.default ?? '', 2000);
        if (!value) continue;
        if (field.kind === 'env') env[field.key] = value;
        if (field.kind === 'header') headers[field.key] = `${field.prefix || ''}${value}`;
    }

    const record = {
        name: clean(name, 60) || template.name,
        transport: template.transport,
        template: template.id,
    };
    if (template.transport === 'http') {
        record.url = fill(template.url || '');
        record.headers = headers;
        if (!/^https?:\/\//i.test(record.url)) return { error: 'The URL has to start with http:// or https://.' };
    } else {
        record.command = template.command;
        // An argument that is only an unfilled optional placeholder is dropped
        // rather than sent as an empty string the server would trip on.
        record.args = (template.args || []).map(fill).filter(arg => arg !== '');
        record.env = env;
    }
    return { server: record };
}

/* ------------------------------------------------------------------ *
 * The official registry
 * ------------------------------------------------------------------ */

const RUNTIME_COMMANDS = { npx: 'npx', uvx: 'uvx', docker: 'docker', dnx: 'dnx' };

/** An argument entry of the registry, as the string(s) it becomes. */
function registryArguments(entries, fields, scope) {
    const out = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || typeof entry !== 'object') continue;
        const key = clean(entry.name || entry.valueHint || `${scope}${out.length}`, 60).replace(/[^\w.-]/g, '_');
        const templated = typeof entry.value === 'string' && /\{[\w-]+\}/.test(entry.value);
        if (entry.type === 'named' && entry.name) out.push(String(entry.name));
        if (typeof entry.value === 'string' && !templated && entry.value) {
            out.push(entry.value);
            continue;
        }
        // A value the user has to give: becomes a field and a placeholder.
        fields.push({
            key,
            label: clean(entry.description || entry.valueHint || key, 120),
            kind: 'arg',
            required: entry.isRequired !== false,
            secret: Boolean(entry.isSecret),
            placeholder: clean(entry.valueHint || entry.default || '', 120),
            default: clean(entry.default || '', 500),
        });
        out.push(`{{${key}}}`);
    }
    return out;
}

/** One registry entry as a template, or null when it cannot be run here. */
function fromRegistry(entry) {
    const server = entry?.server || entry;
    if (!server?.name) return null;
    const meta = entry?._meta?.['io.modelcontextprotocol.registry/official'] || {};
    if (meta.status && meta.status !== 'active') return null;
    const base = {
        id: `registry:${server.name}`,
        name: server.title || server.name.split('/').pop(),
        category: 'other',
        description: clean(server.description, 400),
        homepage: server.repository?.url || server.websiteUrl || '',
        source: 'registry',
        registryName: server.name,
        version: server.version || '',
    };

    const remote = (server.remotes || []).find(item => /http/i.test(item?.type || '') && item?.url);
    if (remote) {
        const fields = [];
        for (const header of Array.isArray(remote.headers) ? remote.headers : []) {
            if (!header?.name) continue;
            const value = String(header.value || '');
            const templated = /\{[\w-]+\}/.test(value);
            if (!templated && value) {
                fields.push({ key: header.name, label: header.name, kind: 'header', required: false, secret: Boolean(header.isSecret), default: value });
                continue;
            }
            // "Bearer {token}" keeps its prefix and asks for the rest.
            const prefix = value.replace(/\{[\w-]+\}.*$/, '');
            fields.push({
                key: header.name,
                label: clean(header.description || header.name, 120),
                kind: 'header',
                required: header.isRequired !== false,
                secret: header.isSecret !== false,
                prefix,
            });
        }
        return { ...base, transport: 'http', url: remote.url, fields };
    }

    const pkg = (server.packages || []).find(item => item?.identifier && RUNTIME_COMMANDS[item.runtimeHint || 'npx']);
    if (!pkg) return null;
    const fields = [];
    const runtime = pkg.runtimeHint || (pkg.registryType === 'pypi' ? 'uvx' : pkg.registryType === 'oci' ? 'docker' : 'npx');
    const command = RUNTIME_COMMANDS[runtime];
    if (!command) return null;
    const args = [];
    if (runtime === 'npx') args.push('-y');
    if (runtime === 'docker') args.push('run', '-i', '--rm');
    args.push(...registryArguments(pkg.runtimeArguments, fields, 'runtime'));
    if (runtime === 'docker') {
        for (const variable of Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : []) {
            if (variable?.name) args.push('-e', variable.name);
        }
    }
    args.push(pkg.identifier + (pkg.version && runtime === 'npx' ? `@${pkg.version}` : ''));
    args.push(...registryArguments(pkg.packageArguments, fields, 'package'));
    for (const variable of Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : []) {
        if (!variable?.name) continue;
        fields.push({
            key: variable.name,
            label: clean(variable.description || variable.name, 120),
            kind: 'env',
            required: variable.isRequired !== false,
            secret: Boolean(variable.isSecret),
            default: clean(variable.default || '', 500),
        });
    }
    return { ...base, transport: 'stdio', command, args, fields };
}

/** Search the official registry. Answers templates; failures are said, not thrown. */
async function search(query, { limit = 20 } = {}) {
    const needle = clean(query, 120);
    if (!needle) return { templates: [], error: '' };
    const url = `${REGISTRY}?search=${encodeURIComponent(needle)}&limit=${Math.max(1, Math.min(Number(limit) || 20, 50))}&version=latest`;
    let payload;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT), headers: { Accept: 'application/json' } });
        if (!response.ok) return { templates: [], error: `The registry answered ${response.status}.` };
        payload = await response.json();
    } catch (error) {
        return { templates: [], error: `The registry could not be reached: ${error.message}` };
    }
    const templates = (Array.isArray(payload?.servers) ? payload.servers : [])
        .map(fromRegistry)
        .filter(Boolean)
        .map(publicTemplate);
    return { templates, error: '', total: payload?.metadata?.count ?? templates.length };
}

/** A template by id, from either shelf; registry ids carry their own data. */
async function resolve(id, fallback = null) {
    const curated = CURATED.find(template => template.id === id);
    if (curated) return curated;
    if (fallback && fallback.id === id) return fallback;
    if (String(id).startsWith('registry:')) {
        const found = await search(String(id).slice('registry:'.length), { limit: 10 });
        const exact = found.templates.find(template => template.id === id);
        if (exact) return exact;
    }
    return null;
}

module.exports = { list, get, search, resolve, instantiate, fromRegistry, publicTemplate, CATEGORIES, CURATED };

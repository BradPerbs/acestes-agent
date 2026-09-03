import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Delete02Icon, Edit02Icon, LibraryIcon, PlugSocketIcon, PlusSignIcon, RefreshIcon } from 'hugeicons-react';
import Dialog from './ui/Dialog';
import McpLibrary from './McpLibrary';
import Button from './ui/Button';
import ConfirmDialog from './ui/ConfirmDialog';
import EmptyFrame from './ui/EmptyFrame';
import Field, { FIELD_CLASS, MONO_FIELD_CLASS } from './ui/Field';
import SegmentedControl from './ui/SegmentedControl';
import { useT } from '../i18n';

/**
 * The MCP servers in an agent's inventory.
 *
 * Each is a command to spawn or a URL to reach, and its tools are handed to
 * the agent with the app's own when it answers. The list lives on the agent
 * record in the main process; this page edits it whole, since a server is
 * only ever a few lines and the registry validates every one on the way in.
 *
 * Next to each server is whether it answers. The main process shakes hands
 * with every server the page has not asked yet, and again on request, and
 * what came back is drawn here: the dot, the tool count, or the reason.
 */

const TRANSPORTS = ['stdio', 'http'];

/** `KEY=value` lines to an object, and back. */
const parseEnv = (text) => Object.fromEntries(
    String(text || '').split('\n')
        .map(line => line.trim())
        .filter(line => line && line.includes('='))
        .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1)]),
);
const formatEnv = (env) => Object.entries(env || {}).map(([key, value]) => `${key}=${value}`).join('\n');

function ServerDialog({ server, onClose, onSave }) {
    const t = useT();
    const [form, setForm] = useState(() => ({
        name: server?.name || '',
        transport: server?.transport || 'stdio',
        command: server?.command || '',
        args: (server?.args || []).join(' '),
        url: server?.url || '',
        env: formatEnv(server?.env),
        headers: formatEnv(server?.headers),
    }));
    const [saving, setSaving] = useState(false);

    const change = (field) => (event) => setForm(current => ({ ...current, [field]: event.target.value }));

    const valid = form.name.trim()
        && (form.transport === 'stdio' ? form.command.trim() : /^https?:\/\//i.test(form.url.trim()));

    const submit = async () => {
        if (!valid || saving) return;
        setSaving(true);
        try {
            await onSave({
                id: server?.id,
                name: form.name.trim(),
                transport: form.transport,
                command: form.command.trim(),
                args: form.args.split(/\s+/).map(entry => entry.trim()).filter(Boolean),
                url: form.url.trim(),
                env: parseEnv(form.env),
                headers: parseEnv(form.headers),
                template: server?.template || '',
            });
            onClose();
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            title={server ? t('mcp.editTitle') : t('mcp.newTitle')}
            onClose={onClose}
            width="32rem"
            footer={(
                <>
                    <Button onClick={onClose}>{t('common.cancel')}</Button>
                    <Button variant="primary" onClick={submit} disabled={!valid || saving}>
                        {t('common.save')}
                    </Button>
                </>
            )}
        >
            <form
                onSubmit={(event) => { event.preventDefault(); submit(); }}
                className="flex flex-col gap-4"
            >
                <Field label={t('mcp.name')}>
                    <input
                        autoFocus
                        type="text"
                        value={form.name}
                        maxLength={60}
                        onChange={change('name')}
                        className={FIELD_CLASS}
                        placeholder="filesystem"
                    />
                </Field>

                <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                        {t('mcp.transport')}
                    </span>
                    <SegmentedControl
                        ariaLabel={t('mcp.transport')}
                        value={form.transport}
                        onChange={(next) => setForm(current => ({ ...current, transport: next }))}
                        segments={TRANSPORTS.map(value => ({ value, label: t(`mcp.${value}`) }))}
                    />
                </div>

                {form.transport === 'stdio' ? (
                    <>
                        <Field label={t('mcp.command')}>
                            <input
                                type="text"
                                value={form.command}
                                onChange={change('command')}
                                className={`${FIELD_CLASS} font-mono`}
                                placeholder="npx"
                            />
                        </Field>
                        <Field label={t('mcp.args')} hint={t('mcp.argsHint')}>
                            <input
                                type="text"
                                value={form.args}
                                onChange={change('args')}
                                className={`${FIELD_CLASS} font-mono`}
                                placeholder="-y @modelcontextprotocol/server-filesystem /srv"
                            />
                        </Field>
                    </>
                ) : (
                    <>
                        <Field label={t('mcp.url')}>
                            <input
                                type="text"
                                value={form.url}
                                onChange={change('url')}
                                className={`${FIELD_CLASS} font-mono`}
                                placeholder="https://mcp.example.com/mcp"
                            />
                        </Field>
                        <Field label={t('mcp.headers')} hint={t('mcp.headersHint')}>
                            <textarea
                                value={form.headers}
                                onChange={change('headers')}
                                rows={2}
                                spellCheck={false}
                                className={`${MONO_FIELD_CLASS} resize-y`}
                                placeholder="Authorization=Bearer …"
                            />
                        </Field>
                    </>
                )}

                {form.transport === 'stdio' && (
                    <Field label={t('mcp.env')} hint={t('mcp.envHint')}>
                        <textarea
                            value={form.env}
                            onChange={change('env')}
                            rows={3}
                            spellCheck={false}
                            className={`${MONO_FIELD_CLASS} resize-y`}
                            placeholder="API_TOKEN=…"
                        />
                    </Field>
                )}
            </form>
        </Dialog>
    );
}

const ROW_ACTION = `w-8 h-8 rounded-lg flex items-center justify-center transition-colors
    text-gray-400 dark:text-neutral-500 disabled:opacity-40 disabled:cursor-default`;

/** The dot on the server's tile: grey until asked, pulsing while asked, then green or red. */
function dotClass(status) {
    if (!status) return 'bg-gray-300 dark:bg-neutral-600';
    if (status.checking) return 'bg-gray-300 dark:bg-neutral-600 animate-pulse';
    return status.ok ? 'bg-emerald-500' : 'bg-red-500';
}

/** The words for what the handshake said. */
function statusLabel(status, t) {
    if (!status) return t('mcp.status.unchecked');
    if (status.checking) return t('mcp.status.checking');
    if (!status.ok) return t('mcp.status.down');
    const count = status.tools?.length || 0;
    const ms = status.latencyMs ?? 0;
    if (count === 0) return t('mcp.status.noTools', { ms });
    if (count === 1) return t('mcp.status.okOne', { ms });
    return t('mcp.status.ok', { count, ms });
}

function statusClass(status) {
    if (!status || status.checking) return 'text-gray-400 dark:text-neutral-500';
    return status.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
}

function McpPanel({ agent, onSave, reachedForPage = 0 }) {
    const t = useT();
    const agentId = agent?.id || '';
    const servers = agent?.mcpServers || [];
    /** `{ server }` while editing, `{ server: null }` while adding. */
    const [editing, setEditing] = useState(null);
    const [confirming, setConfirming] = useState(null);
    const [library, setLibrary] = useState(false);
    // serverId -> what the last handshake said; `ready` once the main
    // process has been asked what it already knew, so the page does not
    // re-probe servers whose answer is a message away.
    const [statuses, setStatuses] = useState({});
    const [ready, setReady] = useState(false);

    useEffect(() => {
        if (!agentId) return undefined;
        let cancelled = false;
        setStatuses({});
        setReady(false);
        window.api.agents.serverStatuses(agentId).then((known) => {
            if (cancelled) return;
            setStatuses(known || {});
            setReady(true);
        }).catch(() => { if (!cancelled) setReady(true); });
        const off = window.api.agents.onServerStatus((event) => {
            if (!event || event.agentId !== agentId) return;
            setStatuses(current => ({ ...current, [event.serverId]: event.status }));
        });
        return () => { cancelled = true; off(); };
    }, [agentId]);

    // Servers nobody has asked yet are asked once they are on screen. The
    // key is the list of unasked ids, so a status arriving for one of them
    // does not start the others over.
    const unchecked = useMemo(
        () => servers.filter(server => !statuses[server.id]).map(server => server.id).join(','),
        [servers, statuses],
    );
    useEffect(() => {
        if (!agentId || !ready || !unchecked) return;
        for (const serverId of unchecked.split(',')) {
            window.api.agents.checkServer({ agentId, serverId }).catch(() => {});
        }
    }, [agentId, ready, unchecked]);

    const check = useCallback((serverId) => {
        window.api.agents.checkServer({ agentId, serverId }).catch(() => {});
    }, [agentId]);

    const checkAll = useCallback(() => {
        window.api.agents.checkServer({ agentId }).catch(() => {});
    }, [agentId]);

    const write = useCallback((next) => onSave?.(next), [onSave]);

    const handleSave = useCallback(async (record) => {
        const next = record.id
            ? servers.map(server => (server.id === record.id ? record : server))
            : [...servers, record];
        await write(next);
        // An edited server is a different server as far as the handshake
        // is concerned: drop what was known and it is asked again.
        if (record.id) {
            setStatuses(current => {
                const { [record.id]: gone, ...rest } = current;
                return rest;
            });
        }
    }, [servers, write]);

    const confirmDelete = useCallback((server) => {
        setConfirming({
            title: t('mcp.deleteTitle'),
            message: t('mcp.deleteMessage', { name: server.name }),
            confirmLabel: t('common.delete'),
            onConfirm: async () => {
                setConfirming(null);
                await write(servers.filter(entry => entry.id !== server.id));
            },
        });
    }, [servers, write, t]);

    const anyChecking = servers.some(server => statuses[server.id]?.checking);

    return (
        <div className="flex flex-col gap-4 h-full min-h-0" id="mcp-panel">
            <div className="flex flex-wrap items-center gap-2 shrink-0">
                <p className="flex-1 min-w-[200px] text-[13px] text-gray-500 dark:text-gray-400">
                    {t('mcp.note')}
                </p>
                {servers.length > 0 && (
                    <Button
                        variant="secondary"
                        icon={<RefreshIcon size={16} strokeWidth={2} className={anyChecking ? 'animate-spin' : ''} />}
                        onClick={checkAll}
                        disabled={anyChecking}
                    >
                        {t('mcp.checkAll')}
                    </Button>
                )}
                <Button
                    variant="secondary"
                    icon={<PlusSignIcon size={16} strokeWidth={2.5} />}
                    onClick={() => setEditing({ server: null })}
                >
                    {t('mcp.new')}
                </Button>
                <Button
                    variant="primary"
                    icon={<LibraryIcon size={16} strokeWidth={2} />}
                    onClick={() => setLibrary(true)}
                >
                    {t('mcp.library.open')}
                </Button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 pb-1">
                {servers.length === 0 ? (
                    <EmptyFrame
                        icon={<PlugSocketIcon size={28} strokeWidth={1.5} />}
                        title={t('mcp.empty')}
                        note={t('mcp.emptyNote')}
                    >
                        <Button size="sm" variant="secondary" onClick={() => setLibrary(true)}>{t('mcp.library.open')}</Button>
                    </EmptyFrame>
                ) : (
                    <div className="flex flex-col gap-2">
                        {servers.map(server => {
                            const status = statuses[server.id];
                            return (
                                <div
                                    key={server.id}
                                    className="group/row flex items-center gap-3 px-4 py-3 rounded-xl
                                        bg-white dark:bg-neutral-800/50 border border-gray-200 dark:border-neutral-800"
                                >
                                    <span className="relative shrink-0">
                                        <PlugSocketIcon size={18} strokeWidth={1.5} className="text-gray-400 dark:text-neutral-500" />
                                        <span
                                            aria-hidden="true"
                                            className={`absolute -right-1 -bottom-1 w-2.5 h-2.5 rounded-full ring-2
                                                ring-white dark:ring-neutral-900 ${dotClass(status)}`}
                                        />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                                                {server.name}
                                            </span>
                                            <span className="shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider
                                                bg-gray-100 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400">
                                                {t(`mcp.${server.transport}`)}
                                            </span>
                                        </div>
                                        <div className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate">
                                            {server.transport === 'http'
                                                ? server.url
                                                : [server.command, ...(server.args || [])].join(' ')}
                                        </div>
                                        {status && !status.checking && !status.ok && status.error && (
                                            <div className="mt-0.5 text-[11px] text-red-600 dark:text-red-400 truncate" title={status.error}>
                                                {status.error}
                                            </div>
                                        )}
                                    </div>
                                    <span
                                        className={`shrink-0 text-[11px] font-medium tabular-nums ${statusClass(status)}`}
                                        title={status?.ok ? [status.name, status.version].filter(Boolean).join(' ') : undefined}
                                    >
                                        {statusLabel(status, t)}
                                    </span>
                                    <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity">
                                        <button
                                            type="button"
                                            aria-label={t('mcp.check')}
                                            title={t('mcp.check')}
                                            disabled={Boolean(status?.checking)}
                                            onClick={() => check(server.id)}
                                            className={`${ROW_ACTION} hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-surface-control dark:hover:text-white`}
                                        >
                                            <RefreshIcon size={15} strokeWidth={1.5} className={status?.checking ? 'animate-spin' : ''} />
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={t('common.edit')}
                                            onClick={() => setEditing({ server })}
                                            className={`${ROW_ACTION} hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-surface-control dark:hover:text-white`}
                                        >
                                            <Edit02Icon size={15} strokeWidth={1.5} />
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={t('common.deleteNamed', { name: server.name })}
                                            onClick={() => confirmDelete(server)}
                                            className={`${ROW_ACTION} hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400`}
                                        >
                                            <Delete02Icon size={15} strokeWidth={1.5} />
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {editing && (
                <ServerDialog
                    server={editing.server}
                    onClose={() => setEditing(null)}
                    onSave={handleSave}
                />
            )}

            {library && (
                <McpLibrary
                    servers={servers}
                    dismiss={reachedForPage}
                    onClose={() => setLibrary(false)}
                    onAdd={(record) => handleSave(record)}
                />
            )}

            {confirming && <ConfirmDialog {...confirming} onCancel={() => setConfirming(null)} />}
        </div>
    );
}

export default memo(McpPanel);

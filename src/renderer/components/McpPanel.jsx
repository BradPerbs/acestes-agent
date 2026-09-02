import { memo, useCallback, useState } from 'react';
import { Delete02Icon, Edit02Icon, PlugSocketIcon, PlusSignIcon } from 'hugeicons-react';
import Dialog from './ui/Dialog';
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
                    <Field label={t('mcp.url')}>
                        <input
                            type="text"
                            value={form.url}
                            onChange={change('url')}
                            className={`${FIELD_CLASS} font-mono`}
                            placeholder="https://mcp.example.com/mcp"
                        />
                    </Field>
                )}

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
            </form>
        </Dialog>
    );
}

function McpPanel({ agent, onSave }) {
    const t = useT();
    const servers = agent?.mcpServers || [];
    /** `{ server }` while editing, `{ server: null }` while adding. */
    const [editing, setEditing] = useState(null);
    const [confirming, setConfirming] = useState(null);

    const write = useCallback((next) => onSave?.(next), [onSave]);

    const handleSave = useCallback(async (record) => {
        const next = record.id
            ? servers.map(server => (server.id === record.id ? record : server))
            : [...servers, record];
        await write(next);
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

    return (
        <div className="flex flex-col gap-4 h-full min-h-0" id="mcp-panel">
            <div className="flex flex-wrap items-center gap-2 shrink-0">
                <p className="flex-1 min-w-[200px] text-[13px] text-gray-500 dark:text-gray-400">
                    {t('mcp.note')}
                </p>
                <Button
                    variant="primary"
                    icon={<PlusSignIcon size={16} strokeWidth={2.5} />}
                    onClick={() => setEditing({ server: null })}
                >
                    {t('mcp.new')}
                </Button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 pb-1">
                {servers.length === 0 ? (
                    <EmptyFrame
                        icon={<PlugSocketIcon size={28} strokeWidth={1.5} />}
                        title={t('mcp.empty')}
                        note={t('mcp.emptyNote')}
                    />
                ) : (
                    <div className="flex flex-col gap-2">
                        {servers.map(server => (
                            <div
                                key={server.id}
                                className="group/row flex items-center gap-3 px-4 py-3 rounded-xl
                                    bg-white dark:bg-neutral-800/50 border border-gray-200 dark:border-neutral-800"
                            >
                                <PlugSocketIcon size={18} strokeWidth={1.5} className="shrink-0 text-gray-400 dark:text-neutral-500" />
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
                                </div>
                                <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity">
                                    <button
                                        type="button"
                                        aria-label={t('common.edit')}
                                        onClick={() => setEditing({ server })}
                                        className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors
                                            text-gray-400 dark:text-neutral-500
                                            hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-surface-control dark:hover:text-white"
                                    >
                                        <Edit02Icon size={15} strokeWidth={1.5} />
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={t('common.deleteNamed', { name: server.name })}
                                        onClick={() => confirmDelete(server)}
                                        className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors
                                            text-gray-400 dark:text-neutral-500
                                            hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400"
                                    >
                                        <Delete02Icon size={15} strokeWidth={1.5} />
                                    </button>
                                </div>
                            </div>
                        ))}
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

            {confirming && <ConfirmDialog {...confirming} onCancel={() => setConfirming(null)} />}
        </div>
    );
}

export default memo(McpPanel);

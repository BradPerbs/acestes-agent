import { useCallback, useEffect, useState } from 'react';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import SegmentedControl from '../ui/SegmentedControl';
import Button from '../ui/Button';
import { useT } from '../../i18n';

/**
 * The envelope one agent works inside: where its local work runs, which
 * sessions it may drive, and which folders on this computer it may touch.
 *
 * Stored on the agent record rather than in the assistant settings, because
 * it is a property of the agent, not of the machine: an agent moved to
 * another machine should still be the one that may not leave its folder.
 * The page edits it through `agents.save`, field by field, since the
 * registry patches rather than replaces.
 *
 * The container switch is offered whether or not Docker is there, and the
 * status line under it says which. Offering it only when Docker is running
 * would hide the option from the person who has not started Docker yet,
 * which is exactly the person reading this card.
 */

const EXECUTIONS = ['host', 'container'];
const NETWORKS = ['none', 'any'];
const SESSIONS = ['own', 'any'];
const MODES = ['read', 'write'];

export default function SandboxCard({ agentId }) {
    const t = useT();
    const [sandbox, setSandbox] = useState(null);
    const [docker, setDocker] = useState(null);
    const [resetting, setResetting] = useState(false);
    const [notice, setNotice] = useState('');

    const load = useCallback(async () => {
        const snapshot = await window.api.agents.list();
        const agent = snapshot?.agents?.find(entry => entry.id === agentId);
        setSandbox(agent?.sandbox || null);
    }, [agentId]);

    useEffect(() => {
        if (!agentId) return undefined;
        load().catch(() => {});
        return window.api.agents.onChange(() => { load().catch(() => {}); });
    }, [agentId, load]);

    const refreshDocker = useCallback(() => {
        if (!agentId) return;
        setDocker(null);
        window.api.agents.sandboxStatus(agentId).then(setDocker).catch(() => setDocker({ available: false, reason: '' }));
    }, [agentId]);

    // Only asked for once the container is in play: a `docker version` on
    // every settings page open would spin up Docker Desktop's CLI for people
    // who never switched the container on.
    useEffect(() => {
        if (sandbox?.execution === 'container') refreshDocker();
    }, [sandbox?.execution, refreshDocker]);

    const save = useCallback(async (patch) => {
        setNotice('');
        await window.api.agents.save({ id: agentId, sandbox: patch });
    }, [agentId]);

    const addFolder = useCallback(async () => {
        const picked = await window.api.agents.chooseFolder();
        if (!picked?.path) return;
        await save({ folders: [...(sandbox?.folders || []), { path: picked.path, mode: 'read' }] });
    }, [sandbox, save]);

    const setMode = useCallback((index, mode) => save({
        folders: (sandbox?.folders || []).map((folder, at) => (at === index ? { ...folder, mode } : folder)),
    }), [sandbox, save]);

    const removeFolder = useCallback((index) => save({
        folders: (sandbox?.folders || []).filter((folder, at) => at !== index),
    }), [sandbox, save]);

    const reset = useCallback(async () => {
        setResetting(true);
        setNotice('');
        try {
            const result = await window.api.agents.sandboxReset(agentId);
            setNotice(result?.ok
                ? t('settings.assistant.sandbox.resetDone')
                : t('settings.assistant.sandbox.resetFailed', { error: result?.error || '' }));
        } finally {
            setResetting(false);
            refreshDocker();
        }
    }, [agentId, t, refreshDocker]);

    if (!sandbox) return null;

    const containerised = sandbox.execution === 'container';

    let dockerLine = '';
    if (containerised) {
        if (!docker) {
            dockerLine = t('settings.assistant.sandbox.docker.checking');
        } else if (!docker.available) {
            dockerLine = t('settings.assistant.sandbox.docker.missing', { reason: docker.reason || '' });
        } else {
            dockerLine = t('settings.assistant.sandbox.docker.ready', { version: docker.version || '' });
            if (docker.container?.exists) {
                dockerLine += ' ' + t('settings.assistant.sandbox.docker.container', { status: docker.container.status || '' });
            }
        }
    }

    return (
        <SettingCard>
            <div className="mb-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                    {t('settings.assistant.sandbox')}
                </h3>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('settings.assistant.sandboxDesc')}
                </p>
            </div>

            <SettingRow
                title={t('settings.assistant.sandbox.execution')}
                description={t(`settings.assistant.sandbox.execution.${sandbox.execution}.note`)}
            >
                <div className="space-y-2">
                    <SegmentedControl
                        ariaLabel={t('settings.assistant.sandbox.execution')}
                        segments={EXECUTIONS.map(value => ({
                            value,
                            label: t(`settings.assistant.sandbox.execution.${value}`),
                        }))}
                        value={sandbox.execution}
                        onChange={(value) => save({ execution: value })}
                    />
                    {containerised && (
                        <div className="flex flex-wrap items-center gap-3">
                            <span className={`text-xs ${docker && !docker.available
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-gray-500 dark:text-gray-400'}`}
                            >
                                {dockerLine}
                            </span>
                            {docker?.available && (
                                <Button size="sm" variant="ghost" onClick={reset} disabled={resetting}>
                                    {t('settings.assistant.sandbox.reset')}
                                </Button>
                            )}
                            {notice && (
                                <span className="text-xs text-gray-500 dark:text-gray-400">{notice}</span>
                            )}
                        </div>
                    )}
                </div>
            </SettingRow>

            {containerised && (
                <SettingRow
                    className={DIVIDED}
                    title={t('settings.assistant.sandbox.network')}
                    description={t(`settings.assistant.sandbox.network.${sandbox.network}.note`)}
                >
                    <SegmentedControl
                        ariaLabel={t('settings.assistant.sandbox.network')}
                        segments={NETWORKS.map(value => ({
                            value,
                            label: t(`settings.assistant.sandbox.network.${value}`),
                        }))}
                        value={sandbox.network}
                        onChange={(value) => save({ network: value })}
                    />
                </SettingRow>
            )}

            <SettingRow
                className={DIVIDED}
                title={t('settings.assistant.sandbox.sessions')}
                description={t(`settings.assistant.sandbox.sessions.${sandbox.sessions}.note`)}
            >
                <SegmentedControl
                    ariaLabel={t('settings.assistant.sandbox.sessions')}
                    segments={SESSIONS.map(value => ({
                        value,
                        label: t(`settings.assistant.sandbox.sessions.${value}`),
                    }))}
                    value={sandbox.sessions}
                    onChange={(value) => save({ sessions: value })}
                />
            </SettingRow>

            <SettingRow
                className={DIVIDED}
                title={t('settings.assistant.sandbox.folders')}
                description={t('settings.assistant.sandbox.foldersDesc')}
            >
                <div className="space-y-2">
                    {sandbox.folders.length === 0 ? (
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                            {t('settings.assistant.sandbox.foldersEmpty')}
                        </p>
                    ) : (
                        <ul className="space-y-1.5">
                            {sandbox.folders.map((folder, index) => (
                                <li
                                    key={folder.path}
                                    className="flex items-center gap-3 rounded-lg px-3 py-2
                                        bg-gray-50 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700"
                                >
                                    <span
                                        className="flex-1 min-w-0 truncate font-mono text-xs text-gray-800 dark:text-gray-200"
                                        title={folder.path}
                                    >
                                        {folder.path}
                                    </span>
                                    <SegmentedControl
                                        size="sm"
                                        ariaLabel={t('settings.assistant.sandbox.folders')}
                                        segments={MODES.map(value => ({
                                            value,
                                            label: t(`settings.assistant.sandbox.folder.${value}`),
                                        }))}
                                        value={folder.mode}
                                        onChange={(value) => setMode(index, value)}
                                    />
                                    <Button size="sm" variant="ghost" onClick={() => removeFolder(index)}>
                                        {t('settings.assistant.sandbox.removeFolder')}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <Button size="sm" variant="secondary" onClick={addFolder}>
                        {t('settings.assistant.sandbox.addFolder')}
                    </Button>
                </div>
            </SettingRow>
        </SettingCard>
    );
}

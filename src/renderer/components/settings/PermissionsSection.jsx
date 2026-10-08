import { useCallback, useEffect, useState } from 'react';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import LoadingCard from './ui/LoadingCard';
import SegmentedControl from '../ui/SegmentedControl';
import Button from '../ui/Button';
import SandboxCard from './SandboxCard';
import HooksCard from './HooksCard';
import useAssistantSettings, { FIELD_CLASS } from './useAssistantSettings';
import { useT } from '../../i18n';

/**
 * What the selected agent may do without asking: the approval policy, the
 * two command lists that sit either side of it, the sandbox it works inside,
 * and the hooks of yours that can veto a tool call.
 *
 * One page for all of it because they answer the same question, and someone
 * tightening what an agent may do should not have to remember that the block
 * list lived three cards below the voice engine.
 */

const APPROVALS = ['always', 'writes', 'never', 'full'];

const toText = (list) => (list || []).join('\n');
const toList = (text) => text.split('\n').map(line => line.trim()).filter(Boolean);

export default function PermissionsSection() {
    const t = useT();
    const { settings, update } = useAssistantSettings();
    const [commands, setCommands] = useState('');
    const [blocked, setBlocked] = useState('');

    // Filled when the settings arrive and again when the agent changes under
    // the page, since the lists are that agent's. Not on every settings push:
    // the composer moving the approval mode should not take away what someone
    // is halfway through typing into a list.
    const agentId = settings?.agentId;
    useEffect(() => {
        if (!settings) return;
        setCommands(toText(settings.autoApproveCommands));
        setBlocked(toText(settings.blockedCommands));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agentId, Boolean(settings)]);

    const saveCommands = useCallback(async () => {
        const next = await update({ autoApproveCommands: toList(commands) });
        setCommands(toText(next.autoApproveCommands));
    }, [commands, update]);

    const saveBlocked = useCallback(async () => {
        const next = await update({ blockedCommands: toList(blocked) });
        setBlocked(toText(next.blockedCommands));
    }, [blocked, update]);

    /**
     * Back to what the app shipped with.
     *
     * Both lists are free to be emptied or rewritten, which is the point of
     * them. What that leaves is no way back: once the seeded entries are gone
     * there is nothing on screen that remembers what they were. Main sends the
     * defaults with the settings so this does not need its own copy of them.
     */
    const restoreCommands = useCallback(async () => {
        const next = await update({ autoApproveCommands: settings.defaults.autoApproveCommands });
        setCommands(toText(next.autoApproveCommands));
    }, [settings?.defaults, update]);

    const restoreBlocked = useCallback(async () => {
        const next = await update({ blockedCommands: settings.defaults.blockedCommands });
        setBlocked(toText(next.blockedCommands));
    }, [settings?.defaults, update]);

    if (!settings) return <LoadingCard />;

    // Offered only once a list has actually moved away from the shipped one,
    // so the row is not carrying a button that would do nothing. Compared
    // against what is saved rather than what is in the box, because a list
    // someone is halfway through typing has not changed anything yet.
    const sameAsDefault = (list, fallback) => toText(list) === toText(fallback);
    const canRestoreCommands = settings.defaults
        && !sameAsDefault(settings.autoApproveCommands, settings.defaults.autoApproveCommands);
    const canRestoreBlocked = settings.defaults
        && !sameAsDefault(settings.blockedCommands, settings.defaults.blockedCommands);

    return (
        <>
            <SettingCard>
                <SettingRow
                    title={t('settings.assistant.approval')}
                    description={t(`settings.assistant.approval.${settings.approval}.note`)}
                >
                    <SegmentedControl
                        ariaLabel={t('settings.assistant.approval')}
                        segments={APPROVALS.map(value => ({
                            value,
                            label: t(`settings.assistant.approval.${value}`),
                        }))}
                        value={settings.approval}
                        onChange={(value) => update({ approval: value })}
                    />
                </SettingRow>

                <SettingRow
                    className={DIVIDED}
                    title={t('settings.assistant.allowList')}
                    description={t('settings.assistant.allowListDesc')}
                >
                    <div className="space-y-3">
                        <textarea
                            aria-label={t('settings.assistant.allowList')}
                            rows={6}
                            spellCheck={false}
                            className={`${FIELD_CLASS} font-jetbrains text-xs leading-relaxed resize-y`}
                            value={commands}
                            onChange={(event) => setCommands(event.target.value)}
                        />
                        <div className="flex items-center gap-3">
                            <Button size="sm" variant="secondary" onClick={saveCommands}>
                                {t('settings.assistant.saveList')}
                            </Button>
                            {canRestoreCommands && (
                                <Button size="sm" variant="ghost" onClick={restoreCommands}>
                                    {t('settings.assistant.restoreDefaults')}
                                </Button>
                            )}
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                                {t('settings.assistant.allowListNote', {
                                    mode: t('settings.assistant.approval.writes'),
                                })}
                            </span>
                        </div>
                    </div>
                </SettingRow>

                <SettingRow
                    className={DIVIDED}
                    title={t('settings.assistant.blockList')}
                    description={t('settings.assistant.blockListDesc')}
                >
                    <div className="space-y-3">
                        <textarea
                            aria-label={t('settings.assistant.blockList')}
                            rows={4}
                            spellCheck={false}
                            placeholder={'rm -rf\nshutdown\nmkfs'}
                            className={`${FIELD_CLASS} font-jetbrains text-xs leading-relaxed resize-y
                                placeholder:text-gray-500 dark:placeholder:text-neutral-400`}
                            value={blocked}
                            onChange={(event) => setBlocked(event.target.value)}
                        />
                        <div className="flex items-center gap-3">
                            <Button size="sm" variant="secondary" onClick={saveBlocked}>
                                {t('settings.assistant.saveList')}
                            </Button>
                            {canRestoreBlocked && (
                                <Button size="sm" variant="ghost" onClick={restoreBlocked}>
                                    {t('settings.assistant.restoreDefaults')}
                                </Button>
                            )}
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                                {t('settings.assistant.blockListEmpty')}
                            </span>
                        </div>
                        {/* Said plainly, because a list like this invites the
                            belief that it is a wall. It stops the destructive
                            command that arrives by mistake, which is nearly all
                            of them. It cannot stop one that is trying not to be
                            recognised, and nothing here should be relied on as
                            though it could. */}
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                            {t('settings.assistant.blockListWarning')}
                        </p>
                    </div>
                </SettingRow>
            </SettingCard>

            <SandboxCard agentId={settings.agentId} />
            <HooksCard agentId={settings.agentId} />
        </>
    );
}

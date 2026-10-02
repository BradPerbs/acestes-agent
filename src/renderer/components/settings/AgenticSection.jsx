import {
    ServerStack01Icon,
    ComputerTerminal01Icon,
    CursorMagicSelection01Icon,
} from 'hugeicons-react';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import LoadingCard from './ui/LoadingCard';
import Toggle from './ui/Toggle';
import Slider from './ui/Slider';
import SegmentedControl from '../ui/SegmentedControl';
import Capability, { Detail } from './Capability';
import BrowserUse from './BrowserUse';
import useAssistantSettings from './useAssistantSettings';
import { useT } from '../../i18n';

/**
 * What the selected agent can reach and operate, as a list of switches.
 *
 * Four things, from least reach to most: the servers (always, it is what the
 * agent is for), files and commands on this computer, the desktop's own apps
 * with the real mouse and keyboard, and a web browser. Each is a row with a
 * name a person would use for it, one line on what it means, and a switch;
 * what there is to set once one is on opens underneath it. The long
 * explanations the old page led with are still there, under the switch they
 * explain, for whoever switches it on.
 *
 * Then how far one turn may run, and the list of tools that all of this adds
 * up to.
 */

const COMMAND_MODES = ['terminal', 'background'];

/** How fast the agent's cursor and typing go. See main/ai/computer.js. */
const COMPUTER_PACES = ['slow', 'normal', 'fast'];

/**
 * The step slider's last notch, which is "no limit" rather than a number.
 * Stored as 0, which every runtime reads as no ceiling (see main/ai/settings).
 */
const STEPS_MAX = 100;
const STEPS_UNLIMITED = STEPS_MAX + 5;

export default function AgenticSection() {
    const t = useT();
    const { settings, tools, update } = useAssistantSettings();

    if (!settings) return <LoadingCard />;

    const readOnlyTools = tools.filter(tool => tool.readOnly).length;

    // The desktop itself: Windows and macOS, the systems there is a helper for
    // (tools/DesktopHelper.cs, tools/mac/).
    const desktop = ['win32', 'darwin'].includes(window.api.platform);

    const unlimited = settings.maxTurns === 0;
    const stepsValue = unlimited ? STEPS_UNLIMITED : Math.min(settings.maxTurns, STEPS_MAX);

    return (
        <>
            <SettingCard>
                {/* Always on: the sessions you open are the agent's way in. The
                    one choice is whether you watch the commands land. */}
                <Capability
                    icon={ServerStack01Icon}
                    title={t('settings.agentic.servers')}
                    description={t('settings.agentic.serversDesc')}
                    control={(
                        <span className="inline-flex items-center h-6 px-2.5 rounded-full text-xs font-medium
                            bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        >
                            {t('settings.agentic.alwaysOn')}
                        </span>
                    )}
                    open
                >
                    <Detail
                        title={t('settings.assistant.commandMode')}
                        description={t(`settings.assistant.commandMode.${settings.commandMode}.note`)}
                    >
                        <SegmentedControl
                            ariaLabel={t('settings.assistant.commandMode')}
                            segments={COMMAND_MODES.map(value => ({
                                value,
                                label: t(`settings.assistant.commandMode.${value}`),
                            }))}
                            value={settings.commandMode}
                            onChange={(value) => update({ commandMode: value })}
                        />
                    </Detail>
                </Capability>

                <Capability
                    className={DIVIDED}
                    icon={ComputerTerminal01Icon}
                    title={t('settings.agentic.local')}
                    description={t('settings.agentic.localDesc')}
                    control={(
                        <Toggle
                            ariaLabel={t('settings.agentic.local')}
                            checked={settings.allowLocalTools}
                            onChange={(value) => update({ allowLocalTools: value })}
                        />
                    )}
                />

                {desktop && (
                    <Capability
                        className={DIVIDED}
                        icon={CursorMagicSelection01Icon}
                        title={t('settings.agentic.desktop')}
                        description={t('settings.agentic.desktopDesc')}
                        open={Boolean(settings.computerUse)}
                        control={(
                            <Toggle
                                ariaLabel={t('settings.agentic.desktop')}
                                checked={Boolean(settings.computerUse)}
                                onChange={(value) => update({ computerUse: value })}
                            />
                        )}
                    >
                        <div className="space-y-5">
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {window.api.platform === 'darwin'
                                    ? `${t('settings.assistant.computerUseDesc')} ${t('settings.assistant.computerUseMac')}`
                                    : t('settings.assistant.computerUseDesc')}
                            </p>
                            <Detail
                                title={t('settings.assistant.computerPace')}
                                description={t('settings.assistant.computerPaceDesc')}
                            >
                                <SegmentedControl
                                    ariaLabel={t('settings.assistant.computerPace')}
                                    segments={COMPUTER_PACES.map(value => ({
                                        value,
                                        label: t(`settings.assistant.computerPace.${value}`),
                                    }))}
                                    value={settings.computerPace || 'normal'}
                                    onChange={(value) => update({ computerPace: value })}
                                />
                            </Detail>
                        </div>
                    </Capability>
                )}

                <BrowserUse className={DIVIDED} settings={settings} update={update} />
            </SettingCard>

            <SettingCard>
                <SettingRow
                    align="center"
                    title={t('settings.assistant.steps')}
                    description={unlimited ? t('settings.agentic.stepsUnlimited') : t('settings.agentic.stepsDesc')}
                    control={
                        <Slider
                            ariaLabel={t('settings.assistant.steps')}
                            value={stepsValue}
                            min={5}
                            max={STEPS_UNLIMITED}
                            step={5}
                            format={(value) => (value === STEPS_UNLIMITED ? t('settings.agentic.noLimit') : String(value))}
                            onChange={(value) => update({ maxTurns: value === STEPS_UNLIMITED ? 0 : value })}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.assistant.lines')}
                    description={t('settings.assistant.linesDesc')}
                    control={
                        <Slider
                            ariaLabel={t('settings.assistant.lines')}
                            value={settings.transcriptLines}
                            min={40}
                            max={1000}
                            step={20}
                            onChange={(value) => update({ transcriptLines: value })}
                        />
                    }
                />
            </SettingCard>

            <SettingCard>
                <SettingRow
                    title={t('settings.assistant.tools')}
                    description={t('settings.assistant.toolsDesc', {
                        count: tools.length,
                        readOnly: readOnlyTools,
                    })}
                >
                    {/* Two across at the card's full width, one once it has
                        less: these names truncate, and half of a narrow card is
                        where they start truncating to nothing. */}
                    <ul className="grid gap-x-6 gap-y-2 grid-cols-[repeat(auto-fill,minmax(min(15rem,100%),1fr))]">
                        {tools.map(tool => (
                            <li key={tool.name} className="flex items-center gap-2 min-w-0">
                                <span
                                    aria-hidden="true"
                                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                        tool.readOnly ? 'bg-emerald-500' : 'bg-amber-500'
                                    }`}
                                />
                                <span className="text-sm text-gray-700 dark:text-gray-300 truncate">
                                    {tool.title}
                                </span>
                            </li>
                        ))}
                    </ul>
                </SettingRow>
            </SettingCard>
        </>
    );
}

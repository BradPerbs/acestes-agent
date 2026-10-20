import { memo, useCallback, useMemo, useState } from 'react';
import AssistantConversation from './assistant/AssistantConversation';
import { followScope } from '../lib/assistant-scope';

/**
 * Home: a greeting, one box to type in, and a row of starters under it.
 *
 * The conversations are in the sidebar already, so Home no longer lists
 * them; it is where a new one begins. The box is the conversation composer
 * itself, with the model, the mode, `@`, `/` and attachments, drawn in
 * Home's layout. Sending opens a tab for the conversation and the message is
 * said there; Home then comes back empty, with a fresh composer under a new
 * key so nothing of the last message lingers in it.
 */
function HomeStart({
    isActive = true,
    agentId,
    agentLook,
    sessions = [],
    hosts = [],
    activeSessionId,
    onLaunch,
    onOpenSettings,
}) {
    const [round, setRound] = useState(0);
    // Home is about whatever is in front, like a fresh tab.
    const scope = useMemo(() => followScope(), []);

    const launch = useCallback((message) => {
        onLaunch?.(message);
        setRound(count => count + 1);
    }, [onLaunch]);

    return (
        <div className="absolute inset-0 flex flex-col" id="home-start">
            <AssistantConversation
                key={`${agentId}:${round}`}
                home
                active={isActive}
                scope={scope}
                sessions={sessions}
                hosts={hosts}
                activeSessionId={activeSessionId}
                agentId={agentId}
                agentLook={agentLook}
                onOpenSettings={onOpenSettings}
                onLaunch={launch}
            />
        </div>
    );
}

export default memo(HomeStart);

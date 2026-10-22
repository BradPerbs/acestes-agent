import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AssistantConversation from './assistant/AssistantConversation';
import OctopusBar from './home/OctopusBar';
import { followScope } from '../lib/assistant-scope';
import { useT } from '../i18n';

/** Where octopus mode and its last agent are kept between runs. */
const OCTOPUS_STORE = 'home.octopus';

function readOctopus() {
    try {
        const stored = JSON.parse(localStorage.getItem(OCTOPUS_STORE) || '{}');
        return { on: Boolean(stored?.on), targetId: String(stored?.targetId || '') };
    } catch {
        return { on: false, targetId: '' };
    }
}

/** How long "Sent to ..." stays on the card after a prompt goes. */
const SENT_FOR = 2500;

/**
 * Home: a greeting, one box to type in, and a row of starters under it.
 *
 * The conversations are in the sidebar already, so Home no longer lists
 * them; it is where a new one begins. The box is the conversation composer
 * itself, with the model, the mode, `@`, `/` and attachments, drawn in
 * Home's layout. Sending opens a tab for the conversation and the message is
 * said there; Home then comes back empty, with a fresh composer under a new
 * key so nothing of the last message lingers in it.
 *
 * Octopus mode sends to any agent, not only the selected one, and stays on
 * Home: each prompt opens its tab behind the page, so the next can go to
 * another agent straight away. The composer is the target agent's (its
 * model, its mode, its inventory for `@`), so changing the target mounts a
 * new one; whatever was typed is carried across.
 */
function HomeStart({
    isActive = true,
    agentId,
    agentLook,
    agents = [],
    sessions = [],
    hosts = [],
    activeSessionId,
    onLaunch,
    onOpenSettings,
}) {
    const t = useT();
    const [round, setRound] = useState(0);
    // Home is about whatever is in front, like a fresh tab.
    const scope = useMemo(() => followScope(), []);

    const [octopus, setOctopus] = useState(readOctopus);
    useEffect(() => {
        try {
            localStorage.setItem(OCTOPUS_STORE, JSON.stringify(octopus));
        } catch {
            // Not kept; it still works for this run.
        }
    }, [octopus]);

    const on = octopus.on && agents.length > 0;
    // The last agent picked, while it still exists; the selected one otherwise.
    const target = on
        ? (agents.find(agent => agent.id === octopus.targetId)
            || agents.find(agent => agent.id === agentId)
            || agents[0])
        : null;
    const composerAgentId = target?.id || agentId;
    const composerLook = target || agentLook;
    const composerKey = `${composerAgentId}:${round}`;

    /**
     * The words, pictures and files in the composer, as it last rendered,
     * and the draft carried into the next one: kept with the key it is for,
     * so it lands only in the composer mounted under that key.
     */
    const draftRef = useRef(null);
    const carryRef = useRef(null);
    const carryTo = useCallback((key) => {
        const draft = draftRef.current;
        const kept = draft && (draft.text?.trim() || draft.images?.length || draft.files?.length);
        carryRef.current = kept ? { key, draft } : null;
    }, []);
    const initialDraft = carryRef.current?.key === composerKey ? carryRef.current.draft : null;

    const retarget = useCallback((id) => {
        if (!id || id === composerAgentId) return;
        carryTo(`${id}:${round}`);
        setOctopus(current => ({ ...current, targetId: id }));
    }, [composerAgentId, round, carryTo]);

    const step = useCallback((delta) => {
        if (agents.length < 2) return;
        const at = Math.max(0, agents.findIndex(agent => agent.id === composerAgentId));
        retarget(agents[(at + delta + agents.length) % agents.length].id);
    }, [agents, composerAgentId, retarget]);

    const toggle = useCallback(() => {
        const next = octopus.on
            ? { ...octopus, on: false }
            // Turned on, it starts where it was left, or on the agent selected.
            : { on: true, targetId: agents.some(agent => agent.id === octopus.targetId) ? octopus.targetId : agentId };
        carryTo(`${(next.on && next.targetId) || agentId}:${round}`);
        setOctopus(next);
    }, [octopus, agents, agentId, round, carryTo]);

    // "Sent to ..." for a moment after each prompt.
    const [sentTo, setSentTo] = useState(null);
    useEffect(() => {
        if (!sentTo) return undefined;
        const timer = setTimeout(() => setSentTo(null), SENT_FOR);
        return () => clearTimeout(timer);
    }, [sentTo]);

    // The composer as it is now, for a launch that resolves after it changed.
    const nowRef = useRef({ composerAgentId, round });
    nowRef.current = { composerAgentId, round };

    const launch = useCallback((message) => {
        if (on) {
            onLaunch?.({ ...message, background: true });
            const name = agents.find(agent => agent.id === message.agentId)?.name || target?.name || '';
            setSentTo({ name, at: Date.now() });
        } else {
            onLaunch?.(message);
        }
        // Anything typed while the conversation was being made goes on into
        // the next composer rather than away with this one.
        const now = nowRef.current;
        carryTo(`${now.composerAgentId}:${now.round + 1}`);
        setRound(now.round + 1);
    }, [onLaunch, on, agents, target, carryTo]);

    /**
     * The chords, while Home is the thing on screen: Ctrl+Shift+O turns the
     * mode on and off, Alt+Left and Alt+Right step through the agents.
     * Taken in the capture phase so the composer, which has the focus, does
     * not see them. See OCTOPUS_KEYS for how the tooltips spell them.
     */
    const keysRef = useRef({ on, toggle, step });
    keysRef.current = { on, toggle, step };
    useEffect(() => {
        if (!isActive) return undefined;
        const handler = (event) => {
            if (event.metaKey) return;
            const claim = () => {
                event.preventDefault();
                event.stopPropagation();
            };
            if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyO') {
                claim();
                keysRef.current.toggle();
                return;
            }
            if (!keysRef.current.on || !event.altKey || event.ctrlKey || event.shiftKey) return;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                claim();
                keysRef.current.step(event.key === 'ArrowLeft' ? -1 : 1);
            }
        };
        document.addEventListener('keydown', handler, true);
        return () => document.removeEventListener('keydown', handler, true);
    }, [isActive]);

    const aside = (
        <OctopusBar
            on={on}
            agents={agents}
            target={target}
            sentTo={sentTo}
            onToggle={toggle}
            onPick={retarget}
            onStep={step}
        />
    );

    return (
        <div className="absolute inset-0 flex flex-col" id="home-start">
            <AssistantConversation
                key={composerKey}
                home
                active={isActive}
                scope={scope}
                sessions={sessions}
                hosts={hosts}
                activeSessionId={activeSessionId}
                agentId={composerAgentId}
                agentLook={composerLook}
                onOpenSettings={onOpenSettings}
                onLaunch={launch}
                homeAside={aside}
                homePlaceholder={on && target ? t('home.octopus.placeholder', { name: target.name }) : ''}
                initialDraft={initialDraft}
                draftRef={draftRef}
            />
        </div>
    );
}

export default memo(HomeStart);

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Copy01Icon, LinkSquare02Icon, Tick01Icon } from 'hugeicons-react';
import AgentMark from './AgentMark';
import ScopeMenu from './ScopeMenu';
import AssistantConversation, { HAIRLINE, HeaderButton } from './AssistantConversation';
import { PANE_HEADER_HEIGHT } from '../../lib/layout';
import { useT } from '../../i18n';

/**
 * A conversation as the thing on screen.
 *
 * The chat used to be a column beside the terminal, drawn narrow and shown
 * only while something else was in front. It is a tab of the window now, and
 * this is what that tab shows: a header naming the conversation and the
 * servers it is about, and the conversation itself underneath.
 *
 * The transcript and the composer are held to a reading measure rather than
 * stretched to the window. A reply is prose, and prose at 1600px is one long
 * line; the width that is left over goes to the margins, the way the empty
 * state inside the conversation already caps itself.
 *
 * The header is the pane headers' row: the same height, the same 32px
 * controls. The scope selector sits on the right, at the width the old tab
 * gave it, because it is the one control here that decides what the next
 * message can touch, and the mark and the title on the left are what the tab
 * strip is already saying, repeated where there is room to read it.
 */
/** How long the tick stays up after a copy. */
const CONFIRM_MS = 1400;

/**
 * The whole conversation to the clipboard, as the debugging cut of the
 * export: settings, every tool input, results untruncated. The button is
 * the tick for a moment afterwards, the way the copy on a code block is;
 * a toast for a thing you just did with your own hand is noise.
 */
function CopyConversationButton({ conversationId }) {
    const t = useT();
    const [copied, setCopied] = useState(false);
    const timer = useRef(0);
    useEffect(() => () => clearTimeout(timer.current), []);

    const copy = useCallback(async () => {
        if (!conversationId) return;
        const text = await window.api.ai.markdown?.(conversationId, { full: true });
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            try {
                await window.api.clipboard?.writeText?.(text);
            } catch {
                return;
            }
        }
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
    }, [conversationId]);

    return (
        <HeaderButton
            title={copied ? t('assistant.copied') : t('assistant.copyConversation')}
            hint={copied ? undefined : t('assistant.copyConversationHint')}
            icon={copied
                ? <Tick01Icon size={16} strokeWidth={2.25} className="text-emerald-600 dark:text-emerald-400" />
                : <Copy01Icon size={16} strokeWidth={1.75} />}
            onClick={copy}
        />
    );
}

function ConversationView({
    tab,
    /** Whether this tab is the one in front. The others stay mounted. */
    active,
    /** What the conversation last reported: `{ title, busy }`. */
    status,
    sessions,
    hosts = [],
    activeSessionId,
    /** Whose conversation this is, for the one it starts, and its colour. */
    agentId = '',
    agentColor = '',
    /** The scope selector's props, minus the scope itself. See useConversationTabs. */
    scopeProps,
    onConversationChange,
    onStatus,
    onOpenSettings,
    onOpenSnippets,
    onDetach,
    onClose,
    onNewTab,
}) {
    const t = useT();
    const title = tab.customTitle || status?.title || t('assistant.newConversation');

    // Ctrl+T opens a conversation and Ctrl+W closes this one, but only while
    // the focus is inside it: a terminal keeps both chords for its own shell.
    const onKeyDown = useCallback((event) => {
        if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        if (event.key === 'w') {
            event.preventDefault();
            event.stopPropagation();
            onClose?.();
        } else if (event.key === 't') {
            event.preventDefault();
            event.stopPropagation();
            onNewTab?.();
        }
    }, [onClose, onNewTab]);

    return (
        <div className="absolute inset-0 flex flex-col" onKeyDown={onKeyDown}>
            <div
                className={`shrink-0 px-3 flex items-center gap-3 border-b ${HAIRLINE}`}
                style={{ height: PANE_HEADER_HEIGHT }}
            >
                <div className="min-w-0 flex-1 flex items-center gap-2">
                    {/* Working, said by the mark: a conversation answering
                        while you read it should be visibly doing so. */}
                    <AgentMark size={18} color={agentColor} className={status?.busy ? 'animate-pulse' : ''} />
                    <span className="text-xs font-semibold text-gray-900 dark:text-white truncate">
                        {title}
                    </span>
                </div>

                <div className="shrink-0 w-64 max-w-[40%]">
                    <ScopeMenu scope={tab.scope} {...scopeProps} />
                </div>

                {tab.conversationId && <CopyConversationButton conversationId={tab.conversationId} />}

                <HeaderButton
                    title={t('assistant.detachOnly')}
                    icon={<LinkSquare02Icon size={16} strokeWidth={1.75} />}
                    onClick={onDetach}
                />
            </div>

            <div className="flex-1 min-h-0 flex flex-col w-full max-w-3xl mx-auto">
                <AssistantConversation
                    tabId={tab.id}
                    conversationId={tab.conversationId}
                    active={active}
                    scope={tab.scope}
                    sessions={sessions}
                    hosts={hosts}
                    activeSessionId={activeSessionId}
                    agentId={agentId}
                    agentColor={agentColor}
                    onConversationChange={onConversationChange}
                    onStatus={onStatus}
                    onOpenSettings={onOpenSettings}
                    onOpenSnippets={onOpenSnippets}
                />
            </div>
        </div>
    );
}

export default memo(ConversationView);

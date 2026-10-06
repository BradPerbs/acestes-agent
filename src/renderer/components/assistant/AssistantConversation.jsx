import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    Cancel01Icon,
    PlusSignIcon,
    ArrowUp01Icon,
    StopCircleIcon,
    ImageAdd01Icon,
    Attachment01Icon,
    ArrowUpRight01Icon,
    Delete02Icon,
    Edit02Icon,
} from 'hugeicons-react';
import Tooltip from '../ui/Tooltip';
import AgentMark from './AgentMark';
import Markdown from '../../lib/markdown';
import useAssistant from '../../hooks/useAssistant';
import useTypewriter from '../../hooks/useTypewriter';
import useMentionables from '../../hooks/useMentionables';
import useSkills, { matchSkills } from '../../hooks/useSkills';
import MentionPicker, { MentionIcon, matchMentions } from './MentionPicker';
import SlashPicker from './SlashPicker';
import ApprovalRequest from './ApprovalRequest';
import QuestionRequest from './QuestionRequest';
import WorkingIndicator from './WorkingIndicator';
import Transcript, { Notice } from './Transcript';
import { Thought } from './ToolGroup';
import ModelMenu from './ModelMenu';
import ContextRing from './ContextRing';
import ApprovalMenu from './ApprovalMenu';
import DictationButton from './DictationButton';
import { useT } from '../../i18n';
import { groupApprovals } from '../../lib/approvals';
import { IMAGE_TYPES, imageFiles, readImage } from '../../lib/images';
import { isAttachableFile, readTextFile } from '../../lib/files';
import { describe, toWire } from '../../lib/assistant-scope';
import { pickLine } from '../../lib/aeneid';
import { lastModel, rememberModel } from '../../lib/last-model';
import { agentColor } from '../../lib/agent-colors';
import { TRANSCRIPT_HOLD } from '../../lib/transcript-find';

/** The rule inside a card, which is lighter than the one between two cards. */
export const HAIRLINE = 'border-black/[0.06] dark:border-white/[0.06]';

/**
 * A button at pane-header size: the rail's button when the panel is shut.
 *
 * Written out rather than reached for from `ui/Button`, because the pane
 * headers in this app use 32px buttons with a 12px radius and `IconButton`'s
 * small size is 8px.
 */
export function HeaderButton({ title, hint, icon, onClick, placement = 'bottom' }) {
    return (
        <Tooltip label={title} hint={hint} placement={placement}>
            <button
                type="button"
                aria-label={title}
                onClick={onClick}
                className="w-8 h-8 shrink-0 flex items-center justify-center rounded-xl transition-colors
                    outline-none text-gray-500 dark:text-gray-400
                    hover:bg-gray-100 hover:text-gray-900
                    dark:hover:bg-surface-control dark:hover:text-white
                    focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25"
            >
                {icon}
            </button>
        </Tooltip>
    );
}


const WINDOWS = {
    five_hour: '5h',
    seven_day: '7d',
    seven_day_opus: '7d Opus',
    seven_day_sonnet: '7d Sonnet',
    seven_day_overage_included: '7d',
    overage: 'overage',
};

/**
 * What this conversation is costing, in the currency the user actually pays in.
 *
 * Three states, and the third one matters most: confirmed subscription,
 * confirmed metered billing, and not known. Nothing is shown in the third.
 *
 * The runtime always reports a `total_cost_usd`, but on a plan it is the price
 * those tokens *would* have cost on the API, not a bill anyone is sending. The
 * absence of a subscription is not evidence of an API key either: the account
 * lookup has not answered yet during the first turn, and an older Claude Code
 * cannot answer it at all. Treating "no subscription found" as "billed to your
 * API key" tells someone with no key that they are paying per token, which is
 * both wrong and alarming.
 *
 * So a dollar figure appears only where we can name the thing paying it: a key
 * this app was given, or a key the runtime says it is using.
 */
function Usage({ account, rateLimit, costUsd, hasStoredKey }) {
    const t = useT();

    if (account?.subscriptionType) {
        if (rateLimit?.utilization === null || rateLimit?.utilization === undefined) return null;

        const percent = Math.round(rateLimit.utilization);
        const window = WINDOWS[rateLimit.window] || 'plan';
        const tone = rateLimit.status === 'rejected'
            ? 'text-red-500 dark:text-red-400'
            : rateLimit.status === 'allowed_warning'
                ? 'text-amber-500 dark:text-amber-400'
                : 'text-gray-400 dark:text-gray-600';

        return (
            <Tooltip
                label={`${percent}% of your ${account.subscriptionType} plan's ${window} limit used`}
                placement="top"
            >
                <span className={`px-1 text-[10px] tabular-nums ${tone}`}>
                    {window} {percent}%
                </span>
            </Tooltip>
        );
    }

    const metered = hasStoredKey
        || Boolean(account?.apiKeySource && account.apiKeySource !== 'none');

    if (!metered || !costUsd) return null;

    return (
        <Tooltip label={t('assistant.costHint')} placement="top">
            <span className="px-1 text-[10px] tabular-nums text-gray-400 dark:text-gray-600">
                ${costUsd.toFixed(3)}
            </span>
        </Tooltip>
    );
}

/**
 * The turn in progress.
 *
 * A component of its own because the reveal sets state on every frame, and
 * that repaint should cost this block rather than the whole transcript sitting
 * above it. It also means the panel's own render is still driven by arriving
 * text and not by the animation.
 *
 * The scroller cannot see the reveal either: the text it is following only
 * changes when a chunk lands, while the block underneath it goes on growing
 * for a few frames afterwards. So each step says so, and the panel keeps the
 * bottom in view on its own terms.
 */
function StreamingText({ text, onReveal, active = true }) {
    const shown = useTypewriter(text, active);

    useLayoutEffect(() => {
        onReveal();
    }, [shown, onReveal]);

    return <Markdown text={shown} />;
}

/**
 * Messages waiting for the running turn to end, in send order.
 *
 * Held in the panel rather than sent to main: a queued message is not in
 * the transcript yet, it goes there when it is actually sent. `Steer`
 * stops the running turn and sends that row next instead of in order.
 */
function MessageQueue({ queue, onSteer, onEdit, onRemove }) {
    const t = useT();
    if (!queue.length) return null;
    return (
        <div className="px-3 pb-2 space-y-1.5" role="list" aria-label={t('assistant.queue')}>
            {queue.map(entry => (
                <div
                    key={entry.id}
                    role="listitem"
                    className="flex items-center gap-1.5 rounded-xl pl-2.5 pr-1.5 py-1.5
                        bg-gray-100 dark:bg-white/[0.06]"
                >
                    <span aria-hidden="true" className="shrink-0 grid grid-cols-2 gap-[2px] opacity-40">
                        {[0, 1, 2, 3, 4, 5].map(dot => (
                            <span key={dot} className="w-[3px] h-[3px] rounded-full bg-current text-gray-500" />
                        ))}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-gray-700 dark:text-gray-300">
                        {entry.text || t('assistant.queuedAttachments', { count: entry.images.length + (entry.files || []).length + entry.mentions.length })}
                    </span>
                    <button
                        type="button"
                        aria-label={t('assistant.queuedRemove')}
                        onClick={() => onRemove(entry.id)}
                        className="w-6 h-6 shrink-0 flex items-center justify-center rounded-full
                            text-gray-500 dark:text-gray-400
                            hover:bg-black/[0.06] dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"
                    >
                        <Delete02Icon size={13} strokeWidth={2} />
                    </button>
                    <button
                        type="button"
                        aria-label={t('assistant.queuedEdit')}
                        onClick={() => onEdit(entry.id)}
                        className="w-6 h-6 shrink-0 flex items-center justify-center rounded-full
                            text-gray-500 dark:text-gray-400
                            hover:bg-black/[0.06] dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"
                    >
                        <Edit02Icon size={13} strokeWidth={2} />
                    </button>
                    <button
                        type="button"
                        onClick={() => onSteer(entry.id)}
                        className="shrink-0 h-6 px-2.5 rounded-full text-[11px] font-medium
                            text-gray-600 dark:text-gray-300
                            hover:bg-black/[0.06] dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"
                    >
                        {t('assistant.steer')}
                    </button>
                </div>
            ))}
        </div>
    );
}

/**
 * How long streamed text can sit still, in ms, before the working line comes
 * back under it. The model often writes a sentence and then spends a long
 * while composing the call that follows, a big edit most of all, and in that
 * gap the draft is on screen, not growing, and nothing says the turn is alive.
 */
const QUIET_AFTER = 1200;

/** Whether `text` is there and has not changed for `QUIET_AFTER`. */
function useQuiet(text) {
    const [quiet, setQuiet] = useState(false);
    useEffect(() => {
        setQuiet(false);
        if (!text) return undefined;
        const timer = setTimeout(() => setQuiet(true), QUIET_AFTER);
        return () => clearTimeout(timer);
    }, [text]);
    return quiet;
}

/**
 * The conversation itself: everything inside the card.
 *
 * Split from the column around it because the column is what animates, and it
 * has to stay in the layout while shut. This is mounted only while the panel is
 * open or on its way out, so closing it still drops the transcript, the draft
 * and the subscription behind it exactly as unmounting always did.
 */
export default function AssistantConversation({
    /** The tab this is drawn in, for what it reports back about itself. */
    tabId,
    /** The conversation the tab was left holding, if any. */
    conversationId,
    /** Whether this tab is the one in front. The others stay mounted. */
    active = true,
    /**
     * Which servers this tab is about: the session in front, every host, or
     * an explicit set. Owned by the tab, since the strip draws the control
     * that changes it; see `lib/assistant-scope` for the shape.
     */
    scope,
    sessions,
    hosts = [],
    activeSessionId,
    /** Whose conversation this is: it starts under that agent, whose inventory it can tag. */
    agentId = '',
    agentLook = null,
    onConversationChange,
    onStatus,
    onOpenSettings,
    /** Bring a conversation to the front by id, in a tab of its own: a branch. */
    onOpenConversation,
}) {
    const t = useT();
    const [settings, setSettings] = useState(null);
    /**
     * The settings of the agent this tab belongs to, which is not always the
     * one selected. Read for its accounts: the model menu offers the ones
     * ticked for this agent, the only ones its conversations can run on.
     */
    const [agentSettings, setAgentSettings] = useState(null);
    /**
     * The model lists, keyed by the agent each came from.
     *
     * Kept with the agent it came from rather than on its own, so that a list
     * arriving for an agent that has since been switched off cannot be shown as
     * though it belonged to another. Reading a catalog means starting a
     * runtime, so those answers can arrive seconds late, in any order, and with
     * several agents switched on there are several of them in flight at once.
     *
     * An agent that is absent has not been asked. One with `null` was asked and
     * publishes nothing, which is a different answer and reads differently in
     * the menu.
     */
    const [catalogs, setCatalogs] = useState({});

    /** Whether a read is in flight, so the menu can say so rather than look empty. */
    const [readingModels, setReadingModels] = useState(false);
    const [text, setText] = useState('');

    /**
     * Pictures waiting in the composer, `{ id, name, mediaType, data, dataUrl }`.
     * Pasted, dropped or picked, and shown as thumbnails until they are sent.
     */
    const [images, setImages] = useState([]);
    /** Which agents can be sent one, from main. The button shows only for those. */
    const [imageProviders, setImageProviders] = useState([]);
    /** Whose runtime each agent answers on, from main: the gate is per tab. */
    const [agentProviders, setAgentProviders] = useState({});
    /** Why the last file did not make it in, shown under the thumbnails. */
    const [imageNotice, setImageNotice] = useState('');
    /**
     * Plain files waiting in the composer, `{ id, name, mediaType, text }`.
     * Unlike pictures these travel as words, so every agent takes them.
     */
    const [files, setFiles] = useState([]);
    /** Why the last file did not make it in, shown under the file chips. */
    const [fileNotice, setFileNotice] = useState('');
    /** A file drag hovering the composer, which then draws as a drop zone. */
    const [dragging, setDragging] = useState(false);
    // What the microphone has to say for itself: nothing heard, no access.
    const [voiceNotice, setVoiceNotice] = useState('');

    /**
     * What this message points at, tagged with `@` or invoked with `/`:
     * hosts, snippets, notes, proxies, keys, MCP servers, skills, and files
     * in the agent's granted folders. Held as `{ kind, id, name }` and sent
     * as the first two, so the main process reads the record as it stands
     * rather than from a copy the panel took when it was tagged.
     */
    const [mentions, setMentions] = useState([]);
    const mentionables = useMentionables({ agentId, hosts });

    /** `{ query, start }` while the picker is open, and the row highlighted. */
    const [mention, setMention] = useState(null);
    const [activeRow, setActiveRow] = useState(0);

    /**
     * The `/` picker: slash skills, open only while the message itself starts
     * with `/` and the caret is still on the first line. `{ query }` is the
     * command token being typed; anything after its first space is arguments
     * and stays in the field when a skill is picked.
     */
    const { skills } = useSkills();
    const [slash, setSlash] = useState(null);
    const [slashRow, setSlashRow] = useState(0);
    const slashMatches = useMemo(
        () => (slash ? matchSkills(skills, slash.query) : []),
        [slash, skills],
    );

    /**
     * Follow-ups typed while a turn is running, per conversation: each is
     * `{ id, text, images, files, mentions }` with images already in wire form
     * (`{ name, mediaType, data }`), files as `{ name, mediaType, text }`
     * and mentions as `{ kind, id, name }`.
     * Shown above the composer, sent in order once the turn ends.
     */
    const [queues, setQueues] = useState({});
    /** A steered row: jumps the queue the moment the turn stops. */
    const steerRef = useRef(null);
    /** A send already in flight from the queue, against double effects. */
    const sendingRef = useRef(false);

    const matches = useMemo(
        () => (mention ? matchMentions(mentionables, mention.query) : []),
        [mention, mentionables],
    );

    const dropMention = useCallback((kind, id) => {
        setMentions(current => current.filter(entry => !(entry.kind === kind && entry.id === id)));
    }, []);

    const scrollRef = useRef(null);
    const inputRef = useRef(null);

    /**
     * What was said, added to the message rather than over it: dictation is
     * often the second half of something typed. Live, the words so far arrive
     * again and again, each time replacing the last, after the message as it
     * stood when the talking began; the box is read-only meanwhile, so the
     * two cannot cross. At the end the box grows to fit and takes the focus,
     * so it can be read over and sent with Enter. Nothing said, or thrown
     * away, leaves the message as it was.
     */
    const textNow = useRef(text);
    textNow.current = text;
    const spokenAfter = useRef(null);
    const [dictating, setDictating] = useState(false);
    const addDictation = useCallback((spoken, { final = true } = {}) => {
        setVoiceNotice('');
        if (spokenAfter.current === null) spokenAfter.current = textNow.current;
        const before = spokenAfter.current;
        const words = String(spoken || '').trim();
        setText(before.trim() && words ? `${before.replace(/\s+$/, '')} ${words}` : (words || before));
        setDictating(!final);
        if (final) spokenAfter.current = null;
        requestAnimationFrame(() => {
            const field = inputRef.current;
            if (!field) return;
            field.style.height = 'auto';
            field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
            field.scrollTop = field.scrollHeight;
            if (!final) return;
            field.focus();
            field.setSelectionRange(field.value.length, field.value.length);
        });
    }, []);
    const fileRef = useRef(null);
    const docRef = useRef(null);
    // Drags enter and leave every child on the way in, so the overlay follows
    // a depth rather than a single event: the last leave ends the hover.
    const dragDepth = useRef(0);
    const stickToBottom = useRef(true);

    /** What the empty page says, chosen once for the life of the tab. */
    const line = useMemo(() => pickLine(), []);

    // `follow` is resolved against the pane in front here, so what goes over
    // IPC is always a concrete answer. A pinned set stays put while the user
    // moves around the app, which is the whole point of pinning it.
    const target = useMemo(() => toWire(scope, activeSessionId), [scope, activeSessionId]);

    // Which sign-ins the menu offers, and which one a conversation that has
    // not picked runs on, are this tab's agent's, not the selected agent's.
    // Picking an account only the selected agent had ticked used to pin a
    // conversation that main then ran on its own agent's account regardless.
    const accountSettings = useMemo(() => {
        if (!settings) return settings;
        const own = agentSettings && (!agentId || agentSettings.agentId === agentId) ? agentSettings : null;
        return own ? { ...settings, accounts: own.accounts, menuAccounts: own.menuAccounts } : settings;
    }, [settings, agentSettings, agentId]);

    // A new conversation starts on the model the chip was last left on.
    const modelAgent = agentId || settings?.agentId || '';
    const startPin = useMemo(() => lastModel(modelAgent, accountSettings), [modelAgent, accountSettings]);

    const assistant = useAssistant({ ...target, agentId, conversationId, onConversationChange, startPin });

    /**
     * What the tab strip says about this tab: what it is about, and whether it
     * is working. The runtime's name for the chat once it has one, as in the
     * history list; until then the first thing the user said, and a message
     * that was only a picture or a spec is named by that.
     */
    const first = assistant.items.find(item => item.kind === 'user');
    const title = String(
        assistant.title
        || first?.text
        || first?.mentions?.[0]?.name
        || (first?.images?.length ? t('assistant.image') : '')
        || (first?.files?.length ? first.files[0].name : ''),
    ).replace(/\s+/g, ' ').trim().slice(0, 60);

    useEffect(() => {
        onStatus?.(tabId, { title, busy: assistant.busy });
    }, [onStatus, tabId, title, assistant.busy]);

    // The model, the effort and the approval mode are all shown in the
    // composer, so the panel holds the settings rather than one field of them.
    // The settings page is still where they are explained.
    useEffect(() => {
        window.api.ai.status(agentId)
            .then((status) => {
                setSettings(status?.settings || null);
                setAgentSettings(status?.agentSettings || null);
                setCatalogs(status?.catalogs || {});
                setImageProviders(status?.imageProviders || []);
                setAgentProviders(status?.agentProviders || {});
            })
            .catch(() => {});
    }, [agentId]);

    /**
     * Which agents are switched on, as one array that keeps its identity.
     *
     * Rebuilt from a string rather than read straight off the settings,
     * because main sends a fresh object every time anything at all changes and
     * a new array each render would put the read below into a loop.
     */
    const activeKey = settings ? (settings.providers || [settings.provider]).join(' ') : '';
    const providers = useMemo(() => (activeKey ? activeKey.split(' ') : []), [activeKey]);

    // Asked for rather than waited for: reading one means bringing that agent's
    // runtime up, and a chip that fills itself in only after the first message
    // is a chip nobody can use to choose the first message. Every switched-on
    // agent is asked, since the menu offers all of them together; main holds
    // each answer, so this costs one start per agent per run of the app.
    const readModels = useCallback((wanted, { refresh = false } = {}) => {
        const asking = (wanted || []).filter(Boolean);
        if (asking.length === 0) return;

        setReadingModels(true);
        Promise.all(asking.map(provider => window.api.ai.models({ provider, refresh })
            .then(rows => [provider, rows || null])
            .catch(() => [provider, null])))
            .then((answers) => {
                setCatalogs(held => ({ ...held, ...Object.fromEntries(answers) }));
            })
            .finally(() => setReadingModels(false));
    }, []);

    useEffect(() => {
        readModels(providers);
    }, [providers, readModels]);

    // A retry aimed at the agents that came back with nothing, so opening
    // the menu heals a cold-start miss on its own instead of respawning
    // every runtime that already answered. Main answers a recent miss at
    // once rather than starting its runtime again, which keeps this cheap.
    const refreshModels = useCallback((only) => {
        const missing = Array.isArray(only) && only.length > 0 ? only : providers;
        readModels(missing, { refresh: true });
    }, [providers, readModels]);

    // Main announces a catalog whenever one is read or the agent changes. It
    // carries the agent it belongs to, so it is filed under that agent rather
    // than replacing what is held, and nothing here has to reason about what
    // arrived when.
    useEffect(() => window.api.ai.onModels(({ provider, models }) => {
        if (!provider) return;
        setCatalogs(held => ({ ...held, [provider]: models || null }));
    }), []);

    // Quick prompts are written on the settings page, which is open beside this
    // panel rather than instead of it, so the panel is told when they change.
    // The provider map rides separately from the settings object, so it is
    // re-read with it: switching an agent's runtime on the settings page
    // moves its tabs' attach gate at once rather than on the next reload.
    useEffect(() => window.api.ai.onSettings((next) => {
        setSettings(next);
        // Re-read for this tab's agent too: ticking an account for the menu
        // may have been a change to it.
        window.api.ai.status(agentId)
            .then((status) => {
                setAgentSettings(status?.agentSettings || null);
                setImageProviders(status?.imageProviders || []);
                setAgentProviders(status?.agentProviders || {});
            })
            .catch(() => {});
    }), [agentId]);

    const changeSettings = useCallback(async (patch) => {
        const next = await window.api.ai.setSettings(patch);
        setSettings(next);
    }, []);

    // The model belongs to the conversation. A new one starts on the model
    // the chip was last left on, or the agent's default before it ever was;
    // from then on it is pinned to what was picked, and coming back to it
    // finds that model still there. A task or a job that starts one on a
    // named model pins it the same way. The chip shows what is answering
    // here, and never moves the agent's settings.
    const pinned = assistant.pinned;
    const shownSettings = useMemo(
        () => (accountSettings && pinned ? { ...accountSettings, ...pinned } : accountSettings),
        [accountSettings, pinned],
    );
    const pinModel = assistant.pinModel;
    const changeModel = useCallback((patch) => {
        rememberModel(modelAgent, accountSettings, { ...shownSettings, ...patch });
        return pinModel(patch);
    }, [modelAgent, accountSettings, shownSettings, pinModel]);

    // The effort dial wears this chat's project colour. White and black have
    // no hue to wear, so they get slate; everything else wears its `from`.
    const sliderAccent = useMemo(
        () => agentColor(agentLook?.color)?.from || '#64748B',
        [agentLook],
    );

    // `preventScroll` because the card is mounted at its full width inside a
    // column that is still only a rail wide, and clipped to it. Focusing the
    // composer without it makes the browser scroll the clip box sideways to
    // bring the field into view, and the panel arrives already shoved off its
    // own left edge.
    //
    // On arrival, and again each time this tab comes to the front: a tab
    // brought forward is one about to be typed into.
    useEffect(() => {
        if (active) inputRef.current?.focus({ preventScroll: true });
    }, [active]);

    /**
     * Follow the bottom, unless the user has scrolled up to read something.
     * Yanking the view back down while they are reading output from three tool
     * calls ago is what makes a streaming panel unusable.
     *
     * Read from which way the view moved, not only from where it ended up.
     * A wheel scroll is animated in small steps, and while a reply streams
     * the bottom is re-pinned every frame; judged on distance alone, each
     * step is still "near the bottom", gets snapped back, and the user can
     * never get away from it. So any move up lets go at once, and only
     * coming back down to the bottom takes hold again.
     */
    const lastTop = useRef(0);
    const onScroll = useCallback(() => {
        const node = scrollRef.current;
        if (!node) return;
        const top = node.scrollTop;
        const gap = node.scrollHeight - top - node.clientHeight;
        // Content shrinking under a pinned view also lowers scrollTop, but
        // leaves it on the bottom: that is not the user leaving.
        if (top < lastTop.current - 1 && gap > 1) stickToBottom.current = false;
        else if (gap < 60) stickToBottom.current = true;
        lastTop.current = top;
    }, []);

    // The wheel and the keys say where the user is going before the view
    // has moved at all, so a frame of streaming in between cannot undo it.
    const onWheel = useCallback((event) => {
        if (event.deltaY < 0) stickToBottom.current = false;
    }, []);
    const onScrollKey = useCallback((event) => {
        if (['PageUp', 'ArrowUp', 'Home'].includes(event.key)) stickToBottom.current = false;
    }, []);

    // Find going to a match says the same, before it moves the view; see
    // ConversationFind. Coming back down to the bottom takes hold again, as
    // it does after a wheel.
    useEffect(() => {
        const node = scrollRef.current;
        if (!node) return undefined;
        const hold = () => { stickToBottom.current = false; };
        node.addEventListener(TRANSCRIPT_HOLD, hold);
        return () => node.removeEventListener(TRANSCRIPT_HOLD, hold);
    }, []);

    const keepAtBottom = useCallback(() => {
        const node = scrollRef.current;
        if (!node || !stickToBottom.current) return;
        node.scrollTop = node.scrollHeight;
        lastTop.current = node.scrollTop;
    }, []);

    const draftQuiet = useQuiet(assistant.draft.text);

    // `busy` too: the row under a turn arrives when it ends, not with an item.
    // And the draft falling quiet, which is when the working line reappears.
    useLayoutEffect(() => {
        keepAtBottom();
    }, [assistant.items, assistant.draft.text, assistant.busy, draftQuiet, keepAtBottom]);

    /**
     * Whether the agent answering can be sent a picture. Per tab, not per
     * window: the pin on an open conversation wins, then a remembered pick
     * for a new one, then the tab's own agent. The selected agent's runtime
     * is only the fallback, for before any of those is known.
     */
    const tabProvider = pinned?.provider
        || (!assistant.conversationId && startPin?.provider)
        || (agentId && agentProviders[agentId])
        || settings?.provider;
    const canAttach = Boolean(tabProvider && imageProviders.includes(tabProvider));

    const clearComposer = useCallback(() => {
        setText('');
        setImages([]);
        setImageNotice('');
        setFiles([]);
        setFileNotice('');
        setMentions([]);
        setMention(null);
        setSlash(null);
        stickToBottom.current = true;
        if (inputRef.current) inputRef.current.style.height = 'auto';
    }, []);

    const submit = useCallback(() => {
        const body = text.trim();
        if ((!body && images.length === 0 && files.length === 0 && mentions.length === 0) || dictating) return;
        const payload = {
            text: body,
            images: images.map(({ name, mediaType, data }) => ({ name, mediaType, data })),
            files: files.map(({ name, mediaType, text: content }) => ({ name, mediaType, text: content })),
            mentions: mentions.map(({ kind, id, name }) => ({ kind, id, name })),
        };
        // Into a running turn the message waits its turn rather than
        // joining it: it sits above the composer until the turn ends.
        if (assistant.busy) {
            const id = assistant.conversationId;
            if (!id) return;
            clearComposer();
            setQueues(current => ({
                ...current,
                [id]: [...(current[id] || []), { ...payload, id: `${Date.now()}-${(current[id] || []).length}` }],
            }));
            return;
        }
        // Not halfway through a sentence: stop the microphone first.
        clearComposer();
        assistant.send(
            payload.text,
            payload.images,
            payload.mentions.map(({ kind, id }) => ({ kind, id })),
            payload.files,
        );
    }, [text, images, files, mentions, assistant, dictating, clearComposer]);

    const queue = (assistant.conversationId && queues[assistant.conversationId]) || [];

    // The queue drains itself: a steered row first, then in order, each
    // sent once the conversation goes quiet. A send that fails goes back
    // to the head rather than vanishing; main already says why.
    useEffect(() => {
        const cid = assistant.conversationId;
        if (!cid || assistant.busy || assistant.starting || sendingRef.current) return;
        const steered = steerRef.current;
        const next = steered || queue[0];
        if (!next) return;
        if (steered) steerRef.current = null;
        else {
            setQueues(current => ({ ...current, [cid]: (current[cid] || []).slice(1) }));
        }
        sendingRef.current = true;
        assistant.send(
            next.text,
            next.images,
            (next.mentions || []).map(({ kind, id }) => ({ kind, id })),
            next.files || [],
        ).then(
            () => { sendingRef.current = false; },
            () => {
                setQueues(current => ({ ...current, [cid]: [next, ...(current[cid] || [])] }));
                sendingRef.current = false;
            },
        );
    }, [assistant, queue]);

    const removeQueued = useCallback((id) => {
        const cid = assistant.conversationId;
        if (!cid) return;
        setQueues(current => ({ ...current, [cid]: (current[cid] || []).filter(entry => entry.id !== id) }));
    }, [assistant.conversationId]);

    const editQueued = useCallback((id) => {
        const cid = assistant.conversationId;
        const entry = ((cid && queues[cid]) || []).find(row => row.id === id);
        if (!entry) return;
        removeQueued(id);
        setText(entry.text || '');
        setImages((entry.images || []).map((image, index) => ({
            ...image,
            id: `q-${Date.now()}-${index}`,
            dataUrl: `data:${image.mediaType};base64,${image.data}`,
        })));
        setFiles((entry.files || []).map((file, index) => ({
            ...file,
            id: `q-${Date.now()}-f-${index}`,
        })));
        setMentions(entry.mentions || []);
        requestAnimationFrame(() => inputRef.current?.focus());
    }, [assistant.conversationId, queues, removeQueued]);

    // Steer: the row jumps the queue and the running turn stops for it.
    // The drain above sends it the moment the stop lands; already quiet
    // and it just goes.
    const steerQueued = useCallback((id) => {
        const cid = assistant.conversationId;
        const entry = ((cid && queues[cid]) || []).find(row => row.id === id);
        if (!entry) return;
        removeQueued(id);
        steerRef.current = entry;
        if (assistant.busy) assistant.interrupt();
    }, [assistant, queues, removeQueued]);

    /**
     * What is being tagged, if anything: an `@` at the caret, at the start of
     * a word, with what has been typed since. Read on every change rather than
     * held as a mode, so clicking elsewhere in the line, or backspacing over
     * the `@`, closes the picker without anything having to notice.
     */
    const readMention = useCallback((value, caret) => {
        const found = /(?:^|\s)@([^\s@]{0,60})$/.exec(value.slice(0, caret));
        if (!found) return null;
        return { query: found[1], start: caret - found[1].length - 1 };
    }, []);

    /**
     * The command token being typed, if any: a `/` as the very first
     * character of the message with the caret still on that line. Read on
     * every change rather than held as a mode, so backspacing over the `/`
     * or moving off the line closes the picker without anything noticing.
     */
    const readSlash = useCallback((value, caret) => {
        if (!value.startsWith('/')) return null;
        const before = value.slice(0, caret);
        if (before.includes('\n')) return null;
        const found = /^\/([A-Za-z0-9_-]{0,60})/.exec(before);
        if (!found) return null;
        return { query: found[1] };
    }, []);

    const onText = useCallback((event) => {
        const { value, selectionStart } = event.target;
        setText(value);
        const slashed = readSlash(value, selectionStart);
        setSlash(slashed);
        setSlashRow(0);
        if (slashed) {
            setMention(null);
            return;
        }
        const next = readMention(value, selectionStart);
        setMention(next);
        setActiveRow(0);
    }, [readMention, readSlash]);

    /**
     * Take the highlighted row: the `@query` in the text becomes the thing's
     * name, and the thing itself is held as a chip. The caret lands after the
     * name so the sentence can carry on being written.
     */
    const pickMention = useCallback((item) => {
        if (!mention) return;
        const caret = mention.start + 1 + mention.query.length;
        const inserted = `@${item.name} `;
        const next = text.slice(0, mention.start) + inserted + text.slice(caret);

        setText(next);
        setMentions(current => (
            current.some(entry => entry.kind === item.kind && entry.id === item.id)
                ? current
                : [...current, { kind: item.kind, id: item.id, name: item.name }]
        ));
        setMention(null);

        const at = mention.start + inserted.length;
        requestAnimationFrame(() => {
            const node = inputRef.current;
            if (!node) return;
            node.focus({ preventScroll: true });
            node.setSelectionRange(at, at);
        });
    }, [mention, text]);

    /**
     * Take the highlighted skill: the `/command` token leaves the text and
     * the skill itself is held as a chip, with any arguments already typed
     * kept in the field. The caret lands at the start so the request can be
     * finished in front of what was already written.
     */
    const pickSlash = useCallback((skill) => {
        if (!slash) return;
        const token = /^\/[A-Za-z0-9_-]*/.exec(text)?.[0] || `/${slash.query}`;
        const rest = text.slice(token.length);
        const next = rest.startsWith(' ') ? rest.slice(1) : rest;

        setText(next);
        setMentions(current => (
            current.some(entry => entry.kind === 'skill' && entry.id === skill.id)
                ? current
                : [...current, { kind: 'skill', id: skill.id, name: skill.name || skill.id }]
        ));
        setSlash(null);

        requestAnimationFrame(() => {
            const node = inputRef.current;
            if (!node) return;
            node.focus({ preventScroll: true });
            node.setSelectionRange(0, 0);
            node.style.height = 'auto';
            node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
        });
    }, [slash, text]);

    /** The `/` button: the same thing typing one does, for a pointer. */
    const openSlash = useCallback(() => {
        const node = inputRef.current;
        if (!node) return;
        const next = text.startsWith('/') ? text : `/${text}`;
        setText(next);
        const caret = node.selectionStart ?? next.length;
        setSlash(readSlash(next, Math.max(caret, 1)));
        setSlashRow(0);
        setMention(null);
        requestAnimationFrame(() => {
            node.focus({ preventScroll: true });
            const at = next.startsWith('/') ? Math.max(caret, 1) : caret + 1;
            try {
                node.setSelectionRange(at, at);
            } catch {
                // The field is laid out; the caret follows on the next frame.
            }
        });
    }, [text, readSlash]);

    /** The `@` button: the same thing typing one does, for a pointer. */
    const openMentions = useCallback(() => {
        const node = inputRef.current;
        if (!node) return;
        const caret = node.selectionStart ?? text.length;
        const spaced = caret > 0 && !/\s$/.test(text.slice(0, caret)) ? ' ' : '';
        const next = `${text.slice(0, caret)}${spaced}@${text.slice(caret)}`;
        const at = caret + spaced.length + 1;

        setText(next);
        setMention({ query: '', start: at - 1 });
        setActiveRow(0);
        requestAnimationFrame(() => {
            node.focus({ preventScroll: true });
            node.setSelectionRange(at, at);
        });
    }, [text]);

    /**
     * Take in image files, however they arrived. One at a time, so a handful
     * of screenshots land in the order they were given; a file that cannot be
     * used says so under the thumbnails rather than vanishing.
     */
    const addImageFiles = useCallback(async (picked) => {
        if (!canAttach) {
            setImageNotice(t('assistant.imageUnsupported'));
            return;
        }
        for (const file of picked) {
            try {
                const image = await readImage(file);
                setImages(current => [...current, { id: `${Date.now()}-${current.length}`, ...image }]);
            } catch {
                setImageNotice(t('assistant.imageDropped', { name: file.name || 'image' }));
            }
        }
        inputRef.current?.focus({ preventScroll: true });
    }, [canAttach, t]);

    /**
     * Take in documents: text, Office files, PDFs. These travel as words,
     * so every agent takes them, whichever runtime is answering.
     */
    const addAttachedFiles = useCallback(async (picked) => {
        for (const file of picked) {
            try {
                const attached = await readTextFile(file);
                setFiles(current => [...current, { id: `${Date.now()}-f-${current.length}`, ...attached }]);
            } catch {
                setFileNotice(t('assistant.fileDropped', { name: file.name || 'file' }));
            }
        }
        inputRef.current?.focus({ preventScroll: true });
    }, [t]);

    /**
     * Whatever was dropped or picked, each file down its own road: pictures
     * as pictures, text as text, anything else named under the composer.
     */
    const addDropped = useCallback(async (picked) => {
        const list = Array.from(picked || []);
        if (list.length === 0) return;
        const pictures = list.filter(file => IMAGE_TYPES.includes(file.type));
        const rest = list.filter(file => !IMAGE_TYPES.includes(file.type));
        if (pictures.length > 0) await addImageFiles(pictures);
        const words = rest.filter(isAttachableFile);
        if (words.length > 0) await addAttachedFiles(words);
        const refused = rest.filter(file => !isAttachableFile(file));
        if (refused.length > 0 && words.length === 0 && pictures.length === 0) {
            setFileNotice(t('assistant.fileDropped', { name: refused[0].name || 'file' }));
        }
    }, [addImageFiles, addAttachedFiles, t]);

    const removeImage = useCallback((id) => {
        setImages(current => current.filter(image => image.id !== id));
    }, []);

    const removeFile = useCallback((id) => {
        setFiles(current => current.filter(file => file.id !== id));
    }, []);

    // Ctrl+V with a picture on the clipboard, which is how a screenshot
    // arrives nine times out of ten. A text paste is left to the textarea.
    const onPaste = (event) => {
        const pasted = imageFiles(event.clipboardData);
        if (!pasted.length || !canAttach) return;
        event.preventDefault();
        addImageFiles(pasted);
    };

    const onDrop = (event) => {
        dragDepth.current = 0;
        setDragging(false);
        const dropped = Array.from(event.dataTransfer?.files || []);
        if (!dropped.length) return;
        event.preventDefault();
        addDropped(dropped);
    };

    const onDragOver = (event) => {
        if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
    };

    const onDragEnter = (event) => {
        if (!event.dataTransfer?.types?.includes('Files')) return;
        dragDepth.current += 1;
        setDragging(true);
    };

    const onDragLeave = () => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
    };

    const onKeyDown = (event) => {
        // Nothing is sent halfway through a sentence.
        if (dictating && event.key === 'Enter') {
            event.preventDefault();
            return;
        }
        // The pickers are driven from here so the caret never leaves the
        // field. The `/` picker wins while it is open; `@` waits beneath it.
        if (slash && slashMatches.length > 0) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setSlashRow(current => (current + step + slashMatches.length) % slashMatches.length);
                return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                pickSlash(slashMatches[slashRow] || slashMatches[0]);
                return;
            }
        }
        if (slash && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setSlash(null);
            return;
        }
        // The picker is driven from here so the caret never leaves the field.
        if (mention && matches.length > 0) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setActiveRow(current => (current + step + matches.length) % matches.length);
                return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                pickMention(matches[activeRow] || matches[0]);
                return;
            }
        }
        if (mention && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setMention(null);
            return;
        }

        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
        }
    };

    /** What the tab is actually pointed at, for the placeholder. */
    const described = useMemo(
        () => describe(scope, { sessions, hosts, activeSessionId }),
        [scope, sessions, hosts, activeSessionId],
    );

    const empty = assistant.items.length === 0 && !assistant.starting && !assistant.failure;
    const quickPrompts = settings?.quickPrompts || [];

    /**
     * The questions waiting on an answer, folded so that one command sent to
     * several servers is one card. See `lib/approvals`. These are drawn in the
     * dock above the composer rather than in the transcript, so the transcript
     * skips them where they would otherwise fall.
     */
    const asking = useMemo(() => groupApprovals(assistant.items), [assistant.items]);
    // The agent's own questions, open. Kept apart from the approvals: they
    // are not folded, and they carry no server.
    const questions = useMemo(
        () => assistant.items.filter(item => item.kind === 'question' && item.status === 'pending'),
        [assistant.items],
    );

    const { branchTurn } = assistant;
    const branchFrom = useCallback(async (turnId) => {
        const answer = await branchTurn(turnId);
        if (answer?.conversationId) onOpenConversation?.(answer.conversationId, answer.agentId);
    }, [branchTurn, onOpenConversation]);

    return (
        <>
            {/* No header of its own: the tab strip above is the one row of
                chrome, and which servers this tab is about is a chip on the
                composer, beside the other things that shape the next
                message. History and closing live in the strip's menu. */}

            {/* Transcript. One spacing step, owned here, not by the items.

                A flex column's gap rather than `space-y-3`. That utility is a
                sibling selector, `> :not([hidden]) ~ :not([hidden])`, which
                the browser cannot narrow: every row, draft or "working" line
                put into the column restyled everything already in it, which
                in a long conversation was six thousand elements a time. A gap
                is no selector at all.

                `assistant-prose` opts the whole column back into text
                selection, which the shell turns off everywhere else, and
                repaints the highlight in the app's own colours. See the note
                on it in input.css. The controls inside opt back out
                individually: dragging across a transcript should pick up the
                reply, not the label on the button next to it. */}
            <div
                ref={scrollRef}
                data-transcript=""
                onScroll={onScroll}
                onWheel={onWheel}
                onKeyDown={onScrollKey}
                className={`assistant-prose flex-1 min-h-0 overflow-y-auto px-3 flex flex-col gap-3
                    ${empty ? '' : 'py-3'}`}
            >
                {assistant.failure && <Notice item={{ tone: 'error', text: assistant.failure }} />}

                {/* Centred on the panel, but by growing a full-height block
                    rather than by centring inside the scroller. The latter
                    puts the top of anything taller than the panel out of
                    reach: overflow spills both ways and only one of them
                    can be scrolled back to.

                    Capped and centred horizontally. The composer is a field
                    and should take whatever width it is given, but this is
                    prose and a row of buttons: dragged out to 720px the
                    sentence turns into one long line and the prompts become
                    strips of mostly empty background. The measure stays put
                    and the extra width goes to the margins. */}
                {empty && (
                    <div className="min-h-full w-full max-w-sm mx-auto py-6 px-1
                        flex flex-col justify-center">
                        <div className="flex flex-col items-center text-center">
                            {/* No tile behind it. The mark brings its own
                                colour, and a grey square around a logo is
                                a frame around a frame. */}
                            <AgentMark size={80} animated look={agentLook} className="mb-3" />
                            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
                                {line.text}
                            </h2>
                            <p className="mt-1 text-[11px] italic text-gray-400 dark:text-gray-600">
                                {line.latin} · Aeneid {line.book}
                            </p>
                            <p className="mt-3 text-xs leading-relaxed text-gray-500 dark:text-gray-500">
                                {t('assistant.welcomeNote')}
                            </p>
                        </div>

                        {/* Nothing canned. Until someone has written their
                            own, this is an offer to write one rather than
                            four guesses about what they might want to ask.

                            Held back until the settings have actually
                            loaded, or someone who has prompts saved sees
                            the invitation to create them flash past
                            first. */}
                        <div className={`mt-6 space-y-1.5 ${settings ? '' : 'invisible'}`}>
                            {quickPrompts.length > 0 ? quickPrompts.map(prompt => (
                                <button
                                    key={prompt}
                                    type="button"
                                    className="w-full min-h-9 px-3 py-2 rounded-lg text-xs text-left
                                        select-none transition-colors
                                        text-gray-600 dark:text-gray-400
                                        bg-gray-50 dark:bg-white/[0.035]
                                        hover:bg-gray-100 dark:hover:bg-white/[0.06]
                                        hover:text-gray-900 dark:hover:text-gray-200"
                                    onClick={() => { setText(prompt); inputRef.current?.focus(); }}
                                >
                                    {prompt}
                                </button>
                            )) : (
                                <button
                                    type="button"
                                    onClick={() => onOpenSettings?.('quickPrompts')}
                                    className="w-full h-12 px-3 rounded-xl flex items-center
                                        justify-center gap-1.5 text-xs font-medium
                                        select-none transition-colors
                                        border border-dashed
                                        border-gray-300 dark:border-white/[0.14]
                                        text-gray-500 dark:text-gray-500
                                        hover:border-gray-400 dark:hover:border-white/25
                                        hover:bg-gray-50 dark:hover:bg-white/[0.03]
                                        hover:text-gray-700 dark:hover:text-gray-300"
                                >
                                    <PlusSignIcon size={13} strokeWidth={2} />
                                    {t('assistant.createQuickPrompts')}
                                </button>
                            )}
                        </div>
                    </div>
                )}

                <Transcript
                    key={assistant.conversationId || 'new'}
                    items={assistant.items}
                    busy={assistant.busy}
                    turnRates={assistant.turnRates}
                    conversationId={assistant.conversationId}
                    onRespond={assistant.respond}
                    onAnswer={assistant.answer}
                    onRevert={assistant.revertTurn}
                    onBranch={onOpenConversation && !assistant.subagent ? branchFrom : null}
                    onOpenConversation={onOpenConversation}
                    onLayout={keepAtBottom}
                    groupTools={settings ? settings.groupToolCalls !== false : true}
                />

                {/* The turn in progress. Replaced by a finished block the
                    moment the model closes it, so both are never shown. */}
                {assistant.busy && assistant.draft.thinking && !assistant.draft.text && (
                    <Thought item={{ text: '', thinking: assistant.draft.thinking }} live />
                )}
                {assistant.draft.text && (
                    <StreamingText text={assistant.draft.text} onReveal={keepAtBottom} active={active} />
                )}

                {/* Not while a question is standing: the turn is still open, so
                    `busy` is true, but nothing is happening and the thing to
                    look at is the card below. Not while words are arriving
                    either, since they say it well enough, but back as soon as
                    they stop and the turn has not. */}
                {assistant.busy && (!assistant.draft.text || draftQuiet)
                    && asking.length === 0 && questions.length === 0 && (
                    <WorkingIndicator items={assistant.items} />
                )}
            </div>

            {/* The questions, pinned.
                Out of the transcript and held against the composer, because a
                card in the flow moves: the model goes on writing underneath it,
                a tool row lands, the scroller follows the bottom, and Allow
                arrives where Decline was half a second ago. These two buttons
                are 6px apart and one of them runs something on a server, so the
                card does not get to move while it is being read.

                Above the composer rather than below it: the composer is the one
                thing on the panel whose position people learn, and a card that
                pushes it down the moment a question arrives moves the target
                they are already typing at.

                Its own scroller, with a hairline above it that says the
                transcript ends there. Several questions can stand at once, and
                the panel is not allowed to lose its reply and its composer to a
                stack of them. */}
            {(asking.length > 0 || questions.length > 0) && (
                <div className={`shrink-0 max-h-[55%] overflow-y-auto px-3 pt-3 pb-1 space-y-2
                    border-t ${HAIRLINE}`}>
                    {asking.map(group => (
                        <ApprovalRequest
                            key={group.key}
                            group={group}
                            sessions={sessions}
                            onRespond={assistant.respond}
                        />
                    ))}
                    {questions.map(item => (
                        <QuestionRequest key={item.id} item={item} onAnswer={assistant.answer} />
                    ))}
                </div>
            )}

            {/* Composer.
                The input takes the whole width and its controls sit on a
                row underneath, rather than crowding into the line being
                typed on. That is what lets the model chip carry a real
                label instead of an icon, and it keeps a long question from
                squeezing the buttons.

                No rule above it, and no surface of its own: the outline is
                what says "type here", and a divider as well would cut the
                card in two for no gain. Transparent rather than a colour
                matching the card, because the card is translucent and
                painting the same wash twice makes a pale rectangle of the
                one part of the panel that should sit flat.

                Focus lifts the border's colour and nothing else, as every
                other input in the app does. A ring would add two pixels
                outside the box and nudge the whole composer as you click
                into it.

                A subagent's transcript has none: it is the parent's
                conversation that talks to it. The bar says so in the
                composer's place and goes back to the parent. */}
            {assistant.subagent ? (
                <div className="shrink-0 p-3">
                    <div className="min-h-[3rem] rounded-2xl px-4 py-2 flex items-center gap-3
                        bg-gray-50 dark:bg-white/[0.035]">
                        <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-gray-500 dark:text-gray-400">
                            {t('assistant.subagentReadOnly')}
                        </span>
                        {onOpenConversation && (
                            <button
                                type="button"
                                onClick={() => onOpenConversation(assistant.subagent.parentId)}
                                title={assistant.subagent.parentTitle || undefined}
                                className="shrink-0 max-w-[50%] h-7 px-2.5 flex items-center gap-1 rounded-lg select-none
                                    text-[11px] font-medium transition-colors
                                    text-gray-600 dark:text-gray-300
                                    hover:bg-gray-100 dark:hover:bg-white/[0.06]
                                    hover:text-gray-900 dark:hover:text-gray-100"
                            >
                                <span className="truncate">
                                    {assistant.subagent.parentTitle
                                        ? t('assistant.subagentParent', { title: assistant.subagent.parentTitle })
                                        : t('assistant.subagentParentUntitled')}
                                </span>
                                <ArrowUpRight01Icon size={12} strokeWidth={2} className="shrink-0" />
                            </button>
                        )}
                    </div>
                </div>
            ) : (
            <div className="shrink-0 p-3">
                <MessageQueue
                    queue={queue}
                    onSteer={steerQueued}
                    onEdit={editQueued}
                    onRemove={removeQueued}
                />
                <div
                    className="relative rounded-2xl transition-colors
                        border border-gray-300 dark:border-surface-control
                        focus-within:border-gray-400 dark:focus-within:border-neutral-600"
                    onDrop={onDrop}
                    onDragOver={onDragOver}
                    onDragEnter={onDragEnter}
                    onDragLeave={onDragLeave}
                >
                    {/* The drop zone: while a file hovers, the composer
                        empties behind an opaque cover with the attach mark
                        in the middle. Transparent to the pointer, so the
                        drop and the leave still land on this box. */}
                    {dragging && (
                        <div
                            aria-hidden="true"
                            className="absolute inset-0 z-10 pointer-events-none
                                flex items-center justify-center rounded-2xl
                                border-2 border-dashed border-gray-400 dark:border-white/40
                                bg-white dark:bg-surface-raised"
                        >
                            <span className="w-11 h-11 flex items-center justify-center rounded-full
                                bg-gray-100 dark:bg-surface-control
                                text-gray-600 dark:text-gray-200">
                                <Attachment01Icon size={20} strokeWidth={2} className="animate-bounce" />
                            </span>
                        </div>
                    )}
                    {/* What `/` opened, over the composer rather than in it. */}
                    {slash && (
                        <SlashPicker
                            items={slashMatches}
                            query={slash.query}
                            active={slashRow}
                            onPick={pickSlash}
                            onHover={setSlashRow}
                        />
                    )}
                    {/* What `@` opened, over the composer rather than in it. */}
                    {mention && !slash && (
                        <MentionPicker
                            items={matches}
                            query={mention.query}
                            active={activeRow}
                            onPick={pickMention}
                            onHover={setActiveRow}
                        />
                    )}

                    {/* What the message tags, as chips. Each can be taken back
                        until it is sent; the words in the field are the user's
                        own and are left alone. */}
                    {mentions.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
                            {mentions.map(entry => (
                                <span
                                    key={`${entry.kind}:${entry.id}`}
                                    className="inline-flex items-center gap-1 pl-2 pr-1 h-6 rounded-md
                                        text-xs font-medium select-none
                                        bg-gray-100 dark:bg-surface-control
                                        text-gray-700 dark:text-gray-200"
                                >
                                    <MentionIcon item={entry} size={12} />
                                    <span className="max-w-[12rem] truncate">{entry.kind === 'skill' ? `/${entry.name}` : entry.name}</span>
                                    <button
                                        type="button"
                                        aria-label={t('mentions.remove', { name: entry.name })}
                                        onClick={() => dropMention(entry.kind, entry.id)}
                                        className="w-4 h-4 flex items-center justify-center rounded
                                            text-gray-500 dark:text-gray-400
                                            hover:text-gray-900 dark:hover:text-white
                                            hover:bg-black/[0.06] dark:hover:bg-white/10 transition-colors"
                                    >
                                        <Cancel01Icon size={10} strokeWidth={2.5} />
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}

                    {/* What is going with the message, above the words about
                        it. Each thumbnail can be taken back until it is sent. */}
                    {images.length > 0 && (
                        <div className="flex flex-wrap gap-2 px-3 pt-2.5">
                            {images.map(image => (
                                <div key={image.id} className="relative group">
                                    <img
                                        src={image.dataUrl}
                                        alt={image.name}
                                        className="h-14 w-14 rounded-lg object-cover
                                            border border-gray-200 dark:border-surface-control"
                                    />
                                    <button
                                        type="button"
                                        aria-label={t('assistant.removeImage')}
                                        onClick={() => removeImage(image.id)}
                                        className="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center
                                            rounded-full shadow transition-opacity
                                            bg-gray-900 dark:bg-white text-white dark:text-black
                                            opacity-0 group-hover:opacity-100 focus:opacity-100"
                                    >
                                        <Cancel01Icon size={10} strokeWidth={2.5} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                    {imageNotice && (
                        <div className="px-3 pt-2 text-xs text-amber-600 dark:text-amber-400">
                            {imageNotice}
                        </div>
                    )}
                    {/* What is going with the message as words: code, logs,
                        docs. Each chip can be taken back until it is sent. */}
                    {files.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
                            {files.map(file => (
                                <span
                                    key={file.id}
                                    className="inline-flex items-center gap-1 pl-2 pr-1 h-6 rounded-md
                                        text-xs font-medium select-none
                                        bg-gray-100 dark:bg-surface-control
                                        text-gray-700 dark:text-gray-200"
                                >
                                    <span className="max-w-[12rem] truncate">{file.name}</span>
                                    <button
                                        type="button"
                                        aria-label={t('assistant.removeFile', { name: file.name })}
                                        onClick={() => removeFile(file.id)}
                                        className="w-4 h-4 flex items-center justify-center rounded
                                            text-gray-500 dark:text-gray-400
                                            hover:text-gray-900 dark:hover:text-white
                                            hover:bg-black/[0.06] dark:hover:bg-white/10 transition-colors"
                                    >
                                        <Cancel01Icon size={10} strokeWidth={2.5} />
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}
                    {fileNotice && (
                        <div className="px-3 pt-2 text-xs text-amber-600 dark:text-amber-400">
                            {fileNotice}
                        </div>
                    )}
                    {voiceNotice && (
                        <div className="px-3 pt-2 text-xs text-amber-600 dark:text-amber-400">
                            {voiceNotice}
                        </div>
                    )}
                    <textarea
                        ref={inputRef}
                        rows={1}
                        value={text}
                        readOnly={dictating}
                        onChange={onText}
                        onKeyDown={onKeyDown}
                        onClick={(event) => {
                            const slashed = readSlash(event.target.value, event.target.selectionStart);
                            setSlash(slashed);
                            setMention(slashed ? null : readMention(event.target.value, event.target.selectionStart));
                        }}
                        onBlur={() => {
                            setMention(null);
                            setSlash(null);
                        }}
                        onPaste={onPaste}
                        placeholder={assistant.busy ? t('assistant.queuePlaceholder') : t('assistant.askAbout', { about: described.sentence })}
                        className="block w-full max-h-40 px-3 pt-2.5 pb-1 bg-transparent
                            resize-none outline-none
                            text-[13px] leading-relaxed text-gray-900 dark:text-white
                            placeholder:text-gray-400 dark:placeholder:text-gray-600"
                        onInput={(event) => {
                            event.target.style.height = 'auto';
                            event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
                        }}
                    />

                    <div className="flex items-center gap-1 pl-2 pr-2 pb-2">
                        {/* The standing state of the panel: what it will do
                            before asking, and where it is changed. */}
                        {settings && (
                            <ApprovalMenu settings={settings} onChange={changeSettings} runPolicy={assistant.runPolicy} />
                        )}

                        {/* Anything in the inventory can be named in a message.
                            The same thing typing `@` does, for a pointer. */}
                        <Tooltip label={t('skills.tag')} hint="/" placement="top">
                            <button
                                type="button"
                                aria-label={t('skills.tag')}
                                onClick={openSlash}
                                className={`w-7 h-7 shrink-0 flex items-center justify-center rounded-full
                                    text-sm font-semibold transition-colors
                                    ${slash || mentions.some(entry => entry.kind === 'skill')
                                        ? 'bg-gray-100 dark:bg-surface-control text-gray-700 dark:text-gray-200'
                                        : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-surface-control '
                                            + 'hover:text-gray-700 dark:hover:text-gray-200'}`}
                            >
                                /
                            </button>
                        </Tooltip>
                        <Tooltip label={t('mentions.tag')} hint="@" placement="top">
                            <button
                                type="button"
                                aria-label={t('mentions.tag')}
                                onClick={openMentions}
                                className={`w-7 h-7 shrink-0 flex items-center justify-center rounded-full
                                    text-sm font-semibold transition-colors
                                    ${mention || mentions.length > 0
                                        ? 'bg-gray-100 dark:bg-surface-control text-gray-700 dark:text-gray-200'
                                        : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-surface-control '
                                            + 'hover:text-gray-700 dark:hover:text-gray-200'}`}
                            >
                                @
                            </button>
                        </Tooltip>

                        {/* A file off the disk: code, logs, docs. Every agent
                            reads these, since they travel as words. */}
                        <input
                            ref={docRef}
                            type="file"
                            multiple
                            className="hidden"
                            onChange={(event) => {
                                addDropped(Array.from(event.target.files || []));
                                event.target.value = '';
                            }}
                        />
                        <Tooltip label={t('assistant.attachFile')} placement="top">
                            <button
                                type="button"
                                aria-label={t('assistant.attachFile')}
                                onClick={() => docRef.current?.click()}
                                className={`w-7 h-7 shrink-0 flex items-center justify-center
                                    rounded-full transition-colors
                                    ${files.length > 0
                                        ? 'bg-gray-100 dark:bg-surface-control text-gray-700 dark:text-gray-200'
                                        : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-surface-control '
                                            + 'hover:text-gray-700 dark:hover:text-gray-200'}`}
                            >
                                <Attachment01Icon size={15} strokeWidth={2} />
                            </button>
                        </Tooltip>

                        {/* The picker, for the agents that can read a picture.
                            Paste and drop work without it; this is for the
                            file that is not already on the clipboard. */}
                        {canAttach && (
                            <>
                                <input
                                    ref={fileRef}
                                    type="file"
                                    accept={IMAGE_TYPES.join(',')}
                                    multiple
                                    className="hidden"
                                    onChange={(event) => {
                                        addImageFiles(Array.from(event.target.files || []));
                                        event.target.value = '';
                                    }}
                                />
                                <Tooltip label={t('assistant.attachImage')} placement="top">
                                    <button
                                        type="button"
                                        aria-label={t('assistant.attachImage')}
                                        onClick={() => fileRef.current?.click()}
                                        className="w-7 h-7 shrink-0 flex items-center justify-center
                                            rounded-full transition-colors
                                            text-gray-500 dark:text-gray-400
                                            hover:bg-gray-100 dark:hover:bg-surface-control
                                            hover:text-gray-700 dark:hover:text-gray-200"
                                    >
                                        <ImageAdd01Icon size={15} strokeWidth={2} />
                                    </button>
                                </Tooltip>
                            </>
                        )}

                        <div className="ml-auto flex items-center gap-1">
                            <ContextRing
                                context={assistant.context}
                                provider={shownSettings?.provider}
                            />
                            <Usage
                                account={assistant.account}
                                rateLimit={assistant.rateLimit}
                                costUsd={assistant.costUsd}
                                hasStoredKey={Boolean(settings?.hasApiKey)}
                            />

                            {shownSettings && (
                                <ModelMenu
                                    settings={shownSettings}
                                    catalogs={catalogs}
                                    providers={providers}
                                    loading={readingModels}
                                    onRefresh={refreshModels}
                                    onChange={changeModel}
                                    accent={sliderAccent}
                                />
                            )}

                            {/* Speaking instead of typing, when switched on
                                in Settings. The words land in the box above,
                                to read over and send: as they are spoken,
                                with Parakeet. */}
                            {settings?.voiceInput && (
                                <DictationButton
                                    live={settings.voiceEngine === 'parakeet'}
                                    onText={addDictation}
                                    onNotice={setVoiceNotice}
                                />
                            )}

                            {/* Nothing to press until there is something to
                                send, so the button is absent rather than
                                disabled: a permanently greyed control is
                                just clutter with a hover state. */}
                            {(text.trim() || images.length > 0 || files.length > 0 || mentions.length > 0) && assistant.busy ? (
                                <Tooltip label={t('assistant.queue')} hint="Enter" placement="top">
                                    <button
                                        type="button"
                                        aria-label={t('assistant.queue')}
                                        onClick={submit}
                                        className="w-7 h-7 shrink-0 flex items-center justify-center
                                            rounded-full transition-all active:scale-95
                                            bg-gray-900 dark:bg-white
                                            text-white dark:text-black hover:opacity-90"
                                    >
                                        <ArrowUp01Icon size={15} strokeWidth={2.5} />
                                    </button>
                                </Tooltip>
                            ) : null}
                            {assistant.busy ? (
                                <Tooltip label={t('assistant.stop')} placement="top">
                                    <button
                                        type="button"
                                        aria-label={t('assistant.stop')}
                                        onClick={assistant.interrupt}
                                        className="w-7 h-7 shrink-0 flex items-center justify-center
                                            rounded-full transition-colors
                                            bg-gray-100 dark:bg-surface-control
                                            text-gray-600 dark:text-gray-300
                                            hover:bg-gray-200 dark:hover:bg-surface-hover"
                                    >
                                        <StopCircleIcon size={15} strokeWidth={2} />
                                    </button>
                                </Tooltip>
                            ) : (text.trim() || images.length > 0 || files.length > 0 || mentions.length > 0) ? (
                                <Tooltip label={t('assistant.send')} hint="Enter" placement="top">
                                    <button
                                        type="button"
                                        aria-label={t('assistant.send')}
                                        onClick={submit}
                                        className="w-7 h-7 shrink-0 flex items-center justify-center
                                            rounded-full transition-all active:scale-95
                                            bg-gray-900 dark:bg-white
                                            text-white dark:text-black hover:opacity-90"
                                    >
                                        <ArrowUp01Icon size={15} strokeWidth={2.5} />
                                    </button>
                                </Tooltip>
                            ) : null}
                        </div>
                    </div>
                </div>
            </div>
            )}
        </>
    );
}

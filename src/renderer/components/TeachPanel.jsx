import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
    Alert02Icon,
    Delete02Icon,
    Loading03Icon,
    PauseIcon,
    PlayIcon,
    RecordIcon,
    StopCircleIcon,
    Tick02Icon,
    ViewIcon,
} from 'hugeicons-react';
import Button from './ui/Button';
import Checkbox from './ui/Checkbox';
import { FIELD_CLASS } from './ui/Field';
import ModelMenu from './assistant/ModelMenu';
import { toastOptions } from '../lib/toast';
import { PROVIDER_NAMES, currentModelRow, mergedModelRows } from '../lib/ai-catalog';

/**
 * Teach mode, as an inventory page the person drives for one agent.
 *
 * The desktop helper records what the person does in the apps they pick; the
 * main process distils a trace into a draft knowledge pack. This page is the
 * three moments the person touches: starting a recording, watching it run, and
 * reviewing the draft to keep or drop each part. Passwords are never recorded;
 * a kept login's password is typed here and only reaches the keychain on
 * accept. Discard wipes anything typed and leaves nothing behind. See
 * ai/teach.js and docs/teach-mode.md.
 */

/** A recording's time, as the machine would read it back later. */
function formatWhen(at) {
    try {
        return new Date(at).toLocaleString();
    } catch {
        return '';
    }
}

/** A login's identity, the key the backend drops it by. */
const loginKey = (site, user) => `${site}\u0000${user}`;

/** The model picked to read recordings, kept per agent on this machine. */
const pickKey = (agentId) => `teach.reader.${agentId}`;
function loadPick(agentId) {
    try {
        const raw = JSON.parse(localStorage.getItem(pickKey(agentId)) || 'null');
        return raw && typeof raw.provider === 'string' ? raw : null;
    } catch {
        return null;
    }
}

/**
 * Which model reads a recording, as a choice on the page rather than hidden.
 *
 * The chat's own model menu, offering only the runtimes switched on for the
 * agent that can do a one-shot read (main's `readers`). Starts on the agent's
 * model; a pick is kept for the agent and sent with every read, so what the
 * chip shows is what reads.
 */
function useReader(agentId, readers) {
    const [aiSettings, setAiSettings] = useState(null);
    const [agentSettings, setAgentSettings] = useState(null);
    const [catalogs, setCatalogs] = useState({});
    const [loading, setLoading] = useState(false);
    const [pick, setPick] = useState(() => loadPick(agentId));
    // The model a new chat would start on (starred, or last used), so an
    // agent with no model of its own still names one here rather than the
    // runtime alone.
    const [startPick, setStartPick] = useState(null);

    useEffect(() => {
        setPick(loadPick(agentId));
        window.api.ai.startModel?.(agentId)
            .then(answer => setStartPick(answer?.pick || null))
            .catch(() => {});
        window.api.ai.status(agentId)
            .then((status) => {
                setAiSettings(status?.settings || null);
                setAgentSettings(status?.agentSettings || null);
                setCatalogs(status?.catalogs || {});
            })
            .catch(() => {});
    }, [agentId]);

    // The agent's own model and sign-ins, as the composer works them out.
    const base = useMemo(() => {
        if (!aiSettings) return null;
        const own = agentSettings && (!agentId || agentSettings.agentId === agentId) ? agentSettings : null;
        return own
            ? { ...aiSettings, provider: own.provider, model: own.model, effort: own.effort, accounts: own.accounts, menuAccounts: own.menuAccounts }
            : aiSettings;
    }, [aiSettings, agentSettings, agentId]);

    const key = base ? (base.providers || [base.provider]).filter(id => readers.includes(id)).join(' ') : '';
    const providers = useMemo(() => (key ? key.split(' ') : []), [key]);

    const read = useCallback((wanted, refresh = false) => {
        const asking = (wanted || []).filter(Boolean);
        if (!asking.length) return;
        setLoading(true);
        Promise.all(asking.map(provider => window.api.ai.models({ provider, refresh })
            .then(rows => [provider, rows || null])
            .catch(() => [provider, null])))
            .then(answers => setCatalogs(held => ({ ...held, ...Object.fromEntries(answers) })))
            .finally(() => setLoading(false));
    }, []);
    useEffect(() => { read(providers); }, [providers, read]);
    const refresh = useCallback((only) => read(Array.isArray(only) && only.length ? only : providers, true), [providers, read]);

    // What the chip shows and the read uses: the pick made here while its
    // runtime is still on offer, else the model a new chat starts on, else
    // the agent's own, else the first runtime that can read.
    const settings = useMemo(() => {
        if (!base || !providers.length) return null;
        if (pick && providers.includes(pick.provider)) return { ...base, ...pick };
        if (startPick?.model && providers.includes(startPick.provider)) {
            return {
                ...base,
                provider: startPick.provider,
                model: startPick.model,
                effort: startPick.effort || '',
                account: startPick.account || '',
            };
        }
        if (providers.includes(base.provider)) return base;
        return { ...base, provider: providers[0], model: '', effort: '', account: '' };
    }, [base, providers, pick, startPick]);

    const change = useCallback((patch) => {
        if (!settings) return;
        const next = { ...settings, ...patch };
        const kept = { provider: next.provider, model: next.model || '', effort: next.effort || '', account: next.account || '' };
        setPick(kept);
        try { localStorage.setItem(pickKey(agentId), JSON.stringify(kept)); } catch { /* not kept; still used */ }
    }, [settings, agentId]);

    const chosen = settings
        ? { provider: settings.provider, model: settings.model || '', effort: settings.effort || '', account: settings.account || '' }
        : null;

    /** A model's name as the menu shows it, for "Reading with" and "Read by". */
    const labelFor = useCallback((who) => {
        if (!who?.provider) return '';
        const rows = mergedModelRows(catalogs, [who.provider], { ...(base || {}), provider: who.provider, model: who.model || '' });
        const row = currentModelRow(rows, { provider: who.provider, model: who.model || '' });
        return row?.short || row?.label || who.model || PROVIDER_NAMES[who.provider] || who.provider;
    }, [catalogs, base]);

    return { settings, providers, catalogs, loading, refresh, change, chosen, labelFor };
}

function TeachPanel({ agentId = '' }) {
    // The global recorder, read from state(): one at a time, with its line
    // count and whether it is paused. Null when nothing is recording.
    const [recording, setRecording] = useState(null);
    const [pending, setPending] = useState([]);
    // The draft stop() handed back, or null when there is nothing to review.
    const [review, setReview] = useState(null);
    // The one-line outcome of the last accept or discard, shown back on idle.
    const [result, setResult] = useState(null);

    const [apps, setApps] = useState('');
    // What the person says they are about to do (before recording), and their
    // correction of what the agent thought they did (in review). Either is the
    // one thing a recording cannot show, and the draft is read in its light.
    const [task, setTask] = useState('');
    const [retellText, setRetellText] = useState('');
    // One call in flight (start, stop, accept, discard), so buttons settle.
    const [busy, setBusy] = useState(false);
    // The agent is reading a recording into a draft (after stop, or a left
    // over one opened with Review). Its own view, so a poll that sees nothing
    // recording any more cannot drop the page back to idle while it reads.
    const [reading, setReading] = useState(false);

    // Review selections. `kept` holds `section:id` keys the person unticked
    // (anything absent is kept); `loginRows` carries each login's keep box and
    // the password typed for it; `answers` the free-text replies by question.
    const [kept, setKept] = useState({});
    const [loginRows, setLoginRows] = useState([]);
    const [answers, setAnswers] = useState({});

    // The runtimes that can read a recording, from main, and the model picked.
    const [readers, setReaders] = useState([]);
    const reader = useReader(agentId, readers);

    const refresh = useCallback(async () => {
        try {
            const state = await window.api.teach?.state();
            setRecording(state?.recording || null);
            setPending(state?.pending || []);
            if (Array.isArray(state?.readers)) {
                setReaders(held => (held.join(' ') === state.readers.join(' ') ? held : state.readers));
            }
        } catch {
            // The page just shows what it last knew.
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    // While a recording runs and nothing is up for review, read the line count
    // and pause state back every couple of seconds. Not once stop is pressed:
    // the recorder is off by then, and the poll would show the idle page.
    const isRecording = Boolean(recording) && !review && !reading;
    useEffect(() => {
        if (!isRecording) return undefined;
        const timer = setInterval(refresh, 2000);
        return () => clearInterval(timer);
    }, [isRecording, refresh]);

    const openReview = useCallback((draftReview) => {
        setKept({});
        setAnswers({});
        setRetellText(draftReview?.task || '');
        setLoginRows((draftReview?.logins || []).map(entry => ({
            site: entry.site,
            user: entry.user,
            store: false,
            password: '',
        })));
        setReview(draftReview);
    }, []);

    const start = useCallback(async () => {
        if (busy || !agentId) return;
        setBusy(true);
        try {
            const list = apps.split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
            const res = await window.api.teach?.start(agentId, { apps: list, task: task.trim() });
            if (res?.ok) {
                setResult(null);
                setTask('');
                await refresh();
            } else if (res) {
                toast.error(res.error || `Could not start recording (${res.code || 'error'}).`, toastOptions());
            }
        } finally {
            setBusy(false);
        }
    }, [busy, agentId, apps, task, refresh]);

    const togglePause = useCallback(async () => {
        const res = await window.api.teach?.pause(!recording?.paused);
        if (res && typeof res.paused === 'boolean') {
            setRecording(current => (current ? { ...current, paused: res.paused } : current));
        }
        refresh();
    }, [recording, refresh]);

    // A draft from stop or review: opened, or its error shown. A recording that
    // could not be read stays under Left over for another go.
    const takeReview = useCallback((draftReview) => {
        if (draftReview && draftReview.ok !== false) {
            openReview(draftReview);
            return true;
        }
        toast.error(draftReview?.error || 'The recording could not be opened for review.', toastOptions());
        return false;
    }, [openReview]);

    const stop = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        setReading(true);
        try {
            const res = await window.api.teach?.stop(agentId, reader.chosen);
            if (res?.review) {
                setRecording(null);
                takeReview(res.review);
            } else if (res && res.ok === false) {
                toast.error(res.error || 'Could not stop the recording.', toastOptions());
            }
        } catch (error) {
            toast.error(error?.message || 'Could not stop the recording.', toastOptions());
        } finally {
            setReading(false);
            setBusy(false);
            refresh();
        }
    }, [busy, agentId, reader.chosen, takeReview, refresh]);

    // Review a left over recording: the agent reads it again (or hands back
    // the draft it already made, or joins the read still under way).
    const reviewPending = useCallback(async (id) => {
        if (busy || !agentId) return;
        setBusy(true);
        setReading(true);
        try {
            takeReview(await window.api.teach?.review(agentId, id, undefined, reader.chosen));
        } catch (error) {
            toast.error(error?.message || 'The recording could not be opened for review.', toastOptions());
        } finally {
            setReading(false);
            setBusy(false);
            refresh();
        }
    }, [busy, agentId, reader.chosen, takeReview, refresh]);

    // The draft got the job wrong: read the same recording again, with the
    // person's own words for what they were doing and the model now picked.
    // If that fails, the draft they had stays up rather than leaving them
    // with nothing.
    const readAgain = useCallback(async () => {
        if (busy || !agentId || !review) return;
        const before = review;
        setBusy(true);
        setReview(null);
        setReading(true);
        try {
            const res = await window.api.teach?.review(agentId, before.id, retellText.trim(), reader.chosen);
            if (res && res.ok !== false) {
                openReview(res);
            } else {
                setReview(before);
                toast.error(res?.error || 'The recording could not be read again.', toastOptions());
            }
        } catch (error) {
            setReview(before);
            toast.error(error?.message || 'The recording could not be read again.', toastOptions());
        } finally {
            setReading(false);
            setBusy(false);
        }
    }, [busy, agentId, review, retellText, reader.chosen, openReview]);

    /** The model menu, as the chat has it, offering the runtimes that can read. */
    const readerChip = reader.settings ? (
        <ModelMenu
            settings={reader.settings}
            catalogs={reader.catalogs}
            providers={reader.providers}
            loading={reader.loading}
            onRefresh={reader.refresh}
            onChange={reader.change}
            placement="down"
        />
    ) : (
        <span className="text-[13px] text-gray-500 dark:text-gray-400">
            None of this agent's runtimes can read a recording. Switch on Claude Code, Codex, or an OpenAI or local model.
        </span>
    );

    const key = (section, id) => `${section}:${id}`;
    const isKept = (section, id) => kept[key(section, id)] !== false;
    const toggleKeep = (section, id) => setKept(prev => ({
        ...prev,
        [key(section, id)]: !(prev[key(section, id)] !== false),
    }));

    const setLoginStore = (index, store) =>
        setLoginRows(rows => rows.map((row, i) => (i === index ? { ...row, store } : row)));
    const setLoginPassword = (index, password) =>
        setLoginRows(rows => rows.map((row, i) => (i === index ? { ...row, password } : row)));
    const setAnswer = (id, text) => setAnswers(prev => ({ ...prev, [id]: text }));

    const buildSelections = () => {
        const draft = review?.draft || {};
        const drop = {};
        const appMapDrop = (draft.appMap || []).filter(entry => !isKept('appMap', entry.path)).map(entry => entry.path).filter(Boolean);
        const procDrop = (draft.procedures || []).filter(proc => !isKept('procedures', proc.name)).map(proc => proc.name).filter(Boolean);
        const glossDrop = (draft.glossary || []).filter(entry => !isKept('glossary', entry.term)).map(entry => entry.term).filter(Boolean);
        const tmplDrop = (draft.templates || []).filter(tmpl => !isKept('templates', tmpl.name)).map(tmpl => tmpl.name).filter(Boolean);
        const loginDrop = loginRows.filter(row => !row.store).map(row => loginKey(row.site, row.user));
        if (appMapDrop.length) drop.appMap = appMapDrop;
        if (procDrop.length) drop.procedures = procDrop;
        if (glossDrop.length) drop.glossary = glossDrop;
        if (tmplDrop.length) drop.templates = tmplDrop;
        if (loginDrop.length) drop.logins = loginDrop;
        if (draft.summary && !isKept('summary', 'summary')) drop.summary = true;

        const logins = loginRows
            .filter(row => row.store && row.password)
            .map(row => ({ site: row.site, user: row.user, password: row.password }));

        const answersOut = {};
        for (const [id, text] of Object.entries(answers)) {
            if (text && text.trim()) answersOut[id] = text.trim();
        }

        return { drop, logins, answers: answersOut };
    };

    const accept = useCallback(async () => {
        if (busy || !review) return;
        setBusy(true);
        try {
            const res = await window.api.teach?.accept(agentId, review.id, buildSelections());
            const counts = res?.counts || {};
            setResult({
                kind: 'saved',
                facts: counts.facts || 0,
                specs: counts.specs || 0,
                logins: counts.logins || 0,
            });
            setReview(null);
            setLoginRows([]);
            await refresh();
            toast.success(
                `Saved ${counts.facts || 0} facts, ${counts.specs || 0} specs, ${counts.logins || 0} logins.`,
                toastOptions(),
            );
        } finally {
            setBusy(false);
        }
    }, [busy, agentId, review, refresh, kept, loginRows, answers]);

    const discard = useCallback(async () => {
        if (busy || !review) return;
        setBusy(true);
        try {
            // Every password typed, kept or not, so each is wiped from memory.
            const typed = loginRows
                .filter(row => row.password)
                .map(row => ({ site: row.site, user: row.user, password: row.password }));
            await window.api.teach?.discard(review.id, { logins: typed });
            setResult({ kind: 'discarded' });
            setReview(null);
            setLoginRows([]);
            await refresh();
            toast('Recording discarded. Nothing was saved.', toastOptions());
        } finally {
            setBusy(false);
        }
    }, [busy, review, loginRows, refresh]);

    const discardPending = useCallback(async (id) => {
        await window.api.teach?.discard(id, { logins: [] });
        await refresh();
        toast('Recording discarded.', toastOptions());
    }, [refresh]);

    /* ----------------------------------------------------------------- *
     * Review
     * ----------------------------------------------------------------- */
    if (review) {
        const draft = review.draft || {};
        const logins = review.logins || [];
        const appMap = draft.appMap || [];
        const procedures = draft.procedures || [];
        const glossary = draft.glossary || [];
        const templates = draft.templates || [];
        const questions = draft.questions || [];

        const appGroups = {};
        for (const entry of appMap) {
            (appGroups[entry.app] = appGroups[entry.app] || []).push(entry);
        }

        const summary = String(draft.summary || '').trim();
        const nothing = !summary && !logins.length && !appMap.length && !procedures.length
            && !glossary.length && !templates.length && !questions.length;
        const retold = retellText.trim() !== String(review.task || '').trim();

        return (
            <div className="flex flex-col gap-4 h-full min-h-0" id="teach-panel">
                <div className="shrink-0">
                    <h2 className="text-base font-medium text-gray-900 dark:text-white">Review what was learned</h2>
                    <p className="mt-1 text-[13px] text-gray-500 dark:text-gray-400">
                        Keep what is right, untick the rest. Only Accept writes anything.
                    </p>
                </div>

                {review.note && (
                    <div className="shrink-0 flex items-start gap-2 rounded-xl border border-amber-300/60 dark:border-amber-500/30
                        bg-amber-50 dark:bg-amber-500/10 px-3 py-2.5 text-[13px] text-amber-700 dark:text-amber-300">
                        <Alert02Icon size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                        <span>{review.note}</span>
                    </div>
                )}

                <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 pb-1 flex flex-col gap-5">
                    {nothing && !review.note && (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            The recording held nothing to learn from.
                        </p>
                    )}

                    <section className="flex flex-col gap-2">
                        <SectionTitle>What you were doing</SectionTitle>
                        <div className="rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-800/50 px-4 py-3">
                            {summary ? (
                                <label className="flex items-start gap-3 cursor-pointer">
                                    <Checkbox checked={isKept('summary', 'summary')} onChange={() => toggleKeep('summary', 'summary')} />
                                    <span className="min-w-0 flex-1 text-sm text-gray-900 dark:text-white break-words">{summary}</span>
                                </label>
                            ) : (
                                <p className="text-[13px] text-gray-500 dark:text-gray-400">
                                    The agent could not tell what the task was. Say it in a line below and it reads the recording again.
                                </p>
                            )}
                            <div className={summary ? 'mt-3 pl-[30px]' : 'mt-3'}>
                                <input
                                    type="text"
                                    value={retellText}
                                    onChange={(event) => setRetellText(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter' && retold && reader.settings) readAgain();
                                    }}
                                    placeholder={summary ? 'Not quite? Say what you were doing' : 'What were you doing?'}
                                    className={FIELD_CLASS}
                                />
                                <p className="mt-1.5 text-[11px] text-gray-500 dark:text-neutral-500">
                                    For example: entering this week's supplier invoices into Xero from the accounts inbox.
                                </p>
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                    <span className="text-[13px] text-gray-500 dark:text-gray-400">Read with</span>
                                    {readerChip}
                                    <Button onClick={readAgain} disabled={busy || !reader.settings}>
                                        Read again
                                    </Button>
                                </div>
                                {review.reader?.provider && (
                                    <p className="mt-1.5 text-[11px] text-gray-500 dark:text-neutral-500">
                                        This draft was read by {reader.labelFor(review.reader)}
                                        {review.reader.effort ? ` at ${review.reader.effort} effort` : ''}.
                                    </p>
                                )}
                            </div>
                        </div>
                    </section>

                    {logins.length > 0 && (
                        <section className="flex flex-col gap-2">
                            <SectionTitle>Logins</SectionTitle>
                            <p className="text-[13px] text-gray-500 dark:text-gray-400 -mt-1">
                                No password was recorded. Type one only for a login you keep: it is saved to the keychain
                                when you accept, and nowhere before that.
                            </p>
                            {loginRows.map((row, index) => (
                                <div
                                    key={loginKey(row.site, row.user)}
                                    className="rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-800/50 px-4 py-3"
                                >
                                    <label className="flex items-start gap-3 cursor-pointer">
                                        <Checkbox checked={row.store} onChange={(event) => setLoginStore(index, event.target.checked)} />
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-sm text-gray-900 dark:text-white break-words">{row.site}</span>
                                            <span className="block text-[13px] text-gray-500 dark:text-gray-400 break-words">{row.user}</span>
                                        </span>
                                        <span className="text-[13px] text-gray-500 dark:text-gray-400 shrink-0">Store this login</span>
                                    </label>
                                    {row.store && (
                                        <div className="mt-3 pl-[30px]">
                                            <input
                                                type="password"
                                                value={row.password}
                                                autoComplete="new-password"
                                                onChange={(event) => setLoginPassword(index, event.target.value)}
                                                placeholder="Password"
                                                className={FIELD_CLASS}
                                            />
                                            <p className="mt-1.5 text-[11px] text-gray-500 dark:text-neutral-500">
                                                Only saved if you accept. Leave blank to note the login without a secret.
                                            </p>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </section>
                    )}

                    {appMap.length > 0 && (
                        <section className="flex flex-col gap-2">
                            <SectionTitle>App map</SectionTitle>
                            {Object.entries(appGroups).map(([app, entries]) => (
                                <div
                                    key={app}
                                    className="rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-800/50 px-4 py-3"
                                >
                                    <p className="text-sm font-medium text-gray-900 dark:text-white break-words">{app}</p>
                                    <div className="mt-2 flex flex-col gap-1.5">
                                        {entries.map(entry => (
                                            <label key={entry.path} className="flex items-start gap-3 cursor-pointer">
                                                <Checkbox
                                                    checked={isKept('appMap', entry.path)}
                                                    onChange={() => toggleKeep('appMap', entry.path)}
                                                />
                                                <span className="min-w-0 flex-1 text-[13px] text-gray-700 dark:text-gray-300 break-words">
                                                    {entry.where ? `${entry.where} - ${entry.path}` : entry.path}
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </section>
                    )}

                    {procedures.length > 0 && (
                        <section className="flex flex-col gap-2">
                            <SectionTitle>Procedures</SectionTitle>
                            {procedures.map(proc => (
                                <div
                                    key={proc.name}
                                    className="rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-800/50 px-4 py-3"
                                >
                                    <label className="flex items-start gap-3 cursor-pointer">
                                        <Checkbox checked={isKept('procedures', proc.name)} onChange={() => toggleKeep('procedures', proc.name)} />
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-sm font-medium text-gray-900 dark:text-white break-words">{proc.name}</span>
                                            {proc.when && (
                                                <span className="block text-[13px] text-gray-500 dark:text-gray-400 break-words">{proc.when}</span>
                                            )}
                                        </span>
                                    </label>
                                    {(proc.steps?.length > 0 || proc.branches?.length > 0) && (
                                        <details className="mt-2 pl-[30px] text-[13px] text-gray-600 dark:text-gray-300">
                                            <summary className="cursor-pointer text-gray-500 dark:text-gray-400 select-none">
                                                Steps ({(proc.steps || []).length})
                                            </summary>
                                            <ol className="mt-1.5 list-decimal pl-5 flex flex-col gap-1">
                                                {(proc.steps || []).map((step, i) => (
                                                    <li key={i} className="break-words">{step}</li>
                                                ))}
                                            </ol>
                                            {(proc.branches || []).length > 0 && (
                                                <ul className="mt-2 list-disc pl-5 flex flex-col gap-1 text-gray-500 dark:text-gray-400">
                                                    {proc.branches.map((branch, i) => (
                                                        <li key={i} className="break-words">{branch}</li>
                                                    ))}
                                                </ul>
                                            )}
                                        </details>
                                    )}
                                </div>
                            ))}
                        </section>
                    )}

                    {glossary.length > 0 && (
                        <section className="flex flex-col gap-2">
                            <SectionTitle>Glossary</SectionTitle>
                            {glossary.map(entry => (
                                <div
                                    key={entry.term}
                                    className="rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-800/50 px-4 py-3"
                                >
                                    <label className="flex items-start gap-3 cursor-pointer">
                                        <Checkbox checked={isKept('glossary', entry.term)} onChange={() => toggleKeep('glossary', entry.term)} />
                                        <span className="min-w-0 flex-1">
                                            <span className="text-sm font-medium text-gray-900 dark:text-white break-words">{entry.term}</span>
                                            {entry.meaning && (
                                                <span className="block text-[13px] text-gray-500 dark:text-gray-400 break-words">{entry.meaning}</span>
                                            )}
                                        </span>
                                    </label>
                                </div>
                            ))}
                        </section>
                    )}

                    {templates.length > 0 && (
                        <section className="flex flex-col gap-2">
                            <SectionTitle>Templates</SectionTitle>
                            {templates.map(tmpl => (
                                <div
                                    key={tmpl.name}
                                    className="rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-800/50 px-4 py-3"
                                >
                                    <label className="flex items-start gap-3 cursor-pointer">
                                        <Checkbox checked={isKept('templates', tmpl.name)} onChange={() => toggleKeep('templates', tmpl.name)} />
                                        <span className="text-sm font-medium text-gray-900 dark:text-white break-words">{tmpl.name}</span>
                                    </label>
                                    {tmpl.text && (
                                        <p className="mt-2 pl-[30px] text-[13px] text-gray-600 dark:text-gray-300 whitespace-pre-wrap break-words">
                                            {tmpl.text}
                                        </p>
                                    )}
                                </div>
                            ))}
                        </section>
                    )}

                    {questions.length > 0 && (
                        <section className="flex flex-col gap-2">
                            <SectionTitle>Questions</SectionTitle>
                            {questions.map(question => (
                                <div
                                    key={question.id}
                                    className="rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-800/50 px-4 py-3"
                                >
                                    <p className="text-[13px] text-gray-700 dark:text-gray-300 break-words">{question.text}</p>
                                    <input
                                        type="text"
                                        value={answers[question.id] || ''}
                                        onChange={(event) => setAnswer(question.id, event.target.value)}
                                        placeholder="Your answer, or leave blank to skip"
                                        className={`${FIELD_CLASS} mt-2`}
                                    />
                                </div>
                            ))}
                        </section>
                    )}
                </div>

                <div className="shrink-0 flex flex-col gap-2 border-t border-gray-200 dark:border-neutral-800 pt-3">
                    <p className="text-[13px] text-gray-500 dark:text-gray-400">
                        Accepting writes the kept logins into this agent's keychain, and the rest into its memory and specs.
                        Discarding wipes the passwords you typed and leaves nothing behind.
                    </p>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="primary"
                            icon={busy ? <Loading03Icon size={16} className="animate-spin" /> : <Tick02Icon size={16} strokeWidth={2} />}
                            onClick={accept}
                            disabled={busy}
                        >
                            Accept
                        </Button>
                        <Button onClick={discard} disabled={busy}>Discard</Button>
                    </div>
                </div>
            </div>
        );
    }

    /* ----------------------------------------------------------------- *
     * Reading: the agent turns the recording into a draft
     * ----------------------------------------------------------------- */
    if (reading) {
        return (
            <div className="flex flex-col gap-4 h-full min-h-0" id="teach-panel">
                <div className="flex-1 min-h-0 flex items-center justify-center">
                    <div className="w-full max-w-md flex flex-col items-center gap-3 text-center">
                        <Loading03Icon size={22} className="animate-spin text-gray-500 dark:text-gray-400" />
                        <span className="text-base font-medium text-gray-900 dark:text-white">Reading the recording</span>
                        <p className="text-[13px] text-gray-500 dark:text-gray-400">
                            {reader.chosen ? `${reader.labelFor(reader.chosen)} is` : 'The agent is'} working out what you were
                            doing, what it learned and what to ask you. This can take a few minutes. If you leave this page, the
                            recording waits under Left over, and Review picks it up again.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    /* ----------------------------------------------------------------- *
     * Recording
     * ----------------------------------------------------------------- */
    if (recording) {
        const paused = Boolean(recording.paused);
        return (
            <div className="flex flex-col gap-4 h-full min-h-0" id="teach-panel">
                <div className="flex-1 min-h-0 flex items-center justify-center">
                    <div className="w-full max-w-md flex flex-col items-center gap-5 text-center">
                        <div className="flex items-center gap-2.5">
                            <span className={`w-2.5 h-2.5 rounded-full ${paused ? 'bg-gray-400 dark:bg-neutral-500' : 'bg-red-500 animate-pulse'}`} />
                            <span className="text-base font-medium text-gray-900 dark:text-white">
                                {paused ? 'Paused' : 'Recording'}
                            </span>
                        </div>
                        <p className="text-[13px] text-gray-500 dark:text-gray-400">
                            {recording.lines || 0} steps so far. Carry on with your task, then stop to review what the agent learned.
                        </p>
                        <div className="flex items-center gap-2">
                            <Button
                                icon={paused ? <PlayIcon size={16} strokeWidth={2} /> : <PauseIcon size={16} strokeWidth={2} />}
                                onClick={togglePause}
                                disabled={busy}
                            >
                                {paused ? 'Resume' : 'Pause'}
                            </Button>
                            <Button
                                variant="primary"
                                icon={busy ? <Loading03Icon size={16} className="animate-spin" /> : <StopCircleIcon size={16} strokeWidth={2} />}
                                onClick={stop}
                                disabled={busy}
                            >
                                Stop and review
                            </Button>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-[13px] text-gray-500 dark:text-gray-400">Read with</span>
                            {readerChip}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    /* ----------------------------------------------------------------- *
     * Idle
     * ----------------------------------------------------------------- */
    return (
        <div className="flex flex-col gap-4 h-full min-h-0" id="teach-panel">
            {result && (
                <div className="shrink-0 flex items-center gap-2 rounded-xl border border-gray-200 dark:border-neutral-800
                    bg-white dark:bg-neutral-800/50 px-3 py-2.5 text-[13px] text-gray-700 dark:text-gray-300">
                    <Tick02Icon size={16} strokeWidth={2} className="shrink-0 text-gray-400 dark:text-neutral-500" />
                    {result.kind === 'saved'
                        ? <span>Saved {result.facts} facts, {result.specs} specs, {result.logins} logins.</span>
                        : <span>Recording discarded. Nothing was saved.</span>}
                </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 pb-1">
                <div className="max-w-xl flex flex-col gap-5">
                    <div className="flex flex-col gap-2">
                        <h2 className="text-base font-medium text-gray-900 dark:text-white">Teach the agent a task</h2>
                        <p className="text-[13px] text-gray-500 dark:text-gray-400">
                            Record yourself doing a task in the apps you choose, and the agent drafts what it learned for you to
                            review before anything is saved. Passwords are never recorded: you type them yourself at the end, and
                            only for the logins you choose to keep.
                        </p>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">What are you about to do?</span>
                        <input
                            type="text"
                            value={task}
                            onChange={(event) => setTask(event.target.value)}
                            placeholder="Optional, one line"
                            className={FIELD_CLASS}
                        />
                        <span className="text-[11px] text-gray-500 dark:text-neutral-500">
                            For example: entering this week's supplier invoices into Xero from the accounts inbox. The agent
                            reads the recording in the light of it, and asks you less.
                        </span>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Apps to record</span>
                        <input
                            type="text"
                            value={apps}
                            onChange={(event) => setApps(event.target.value)}
                            placeholder="Comma-separated process names, blank for all"
                            className={FIELD_CLASS}
                        />
                        <span className="text-[11px] text-gray-500 dark:text-neutral-500">
                            For example chrome.exe, excel.exe. Anything not listed stays off the recording.
                        </span>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Model that reads the recording</span>
                        <div className="flex items-center">{readerChip}</div>
                        <span className="text-[11px] text-gray-500 dark:text-neutral-500">
                            It works out what you were doing and what to ask you. A stronger model understands the work
                            better; you can change it again before you stop, or read the recording again with another.
                        </span>
                    </div>

                    <div>
                        <Button
                            variant="primary"
                            icon={busy ? <Loading03Icon size={16} className="animate-spin" /> : <RecordIcon size={16} strokeWidth={2} />}
                            onClick={start}
                            disabled={busy || !agentId}
                        >
                            Start recording
                        </Button>
                    </div>

                    {pending.length > 0 && (
                        <div className="flex flex-col gap-2">
                            <SectionTitle>Left over</SectionTitle>
                            <p className="text-[13px] text-gray-500 dark:text-gray-400 -mt-1">
                                Recordings that were never reviewed. Review one to answer the agent's questions and keep what it
                                learned, or discard the ones you do not need.
                            </p>
                            {pending.map(item => (
                                <div
                                    key={item.id}
                                    className="flex items-center gap-3 rounded-xl border border-gray-200 dark:border-neutral-800
                                        bg-white dark:bg-neutral-800/50 px-4 py-3"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm text-gray-900 dark:text-white break-words">{item.id}</p>
                                        <p className="text-[13px] text-gray-500 dark:text-gray-400">
                                            {formatWhen(item.at)}
                                            {item.ready ? ' · Ready to review' : item.reading ? ' · The agent is reading it' : ''}
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        icon={<ViewIcon size={15} strokeWidth={1.75} />}
                                        onClick={() => reviewPending(item.id)}
                                        disabled={busy || !agentId}
                                    >
                                        Review
                                    </Button>
                                    <Button
                                        variant="dangerGhost"
                                        size="sm"
                                        icon={<Delete02Icon size={15} strokeWidth={1.75} />}
                                        onClick={() => discardPending(item.id)}
                                        disabled={busy}
                                    >
                                        Discard
                                    </Button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

/** A small, quiet heading for a review or idle section. */
function SectionTitle({ children }) {
    return (
        <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{children}</h3>
    );
}

export default memo(TeachPanel);

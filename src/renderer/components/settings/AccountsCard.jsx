import { useEffect, useMemo, useRef, useState } from 'react';
import {
    Cancel01Icon, Delete02Icon, Folder01Icon, LinkSquare02Icon, Loading03Icon,
    PencilEdit02Icon, PlusSignIcon, Refresh01Icon, Tick02Icon,
} from 'hugeicons-react';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import Button, { IconButton } from '../ui/Button';
import ConfirmDialog from '../ui/ConfirmDialog';
import LimitBar, { UsageLine } from '../usage/LimitBar';
import ProviderMark from '../../lib/provider-marks';
import { PROVIDER_NAMES } from '../../lib/ai-catalog';
import { STALE_AFTER, identityLine, keyOf, lastRead, sortWindows, span } from '../../lib/usage-limits';
import useUsageLimits from '../../hooks/useUsageLimits';
import { useT } from '../../i18n';

/**
 * Which account each agent signs in with, and how much of each plan is left.
 *
 * Claude Code and Codex can hold more than one sign-in on a machine, each in
 * its own folder, and this is where they are added, signed in and chosen
 * between. The choice is this agent's, like everything else on the page: a
 * work agent on the work account and a personal one beside it is the point.
 *
 * Every switched-on runtime gets a section, including the ones with a single
 * login, because the second half of the card is theirs too: what this
 * computer has sent through each, today and this week. For the two that can
 * say, the plan's own windows sit above that, the same figures their /usage
 * screens draw, counting every device on the account.
 *
 * Limits are read when the page opens if what is held is old, and on the
 * button. Reading one starts the runtime for a couple of seconds and sends
 * nothing to a model.
 */

const FIELD_CLASS = `w-full px-3 py-2 rounded-xl text-sm bg-white dark:bg-neutral-800
    border border-gray-300 dark:border-neutral-700
    text-gray-900 dark:text-gray-100 outline-none
    focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25`;

function AccountRow({ provider, account, entry, login, chosen, checking, now, canSignIn, onChoose, onCheck, onLogin, onCancelLogin, onRename, onRemove }) {
    const t = useT();
    const [editing, setEditing] = useState(false);
    const [label, setLabel] = useState(account.label);
    const signedIn = entry?.identity?.signedIn;
    const windows = sortWindows(entry?.windows || []);
    const name = account.builtIn ? t('settings.accounts.machineLogin') : account.label;
    const checkedAt = lastRead(entry);

    const saveLabel = () => {
        setEditing(false);
        if (label.trim() && label.trim() !== account.label) onRename(account.id, label.trim());
        else setLabel(account.label);
    };

    return (
        <li className={`rounded-xl border p-3 transition-colors ${chosen
            ? 'border-gray-900/40 dark:border-white/40 bg-gray-50/60 dark:bg-white/[0.03]'
            : 'border-gray-200 dark:border-neutral-800'}`}
        >
            <div className="flex items-start gap-3">
                <button
                    type="button"
                    role="radio"
                    aria-checked={chosen}
                    aria-label={t('settings.accounts.use', { name })}
                    onClick={() => !chosen && onChoose(account.id)}
                    className={`mt-0.5 w-4 h-4 rounded-full border shrink-0 flex items-center justify-center
                        outline-none focus-visible:ring-2 focus-visible:ring-gray-900/25 dark:focus-visible:ring-white/30
                        ${chosen ? 'border-gray-900 dark:border-white' : 'border-gray-300 dark:border-neutral-600 hover:border-gray-500'}`}
                >
                    {chosen && <span className="w-2 h-2 rounded-full bg-gray-900 dark:bg-white" />}
                </button>

                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                        {editing ? (
                            <input
                                autoFocus
                                aria-label={t('settings.accounts.label')}
                                className={`${FIELD_CLASS} py-1 text-sm`}
                                value={label}
                                maxLength={60}
                                onChange={(event) => setLabel(event.target.value)}
                                onBlur={saveLabel}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') saveLabel();
                                    if (event.key === 'Escape') { setLabel(account.label); setEditing(false); }
                                }}
                            />
                        ) : (
                            <button
                                type="button"
                                onClick={() => !chosen && onChoose(account.id)}
                                className="text-sm font-semibold text-gray-900 dark:text-white truncate text-left"
                            >
                                {name}
                            </button>
                        )}
                        {chosen && !editing && (
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 shrink-0">
                                {t('settings.accounts.inUse')}
                            </span>
                        )}
                    </div>
                    <p className={`text-xs truncate ${entry?.identity && !signedIn ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'}`}>
                        {identityLine(entry, t)}
                    </p>
                    {!account.builtIn && !account.managed && (
                        <p className="text-[11px] font-jetbrains text-gray-400 dark:text-neutral-500 truncate" title={account.home}>
                            {account.home}
                        </p>
                    )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                    {!login && !signedIn && entry?.identity && canSignIn && (
                        <Button size="sm" variant="primary" onClick={() => onLogin(account.id)}>
                            {t('settings.accounts.signIn')}
                        </Button>
                    )}
                    <IconButton
                        size="sm"
                        variant="ghost"
                        title={checking ? t('settings.accounts.checking') : t('settings.accounts.check')}
                        disabled={checking}
                        icon={checking
                            ? <Loading03Icon size={14} className="animate-spin" />
                            : <Refresh01Icon size={14} strokeWidth={2} />}
                        onClick={() => onCheck(account.id)}
                    />
                    {!account.builtIn && (
                        <>
                            <IconButton
                                size="sm"
                                variant="ghost"
                                title={t('settings.accounts.rename')}
                                icon={<PencilEdit02Icon size={14} strokeWidth={2} />}
                                onClick={() => setEditing(true)}
                            />
                            <IconButton
                                size="sm"
                                variant="ghost"
                                title={account.managed ? t('settings.accounts.remove') : t('settings.accounts.forget')}
                                icon={<Delete02Icon size={14} strokeWidth={2} />}
                                onClick={() => onRemove(account)}
                            />
                        </>
                    )}
                </div>
            </div>

            {login && (
                <div className="mt-3 ml-7 flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                    <Loading03Icon size={13} className="animate-spin shrink-0" />
                    <span>{t('settings.accounts.waiting', { name: PROVIDER_NAMES[provider] })}</span>
                    {login.code && (
                        <span className="px-2 py-0.5 rounded-md font-jetbrains text-xs tracking-wider bg-gray-100 dark:bg-white/[0.07] text-gray-900 dark:text-white select-all">
                            {login.code}
                        </span>
                    )}
                    {login.url && (
                        <Button
                            size="sm"
                            variant="ghost"
                            icon={<LinkSquare02Icon size={13} strokeWidth={2} />}
                            onClick={() => window.api.links.open(login.url)}
                        >
                            {t('settings.accounts.openPage')}
                        </Button>
                    )}
                    <Button size="sm" variant="ghost" icon={<Cancel01Icon size={13} strokeWidth={2} />} onClick={() => onCancelLogin(account.id)}>
                        {t('common.cancel')}
                    </Button>
                </div>
            )}

            {(windows.length > 0 || entry?.usage) && (
                <div className="mt-3 ml-7 space-y-3">
                    {windows.length > 0 && (
                        <div className="grid gap-x-6 gap-y-2.5 grid-cols-[repeat(auto-fill,minmax(min(14rem,100%),1fr))]">
                            {windows.map(window => <LimitBar key={window.id} window={window} now={now} />)}
                        </div>
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                        <UsageLine usage={entry?.usage} priced={provider !== 'claude-code' || !entry?.identity?.plan} />
                        {checkedAt > 0 && (
                            <span className="text-[11px] text-gray-400 dark:text-neutral-500">
                                {t('settings.accounts.checkedAgo', { span: span(now - checkedAt) })}
                            </span>
                        )}
                    </div>
                </div>
            )}
        </li>
    );
}

/**
 * The form for another account: a fresh sign-in in a folder this app keeps,
 * or a folder the user already signs in from. Folders that look like one of
 * those are offered, found by name in the home directory.
 */
function AddAccount({ provider, canSignIn, onAdded, onClose }) {
    const t = useT();
    const [label, setLabel] = useState('');
    const [mode, setMode] = useState(canSignIn ? 'new' : 'existing');
    const [home, setHome] = useState('');
    const [found, setFound] = useState([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        window.api.ai.accounts.discover(provider).then((list) => {
            if (!cancelled) setFound(list || []);
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [provider]);

    const browse = async () => {
        const picked = await window.api.ai.accounts.pickFolder().catch(() => '');
        if (picked) { setHome(picked); setError(''); }
    };

    const submit = async (event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        const result = await window.api.ai.accounts.add({
            provider,
            label: label.trim(),
            home: mode === 'existing' ? home.trim() : '',
        }).catch(error => ({ error: error.message }));
        setBusy(false);
        if (result?.error || !result?.account) {
            setError(result?.error || t('settings.accounts.addFailed'));
            return;
        }
        onAdded(result);
    };

    const radio = (value, title, note) => (
        <label className="flex items-start gap-2.5 cursor-pointer">
            <input
                type="radio"
                name={`account-mode-${provider}`}
                className="mt-1 accent-gray-900 dark:accent-white"
                checked={mode === value}
                onChange={() => { setMode(value); setError(''); }}
            />
            <span className="min-w-0">
                <span className="block text-sm text-gray-900 dark:text-white">{title}</span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">{note}</span>
            </span>
        </label>
    );

    return (
        <form onSubmit={submit} className="rounded-xl border border-dashed border-gray-300 dark:border-neutral-700 p-3 space-y-3">
            <input
                autoFocus
                aria-label={t('settings.accounts.label')}
                placeholder={t('settings.accounts.labelPlaceholder')}
                className={FIELD_CLASS}
                value={label}
                maxLength={60}
                onChange={(event) => setLabel(event.target.value)}
            />
            <div className="space-y-2" role="radiogroup">
                {canSignIn
                    ? radio('new', t('settings.accounts.modeNew'), t('settings.accounts.modeNewNote', { name: PROVIDER_NAMES[provider] }))
                    : radio('new', t('settings.accounts.modeEmpty'), t('settings.accounts.modeEmptyNote', { name: PROVIDER_NAMES[provider] }))}
                {radio('existing', t('settings.accounts.modeExisting'), t('settings.accounts.modeExistingNote'))}
            </div>
            {mode === 'existing' && (
                <div className="space-y-2 pl-6">
                    <div className="flex gap-2">
                        <input
                            aria-label={t('settings.accounts.folder')}
                            spellCheck={false}
                            placeholder={provider === 'codex' ? '~/.codex-work' : '~/.claude-work'}
                            className={`${FIELD_CLASS} flex-1 font-jetbrains text-xs`}
                            value={home}
                            onChange={(event) => { setHome(event.target.value); setError(''); }}
                        />
                        <Button size="md" variant="secondary" icon={<Folder01Icon size={14} strokeWidth={2} />} onClick={browse}>
                            {t('settings.accounts.browse')}
                        </Button>
                    </div>
                    {found.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            {found.map(folder => (
                                <button
                                    key={folder}
                                    type="button"
                                    onClick={() => { setHome(folder); setError(''); }}
                                    className="px-2 py-1 rounded-lg text-[11px] font-jetbrains border border-gray-200 dark:border-neutral-700
                                        text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800"
                                >
                                    {folder}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            <div className="flex items-center gap-2">
                <Button
                    type="submit"
                    size="sm"
                    variant="primary"
                    disabled={busy || (mode === 'existing' && !home.trim())}
                    icon={busy ? <Loading03Icon size={13} className="animate-spin" /> : <Tick02Icon size={13} strokeWidth={2.5} />}
                >
                    {mode === 'new' && canSignIn ? t('settings.accounts.addAndSignIn') : t('settings.accounts.add')}
                </Button>
                <Button size="sm" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            </div>
        </form>
    );
}

function ProviderSection({ provider, overview, chosenId, checking, now, first, onChoose, onCheck, onLogin, onCancelLogin, onRename, onRemove, onAdded }) {
    const t = useT();
    const [adding, setAdding] = useState(false);
    const list = overview.accounts?.[provider];
    const multi = Array.isArray(list);
    const can = overview.capabilities?.[provider] || {};
    const accounts = multi ? list : [{ id: 'default', provider, builtIn: true, label: '' }];
    const logins = overview.logins || [];

    return (
        <section className={first ? '' : DIVIDED}>
            <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2 min-w-0">
                    <ProviderMark provider={provider} size={18} />
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-white truncate">{PROVIDER_NAMES[provider]}</h4>
                </div>
                {multi && can.multiple && !adding && (
                    <Button size="sm" variant="ghost" icon={<PlusSignIcon size={13} strokeWidth={2.5} />} onClick={() => setAdding(true)}>
                        {t('settings.accounts.addAccount')}
                    </Button>
                )}
            </div>

            {multi ? (
                <ul className="space-y-2" role="radiogroup" aria-label={t('settings.accounts.which', { name: PROVIDER_NAMES[provider] })}>
                    {accounts.map(account => (
                        <AccountRow
                            key={account.id}
                            provider={provider}
                            account={account}
                            entry={overview.limits?.[keyOf(provider, account.id)]}
                            login={logins.find(entry => entry.provider === provider && entry.accountId === account.id)}
                            chosen={chosenId === account.id}
                            checking={checking.has(keyOf(provider, account.id))}
                            now={now}
                            canSignIn={Boolean(can.signIn)}
                            onChoose={(id) => onChoose(provider, id)}
                            onCheck={(id) => onCheck(provider, id)}
                            onLogin={(id) => onLogin(provider, id)}
                            onCancelLogin={(id) => onCancelLogin(provider, id)}
                            onRename={onRename}
                            onRemove={onRemove}
                        />
                    ))}
                </ul>
            ) : (
                <div className="space-y-1">
                    <UsageLine usage={overview.limits?.[keyOf(provider, 'default')]?.usage} priced />
                    <p className="text-[11px] text-gray-400 dark:text-neutral-500">{t('settings.accounts.noPlan')}</p>
                </div>
            )}

            {adding && (
                <div className="mt-2">
                    <AddAccount
                        provider={provider}
                        canSignIn={Boolean(can.signIn)}
                        onClose={() => setAdding(false)}
                        onAdded={(result) => { setAdding(false); onAdded(provider, result); }}
                    />
                </div>
            )}
        </section>
    );
}

export default function AccountsCard({ providers = [], settings, onSettings }) {
    const t = useT();
    const { overview, setOverview, checking, check, loginNotice } = useUsageLimits();
    const [notice, setNotice] = useState('');
    const [confirming, setConfirming] = useState(null);
    const [now, setNow] = useState(() => Date.now());

    // The reset countdowns tick over without anything having to be asked.
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(timer);
    }, []);

    // Brought here from the settings jump that asked for this card: the
    // status bar's "Manage accounts" lands on it rather than the page's top.
    const cardRef = useRef(null);
    useEffect(() => {
        let wanted = '';
        try {
            wanted = window.sessionStorage.getItem('settings.focus') || '';
            if (wanted === 'accounts') window.sessionStorage.removeItem('settings.focus');
        } catch {
            // No session storage: nothing to land on.
        }
        if (wanted === 'accounts') cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, []);

    const multiProviders = useMemo(
        () => providers.filter(provider => Array.isArray(overview.accounts?.[provider])),
        [providers, overview.accounts],
    );

    // Read on the way in whatever has not been read lately, once the accounts
    // are known. Only the switched-on runtimes: nobody asked about the others.
    const [autoChecked, setAutoChecked] = useState(false);
    useEffect(() => {
        if (autoChecked || multiProviders.length === 0) return;
        setAutoChecked(true);
        const at = Date.now();
        for (const provider of multiProviders) {
            for (const account of overview.accounts[provider]) {
                const entry = overview.limits?.[keyOf(provider, account.id)];
                if (!entry?.checkedAt || at - entry.checkedAt > STALE_AFTER) check(provider, account.id);
            }
        }
    }, [autoChecked, multiProviders, overview, check]);

    const checkAll = () => {
        for (const provider of multiProviders) {
            for (const account of overview.accounts[provider]) check(provider, account.id);
        }
    };

    const choose = (provider, accountId) => onSettings({ accounts: { [provider]: accountId } });

    const login = async (provider, accountId) => {
        setNotice('');
        const result = await window.api.ai.accounts.login(provider, accountId).catch(error => ({ error: error.message }));
        if (result?.error) setNotice(result.error);
    };

    const cancelLogin = (provider, accountId) => window.api.ai.accounts.cancelLogin(provider, accountId);

    const rename = async (id, label) => {
        const next = await window.api.ai.accounts.rename(id, label).catch(() => null);
        if (next?.accounts) setOverview(next);
    };

    const remove = async () => {
        const account = confirming;
        setConfirming(null);
        if (!account) return;
        const next = await window.api.ai.accounts.remove(account.id).catch(() => null);
        if (next?.accounts) setOverview(next);
    };

    // A new account in a folder of our own has nobody signed in yet, so the
    // sign-in starts straight away; one pointed at an existing folder is read.
    // It is chosen for this agent either way: adding one is asking to use it.
    const added = (provider, result) => {
        setOverview(result);
        choose(provider, result.account.id);
        if (result.account.managed && overview.capabilities?.[provider]?.signIn) login(provider, result.account.id);
        else check(provider, result.account.id);
    };

    if (providers.length === 0) return null;

    return (
        <div ref={cardRef} className="scroll-mt-4">
        <SettingCard>
            <SettingRow
                title={t('settings.accounts.title')}
                description={t('settings.accounts.desc')}
                control={multiProviders.length > 0 && (
                    <Button
                        size="sm"
                        variant="secondary"
                        icon={checking.size > 0
                            ? <Loading03Icon size={13} className="animate-spin" />
                            : <Refresh01Icon size={13} strokeWidth={2} />}
                        disabled={checking.size > 0}
                        onClick={checkAll}
                    >
                        {t('settings.accounts.checkAll')}
                    </Button>
                )}
            />

            {(notice || loginNotice) && (
                <p className="mt-4 text-xs text-amber-600 dark:text-amber-400">{notice || loginNotice}</p>
            )}

            <div className="mt-5">
                {providers.map((provider, index) => (
                    <ProviderSection
                        key={provider}
                        provider={provider}
                        overview={overview}
                        chosenId={overview.accounts?.[provider]?.some(account => account.id === settings?.accounts?.[provider])
                            ? settings.accounts[provider]
                            : 'default'}
                        checking={checking}
                        now={now}
                        first={index === 0}
                        onChoose={choose}
                        onCheck={check}
                        onLogin={login}
                        onCancelLogin={cancelLogin}
                        onRename={rename}
                        onRemove={setConfirming}
                        onAdded={added}
                    />
                ))}
            </div>

            {confirming && (
                <RemoveDialog account={confirming} onConfirm={remove} onCancel={() => setConfirming(null)} />
            )}
        </SettingCard>
        </div>
    );
}

function RemoveDialog({ account, onConfirm, onCancel }) {
    const t = useT();
    return (
        <ConfirmDialog
            title={account.managed ? t('settings.accounts.removeTitle', { name: account.label }) : t('settings.accounts.forgetTitle', { name: account.label })}
            message={account.managed ? t('settings.accounts.removeMessage') : t('settings.accounts.forgetMessage', { folder: account.home })}
            confirmLabel={account.managed ? t('settings.accounts.remove') : t('settings.accounts.forget')}
            onConfirm={onConfirm}
            onCancel={onCancel}
        />
    );
}

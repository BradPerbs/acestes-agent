import { useCallback, useEffect, useState } from 'react';
import { keyOf } from '../lib/usage-limits';

const EMPTY = { accounts: {}, limits: {}, logins: [] };

/**
 * The accounts, their plan limits and their usage, kept current.
 *
 * Read once and then followed: the main process pushes the accounts when one
 * is added or removed, the limits whenever a check or a turn moves them, and
 * each step of a sign-in. `check` asks one account again; `checking` is the
 * set of `runtime:account` keys with a check in flight, so a button can spin.
 */
export default function useUsageLimits() {
    const [overview, setOverview] = useState(EMPTY);
    const [checking, setChecking] = useState(() => new Set());
    const [loginNotice, setLoginNotice] = useState('');

    useEffect(() => {
        let cancelled = false;
        window.api.ai.accounts.overview()
            .then((next) => { if (!cancelled && next) setOverview(next); })
            .catch(() => {});
        const offChanged = window.api.ai.accounts.onChanged((accounts) => setOverview(current => ({ ...current, accounts })));
        const offLimits = window.api.ai.accounts.onLimits((limits) => setOverview(current => ({ ...current, limits })));
        const offLogin = window.api.ai.accounts.onLogin((event) => {
            setOverview((current) => {
                const same = (entry) => entry.provider === event.provider && entry.accountId === event.accountId;
                const others = (current.logins || []).filter(entry => !same(entry));
                if (event.phase === 'done' || event.phase === 'failed') return { ...current, logins: others };
                const before = (current.logins || []).find(same);
                return {
                    ...current,
                    logins: [...others, {
                        provider: event.provider,
                        accountId: event.accountId,
                        url: event.url || before?.url || '',
                        code: event.code || before?.code || '',
                    }],
                };
            });
            if (event.phase === 'failed' && event.message && event.message !== 'Cancelled.') setLoginNotice(event.message);
            if (event.phase === 'done') setLoginNotice('');
        });
        return () => {
            cancelled = true;
            offChanged?.();
            offLimits?.();
            offLogin?.();
        };
    }, []);

    const check = useCallback(async (provider, accountId) => {
        const key = keyOf(provider, accountId);
        setChecking(current => new Set(current).add(key));
        try {
            const next = await window.api.ai.accounts.check({ provider, accountId });
            if (next) setOverview(next);
        } catch {
            // What was held stays; the account's error line says what went wrong.
        } finally {
            setChecking((current) => {
                const next = new Set(current);
                next.delete(key);
                return next;
            });
        }
    }, []);

    return { overview, setOverview, checking, check, loginNotice, setLoginNotice };
}

/**
 * The assistant settings of one agent, followed as they change. The bar
 * needs to know which runtimes are on and which account each one uses, and
 * both belong to the agent that is selected.
 */
export function useAgentSettings(agentId) {
    const [settings, setSettings] = useState(null);

    useEffect(() => {
        let cancelled = false;
        window.api.ai.status()
            .then((status) => { if (!cancelled && status?.settings) setSettings(status.settings); })
            .catch(() => {});
        const off = window.api.ai.onSettings((next) => {
            if (!next || (agentId && next.agentId && next.agentId !== agentId)) return;
            setSettings(next);
        });
        return () => {
            cancelled = true;
            off?.();
        };
    }, [agentId]);

    return settings;
}

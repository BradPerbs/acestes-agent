import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserIcon } from 'hugeicons-react';
import Capability, { Detail, StatusLine } from './Capability';
import Toggle from './ui/Toggle';
import Button from '../ui/Button';
import { useT } from '../../i18n';

/**
 * Browser use: one switch for the agent driving a real web browser.
 *
 * The browser is the Playwright MCP server on the agent's inventory, and it
 * used to be something to find in the MCP library, fill in, and hope about.
 * Here it is the switch. On, with a server already there, it is simply
 * handed to the agent again (`browserUse`). On, with none, the switch sets
 * one up: it checks this computer for Node.js and a browser, offers to
 * install Node.js when it is missing (or points at the download), adds the
 * server with the browser that is here, and starts it once to prove it
 * answers. Off keeps the server, so one set up by hand with its own flags
 * is still there next time.
 *
 * The probe is real: the first start of `npx @playwright/mcp` downloads the
 * package, which can outlast the handshake's timeout. That case says so and
 * offers to try again, rather than calling the setup a failure.
 */

const NODE_DOWNLOAD = 'https://nodejs.org/en/download';
const CHROME_DOWNLOAD = 'https://www.google.com/chrome/';

const isBrowserServer = (server) => server?.template === 'playwright'
    || (server?.args || []).some(arg => /@playwright\/mcp\b/.test(String(arg)));

/** The agent's servers, and its first browser among them. */
async function readServers(agentId) {
    const snapshot = await window.api.agents.list();
    const agent = snapshot?.agents?.find(entry => entry.id === agentId);
    const servers = agent?.mcpServers || [];
    return { servers, browser: servers.find(isBrowserServer) || null };
}

export default function BrowserUse({ settings, update, className = '' }) {
    const t = useT();
    const agentId = settings.agentId;

    const [browser, setBrowser] = useState(undefined);
    /**
     * Where the setup or the check stands:
     *   idle        nothing under way
     *   checking    looking at this computer
     *   needsNode   Node.js missing or too old
     *   installing  installing Node.js
     *   needsBrowser  no Chrome or Edge
     *   adding      putting the server on the agent
     *   testing     starting it once
     *   ready       it answered
     *   failed      it did not, or a step went wrong
     */
    const [phase, setPhase] = useState('idle');
    const [machine, setMachine] = useState(null);
    const [probe, setProbe] = useState(null);
    const [problem, setProblem] = useState('');
    const [installLine, setInstallLine] = useState('');
    const alive = useRef(true);

    useEffect(() => () => { alive.current = false; }, []);

    const load = useCallback(async () => {
        const { browser: found } = await readServers(agentId);
        if (!alive.current) return;
        setBrowser(found);
        // What is already known about it, so a page opened after a check
        // does not say "not checked" about a server that answered a minute ago.
        if (found) {
            const known = await window.api.agents.serverStatuses(agentId).catch(() => null);
            const status = known?.[found.id];
            if (alive.current && status && !status.checking) setProbe(status);
        }
    }, [agentId]);

    useEffect(() => {
        if (!agentId) return undefined;
        load().catch(() => setBrowser(null));
        return window.api.agents.onChange(() => { load().catch(() => {}); });
    }, [agentId, load]);

    useEffect(() => window.api.ai.onBrowser?.((state) => {
        if (state?.state === 'installing') setInstallLine(state.line || '');
    }), []);

    const on = Boolean(settings.browserUse && browser);
    const busy = ['checking', 'installing', 'adding', 'testing'].includes(phase);

    /** Start the server once and say whether it answered. */
    const test = useCallback(async (serverId) => {
        setPhase('testing');
        setProblem('');
        const result = await window.api.agents.checkServer({ agentId, serverId }).catch(error => ({ ok: false, error: error.message }));
        if (!alive.current) return;
        setProbe(result);
        setPhase(result?.ok ? 'ready' : 'failed');
    }, [agentId]);

    /**
     * From nothing to a browser the agent can use. Each step that finds
     * something missing stops there with what to do about it; the guide's
     * buttons come back here when it is done.
     */
    const setUp = useCallback(async () => {
        setProblem('');
        setPhase('checking');
        // Optional: a window loaded before the main process learned this
        // has no such call, and says the setup could not run instead.
        const found = await (window.api.ai.browserStatus?.() || Promise.resolve(null)).catch(() => null);
        if (!alive.current) return;
        if (!found) {
            setProblem(t('settings.agentic.browserSetupFailed'));
            setPhase('failed');
            return;
        }
        setMachine(found);
        if (!found?.node?.found || !found.node.recent) {
            setPhase('needsNode');
            return;
        }
        if (!found.preferred) {
            setPhase('needsBrowser');
            return;
        }

        setPhase('adding');
        const made = await window.api.agents.libraryInstantiate({
            template: 'playwright',
            values: { browser: found.preferred },
            name: 'Playwright',
            agentId,
        }).catch(error => ({ error: error.message }));
        if (!made?.server) {
            setProblem(made?.error || t('settings.agentic.browserSetupFailed'));
            setPhase('failed');
            return;
        }
        const { servers } = await readServers(agentId);
        const saved = await window.api.agents.save({ id: agentId, mcpServers: [...servers, made.server] })
            .catch(error => ({ error: error.message }));
        if (saved?.error) {
            setProblem(saved.error);
            setPhase('failed');
            return;
        }
        await update({ browserUse: true });
        const { browser: added } = await readServers(agentId);
        if (!alive.current) return;
        setBrowser(added);
        if (added) await test(added.id);
        else setPhase('idle');
    }, [agentId, update, test, t]);

    const toggle = useCallback(async (value) => {
        setProblem('');
        if (!value) {
            setPhase('idle');
            await update({ browserUse: false });
            return;
        }
        if (browser) {
            await update({ browserUse: true });
            await test(browser.id);
            return;
        }
        await setUp();
    }, [browser, update, test, setUp]);

    const installNode = useCallback(async () => {
        setPhase('installing');
        setInstallLine('');
        setProblem('');
        const result = await window.api.ai.browserInstallNode().catch(error => ({ ok: false, error: error.message }));
        if (!alive.current) return;
        if (!result?.ok) {
            setProblem(result?.error || t('settings.agentic.nodeInstallFailed'));
            setPhase('needsNode');
            return;
        }
        await setUp();
    }, [setUp, t]);

    /** The window shown or hidden: `--headless` in the server's arguments. */
    const setWindow = useCallback(async (shown) => {
        if (!browser) return;
        const { servers } = await readServers(agentId);
        const args = (browser.args || []).filter(arg => arg !== '--headless');
        if (!shown) args.push('--headless');
        await window.api.agents.save({
            id: agentId,
            mcpServers: servers.map(server => (server.id === browser.id ? { ...server, args } : server)),
        });
    }, [agentId, browser]);

    const extension = (browser?.args || []).includes('--extension');
    const hidden = (browser?.args || []).includes('--headless');
    const guiding = ['needsNode', 'needsBrowser', 'installing'].includes(phase)
        || (phase === 'failed' && !browser);

    const statusLine = () => {
        if (phase === 'checking') return <StatusLine tone="busy">{t('settings.agentic.browserChecking')}</StatusLine>;
        if (phase === 'adding') return <StatusLine tone="busy">{t('settings.agentic.browserAdding')}</StatusLine>;
        if (phase === 'testing') return <StatusLine tone="busy">{t('settings.agentic.browserTesting')}</StatusLine>;
        if (probe && !probe.ok) {
            const slow = /too long|timed out|timeout/i.test(probe.error || '');
            return (
                <div className="space-y-3">
                    <StatusLine tone="warn">
                        {slow ? t('settings.agentic.browserSlow') : t('settings.agentic.browserFailed', { error: probe.error || '' })}
                    </StatusLine>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => test(browser.id)}>
                        {t('settings.agentic.browserRetry')}
                    </Button>
                </div>
            );
        }
        if (probe?.ok) {
            return (
                <StatusLine tone="ok">
                    {t('settings.agentic.browserReady', { name: browser.name, count: (probe.tools || []).length })}
                </StatusLine>
            );
        }
        return (
            <div className="flex items-center gap-3 flex-wrap">
                <StatusLine tone="ok">{t('settings.agentic.browserSetUp', { name: browser.name })}</StatusLine>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => test(browser.id)}>
                    {t('settings.agentic.browserTest')}
                </Button>
            </div>
        );
    };

    const guide = () => {
        if (phase === 'installing') {
            return (
                <div className="space-y-2">
                    <StatusLine tone="busy">{t('settings.agentic.nodeInstalling')}</StatusLine>
                    {installLine && (
                        <p className="pl-3.5 text-xs font-jetbrains text-gray-500 dark:text-gray-400 truncate">{installLine}</p>
                    )}
                </div>
            );
        }
        if (phase === 'needsNode') {
            const old = machine?.node?.found && !machine.node.recent;
            return (
                <div className="space-y-3">
                    <StatusLine tone="warn">
                        {old
                            ? t('settings.agentic.nodeOld', { version: machine.node.version })
                            : t('settings.agentic.nodeMissing')}
                    </StatusLine>
                    {problem && <p className="pl-3.5 text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap">{problem}</p>}
                    <div className="flex items-center gap-2 flex-wrap pl-3.5">
                        {machine?.installer && (
                            <Button size="sm" variant="primary" onClick={installNode}>
                                {t('settings.agentic.nodeInstall')}
                            </Button>
                        )}
                        <Button size="sm" variant="secondary" onClick={() => window.api.links.open(NODE_DOWNLOAD)}>
                            {t('settings.agentic.nodeDownload')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={setUp}>
                            {t('settings.agentic.checkAgain')}
                        </Button>
                    </div>
                    {machine?.installer && (
                        <p className="pl-3.5 text-xs text-gray-500 dark:text-gray-400">
                            {t(`settings.agentic.nodeInstallNote.${machine.installer}`)}
                        </p>
                    )}
                </div>
            );
        }
        if (phase === 'needsBrowser') {
            return (
                <div className="space-y-3">
                    <StatusLine tone="warn">{t('settings.agentic.browserMissing')}</StatusLine>
                    <div className="flex items-center gap-2 flex-wrap pl-3.5">
                        <Button size="sm" variant="primary" onClick={() => window.api.links.open(CHROME_DOWNLOAD)}>
                            {t('settings.agentic.getChrome')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={setUp}>
                            {t('settings.agentic.checkAgain')}
                        </Button>
                    </div>
                </div>
            );
        }
        // A step of the setup went wrong before there was a server.
        return (
            <div className="space-y-3">
                <StatusLine tone="warn">{problem || t('settings.agentic.browserSetupFailed')}</StatusLine>
                <div className="pl-3.5">
                    <Button size="sm" variant="secondary" onClick={setUp}>{t('settings.agentic.browserRetry')}</Button>
                </div>
            </div>
        );
    };

    return (
        <Capability
            className={className}
            icon={BrowserIcon}
            title={t('settings.agentic.browser')}
            description={t('settings.agentic.browserDesc')}
            open={on || guiding || busy}
            control={(
                <Toggle
                    ariaLabel={t('settings.agentic.browser')}
                    checked={on || (busy && !browser)}
                    disabled={busy || browser === undefined}
                    onChange={toggle}
                />
            )}
        >
            {guiding && !on ? guide() : (
                <div className="space-y-5">
                    {browser ? statusLine() : (busy && statusLine())}

                    {browser && (extension ? (
                        <p className="text-xs text-gray-500 dark:text-gray-400">{t('settings.agentic.browserExtension')}</p>
                    ) : (
                        <div className="flex items-center justify-between gap-6">
                            <Detail
                                title={t('settings.agentic.browserWindow')}
                                description={t('settings.agentic.browserWindowDesc')}
                            />
                            <Toggle
                                ariaLabel={t('settings.agentic.browserWindow')}
                                checked={!hidden}
                                disabled={busy}
                                onChange={setWindow}
                            />
                        </div>
                    ))}

                    {browser && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                            {t('settings.agentic.browserManage', { name: browser.name })}
                        </p>
                    )}
                </div>
            )}
        </Capability>
    );
}

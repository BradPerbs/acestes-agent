import { useCallback, useState } from 'react';
import SettingsPage from '../ui/SettingsPage';
import SegmentedControl from '../../ui/SegmentedControl';
import TerminalSection from '../TerminalSection';
import MonitoringSection from '../MonitoringSection';
import SessionLogSection from '../SessionLogSection';
import KnownHostsSection from '../KnownHostsSection';
import ImportSection from '../ImportSection';
import AppImportSection from '../AppImportSection';
import { useT } from '../../../i18n';

/**
 * Everything about the servers and the terminal, on one page.
 *
 * This app is an agent that happens to carry a serious SSH client, and the
 * settings should read that way: the agent first, then the app, then the
 * machinery the agent works through. The facets of that subject (how the
 * shell looks, which hosts are watched, what of a session is written to
 * disk, which server keys are trusted, and what is brought in from existing
 * SSH setups) sit here as tabs under one heading rather than as a third of
 * the navigation.
 *
 * Tabs rather than one long scroll because the terminal section alone is
 * a dozen cards, and someone here to forget a host key should not have to
 * pass the font picker to find it.
 */

const TABS = ['terminal', 'monitoring', 'logging', 'knownHosts', 'import'];

/** The title and description keys each tab reuses from its former page. */
const LABELS = {
    terminal: { title: 'settings.terminal.title', desc: 'settings.terminal.desc' },
    monitoring: { title: 'settings.monitoring.title', desc: 'settings.monitoring.desc' },
    logging: { title: 'settings.logging.title', desc: 'settings.logging.desc' },
    knownHosts: { title: 'settings.knownHosts.title', desc: '' },
    import: { title: 'settings.importTab.title', desc: 'settings.importTab.desc' },
};

// Which tab was open last, for the same reason the panel remembers its page.
const TAB_KEY = 'settings.servers.tab';

const readTab = () => {
    try {
        const saved = localStorage.getItem(TAB_KEY);
        return TABS.includes(saved) ? saved : TABS[0];
    } catch {
        return TABS[0];
    }
};

export default function ServersPage(props) {
    const t = useT();
    const [tab, setTab] = useState(readTab);
    const [query, setQuery] = useState('');

    const changeTab = useCallback((next) => {
        setTab(next);
        try { localStorage.setItem(TAB_KEY, next); } catch { /* private mode */ }
    }, []);

    const description = LABELS[tab].desc ? t(LABELS[tab].desc) : '';

    const section = (id) => {
        if (id === 'terminal') return <TerminalSection {...props} />;
        if (id === 'monitoring') return <MonitoringSection />;
        if (id === 'logging') return <SessionLogSection />;
        if (id === 'knownHosts') return <KnownHostsSection />;
        return (
            <>
                <ImportSection onImported={props.onDataImported} />
                <AppImportSection onImported={props.onDataImported} />
            </>
        );
    };

    // A search covers every tab, not only the one that happened to be open:
    // the tabs are this page's way of staying short, and someone searching
    // does not know (or care) which of them the setting sits under. Each tab's
    // cards come under its name, and a tab with nothing matching drops out
    // whole; see lib/settings-search for how a group is judged.
    const searching = query.trim() !== '';

    return (
        <SettingsPage
            title={t('settings.servers.title')}
            description={t('settings.servers.desc')}
            query={query}
            onQueryChange={setQuery}
        >
            {!searching && (
                <div className="px-1 flex flex-col gap-3">
                    <SegmentedControl
                        ariaLabel={t('settings.servers.title')}
                        segments={TABS.map(value => ({ value, label: t(LABELS[value].title) }))}
                        value={tab}
                        onChange={changeTab}
                    />
                    {description && (
                        <p className="text-sm text-gray-500 dark:text-gray-400">{description}</p>
                    )}
                </div>
            )}

            {searching
                ? TABS.map(id => (
                    <section key={id} data-setting-group="" className="flex flex-col gap-3">
                        <h3 className="px-1 text-sm font-semibold text-gray-500 dark:text-gray-400">
                            {t(LABELS[id].title)}
                        </h3>
                        <div className="flex flex-col gap-6">{section(id)}</div>
                    </section>
                ))
                : section(tab)}
        </SettingsPage>
    );
}

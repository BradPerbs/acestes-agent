import { useCallback, useEffect, useState } from 'react';

/**
 * The assistant settings as the agent's pages read them: the selected agent's,
 * kept current while the composer (or another window) changes them.
 *
 * The agent's settings used to be one long page with one copy of this state.
 * They are four pages now (the agent, its permissions, what it can reach, the
 * chat), and each loads its own copy: only one page is mounted at a time, and
 * the read is a single IPC call.
 *
 * `providers` is which runtimes this build has, and `tools` the tool list the
 * agent is offered; both come from the same status read as the settings.
 */
export default function useAssistantSettings() {
    const [settings, setSettings] = useState(null);
    const [providers, setProviders] = useState([]);
    const [tools, setTools] = useState([]);
    const [toolBundles, setToolBundles] = useState([]);

    useEffect(() => {
        let cancelled = false;
        window.api.ai.status().then((status) => {
            if (cancelled || !status) return;
            setSettings(status.settings);
            setProviders(status.providers || []);
            setTools(status.tools || []);
            setToolBundles(status.toolBundles || []);
        }).catch(() => {});

        const off = window.api.ai.onSettings(setSettings);
        return () => {
            cancelled = true;
            off?.();
        };
    }, []);

    const update = useCallback(async (patch) => {
        const next = await window.api.ai.setSettings(patch);
        setSettings(next);
        return next;
    }, []);

    return { settings, providers, tools, toolBundles, update };
}

/** The field look the agent's pages use: text areas and address boxes. */
export const FIELD_CLASS = `w-full px-3 py-2 rounded-xl text-sm bg-white dark:bg-neutral-800
    border border-gray-300 dark:border-neutral-700
    text-gray-900 dark:text-gray-100 outline-none
    focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25`;

import { useEffect, useMemo, useState } from 'react';
import { useProxies } from './useProxies';
import { useSnippets } from './useSnippets';

/**
 * Everything in the selected agent's inventory that a message can tag with
 * `@`: its hosts, keys, proxies, snippets, notes and MCP servers, plus the
 * files in the folders granted to it, as one flat list the picker can filter.
 *
 * The classes that are already kept live for the whole app come from their own
 * hooks; the two that are not, the keychain and the memory, are read here and
 * followed. The workspace files are listed server-side, so the walk stays
 * inside the agent's envelope, and read again when the agents change, which
 * is also when a folder is granted or taken away. Nothing carries the text
 * of anything: a mention is a kind and an id, and the main process resolves
 * it when the message is sent.
 */

const inAgent = (agentId) => (record) => !record.agentId || !agentId || record.agentId === agentId;

export function useMentionables({ agentId = '', hosts = [] } = {}) {
    const { proxies: allProxies } = useProxies();
    const { snippets: allSnippets } = useSnippets();
    const [keys, setKeys] = useState([]);
    const [notes, setNotes] = useState([]);
    const [servers, setServers] = useState([]);
    const [workspaceFiles, setWorkspaceFiles] = useState([]);

    useEffect(() => {
        let cancelled = false;
        const read = () => window.api.keys.list()
            .then(list => { if (!cancelled) setKeys(list || []); })
            .catch(() => {});
        read();
        // The agent can add a key to the keychain mid-conversation.
        const off = window.api.inventory?.onChange?.((change) => {
            if (change?.kind === 'keys') read();
        });
        return () => {
            cancelled = true;
            off?.();
        };
    }, []);

    // The agent's MCP servers live on the agent record, so they arrive with
    // the registry rather than from a list of their own.
    useEffect(() => {
        let cancelled = false;
        const read = (snapshot) => {
            if (cancelled || !snapshot) return;
            const agent = snapshot.agents?.find(entry => entry.id === (agentId || snapshot.activeId));
            setServers(agent?.mcpServers || []);
        };
        window.api.agents.list().then(read).catch(() => {});
        const off = window.api.agents.onChange(read);
        return () => {
            cancelled = true;
            off?.();
        };
    }, [agentId]);

    useEffect(() => {
        let cancelled = false;
        const read = () => window.api.memory.list(agentId)
            .then(list => { if (!cancelled) setNotes(list || []); })
            .catch(() => {});
        if (agentId) read();
        return window.api.memory.onChange?.((change) => {
            if (!change?.agentId || change.agentId === agentId) read();
        }) || (() => { cancelled = true; });
    }, [agentId]);

    // The files in the folders granted to this agent. An agent with no
    // folders simply offers none, which is also what `@` showed before.
    useEffect(() => {
        let cancelled = false;
        const read = () => {
            if (!agentId || typeof window.api.ssh?.workspaceFiles !== 'function') {
                if (!cancelled) setWorkspaceFiles([]);
                return;
            }
            window.api.ssh.workspaceFiles(agentId)
                .then(list => { if (!cancelled) setWorkspaceFiles(list || []); })
                .catch(() => { if (!cancelled) setWorkspaceFiles([]); });
        };
        read();
        const off = window.api.agents.onChange?.(() => read());
        return () => {
            cancelled = true;
            off?.();
        };
    }, [agentId]);

    return useMemo(() => {
        const mine = inAgent(agentId);
        const items = [];

        for (const host of hosts.filter(mine)) {
            const address = host.protocol === 'serial'
                ? (host.serial?.path || '')
                : [host.host, host.port && host.port !== 22 ? host.port : ''].filter(Boolean).join(':');
            items.push({
                kind: 'host',
                id: host.id,
                name: host.name || host.host || host.id,
                hint: host.username ? `${host.username}@${address}` : address,
                os: host.os,
                distro: host.distro,
                tags: host.tags || [],
            });
        }

        for (const snippet of allSnippets.filter(mine)) {
            items.push({
                kind: 'snippet',
                id: snippet.id,
                name: snippet.name,
                hint: snippet.description || snippet.kind,
                snippetKind: snippet.kind,
                tags: snippet.tags || [],
            });
        }

        for (const note of notes) {
            items.push({
                kind: 'memory',
                id: note.id,
                name: note.tags?.[0] ? `#${note.tags[0]}` : note.text.slice(0, 40),
                hint: note.text,
                tags: note.tags || [],
            });
        }

        for (const proxy of allProxies.filter(mine)) {
            items.push({
                kind: 'proxy',
                id: proxy.id,
                name: proxy.name || proxy.host,
                hint: `${String(proxy.type || '').toUpperCase()} ${proxy.host}:${proxy.port}`.trim(),
            });
        }

        for (const key of keys.filter(mine)) {
            items.push({
                kind: 'key',
                id: key.id,
                name: key.name,
                hint: key.type || 'key',
            });
        }

        for (const server of servers) {
            items.push({
                kind: 'mcp',
                id: server.id,
                name: server.name,
                hint: server.transport === 'http' ? server.url : server.command,
            });
        }

        for (const file of workspaceFiles) {
            if (!file?.id || !file?.name) continue;
            items.push({
                kind: 'file',
                id: file.id,
                name: file.name,
                hint: file.hint || file.id,
            });
        }

        return items;
    }, [agentId, hosts, allSnippets, allProxies, keys, notes, servers, workspaceFiles]);
}

export default useMentionables;

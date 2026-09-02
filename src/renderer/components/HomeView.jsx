import { memo } from 'react';
import ConversationsPanel from './ConversationsPanel';
import InventoryTabs, { INVENTORY_PAGES } from './InventoryTabs';
import InventoryOverview from './InventoryOverview';
import McpPanel from './McpPanel';
import MemoryPanel from './MemoryPanel';
import HostsPanel from './HostsPanel';
import KeychainPanel from './KeychainPanel';
import ProxiesPanel from './ProxiesPanel';
import SnippetsPanel from './SnippetsPanel';
import LogsPanel from './LogsPanel';
import RunsPanel from './RunsPanel';
import SettingsPanel from './settings/SettingsPanel';

function HomeView({
    activeNav,
    // Home stays mounted behind a terminal tab. Panels that can open a sheet
    // need to know when they are no longer the thing on screen.
    isActive = true,
    // Bumped when the chrome asks for the page that is already up, which is a
    // way of asking for whatever is over it to go. See App.
    reachedForPage = 0,
    hosts,
    folders,
    allHosts,
    allFolders,
    currentFolderId,
    connectedHostIds,
    theme,
    appColors,
    terminalTheme,
    customTerminalTheme,
    terminalSettings,
    terminalFonts,
    onThemeChange,
    onAppColorsChange,
    onTerminalThemeChange,
    onCustomTerminalThemeChange,
    onTerminalSettingsChange,
    onTerminalSettingsReset,
    onDataImported,
    onNewHost,
    onEditHost,
    onDuplicateHost,
    onDeleteHost,
    onConnect,
    onNewFolder,
    onCreateFolder,
    onEditFolder,
    onDeleteFolder,
    onDeleteMany,
    onNavigateFolder,
    onArrange,
    onTagHosts,
    // The selected agent, whose inventory and conversations these are
    agentId,
    agentColor,
    activeAgent,
    onSaveAgentServers,
    onNavChange,
    // Conversations props
    conversations,
    onRefreshConversations,
    openConversationIds,
    onOpenConversation,
    onNewConversation,
    onDeleteConversation,
    onPinConversation,
    // Keychain props
    keys,
    onLoadKeys,
    onSaveKey,
    onDeleteKey,
    onGenerateKey,
}) {
    return (
        <div className="absolute inset-0 flex flex-col p-6 overflow-y-auto" id="home-view">
            {/* The inventory is one sidebar entry and several pages; the row
                of tabs is what moves between them. */}
            {INVENTORY_PAGES.includes(activeNav) && (
                <InventoryTabs active={activeNav} onChange={onNavChange} />
            )}

            {activeNav === 'overview' && (
                <InventoryOverview
                    hosts={allHosts}
                    keys={keys}
                    agentId={agentId}
                    activeAgent={activeAgent}
                    onOpen={onNavChange}
                />
            )}

            {activeNav === 'mcp' && (
                <McpPanel agent={activeAgent} onSave={onSaveAgentServers} />
            )}

            {activeNav === 'memory' && (
                <MemoryPanel agentId={agentId} />
            )}

            {activeNav === 'conversations' && (
                <ConversationsPanel
                    conversations={conversations}
                    agentId={agentId}
                    agentColor={agentColor}
                    onRefresh={onRefreshConversations}
                    openIds={openConversationIds}
                    onOpen={onOpenConversation}
                    onNew={onNewConversation}
                    onDelete={onDeleteConversation}
                    onPin={onPinConversation}
                />
            )}

            {activeNav === 'hosts' && (
                <HostsPanel
                    isActive={isActive}
                    reachedForPage={reachedForPage}
                    hosts={hosts}
                    folders={folders}
                    allHosts={allHosts}
                    allFolders={allFolders}
                    currentFolderId={currentFolderId}
                    connectedHostIds={connectedHostIds}
                    onNewHost={onNewHost}
                    onEditHost={onEditHost}
                    onDuplicateHost={onDuplicateHost}
                    onDeleteHost={onDeleteHost}
                    onConnect={onConnect}
                    onNewFolder={onNewFolder}
                    onCreateFolder={onCreateFolder}
                    onEditFolder={onEditFolder}
                    onDeleteFolder={onDeleteFolder}
                    onDeleteMany={onDeleteMany}
                    onNavigateFolder={onNavigateFolder}
                    onArrange={onArrange}
                    onTagHosts={onTagHosts}
                />
            )}

            {activeNav === 'keychain' && (
                <KeychainPanel
                    isActive={isActive}
                    reachedForPage={reachedForPage}
                    keys={keys}
                    // So a key can say how many hosts are relying on it, and so
                    // deleting one can name them rather than breaking them
                    // quietly at the next connection attempt.
                    allHosts={allHosts}
                    onLoadKeys={onLoadKeys}
                    onSaveKey={onSaveKey}
                    onDeleteKey={onDeleteKey}
                    onGenerateKey={onGenerateKey}
                />
            )}

            {activeNav === 'proxies' && (
                // `allHosts` so a proxy can say how many hosts are dialling
                // through it, and so deleting one can name them rather than
                // quietly putting their traffic back on the local network.
                <ProxiesPanel isActive={isActive} reachedForPage={reachedForPage} allHosts={allHosts} agentId={agentId} />
            )}

            {activeNav === 'snippets' && (
                <SnippetsPanel isActive={isActive} reachedForPage={reachedForPage} allHosts={allHosts} agentId={agentId} />
            )}

            {activeNav === 'runs' && (
                <RunsPanel agentId={agentId} />
            )}

            {activeNav === 'logs' && (
                <LogsPanel isActive={isActive} reachedForPage={reachedForPage} />
            )}

            {activeNav === 'settings' && (
                <SettingsPanel
                    theme={theme}
                    appColors={appColors}
                    terminalTheme={terminalTheme}
                    customTerminalTheme={customTerminalTheme}
                    terminalSettings={terminalSettings}
                    terminalFonts={terminalFonts}
                    onThemeChange={onThemeChange}
                    onAppColorsChange={onAppColorsChange}
                    onTerminalThemeChange={onTerminalThemeChange}
                    onCustomTerminalThemeChange={onCustomTerminalThemeChange}
                    onTerminalSettingsChange={onTerminalSettingsChange}
                    onTerminalSettingsReset={onTerminalSettingsReset}
                    onDataImported={onDataImported}
                />
            )}
        </div>
    );
}

export default memo(HomeView);

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/* ------------------------------------------------------------------ *
 * Terminal data channel
 *
 * MessagePorts cannot cross the context bridge, so the preload owns them and
 * exposes a callback API instead. Keystrokes that arrive before the port is
 * established are queued rather than dropped.
 * ------------------------------------------------------------------ */

const ports = new Map();        // tabId -> MessagePort
const handlers = new Map();     // tabId -> callback
const pending = new Map();      // tabId -> queued messages

// Every open tab subscribes to the broadcast channels (disconnects, transfer
// updates, resume). The default ceiling of 10 would start warning at five tabs.
ipcRenderer.setMaxListeners(200);

ipcRenderer.on('ssh-port', (event, { tabId }) => {
    const port = event.ports?.[0];
    if (!port) return;

    // A reconnect hands out a fresh port for the same tab; the old one has to
    // go or it leaks and its queued messages never land anywhere.
    const previous = ports.get(tabId);
    if (previous) {
        previous.onmessage = null;
        try {
            previous.close();
        } catch {
            // Already closed with the session it belonged to.
        }
    }

    ports.set(tabId, port);

    port.onmessage = (message) => {
        const handler = handlers.get(tabId);
        if (!handler) return;
        if (typeof message.data === 'string') {
            handler({ type: 'data', data: message.data });
        } else if (message.data?.type === 'disconnected') {
            handler({ type: 'disconnected' });
        }
    };
    port.start();

    const queued = pending.get(tabId);
    if (queued) {
        for (const message of queued) port.postMessage(message);
        pending.delete(tabId);
    }
});

function post(tabId, message) {
    const port = ports.get(tabId);
    if (port) {
        port.postMessage(message);
        return;
    }
    const queue = pending.get(tabId) || [];
    queue.push(message);
    pending.set(tabId, queue);
}

function closePort(tabId) {
    const port = ports.get(tabId);
    if (port) {
        port.close();
        ports.delete(tabId);
    }
    handlers.delete(tabId);
    pending.delete(tabId);
}

/** Subscribe to a main-process event, returning an unsubscribe function. */
function subscribe(channel, callback) {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
    hosts: {
        list: () => ipcRenderer.invoke('get-hosts'),
        save: (host) => ipcRenderer.invoke('save-host', host),
        remove: (hostId) => ipcRenderer.invoke('delete-host', hostId),
        // Copied in main, where the credentials are: a copy made by saving the
        // redacted record back would come out unable to log in.
        duplicate: (hostId) => ipcRenderer.invoke('duplicate-host', hostId),
        /**
         * Add and remove tags across several hosts at once:
         * `{ hostIds, add, remove }`. One call however many were selected, so
         * tagging a dozen is a single write rather than a dozen saves.
         */
        tag: (edit) => ipcRenderer.invoke('tag-hosts', edit),

        /**
         * Dial an address that was typed rather than saved: `10.0.0.5`,
         * `root@10.0.0.5:2222`, `box.example.com`.
         *
         * Main parses it and answers `{ success, message, host }`, where the
         * host is an ordinary redacted record that exists for this app run
         * only. Connect it by id like any other; nothing is written to disk,
         * and the login is asked for on the pane while it dials.
         */
        quickConnect: (address) => ipcRenderer.invoke('host-quick-connect', String(address || '')),
    },

    folders: {
        list: () => ipcRenderer.invoke('get-folders'),
        save: (folder) => ipcRenderer.invoke('save-folder', folder),
        remove: (folderId) => ipcRenderer.invoke('delete-folder', folderId),
    },

    /**
     * Where records sit: which folder they belong to and in what order. Spans
     * both collections because one drag can move a folder and renumber the
     * hosts it landed among, and that should be a single write.
     */
    arrange: {
        apply: (changes) => ipcRenderer.invoke('arrange-items', changes),
    },

    keys: {
        list: () => ipcRenderer.invoke('get-keys'),
        save: (key) => ipcRenderer.invoke('save-key', key),
        remove: (keyId) => ipcRenderer.invoke('delete-key', keyId),
        generate: (options) => ipcRenderer.invoke('generate-key', options),
        // Pick a key file. Main reads it and keeps the private half, so what
        // comes back is an id to claim it with plus the public halves.
        importFile: (options) => ipcRenderer.invoke('import-key-file', options),
        // Whether this machine can hold a key in its TPM behind Windows Hello,
        // and the enrolment that puts one there.
        helloSupported: () => ipcRenderer.invoke('hello-supported'),
        createHello: (options) => ipcRenderer.invoke('create-hello-key', options),
    },

    snippets: {
        list: () => ipcRenderer.invoke('get-snippets'),
        save: (snippet) => ipcRenderer.invoke('save-snippet', snippet),
        remove: (snippetId) => ipcRenderer.invoke('delete-snippet', snippetId),
    },

    /**
     * Saved proxies: SOCKS5, SOCKS4 and HTTP CONNECT servers a host can be
     * dialled through, whatever it speaks once it is connected.
     *
     * A proxy's password comes back only as `hasPassword`, like every other
     * stored secret. It goes the other way when it is first typed, which is the
     * only direction a secret ever travels, and `test` may carry one for the same
     * reason: checking settings that have not been saved yet is most of what
     * checking is for.
     */
    proxies: {
        list: () => ipcRenderer.invoke('get-proxies'),
        save: (record) => ipcRenderer.invoke('save-proxy', record),
        remove: (proxyId) => ipcRenderer.invoke('delete-proxy', proxyId),
        duplicate: (proxyId) => ipcRenderer.invoke('duplicate-proxy', proxyId),
        // `{ proxyId }` for a saved record, `{ proxy }` for a draft.
        test: (payload) => ipcRenderer.invoke('proxies-test', payload || {}),
    },

    store: {
        status: () => ipcRenderer.invoke('store-status'),
    },

    // The audit trail: connections made, records edited, remote files touched.
    // Read-only from here apart from clearing it: entries are written by the
    // main process at the point the thing actually happened, never by the
    // renderer asking for a line to be added.
    activity: {
        list: (options) => ipcRenderer.invoke('activity-list', options || {}),
        summary: () => ipcRenderer.invoke('activity-summary'),
        clear: () => ipcRenderer.invoke('activity-clear'),
        export: () => ipcRenderer.invoke('activity-export'),

        onAppend: (callback) => subscribe('activity-append', callback),
        onCleared: (callback) => subscribe('activity-cleared', callback),
    },

    /**
     * Session transcripts: what the server printed, written to a file.
     *
     * Write-only from here in the sense that matters: the renderer can turn
     * recording on, off and find the files, but the transcript never travels
     * back across the bridge. It is captured in main, where the bytes arrive,
     * so a reload cannot punch a hole in it.
     */
    sessionLog: {
        config: () => ipcRenderer.invoke('session-log-config'),
        configure: (patch) => ipcRenderer.invoke('session-log-configure', patch || {}),
        chooseDirectory: () => ipcRenderer.invoke('session-log-choose-directory'),
        resetDirectory: () => ipcRenderer.invoke('session-log-reset-directory'),
        openFolder: () => ipcRenderer.invoke('session-log-open-folder'),

        status: (tabId) => ipcRenderer.invoke('session-log-status', tabId),
        start: (tabId) => ipcRenderer.invoke('session-log-start', tabId),
        stop: (tabId) => ipcRenderer.invoke('session-log-stop', tabId),

        list: (options) => ipcRenderer.invoke('session-log-list', options || {}),
        reveal: (filePath) => ipcRenderer.invoke('session-log-reveal', filePath),
    },

    // Optional password required to open the app. Main refuses everything else
    // while locked, so these are the only calls that answer before unlocking.
    appLock: {
        status: () => ipcRenderer.invoke('app-lock-status'),
        unlock: (password) => ipcRenderer.invoke('app-lock-unlock', password),
        set: (password) => ipcRenderer.invoke('app-lock-set', password),
        change: (current, next) => ipcRenderer.invoke('app-lock-change', { current, next }),
        disable: (password) => ipcRenderer.invoke('app-lock-disable', password),
        lock: () => ipcRenderer.invoke('app-lock-lock'),
        // Fired when main re-locks, so the renderer can drop back to the lock
        // screen without being the thing that decided to.
        onLocked: (callback) => subscribe('app-locked', callback),
    },

    // A pane's session, whatever it runs over. Named for SSH because that is
    // what every session was when this was written and what almost all of them
    // still are; main reads the host record and picks between SSH, telnet and a
    // serial port. Nothing on this side has to know which it got: the port
    // carries bytes either way.
    ssh: {
        connect: ({ tabId, hostId, cols, rows }) =>
            ipcRenderer.invoke('ssh-connect', { tabId, hostId, cols, rows }),
        disconnect: (tabId) => ipcRenderer.invoke('ssh-disconnect', tabId),
        detectOS: (tabId) => ipcRenderer.invoke('ssh-detect-os', tabId),
        // Adopt a session that is already open in main (opened by the agent
        // with no window up). The port arrives on `ssh-port` as for a dial,
        // carrying what the session has shown so far.
        attach: (tabId) => ipcRenderer.invoke('ssh-attach', tabId),
        // The sessions no window is drawing yet.
        headless: () => ipcRenderer.invoke('sessions-headless'),
        onHeadless: (callback) => subscribe('session-headless', callback),

        sendInput: (tabId, data) => post(tabId, { type: 'input', data }),
        resize: (tabId, cols, rows) => post(tabId, { type: 'resize', cols, rows }),

        onData: (tabId, callback) => {
            handlers.set(tabId, callback);
            return () => handlers.delete(tabId);
        },
        release: (tabId) => closePort(tabId),

        // Shells on this computer, for the terminals beside a conversation.
        // Opening an id that is running attaches to it, so a remounted panel
        // gets its shell back. Data, input and resize are the calls above.
        localShells: (options) => ipcRenderer.invoke('local-terminal-shells', options || {}),
        // The agent's folders a terminal can start in, for the picker.
        localFolders: (agentId) => ipcRenderer.invoke('local-terminal-folders', agentId),
        openLocal: ({ id, agentId, shellId, cwd, cols, rows }) =>
            ipcRenderer.invoke('local-terminal-open', { id, agentId, shellId, cwd, cols, rows }),
        closeLocal: (id) => ipcRenderer.invoke('local-terminal-close', id),
        // Every terminal of one project, when the project goes.
        closeLocalGroup: (group) => ipcRenderer.invoke('local-terminal-close-group', group),

        onDisconnected: (callback) => subscribe('ssh-disconnected', callback),
    },

    agent: {
        // `agentPath` blank means "auto-detect"; main resolves it.
        status: (agentPath) => ipcRenderer.invoke('agent-status', agentPath || ''),
        defaultPath: () => ipcRenderer.invoke('agent-default-path'),
    },

    // The serial ports this machine can see, for the picker in the host editor.
    // Answers `{ available, message, ports }` rather than throwing when the
    // serial binding is missing, so the editor can say why the list is empty.
    serial: {
        listPorts: () => ipcRenderer.invoke('serial-list-ports'),
    },

    auth: {
        // Keyboard-interactive rounds the app cannot answer on its own: a
        // one-time code, a push approval, an expired password.
        onPrompt: (callback) => subscribe('auth-prompt', callback),
        // `answers` omitted (or null) cancels the attempt.
        respond: (requestId, answers) =>
            ipcRenderer.invoke('auth-prompt-response', { requestId, answers }),
    },

    hostKeys: {
        onPrompt: (callback) => subscribe('host-key-prompt', callback),
        respond: (requestId, accepted) =>
            ipcRenderer.invoke('host-key-response', { requestId, accepted }),
        list: () => ipcRenderer.invoke('known-hosts-list'),
        forget: (host, port) => ipcRenderer.invoke('known-hosts-forget', { host, port }),
        forgetById: (id) => ipcRenderer.invoke('known-hosts-forget-id', id),
        forgetKey: (id, fingerprint) =>
            ipcRenderer.invoke('known-hosts-forget-key', { id, fingerprint }),
    },

    sftp: {
        init: (tabId) => ipcRenderer.invoke('sftp-init', tabId),
        close: (tabId) => ipcRenderer.invoke('sftp-close', tabId),

        list: (tabId, remotePath) => ipcRenderer.invoke('sftp-list', { tabId, remotePath }),
        home: (tabId) => ipcRenderer.invoke('sftp-home', tabId),
        realpath: (tabId, remotePath) => ipcRenderer.invoke('sftp-realpath', { tabId, remotePath }),
        stat: (tabId, remotePath, follow = true) =>
            ipcRenderer.invoke('sftp-stat', { tabId, remotePath, follow }),
        diskUsage: (tabId, remotePath) => ipcRenderer.invoke('sftp-disk-usage', { tabId, remotePath }),

        mkdir: (tabId, remotePath) => ipcRenderer.invoke('sftp-mkdir', { tabId, remotePath }),
        createFile: (tabId, remotePath) => ipcRenderer.invoke('sftp-create-file', { tabId, remotePath }),
        remove: (tabId, remotePaths) => ipcRenderer.invoke('sftp-delete', { tabId, remotePaths }),
        rename: (tabId, oldPath, newPath) =>
            ipcRenderer.invoke('sftp-rename', { tabId, oldPath, newPath }),
        chmod: (tabId, remotePath, mode, recursive = false) =>
            ipcRenderer.invoke('sftp-chmod', { tabId, remotePath, mode, recursive }),
        copy: (tabId, sources, destinationDir, move = false) =>
            ipcRenderer.invoke('sftp-copy', { tabId, sources, destinationDir, move }),

        // Fired when a completed transfer may have changed the remote tree.
        onChanged: (callback) => subscribe('sftp-changed', callback),
    },

    transfers: {
        enqueue: (tabId, options) => ipcRenderer.invoke('sftp-transfer-enqueue', { tabId, ...options }),
        list: (tabId) => ipcRenderer.invoke('sftp-transfer-list', tabId),
        cancel: (id) => ipcRenderer.invoke('sftp-transfer-cancel', id),
        cancelAll: (tabId) => ipcRenderer.invoke('sftp-transfer-cancel-all', tabId),
        retry: (id) => ipcRenderer.invoke('sftp-transfer-retry', id),
        clearFinished: (tabId) => ipcRenderer.invoke('sftp-transfer-clear', tabId),

        respondToConflict: (requestId, decision) =>
            ipcRenderer.invoke('sftp-conflict-response', { requestId, decision }),

        onUpdate: (callback) => subscribe('sftp-transfers', callback),
        onConflict: (callback) => subscribe('sftp-conflict', callback),
        onConflictResolved: (callback) => subscribe('sftp-conflict-resolved', callback),
    },

    tunnels: {
        list: (tabId) => ipcRenderer.invoke('tunnels-list', tabId),
        sync: (tabId, hostId) => ipcRenderer.invoke('tunnels-sync', { tabId, hostId }),
        start: (tabId, tunnelId) => ipcRenderer.invoke('tunnels-start', { tabId, tunnelId }),
        stop: (tabId, tunnelId) => ipcRenderer.invoke('tunnels-stop', { tabId, tunnelId }),
        startAll: (tabId) => ipcRenderer.invoke('tunnels-start-all', tabId),
        stopAll: (tabId) => ipcRenderer.invoke('tunnels-stop-all', tabId),

        onUpdate: (callback) => subscribe('tunnels-update', callback),
    },


    importer: {
        paths: () => ipcRenderer.invoke('import-paths'),
        // Which of the importable apps (OpenSSH, PuTTY, KiTTY, MobaXterm)
        // actually have sessions on this machine.
        detect: () => ipcRenderer.invoke('import-detect'),
        scan: (options) => ipcRenderer.invoke('import-scan', options || {}),
        apply: (options) => ipcRenderer.invoke('import-apply', options || {}),
    },

    backup: {
        // Main owns the file dialogs and the decrypted payload; only the
        // passphrase goes in and only counts come back.
        export: (passphrase) => ipcRenderer.invoke('backup-export', { passphrase }),
        inspect: (passphrase, filePath) =>
            ipcRenderer.invoke('backup-inspect', { passphrase, filePath }),
        restore: (token, overwrite) =>
            ipcRenderer.invoke('backup-restore', { token, overwrite }),
        discard: (token) => ipcRenderer.invoke('backup-discard', token),
    },

    account: {
        // No token ever crosses this bridge. Main runs the OAuth exchange and
        // holds the credential; the renderer only learns which account is
        // connected and what the console said.
        status: () => ipcRenderer.invoke('account-status'),
        signIn: () => ipcRenderer.invoke('account-sign-in'),
        cancelSignIn: () => ipcRenderer.invoke('account-sign-in-cancel'),
        signOut: () => ipcRenderer.invoke('account-sign-out'),
        refresh: () => ipcRenderer.invoke('account-refresh'),
        servers: () => ipcRenderer.invoke('account-servers'),
        // Signing in or out from Settings has to reach the sidebar, which did
        // not ask for it.
        onState: (callback) => subscribe('account-state', callback),
    },

    serverSync: {
        status: () => ipcRenderer.invoke('server-sync-status'),
        setEnabled: (enabled) => ipcRenderer.invoke('server-sync-set-enabled', enabled),
        now: () => ipcRenderer.invoke('server-sync-now'),
        // Fired after any sync, including the ones on a timer that nothing in
        // the renderer asked for, so the host list can refresh itself.
        onState: (callback) => subscribe('server-sync-state', callback),
    },

    /**
     * Watching whether hosts are still answering.
     *
     * Everything here is main's: it owns the timer, the states and the Windows
     * notifications, because a renderer that was reloading would be a renderer
     * not noticing a server go down. This side reads the states and changes the
     * settings, and never learns an address it did not already have from the
     * host list.
     *
     * There is no list of past alerts to read. A host crossing between states
     * raises a notification and writes an activity entry, and the activity log
     * is where it stays; keeping a second copy in memory for a panel to show
     * would be two records of one thing.
     */
    monitor: {
        status: () => ipcRenderer.invoke('monitor-status'),
        configure: (patch) => ipcRenderer.invoke('monitor-configure', patch || {}),
        // Sweeps now, at the next opportunity rather than the next interval.
        checkNow: () => ipcRenderer.invoke('monitor-check-now'),

        // Every sweep and every state change. Nothing in the renderer asked for
        // these, which is the point: the host cards and the bell keep up with a
        // timer they do not own.
        onState: (callback) => subscribe('monitor-state', callback),
    },

    cloudSnapshot: {
        status: () => ipcRenderer.invoke('cloud-snapshot-status'),
        setEnabled: (enabled) => ipcRenderer.invoke('cloud-snapshot-set-enabled', enabled),
        push: () => ipcRenderer.invoke('cloud-snapshot-push'),
        pull: () => ipcRenderer.invoke('cloud-snapshot-pull'),
        // Terminal settings live in localStorage, so the renderer is the only
        // side that can see them change.
        reportSettings: (settings) => ipcRenderer.invoke('cloud-snapshot-settings', settings),
        onState: (callback) => subscribe('cloud-snapshot-state', callback),
        // A pull brought settings down from another device.
        onSettings: (callback) => subscribe('cloud-snapshot-settings', callback),
    },

    remoteEdit: {
        open: (tabId, remotePath) => ipcRenderer.invoke('sftp-edit-open', { tabId, remotePath }),
        stop: (tabId, remotePath) => ipcRenderer.invoke('sftp-edit-stop', { tabId, remotePath }),
        list: (tabId) => ipcRenderer.invoke('sftp-edit-list', tabId),
        onStatus: (callback) => subscribe('sftp-edit-status', callback),
    },

    local: {
        downloadsDir: () => ipcRenderer.invoke('local-home'),
        reveal: (localPath) => ipcRenderer.invoke('local-reveal', localPath),

        // Where a dropped File actually lives on disk. `File.path` used to
        // carry this and was removed in Electron 32, because a renderer that
        // can read it learns real filesystem paths from any drop. It is a
        // preload-only API now, so the path is resolved on this side of the
        // bridge and the renderer only ever sees the string it asked for.
        pathForFile: (file) => {
            try {
                return webUtils.getPathForFile(file);
            } catch {
                // Not a real File (or one with no backing path, e.g. dragged
                // out of another app's virtual folder). Callers filter these.
                return '';
            }
        },
    },

    links: {
        // Main allowlists the scheme; a link out of a terminal is untrusted input.
        open: (url) => ipcRenderer.invoke('open-external', url),
    },

    system: {
        // Machine woke from sleep or the screen was unlocked.
        onResume: (callback) => subscribe('system-resume', callback),
        // What the app's own processes hold, in bytes, split by kind.
        memory: () => ipcRenderer.invoke('app-memory'),
        // Keeping the machine from sleeping while the app runs: `{ awake, since }`.
        keepAwake: () => ipcRenderer.invoke('keep-awake-status'),
        setKeepAwake: (on) => ipcRenderer.invoke('keep-awake-set', Boolean(on)),
    },

    /**
     * Whether the app launches itself when the machine starts.
     *
     * The system holds the answer (a Run key entry on Windows, a login item on
     * macOS), so `status` asks it rather than reading a setting of ours, and
     * both calls answer with `supported` and a reason: a development run and a
     * platform with no login items are both switches that cannot be offered.
     */
    startup: {
        status: () => ipcRenderer.invoke('startup-status'),
        setEnabled: (enabled) => ipcRenderer.invoke('startup-set-enabled', enabled),
    },

    dialog: {
        save: (options) => ipcRenderer.invoke('show-save-dialog', options || {}),
        open: (options) => ipcRenderer.invoke('show-open-dialog', options || {}),
    },

    clipboard: {
        readText: () => ipcRenderer.invoke('clipboard-read-text'),
        writeText: (text) => ipcRenderer.invoke('clipboard-write-text', text),
    },

    screenshot: {
        capture: (options) => ipcRenderer.invoke('screenshot-capture', options),
        get: (id) => ipcRenderer.invoke('screenshot-get', id),
        copy: (id) => ipcRenderer.invoke('screenshot-copy', id),
        save: (id) => ipcRenderer.invoke('screenshot-save', id),
        reveal: (filePath) => ipcRenderer.invoke('screenshot-reveal', filePath),
        close: () => ipcRenderer.invoke('screenshot-close'),
    },

    updates: {
        // `status.mode` says which of the two shapes this is. On a build main
        // can get a signature checked for, these move a real installer along.
        // On one it cannot, they are a notice and a link and nothing else, and
        // the renderer has to say so rather than promise an install.
        status: () => ipcRenderer.invoke('updates-status'),
        // The button. Rate limited in main, which is why it answers with a
        // message rather than just a status.
        check: () => ipcRenderer.invoke('updates-check'),
        // The retry. Nothing normally calls it: an available update is already
        // downloading by the time the renderer hears about it.
        download: () => ipcRenderer.invoke('updates-download'),
        // Closes the app. Nothing after this resolves, because there is
        // nothing left to resolve into.
        install: () => ipcRenderer.invoke('updates-install'),
        open: () => ipcRenderer.invoke('updates-open'),
        dismiss: () => ipcRenderer.invoke('updates-dismiss'),
        // The daily check is not one the renderer asked for, a check started
        // from Settings has to reach the bell in the title bar, and download
        // progress is nobody's request at all.
        onState: (callback) => subscribe('updates-state', callback),
    },

    /**
     * The assistant. Named `ai` rather than `agent`, which is already taken by
     * the SSH agent and means something entirely different.
     *
     * A conversation lives in the main process, not here. This surface starts
     * one, feeds it text, and subscribes to the event stream it produces; a
     * window reload loses the panel and none of the conversation, which is why
     * `history` exists.
     */
    ai: {
        status: () => ipcRenderer.invoke('ai-status'),
        setSettings: (patch) => ipcRenderer.invoke('ai-settings-set', patch),
        // The settings, whenever anything changes them. Both the panel and the
        // settings page show some of these and can be open at once.
        onSettings: (callback) => subscribe('ai-settings', callback),
        // The models the installed Claude Code reports it can run, and the
        // effort levels each of them takes. Arrives once the runtime has
        // started, which is the first time it can be asked, so it is pushed
        // rather than only being read from `status`.
        onModels: (callback) => subscribe('ai-models', callback),
        // Asks for the list, starting the runtime briefly if that is what it
        // takes. Resolves null when this machine's Claude Code cannot say.
        // `provider` names which agent to ask, since several can be switched on
        // at once, and defaults to the one answering. `refresh` throws away
        // what was read for that agent and asks again, for the button the menu
        // shows when a read came back empty.
        models: ({ refresh = false, provider = '' } = {}) =>
            ipcRenderer.invoke('ai-model-list', { refresh, provider }),
        // Whether one agent could run on this machine, for the moment before it
        // is switched on. Resolves `{ ok, reason }`; an agent with nothing to
        // find on disk answers yes.
        detect: (provider) => ipcRenderer.invoke('ai-detect', provider),

        // The sign-ins each runtime can run under, and how much of each plan
        // is left. `overview` answers `{ accounts, limits, logins }`: accounts
        // by runtime, the machine's own first; limits by `runtime:account`.
        accounts: {
            overview: () => ipcRenderer.invoke('ai-accounts'),
            add: ({ provider, label, home } = {}) => ipcRenderer.invoke('ai-accounts-add', { provider, label, home }),
            rename: (id, label) => ipcRenderer.invoke('ai-accounts-rename', { id, label }),
            remove: (id) => ipcRenderer.invoke('ai-accounts-remove', id),
            discover: (provider) => ipcRenderer.invoke('ai-accounts-discover', provider),
            pickFolder: () => ipcRenderer.invoke('ai-accounts-pick-folder'),
            // Without `provider`, every account of every runtime.
            check: ({ provider, accountId } = {}) => ipcRenderer.invoke('ai-accounts-check', { provider, accountId }),
            login: (provider, accountId) => ipcRenderer.invoke('ai-accounts-login', { provider, accountId }),
            cancelLogin: (provider, accountId) => ipcRenderer.invoke('ai-accounts-login-cancel', { provider, accountId }),
            onChanged: (callback) => subscribe('ai-accounts-changed', callback),
            onLimits: (callback) => subscribe('ai-limits', callback),
            // `{ provider, accountId, phase, url, line, message }`, phase being
            // started, waiting, done or failed.
            onLogin: (callback) => subscribe('ai-account-login', callback),
        },

        // `sessionIds` and `hostIds` are the explicit set a pinned scope fences
        // the conversation to. Empty for the two modes that are not a set.
        // `agentId` says whose conversation it is; left out, the selected
        // agent's.
        start: ({ scope, sessionId, sessionIds, hostIds, agentId } = {}) =>
            ipcRenderer.invoke('ai-conversation-start', { scope, sessionId, sessionIds, hostIds, agentId }),
        // `{ agentId }` narrows the list to one agent's conversations.
        list: (filter) => ipcRenderer.invoke('ai-conversation-list', filter || {}),
        // By what was said: `{ agentId, query, limit, openIds }`. See ai/search.js.
        search: (filter) => ipcRenderer.invoke('ai-conversation-search', filter || {}),
        history: (conversationId) => ipcRenderer.invoke('ai-conversation-history', conversationId),
        // Releases the running query and keeps the transcript, so the
        // conversation can be picked up again from the history menu.
        park: (conversationId) => ipcRenderer.invoke('ai-conversation-park', conversationId),
        // Keep a conversation at the top of the list, or let it go.
        pin: (conversationId, pinned) => ipcRenderer.invoke('ai-conversation-pin', { conversationId, pinned }),
        close: (conversationId) => ipcRenderer.invoke('ai-conversation-close', conversationId),
        // Pin one conversation to a runtime, model and effort, or change the
        // pin it has. Answers `{ pinned }`, the patch as kept.
        setModel: (conversationId, patch) => ipcRenderer.invoke('ai-conversation-model', { conversationId, patch }),
        // What a turn did to files, as lines: `{ found, reverted, files }`.
        turnChanges: (conversationId, turnId) =>
            ipcRenderer.invoke('ai-turn-changes', { conversationId, turnId }),
        // Put back every file a turn changed. Answers `{ reverted, failed }`.
        revertTurn: (conversationId, turnId) =>
            ipcRenderer.invoke('ai-turn-revert', { conversationId, turnId }),
        // A new conversation holding this one up to the end of a turn.
        // Answers `{ conversationId, agentId }`.
        branch: (conversationId, turnId) =>
            ipcRenderer.invoke('ai-conversation-branch', { conversationId, turnId }),
        // Save the conversation as a Markdown file; main asks where.
        export: (conversationId) => ipcRenderer.invoke('ai-conversation-export', conversationId),
        // The same Markdown as text, for the clipboard. `{ full: true }` adds
        // the settings, every tool input and untruncated results.
        markdown: (conversationId, options) =>
            ipcRenderer.invoke('ai-conversation-markdown', { conversationId, ...(options || {}) }),
        // Which servers the panel is pointed at: the session in front, every
        // host, or a pinned set of sessions and saved hosts.
        setScope: (conversationId, target) =>
            ipcRenderer.invoke('ai-scope', { conversationId, ...(target || {}) }),

        // `images` is optional: `[{ name, mediaType, data }]` with the bytes
        // as base64. Main checks them and refuses the message if the agent in
        // use cannot read pictures. `mentions` is optional too: `{ kind, id }`
        // for anything in the agent's inventory the message tagged with `@`.
        // Main reads each record itself rather than taking it from here.
        send: (conversationId, text, images, mentions) =>
            ipcRenderer.invoke('ai-send', { conversationId, text, images, mentions }),
        interrupt: (conversationId) => ipcRenderer.invoke('ai-interrupt', conversationId),

        // Every message, tool call and result for a conversation.
        onEvent: (callback) => subscribe('ai-event', callback),
        // A secret was stored and masked out of a conversation's past: the
        // window holding it reads the transcript again.
        onHistoryScrubbed: (callback) => subscribe('ai-history-scrubbed', callback),

        // A tool call waiting on the user. The panel draws it; the answer goes
        // back on the matching request id.
        // How an approval was settled, including a timeout, arrives on the
        // ordinary event stream, so there is no second channel to watch.
        approve: (requestId, approved, message) =>
            ipcRenderer.invoke('ai-approval-response', { requestId, approved, message }),
        // A question the agent asked with ask_user, answered. `chosen` says
        // the answer was one of the offered options rather than typed. An
        // empty answer dismisses the question.
        answer: (requestId, answer, chosen = false) =>
            ipcRenderer.invoke('ai-question-response', { requestId, answer, chosen }),

        // Main asking the window to open or close a session, which only the
        // window can do because that means touching the tab tree.
        onAction: (callback) => subscribe('ai-action', callback),
        respondToAction: (requestId, result) =>
            ipcRenderer.invoke('ai-action-response', { requestId, ...result }),

        // Windows of the assistant's own. `detach` opens one holding these
        // conversations; a window asks `windowTabs` for what it holds and
        // reports changes with `setWindowTabs`; `reattach` hands some or all
        // back to the main window, and `closeWindow` closes without handing
        // anything back. `onAdoptTabs` is the main window being handed them.
        detach: (conversationIds) => ipcRenderer.invoke('ai-window-open', { conversationIds }),
        windowTabs: () => ipcRenderer.invoke('ai-window-tabs'),
        setWindowTabs: (conversationIds) => ipcRenderer.invoke('ai-window-tabs-set', conversationIds),
        reattach: (conversationIds) => ipcRenderer.invoke('ai-window-reattach', conversationIds),
        closeWindow: () => ipcRenderer.invoke('ai-window-close'),
        onAdoptTabs: (callback) => subscribe('ai-tabs-adopt', callback),
        // The corner overlay's rows: the agents at work on the desktop.
        onActivity: (callback) => subscribe('ai-activity', callback),
        // The composer's microphone: 16 kHz mono samples in, the words out,
        // transcribed on this machine. `onSpeech` hears how the first use's
        // model download is going. See main/ai/speech.js.
        transcribe: (samples, options) => ipcRenderer.invoke('ai-transcribe', { samples, ...(options || {}) }),
        onSpeech: (callback) => subscribe('ai-speech', callback),
        // Whether each engine can be used, and installing Faster-Whisper's
        // Python package, for the Voice input settings.
        speechStatus: (options) => ipcRenderer.invoke('ai-speech-status', options || {}),
        speechInstall: () => ipcRenderer.invoke('ai-speech-install'),
        speechDownload: () => ipcRenderer.invoke('ai-speech-download'),
        // Browser use, for its settings: whether Node.js and a browser are
        // here, installing Node.js, and that install's output as it goes.
        // See main/ai/browser-use.js.
        browserStatus: () => ipcRenderer.invoke('ai-browser-status'),
        browserInstallNode: () => ipcRenderer.invoke('ai-browser-install-node'),
        onBrowser: (callback) => subscribe('ai-browser', callback),
        // Live dictation (Parakeet): audio streamed in as it is recorded,
        // `onDictation` hearing the words so far, stop handing back the rest.
        dictationStart: () => ipcRenderer.invoke('ai-dictation-start'),
        dictationAudio: (id, samples) => ipcRenderer.send('ai-dictation-audio', id, samples),
        dictationStop: (id) => ipcRenderer.invoke('ai-dictation-stop', id),
        dictationCancel: (id) => ipcRenderer.invoke('ai-dictation-cancel', id),
        onDictation: (callback) => subscribe('ai-dictation', callback),
        // Another window has opened these, so this one is to let them go: a
        // conversation is shown in one place.
        onReleaseTabs: (callback) => subscribe('ai-tabs-release', callback),

        // What a detached window cannot see for itself: the open sessions,
        // the saved hosts and the one in front. The main window publishes it;
        // a detached one reads it once and then follows changes.
        publishContext: (context) => ipcRenderer.invoke('ai-context-set', context),
        context: () => ipcRenderer.invoke('ai-context'),
        onContext: (callback) => subscribe('ai-context', callback),

        // A detached window asking the main one to show a page it has not
        // got: 'settings' or 'snippets'. The main window listens on the other.
        navigateMain: (nav) => ipcRenderer.invoke('ai-navigate-main', nav),
        onNavigate: (callback) => subscribe('ai-navigate', callback),

        // The chats this window has on screen, so main can tell a turn
        // ending or a question asked out of sight and say so through the
        // OS; and the sound that goes with those notifications.
        setInView: (conversationIds) => ipcRenderer.invoke('ai-in-view-set', conversationIds),
        onChime: (callback) => subscribe('ai-chime', callback),
    },

    /**
     * Runs: the units of work, interactive or scheduled, with their steps.
     * See main/runs. `onChange` fires on any change to any run.
     */
    /**
     * The secrets store: API keys and tokens by name. Names and dates come
     * back; values never do. A value is set once and used by the app, in
     * the main process, where a record refers to it as {{secret:name}}.
     * Each belongs to an agent: `agentId` is whose, the selected one when
     * left out. A list is that agent's own and the shared ones.
     */
    secrets: {
        list: (agentId) => ipcRenderer.invoke('secrets-list', agentId),
        set: (name, value, agentId) => ipcRenderer.invoke('secrets-set', { name, value, agentId }),
        remove: (name, { agentId, shared = false } = {}) => ipcRenderer.invoke('secrets-remove', { name, agentId, shared }),
    },

    /**
     * The agent's files: its own and the shared ones, as records. The bytes
     * stay in main; a file is added from the user's own dialog or drop, and
     * opened, revealed or copied out by main. Changes from either side are
     * announced as `inventory.onChange` with kind "files".
     */
    files: {
        list: (agentId) => ipcRenderer.invoke('files-list', agentId),
        // The open dialog, then the chosen files stored: `{ added, errors }` or `{ canceled }`.
        add: (agentId) => ipcRenderer.invoke('files-add', agentId),
        // Files dropped on the page, resolved to their paths on this side.
        addDropped: (agentId, fileList) => {
            const paths = [...(fileList || [])].map((file) => {
                try {
                    return webUtils.getPathForFile(file);
                } catch {
                    return '';
                }
            }).filter(Boolean);
            return ipcRenderer.invoke('files-add-paths', { agentId, paths });
        },
        // `patch`: { name, description, tags, shared }
        update: (agentId, id, patch) => ipcRenderer.invoke('files-update', { agentId, id, patch }),
        remove: (agentId, id) => ipcRenderer.invoke('files-remove', { agentId, id }),
        open: (agentId, id) => ipcRenderer.invoke('files-open', { agentId, id }),
        reveal: (agentId, id) => ipcRenderer.invoke('files-reveal', { agentId, id }),
        exportFile: (agentId, id) => ipcRenderer.invoke('files-export', { agentId, id }),
    },

    runs: {
        list: (filter) => ipcRenderer.invoke('runs-list', filter || {}),
        get: (runId) => ipcRenderer.invoke('runs-get', runId),
        usage: (filter) => ipcRenderer.invoke('runs-usage', filter || {}),
        // The run as a span tree in the OpenTelemetry GenAI shape.
        trace: (runId) => ipcRenderer.invoke('runs-trace', runId),
        cancel: (runId) => ipcRenderer.invoke('runs-cancel', runId),
        remove: (runId) => ipcRenderer.invoke('runs-remove', runId),
        onChange: (callback) => subscribe('runs-changed', callback),
    },

    /**
     * Jobs: prompts on a schedule, run with nobody watching. See main/runs/jobs.
     * `create` and `update` answer `{ job }` or `{ error }`.
     */
    jobs: {
        list: (filter) => ipcRenderer.invoke('jobs-list', filter || {}),
        create: (spec) => ipcRenderer.invoke('jobs-create', spec || {}),
        update: (id, patch) => ipcRenderer.invoke('jobs-update', { id, patch: patch || {} }),
        remove: (id) => ipcRenderer.invoke('jobs-remove', id),
        runNow: (id) => ipcRenderer.invoke('jobs-run-now', id),
        token: (id) => ipcRenderer.invoke('jobs-token', id),
        // A model the way a person names it, resolved across the agent's
        // runtimes: `{ provider, model, label, effort }` or `{ error }`.
        resolveModel: (agentId, query) => ipcRenderer.invoke('jobs-resolve-model', { agentId, query }),
        // `{ schedule, text, next: [stamps] }` or `{ error }`, nothing saved.
        preview: (schedule, count = 3) => ipcRenderer.invoke('jobs-preview', { schedule, count }),
        // The job library, and one template filled in as `{ spec }` or `{ error }`.
        templates: (filter) => ipcRenderer.invoke('jobs-templates', filter || {}),
        fromTemplate: (payload) => ipcRenderer.invoke('jobs-template-instantiate', payload || {}),
        onChange: (callback) => subscribe('jobs-changed', callback),
    },

    /**
     * The inventory, as the agent changes it. Its tools write hosts, snippets
     * and proxies straight to the store, so a window has to be told to read
     * a collection again: `{ kind: 'hosts' | 'snippets' | 'proxies' | 'keys' | 'files', agentId }`.
     */
    inventory: {
        onChange: (callback) => subscribe('inventory-changed', callback),
    },

    /** What an agent remembers between conversations. See ai/memory.js. */
    memory: {
        list: (agentId) => ipcRenderer.invoke('memory-list', agentId),
        save: (entry) => ipcRenderer.invoke('memory-save', entry),
        remove: (agentId, id) => ipcRenderer.invoke('memory-remove', { agentId, id }),
        search: (agentId, query, limit) => ipcRenderer.invoke('memory-search', { agentId, query, limit }),
        status: (agentId) => ipcRenderer.invoke('memory-status', agentId),
        // A JSON file of one agent's notes, written or read where the user picks.
        exportFile: (agentId) => ipcRenderer.invoke('memory-export', agentId),
        importFile: (agentId) => ipcRenderer.invoke('memory-import', agentId),
        onChange: (callback) => subscribe('memory-changed', callback),
    },

    /**
     * The agents: whose the conversations, the inventory and the settings
     * are. Every mutation answers with the whole list and the selection.
     */
    agents: {
        list: () => ipcRenderer.invoke('agents-list'),
        select: (id) => ipcRenderer.invoke('agents-select', id),
        save: (agent) => ipcRenderer.invoke('agents-save', agent),
        remove: (id) => ipcRenderer.invoke('agents-remove', id),
        onChange: (callback) => subscribe('agents-changed', callback),
        // Whether the agent's MCP servers answer. `serverStatuses` is what
        // is already known; `checkServer` performs the handshake, for one
        // server or (without a serverId) all of them; every result is also
        // pushed through `onServerStatus`.
        serverStatuses: (agentId) => ipcRenderer.invoke('agents-server-statuses', agentId),
        checkServer: (payload) => ipcRenderer.invoke('agents-server-check', payload || {}),
        onServerStatus: (callback) => subscribe('mcp-status', callback),
        // The MCP library: curated templates, the official registry, and a
        // template filled in as a server record ready to put on the agent.
        library: (filter) => ipcRenderer.invoke('mcp-library-list', filter || {}),
        librarySearch: (query) => ipcRenderer.invoke('mcp-library-search', query || ''),
        libraryInstantiate: (payload) => ipcRenderer.invoke('mcp-library-instantiate', payload || {}),
        // The sandbox: whether Docker can run this agent's container, a
        // reset of it, and the folder picker that grants a local folder.
        sandboxStatus: (id) => ipcRenderer.invoke('sandbox-status', id),
        sandboxReset: (id) => ipcRenderer.invoke('sandbox-reset', id),
        chooseFolder: () => ipcRenderer.invoke('sandbox-choose-folder'),
    },

    // Which OS this is, for the handful of places the interface has to differ:
    // macOS draws its own window controls, and Pageant and the registry
    // importers only exist on Windows. Read once at load; it cannot change.
    platform: process.platform,

    window: {
        minimize: () => ipcRenderer.send('window-minimize'),
        maximize: () => ipcRenderer.send('window-maximize'),
        close: () => ipcRenderer.send('window-close'),
        reload: () => ipcRenderer.send('reload-window'),
        toggleDevTools: () => ipcRenderer.send('open-devtools'),
        quit: () => ipcRenderer.send('force-quit'),
    },
});

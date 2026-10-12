/**
 * Claude Desktop: the Claude Code that the Claude desktop app downloads for
 * its Code tab, as an agent of its own.
 *
 * It is the same CLI as Claude Code, so it is driven by the same code
 * (claude-code.js); what differs is which binary runs. This agent only ever
 * runs the desktop app's copy (`findDesktopClaude`), and Claude Code never
 * does, so a machine with only the desktop app has an agent to tick, and one
 * with both can tell which is which.
 *
 * The sign-in is not the desktop app's. That app keeps its login in its own
 * storage and hands it to its copy only when it starts it itself, so this
 * agent signs in once on its own: the Sign in on Settings > Accounts, or the
 * one the chat offers when a message finds it signed out. That lands in the
 * standard Claude Code folder (`~/.claude`), which is also where the desktop
 * app's copy reads its settings from. One login per machine (see accounts.js).
 *
 * Every entry point that starts the CLI is passed through `pin`, so whatever
 * the caller handed over, the run is this agent's: the account actions hand
 * over only an account's variables, with no provider on them.
 */
const claudeCode = require('./claude-code');

const PROVIDER = 'claude-desktop';

const pin = (options = {}) => ({ ...options, settings: { ...(options.settings || {}), provider: PROVIDER } });

/**
 * Whether the desktop app has a copy here, for the tick that switches this
 * agent on. Signed in or not: that is offered as a Sign in where it is needed,
 * rather than refused here with nothing to do about it.
 */
function detect() {
    return { ok: Boolean(claudeCode.findDesktopClaude()), reason: 'notFound' };
}

module.exports = {
    ...claudeCode,
    start: options => claudeCode.start(pin(options)),
    title: options => claudeCode.title(pin(options)),
    listModels: options => claudeCode.listModels(pin(options)),
    readLimits: options => claudeCode.readLimits(pin(options)),
    authStatus: options => claudeCode.authStatus(pin(options)),
    login: options => claudeCode.login(pin(options)),
    logout: options => claudeCode.logout(pin(options)),
    detect,
    // What the version check and anything else that asks "where is it" use.
    findClaude: () => claudeCode.findDesktopClaude(),
    PROVIDER,
};

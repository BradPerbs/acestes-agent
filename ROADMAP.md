# Acestes Agent roadmap

Acestes Agent is a fork of CloudTerm 1.4.3. The goal is an agent-first desktop app
in the spirit of Hermes Agent and OpenClaw: the agent is the primary surface, and
terminals, SSH sessions and local folders are the tools it works with.

## What is inherited and stays

- Electron + React + xterm.js shell, split panes, tabs, snippets, vaults.
- SSH, SFTP, Telnet, serial, RDP and VNC sessions (`src/main/*`).
- Provider integrations in `src/main/ai/providers`: Claude Code (Agent SDK),
  Codex, Grok, Kimi, OpenCode, local / OpenAI-compatible endpoints.
- The tool layer the assistant already uses to drive SSH sessions
  (`src/main/ai/tools.js`, `terminal-run.js`, `exec.js`, `mcp-host.js`).

## What changes

1. **Agent-first UI.** The assistant pane becomes the home screen. Sessions and
   file views open as panes the agent (or the user) spawns, instead of the
   assistant living as a tab beside terminals.
2. **Persistent memory.** A per-workspace memory store under `userData`
   (facts, preferences, project notes, task history) that is loaded into every
   run and that the agent can read and write through tools. Start with a
   file-backed store (markdown + index, like Claude Code's auto-memory), add
   embeddings for recall later.
3. **Local filesystem scope.** Let the user grant the agent one or more local
   folders. Add read / write / search / run tools scoped to those folders, with
   the same approval flow that already gates SSH commands
   (`test/assistant-approval.test.js` documents the current contract).
4. **Long-running tasks.** Background jobs with progress, resumable across app
   restarts, surfaced in the agent timeline rather than a chat scrollback.
5. **Skills / playbooks.** Reuse the snippet + specs library as the place where
   reusable procedures live, and let the agent be handed them.

## Identity

- Package name `acestes-agent`, app id `com.acestes.agent`, product name
  "Acestes Agent". Because the Electron app name changed, the fork gets its own
  `userData` directory and does not touch an installed CloudTerm's hosts, vaults
  or settings.
- Update feed points at `BradPerbs/acestes-agent` (override with
  `CLOUDBLAST_UPDATE_REPO`). No releases exist yet.
- Remaining `CloudTerm` / `cloudblast` strings in locales, account sync and
  cloud snapshot code are left as-is for now. Those touch the CloudBlast
  account service and should be decided on deliberately, not search-replaced.

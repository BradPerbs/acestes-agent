# Acestes Agent roadmap

Acestes Agent is a fork of CloudTerm 1.4.3. The goal is an agent-first desktop app
in the spirit of Hermes Agent and OpenClaw: the agent is the primary surface, and
terminals, SSH sessions and local folders are the tools it works with.

## What is inherited and stays

- Electron + React + xterm.js shell, split panes, tabs, snippets, vaults.
- SSH, SFTP, Telnet and serial sessions (`src/main/*`). RDP, VNC and IPMI were
  taken out: an agent works through a shell, and a picture of a screen is not
  one.
- Provider integrations in `src/main/ai/providers`: Claude Code (Agent SDK),
  Codex, Grok, Kimi, OpenCode, local / OpenAI-compatible endpoints.
- The tool layer the assistant already uses to drive SSH sessions
  (`src/main/ai/tools.js`, `terminal-run.js`, `exec.js`, `mcp-host.js`).

## What changes

1. **Agent-first UI.** Done in the first pass: agents are the top-level thing.
   The sidebar picks the agent and lists its conversations; an agent has its
   own conversations, its own inventory (hosts, keychain, proxies, snippets,
   MCP servers, logs) and its own settings (runtime, model, approvals,
   standing instructions). Conversations are tabs of the window, and sessions
   the agent opens arrive as tabs behind the conversation rather than in front
   of it. Still to do: sessions and file views as panes beside the
   conversation, and MCP servers for the runtimes other than Claude Code.
2. **Persistent memory.** Done in the first pass: a notebook per agent under
   `userData/memory`, written by the agent through `remember`, `recall` and
   `forget` and edited on the Memory page of the inventory. Every note is
   embedded on the machine (MiniLM through ONNX, see `src/main/ai/embeddings.js`)
   into a flat vector index; the newest notes go into the system prompt and the
   ones that bear on each message are found by meaning and sent with it. Still
   to do: automatic extraction of facts from a finished turn, and consolidation
   of a new fact against the ones it overlaps, the way mem0 does it.
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

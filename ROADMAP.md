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
   of it. The agent's MCP servers reach every runtime, spawned through one
   launcher with a scrubbed environment. Still to do: sessions and file views
   as panes beside the conversation.
2. **Persistent memory.** Done in the first pass: a notebook per agent under
   `userData/memory`, written by the agent through `remember`, `recall` and
   `forget` and edited on the Memory page of the inventory. Every note is
   embedded on the machine (MiniLM through ONNX, see `src/main/ai/embeddings.js`)
   into a flat vector index; the newest notes go into the system prompt and the
   ones that bear on each message are found by meaning and sent with it. Still
   to do: automatic extraction of facts from a finished turn, and consolidation
   of a new fact against the ones it overlaps, the way mem0 does it.
3. **Sandbox.** Done in the first pass, in two layers (`src/main/ai/sandbox.js`
   is the envelope both read). The code layer is always on: an agent may only
   drive the sessions it opened and the ones the user opened, its local tools
   (`list_local_directory`, `read_local_file`, `write_local_file`,
   `run_local_command`) stay inside the folders the user granted on the
   Sandbox card of the settings page, and its MCP servers are started with the
   secrets stripped out of the environment (`mcp-launch.js`). The loopback tool
   server now answers each conversation in its own context, keyed by token.
   The container layer is opt-in per agent: with Docker present, local
   commands, files and the agent's MCP servers run in a hardened container of
   its own (`container.js`), read-only root, capabilities dropped, no network
   unless the agent is given it, with the granted folders mounted under
   `/workspace`. `test/sandbox.test.js` documents the contract. Still to do:
   a per-host network allowlist for the container (Docker has no egress
   filter of its own, so it needs a proxy), a search tool over the granted
   folders, and an unattended policy for scheduled runs (see 4).
4. **Long-running tasks.** Done in three passes, see `src/main/runs`. A run is
   the unit of work: every turn, every job firing, every delegation is one,
   written to `runs.db` (SQLite through `node:sqlite`, no native build) as
   it goes, with each tool call a step written pending before the effect and
   complete after. On launch, runs the last process left going are closed or
   re-queued and tool steps that never reported are marked unknown, never
   replayed. Jobs (`runs/jobs.js`, `runs/scheduler.js`) fire a prompt at a
   time, on an interval, on a cron expression through Croner, on a monitored
   host crossing, on a webhook, or after a heartbeat probe; a run started by
   a job gets a policy (read-only, allowlist, park, full) folded into the
   approval gate every provider already consults, and under park a write
   stops the run and waits for the user with no timeout. Backoff, overlap,
   missed ticks and delivery (notification, webhook, file) follow the
   reference harnesses. Sessions no longer need a window (`ai/headless.js`),
   the app stays up for its jobs with a tray icon, and the Runs and Jobs
   pages show it all. Delegation is a child run: `delegate` hands a brief to
   another agent, `fan_out` runs it once per host, two levels deep at most,
   with the child's questions drawn on the parent. Hooks (before and after a
   tool, at run start and end) run the user's own command around every
   provider. The OpenAI-compatible path compacts its history by summary
   before it cuts. A run is readable as an OpenTelemetry-shaped span tree,
   and a conversation exports as Markdown. Still to do: a risk tier per host
   under the full policy, wait-and-poll for long commands, SFTP transfer
   between local and remote, and an OTLP exporter once the conventions are
   stable.
5. **Skills / playbooks.** Reuse the snippet + specs library as the place where
   reusable procedures live, and let the agent be handed them. Done in the
   first pass: the agent can look through its own bag (`list_snippets`,
   `read_snippet`, `list_inventory`) and keep it (`save_snippet`, `save_host`,
   `save_proxy`, `save_key`, `save_mcp_server`, `save_folder`,
   `delete_inventory_item`), see `src/main/ai/inventory-tools.js`. It sees
   and edits its own records and the shared ones, never another agent's, and
   it has the full hand over them, credentials included: it can set a host's
   password or key, a proxy's password, and add keys to the keychain. Secrets
   flow one way: what it writes is encrypted by the store, and nothing it
   reads back carries one. Every write stops at the approval card under the
   default policy. `test/inventory-tools.test.js` documents the contract.
   Still to do: let the agent turn a finished turn into a spec on its own.
6. **The tools a day's work needs.** Done in the first pass: `edit_file` and
   `edit_local_file` replace one passage rather than a whole file, and the
   approval card shows the change; `search_local_files` greps the granted
   folders; `search_conversations` reads the agent's own past through the
   history page's search; `ask_user` puts a question with options on a card
   and waits. Folders are granted in the agent dialog as well as on the
   Sandbox card. Still to do: wait-and-poll for long commands, SFTP
   transfer between local and remote, fan-out of one command across hosts.
7. **Secrets.** Done in the first pass (`src/main/ai/secrets.js`): a value
   goes in by name through a masked card, the keychain page or
   `save_secret`, is encrypted by the OS keychain, and the agent only ever
   holds `{{secret:name}}`. The app resolves the reference at the moment of
   use: the env of a local command, the env, headers and URL of an MCP
   server, a host or proxy password, and, on the Claude Code runtime, the
   arguments of a call to one of the agent's MCP servers, so a password can
   be typed into a browser form without the model or the transcript seeing
   it. Every stored value is masked out of the transcript, the conversation
   titles and the runs log, and a credential found in a server's env or
   headers is moved into the store whichever door it came through,
   `agents.json` written by an earlier release included. Still to do: the
   same resolution of references in MCP arguments on Codex, Grok, Kimi and
   OpenCode, whose runtimes spawn the agent's servers themselves (routing
   those servers through the loopback host would do it); and a fence for
   the runtimes' own file tools, which today reach outside the granted
   folders on the host (Grok Build runs with `--always-approve` and its
   `read_file` can open `agents.json`; Claude Code's go through the
   approval card but not the grant).

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

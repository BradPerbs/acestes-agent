<h1 align="center">Acestes Agent</h1>

<p align="center">
  <strong>An agent that lives on your desktop: persistent memory, its own inventory, and SSH sessions it works through.</strong>
</p>

<p align="center">
  Electron · React · xterm.js · Claude Code, Codex, OpenCode, Grok, Kimi and local models
</p>

---

Acestes Agent is a desktop workspace built around agents. Each agent has its
own conversations, its own inventory of things to work with, its own memory
and its own settings. You talk to it in a chat; it reads your terminals, runs
commands over SSH sessions it opens itself, and remembers what it learned for
next time.

It is a fork of [CloudTerm](https://github.com/BradPerbs/cloudterm) 1.4.3,
which contributed the terminal, the SSH/SFTP stack and the provider
integrations. Everything that an agent cannot work through, such as the remote
desktop viewers, has been taken out, and the interface has been rebuilt around
the agent rather than around a list of hosts.

## What is in it

### Agents

- **More than one.** Pick the agent from the top of the sidebar, make a new
  one with a name and a colour, rename or delete it. Deleting an agent hands
  its conversations and notes to the one selected next.
- **Its own settings.** Which runtime answers for it, the model and effort,
  the approval policy, the command mode, quick prompts, blocked commands, and
  standing instructions sent ahead of every conversation. Machine-level
  settings, such as which runtimes are installed, are shared.
- **Its own mark.** A round face with animated eyes, in the agent's colour,
  everywhere the agent appears.

### Conversations

- Conversations are tabs of the window, beside the SSH sessions. The chat is
  the main surface; the sidebar lists the selected agent's conversations,
  newest first, and a Conversations page lists all of them with search.
- A conversation can be pointed at the session in front of you, at every
  saved host, or pinned to a set of servers the tools are fenced to.
- Sessions the agent opens arrive as tabs behind the conversation rather
  than in front of it. A conversation can be lifted into a window of its own.

### Inventory

One sidebar entry, several pages, all scoped to the selected agent:

- **Overview**, drawn like a game inventory: the agent's card, and a pouch
  per class with a round token per item.
- **Hosts**, with folders, tags, jump hosts, proxies, port forwards,
  run-on-connect commands and reachability monitoring. SSH, Telnet and
  serial.
- **Keychain**, for SSH keys, including keys held in Windows Hello.
- **Proxies**: SOCKS4, SOCKS5 and HTTP CONNECT, chainable.
- **Snippets**: commands, packages of commands, and specs, which are
  documents the agent is handed with a message.
- **Memory**: what the agent remembers, readable and editable.
- **MCP servers**: external tool servers handed to the agent, by command or
  by URL.
- **Logs**: the activity log of what was connected to and changed.

Records made while an agent is selected belong to it. Records with no owner,
such as imported hosts, are visible to every agent.

### Memory

Every agent keeps a notebook between conversations. The agent writes to it
through three tools: `remember` saves a note, `recall` searches, `forget`
deletes one by id. The user can add and edit notes on the Memory page.

Notes are embedded on the machine, with MiniLM run through ONNX, into a
vector index kept beside them. The newest notes go into the system prompt;
the ones that bear on each message are found by meaning and sent with it,
which is what lets the notebook grow past what a prompt could carry. Search
folds in a plain word match, so an exact hostname or id still wins. The model
is fetched once, about 23 MB, and nothing leaves the machine to be indexed.

### The agent's tools

The agent works through the app rather than around it. It can list hosts and
sessions, read what is on a terminal, run commands (typed into the terminal
you are watching, or on a background channel with a real exit code), send
input to a running program, list, read and write files over SFTP, open and
close sessions, and use its memory. It never sees a credential: it names a
host or a session, and the app connects with what is already stored.

Every call that changes something goes through an approval policy: ask every
time, ask before changes, or never ask. A blocked command list refuses the
dangerous ones before they reach a server.

### Terminal

Everything CloudTerm's terminal had: tabs and tab groups, split panes,
broadcast typing, search, session recording, snippets, SFTP with drag and
drop, port forwarding with live counters, remote file editing in your own
editor, host key trust on first use, and keyboard-interactive logins.

## Running it

```
npm install
npm run dev
```

`npm run dev` starts the Vite dev server and Electron against it. If you
launch from a shell that inherited `ELECTRON_RUN_AS_NODE` (VS Code's
integrated terminal does this), unset it first or Electron starts as plain
Node.

```
npm test          # the unit tests
npm run build     # Windows installer and portable build, into dist/
npm run build:mac
npm run build:linux
```

The first conversation needs one of the supported runtimes installed and
signed in on the machine: Claude Code, Codex, OpenCode, Grok, Kimi, or a local
OpenAI-compatible endpoint. Which ones are on is set on the agent's settings
page.

## Where things live

- `src/main/agents.js`: the agent registry.
- `src/main/ai/`: conversations (`index.js`), the tool catalog (`tools.js`),
  the system prompt (`prompt.js`), memory (`memory.js`, `embeddings.js`),
  settings with per-agent overlays (`settings.js`), and one file per runtime
  under `providers/`.
- `src/main/`: SSH, SFTP, telnet, serial, tunnels, proxies, the store and the
  activity log.
- `src/renderer/`: the React app. `App.jsx` holds the tabs; `components/`
  holds the pages and the conversation surface; `hooks/` holds the state.
- `ROADMAP.md`: what is done and what is next.

## License

Acestes Agent keeps CloudTerm's license, a fair-code license under which the
source is open to read and the software is free to use and modify. See
[LICENSE](LICENSE).

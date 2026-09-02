<h1 align="center">Acestes Agent</h1>

<p align="center">
  <strong>The agent that lives on your desktop and runs your servers with you.</strong>
</p>

<p align="center">
  Persistent memory · Its own inventory · SSH sessions it opens itself · Runs on Claude Code, Codex, OpenCode, Grok, Kimi or a local model
</p>

---

## Meet Acestes

Acestes appears twice in the *Aeneid*, and both times he is the one who stays.
Born of a Trojan mother and a Sicilian river, he rules the western coast where
Aeneas is driven ashore, and he receives the fleet without ceremony or terms.
When the Trojans return a year later, it is in his kingdom that they bury their
dead, hold the games, and watch his arrow take fire in the air, the omen the
poem chooses for him. And when the ships burn and the exhausted decide they can
go no further, it is Acestes who founds a city for them and keeps them, while
Aeneas sails on to his destiny.

A host, in the oldest sense of the word: the one whose ground you can return
to, who remembers you, and who holds what you leave in his care.

That is what this agent is built to be. Not a conversation that ends when the
window closes, but a presence that keeps your servers, your keys, your notes
and your way of working, and is there the next morning knowing what happened
the day before.

## An opinionated agent

Acestes is not a general assistant with a terminal bolted on. It is built for
one job, running servers with the person who owns them, and it takes
positions on how that should go:

- **The terminal is the truth.** The agent works through real SSH sessions
  in a real terminal, and by default it types where you can see it. What it
  did is in your scrollback, not in a summary of what it says it did.
- **Memory is a notebook, not a transcript.** It keeps short facts it decided
  were worth keeping, in plain text you can read and edit, rather than
  quietly mining every conversation.
- **It asks, in the open.** Anything that changes a system stops on a card
  you can read to the end of, with the exact command on it. When it needs
  a decision from you, it puts the question on a card with the answers it
  sees, instead of guessing or burying the question in a paragraph.
- **Secrets go one way.** The agent can save a host with its password or
  key, but nothing it reads back ever carries one, and a secret never lands
  in a transcript or a log.
- **Every agent is a person, not a mode.** Two agents in one window have
  separate memories, inventories, folders and sessions, and one cannot
  drive the other's terminal.

If you want a blank canvas that does whatever a prompt says, this is not it.

## An agent, not a chatbot

- **It remembers.** Every agent keeps a memory that grows with every
  conversation: what your machines are, how you like things done, what the
  fix turned out to be. Indexed on your own machine, searched by meaning,
  never sent anywhere to be stored. It can also search its own past
  conversations, so "how did we fix this last time" has an answer.
- **It does the work.** Acestes opens SSH sessions, reads what is on the
  screen, runs the commands, checks the result and reports back. You watch it
  happen in a real terminal, or let it work quietly in the background. It
  edits a config file by replacing the passage it read rather than rewriting
  the file, so the approval card shows the change and not the whole file.
- **It carries its own kit.** Hosts, keys, proxies, snippets, playbooks and
  MCP tool servers live in the agent's inventory, laid out like a bag in a
  game. The agent can look through its own bag, read a playbook you wrote
  for it before starting a job, and keep the bag itself: add the host it was
  just told about, save a procedure that worked as a playbook, register an
  MCP server. It sees and edits its own records and the shared ones, never
  another agent's.
- **It works on this computer too, inside a fence.** Grant an agent a folder
  when you create it and it can list, read, search, edit and run commands
  there and nowhere else. Turn on the container and that fence becomes a
  wall.
- **It asks before it breaks things.** You choose how much it does on its own:
  everything on approval, reads without asking, or full autonomy. A blocked
  list stops the truly dangerous commands before they reach a server.
- **It never shows you a password.** Credentials stay in the app's vault,
  encrypted. The agent names a host; the app makes the connection.

## A team of them

One agent for production, one for the homelab, one that only reads and
reports. Each has its own name, its own colour, its own face, its own
memory, its own inventory and its own rules. Switch between them from the
sidebar. Run them on different models. Give each one standing instructions
and it behaves like the specialist you hired it to be.

## Built on a real terminal

Acestes grew out of [CloudTerm](https://github.com/BradPerbs/cloudterm), so
underneath the agent is a serious SSH client: tabs, split panes, SFTP with
drag and drop, port forwarding, session recording, jump hosts, proxies and
serial consoles. The agent works through the same sessions you do, in the
same window.

## Your runtime, your choice

Acestes drives the coding agents already installed and signed in on your
machine: Claude Code, Codex, OpenCode, Grok, Kimi, or any local
OpenAI-compatible model. No new subscription, no key to paste, and you can
change your mind per agent.

## Run it

```
npm install
npm run dev
```

Builds for Windows, macOS and Linux come from `npm run build`,
`npm run build:mac` and `npm run build:linux`. See [ROADMAP.md](ROADMAP.md)
for where this is going.

## License

Acestes Agent is a fork of CloudTerm 1.4.3 and keeps its fair-code license:
the source is open to read, and the software is free to use and modify. See
[LICENSE](LICENSE).

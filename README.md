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

## An agent, not a chatbot

- **It remembers.** Every agent keeps a memory that grows with every
  conversation: what your machines are, how you like things done, what the
  fix turned out to be. Indexed on your own machine, searched by meaning,
  never sent anywhere to be stored.
- **It does the work.** Acestes opens SSH sessions, reads what is on the
  screen, runs the commands, checks the result and reports back. You watch it
  happen in a real terminal, or let it work quietly in the background.
- **It carries its own kit.** Hosts, keys, proxies, snippets, playbooks and
  MCP tool servers live in the agent's inventory, laid out like a bag in a
  game. Give an agent what it needs and it takes it into every conversation.
- **It asks before it breaks things.** You choose how much it does on its own:
  everything on approval, reads without asking, or full autonomy. A blocked
  list stops the truly dangerous commands before they reach a server.
- **It never sees a password.** Credentials stay in the app's vault. The
  agent names a host; the app makes the connection.

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

# Devices: one Acestes across several computers

Acestes installed on several machines (your PC, a laptop, Windows servers you
reach by RDP) joins into one **fleet**. Every device is the equal of the
others: the same agents, settings, inventory, secrets, memory, jobs and
conversations; any of them can hand another a task; and a scheduled job runs
once, on whichever device is on. The one exception is **Lock**: a locked
device takes no tasks from the others and runs none of their jobs. It still
syncs, and it can still hand work to them.

Code: `src/main/fleet/`, the agent tools in `src/main/ai/fleet-tools.js`
(`list_devices`, `run_on_device`) and the `device` option of `schedule_job`
and `update_job`, the page in `src/renderer/components/settings/DevicesSection.jsx`.

## Pieces

| File | What it does |
|---|---|
| `crypto.js` | Device identity (Ed25519 to sign, X25519 to receive keys), the fleet key (AES-256-GCM), invite codes and their proofs, record names |
| `relay-core.js` | The relay: roster, presence, mailboxes, the sync log, claims. Runtime-agnostic |
| `ws-server.js`, `hub.js` | The relay in Node: inside Acestes (hub mode) or alone, `node src/main/fleet/hub.js --port 7377` |
| `relay/cloudflare/` | The relay as a Cloudflare Worker, one Durable Object per fleet, so no computer has to host it |
| `client.js` | One device's connection: challenge, sign-in, reconnect, outbox, calls to the relay |
| `device.js` | This computer in a fleet: roster, keys by epoch, admission by code, rekey on removal, request/reply, sealed records, claims |
| `sync.js` | Records kept in step: stamp, pull, publish, newest stamp wins |
| `collections.js` | What sync carries, store by store, and what stays per machine |
| `tasks.js` | Remote runs and mirrors: the worker side and the watching side |
| `placement.js` | Which device runs a due job |
| `index.js` | The app's glue: `fleet.json` and `fleet-sync.json`, the vault, hub mode, IPC |

## Trust

- The relay never sees the fleet key. Messages and sync records are sealed
  under it and signed by the sending device; record names are HMACs, so the
  relay cannot tell a host from a memory note.
- A device joins with a one-time code. The joiner proves it holds the code
  with an HMAC over its own public keys; the inviter checks it and sends a
  welcome wrapped to the joiner's key, with a proof of its own.
- The roster each device keeps changes only through signed, sealed messages
  from members. Removing a device starts a new key epoch for the others.
  Every epoch's key is kept, and removed devices' signing keys are kept as
  "former", so records they wrote still read.

## Sync

A record is a collection, an id and a value (null when deleted), stamped
with a hybrid logical clock. Each round, one at a time: stamp local changes
(found by hashing each collection), pull what is newer from the relay's log,
then publish. The relay keeps one entry per record and refuses an older copy
over a newer one, handing the newer one back instead. A device that joins
pulls everything before it stamps anything, so the fleet's copy of a record
both have wins; a fresh install's own default agent is set aside.

Synced: hosts, folders, SSH keys, snippets and specs, proxies, trusted host
keys, agents (MCP servers, per-agent settings), shared assistant settings and
API keys, keychain secrets, memory notes, jobs and where each runs, and the
conversation list (as mirrors, fetched when opened).

Per machine: last connected times, local SSH agent socket, tunnel autostart,
Windows Hello keys, agent sandbox (granted folders) and hooks, runtime
sign-ins, installed and selected runtimes, local model server, voice models,
sounds, history retention, job run state and webhook tokens, channels.

## Remote runs and mirrors

`run_on_device` asks another device to run a brief as a conversation of its
own agent, in its own approval mode; the asking device holds a mirror, a tab
with no runtime whose events come from the worker, numbered, with a full
resync on a gap. Messages, stop and answers to cards go back. Every device's
own conversations are listed on the others as mirrors too: opening one
fetches it, and writing into it runs on the device that owns it.

## Scheduler

Every device has every job; the gate decides who runs a due one. Pinned: only
that device. Any (default): the device the job was made on first, the others
after a grace period each, and a claim on the relay picks one. Interval jobs
claim a lease for most of an interval. A locked device runs only its own
jobs; one cut off from the relay runs only its own too.

## Not done

- Inventory files (the Files page) are not synced yet.
- A mirror's composer shows this computer's model, not the worker's.
- Attachments do not go to a remote run.

On an RDP server: disconnecting RDP locks the session, which stops computer
use there. `tscon <session> /dest:console` hands it to the console instead.

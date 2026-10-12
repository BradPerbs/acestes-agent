# Teach mode

Draft design, 2026-10-12.

An employee turns teach mode on, does their normal work in their company's
apps and control panels, and turns it off. Acestes keeps a trace of what they
did, asks them a short Q&A, and turns both into a knowledge pack for an agent:
a map of each app, the procedures as specs, a glossary, and templates for what
they write. Nothing is trained. "Learning" means notes and specs, the same
memory the agent fills today by exploring on its own.

## The flow

1. **Start.** The person picks what may be recorded (apps, and sites for a
   browser) and optionally names the session ("Monday billing run"). A badge
   says it is recording for the whole session, with pause and stop.
2. **Record.** The desktop helper reports what the person does as event lines;
   the main process writes them to `userData/recordings/<id>/trace.jsonl`, with
   keyframes in `frames/`. Passwords included.
3. **Stop, first pass.** The trace is split into episodes and drafted into an
   app map, procedures, a glossary, templates and a list of questions.
4. **Q&A.** The logins it captured, to keep or drop, and any it could not
   capture. Then at most 8 questions, under 10 minutes, each shown beside the frame
   or the steps it is about. Answered by voice (Parakeet, local) or text. Any
   question can be skipped, and any episode dropped ("don't learn this").
5. **Second pass.** The answers are folded into the drafts.
6. **Review.** The person accepts, edits or drops each item. Accepted items go
   into memory (facts) and specs. The raw trace is then deleted by default.
7. **Hand over.** The pack can be exported to the agent that will do the work,
   on another machine (built on `memory.exportAgent` / `importAgent`).

## The trace

JSON lines. The first is a header; every event after it has `t` (ms since the
start), `type`, and `app` (process name) and `window` (title) where they apply.
Targets are described in the words the agent acts in later: the same role and
name `read_screen` shows, plus a short path of named ancestors.

```jsonl
{"v":1,"type":"header","id":"rec-01","started":"2026-10-12T09:02:11Z","machine":"PC-ANNA","scope":{"apps":["chrome.exe","EXCEL.EXE"],"sites":["panel.example.com"]}}
{"t":0,"type":"window","app":"chrome.exe","window":"Domains - Plesk","url":"https://panel.example.com/smb/web/view"}
{"t":1840,"type":"page","app":"chrome.exe","url":"https://panel.example.com/smb/web/view","title":"Domains","headings":["Domains","Websites & Domains"]}
{"t":5210,"type":"click","button":"left","target":{"role":"button","name":"Add Domain","path":["main","toolbar"]}}
{"t":700,"type":"field","target":{"role":"edit","name":"Username"},"value":"anna.rossi"}
{"t":980,"type":"login","target":{"role":"edit","name":"Password"},"site":"panel.example.com","user":"anna.rossi"}
{"t":1840,"type":"content","text":"Domains\nexample.com  Active  Website hosting  ..."}
{"t":9022,"type":"field","target":{"role":"edit","name":"Domain name","path":["form 'Add a Domain'"]},"value":"example.org"}
{"t":11870,"type":"select","target":{"role":"combo box","name":"Hosting type"},"value":"Website hosting"}
{"t":12400,"type":"keys","keys":"enter"}
{"t":12950,"type":"frame","file":"frames/000004.png","reason":"page"}
{"t":64000,"type":"gap","until":191000}
{"t":191000,"type":"mark","note":"this one is a reseller, different plan"}
```

| type | when | what it carries |
|---|---|---|
| `window` | the foreground window changes | app, title, URL for a browser |
| `page` | a browser's URL or title changes | URL, title, headings from the UIA tree |
| `content` | after `window` or `page`, once it settles | the visible text of the window, up to 8,000 characters |
| `click` | the person clicks in scope | button, target |
| `field` | the person leaves a field they changed | target, final value (never a password) |
| `login` | a password field was filled | target, the site and the username beside it; no password |
| `select` | a list, combo or tab selection changes | target, value |
| `keys` | a shortcut or a special key | `ctrl+s`, `enter`, `tab`, `esc`, `f5`... |
| `frame` | a keyframe is saved | file, reason |
| `gap` | an app out of scope is in front | only the time; no app name, no title |
| `mark` | the person presses the mark hotkey | an optional spoken note |
| `pause` / `resume` | the person pauses | nothing else |

### What is recorded, and where it goes

What appears in the apps in scope is recorded: what the person types into
ordinary fields, what they choose, and the text each page or window shows.

- **Passwords are never recorded.** Windows hides a password field's contents
  from other programs on purpose, and the one way around that is to log the
  keys as they are typed. A background process on an employee's machine that
  lifts passwords out of login forms is a credential stealer whatever it is
  for, so the recorder does not do it. When the person types into a password
  field, the trace holds only a `login` line: the site, the username in the
  field beside it, and that a password was entered, never the password.
- **The agent still gets to sign in,** but by the person handing the password
  over on purpose, not by the machine skimming it. See "Logins and the Q&A".
- **Other values are kept as they are.** Customer names, IPs, plan names and
  account numbers are what the agent needs to understand the screens.
  Redaction is a setting a company can turn on, with patterns (card numbers
  by Luhn check, IBANs, their own), not the default.
- **Keystrokes are not logged.** The field's value when the person leaves it
  already holds what they wrote, so there is no keystroke logging at all.
- **Apps out of scope are a `gap`.** The person chose what to record; the rest
  of their screen is theirs.
- **No timings in the pack.** The pack carries dates, not durations or counts
  per person, so it cannot be used to rate how fast someone works.

### Logins and the Q&A

Each `login` line becomes an entry in the Q&A at the end, where the person
decides it deliberately:

- **Keep or drop.** Each login the recorder saw is shown by site and
  username. Dropped, it is gone.
- **The password is typed once, into a masked field, in the Q&A.** It is held
  only in memory, as part of the draft pack. It reaches the keychain only when
  the person accepts the pack (see "Accept and discard"), stored with the
  agent's own credentials under `site-user`, and the specs reference it as
  `{{secret:site-user}}`, which `type_text` fills in when the agent signs in.
  Nothing is written speculatively: a recording the person discards leaves no
  password anywhere, because the password only ever existed in memory.
- **Two-factor.** A one-time code is no use later, and the recorder cannot see
  an authenticator's seed. The Q&A asks how the second factor works for that
  login: a TOTP seed the person gives, a shared mailbox the agent can read, or
  a push to a phone, which means a person approves each sign-in.
- **Whose account.** Reusing an employee's login means the panel's audit log
  shows the employee for everything the agent does, and it breaks when they
  change their password or leave. The Q&A offers to note a dedicated account
  for the agent instead.

### Accept and discard

The draft pack, the passwords typed in the Q&A included, lives in memory until
the person decides:

- **Accept** writes the kept facts and specs into the agent's memory, and the
  kept logins into the keychain, then deletes the recording on disk. This is
  the one point where a password is written anywhere, and the review screen
  says so, because a keychain entry is then removed from the keychain like any
  other secret rather than by discarding the recording.
- **Discard** drops the draft: the in-memory passwords are overwritten, the
  recording file and its frames are deleted, and nothing reached the keychain,
  the memory or the specs.

## Changes to the desktop helper (`tools/DesktopHelper.cs`)

One new command and a recorder thread. The rest of the protocol is unchanged.

```jsonc
{"id":7,"cmd":"record","on":true,"scope":{"apps":["chrome.exe","EXCEL.EXE"]},"frames":true,"label":"Recording · Ctrl+Alt+P to pause"}
{"id":8,"cmd":"record","on":false}
// events come back unasked, like took-over and escape do today:
{"event":"rec","line":{"t":5210,"type":"click", ...}}
```

- **Clicks.** The low-level mouse hook used today for taking over is reused.
  In the hook, only note the point and the button (it must return quickly),
  and only when the event has no `Mark` and the window in front is in scope.
  The hit test runs on the recorder thread, through `ElementFromPointBuildCache`
  with a cache request adding `AutomationId`, `ClassName`, `IsPassword` and the
  names of two or three ancestors.
- **Fields.** `AddFocusChangedEventHandler` on the recorder thread. When focus
  arrives at an editable element (`HasValue` and not `ValueIsReadOnly`, or an
  edit or document), keep it and its value. When focus leaves, read the value
  again and emit `field` if it changed. Rich editors with no value pattern are
  read through `TextPattern` (DocumentRange, capped at 4,000 characters). The
  focused field is also read on Enter, and on a click elsewhere, because a web
  button that does not take focus never moves it. The handler only queues
  work; the reading happens on the recorder thread.
- **Password fields are the one thing left alone.** A field with `IsPassword`
  is never read and the keys typed into it are never logged. When focus leaves
  one that was changed, the recorder emits a `login` line, not a `field`: the
  top-level window (the site, for a browser), and the value of the nearest
  preceding text field as the username. No password, and no keystroke buffer
  anywhere in the helper.
- **Content.** Once a new window or page settles, its visible text is read as
  the `text` command does today, capped at 8,000 characters.
- **Windows and pages.** `SetWinEventHook` for `EVENT_SYSTEM_FOREGROUND`, and
  `EVENT_OBJECT_NAMECHANGE` on the foreground window, out of context, on the
  UI thread that already runs `Application.Run`. A browser's title changes on
  each navigation; the URL is the address bar's value. (To verify: whether
  Chromium's document element gives the URL as its Value, which would avoid
  depending on the address bar's localized name.)
- **Keys.** Outside a password field, the existing keyboard hook emits `keys`
  only for combinations with Ctrl, Alt or Win, and for Enter, Tab, Esc and the
  F-keys.
- **Frames.** On `window` and `page`, and after a click whose target has no
  name (a sign that UIA sees little there): capture the window, not the
  screen, at most one frame every 2 seconds, and drop one that barely differs
  from the last (16 by 16 grayscale difference).
- **Badge.** `overlay.Badge` with a new `Tone.Recording`, hidden from capture
  like the others. A hotkey pauses and a second one drops a mark.
- **Threads.** The worker answers requests one at a time, so recording cannot
  run there. The recorder thread is MTA, has its own `IUIAutomation`, and
  takes work from its own queue.
- **Driving.** In v1, recording and driving are exclusive: `drive` is refused
  while recording, and the reverse.
- **Elevated apps.** The hooks see nothing in an elevated window unless the
  helper is elevated too. Those show up as gaps.

## Main process (`src/main/ai/teach.js`, new)

- Start, pause and stop over IPC. It uses the helper process `computer.js`
  already runs and takes the `rec` event lines from it.
- Applies the company's redaction patterns if turned on, writes `trace.jsonl`
  and the frames, and deletes the recording once the pack is reviewed (or
  after 7 days).
- **Episodes.** Split on gaps over 2 minutes, a change of app, and marks. Each
  episode is rendered as readable steps for the model:

  ```
  09:02 Chrome · panel.example.com · Domains
    click button "Add Domain" (toolbar)
    enter "Domain name" = example.org
    choose "Hosting type" = Website hosting
    press Enter
  ```

- **Distilling.** Asked of the runtime as `titles.js` and `memory-tidy.js` ask:
  one turn, no tools, no session in the user's history. Frames go along only
  for episodes where UIA said little. The first pass returns JSON:

  ```json
  {
    "episodes": [{"id": "e3", "title": "Add a domain for a customer", "apps": ["chrome.exe"]}],
    "appMap": [{"app": "panel.example.com", "where": "Mail queue", "path": "Tools & Settings > Mail Server Settings > Mail Queue"}],
    "procedures": [{"name": "Add a hosting domain", "episodes": ["e3", "e7", "e12"], "params": ["domain", "plan"], "steps": ["..."], "branches": ["reseller customers: plan is Reseller Basic"]}],
    "glossary": [{"term": "SUB", "meaning": "..."}],
    "templates": [{"name": "Welcome email", "text": "Hi {{name}}, your domain {{domain}} is live..."}],
    "questions": [{"id": "q1", "episode": "e7", "frame": "frames/000031.png", "text": "On the second domain you opened Billing before saving. Why?"}]
  }
  ```

- **Repetition.** The same procedure seen several times becomes one spec. The
  values that changed between runs are its parameters, and the steps that
  differed become branches or questions.

## The Q&A

Logins come first and do not count towards the 8: each `login` line is shown
by site and username to keep or drop, the password for a kept one is typed
into a masked field there, and each gets one question about its second factor.
What is typed is held in memory with the draft and reaches the keychain only
on accept (see "Accept and discard").

Then at most 8 questions, chosen in this order of value:

1. Decision points: why one path was taken over another.
2. Constant or variable: is this value always the same?
3. Differences between repeats of the same task.
4. Terms and abbreviations it could not place.
5. Waits and off-screen steps ("you stopped for 6 minutes here: waiting for
   what?").

Each question shows its frame or steps. Voice or text, skip, or drop the
episode. The aim is under 10 minutes.

## The knowledge pack

- **App map** becomes facts, tagged with the app or site, e.g. "On
  panel.example.com the mail queue is under Tools & Settings > Mail Server
  Settings > Mail Queue."
- **Procedures** become specs: when to use it, parameters, steps written as
  windows, control names, URLs and commands, the checks at the end, and which
  recording it came from and when.
- **Glossary** becomes facts tagged `glossary`.
- **Templates** become specs (or inventory files when long).
- **Logins** are keychain entries, and the specs refer to them by name: "sign
  in as anna.rossi with `{{secret:panel.example.com-anna.rossi}}`".

Before the pack leaves the person's machine, they see all of it. The keychain
is encrypted with the OS (DPAPI on Windows), which only that Windows account
on that machine can open, so logins cannot travel as they are stored. An
exported pack carries them encrypted with a passphrase the person picks
(AES-256-GCM, key from scrypt); importing asks for it and puts them straight
into the receiving agent's keychain.

## Limits

- **Citrix, RDP and VDI** are one window of pixels to UIA. They get frames
  only, read by vision, and their drafts are marked as less certain. Worth
  checking early, since many companies run their main tools this way.
- **Apps that describe little** (some Java, custom-drawn UIs) are the same.
- **Mac** needs the same with `AXObserver` in `tools/mac`, later.

## Build order

1. Helper `record` mode: windows and titles, clicks, fields, content, keys,
   badge, the trace on disk. Tested on Calculator and Character Map only.
2. Password capture, tested on a local test page with a
   login form.
3. Episodes and the first pass, with a plain trace viewer for development.
4. Q&A panel with logins first, second pass, review into memory and specs.
5. Frames.
6. Pack export and import, logins under a passphrase.
7. Mac.

## Open questions

- Is the recorder the full Acestes app on the employee's PC, or a slim
  recorder-only install? The full app is the quickest to build; a slim one is
  easier for a company to roll out.
- Does distilling run on the employee's PC with their own runtime, or does the
  trace go to whoever set the agent up? Local is better for privacy, and only
  the reviewed pack leaves the machine.

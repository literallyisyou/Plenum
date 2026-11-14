# Extending Plenum

How to add a feature to Plenum without changing a file that everything else depends on. Each part of Plenum that can grow is a
folder that Plenum reads when it starts: you add one file, and nothing else is edited. This guide lists those folders, the shape
of a file in each, the data that can grow without any code, and the test each addition needs.

This file is for people and models working on Plenum's source. The installed app does not carry it.

One package this guide describes is not in this build yet: channels that send for the owner (`lib/channels.mjs`). Every row,
paragraph and example that belongs to it is marked "(later build)". Handing a task to another program (`lib/programs.mjs`,
`lib/program-run.mjs`), businesses and their templates (`lib/business.mjs`, `lib/business-templates/`), the owner's list of
decisions (`lib/decisions.mjs`) and routines (`lib/routines.mjs`) are in the project since 13 Nov 2026.

## The rules that hold for every addition

1. **One file in a discovered folder.** Do not edit `server.mjs`, `public/app.js`, `desktop/main.cjs` or a loader to make room
   for a feature. If a kind of thing has no folder yet, add the discovery once (one loader, one test that pins it) and then use it.
2. **What can grow is data.** Models, the team and kinds of work are records in files with a version; so are programs,
   businesses, routines and templates. Nothing is written against today's list of models, subscriptions or
   businesses.
3. **State has a version and a `migrate(raw)`.** An older file, a damaged file and a file from a newer Plenum all load. A file from
   a newer Plenum is read and never written. A new field has a default. Nothing is written until there is something to save.
4. **The contract is written once**, in the comment at the top of the module that owns it (routes, JSON shapes, events, tool names
   and arguments), and a test pins it.
5. **A neighbour is optional.** A module that uses another new module loads it with `import()` inside `try`, on first use, inside a
   function, and keeps the result. Do not `await import()` at the top of a module: `lib/routes/index.mjs` and `lib/turn-hooks.mjs`
   load every route and hook with a top-level await, and two modules that wait for each other never finish loading.
   (`lib/team-run.mjs` is the one exception and says why.)
6. **Nothing new is on until the owner turns it on.** Ask first stays the default approval mode. A worker never gets more rights
   than the lead that started it, and neither will a program. Nothing leaves the PC and no money moves without the
   owner's OK.
7. **Only Plenum's window shows.** Every program Plenum starts is started hidden (`windowsHide: true`), with nothing on its input
   and a time limit, and Stop ends its whole process tree.
8. **Keys and tokens never reach** a file, a log, an error, an argument, a child's environment or the page.
9. **Page text goes in through `textContent`.** No inline script or style, no `style` attribute, colours from the tokens in
   `public/style.css`. A missing or failing route is answered with one calm line.

## The folders Plenum reads

| To add | Put a file in | Named | Read by |
| --- | --- | --- | --- |
| A route | `lib/routes/` | `<name>.mjs` | `lib/routes/index.mjs` |
| A panel, a Settings section or a side pane | `public/` | `ext-<name>.js` and `ext-<name>.css` | `public/ext.js` through `GET /api/ext-modules` |
| A tool for models | `lib/tools/` | `NN-name.mjs` | `lib/tools.mjs` |
| A part of the system prompt | `lib/prompt-parts/` | `NN-name.mjs` | `lib/prompt.mjs` |
| A step around each turn | `lib/hooks/` | `NN-name.mjs` | `lib/turn-hooks.mjs` |
| A desktop handler | `desktop/handlers/` | `<name>.cjs` | `desktop/handler-loader.cjs` |
| A business template | `lib/business-templates/` | `NN-name.json` | `lib/business.mjs` |

The packages of businesses, the owner's list, routines and programs were added this way, and none of them needed an edit of a central
list: a route they add (`GET /api/business/charter`, `POST /api/programs/check`) needed no edit in `server.mjs`; a panel
(`ext-business`, `ext-programs`) needed no edit in `public/index.html` or `ext.js` (the server lists `ext-*.js` and the loader
brings each with its stylesheet); a hook and a prompt part are found by their folders (`lib/hooks/70-business.mjs`, `72-decisions.mjs`,
`lib/prompt-parts/60-business.mjs`).

Every one of these is read through `lib/overlay.mjs` (the desktop folder by its own loader), so a file that an applied update adds
or replaces is found as well.

### A route

A file in `lib/routes/` exports `routes`, an array of `{ method, path, handler, gated? }`. The handler gets
`{ req, res, url, json, readBody, httpError, store, projectById, events, ... }` and answers with `json(res, status, data)`; a
refusal is `throw httpError(400, 'One plain sentence.')`. The server checks the Plenum token before any handler and holds every
POST until the License Agreement is accepted; a GET that reaches the network or a provider sets `gated: true`. A POST also calls
`requireToken(req, httpError)` from `lib/auth.mjs`.

A route file imports statically only node's own modules, modules that already exist and its own package's lib file. A route file
that does not load stops every server, so check it with `node --check` and import it once before it goes into the folder.

Write the routes and their JSON shapes in the comment at the top of the file. Example: `lib/routes/services.mjs`.

Test: call the handlers with fakes for each shape and refusal, and import `lib/routes/index.mjs` and `lib/turn-hooks.mjs` in a
sealed child process with a time limit of 20 seconds. The battery's `v06/legal-gate` walks `allRoutes()` and fails on a POST that
is not held by the gate.

### A panel

Two files with one name, `public/ext-<name>.js` and `public/ext-<name>.css`: the loader asks for both. The script is one function
that runs at once, reads `window.MuseUI` and adds itself:

- a Settings section: `MuseUI.settings.register({ id, scope: 'app', group, title, order, render })`. The groups are a fixed list in
  `public/app.js` (`project`, `rules`, `accounts`, `api`, `roles`, `agents`, `safety`, `phones`, `general`, `updates`, `legal`); an
  unknown one lands under More.
- a side pane: `MuseUI.pane.register({ id, title, icon, order, render, titleButton })`, opened with `MuseUI.pane.open(id)`.
- a chip in the title bar: `MuseUI.slots.add('titlebar', id, node, order)`.

Ask the server through `MuseUI.request(path, { method, body })` or `MuseUI.api(path, body)`; listen with
`MuseUI.events.on(type, fn)`. Ask nothing before the panel is drawn and nothing after it left the page. Draw a registered notice
only by an id that `lib/notices.mjs` holds, through the guarded call `MuseUI.notice?.(id, ...)`.

The look follows the visual refresh: tokens only, both themes, usable at 480 px, every control reachable by keyboard with the
focus kept where the person was. Example: `public/ext-services.js` and `public/ext-services.css`.

Test: a static check (text only through `textContent`, no notice id the registry lacks, no literal colour), and the real page in
the hidden Electron harness at 1280 and 480 px in both themes, by keyboard only, with the route missing and failing. Look at the
pictures.

### A tool

A file in `lib/tools/` named `NN-name.mjs`. Its shape is documented at the top of `lib/tools/10-files.mjs`: each entry has a
`name`, a `description`, an `input_schema` and `run`, and a tool that changes something has a `plan`, which is what the approval
card shows. The engine in `lib/tools.mjs` applies the rules every tool shares (the path guard, the scope of a delegated coder,
snapshots, the command deny list). A tool never widens a folder, an approval mode or a spending limit.

The battery pins the list of tool files in three places (one of them in a suite that must not be edited), so a new tool file means
updating those lists; a new argument of an existing tool means updating that tool's pinned argument list. Say so in the report.

Test: the tool against a temporary project folder, with the approval card it asks for in Ask first, and a refused path.

### A prompt part

A file in `lib/prompt-parts/` named `NN-name.mjs` exports `parts`, an array of `{ id, order, contexts, text }` (see the top of
`lib/prompt.mjs`). A part adds text only: nothing in a part approves an action, widens a folder or turns a tool on. Keep it short;
every call pays for it. The battery pins the list of part ids. Example: `lib/prompt-parts/40-focus.mjs` (text that is added only
when the project has build focus on, and nothing otherwise). The part for businesses, `lib/prompt-parts/60-business.mjs`, adds text to a chat turn only
in a project that belongs to a business; the test that pins the list of part ids (`build/v06/gw-03-prompt-parts/parts.test.mjs`) names it.

Test: `buildSystem` with a hand-built context gives the text, and gives nothing when the feature is off.

### A turn hook

A file in `lib/hooks/` named `NN-name.mjs` may export `expandMessage(ctx, text)`, `beforeTurn(ctx)` and `afterTurn(ctx, turn)` (see
the top of `lib/turn-hooks.mjs`). A hook that fails becomes one notice and the turn goes on. Examples: `lib/hooks/30-mentions.mjs`
(`expandMessage`) and `lib/hooks/50-checks.mjs` (`afterTurn`). The hooks of businesses and of the owner's list, `lib/hooks/70-business.mjs` and
`lib/hooks/72-decisions.mjs`, are found by their folder like any other: nothing in `server.mjs` names them.

Test: the hook with a hand-built context `{ project, scope, record, send }` and a temporary data folder.

### A desktop handler

A file in `desktop/handlers/` exports `{ name, messages: { [type]: async (message, shell) => reply }, hooks? }` (see the top of
`desktop/handler-loader.cjs`). The server reaches it with `shellRequest(type, payload)` from `lib/shell.mjs`, which answers 503
under plain Node. Never call `dialog.show*` from a handler that a test loads, and never log a message body.

The battery pins the message names and the hooks (`v06/gw-04-desktop-handlers`): give your messages a prefix of their own and add
that prefix to the filter there, and prefer messages over hooks. Example: `desktop/handlers/autostart.cjs`.

Test: the handler through `handleMessage` with a fake `shell` (a fake Electron `app`), never the real one.

### A notice

A danger is explained by a notice, not by a hard limit. Notices are entries in `lib/notices.mjs`, and that file, `lib/legal.mjs`
and their routes and panels cannot be changed by an applied update. A new notice is an edit of `lib/notices.mjs` in a release, with
its words reviewed; two battery tests read every `public/*.js` and fail on an id the registry does not hold.

## Data that grows without code

| What | Where | How to add one |
| --- | --- | --- |
| A kind of work (Find, Research, Code, ...) | `team.json`, `kinds` (`lib/team.mjs`) | A built-in kind is one entry in `DEFAULT_KINDS` of `lib/team.mjs`. A kind of the owner's own is one entry in `kinds`: `{ id, label, about, agent, workers, effort, reply, answerMax }`, saved with `POST /api/team`, which takes the whole list (the Team page shows the kinds and has no button to add one yet). The delegate tool's `work` argument names the kind. |
| A model in the team | `team.json`, a kind's `workers`, in the owner's order | Settings > Agents > Team. A model is named by its ref (`provider:id`); the catalog and the CLI account lists say which exist. |
| A program for a hand-off | `programs.json`, `programs` (`lib/programs.mjs`) | A CLI Plenum already drives: one entry with its `best` line. An agent on Plenum Hub: `{ id: 'hub:<agent>', via: 'hub', agent, best }`. A CLI Plenum does not drive yet: its adapter beside the others in `lib/` (see `lib/cursor.mjs`, `lib/grok.mjs`), one line in `BUILT_IN` and one in `ABILITIES` of `lib/programs.mjs`. |
| A business | `businesses.json` (`lib/business.mjs`) and its own folder | The Businesses pane. Its files (`BUSINESS.md`, `STATE.md`, `PLAN.md`, `playbooks/`) live in the owner's folder, never in the program folder. |
| A business template | `lib/business-templates/NN-name.json` | One JSON file: `{ v, id, label, about, business, files, routines }`. Routines in a template are created switched off. |
| A routine | `routines.json` (`lib/routines.mjs`) | The Businesses pane. Models cannot create or switch on a routine. |

Where the next kinds go:

- **A second kind of routine.** A routine has `kind: "lead"` (a lead model runs a playbook as an ordinary chat turn).
  A second kind is a new value of `kind` with its own runner inside `lib/routines.mjs`, chosen where a due routine is started; an
  old file loads because `migrate` gives a routine without a kind the value `lead`. A kind that runs a command with no approval
  card is not wanted: a run is a chat turn so that approvals, limits, Stop and the saved history are the existing ones.
- **A first sending channel (later build)** (email, a message, a post). Nothing sends by itself: a lead prepares the text, saves
  it under the business's `outbox/` and asks with an `OWNER:` line (`lib/decisions.mjs`). A channel is a new module
  `lib/channels/<name>.mjs` with one loader in `lib/channels.mjs` (add the discovery once), a record of standing permissions per
  business with a limit each, and a line in the business's record for everything sent. What leaves the PC in the owner's name
  needs his OK unless he allowed that kind of message.
- **A background service.** The rows of Settings > General > Background services are read by `lib/routes/services.mjs`: a new
  service is one more reader in `READERS` there that answers `{ id, label, state, why, action }` from memory. A row's button is
  either the page's own (`open-...`) or an id handled by `POST /api/services/action`. A row never ends in "Check again" alone
  while Plenum itself can still do something about it. A program started in the background is started hidden, with nothing on its
  input, and with an environment that holds no key and none of Plenum's own variables (`ENV_DROP` in `lib/hub-starter.mjs`, and the
  same list as `STARTER_ENV_DROP` in `lib/hub.mjs`: inside the desktop app the server's environment has `ELECTRON_RUN_AS_NODE=1`, which makes any Electron program that inherits
  it run without its window).

## The state files

All in Plenum's data folder (`store.HOME`: `%USERPROFILE%\.muse-console`, or the desktop app's user-data folder). The JSON files are
written with `writeFileAtomic` from `lib/atomic-write.mjs`, one write at a time; the log `team-log.jsonl` gets one line appended for
each finished task and is renamed to `team-log.1.jsonl` at 4 MB. Every tool refuses this folder to every model.

| File | Version field | Module that reads a file of any age |
| --- | --- | --- |
| `state.json` (projects, chats, settings) | none: every missing field takes its default on load | `lib/store.mjs` |
| `team.json`, `team-log.jsonl` | `v: 1` (each line of the log has its own) | `lib/team.mjs`, `lib/team-log.mjs` |
| `programs.json` | `v: 1` | `lib/programs.mjs` (`migrate`) |
| `businesses.json`, `business-charter.json`, `business-log/<id>.jsonl` | `v: 1` | `lib/business.mjs` (`migrate`) |
| `decisions.json` | `v: 1` | `lib/decisions.mjs` (`migrate`) |
| `routines.json` | `v: 1` | `lib/routines.mjs` (`migrate`) |
| `services.json` | `v: 1` | `lib/hub-starter.mjs` (`migrate`) |

To add a field: give it a default where the module reads the file (`migrate`) and leave `v` alone. Raise `v` only when an old file can no longer be
read as it is, and add the step to `migrate`. Test `migrate` with a file from before the change, a damaged file and a file with a
higher `v`.

## Events

The page listens on `GET /api/events`; a module publishes with `events.publish({ type, ... })` from `lib/events.mjs`. The types
that the features in this guide add: `{ type: "team", reason }` and `{ type: "services", reason }`. The older types (`hello`, `state`,
`run`, `approval`, `notice`, `agent`, `app-update`) are listed in the top comment of `lib/events.mjs`; other modules publish types of
their own (`hub`, `phone`, `browser`, `drive`, `project`, `activity`). The types of the programs, businesses, list and routines packages:
`{ type: "programs", reason }`, `{ type: "business", reason, id }`, `{ type: "decisions", waiting }` and
`{ type: "routine", action, routine }`. A new feature takes a type of its own and writes it in its module's top comment. An event
never holds a key, a token or a file's text.

## Plenum Hub

The hub is another program with its own folder and its own session. Plenum never edits that folder, never reads its `.env`, never
holds its admin key and never runs Docker. It uses only what the hub's contract names (`docs/PLENUM-INTEGRATION.md` in the hub's
folder): `agent-key` and `owner-status` in `lib/hub.mjs`, and `state`, `up` and `wake` in `lib/hub-starter.mjs`. A new use of the
hub starts with a new entry in that contract, then one function in one of those two modules. Tests use a stand-in starter folder
and a fake hub, never the real ones (ports 8790 and 8791).

## Tests

Tests live outside the repository, one folder for each package, as `node:test` files. They run sealed:
`bash ultra/seal.sh <label> node --test <files>` sets an empty `APPDATA`, a fresh data folder, a `PATH` with no real CLI and the
accepted License Agreement, and `PLENUM_NO_SERVICES=1` and `PLENUM_NO_SCHEDULER=1`, so that nothing reaches the owner's real hub. A
server that a test starts with an environment of its own does not inherit them and sets them itself, with a `USERPROFILE`, a `HOME`
and a `PORT` of its own, unless the test is about exactly that.

- No test calls a real model, a real CLI with a prompt or a provider: `echo:offline`, fake streams and stand-in CLIs on `PATH`.
- Each behaviour has a test that fails without the code.
- A state file: `migrate` with files of every age.
- A page: the hidden Electron harness, both themes, 480 px, keyboard only, the route missing.
- A program that is started: the whole process tree is gone after Stop and after a time limit.

## What a feature must never touch

- **The updater and the applied-updates overlay**: `lib/updates.mjs`, `lib/overlay.mjs`, `lib/overlay/`, `desktop/handlers/app-update.cjs`.
  A feature must load from an applied update as it loads from the install folder, which the discovered folders already give it.
- **The build identity**: `lib/build-info.mjs`, `scripts/stamp-build.mjs`, `build-info.json`.
- **The legal texts and the gate**: `LICENSE.txt`, `legal/`, `lib/legal.mjs`, `lib/notices.mjs` and their routes and panels.
- **The floor**: the credential and data folders stay refused to every tool; Plenum's own source changes only through the Updates
  panel; a visible indicator while a model controls the screen or the browser; a Stop that always works. No setting turns these off.
- **The owner's data**: what a feature keeps for the owner is in the owner's folders and Plenum's data folder, never in the program
  folder, so an update keeps it (a business's files are the first case).

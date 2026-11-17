# Plenum

A local console that runs Claude Code, Codex, Gemini CLI and Muse Code, and API models. It runs on your machine, serves a browser UI at
http://127.0.0.1:4317, and talks to:

- **Claude** through the Claude CLI (`claude`), signed in with your Claude account. It reads and searches the project, creates and edits files, runs commands, and can propose changes to Plenum itself. Without the CLI it falls back to the Anthropic API and a saved key.
- **Muse Code** (Meta) through `muse exec`, run in the project folder. Sign in with `muse login`, or set `META_API_KEY`.
- **Codex** through `codex exec`, run in the project folder. By default it may change files in the project folder only.
- **Gemini** through the Gemini CLI (`gemini`), signed in with a Google account and run in the project folder.
- **Antigravity** through Google's Antigravity CLI (`agy acp`), signed in with a Google AI Pro, Ultra or Plus account. This is how a Gemini subscription reaches Plenum now: since 18 June 2026 Gemini CLI's Google sign-in no longer serves those plans. The model menu lists the models your account may use, Gemini 4 Hydrogen among them.
- **Grok (xAI), OpenAI, DeepSeek, Mistral and Google AI** through their APIs, and **OpenRouter** for any model it lists. These are billed per token with a key you save in the Accounts panel. See [API model providers](#api-model-providers).
- **Echo**, an offline test provider that calls nothing.

## Platforms

Plenum runs on Windows, macOS and Linux. Build the desktop app from this folder. The first build downloads Electron (and, on Windows, the NSIS installer tools):

```bash
npm install
npm ci --prefix mobile # the phone shell that dist bundles
npm run dist           # Windows: NSIS installer, portable .exe and zip (x64)
npm run dist:mac       # macOS: dmg and zip for arm64 and x64
npm run dist:mac:arm64 # macOS: dmg and zip for arm64 only
npm run dist:mac:x64   # macOS: dmg and zip for x64 only
npm run dist:linux     # Linux: AppImage and deb (x64)
```

Installers are written to `release/`.

Pushing a version tag (`v*`) runs `.github/workflows/release.yml`. It builds Windows on `windows-latest` (`npm run dist`), macOS arm64 on `macos-latest` (`npm run dist:mac:arm64`), macOS x64 on `macos-15-intel` (`npm run dist:mac:x64`), and Linux x64 on `ubuntu-latest` (`npm run dist:linux`). Each build is uploaded as a workflow artifact, and the build's installers and update files are attached to a draft release on this repository (see [New versions](#new-versions)). The workflow's own token makes the draft, so no secret is needed for that. A draft is invisible to installed apps until you publish it. CI runs `npm run legal`, `npm run mobile:build` and `npx electron-builder` for each target with `--publish always` and `PLENUM_RELEASE=1`. A local `npm run dist` does not set `PLENUM_RELEASE=1`, so a placeholder in the legal texts is only a warning there.

The macOS builds from the release workflow are unsigned until signing certificates are added, and the Linux builds are not signed. The Windows and macOS jobs sign only when their certificate secret is set (`WIN_CSC_LINK`, `CSC_LINK`), and a broken certificate fails the build instead of shipping unsigned. The macOS job notarises only when all three App Store Connect secrets are set (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`). Until a build is signed, Windows SmartScreen may warn about the installer, and macOS asks you to allow the app in System Settings under Privacy & Security.

## Windows app

The installer is written to `release/` as `Plenum Setup 0.6.0.exe`. It shows the licence page first, which you accept before anything is installed. It installs per user (no admin rights needed) to the default per-user folder, without asking for a folder, and adds a Desktop shortcut and a Start menu entry. It opens Plenum in its own window. Closing the window stops the server, unless **Keep in tray on close** is on (see [Portable and tray mode](#portable-and-tray-mode)).

`npm run pack` builds an unpacked folder at `release/win-unpacked/` for quick testing: run `Plenum.exe` in it. `start.bat` opens that build.

To keep it on the taskbar, open Plenum, right-click its taskbar icon and choose **Pin to taskbar**.

The look follows the system (light or dark). The **Theme** button in the sidebar, or `/theme dark`, overrides that. Both themes use one calm look: a soft field of colour with the side panel, the chat and an open pane lying on it as sheets, the message box as a capsule, round buttons, one accent for the main action, links and focus, and the same buttons, fields and menus in every panel. Where Windows has its transparency effects off, or a high-contrast theme is on, every layer is solid and nothing is blurred. Motion is short and is off when the system asks for reduced motion.

Applied updates are kept in Plenum's state folder, never in the install folder, so the install location does not need to be writable for them. See [Updates to Plenum](#updates-to-plenum).

### Starting, health and build identity

- The server answers /api/health at once ({ ok, pid, uptimeMs }), before and after the License Agreement is accepted. The desktop window waits on it, and restarts the server by itself if it ends.
- /api/status never waits for a CLI or a model list. It returns what it last read and refreshes in the background. When something changes, the page is told by a 'providers' event and asks again. Model lists for Codex, Antigravity and Muse Code are read from the CLIs themselves. A model a CLI no longer offers is shown with a note and a way to pick another. Plenum does not switch your model for you.
- Every build says which one it is. 'npm run stamp' (node scripts/stamp-build.mjs) writes build-info.json (version, build as UTC YYYYMMDD.HHmm, commit, dirty, builtAt); the release workflow runs it before the build. GET /api/build-info and the log line read like 'Plenum 0.6.0 (build 20261113.0412, 0af7276)', and a development copy reads 'Plenum 0.6.0 (development copy)'.
- The repository now lives at https://github.com/literallyisyou/Plenum.
- The desktop app writes its log to `server.log` in its data folder. Every line the app writes starts with its time. At 5 MB the file is renamed `server.log.1` (the one before is replaced) and a new one starts. A full disk or a locked file stops the log from writing and does not stop Plenum; the log opens the file again after 30 seconds and then says how many lines it lost. The user name in a path is replaced by `~`, and keys and the launch token never reach the file. Every end of the server process is one line with its kind, its exit code and the last thing it printed on stderr. [Help](#help-and-diagnostics) can open the folder.
- The start does not wait for the Windows registry. The app reads the registry's variables for the server while the window opens, both keys at once, and gives up on a reading after 1.5 seconds; the server then starts with the variables the app already has.
- If you open Plenum a second time while the first copy is still quitting, the first copy opens Plenum again once it has finished quitting (it does not when Windows is ending the session). If Plenum is running with no window, opening it again makes a window.
- The boxes the app shows when it cannot start or the server stops (Try again, Open log, Quit) have a **Copy details** button. It puts the words of the box, the build and the last lines of the log on the clipboard, with your user name in paths hidden, and asks the same question again.

### Background services, Start with Windows and Plenum Hub in the background

Open **Settings > General > Background services**. Each row is one thing Plenum runs or needs: Plenum itself, your sign-ins, and Plenum Hub with its helper. A row says in a word whether it runs, says why in a sentence, and has one button when there is something to do: **Open Accounts**, **Start**, **Start anyway**, **Start the helper**, **Set up the hub**, **Check again**. Plenum itself opens no window for these, and the section starts no CLI.

- **Plenum Hub.** Plenum starts the hub and its helper for you, hidden, through the hub's own starter. If the hub was never set up on this computer, **Set up the hub** lets the hub install and build in the background, and the row shows its progress. If the hub runs in Docker and Docker Desktop is closed, the button reads **Start anyway** and the row says first that Docker will open its own window (you can switch that off in Docker Desktop's settings, General, "Open Docker Dashboard when Docker Desktop starts"). If a start did not work, the row says why in the hub's own words and keeps the button, so you can try again once you have done what it asks. Plenum never stops the hub. A hub that runs without Docker says "It runs on this computer, without Docker.", never says that Docker is closed or missing, and offers **Start**, not **Start anyway**. When the hub's helper runs, the row says whether it is set to start with Windows; Plenum does not change that. If you quit Plenum while it is still starting the hub, the hub's starter is left running and Plenum ends only its own other processes.
- **Bring Plenum Hub up when Plenum starts.** With this on, Plenum checks the hub about 20 seconds after it starts and brings it and its helper up when that needs no window: the hub is set up and either runs without Docker or Docker is already running. If the hub runs in Docker and Docker Desktop is still starting, as it usually is right after you sign in to Windows, Plenum looks again once a minute for ten minutes and brings the hub up as soon as Docker runs. It is on by itself while **Connect agents** is on (Settings > Agents > Plenum Hub) until you change it here. Nothing is started before you have accepted the License Agreement.
- **Start with Windows.** In the installed app on Windows, turn this on and Plenum starts in the tray when you sign in to Windows, with no window until you open it from the tray icon or start Plenum again. Keep **Keep in tray on close** on (Settings > General > Desktop) so that Plenum keeps running in the tray. The portable and zip builds do not offer this. Start with Windows has not yet been confirmed through a real sign-in to Windows.

For people who work on Plenum's source, `docs/EXTENDING.md` says how to add a route, a panel, a tool, a prompt part, a turn hook, a desktop handler or a notice without changing a file the rest depends on.

## Run without the app window

In a terminal, in this folder:

```bash
npm install
npm start
```

`npm start` runs `plenum.mjs`, which settles any applied update first and then starts the server. The terminal prints a link such as `http://127.0.0.1:4317/#token=...`. Open that link in a browser. The token in it is new for each start, and it is what lets the page talk to the server, so keep the link to yourself. It is the same app with the same state. Keys saved in the desktop app are not available here; see [Where keys are kept](#where-keys-are-kept). If the launcher gives the token in `PLENUM_TOKEN`, the terminal prints no link, because the launcher already has the token.

`node server.mjs` runs the same server with the shipped files and no applied updates.

## Setup wizard

The first time Plenum opens with no saved key and no CLI signed in, the setup wizard opens by itself. It has four steps: a welcome, the CLI sign-ins (Claude Code, Codex, Gemini CLI, Muse Code, Cursor, Grok Build and Antigravity), the API keys, and a summary. A row whose CLI is not installed shows how to install it, with a Copy button for each command; if the row still says Not installed after the install, restart Plenum. Each sign-in button opens that CLI's own sign-in window. While you finish the sign-in there, the row says "Waiting for sign-in"; Plenum checks every few seconds for three minutes and shows the sign-in by itself, and Check again reads it at once. The Claude Code, Codex, Gemini CLI, Muse Code, Cursor, Grok Build and Antigravity cards in Accounts do the same. A key is typed into a password box, sent once and cleared. The three requests behind the rows (keys, sign-ins, the CLIs added later) each draw their rows when their answer arrives, and Cursor, Grok Build and Antigravity say Checking until theirs does. The last step names the model that will answer ("Plenum will answer with <name>."); when the chosen model cannot answer yet, it says why and offers **Use <name>**, which changes the model only when you press it.

**Skip for now** closes the wizard, and it may open again on a later visit. Any other way of closing it by hand (Finish, Escape, the close button, or a click on the dimmed background) means it stays closed. Opening Settings (Ctrl+,) or Read the terms also closes it, without a choice, so it may open again. The **Setup** entry in the side menu, above Accounts, always reopens it. The wizard is in `public/ext-setup.js`.

## Legal

The first time Plenum opens, and again when its terms change, it shows the License Agreement and asks you to agree before it can reach any provider. You tick the box and press **I agree**; the terms are on the same screen (in a narrow window the card shrinks to fit, with a tall reading box and its two buttons on one row), and the version you accepted is recorded on this computer. **Settings › Legal** (or `/legal`) shows the agreement you accepted, the Privacy Notice, the third-party services notice, the open-source licences and the safety notices. Each safety notice appears once where its risk starts. It has **Don't show again**, and **Settings › Safety** can show it again. A notice never turns off a safety check: approval cards, blocked commands and folders, and plan mode work the same whatever you choose. Plenum sends no telemetry and has no server.

The Windows installer's own licence page covers only that installer. The portable exe, the zip, the macOS and Linux builds and `npm start` have no licence page, so the in-app step is the one every user passes. `LICENSE.txt` in the app folder is the licence of the source. The placeholders in the legal texts (`[LICENSOR NAME]`, `[CONTACT EMAIL]`, `[GOVERNING LAW]`, `[EFFECTIVE DATE]`) stay until the owner fills them in.

## Accounts

Open **Accounts** in the sidebar (or click any status item at the bottom of the window). A status item says **checking** while Plenum does not know yet, for example right after a start or while Claude Code has not answered its sign-in check; it says "sign-in needed" or "not installed" only when that is the real answer, and it asks again by itself until it has one. After about a minute without an answer the item says **no answer**; Plenum keeps asking, more slowly, and the item puts itself right when the answer comes.

- **Claude:** Claude runs through the Claude CLI (`claude`), signed in with your Claude account, so it uses your Claude plan rather than an API key. **Sign in to Claude Code** opens a terminal running `claude auth login`; finish in your browser, then press **Refresh**. Plenum looks for the Claude, Codex and Gemini CLIs on PATH first, then in its own tools folder. Install or update them with `npm install --prefix "<full path to your home folder>\.muse-console\tools" @anthropic-ai/claude-code @openai/codex @google/gemini-cli` on Windows, or `npm install --prefix "<full path to your home folder>/.muse-console/tools" @anthropic-ai/claude-code @openai/codex @google/gemini-cli` on macOS and Linux. Write the full folder, not %USERPROFILE% or $HOME. The Accounts card shows the exact command for this computer, using MUSE_CONSOLE_HOME when it is set. You sign in once. The CLI keeps the sign-in, not Plenum. If the CLI is not installed, the card asks for an Anthropic API key instead and Claude uses the API.
- **Muse Code:** **Sign in to Muse Code** opens a terminal running `muse login`. Approve the code in your browser, then press **Refresh**. `META_API_KEY`, if set on the computer, is passed to Muse Code. Muse Code is installed with its own installer; Plenum gives no install command for it.
- **Codex:** **Sign in to Codex** opens a terminal running `codex login`.
- **Gemini:** **Sign in to Gemini CLI** opens the Gemini CLI's own sign-in, which uses a Google account. The card says which one Gemini is using: a saved Google sign-in, or a saved Google AI key (**Using your key**: billed per token, no Google sign-in needed). Gemini CLI does not serve Google AI Pro, Ultra or free plans any more; the card says so and points to the Antigravity card (naming your plan once that card has reported it) or to a saved Google AI key.
- **Grok Build:** **Sign in to Grok Build** opens a terminal running `grok login` (SuperGrok or X Premium Plus). Install it with `irm https://x.ai/cli/install.ps1 | iex` (Windows PowerShell) or `curl -fsSL https://x.ai/cli/install.sh | bash` (macOS, Linux). In Ask first, Grok Build asks Plenum before it edits or runs a command, and it joins every multi-model role. Plenum cannot see whether it is signed in until it runs.
- **Antigravity:** for a Google AI Pro, Ultra or Plus plan. Install it with `irm https://antigravity.google/cli/install.ps1 | iex` (Windows PowerShell) or `curl -fsSL https://antigravity.google/cli/install.sh | bash` (macOS, Linux), in your own terminal, then restart Plenum. **Sign in to Antigravity** opens a terminal running `agy acp --login`; finish in your browser, then press **Refresh**. The card shows your plan. Plenum reads the account's model list from Antigravity without sending a prompt, at most every 30 minutes, and lists each model as `antigravity:<model>`, for example **Gemini 4 Hydrogen High (Antigravity)**; `antigravity:default` keeps Antigravity's own choice. In Ask first, Antigravity asks Plenum before it edits or runs a command, and it joins every multi-model role, read-only in an empty folder like Grok Build. No Google key reaches it, so its runs stay on your plan. Gemini 4 Hydrogen is also on the Google AI key as `googleai:gemini-4-hydrogen` (short name `hydrogen`), billed per token.

The buttons read "Sign in to" followed by the product's name, never "Sign in with", so no button copies a provider's own sign-in label. Product names appear in plain text only, with no logos.

A card for a CLI that is not installed shows the install steps with a Copy button for each command. After you press a sign-in button, the card says "Waiting for sign-in" and shows the sign-in by itself when it has finished (Plenum checks every few seconds for three minutes); **Refresh** reads it at once.

A CLI you install while Plenum is open is found when you press **Refresh**; you do not have to restart Plenum first (Antigravity's card still says to restart). (Windows, in the desktop app: Plenum reads the PATH again from the registry when a CLI is not found. If a CLI still shows Not installed after Refresh, restart Plenum.)

Plenum asks each CLI whether it is signed in when you open Accounts or the setup guide, and waits about 3 seconds for the answer. A CLI that is slower keeps the answer Plenum last had, and the new one shows on the next Refresh. If Claude Code or Codex does not answer at all, its card says **Sign-in unknown** and that Plenum could not check it just now, and it is not shown as signed out. Press **Refresh** to check again. Accounts draws the cards of Claude Code, Codex, Gemini CLI and Muse Code when the first answer arrives; the Cursor, Grok Build and Antigravity cards say Checking… until theirs does, so a slow CLI holds up only its own cards.

### Sign-ins repair themselves

Plenum no longer waits for you to press Retry after most sign-in trouble.

- **Before a turn.** A chat turn, like a council, first asks the program whether it is signed in. If the program itself says nobody is signed in, Plenum opens that program's sign-in window for you and waits (up to five minutes), then sends the turn. If the program gives no answer, the turn runs anyway: no answer is never taken for "signed out". The check can add up to 5 seconds when the last answer is old.
- **After a failure that passes.** A turn that failed before it wrote anything, because the connection dropped, the service was busy, the program stopped, or another Claude Code process was renewing the sign-in at that moment, is sent again by itself after a short wait (2, 5, 10 or 20 seconds by cause, and once more after 60 seconds for a renewal collision), up to five tries in all. The chat says so while it waits. This covers chat turns, council seats, team tasks, Quick compare columns, pipeline steps and relay hops. Never sent again this way: a usage limit, a model that is not offered, a refused option, an unknown error, a turn that wrote text or started a tool, an agent or a file change, a turn you stopped, and a model on an API key (its own request code already tries again).
- **One start at a time per program.** Two processes of the same signed-in program start at least 2 seconds apart wherever they come from (a council, a routine, a chat, a team task). Runs one after another are not slowed.
- **Signed in again.** When a program is seen signed in again, a "still signed out" notice is taken down and routines that were waiting for it run. Muse Code, Gemini CLI and Grok Build have no sign-in check of their own; for them a turn that answered, or sign-in files that appear, is the sign.
- **Routines.** A routine that could not run because of a sign-in waits and runs when you sign in, or looks again every 2 minutes, for its catch-up window (Settings on the routine: "Run late up to N hours", default 6; "Try again after N minutes", default 30). A failure that passes does not count toward the day's runs or the three-failures rule.
- **You are told once.** "<Program> needs you to sign in" when a window is opened (at most once per program in 6 hours), "signed in again" when it is done, and "still signed out" when a wait ended without one. Notices follow Settings > General > Notifications (see Notifications below).

What Plenum never does: sign in for you, change a model, or send a turn again after it has written something.

Keys are never written to the state file. Where they are kept is described in [Where keys are kept](#where-keys-are-kept).

## Where keys are kept

These are the keys for the per-token providers (xAI, OpenAI, DeepSeek, Mistral, Google AI and OpenRouter) and the Anthropic API key. Where a key lives depends on how Plenum was started (`lib/keys.mjs`):

- **Desktop app.** Saving a key encrypts it with the operating system through Electron safeStorage (`desktop/keyvault.cjs`): Windows data protection on Windows, the Keychain on macOS, and the secret service (GNOME Keyring or KDE Wallet) on Linux. The encrypted file is written to one file in the app's user-data folder. The server gets the keys from the desktop app and holds them in memory only, while Plenum runs. The desktop app does not read these keys from environment variables. Keys are never logged and never sent back to the browser.
- **Linux without a secret service.** If safeStorage can only use its `basic_text` backend, Plenum keeps keys for this session only, and they are forgotten when Plenum closes. A notice says so. That backend protects keys with a password built into Chromium, so it gives no real protection. Install and unlock GNOME Keyring or KDE Wallet to keep keys between sessions.
- **Plain Node** (`npm start` or `node server.mjs`). There is no desktop app, so keys come only from environment variables: `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `GOOGLE_AI_API_KEY` and `OPENROUTER_API_KEY`. They cannot be saved from the window. In any mode, `ANTHROPIC_AUTH_TOKEN` is read as a fallback for Claude.

On Windows, older versions saved keys to the Windows user environment. Accounts can copy those keys into the store, but only when you choose to. The copies in the environment are left in place. Remove them in Windows settings (environment variables for your account) if you no longer want them there.

To remove a saved key, open **Accounts** and choose **Remove key** on its card, then confirm. The per-token providers have their card under **Model providers (per token)**. The Anthropic key is removed from the **Claude** card under **Anthropic API key**, which appears when Claude runs through the Anthropic API key route. In the desktop app the key is deleted from the encrypted file at once and Plenum stops using it. In a plain Node run the key comes from an environment variable, which Plenum cannot change: clear the variable and restart Plenum.

## Edits and approvals

The **Mode** menu under the message box sets the approval mode for the active project. Its button shows what sending will allow, in the mode's colour: Plan, Ask first, Auto-approve or Approve all, with "· Focus" added when build focus is on. The menu also holds the **Plan** and **Build focus** checkboxes and **Safety settings…**. The app-wide default is in **Settings › Safety**; each project keeps its own unless you choose **Use app default**.

- **Ask first** (default): every edit and command waits for you. The exception is a Codex or Gemini coder started as an agent, which cannot ask: in Ask first it writes without a card and the run lists what changed, unless the project is set to refuse such coders. Each write, edit and command shows an Approve / Deny card with the exact change or command. Changes to existing files show a diff. Reads inside the project never ask.
- **Auto-approve**: edits and commands run without asking; guards still ask. A command that a built-in rule or a project pattern blocks, and a write outside the project folder, still show a card. Auto-approve has no card for ordinary edits and commands. `/approvals ask` switches back.
- **Approve all**: every approval card is answered for you, in the project and outside it, including the cards that Gemini and Muse Code show for themselves. Gemini runs in its yolo mode and Muse Code with its own approval prompts off, so both can run commands headlessly. Codex and Claude Code get no new flags: Codex already runs in its project-folder sandbox without asking, and Plenum keeps answering Claude Code's permission prompts itself. Approve all also answers the computer-use and browser cards, so sending, buying, deleting, signing in and new apps or sites go ahead without asking. Two project switches in **Project settings** turn that off: **Approve all also answers computer-use cards** and **Approve all also answers browser cards**.
- **Permissions.** The title bar shows "Permissions: Ask first", "Fewer questions", "Hands-off" or "Custom" for the project on screen. Click it (or use Settings › Safety, or "Permissions…" in the Mode menu) to open a sheet with the three presets. Each card says in plain words what it changes, lists the exact settings, and shows what it will change from what is in force now. Pick where it applies: this project, every project, or the default for new projects. Ask first is how Plenum starts, and going back to it is one click. Fewer questions is Auto-approve: edits and commands run without a card, with your user rights, so a command can change files outside the project; file writes outside the project, blocked commands and computer-use and browser cards still ask. Hands-off is Approve all with the computer-use and browser covers on; Plenum's own tools still show the Deny-first card for blocked commands, but Gemini, Muse Code, Grok Build and Cursor's print transport run with their own prompts off in this mode, so Plenum cannot see or stop what they run. Turning on Hands-off asks the Approve all question first, unless you ticked Don't show again. A preset only sets switches that already exist; credential folders, Plenum's own files, the password guard, the visible indicators and Stop are not part of any preset.

Credential folders, system folders, Plenum's own source and Plenum's own data stay off limits in every mode. The shell-command check that enforces this reads wildcards and recursive searches too (see [Files outside the project](#files-outside-the-project)). In every mode the model never types into a password, one-time-code, 2FA or CVV field; you type those yourself. Stop, and Ctrl+Alt+Esc, end a computer or browser run at once.

A built-in deny list checks every shell command, in every mode. A command it matches shows a card that says it was blocked, with **Deny** as the default button; Approve runs it anyway. The built-in rules cover a recursive delete of a drive root, home folder or project root, `format`, `diskpart`, `reg delete`, `schtasks /create`, `bcdedit`, `shutdown`, `cipher /w`, a download piped into a shell, `git push --force`, and a write to a system folder. In Approve all these cards look the same, unless the project turns on **Approve all also answers blocked-command cards** (off by default). With that switch on, Approve all runs the commands that the rules block, including the ones that can wipe a drive or the system, and nothing stops them but you. A project can add its own patterns in **Project settings** (up to 50, each up to 120 characters); a command that matches one is checked the same way.

Turning Approve all on asks you to confirm. The confirmation has a **Don't show again** box like every other notice; with it ticked, turning Approve all on takes one click, and the red button, the line above the message box and a line in the chat remind you that it is on. It is saved like the other modes and survives a restart. When Approve all answers a card for you, the chat shows a line saying so instead of the card.

Denied actions, and actions left unanswered for five minutes, are reported back to Claude, which is told not to retry them.

On a card:

- **Deny with a reason.** Type in the box under the buttons before you press Deny. The reason (up to 300 characters) goes to the model with the denial and shows on the step in the chat. Approve ignores the box. A denied step is labelled Denied (not Failed); the reason shows when you rest the pointer on its row and in the opened step. A step ended by Stop reads Stopped and carries no reason.
- **Keys.** Click the card, then **Y** approves and **N** denies. A new card takes focus only when you are not typing somewhere else and no drawer is open, and keys pressed in its first 400 ms are ignored, so a stray keystroke cannot answer it. Y does nothing on a blocked-command card or a checkpoint restore card; click those.
- **Countdown.** The card shows how long is left of its five minutes. When time runs out, the action is denied and the card says so.
- **Show all.** A long diff (an edit or a whole-file write) is cut on the card. **Show all** loads the whole change (up to 2,000,000 characters) before you decide. The full text is held only while the card waits.

## Files outside the project

Claude can work with any file on your computer. Give it a path in your message (for example `C:\Users\name\Documents\notes.txt` on Windows, or `/Users/name/Documents/notes.txt` on macOS), or type `@` followed by the path to attach a file's contents straight away. A write to a path outside the project folder shows an approval card first. In auto-approve mode that card still shows; in Approve all it is answered for you. Credential and system folders are refused in every mode.

Some places are never touched:

- the credential folders in your home folder: `~/.codex`, `~/.config/muse`, `~/.claude`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.gemini`, `~/.config/gcloud` (on Windows `%APPDATA%\gcloud`), `~/.kube`, `~/.docker/config.json`, `~/.netrc`, the folder where Plenum Hub's starter keeps its agent keys (`~/.tabletalk-hub`), and Plenum's own data folder, `~/.muse-console`. The desktop app's own data folder is also kept off limits: `%APPDATA%\Plenum` on Windows, `~/Library/Application Support/Plenum` on macOS, and `~/.config/Plenum` on Linux. On Windows the home folder ones are the same folders under `%USERPROFILE%`;
- the operating system's folders, for writes: `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)` and `C:\ProgramData` on Windows, and `/etc`, `/usr`, `/System` and similar folders on macOS and Linux;
- Plenum's own source (use the Updates panel for that).

The shell-command check that keeps these folders off limits reads wildcards (`.s*`, `~\*`) and separate words after the home folder in the Join-Path style, and refuses a recursive search that starts at the home folder or above (`Get-ChildItem -Recurse ~`, `dir /s %USERPROFILE%\x`, `find /`, `grep -r x ~`). A search inside a folder in the home folder is fine. The check covers Plenum's own `run_command`, the Claude CLI, Cursor and Grok, not commands that Codex, Gemini and Muse Code run in their own shells (see [Known limits](#known-limits)).

A network spelling of a folder on this PC (for example `\\localhost\C$\...`) is treated as the folder it is; other network paths work unless they lead to a guarded folder or cannot be checked. The command check also reads a PowerShell `-EncodedCommand` and a script the command runs (it refuses a script that names a sign-in folder and reaches for the home folder), and it is a safety net, not a wall: a script built at run time still gets past it. The text search tool does not look inside sign-in folders, stops after 20,000 files or 10 seconds, and stops a regular expression that takes more than 5 seconds. Edits keep a file's Windows line endings, and a file that is not UTF-8 text is not edited. A long command keeps the end of its output.

Muse Code and Codex work inside the project folder they are given. To work on a file elsewhere with them, add its folder as a project.

## Updates to Plenum

Claude can propose a change to Plenum itself with the `propose_update` tool. The change is queued in the **Updates** panel, which shows each file's status and its new contents. It shows each new file in full, so the review sees what Apply runs. Nothing changes on disk until you click **Apply and restart**. Applying:

1. Runs a syntax check on every JavaScript file in the bundle, and checks that each relative import in a changed file exists, either in the bundle or in the version it replaces.
2. Writes the whole new version as a **generation** under Plenum's state folder, in `overlay/gen-<n>/` (`~/.muse-console/overlay/` on macOS and Linux, `%USERPROFILE%\.muse-console\overlay\` on Windows). A generation holds every file of the version it replaces that the bundle does not change, so it is complete on its own. The install folder is never written.
3. Switches to the new generation with one change to `overlay/manifest.json`, and restarts the server (in the desktop app; under `npm start` the server stops after the update, and you start it again with `npm start` and open the new link it prints).

The Updates panel lists the generations. **Roll back** goes back to the generation before the active one. **Remove all applied updates** deletes every applied generation and restarts with the shipped files. Plenum keeps the last three generations. If a new generation does not start and become healthy, the next start goes back to the generation before it, and the page shows a notice that says so. If the applied updates cannot be read at all, nothing is rolled back: the shipped files run and the notice says so. A failure before the switch removes the half-made generation and changes nothing. A file name can be at most 200 characters. If the record of applied updates cannot be read, Apply is refused until you choose **Remove all applied updates**; the panel shows that button in that case.

What can be updated: `server.mjs`, the `.mjs` files in `lib/`, `lib/routes/`, `lib/tools/` and `lib/prompt-parts/`, and the `.html`, `.js` and `.css` files in `public/`. What never can be updated from the app: the update loader (`plenum.mjs`, `lib/overlay.mjs` and `lib/overlay/`), the request token check (`lib/auth.mjs`), the desktop app (`desktop/`), and `package.json`, `README.md` and `start.bat`, which belong to the install. A new release changes those. **Discard** drops a bundle without applying it. Applying is refused while a run is in progress. A new `public/ext-*.js` file is listed as "new panel: loads on every page", because Plenum loads every panel file it finds.

Applied changes are tied to the Plenum version they were applied under. After Plenum updates to a new version, they are set aside so the shipped files run, and the Updates panel says so (see [New versions](#new-versions)).

## New versions

The desktop app checks for a new version 20 seconds after it starts and every four hours after that, unless **Check for new versions** is off in **Settings › Updates**. The check asks the Plenum release repository on GitHub (`https://github.com/literallyisyou/Plenum`) for the newest published release. It carries your Plenum version, operating system and architecture, your IP address, and a random rollout ID that Plenum keeps in its user-data folder. Apart from the download of an update itself, nothing else leaves your computer for this, and nothing about you goes to Plenum's developer: GitHub shows the developer only how many times each file was downloaded.

What happens when a new version is found depends on the build:

| Build | What happens |
|---|---|
| Windows installer (`Plenum Setup x.y.z.exe`) | Downloads the new version in the background. **Restart to update** installs it, or it installs when you quit Plenum. |
| Windows portable `.exe` and zip | Shows "Plenum x.y.z is available" and **Get x.y.z**, which opens the release page. Replace the file or folder yourself. |
| macOS dmg and zip | Installs itself only when the build is signed. Until then it shows the notice and **Get x.y.z**. |
| Linux AppImage | Downloads in the background. **Restart to update** replaces the AppImage file, or it is replaced when you quit Plenum. |
| Linux deb | Shows the notice and **Get x.y.z**. |

**Restart to update** never restarts while a run is in progress or an approval card is waiting. Plenum says why, and you restart when the run has ended. If the message box holds text you have not sent, Plenum asks once before it restarts. The new version's release notes are in **Settings › Updates** before you restart, and after the update under **What changed in x.y.z**.

**Channels.** Stable (the default) gets numbered releases. Beta also gets pre-release versions (`x.y.z-beta.n`) as soon as they are published. Switching from Beta back to Stable keeps the beta you have until a newer stable release ships.

**If a new version does not start.** The first start after an update is watched. If Plenum does not come up, it shows "Plenum x.y.z did not start" with the log path. On Windows, when the previous installer is still in Plenum's user-data folder (`%APPDATA%\Plenum\updates`), the dialog offers **Reinstall x.y.z** for the version before; otherwise it offers **Get x.y.z**, which opens that release's page. Plenum then does not offer that version again; the next newer version is offered as usual. Changes applied from the Updates panel are made for one version: after Plenum updates, they are set aside so the shipped files run, and the Updates panel says so.

**Turning it off.** Switch off **Check for new versions**. Plenum then makes no update request at all and installs nothing by itself. That includes the install at quit, even of an update it had already downloaded. New versions are listed on the release repository.

**Until the builds are signed**, a Windows update is checked against the sha512 in the release feed but not against a publisher certificate, so the release repository's GitHub account is what you trust.

### Publishing a release

1. Raise `version` in `package.json` and push a tag: `git tag -a v0.6.0 -m "What changed" && git push origin v0.6.0`. Betas use a tag such as `v0.6.0-beta.1`. The tag message seeds the notes. Before you tag, run `node scripts/build-mobile.mjs` and commit `relay/public` in the same commit as the change; `node scripts/build-mobile.mjs --check` must pass. The tagged commit must have no untracked or changed files (the release workflow's prepare step checks that), and the phone tests (`phone-tests.yml`) must pass before the draft is created. Android `versionCode` comes from the tag. iOS needs the repository variable `APPLE_TEAM_ID`.
2. The workflow creates a draft release on the release repository, builds every platform and attaches the installers, the `latest*.yml` and `beta*.yml` files and the blockmaps.
3. Review the draft, write the notes, and publish it. The notes are what the app shows under **What changed in x.y.z**, as plain text: short lines or a bullet list read best, and links and images are dropped. A draft is invisible to the app.
4. Stage the rollout: `node scripts/stage-release.mjs v0.6.0 10`, then `50` or `100` to widen it.
5. To pull a bad release, publish a higher version. Publishing the same version number again leaves the people who took it on it.
6. Keep `electron-updater` current, because it verifies the downloads.

## API model providers

Grok (xAI), OpenAI, DeepSeek, Mistral and Google AI are billed per token, separately from your subscriptions. OpenRouter is too. Its model ids are free text: type `openrouter:<id>` with any id OpenRouter lists, or pick one from the OpenRouter card in Accounts, which keeps the list for ten minutes (`lib/openrouter.mjs`).

Open **Accounts**, find **Model providers (per token)**, and paste the key for a provider. Plenum checks the key with that provider and saves it to the encrypted key store (see [Where keys are kept](#where-keys-are-kept)). A key the provider rejects is never saved, and neither is a key with a stray character from a document, such as a curly quote or an invisible space. When the check could not run (no internet, a busy provider, a limit, an account with no credit yet, a network sign-in page, or a key that may not list models), the key stays in the box and **Save anyway** keeps it; its card then says "not checked yet" until **Test saved key** passes. If you replace the saved key while a test is still running, that test says the key was changed while it was being checked, and you press **Test saved key** again. This applies to the per-token providers; the Anthropic key on the Claude card is still saved only when its check passes. In the desktop app the saved key is used. A plain Node run uses the provider's environment variable instead (for example `XAI_API_KEY`). The panel never shows a saved key. Their models appear in the model menus under their own names.

**When a provider is busy.** If xAI, OpenAI, DeepSeek, Mistral, Google AI or OpenRouter answers with a rate limit, says it is overloaded, or the connection drops before the reply starts, Plenum waits a moment and asks again, up to 4 requests for one reply, and a line in the chat says so. It waits as long as the provider asks, up to a minute; **Stop** ends the wait at once. Once any of the reply has arrived Plenum does not ask again, so nothing is repeated and no tool runs twice: the text so far is kept and the message says to send again. A failure that does not pass says what happened and what to do: save a valid key, add credit (with the provider's billing page), wait, pick another model, or shorten the chat with `/compact`. A retried request is counted once in the spend total. The Claude API route says its failures in the same words.

### Tools for API models

OpenAI, DeepSeek, Mistral and Google AI can use the project tools. Grok by API key answers in text only until you press **Check tool calls** on the xAI card in **Accounts**. That sends one tiny request with your key, which xAI bills like any other request; if xAI completes the tool call, Grok gets the project tools (and the browser tools, when the pane's switch is on) like OpenAI. OpenRouter models answer in text only until a model passes Plenum's tool test: open **Accounts**, find **Tools for API models**, and press **Test tools** next to the model. The test runs Plenum's own file tools (list, read, write and edit, nothing else) in a temporary folder that is deleted afterwards, never your project. It checks an exact edit, an exact new file, and that a path in a credential folder is refused and not tried again. It sends about 15,000 tokens through that model's key; this is not counted in any project's spend. A model that passes shows **Passed on <date>**. Turn on **Allow tools** to give it the project tools; Ask first, the deny list, plan mode and the off-limits folders apply as for any model, and it can then be picked as a /build coder. The result belongs to that exact model id: if the provider later answers under a different model name, tools turn off for it and the row says **Out of date** until it is tested again. Results are kept in the state file with their date; no key or file content is kept.

## API finder

**API finder** (Settings › API finder, or the link in Accounts) compares what model routers and providers charge for the same model. Each model shows its lowest price per million input and output tokens, its context window, whether it takes tools or images, and which source is cheapest for a typical chat (three input tokens for each output token, before fees). Expand a model to see every source side by side, with its fee note and a link to its page; for an OpenRouter model you can also see the providers OpenRouter routes to. Search and filter by name, provider, price, context, tools, vision, or "Works in Plenum". **Use in Plenum** sets an OpenRouter model as the model of the thread on screen (Main: your model) (`openrouter:<id>`, text only, without project tools), **Try once with /ask** sends just the next message to it, and a model Plenum supports directly offers **Use … direct**, or **Open Accounts** to add its key. Prices come from four public lists read without a key (OpenRouter, Vercel AI Gateway, DeepInfra and Martian), read only while the finder is open and each kept for ten minutes; **Refresh** reads them again at most once a minute. Direct prices come from `lib/pricing.mjs` (checked 2026-10-14) and are marked as table prices wherever they appear. The **Routers** tab lists every router with its fees, base URL and links; routers without a public price list come from a table checked by hand on 2026-10-20 (`lib/router-directory.mjs`), so check their pages before relying on it. Links open in your browser. A model that two routers name differently appears as two rows.

The API finder earns Plenum no commission, and it stores no prices on disk.

## Council, quick compare and pipelines

- **Council** (`/council <question>`, or the council board above the message box). Two to four seats each take a role, such as Architect, Skeptic or Engineer, and answer. Seats critique each other over one to three rounds (two by default), then a moderator writes the verdict. If the moderator leaves a section out, the card shows the rest and names the section it left out. **Add seat** on the board adds a seat (up to four), and the × on a seat removes it (down to two); a new seat takes a role and a CLI the council does not have yet, Gemini CLI first. Each seat's model, role and effort can be changed on the board. A question can carry files, as a chat message can (see [Attachments](#attachments)); every seat and the moderator read them. The **Folder** menu on the board sets where the seats work. **Text only**: they answer from the question alone. **Read the folder** (the default): every seat and the moderator open and search the project's files and change nothing. **Work in the folder**: round 1 reads; in each later round the seats take turns, one at a time in seat order, changing files and running commands under the project's approval mode (in Ask first their cards show on the council card), each told what the seats before it changed, and the moderator then checks the changed files. Work in the folder needs two or three rounds, the writer thread, and plan mode off; in plan mode a council set to read the folder answers text-only and says so. A seat whose model has no tools in Plenum answers from the prompt and, in a work round, reviews what the seats before it report. A council saved before the Folder menu existed stays text-only until you change it. The default council is `DEFAULT_COUNCIL` in `lib/council.mjs`: Claude Opus 5.5 as Architect, Muse Code (Wonder 1.0) as Skeptic, Codex as Engineer and Gemini CLI as Generalist, all at high effort, with Claude Fable 5.2 as moderator at high effort, two rounds, reading the folder. Every seat is told who the other seats are and what each role covers, which round it is and who reads its reply, so a seat goes deep on its own role and leaves the others theirs; the moderator knows that a seat's silence outside its role is not agreement. If only one seat answers the first round, the council skips the critique rounds and the moderator gives a verdict on that one answer; the card says so. If no seat answers, it stops and names each seat's cause. A seat or moderator that writes nothing for 10 minutes is stopped and the others go on. Stop still stops everything and keeps the answers already given. A seat that failed has **Retry**, **Run this seat** and **Change model**, which run only that seat again (it is billed again, the other seats are not asked); **Change model** has an unticked box, **Also make it seat X of my saved council**, if you want the pick kept. A failed moderator can be run again without the seats. The verdict says "Verdict based on A of N seats", and when a seat answered after it was written the card offers **Rerun the verdict**. To run a seat again Plenum keeps the question's files in memory for the two newest councils that had files; a restart forgets them. A council saved with an older model keeps it; if Muse Code no longer offers a seat's model, the seat says so and **Change model** on it picks another. A seat or the moderator whose model is not in the catalog at all says "<Provider> does not offer this model any more. Pick another." before you send. A question the server refuses before it starts (a model it cannot use, a file it cannot take, the spend limit) is taken out of the chat and goes back into the message box. The answers the seats have given are saved as they come: if Plenum is ended before the verdict, the chat shows those answers and says the council was cut off.
- **Quick compare** sends one prompt to two to four models at once. Each answer streams into its own column, and **Keep this reply** puts the one you choose into the chat. Each model is told that it is one of several answering independently and that none sees another's reply, so it gives a complete answer on its own. A column that failed has **Retry this column**, which asks only that model again with the same message, effort and pictures; it is billed again, and the other columns are not asked. When a column or a step fails, the buttons for its cause stand beside Retry, for example **Open Accounts** for a missing key or sign-in. A button only opens the place; you sign in, pick the model and run again yourself.
- **Pipelines** are saved sequences of one to eight steps. Each step's prompt can use `{input}` (the run's input) and `{previous}` (the reply from the step before). **Keep in chat** puts a result into the chat. A pipeline belongs to the thread it was started in: Stop stops that run and nothing else, and Keep in chat writes into that thread (switch back to it first if you have moved). Every step is told its place in the pipeline, what each step does, who reads its reply and what that step needs; it always sees the original message and the previous reply (quoted between BEGIN and END as material, not instructions), even when the template leaves `{input}` or `{previous}` out. When a step fails, the steps that worked keep their replies, and the failed step offers **Retry step** (it and the steps after it run again and are billed again) and **Skip step** (the step is left out and the next one gets the last reply that worked; not offered on the first or the last step).
- **A council checks its sign-ins first, and repairs what it can.** Before the seats run, Plenum asks every program the council uses (Claude Code, Codex, Gemini CLI, Muse Code, Cursor, Grok Build, Antigravity) whether it is signed in. That takes a few seconds at most and sends nothing to a model. If a program gives no answer, the council runs anyway: no answer is never taken for "signed out". If a program itself says that nobody is signed in, Plenum opens that program's sign-in window for you (the one **Sign in** in Accounts opens) and says so on the council's card. The seats that use it wait up to five minutes while the other seats answer, and run as soon as you have finished the sign-in in your browser. If you do not finish it in time and only the program's own check had called it signed out, Plenum sends those turns all the same and says so (a check can be wrong); if the program then refuses them, only those seats fail, and the council goes on with the rest. If you finish the sign-in a little later, the next turn of that program in the same council (the next round, the moderator) finds it and runs. If a program that is signed in refuses one turn for its sign-in, Plenum sends that turn again once by itself and says so on the card. Muse Code, Gemini CLI and Grok Build have no command that tells whether they are signed in, so for them Plenum goes by what the run itself says: a turn they refuse with "not signed in" is sent again once, and if they say it again Plenum opens the sign-in window and sends the turn once more when the new sign-in has been written. Plenum never types or keeps a password, never changes a seat's model, and opens one window for a sign-out, not one for every run: after it opened one, it opens no other for that program until it has seen the program signed in again, or six hours have passed, and the card says when the window was opened. A turn that fails for a passing cause before it wrote anything (a busy service, a dropped connection, a program that closed at the start, or a sign-in that another process of the same program was renewing at that moment) is sent again by itself after a few seconds, and the card says so; seats that use the same program start two seconds apart in the first round, so that they do not renew one sign-in at the same moment. A chat message, a relay, a compare and a pipeline are not checked this way yet: a failed reply there has **Retry** and **Sign in**.

Council seats and the moderator, relay hops, quick-compare seats and pipeline steps can use Claude, Muse Code, Codex, Gemini or an API model. Each CLI seat runs in its read-only setting in these roles (Codex in its read-only sandbox, Gemini in plan mode, Muse Code in an empty scratch folder, Claude with no tools), and no seat, hop or step is given the project's tools, unless you allow it in Agents > Limits: a seat, the moderator, a hop, a column or a step can then start read-only agents (Researcher, for example) that read the project and report back, within the numbers you set; the seat itself stays text-only, and Codex, Gemini and Muse Code seats cannot start agents. A council set to read or work in the folder is the exception: each seat and the moderator runs as an agent of the project in the project folder, with every gate an agent has (the credential guard, the deny list, the cards, Stop and the spend limit), Codex in its read-only sandbox, Gemini in plan mode and Muse Code with writes off while they read, and Cursor, Grok Build and Antigravity in an empty folder, as their read-only agents run. Such a seat also gets the project's AGENTS.md and your global rules.

## Relay

A relay passes a finished reply from one seat to another. Start one with **Relay…** on the council board, or with `/relay`. Auto relay is off by default. When it is on, each hop waits for a countdown (3 seconds by default). A route stops at its hop limit (no limit by default), at the first error (by default), or when you press **Stop** on the relay bar. **Pause** and **Stop** control a running route, and **Relay log** lists the last hops. Each hop is told that it is one of several models working for one person, the order of the relay and its own place in it, who reads its reply next, and the person's original request; it builds on the reply it receives, names any claim it rejects, and starts with one line saying what it kept, changed or added. A hop that fails or is stopped is kept in the chat with its reason or "Stopped.", and its text is not passed on to the next hop.

### Your team

Open **Settings > Agents > Team**. For each kind of work (Find, Research, Code, Test, Write, Data and Review) you keep your own ordered list of models across your subscriptions. When a lead model hands work over and names the kind, Plenum gives the task to the first model in your list that can run now: its program installed, signed in, offered by its CLI, and under your plan line. If a model is at its limit or signed out, the next one in your list is used and the chat shows the reason. Plenum never uses a model that is not in your list. The team is off until you turn it on; while it is off, delegated work uses one model for everything, as before, and Plenum tells you once that a team exists.

- **Turn it on.** Press **Use this team** to take the suggested team (built from the subscriptions you are signed in to; with none, there is nothing to suggest and nothing is saved), or arrange your own and turn on **Use the team for delegated work**. A team you arranged is replaced only after a question.
- **Each model shows what it can do now.** A dot and a word: Ready, Needs sign-in, Needs an API key, At its plan limit, Not offered, Not installed, Not checked yet, or Off (a model billed per token while that switch is off). The plan-limit banner shows when a reply fails on a limit while you watch. Opening a project whose old reply ended that way shows the failed reply and no banner.
- **Change the order** with the arrows and take a model out with **Remove**. To put one in, choose it in **Add a model** and press **Add**; choosing in the menu adds nothing by itself. Each change is saved at once, and the line beside it says **Saved** or why it was refused. Everything works by keyboard.
- **A kind with no model.** The team does not choose for it. With the team on, the section says so under the switch and under the kind, and a task of that kind runs on the model of its agent type, as it does with the team off. Add a model to give that kind's tasks to the team.
- **Plan use** is read when work is handed over and when it ends. A reading older than 30 minutes no longer counts, so a model that was near its limit last night is tried again today. The team passes over a subscription once it reaches the line shown in **Delegated work, last 7 days**, which lists what each subscription did (tasks, minutes, tokens) beside how much of its plan is used.
- **Other models you can add** lists the models that are in no kind, with each one's size. Luna, Terra and other account models appear when your CLI lists them (Accounts, then Refresh). A size "guessed from the name" is a starting point: set it yourself with the menu beside the model. Models are tried in the order of your list, not by size.
- **Models billed per token** do no delegated work until you turn on **Models billed per token may do delegated work**. The spend limit of the project applies to them.
- **A local log.** Each finished task is written to `team-log.jsonl` in Plenum's data folder (which model, how long, tokens where reported). It never holds the instructions or the answer. Your list is in `team.json` in the same folder.

**Handing work over by kind.** A lead model can name the kind of work (find, research, code, test, write, data or review) instead of picking an agent type. It can also say how to tell the task is finished, and give the tasks of one piece of work a shared job name, so a later task gets what the earlier ones found as short notes (kept in memory only, never written into your project). A lead can send up to 8 tasks in one call. They run at the same time, Stop ends all of them, and the chat shows one row for the call with the count at its end, for example "3 tasks: 2 done, 1 not finished · Claude 2, Codex 1".

**When your team is on.** The chat shows a small row with the model and why it was chosen ("Claude Haiku 5.5: first in your team for Find."), and the task's row ends with the model that did the work and what it used. If the model is at its plan limit, needs sign-in, is not offered on your account or is not installed, the task goes to the next model in your list, at most twice, and a row says so. A task that already changed a file is never started again on another model; the lead is told instead. A model that you or the lead named is never swapped for another one.

**Short both ways.** The worker gets a short brief and is asked to keep its reply short. A long reply is cut for the lead, with a line that says how much was cut.

### Handing work to a program or a hub agent

A lead can hand a task to a **program** instead of a model: Claude Code, Codex, Muse Code, Gemini CLI, Antigravity, Cursor or Grok
Build on this PC, or an agent you added by its name on **Plenum Hub**. The task then runs inside that program, with that program's own
abilities, and its result comes back to the lead as a hand-off result. Open **Settings > Agents > Programs**.

- **Each program has one line, "Best at"**, that you can edit. The lead reads these lines and picks by them; you can also name the
  program yourself in your message. Plenum never switches silently to another program: if the one named is not installed, needs
  sign-in, is switched off or is at its plan limit, the lead is told so with the programs that can run now, in your order.
- **Each row shows what is true now**: Ready, At its plan limit, Needs sign-in, Not installed, Switched off, Not checked yet. Change
  the order with the arrows; the switch takes a program out; **Model** is Automatic or one you choose.
- **A program never gets more rights than the chat that asked**: the same folders and the same approval mode. Programs that ask before
  each step (Claude Code, Antigravity, Cursor, Grok Build) send each step to Plenum first. Codex, Gemini CLI and Muse Code cannot
  ask before they act, so in a folder on **Ask first** a hand-off to one of them starts only after your yes on a card at the top of
  **Businesses > Today**. The card shows the program, the model, the folder, the scope, the agent type, who asked and the whole task
  text, and your yes is tied to that text. With no answer in five minutes, a no, Stop, or a text over 60,000 characters, it is not
  started, and the lead is told so in words. Codex in Ask first also starts without your own Codex settings file, so the MCP servers
  set there are not loaded. In **Auto-approve** and **Approve all** a hand-off starts at once, and an editing task may use the
  program's connected services. A business that does not allow models billed per token never runs a hand-off on an API-key route.
  Plenum lists what these programs changed. The card is answered at the computer, or on a phone with Full access.
- **Claude Code in a hand-off** runs with the tools of the task's agent type only. None of your own Claude Code skills, MCP servers or
  settings are loaded.
- **Stop** ends the program and everything it started. Nothing shows on screen but Plenum.
- **An agent on Plenum Hub** (for example your Muse or Grok Bot in its own program, or on another computer): add it under **Agents on
  Plenum Hub** with its name on the hub, what to call it, what it is best at and how many minutes to wait (10 to start with, 60 at
  most). Plenum creates a task for it on the hub, waits for its answer and takes that as the result. Plenum opens nothing on this PC
  for it. **Connect agents to the hub** must be on.
  - The row says whether the hub's helper can start the agent. With hands-off mode on in the hub, the helper starts it by itself and
    Plenum does not ask a second time. With hands-off off, Plenum asks the helper to start it when a task is handed over. A run the
    helper starts has the hub's tools only (no shell, no files on this PC, no web) and ends within 10 minutes.
  - **Stopping a hand-off** cancels its task on the hub at once. A run the helper had already started ends by itself within 10 minutes;
    to stop it at once, pause the agent in Plenum Hub.
  - What the agent answers is another agent's text, not yours: the lead is told so, as with every hub message.
- **The result** goes on the business's record when the chat belongs to a business (which program, the title, whether it worked, a
  short text, the files it changed), and the brief counts hand-offs by program.

### The sharing switch

**Results in the business room** lists your businesses that have a room on Plenum Hub, each with a switch that is **off** until you
turn it on. Switched on for a business, Plenum posts a short result line in that business's room after a task that ran in a program
on this PC (the title, the answer and the changed files), so other agents of that business build on it; and the title and the
instructions of a task handed to an agent on Plenum Hub go into that room. A room is received by every agent that is a member of it,
on other computers too, and any agent on the hub can read a room that is not private, so the switch is yours for each business.
While it is off, none of that goes to a room: such a task goes to the agent alone. The hub tells which members acknowledged a
message; Plenum never claims that it was read.

## Plenum Hub

Plenum Hub connects Plenum to the hub program on this computer (Tabletalk Hub, in the `agent-relay-hub` folder), where agents send each other messages, hand over tasks and share notes and files. Open **Settings › Agents › Plenum Hub**.

- **Connect agents to the hub** is off until you turn it on. While it is off and the section is not on screen, Plenum sends the hub nothing and does not start its starter. With it on, a Claude Code, Codex, Gemini CLI, Cursor, Grok Build or Antigravity run gets the hub's tools beside Plenum's own. Each model is its own agent on the hub, named after the model (for example `codex-gpt-6-astra`), the same name the hub's starter uses, so a model you start in Plenum and the same model started from the hub's menu share one inbox. Muse Code and API models cannot use the hub yet.
- **No key to enter.** Plenum asks the hub's starter (`Tabletalk.cmd` in the hub's folder; the folder is under **Addresses**) for each agent's key and keeps it in memory only. It never reaches a file, a log, a CLI or a model. Plenum never uses the hub's admin key.
- **Ask before a model changes anything on the hub** is on by default: a card asks before a model sends a message, creates a task or writes a note. Reading needs no card. If you turn the hub off or change its settings while a card waits, nothing is sent. Five hub tools are never offered to a model (deciding approvals, the kill switch, publishing tools, file links and deleting files); use the hub's own screens for those.
- **What another agent writes is not you.** Plenum tells the model that a message on the hub comes from another agent, that a request in it is a colleague's request to be weighed, and that it is never your permission. The hub's own instructions reach the model as they are. If the hub is slow when a reply starts, the model gets these rules with its first hub result instead.
- **Waiting for you** shows how many things need your answer (questions agents asked you, and calls that wait for your OK), with links into the hub's screens. A **Hub N** chip in the title bar shows the same number when it is not zero. A number Plenum does not know is shown as unknown, never as 0.
- **Agents of your models** lists each agent Plenum has used and any that has a problem of its own (no key, a name that belongs to an agent on another computer, paused), with the sentence the hub's starter gave. A row says **Ready** only while the hub answers, is not paused and its starter can hand out keys. **Disconnect Plenum from all agents** forgets the keys Plenum holds and turns the switch off; the agents stay on your hub.
- **Check now** asks the hub and its starter once. **Addresses** holds the two addresses, the starter's folder, **Reset** and **Test connection** (it asks the hub whether it is up and the starter what waits for you; it uses no key). Only a hub on this computer is accepted.

If the hub is down, not set up, paused, older than Plenum expects or cannot give a model its key, the reply goes ahead without the hub and the chat says so once. It says so again only after the cause was over and came back.

## Businesses

A business in Plenum is a folder with your instructions, a plan and playbooks, plus a small record that Plenum keeps. Models work in
that folder, at the times you set, inside the limits you set, and ask you before anything leaves this PC. Open the **Businesses** pane
from the title bar (the list icon; it shows how many things wait for you).

A project that belongs to no business behaves exactly as before.

### What a business is

- **A folder you already have in Plenum** (a project). One folder is the business's home; up to four folders can belong to it. A folder
  that is, contains or lies inside another business's folder is refused, with a sentence that names that business.
- **Five things in the folder**, as plain files any model can read cold:
  `BUSINESS.md` (your instructions: what is sold, to whom, the rules), `STATE.md` (what is in progress, kept short), `PLAN.md` (a
  checklist), `playbooks/` (one file for each recurring job) and `outbox/` (drafts of anything that would go outside).
- **A record in Plenum's data folder**, not in the program folder, so an update keeps it: `businesses.json` (the list),
  `business-log/<id>.jsonl` (what happened: every turn, run, skip, answer of yours, hand-off and flag; lines are added, never changed)
  and `business-charter.json` (the fingerprint of the `BUSINESS.md` text you last confirmed).
- **Lead models** in your order. The first that can run now leads a routine. Plenum never uses a model you did not list.
- **Two limits a day**: how many routine runs (12 to start with) and how many minutes of model time (180 to start with). When one is
  reached, the next routine is skipped and the record says why.

A lead working in a business's folder is told, at the start of every chat turn, the text of `BUSINESS.md` and `STATE.md`, the last
three finished turns, and how to ask you something. It is told to stay inside this business's folders.

### Make one

1. Open **Businesses**. With no business yet, **Today** shows the form.
2. Give it a **name** and one sentence on **what it does**.
3. Choose the **folder** (one of your Plenum projects) and the **lead model**.
4. Choose a **template**: **Blank** (the files and nothing else), **Fixed-scope service** (three routines: Morning intake, Delivery,
   Exception digest) or **Daily research** (Daily cycle, Daily report). A template holds no model name.
5. Press **Create**.

Plenum writes the files that are missing in the folder. A file that is already there is never overwritten. The template's routines
arrive **switched off**; nothing runs until you turn one on. Then write your instructions in `BUSINESS.md` and confirm them under
**Setup** (see "BUSINESS.md is yours").

Under **Setup** you can change the name and the sentence, the leads and their order, the two limits, pause or close the business and
see its files. **Pause** holds every routine of that business; **Pause all** at the top holds every routine of every business until you
press **Resume all**. **Close** stops its routines and takes it off Today; its files and its record are kept, and you can open it
again under Setup.

### Set one up from a council's verdict

- A council's verdict carries the button **Set up as a business**: Plenum makes a folder for each idea you keep, and the lead model sets the business up step by step, asking you in Businesses (and on a paired phone) for everything only you can do or decide.
- Setup asks before every change unless you choose **Work on its own inside this folder**; in that mode commands run without a card and are not held to the folder.
- Setup pauses by itself after 12 steps in a row; **Stop** on a setup holds until you press **Continue setup**, also across a restart.
- The lead cannot change `BUSINESS.md`: it proposes a text, and only your Yes on that card makes it yours.
- Never type a password in an answer: Plenum refuses text that looks like one.

### What waits for you

**Today** lists everything that needs your answer, across all businesses, newest first. A lead puts an item there by ending its reply
with a line that starts with `OWNER:` (a question, a plan, or a step that would send, publish, spend, open an account or delete).
Each item shows the business, the type, who asked, the model's recommendation and one button for each option.

- **Silence is never a yes.** An item waits until you answer it or press **Not needed**. There is no default answer, no timer and no
  "answer all".
- **A yes to a draft is tied to the text you were shown.** The first press on a yes opens the draft; the second records your yes.
  Plenum takes the draft's fingerprint when it shows it and checks it again when you tap. If the file changed in between, nothing is
  recorded and you are asked to read it again.
- **An answer is a refusal only when it is the No that Plenum adds to every item.** Plenum never reads a no from the words of an
  option a model wrote.
- **A send or a publish with no draft**, or with a draft that is a link, a second name of a file, outside the folder or missing, stays
  on the list but can only be refused.
- **A yes never pays and never sends by itself:** you pay yourself. In a folder on Ask first, a send still shows its own card when
  it comes from a model or program that asks Plenum before it acts. In Auto-approve and Approve all no card is shown, because you
  chose that mode.
- **Your answer reaches the lead with its next message** in the thread that asked, and goes on the business's record with the time,
  the draft's name and its fingerprint. You can add a short note for the model.
- The options and the type of an item are the model's words; the page says so above the list.

**How it stands** under the list is the brief of each business for today or this week: what ran and how it ended, what the last run
finished and what comes next, model minutes used, plan use of each subscription against your line, goals, how many outside steps you
approved and refused, hand-offs to programs, and whether `BUSINESS.md` was changed.

### BUSINESS.md is yours

`BUSINESS.md` holds your instructions, so Plenum watches it. When its text is not the text you last confirmed, leads are told to
treat what is new in it as unconfirmed, and **Setup** shows the text with one button, **I made this change**. The confirmation is tied
to the text you were shown: if the file changes after you opened it, nothing is confirmed and the text is shown again. A business
Plenum has no confirmation for is never taken over silently: only **Create**, from your own form, confirms the first text.

A file of a business's folder that is a link, has a second name on the disk, leads outside the folder or is a secret file is not read
into a model's instructions; the page says which file and why.

### Routines

A routine starts a lead model at a time you set, as an ordinary chat turn in the folder's **Routines** thread. So it has the
approvals, limits, Stop, checkpoints and saved history of any chat. Open **Businesses > Routines**.

- **Every routine arrives switched off.** Only you can create one, change one or switch one on: no model has a tool for it.
- **When**: every day or on chosen weekdays at a time, or every N hours. **What**: a short instruction, or a playbook file in the
  folder. **How long**: 60 minutes to start with, 180 at most.
- **Before you switch one on**, the row says two things that hold for that folder: whether the Routines thread may write (turn on
  **More than one thread may write** to let it), and what the folder's approval mode means while nobody is there. In **Ask first**,
  each change waits five minutes for you and is then skipped; the run's line says how many were not answered.
- **Run now** starts it at once; **Stop** ends a run; the row shows the last run, how it ended and what it finished. A follow-up
  run that answers one of your items is listed as running too, with its own **Stop**.
- **After Stop all, or Stop on a chat a routine started, no routine starts by itself for 30 minutes.** The Routines tab says until
  when. **Resume routines**, or **Run now** on a routine, ends the wait sooner.
- **A changed playbook waits for you.** If the playbook file is not the text the routine was saved with, the routine is held and you
  are asked; **Keep** shows you the new text and accepts only that text. A playbook is read only when it is a regular file with one
  name, no link, inside the business's folder.
- **Plan use.** A run by itself is not started when its lead is at or past your stop line. If no fresh reading can be had, the last
  reading counts until that plan's window resets, and the reason says how old it is. For a subscription Plenum cannot read without
  sending a prompt, the run starts and its line says that plan use was not known.
- **Missed times.** After sleep, a restart or an update, a routine whose time passed runs once if it is not more than six hours
  late; otherwise it is skipped and the record says so. A run that was cut off by a restart is
  marked as cut off.
- **Nothing runs by itself** while everything is paused, while the business is paused or closed, before the License Agreement is
  accepted, or when Plenum's server is not the one on its port. The Routines tab and **Settings > General > Background services** say
  when the scheduler is off and why: that section has a **Routines** row and, while no business exists, a **Businesses** row that says
  "No business yet." with **Start your first business**.

Routines run only while Plenum is running. With **Start with Windows** on, Plenum starts in the tray and the scheduler with it.

## Plan mode and queued follow-ups

The **Plan** checkbox in the **Mode** menu, or Ctrl+Shift+P, turns plan mode on or off for the thread on screen (Main: the project). It is saved with that thread or project and applies from the next message. In plan mode the chat is read-only: Plenum answers and makes plans, but does not edit files, run commands or use tools, and each model runs in its read-only setting. Builds (`/build`) are refused while plan mode is on. A checkpoint restore, a rules save or an artifact save that you click is your own change, so plan mode allows it with the same checkpoint and confirmation it has outside plan mode. `/plan <task>` asks for a plan first, with no file edits.

## Threads

A project can have several chats at once, called threads, shown as tabs above the chat. The first is **Main**, which is the project's chat from before. **+ Thread** (or **Ctrl+T** in the desktop app) starts a new one with its own name, model, chat, queue, plan mode and CLI sessions; up to 8 can be open per project. Threads run at the same time: a reply in one does not block another, and each tab shows whether it is running, waiting for your approval, or has a reply you have not read. Only one thread at a time may change files in the project folder, the **writer** (Main by default); the others are read-only until you choose **Make this thread the writer**, or until they get an isolated copy (see [Isolated copies](#isolated-copies-git-worktrees)). Builds, checkpoint restores and rewinds wait until every thread of the project is idle. **Close thread** keeps its chat under **Closed threads** in the New thread panel, where it can be reopened or removed; up to 20 closed threads are kept.

The switch **Several threads may write in this folder**, in the New thread panel under **This project**, is off by default. On, every thread writes in the project folder, the read-only rule and the writer go away for that project, and each turn keeps a snapshot for Rewind. Its notice says: "Two agents editing one folder can overwrite each other's uncommitted work. Use an isolated copy for the second thread, or commit first." Builds and restores still wait until every thread is idle.

The first start of this version copies the state file to `state.json.pre-threads-<date>` (or `state.json.pre-threads-<date>-2`, `-3` and so on when that name is taken) before adding threads. Main keeps the project's chat where earlier versions read it, so an earlier version opened on the same state file still shows Main's chat (the other threads are kept but not shown).

A project's threads and their chats can be exported to a file and imported back, with **Export threads** and **Import threads…** in the New thread panel. A message travels whole, up to 8,000,000 characters. A council or build card is saved as the text of its reply, and rewind points stay on this PC. When a file leaves something out, the panel says so in one line under the buttons, on export and on import, and the file records the same counts. A project file is at most 64 MB; an export that would be larger is refused with advice to remove some threads first, and an import accepts files up to that size.

**Split view** shows two threads of the project side by side. Ctrl-click a thread's tab (Cmd-click on a Mac), choose **Open beside** in its **…** menu (or right-click the tab), or press **Ctrl+Shift+\\**. The left pane is the thread you chose last, with the full message box (model, effort, Mode, Council, attachments and / commands). The right pane has its own message box with Send and Stop, its own queue and its own approval cards. Runs stream in both at once, and Stop and Esc stop only the thread of their pane. **Swap sides** puts the right thread on the left; the **×** in a pane's head closes that pane and keeps the thread as a tab. Drag the line between the panes, or use the arrow keys on it, to change the widths. Under 1100 px, or while the side pane is open, one pane shows at a time, with a **Show …** button in its head; while a model drives the computer or the browser, that is the left pane, which holds the drive bar. In the desktop app, **Ctrl+1** and **Ctrl+2** go to the left and the right message box, and F6 reaches both panes. Plenum remembers each project's right thread and the widths in this window. In the desktop app, Ctrl+Tab and Ctrl+Shift+Tab go to the next and the previous thread on the left.

## Isolated copies (git worktrees)

In a git repository, the New thread panel offers **Work in an isolated copy (git worktree)**. The thread then works on its own branch, `plenum/<name>-<code>`, in a folder outside the project (`%LOCALAPPDATA%\PlenumWT` on Windows, `~/.plenum-wt` on macOS and Linux), so several threads can change the same repository without overwriting each other, and a OneDrive project is not synced while an agent writes. Every agent in that thread, Claude Code, Codex, Gemini CLI, Muse Code and the API models, works only in its copy. **Copy settings** can name a setup command such as `npm ci` (run through the deny list with a time limit) and untracked files such as `.env` to copy in; credential folders are never copied. A copy starts from the last commit. If the project folder has files you changed or added and did not commit, the New thread panel says how many when you tick the box, and the copy's log names them: the copy will not have them, so commit them first if the thread needs them. The thread's header row above the chat shows the branch and how many files changed, with **Review diff**, **Keep branch** (commits the changes to the branch and removes the folder) and **Discard** (removes the folder; the branch is kept unless you tick **Also delete the branch**). **Discard** always removes the folder, also when an earlier removal stopped half way (a program held a file open, or the PC went to sleep) and when the copy holds linked folders such as pnpm's `node_modules`; the folders those links lead to are never touched. **Keep branch** never deletes work it could not read: it tells you to use Discard and names the branch your commits are on. For a thread that works in an isolated copy, the git chip in the header shows that copy's branch and files. **Merge into <base>** shows the whole diff on an approval card and merges without forcing; if files conflict, Plenum lists them, stops the merge and changes nothing. Plenum runs git with the repository's hooks and fsmonitor turned off. In a folder that is not a git repository, threads share the folder and one of them is the writer.

## Build focus

Build focus is a per-project setting: the **Build focus** checkbox in the **Mode** menu, or `/focus [on|off]`, turns it on or off, and `/focus` by itself switches it. It is saved with the project and applies from the next message. With it on, every model in the project (Claude, Muse Code, Codex, Gemini and the API models) is told to get the code working and run only the checks that are strictly needed: one test file or one test name instead of the whole suite, no linters, type checks or production builds unless you ask for them in your message, no new tests or refactors you did not ask for, and a short line at the end naming the checks it skipped so you can run them. In a build, the planner adds no test-only tasks, the coders get the same instruction, and the reviewer still runs once but does not fail a build for missing tests. The build card and the plan show a **Build focus** pill while it is on; a build card that is redrawn from the chat after a reload does not show the pill.

It is an instruction, not a block: a model that decides a check is the only way to verify a change may still run it, and Ask first still shows the command on a card. Plan mode wins when both are on.

While a reply is running, Enter queues what you type, up to five messages. Each queued message starts when the run before it ends, Stop included. Each queued message has **Edit** (moves it back into an empty message box) and **Remove**. Esc stops the run.

## Model-driven runs: pause and stop

When a model drives the screen or the in-app browser, a bar sits above the message box and a pill in the title bar shows the same run. With more than one live drive, the bar has one row for each (up to three; the last row counts the drives it does not show and has a Stop for them), and the title bar has a pill for each drive, up to two; with more than two, the last pill counts the rest and has a Stop that ends all of them. The bar says what the model is doing and what state the run is in (running, paused, waiting for a card, or waiting for you to do a step). It has two controls, with the same names everywhere: **Pause**, which becomes **Resume** once the run is paused, and **Stop**. During a computer run an overlay bar on the screen has the same two controls.

- **Pause** holds the model before its next action, and **Resume** lets it go on. A run also pauses when you move the mouse, when you type where Plenum can see your keys (see [Known limits](#known-limits)), and when the model asks you to do a step, such as entering a password. While an approval card of the run waits, the bar says the card is waiting: answer the card in the chat, or press Stop.
- **Stop** ends the model's control at once and rejects every action it is still waiting to take. The model then writes a short report of what it did. Esc in the message box stops the reply as well.
- **The stop key** is **Ctrl+Alt+Esc** (**Control+Option+Esc** on a Mac). It works from any app, but only while a run is driving something: Plenum registers it when a run starts and releases it when the run ends. On Linux a desktop may already use that key, so `driveStopKey` in the state file can name another key with at least two modifiers, such as `Ctrl+Shift+F12`.
- **Time limits count only the time the model is driving.** The bar turns amber when 5 actions or 60 seconds are left. A run left paused for the pause limit ends by itself. The limit is 60 minutes by default, and **Settings › Safety › Computer use** sets it from 5 minutes to 8 hours.

When a click opens a new tab or a pop-up is blocked, the model is told which, with the new tab's number, so it does not click again. The in-app browser uses the same bar and controls. The badge, the drive bar and the stop key go away when the reply ends. The one exception is a password, code or card field that the model left for you: the browser stays paused until you have typed it (in the page, or with Type it for me) and pressed Resume, or pressed Stop.

## Computer use

Computer use lets a model see the screen and act with the mouse and keyboard, in the apps you allow, for one task you give it. It runs only in the desktop app. One run belongs to one chat message, and every action it takes passes the same checks, cards, limits and run log.

### Starting a run

Type **/computer** (with the task after it, if you like), press the **Computer…** button in the composer, or choose **Use the computer…** from the **+** menu. The dialog opens with the choices you last made for this project. It has:

- **Task.** Say what the model should do, as you would to a person.
- **What the model sees.** One window, or a whole display. A window run sees that window with the menus and dialogs its app opens, and acts only in that app. A display run sees every window on the display.
- **Apps the model may use.** For a display run, pick up to 32 of the open windows. Password managers are never offered. **Any app, no asking** lets the model act in any app except the never-allowed ones.
- **Model.** Models that cannot use the computer are listed disabled, with the reason.
- **Limits and checks.** Closed by default; its summary shows the values in use. See Limits and pacing and the switches below.
- **Start**, **Cancel** and **Past runs**.

**Start is the consent.** The run begins as soon as you press Start, and the model sees what you chose at once. No start card asks again. A run that the model starts itself is different: with the project's switch **The model may start computer use itself** on (off by default, in Project settings), it shows a start card first, and Approve all answers that card only where it covers computer cards. The model can start one run per message, and only when no run is going.

The chat shows a Computer use line under the message with the apps the model may use. Each step appears in the chat as it happens, with the model's notes between steps, and a finished run keeps its summary.

### What never happens

These hold in every mode, and no switch changes them.

- The model never types into a password, one-time-code, 2FA or CVV field. Plenum also reads the name, help text and id of the focused field (UI Automation on Windows, the accessibility API on macOS, AT-SPI on Linux; never the field's text) and refuses a box named for a one-time code, a TOTP, a 2FA, a security, verification, confirmation, login, sign-in or access code, an "N-digit code", a card verification value, a CVV or a PIN. Typed text that holds a Tab or a line break is typed in pieces and the field is checked again before each piece, so a Tab inside the text cannot carry it into a password field. On Windows Plenum asks UI Automation whether the focused field is one, and refuses to type when it cannot tell (for example in a program that hides its fields from Windows). It also refuses when the desktop app does not answer for the field's name within 2 seconds. If the desktop app is older than its server (changes from the Updates panel reach the server only), no text is typed at all and a notice says to update Plenum; until then you type, through **Type it for me**. The model then clicks the field once more or hands the step over. When it hands over, the chat shows a **Your turn** card: type the value into its box and press **Type it for me**. Plenum types it into the program the run was using and presses nothing else. The value is not kept, is not written to the transcript or the run log, and is not sent to any model.
- It never acts in a password manager, a credential or consent dialog, or a window that runs as administrator (an elevated window). The never-allowed list covers 1Password, Bitwarden, KeePass, KeePassXC, LastPass, Dashlane, NordPass, Enpass, Proton Pass, RoboForm, Sticky Password, Keeper, Keychain Access and the macOS Passwords app, and the system's own credential prompts (Windows consent and sign-in, macOS SecurityAgent, the polkit agents and pinentry on Linux). A click, scroll or button press without coordinates lands where the pointer is, so the program under the pointer is checked like a point the model names; if the pointer cannot be read, the step is refused. Plenum's own windows are never a target.
- After any pause, it takes a fresh screenshot before its next action.
- Plan mode refuses computer use. Delegated coders, /build, council, relay, quick compare and pipelines never get it.

Card, bank and id numbers are blocked by default by the **Block card, bank and id numbers** switch under Limits and checks. Switch it off and the model may type numbers that it reads in your chat or on the screen, and the run log notes that the guard was off for that run. Everything it types goes to the model's provider. Use that only for test cards in your own app.

**Always asks first**, unless Approve all covers it. These switches are under Limits and checks, and all are on by default:

- Sending messages or email
- Buying or paying
- Deleting or discarding
- Submitting forms
- Agreeing to terms
- Signing in

A switch that is off leaves that item out of the instructions the model gets for the run. A question the model still raises is asked. In a window run, an action that lands in another app asks **Allow <App> for this run?**, and Approve adds that app for the run. In a display run, an app that is not on the list asks first, unless the choice for other apps is **Any app, no asking** (or **Refuse**, which never lets the model act there). **Ask before every action**, off by default, adds a card before each click, key press and typing step.

### Approval modes

The three approval modes treat these cards differently:

- **Ask first** shows every card above.
- **Auto-approve** does not answer any computer card. The cards still show.
- **Approve all** answers them for you while the project's switch **Approve all also answers computer-use cards** is on. The switch is on by default and is in Project settings. Each answer is logged as approved by Approve all and shown as a line in the chat. The floor is not a card, so Approve all does not change it: passwords, codes, never-allowed apps, elevated windows and Stop stay as described above.

### Limits and pacing

- **Limits and checks** are set for each project and remembered. They are up to 200 actions (10 to 2,000, or **No limit on actions**), 30 minutes of activity (1 to 480; paused time does not count), and a screenshot long edge of 1280 px (1600, 2000 or 2576 px are also offered). A click, a key press, a typing step and a scroll are one action each. Long runs cost more and give the model more room to wander.
- **Settings › Safety › Computer use** sets the values for every project: the pause limit (60 minutes; 5 minutes to 8 hours), the pause between two actions (300 ms; 100 to 2,000 ms), how many days run screenshots are kept (7; 1 to 90) and how many megabytes of them are kept (200; 50 to 5,000).
- Each action waits for the pause since the last one. After a Resume, the mouse must rest for about a second before the model acts.

### Pausing

Moving the mouse pauses the run, and **Resume** goes on. Typing pauses it where Plenum can see the keyboard (see Known limits). Paused time is not counted in the minutes of activity, and after any pause the model looks again before it acts. After an approval card, Plenum waits for the mouse to rest and brings back the window that was in front. If that window is not in front again, the action is refused. A run left paused for the pause limit ends.

### On screen

While a model acts, the drive bar above the composer shows what it is doing, with Pause and Stop. The title-bar pill shows the run with Stop. An overlay bar on the screen shows the run's state and the stop key. An **amber frame** goes around exactly what the model sees: the window in a window run, or the edges of the display in a display run. In a window run the frame and the bar follow the window when it moves, changes size or goes to another display (they are drawn again each time the model looks); a bar you dragged stays where you left it. The frame shows only while the model is acting, and the overlay bar is kept out of the screenshots. In a window run on Windows and macOS, parts of the window that another program covers show grey to the model.

### Models

- **Claude.** Opus 5.5, Sonnet 5.5, Haiku 5.5 and Opus 5 use Claude's computer tools through the Anthropic API, so an Anthropic API key must be saved. The key is needed even when chat runs through the Claude CLI; with no key, Claude Code reaches the computer through the bridge instead. Claude Fable 5.2 and Fable 5.1 are listed as untested.
- **OpenAI and Google AI.** Their computer-use tools run through the OpenAI and Gemini APIs, with that provider's key saved. A safety check the provider asks for appears as a card marked as OpenAI's or Google's. The switches under Limits and checks decide which checks are acknowledged without a card.
- **Other API models that take pictures.** Plenum's generic screenshot-and-act loop runs them, and the dialog marks them **generic loop**. The notice in the chat says the model was not trained for computer use, so expect misclicks and retries. When a provider refuses or fails a request in any of these runs, the run says what happened and what to do (add credit, wait, pick another model); Plenum does not send a step again by itself, so you send again.
- **CLI agents.** Claude Code, Codex, Gemini CLI, Cursor and Grok Build reach the computer through the Plenum bridge while a run you started is live, through the same cards and Stop (see [CLI agents](#cli-agents)). Muse Code has no bridge.

Every model goes through the same checks, cards, limits and run log. Text-only models are listed disabled, with the reason.

### Platforms

- **Windows** works out of the box. A window that runs as administrator cannot be controlled, and Plenum refuses each action on it.
- **macOS** needs **Screen Recording** and **Accessibility** for Plenum, in System Settings › Privacy & Security. Grant both, then restart Plenum. The dialog's **Request permissions** button asks for them. Computer use has not been run on a Mac yet.
- **Linux** works on X11 only, with `xdotool` installed. Wayland is refused: the screen cannot be captured there, and the keyboard and mouse cannot be driven. It has not been run on a real Linux desktop yet.
- **Plain Node** (`npm start` and `node server.mjs`) has no computer use. It needs the desktop app.

### Run log

Each run is kept in the state folder, under `computer/runs`. It holds every screenshot the model was given, the actions it asked for, the card answers and the pauses. Typed text is clipped to 60 characters in the log, and the text typed into the **Type it for me** box is never written there. The files are not encrypted, and the Privacy Notice lists them. Runs are kept for 7 days and up to 200 MB by default; the oldest go first, and a run that is still going is never removed.

**Past runs** in the dialog, or `/computer runs`, lists the runs, newest first. Open one to see its steps and screenshots. **Delete this run** removes it, and **Delete all runs** removes every run that has ended. A run still going cannot be deleted; stop it first.

## Working in the chat

- **Copy, Insert, Edit and Regenerate.** Hover a message to see them. **Copy** copies the Markdown. **Insert** puts a reply in the message box (Append or Replace if the box has text). **Edit** on your own message removes it and everything after it and puts its text back in the box. **Regenerate** replaces the last reply, with the same model or another one you pick. Each reply has one Insert.
- **Long messages.** A message longer than about 100,000 characters shows its beginning, with a line under it that says how long it is and a **Show all** button that draws the rest. It then stays open until you press **Show less**, and a long reply that has just arrived stays open too. A message of several MB folds again by itself when the chat changes, because that much text on the page slows typing. Copy, Insert, Edit and Regenerate always use the whole message.
- **Long chats.** A long chat opens at its end at once; earlier messages are drawn as you scroll up, or with Show earlier messages.
- **Undo.** `/clear`, `/compact` and Edit keep the chat they replaced. An **Undo** line above the message box puts it back until you send the next message, and it survives a restart. `/clear` on a chat of four or more messages asks first.
- **Cut-off replies.** When an API model stops at its output limit, the reply gets a note and a **Continue** button, which asks it to carry on. The Claude, Codex, Gemini and Muse Code CLIs report no such stop.
- **Lost connection.** If the page cannot reach Plenum's server, a banner says so and clears when the server is back. A failed message gets **Retry** (puts it back in the message box) and **Copy error**. A restart of the server keeps the message, so its **Retry** still works; reloading the page does not.
- **Model menu.** Each model shows whether it is ready (signed in, or a key is set), its price per million tokens, its context window and whether it can use tools. Choosing a model that is not ready shows a banner that says what to do. When another program is ready, the banner also offers **Use <name>** (Claude, Codex, Gemini, Muse Code, Cursor, Grok Build, Antigravity, then a ready API provider, in that order): it sets that model for the thread when you press it, says so, and never happens by itself.
- **Unsent text.** What you have typed in the message box is kept for each thread on this computer, in the browser's own storage (it is never sent to the server), and comes back with a note and **Discard** after a reload or an update, when the box is empty. Sending clears it. Not kept: pictures and files, the queued follow-ups, a line that starts with `/`, and text that holds a key or the launch token. Drafts older than 30 days, or of chats that are gone, are dropped.
- **Command palette.** Typing `/` lists matching commands with a hint for their arguments. Some have a second name: `/stop` runs `/cancel`, `/reset` runs `/clear`, `/switch` runs `/project`, `/forget` runs `/remove`, `/limits` runs `/usage`, and `/keys` and `/login` open Accounts. The Commands panel has a filter box.
- **Narrow windows.** Below 860 px the sidebar folds into a menu button at the top left. The desktop window can be as narrow as 480 px.

## Settings

**Settings** in the sidebar, Ctrl+Comma or `/settings` opens one page over the chat. It keeps the title bar, so the drive pill and Stop stay visible. A list on the left, with a search box, holds the groups **This project**, **Rules**, **Accounts**, **API finder**, **Roles**, **Agents**, **Safety**, **Phones**, **General**, **Updates** and **Legal**, and each group's sections stack on the right. The sections this README describes are:

- **Appearance:** the same choice as the **Theme** button (system, dark or light).
- **Desktop:** the four switches described in [Finished alerts and keep-awake](#finished-alerts-and-keep-awake). They take effect in the desktop app only, and the section says so when the page is not running there.
- **Sessions:** the session mode, Transcript or Native, as described in [Session modes](#session-modes).
- **Auto-compact** (under **Roles**): a menu, a dial and a number box for each model in use, in tokens. **Model default** changes nothing; **Limit** (from 10,000 tokens to the model's context window) compacts a chat into a summary before a message goes, as `/compact` does, once the thread holds that many tokens; **Off** never does. A chat shows a notice when it is compacted, and Undo puts the old thread back. Claude Code and Codex are told the same number of tokens for their own compaction (Off turns Claude Code's off too; Codex has no off switch). A CLI in Native session mode compacts its own session, so Plenum leaves it alone, and a CLI in Transcript mode is sent at most about 37,500 tokens of the chat in one prompt, so above that the oldest messages are left out until the chat is compacted. **Add another model** gives any other model a row.
- **Team** (under **Agents**): your ordered list of models for each kind of work, as described in [Your team](#your-team).
- **Plenum Hub** (under **Agents**): the hub's state, the two switches, what waits for you and the agents of your models, as described in [Plenum Hub](#plenum-hub).
- **Programs** (under **Agents**): the programs and hub agents a lead can hand a task to, as described in [Handing work to a program or a hub agent](#handing-work-to-a-program-or-a-hub-agent).
- **Backups** (under **General**): the dated copies of your chats and settings, as described in [Known limits](#known-limits).
- **Background services** (under **General**): what Plenum runs and needs, the **Bring Plenum Hub up when Plenum starts** and **Start with Windows** switches, as described in [Background services](#background-services-start-with-windows-and-plenum-hub-in-the-background).
- **Updates:** the installed version, **Check now**, **Restart to update**, the **Check for new versions** switch and the channel, as described in [New versions](#new-versions). Checks run only in the desktop app; a plain `npm start` run says that update checks are not available.

Each change saves at once, and the line under it says **Saved** or why the change was refused. Panels can add their own sections; see [Extending Plenum](#extending-plenum).

## Phones

A phone can show the same Plenum as this window: chat, models, approvals, agents, review and Stop. You pair a phone once, from **Settings › Phones › Add phone**. Pairing happens only at this computer: a window that screen capture does not show asks you to check a six-digit code against the phone and press **Allow**. No model, tool or other program can pair a phone, press Allow or raise a phone's tier. On Linux Electron cannot keep a window out of screen capture, so the code is never shown there; pair with Copy link.

- **Ways to reach this computer.** The same network (off until you turn on **Allow phones on this network**; Windows may ask before Plenum can listen), your own Tailscale (after you agree in Settings › Phones, Plenum runs `tailscale serve` with your Tailscale; switching the phone link off removes only the Tailscale share that Plenum set up, and shares of other programs on this computer are left alone; Plenum first reads what Tailscale already serves, and if another program serves something on https port 443 it does not replace it and says so; while the link is on it looks again every two minutes and sets its own share again if another program took it away), or a relay you deploy to your own Cloudflare account from the `relay/` folder. Plenum runs no server for phones, and its developer receives nothing from them.
- **Encryption.** Each phone link is encrypted end to end with X25519 key exchange and ChaCha20-Poly1305 (the Noise protocol). The web page a phone opens on the same network is plain http, so an active attacker on that network can alter it. Use Tailscale or the relay on networks you do not trust.
- **What a phone can do.** At the **Full** tier a phone can do what this window can. Actions a phone starts, approves or stops are your actions, as the License Agreement says. **Approve and watch** lets a phone watch, approve and stop, and **Read only** lets it watch and stop. Tiers are set here, at the computer. The **Businesses** pane and the Programs section can be opened on a phone: below Full they can be read and only stopping routines works, and the pane says that answering needs Full access; at Full a phone can answer what waits, as this window can.
- **Indicator.** While a phone is connected, the title bar shows **Phone connected** and the tray shows how many. No setting hides it. Every action a phone takes is labelled with that phone's name in the activity list, the approvals and the history.
- **Stop.** Stop works from a phone in every tier, and from a notification. It ends every run on this computer.
- **Notifications.** Off until you turn them on, and each kind has its own switch: **Needs you** (approvals, hand-overs, and problems Plenum could not fix), **Finished runs**, **Limits**. They show the business or project name and a short status; a finished council says "Council is done: <project>", and a failed run says why in a fixed sentence ("<Program> is signed out", "The plan is used up", "No internet"). **Include the first line** adds the first line of a card, which can name files and commands. A phone browser gets them from its own push service (Google, Apple or Mozilla); an Android phone gets them through the push app you choose, such as ntfy. A push that fails is tried again after 5 and then 30 seconds. An approval is held for 20 seconds and sent only if you have been away from the computer (idle for 2 minutes or more). A notification is taken down when you answer its card on any device, and after Approve, Deny or Stop on the phone. While the Plenum app is open on the phone, finished, failed and limit alerts show as a toast in the app, not as a system notification. Quiet hours apply (see Notifications). An alert of the plan watch comes under the **limits** switch, with the computer's own sentence, and a tap opens Plan use (see [Plan use and the plan watch](#plan-use-and-the-plan-watch)).
- **Notifications that repair themselves.** If turning them on fails, Settings says why and offers the fix: **Get ntfy** when no push app is installed, **Open notification settings** when Android blocks them, **Open ntfy once** when ntfy does not answer. The phone looks again when you come back to the app, and sends a test notification when turning on worked. At every start the phone registers again with each computer, and when a computer no longer holds its address it sends it again quietly; Settings then says once, "Notifications had stopped reaching this phone. Plenum turned them back on." The phone keeps only a short hash of each address it gave out, never a key.
- **Keys and removal.** The phone link's keys are in `phones.json` in the desktop app's user-data folder, encrypted by the operating system. Under plain `node` they are plain files in the state folder, and Settings › Phones says so. Remove a phone under Settings › Phones: its connection closes at once and its key is deleted here. Keep phones locked, and remove a lost one.
- **Stop from a locked phone.** The lock screen's Stop everything and a notification's Stop all reach the computer without unlocking the phone. They use a Stop key that can only stop runs on that computer, and Remove revokes it with the phone.
- **When the phones file cannot be saved or read.** Stop from a phone and connecting do not wait for the file: they work while a save fails, and Plenum saves again by itself. Settings › Phones shows a red line while the last save failed, and the line goes when the save has worked. If the file cannot be read when Plenum starts, phones come back by themselves when it can, if it is only locked or not ready (Plenum reads again after 2, 5, 15, then every 60 seconds), and turning "Let phones connect" on reads it at once. A phones file that Plenum cannot read at all (it cannot be decrypted, or is not a phones file) is never replaced by itself: Settings › Phones says so and offers **Start fresh**, which asks first, keeps the old file beside the new one as `phones.json.damaged` and starts again, so every phone must pair again.
- **A relay that goes silent.** While the relay link is open, Plenum sends it a small ping every 20 seconds and counts any answer as life. After two pings with no answer in 10 seconds it drops that link, says "Your relay stopped answering, so Plenum is connecting again." in Settings › Phones and connects again. This is meant to keep Stop from a phone working after the computer has slept; it has been tested with a stand-in relay only.
- **Reconnecting.** The phone dials all its ways together, a quarter of a second apart, and uses the first one that opens, starting with the address that worked last time. Away from the home Wi-Fi, reconnecting and Stop take a second or two.
- **Changing how phones connect.** Only the computer can turn phones on or off, change the ways phones reach it or use Remove all. A phone with Full control can still remove a single phone.
- **Relay room.** If your relay turns this computer away, Settings › Phones offers New room. Phones paired before then use the relay again after you pair them again.
- **Phone apps.** The phone code is in `mobile/`. The phone web app loads from this computer, or from your relay. The iPhone and Android apps update through their stores or the release page, not through this computer. A reinstalled Android app always shows its new screens. With the phone's app lock (fingerprint) on, the app asks once when you open it, not at every switch between its pages; Lock now, a longer time in the background or turning the lock off asks again. The phone's first screen is **Today**: what waits for you, what runs now (with Stop), what did not run today and why, one Plan use line, and each business's next routine with **Run now** and **Pause**. Below Full control those buttons are disabled and say why. When the network changes or you come back to the app, the phone reconnects at once; away from the network it tries every 10 seconds, then every 30, then every 60.
- **Steering this computer from a phone.** A phone at **Full** control can tap, drag and type on the Browser pane's picture, and on a computer run's live picture after **Take over from phone**. The input is yours, not the model's: it goes straight to the browser or the screen, and no model run sees it or what you typed. Take over from phone pauses the model, waits for any step already on its way, and **Resume** hands the run back. Stop works throughout. Pictures are sent only while a phone is looking, at most five a second. A notice explains this the first time the controls appear. The iPhone app can steer only over the same network.

### Building the Android app

The Android app is built on this PC, not on a server:

```bash
npm ci --prefix mobile
node scripts/build-android.mjs          # builds the debug APK
node scripts/build-android.mjs --check  # only reports what it would use
```

The script needs JDK 21 and the Android SDK (API 36) already installed on D:. A Java runtime (JRE) or Java 25 is refused. It never downloads a JDK or SDK and never starts adb or an emulator. It keeps Gradle's cache in `D:\Gradle` and the debug signing key in `D:\Android\user`, so nothing large lands on C:. It builds the phone bundle, runs `cap sync` and Gradle, and copies the APK to `dist-android/` (on D:, not in git) with its path, size and sha256. The newest three `plenum-debug-*.apk` are kept; older ones are removed. Each build has a higher version than the last (the versionCode is the number of minutes since a fixed date, and the versionName ends in `-dev.<date>.<time>`), so installing it over the old one always loads the new screens.

To install, copy the APK to the phone and open it (sideload): Android asks once to allow installs from that app, and the install replaces the earlier build with its data kept. This is a debug-signed APK for your own phone, not a store build. The app has the Plenum icon, a splash in the page's colours, and launcher shortcuts for **Today**, **Waiting for you** and **Stop** (the Stop shortcut stops the computer the phone has open). Its notifications use their own channels, set up at install, including a separate Problems channel, group by business, and take themselves down when the card is answered. Only **Approve** asks for the phone's unlock; **Stop all** and **Deny** do not ask for it themselves, but Android may still ask for the unlock before it opens Plenum from the lock screen. That has not been tried on a phone.

### Using Plenum from a browser

A browser on another computer can show the same Plenum as a phone. It needs no app and no camera.

1. At this computer, open **Settings › Phones**, turn the phone link on, and press **Add a browser** (beside Add phone). The window shows a short address and a 12-character code. The code is drawn as a picture so that screen capture does not show it, and lives for 5 minutes.
2. On the other computer, open the address in a browser. Prefer the first one, the `https://<your-computer>.ts.net/pair/` address, which needs Tailscale on both computers (see Ways to reach this computer). Type the code.
3. The browser shows its pairing review. Check the six digits against the window on this computer, give the browser a name (it suggests "<Browser> on <System>"), and press **Allow** at this computer. Only a person at this computer can press Allow; no model or tool can.

**Why the Tailscale https address is best.** The Tailscale address is encrypted from the browser to your computer and carries a certificate, so the page itself cannot be changed on the way and the browser can keep its sign-in (it asks the browser to keep its storage). The Same network addresses are plain http: the connection is still encrypted end to end once paired, but an active attacker on that network could alter the page before it loads, and some browsers refuse to keep data on a plain page. Use them only at home or on a network you trust. The code carries no key: it only lets the browser fetch the pairing link while the offer is live. After 5 wrong codes the offer ends, and you press **New code**.

What a browser gets:

- **The computer layout.** A browser window at least 1000 px wide with a mouse or trackpad shows the desktop's own layout (sidebar beside the chat). Narrower windows and touch-only devices show the phone layout. **Settings › Appearance › Layout on this device** is Automatic, Phone or Computer; resizing across the line offers a **Switch** strip and never switches by itself.
- **Stop** is at the top right of the title bar with the word Stop, above everything else on the page. It works from every tier. If two tabs of the same browser are open, the second shows "Plenum is open in another tab of this browser." with **Use it here**; Stop from the tab that let go takes the computer back and stops.
- **Notifications** come through the browser's own push service. A hidden tab that keeps polling still gets them; a visible one does not get a duplicate. Browsers keep some keys for themselves (Ctrl+Shift+P, C and A), so the keyboard list notes that.
- **Names.** The browser is named as a browser in the title-bar chip ("Browser", "2 browsers", "N devices"), the tray, the "Browser connected: <name>" notification and Settings › Phones, with its own **This browser** row for notifications and lock. Remove it there like a phone.
- **The Browser pane** on a browser shows a picture of the browser on your computer, every 2.5 seconds; click and type in it there.

Not seen yet: any real browser other than Chromium inside Electron, real Tailscale between two computers, and a real second computer.

## Side panes

The side pane is the column to the right of the chat. Panels put their tabs into it, such as Artifacts, the Browser, Review, Agents and Businesses, and only one tab shows at a time. **Back to the chat** hides the column and keeps the tabs. **Close pane** closes the tab that is showing. Drag the pane's left edge to resize it, double-click the edge to reset it, or focus the edge and use the arrow keys. The pane starts at 440 px. It is never narrower than 380 px, and never wider than the smaller of 60% of the window and the window less 480 px, so the chat keeps room. Below 860 px the pane covers the window below the title bar, and **Back to the chat** returns to the chat. The width is kept only for the life of the page. The Review tab shows the changes of the thread on screen (its isolated copy when it has one) and follows you when you switch threads; review comments are kept for each thread. If git takes too long, the pane says so ("Git took too long to read the changes"); try again, or look at the repository in your terminal.

## Keyboard shortcuts

Press **Ctrl+/** (**Cmd+/** on a Mac) for the full list. The main ones: **Enter** sends (or queues during a run), **Shift+Enter** adds a line, **Esc** closes a list and then stops the run, **/** focuses the message box, **Up** in an empty box recalls your last message, **Ctrl+K** switches project, **Ctrl+Shift+P** turns plan mode on or off, **Ctrl+Shift+C** turns council mode on or off, **Ctrl+Shift+A** opens Accounts, **Ctrl+Shift+B** opens the Agents tab, **Ctrl+Shift+\\** turns split view on or off (**Ctrl+1** and **Ctrl+2** go to its two message boxes in the desktop app), and **Ctrl+Enter** starts a quick compare or a pipeline. Ctrl+K and Ctrl+/ work even in a text field. Ctrl+Shift letters work from the message box but not from other text fields. The approval modes (Ask first, Auto-approve and Approve all) have no shortcut on purpose. **Ctrl+Alt+Esc** (**Control+Option+Esc** on a Mac) stops a computer or browser run from any app while a run is driving something; see [Model-driven runs: pause and stop](#model-driven-runs-pause-and-stop). In the desktop app the Ctrl+/ list shows this key too, with your own key if you changed it. The page can be used with the keyboard and a screen reader: a drawer takes the focus when it opens and keeps Tab inside it while Stop stays reachable, the conversation is not read out again while a reply streams, and short events (a reply finished, a run stopped, an approval waiting, a failure) are spoken once each. If Plenum is slow to start, plain words under the title bar say so.

## Help and diagnostics

Press **F1**, or **Help** in the sidebar above Commands, to open the Help drawer. It has short topics (start a chat, stop a run, ask first and approvals, models and sign-in, settings, keyboard shortcuts), **About** (the build you run, as in [Starting, health and build identity](#starting-health-and-build-identity)) and **Diagnostics**.

- **Diagnostics is a report you read before you copy it.** It is plain text, shown in the drawer. **Copy diagnostics** and **Save as a file** are your own presses; nothing is sent anywhere. **Open log folder** shows `server.log` in the file manager in the desktop app; under plain `npm start` the drawer says where the log is.
- **What it holds.** Versions (Plenum's build, Node, Electron, Chrome, the operating system), which CLIs are found and the version each prints for `--version` (Plenum never sends a CLI a prompt for this), yes or no for each tool and each saved key, counts and sizes, the data folder and app folder as paths, a project only by its last folder's name, and the last 50 error lines of the log, each cut short.
- **What it never holds.** A key, the launch token, a chat, a prompt, the content of a file, a project's path beyond its last folder's name, your user name, an e-mail address, a phone's name or pairing data, or a hub key. One redaction cleans all of it: keys and the launch token by value and by shape, e-mail addresses, any path outside Windows' own folders and Plenum's data and app folders (cut to its last name), and a long quoted run in an error line (40 characters or more). A short word of your own inside an error line cannot be recognised, which is why the report is shown whole before you copy it.
- **Errors the page itself caught** are reported to the server (the message, the file and the line only, at most 20 a minute) and appear in the log and in the report.
- Before the License Agreement is accepted, a report can still be made, without looking for any tool.

## Checkpoints

Before a write that Plenum allows, the write and edit tools and the Claude CLI's own writes keep the file's previous contents in the state folder, under `checkpoints/<project id>`. Files over 5 MB are not kept. Open **Checkpoints** to see the list and restore a checkpoint. **Show changes** shows what a restore would change, as a diff from the file as it is now, and **Group by file** lists the changed files in this chat. The restore card shows the same diff. A restore first keeps the files as they are now as a new checkpoint ("Before restore to …"), so it can be undone: press **Undo this restore** under the status line, or restore that checkpoint from the list later. A file over 5 MB is not kept, and the card marks it before you approve. An undo does not remove a file that a restore created. A restore that you click is allowed in plan mode, with the same checkpoint and confirmation; the model itself still cannot write in plan mode. Codex, Gemini and Muse Code write files on their own; the turn snapshots below cover those writes.

### Turn snapshots and Rewind

Before each chat turn and each build, Plenum records the project folder in a private git repository under `~/.muse-console/shadow`, separate from the project's own `.git`, and again after the turn. This covers files written by Claude Code, Codex, Gemini CLI, Muse Code and shell commands. Folders such as node_modules and .git, files listed in .gitignore, and files over 5 MB are left out; a folder with more than 20,000 files or 1 GB is not snapshotted, and the chat says so. Snapshots need git. On Windows, a folder whose path is 259 characters or more is too long for git unless long paths are enabled in Windows, so its snapshots and Rewind are off, and the chat says the path is too long. A nested git repository in the folder (one with its own `.git`) is left as it is by a rewind, and the card lists it as left. **Rewind** under a message offers **Code and chat**, **Code only** or **Chat only**. Rewinding code shows a card with every file it will restore or remove, the diff, and a mark on each file the snapshot does not keep (a file over 5 MB, an ignored file or a secret file), which cannot be undone; it is refused while the project runs (plan mode does not refuse it, and the card says so), and **Undo code rewind** puts the files back. Chat only works like Edit without filling the message box. The last 50 turns of each chat keep their snapshots: for an older turn, the code choices of Rewind are off and the chat says its code is no longer kept. The copies are plain git objects, not encrypted. Secret files are left out whatever `.gitignore` says (`.env` and `.env.*` other than the example ones, private keys such as `id_ed25519` and `*.pem`, `.npmrc`, `.netrc`, cloud credential files and the like), and a rewind never writes over or removes them. Forgetting a project or clearing its chat does not remove them; delete the `shadow` folder in the state folder to remove them all (the Privacy Notice says the same).

## Attachments

Attach a file with the attach button, by dropping it on the message box, or by pasting it. Type `@` in the message box to pick a file or folder by a few letters of its name; the list leaves out ignored files, credential folders and Plenum's own source, and marks files that may hold secrets. It also offers live context: `@diff` (the working-tree diff), `@checkpoint` (what the last turn changed), `@checks` (the last check output) and `@thread:<name>` (another thread's last reply). Each goes to the model as a block marked as data from another source, up to 100 KB each and 200 KB per message; all models get them, the CLIs included. In a git folder, `@diff` leaves out the changes to secret files, as the turn snapshots do, and does not name an untracked secret file. A file literally named `diff` is written `@./diff`. Paths with spaces cannot be @-mentioned; use the attach button. Up to 10 files and 25 MB in total can go with one message.

- **Images** (PNG, JPEG, GIF, WebP; up to 4 per message, 5 MB each) go to Claude (through the CLI or an API key), Codex, Gemini CLI, and the API models whose providers document image input (Grok takes PNG and JPEG only). Which models take images is in `lib/capabilities.mjs`, read from each provider's pages on the date it shows. Muse Code and DeepSeek take text only. Before you send, a line under the attachments says what the selected model will receive, for example 'Gemini CLI: image ok · PDF as text'. Gemini CLI gets the images from a temporary folder that is deleted after the reply.
- **PDFs** (up to 20 MB) go to Claude by API key as documents (up to 100 pages). Every other model gets the PDF's text, read by Plenum (up to 100 pages and 200 KB of text; never part of a file). A scanned PDF has no text, and Plenum says so instead of sending it. A PDF with only a few characters of text (fewer than 20 that are not spaces) is refused as too short to read, because a stray page number or stamp on a scanned page is not sent as text; a password-protected PDF is refused with a request to save a copy without the password.

Council seats, the moderator and quick-compare seats get the images when their model takes them; the others get a note that an image was attached. A council question takes text, code and PDFs as well (attach, drop, paste or `@path`): every seat and the moderator get them in every round, a PDF as a document for Claude by API key and as its text for the others. A `@path` file goes into every seat's prompt, since no seat opens files itself.
- **Text and code** from the attach button, drag and drop, or paste go into the prompt for every model (up to 200 KB a file, 600 KB of text in all). A `@path` file goes into the prompt for the API models only, and only if it is 100 KB or less. Claude through the CLI, Codex, Gemini and Muse Code read a `@path` file with their own tools.

## Tokens and cost

Each reply records the tokens its provider reported. Dollar figures come from `lib/pricing.mjs`, which has per-token prices for the API models, read from the providers' pricing pages on 2026-10-14 (`PRICES.checkedOn`). Check the prices again before relying on a cost figure. A model with no published price shows "price not published", and a reply whose usage was not reported shows "usage not reported". Tokens are never estimated. A subscription CLI (Claude Code, Codex, Gemini CLI, Muse Code, Cursor, Grok Build, Antigravity) is billed to your plan, so its replies show plan use: tokens only, never a dollar amount. The top bar shows the project's running total, and its tooltip gives the breakdown.

### Spend limits

The spend chip in the project header opens **Spend limit**, where a project can have a warning amount and a cap in dollars for models billed through an API key. The total keeps counting across `/clear`, `/compact`, Edit and Undo, from the date shown, until you press **Reset spend**. Crossing the warning shows one notice. At the cap, messages, `/review` and `/compact` that would bill an API key are refused with a plain message, and the automatic advisor review is skipped with a notice. The Claude, Codex, Gemini and Muse Code CLIs on your plans are never refused. Agents on API-key models count toward the cap, `/build` tasks included: an agent that would bill an API key is refused at the cap like a reply, and its cost adds to the running total (see [Agents](#agents)). The cap also holds inside one reply: before each further request of a tool loop on an API-key model Plenum checks the saved spend (each finished request is saved at once, and a running agent counts what it has used so far), and a reply that reaches the cap ends with a plain notice, so one message cannot run far past it. At most the request already in flight goes over. A council that reads or works in the folder counts, since its seats and moderator run as agents. Text-only council, quick compare, pipeline and relay replies are not counted yet, because their cost is not worked out on the server.

### Plan use and the plan watch

Plenum reads the plan use of every subscription you are signed in to by itself, works out where each limit will stand when it resets, and tells you before a business runs out.

- **What is read, and what it costs.** Every five minutes Plenum takes the readings that cost nothing: Codex is asked directly (its app server answers without running a model), and Muse Code reports plan use with every reply, yours or a routine's. Claude Code reports its limits with replies too, but not with every one. Claude Code 2.1 sends the percentage of each limit it measured, and Plenum reads it; an older version can send only "within limit", "close to the limit" or "used up" and nothing more. Claude Code and Muse Code can be asked only by sending one very small request. Plenum sends one when the newest number is older than the time you choose (every hour unless you change it: 30 minutes to 6 hours, or **Never**), never more than one in 30 minutes for a provider, and never while a run of that provider is going. While nothing changes it asks less often: each request that finds the numbers where they were doubles the wait, up to 6 hours, and the first use that is seen ends the longer wait. **Check now** reads everything at once; it sends such a request at most once an hour for a provider. Gemini CLI, Antigravity, Cursor and Grok Build report no plan use, and their rows say so.
- **Where you see it.** The ring beside the model opens **Plan use**: a card for each subscription with each limit as a bar, "used N%", when it resets, one sentence about the pace, and when and how it was last checked. The switches are there too: check by itself, how often a check may send a very small request, and alerts.
- **The projection.** The pace comes from the readings of the last two hours (a limit of up to 12 hours) or of the last day (a longer one) when at least three of them cover a quarter of that time, otherwise from the whole period so far. A limit that will stand between 85% and 100% at its reset is **Tight**. One that passes 100% before its reset **Will run short**, and the sentence says when it is used up. At 100%, or when the provider says so, it is **Used up**. A limit that was reported with no percentage has no projection: "close to the limit" shows as **Tight**, "used up" as **Used up**, and otherwise the card says that no percentage was reported. The pace is said by the hour for a limit of up to 12 hours and by the day for a longer one ("17 percent a day"). While there are too few readings the sentence ends "This is an early estimate.", and the card's label reads **May run short** or **May get tight** instead of the plain word. A reading so old that the limit would have been reached by now at that pace is said as what it is: "At that pace it would be used up by now. This reading is 50 minutes old."
- **Businesses.** A business runs its routines on its leads, in order, and stops using a lead at your stop line for that provider (the business's own line, else your team's, else 100%). Each business card has one line: that it is fine, which lead reaches your line when and which lead takes over, or when it runs out of plan use and until when nothing is left. A business has nothing left only while every one of its leads is at its line at the same time. A lead that cannot run for another reason (not installed, not signed in, no key) is named as that, never as a plan that is used up.
- **Alerts.** Four kinds, each once for that period of the limit: a plan's limit will run short, a plan's limit is used up, a business will run out of plan use, a business has nothing left. When one of your businesses is left with nothing the alert leads with the business.
  - *Ahead of time* only for a limit longer than 12 hours (the weekly ones), and only on evidence: the limit is on course for a tenth over the line at its reset, it would be reached at least a tenth of the limit's length before the reset, at least a quarter of the period is gone and the whole period so far agrees. The pace of a 5-hour limit says too little for that (see DECISIONS item 153), so a 5-hour limit is told when it is used up.
  - *Used up* and *nothing left* are told when they will last 30 minutes or more.
  - An alert shows as a strip above the message box (never a dialog, and it never stops a run), as a Windows notification when Plenum is not in front, and on your phones under their **limits** switch. An alert that no longer holds leaves the strip, and the list says "This is no longer the case." **Alert me before a plan runs out** switches alerts off.
- **What is kept.** The readings of the last 14 days are in `plan-use.json` in the state folder: percentages, reset times, the alerts and the three switches. No prompt, reply, key or account detail.
- **What Plenum never does for this.** It never signs in, never reads a CLI's credential files and never calls a provider's account pages itself: every number comes from what the provider's own program reports. Nothing is read before the License Agreement is accepted.

## History search and export

The **Chat history** panel searches the current project's chat, case-insensitively, newest first, up to 50 matches. Tick **All projects** to search every project's chat; each match names its project, and clicking it switches there and outlines the message. The panel also exports the chat as a Markdown file. Search and export read the chat and change nothing. Each chat keeps its last 300 messages: Main and every thread.

## Saved prompts

A saved prompt is a named template for one project. Its name is up to 32 lowercase letters, digits or hyphens, and it cannot be the name of a built-in command. Its text is up to 4,000 characters. `$ARGUMENTS` in the text is replaced by whatever you type after the name. Type `/name` in the message box to send it. Saved prompts are kept in `prompts.json` in the Plenum state folder.

**Export** saves a project's prompts as a JSON file, and **Import** adds the prompts from such a file; a prompt with the same name is replaced. Pipelines export and import the same way in their panel. Every entry is checked before anything is saved, and a file with one bad entry is refused with the entry's number. Importing never runs anything.

If `prompts.json` is damaged (it cannot be read as a JSON object), Plenum renames it to `prompts.json.corrupt-<time>`, never deletes it, and starts with an empty list. An entry that was broken by hand is left out of the list, so it cannot be sent.

## Rules

Open **Rules** in Settings (or type `/rules`) to edit the project's rules files and your global rules without leaving Plenum.

- **AGENTS.md** in the project folder is the project owner's instructions. Plenum adds its text (up to 32,000 characters) to the instructions for every chat message and for the build's planner, coders and reviewer, and says in the chat when it uses one. Codex also reads it from the folder on its own. It is treated as data: it cannot approve an action, widen the project folder or turn a tool on. The panel creates it when there is none.
- **CLAUDE.md** and **GEMINI.md** are read by Claude Code and the Gemini CLI from the project folder on their own; Plenum edits them but never adds them to a prompt. The panel shows them when they exist and can create them.
- **Global rules** apply to every project, after the project's AGENTS.md. They are kept in `rules.md` in the Plenum state folder (up to 16,000 characters) and are never written to the CLIs' own global files.
- **Blocked commands** are still edited in Project settings; the panel links there.

Before the panel overwrites a project file it keeps a checkpoint, so **Checkpoints** can put the old text back. A file that changed on disk while the panel was open is reloaded if you had not edited it, and otherwise your save is refused until you reload. Saves are refused while the project is running. Plan mode does not refuse your own save: plan mode binds the model, not you, so a save from this panel is written with the same checkpoint as outside plan mode. The model still cannot write files in plan mode. A change applies from the next message; a Native session is started again so the model sees it. Council seats get the rules only when the council reads or works in the folder; quick compare, pipeline and relay seats do not get them.

## Finished alerts and keep-awake

In the desktop app, Plenum shows a notification when a run in any project ends while the window is not the one in front. It says "Done: <project>", "Council is done: <project>" with "The verdict is ready.", or "Stopped: <project>" with a plain reason (signed out, plan used up, no internet), never the model's own words. Runs under 20 seconds, stopped runs, housekeeping runs and runs of a routine are not told here. When an approval card is waiting and the window is not in front, Plenum shows "<project> needs a yes", or "N approvals are waiting", as one notification that the newer one replaces and that is closed when the last card is answered. Clicking a notification brings the window back and opens the place: the chat, the waiting card, Today, Plan use, Accounts or Background services. While any project has a run in progress, Plenum keeps the PC from suspending. The tray icon's tooltip and menu show how many approvals are waiting. The four switches are under **Settings** in the sidebar, in the **Desktop** section: **Finished alerts**, **Approval alerts**, **Keep awake** and **Keep in tray on close**. They are also kept in the state file as `finishedAlerts`, `approvalAlerts`, `keepAwake` and `trayOnClose`, and a change made in the window applies at once, with no restart. Finished alerts, approval alerts and keep awake are on by default. Keep in tray on close is off by default. None of them runs under `npm start`. During quiet hours (see Notifications) finished alerts are not shown and approval alerts come without sound.

## Notifications

Everything Plenum tells you outside a chat goes through one place, so the desktop, the page and your phone follow the same rules. A notice has a level:

- **Needs you** (an approval, a routine that is switched off, a sign-in you must do, Plenum Hub that could not be started). It rings, stays on the bell until done, and goes to a phone with sound.
- **Problem** (something went wrong that Plenum could not fix). It is shown, stays on the bell, and goes to a phone.
- **News** ("Codex is signed in again", "Plenum Hub had stopped. Plenum started it again."). It is shown quietly and never goes to a phone.

Where you see them:

- **The bell** in the title bar counts what is open and opens **Notifications**: **Needs you**, with one button to the place, and **Recent** (the last 20). The bell keeps its place when nothing is open.
- **A toast** in the page for a live notice. The same notice twice within a minute is shown once. At most 3 toasts show at a time.
- **Windows notifications** in the desktop app, only while the Plenum window is not in front. When it is in front, the toast and the bell are the only places.
- **Your phone**, when push is on for it (see Phones).
- **"While you were away"**, one strip above the chat when you open the page or come back after more than 30 minutes, with what happened since you last looked.

Settings > General > Notifications has:

- **Quiet hours**, on by default, 23:00 to 07:00 local time. In quiet hours approvals and hand-overs reach your phone without sound, and finished and failed runs and limits are held back; they are not lost. They are written to Recent and to the morning summary, and are not shown on the bell.
- **Morning summary**, on by default at 08:00 (or when quiet hours end, if that time falls inside them): one "While you were away" notice made from counts, never from a model's words.
- **Mute a business** for an hour or to the end of the day. A muted business sends nothing until then; what needs you still shows on the bell.
- **Send a test notification.** On the desktop it shows as a toast in the page while the window is in front.

Notices are kept in `notify.json` in Plenum's state folder (the last 50, and the open ones). If that file cannot be read, Plenum does not write over it, runs from memory and says so.

## Project settings and tools

Each project folder can have its own model, effort, approvals, relay settings, plan mode, deny patterns, tool options and agent types and limits. Open **Project settings** with the gear beside the project name. Each setting follows the app default until you change it, and **Use app default** goes back to it. The **Tools** section covers Claude Code, Codex, Gemini and Muse Code. For example, it sets Claude Code's permission mode and tool lists, Codex's sandbox (read only, or project folder only), and Muse Code's approval mode and sandbox network. Council seats and the moderator are not given the project's tools unless the council reads or works in the folder, or you allow read-only agents for them in **Agents > Limits** (see [Agents](#agents)); in a text-only council a CLI seat runs in its own read-only setting. The **Agents** section gives the project its own copy of the agent types and limits, or uses the app's.

Under the deny patterns, **Test a command** says whether a built-in rule or one of the project's patterns would block a command you type. It only checks; nothing runs.

The project's **Approvals** setting takes Ask first, Auto-approve or Approve all, and a project's value is what its runs use. The same setting is the **Mode** menu's choice.

**Browse…** in the add-project form opens the system's folder chooser in the desktop app. Under `npm start` it says to paste the path instead.

For a project in a git repository, the header shows the branch, how far it is ahead or behind, and how many files are changed or untracked. Click it for the list of files. It refreshes every 30 seconds and after each run, and it runs one fixed, read-only `git status` command, with git's `core.fsmonitor` program, hooks and filter drivers turned off (see `DECISIONS.md`, items 18 and 30).

### Check after each turn

In **Project settings**, **Check after each turn** takes a command such as `npm test`, `pytest -q` or `cargo check`. After a chat turn that changed files, Plenum runs it in the project folder (or the thread's own copy) and the reply gets a badge: **Checks passed · 12 s** or **Checks failed · exit 1**, with the output one click away. The **Running checks** notice appears when the check starts, not when it ends. **Send failures to <model>** puts the failure output in a message for the agent. **Auto-fix up to 2 times** (off by default) sends the failures back by itself and runs the check again, at most twice; each round is a normal reply that counts toward the spend limit and asks for approval as usual. The check runs like run_command: with your user rights, through the deny list, with a time limit (120 seconds by default) and a cap on its output. It never changes Ask first or Auto-approve. A safety notice under the switch says the check runs with your rights and no approval card, and that Auto-fix sends its output to the model. When a turn changed a file that decides what the check runs, such as package.json or a Makefile, Plenum does not run it by itself; look at the change, then press **Run checks**. No check runs in plan mode.

## Session modes

The **Sessions** choice in **Settings** is either Native or Transcript (saved as `sessionMode` in the app's state file). Transcript, the default, sends the chat again with each message. Native resumes the session that Claude or Codex keeps for the main chat. Other providers, and Muse Code, always send the transcript. Council seats always send the transcript, and each shows **Sessions: Transcript**, because their turns never open a native session. A change to AGENTS.md or the global rules starts the Native session again on the next message, with a notice, so the model sees the new rules.

## Portable and tray mode

On Windows, `npm run dist:portable` builds one portable `.exe` in `release/` that runs without an installer. To keep the window in the tray, turn on **Keep in tray on close** under **Settings** › **Desktop** (or set `"trayOnClose": true` in the state file: `%USERPROFILE%\.muse-console\state.json` on Windows, or `~/.muse-console/state.json` on macOS and Linux). Closing the window then hides Plenum to the tray and the server keeps running. Click the tray icon to show the window again, or choose **Quit** from the tray menu to stop everything.

## CLI agents

Claude Code, Codex, Gemini CLI, Cursor and Grok Build run as their own command-line programs with their own sign-ins. Plenum gives one of them a key only through a key route under **Accounts**, which says what each run uses. **Use my Google AI key with Gemini CLI** is on by default: when a Google AI key is saved, Gemini CLI gets it as `GEMINI_API_KEY` and those requests are billed per token, because Google's terms allow Gemini CLI through an API key but restrict its account sign-in from other apps. Turn it off to use the Google sign-in. Under the switch, each Gemini model can also have a route of its own: **Google AI key (per token)** or **Gemini subscription (Google sign-in)**, which wins over the switch for that model. A run with its own route tells Gemini CLI which sign-in to use in a settings file of its own for that run, so the choice holds whatever `/auth` is set to in Gemini CLI. Gemini 4 Argon, Gemini 3.8 Flash and Gemini 3.5 Flash-Lite are listed through Gemini CLI as well as through the Google AI API, so they can run on the subscription; whether the subscription serves a model is Google's call, and Gemini CLI says so when it does not. **Use my OpenAI API key with Codex** is off by default, so Codex uses your ChatGPT sign-in. The key goes only into that one run's environment, and Plenum takes it out of the CLI's output, failure text included. Claude Code, Cursor, Grok Build and Muse Code never get a key.

Claude Code, Codex, Gemini CLI, Cursor and Grok Build can use the Plenum browser pane, a computer-use run you started and Plenum's agents. Plenum starts a small local MCP server for the CLI for each chat message (never for read-only seats, council seats or Plan mode); each call goes through the same cards, site list, limits and Stop as in Plenum's own chat. Plenum passes the CLI only the address of this app on your computer and a one-time token, never a key or a sign-in. Muse Code does not get the bridge.

Cursor runs through the Cursor CLI (`agent`, or `cursor-agent`), signed in with your Cursor account through Cursor's own sign-in. Plenum does not use a Cursor API key: it removes `CURSOR_API_KEY` and every other `CURSOR_` setting from the program's environment. Its default transport is ACP, so Ask first works: its edits and commands come to Plenum as approval cards. `MUSE_CONSOLE_CURSOR_TRANSPORT=print` uses Cursor's print mode instead, which cannot ask: in Ask first Cursor only proposes its edits in its reply, and in Auto-approve or Approve all it runs with its own prompts off (`--force`), so Plenum's deny list and credential floor do not reach those steps, and a notice says so. A read-only Cursor run (a council seat, a compare column, plan mode) runs in an empty folder and refuses every request.

Grok Build runs through its own CLI (`grok`, installed with x.ai's installer), signed in with your SuperGrok or X Premium Plus account through `grok login` in Accounts. Plenum removes every `XAI_` and `GROK_` setting from the program's environment, so no API key reaches it. Its default transport is ACP (`grok agent stdio`), so Ask first works: its edits and commands come to Plenum as approval cards. `MUSE_CONSOLE_GROK_TRANSPORT=print` uses `grok -p` instead, which cannot ask, so an action that needs approval fails. In Approve all, that transport runs with Grok Build's prompts off (`--always-approve`); Plenum cannot see or stop those steps, and a notice says so. A read-only Grok Build run (a council seat, a relay hop, a compare or pipeline step, plan mode) runs in an empty folder and refuses every request.

**When a CLI fails.** If Muse Code, Codex, Gemini CLI or Claude Code stops in the middle of a reply (a usage limit, a busy service, a dropped connection, a crash), the text it had written stays in the chat and the reply is marked as failed, so a half answer is never taken for a whole one; a council or relay does not pass it on. The message says what happened and what to do, in plain words: sign in from Accounts, wait for a limit to reset (with the time, when the CLI gave one), pick another model, check the connection, or update Plenum when a CLI has changed its options. The CLI's own last line follows underneath. When Plenum cannot tell the cause it says so and shows the CLI's last lines; it does not guess. Under a failed reply Plenum offers the buttons that fit the cause: **Retry** (puts your message back to send again), **Sign in** (opens Accounts at that card), **Pick another model** (opens the model menu) and **Open the log** (opens the folder of Plenum's log). Plenum never signs in, switches the model or sends again by itself: each button only takes you to the place, and you do the rest. "Not signed in" is said only when the CLI itself says nobody is signed in. When Claude Code refuses one reply for its sign-in, Plenum asks Claude Code's own sign-in check again; if that says it is signed in, the message says the sign-in was refused for this reply although Claude Code is signed in, and offers **Retry** beside **Sign in** (send the message again; if it is refused again, choose **Sign in again** on the Claude Code card). A reply that only talks about signing in or authentication is a reply, never a failure. A reply that an agent cut off says so, a long command output keeps its start and its end and says how much was dropped, and an option a CLI refused is remembered for one hour for that CLI version, so the same run is not started again with it.

## Agents

An agent is a model that does one task for another model and reports back. Open **Settings**, then **Agents** (or type `/agents`), to see the agent types and the limits. Five built-in types come with Plenum: **Researcher** (reads the project and reports what it finds; never edits), **Coder** (makes one change inside the folders it is given and reports what it changed; this is the coder that the delegate tool and /build have always used), **Tester** (runs the checks the task names, such as one test file, a lint or a build, and reports pass or fail with the failing output; it does not edit), **Reviewer** (reviews the change it is given, opens the files it needs and gives a verdict; it does not edit; /build's review step uses it) and **Planner** (splits a goal into build tasks; /build uses it alone). You can add your own, most quickly with **Copy** on an existing type. Each type sets its model (any provider, or the same model as the one that asked), effort, a tool-step limit, a time limit, an idle limit, its access to the project files (none, read, or read and edit), whether it may run commands or use the web, which folders it may write in, and what it reports back. Built-in types keep their name, kind and reply layout. **Reset** on a built-in type restores its shipped settings; on the Reviewer it restores the older version that cannot open files. **Limits** say, per caller (the chat model, a build, each council seat, the moderator, relay hops, quick compare columns and pipeline steps), which types it may start, how many at once, how many per reply, build or run, and whether to ask before each start. A per-model override gives one model its own numbers, in every role or in one. Below them, **Every run** says whether agents may start agents (off by default, read-only agents only, or any type they may start) and the most agents in one run. The council seats, the moderator, relay hops, quick compare columns and pipeline steps start nothing until you give them types. Once you do, their cards show on the Agents board and in the chat under the seat's name, and the types they may be given can edit files or run commands; the add menu lists the read-only types first, marked suggested. The settings are app-wide, and a project can keep its own copy with **Give this project its own agent settings** in **Project settings**. The defaults are: the chat may start Researcher, Coder, Tester and Reviewer, 8 at once and 32 per reply; /build may start Coder, Researcher and Tester, 4 at once and 8 per build; agents cannot start agents; the other roles start nothing. A call beyond the number at once waits for a place, and a call beyond the number per reply is refused. An agent that a seat, hop, column or step starts is told which model started it and that its report goes back to that model, not to the person.

Limits are enforced while an agent runs: it is stopped at its tool-step limit, its time limit or its idle limit, and the model that asked is told why. Anything the model sends counts as activity for the idle limit, its thinking and a CLI's progress lines included, so a model that thinks for minutes is not stopped as idle. Before and after its work, an agent compares the files of the project folder, which is how Plenum lists what it changed and catches a change outside its scope. The first comparison in a folder reads every file; later ones read only the files that changed. Stop works while it runs, and the Agents tab says "Checking the project's files" while a slow comparison runs. If the folder has more than 20,000 files, or the comparison takes longer than 15 seconds, the agent still runs and a note says that only some files were checked, so a change to one of the others may not be listed. The model that asked is told the same: its answer says "Changed files: not known" (or that another changed file may not be listed) and never reads as if nothing changed. The built-in types wait 10 minutes for activity (the Planner 20); the Reviewer and the Planner have 20 minutes in all. Every agent follows the approval mode (Ask first shows its cards, named after the type and the task), plan mode (no agent runs), the blocked commands, checkpoints and the project spend cap (an agent on an API-key model is refused at the cap, and its cost counts toward the running total). Through the Claude CLI, the chat can start only agent types on Claude models, because they run as Claude Code subagents; Claude Code's own subagents count against the Chat row and can be turned off in Limits. When the turn that started an agent through the Plenum MCP bridge ends, its running agents are stopped with it, so they are not left running unlisted. An agent that Plenum starts as its own Claude Code run gets only the tools of its type: it does not see the services you connected to Claude Code, your skills or your Claude Code settings files, and a tool that is not on its type's list is refused with no card. The chat's own Claude Code turn, and the agents the chat starts inside it as subagents, keep your settings, so an allow rule there still passes without a card. This was tested with a stand-in Claude Code only, not a real one.

**Running agents** are listed in the **Agents** tab of the side pane, which `/agents running` and Ctrl+Shift+B open. Its button shows how many agents are waiting for you (in amber), or else how many are running. The tab has three parts. **Waiting for you** holds the approval cards, one open at a time. **Running** is a tree, with each agent under the agent that started it, showing its type, its title, its model, its elapsed time, its steps and its state (waiting for a free slot, waiting for your approval, running, or running inside Claude Code). Each agent has **Stop**. The tab's **Stop all** asks first, then stops every reply, agent and computer or browser run in every project and denies the cards they wait on, like Stop on a phone. **Finished** lists the last 30 agents with how each one ended, such as stopped at its time limit, stopped by you or failed. An agent that runs inside Claude Code has no Stop, because Plenum cannot stop it; Esc stops the whole reply. The list is the table the limits count, so what it shows is what the limits count. `/agents stop` stops every running agent in the active project. The sidebar's **Running now** list shows every run in every project, with the approval cards that wait pinned at the top as **Waiting for you**; **Show all (Ctrl+Shift+B)** opens this tab. Click a row to open its project and its thread (Main for a Main run, whatever thread the project showed last); a finished run keeps its dot until its own thread has been on screen. In `/build`, each task row shows its agent type and model, its elapsed time while it runs and its steps once it is done, and the plan panel lets you change each task's agent, model and effort before it runs.

## Commands

| Command | What it does |
|---|---|
| `/add <folder>` | Add a project folder (absolute path) |
| `/project [name]` | Show or switch projects |
| `/remove <name>` | Forget a project (files are kept) |
| `/model [name]` | Show or set the main model: `opus`, `sonnet`, `haiku`, `fable`, `wonder`, `wonder-full`, `muse`, `codex`, `gemini`, `grok`, `gpt`, `deepseek`, `mistral`, `google-ai`, `echo`, or a full id such as `openrouter:<id>` |
| `/models` | List models and aliases |
| `/advisor [name\|off\|auto]` | Set the advisor. It is off in a new profile, and a profile that already had a setting keeps it. `auto` reviews every reply |
| `/review` | Advisor reviews the last answer plus the working-tree diff |
| `/council <question>`, `/council off` | Ask every council seat, then a moderator sums up. `off` returns to Chat |
| `/build` | Turn the last council recommendation into tasks, then run them. Each task runs as an agent type (Coder by default). |
| `/agents [running\|stop]` | Agent types and limits; `running` shows the agents at work, `stop` ends them all |
| `/relay` | Pass a finished reply from one seat to another, once or as a route |
| `/approvals [ask\|auto\|all]` | Show or set the approval mode. `all` asks you to confirm |
| `/focus [on\|off]` | Build focus on or off for this project. With no word it switches |
| `/computer [task\|runs]` | Open the Computer use dialog, with the text after it as the task; `runs` lists the past computer runs |
| `/rules` | Open the Rules panel: AGENTS.md, CLAUDE.md, GEMINI.md and the global rules |
| `/legal` | Open the Legal page: the License Agreement, Privacy Notice, third-party notices and safety notices |
| `/effort [low\|medium\|high\|xhigh\|max]` | Show or set how hard the main model thinks. The **Effort** menu under the message box does the same. Claude, Muse Code and Codex all take it |
| `/theme [system\|dark\|light]` | Follow the system, or always use the dark or light look |
| `/updates` | Show or hide the Updates panel |
| `/settings` | Open Settings: Appearance, the Desktop switches and Sessions |
| `/ask <model> <message>` | Send one message to a model without switching |
| `/plan <task>` | Ask for a plan only, with no file edits |
| `/usage` | Show your limits: Muse Code's 5-hour and weekly use, Codex's weekly use and credits, and the Claude key's per-minute rate limits. Reading Muse Code or Claude can send one very small request |
| `/compact` | Have the main model summarise this project's chat, then replace the chat with that summary |
| `/clear`, `/reset` | Clear this project's transcript. A chat of four or more messages asks first, and Undo can bring it back |
| `/cancel`, `/stop` | Stop the running request (Esc also works) |
| `/status`, `/login` | Provider status, and how to sign in |

`@path/to/file` attaches a file (see [Attachments](#attachments)).

If two projects share a folder name, `/project` and `/remove` refuse that name and list the full paths; give the full path instead.

## Known limits

- Through the Claude CLI, Plenum sees only the requests the CLI asks permission for. Reads and harmless commands that the CLI allows on its own produce no card. Everything else asks first unless auto-approve is on. Credential folders and Plenum's own source stay off limits either way.
- `run_command` runs with your user rights, in the project folder, with a 120 second default timeout (900 maximum). It uses cmd.exe on Windows and `/bin/sh -c` on macOS and Linux. Output is capped.
- Muse Code's approval and sandbox settings come from its tool options in project settings, not from the Mode menu. The default is on-request approval. Muse's own approval prompts cannot be answered from this window, so in Approve all they are turned off instead (`--disable-approval`); verify how a headless run behaves after you sign in.
- In Approve all, commands that Gemini runs in its yolo mode and that Muse Code runs with its prompts off are not checked by Plenum's deny list, which covers only the write and edit tools, `run_command` and the Claude CLI. Their own settings files (`~/.gemini/settings.json`, `security.disableYoloMode`; Muse Code's own config) still apply.
- The API finder matches models across routers by exact id, after spelling fixes for a few makers (x-ai, mistralai, z-ai, deepseek-ai). It does not include fees in its comparison, drops router entries marked deprecated, and its hand-checked router table is dated 2026-10-20.
- Checkpoints and the deny list cover the write and edit tools, `run_command` and the Claude CLI. They do not cover writes that Codex, Gemini or Muse Code make on their own. Those three also still read the project as advisor, planner or reviewer.
- Muse Code runs one-shot per message, with the chat resent. Codex resumes its own session only in Native session mode. Neither shares its session memory with Claude's history.
- Prompts for the CLIs go in a file or on stdin, so long histories fit.
- Plenum keeps projects and chat history in `%USERPROFILE%\.muse-console\state.json` on Windows, or `~/.muse-console/state.json` on macOS and Linux (override with `MUSE_CONSOLE_HOME`). It does not write API keys to that file. Where keys are kept is described in [Where keys are kept](#where-keys-are-kept). Plenum saves your chats after every change. If another program has the state file open for a moment (a sync or antivirus tool), Plenum waits a few seconds and tries again. If a save still fails, the chat stays on screen, a banner says so, and Plenum saves again by itself after 10 seconds, then 30, then every minute. Before each save, the previous file is copied to `state.json.bak`. Plenum also keeps dated copies in the `backups` folder beside it: at most one an hour while you work (the newest 24 are kept), then one a day for 7 earlier days, one before the first save of a new build, and one before a restore, all under 200 MB. **Settings** › **General** › **Backups** lists them, says how many messages and chats each one holds, and restores one after a confirm. A restore keeps the chats and settings from just before it as a copy in the same list, marked "before a restore", so it can be undone; those copies stay for at least a week. Restoring several copies one after another to look for something keeps one such copy, the state you started from. A restore waits until no reply is running. A copy that cannot be made (a full disk, a locked file) never stops a save. If `state.json` cannot be read as JSON at start, it is renamed to `state.json.corrupt-<time>` (never deleted), the backup is loaded, and a banner says what happened. If it cannot be opened at all (another program holding it), Plenum tries three more times, then loads the backup and leaves the file alone; before the next save replaces it, it is copied to `state.json.unread-<time>`. A chat that is not a list of messages keeps its old value in `state.json.damaged-chats-<time>.json` and the chat starts empty. A backup that cannot be used is kept as `state.json.bak.corrupt-<time>`. A leading byte-order mark is ignored. If another Plenum on the same folder saves the state file while this one runs, this one refuses the save with a notice until it is restarted; a hand edit of state.json while Plenum runs has the same effect.
- The server binds to 127.0.0.1 only. Every request to `/api/` must carry the per-launch token (the desktop app passes it to its window; a plain node run prints a link that carries it) and POSTs must come from the same origin.
- `MUSE_CONSOLE_NO_FALLBACK=1` turns off the server-side refusal fallback that the Claude Opus, Sonnet and Fable models request by default.
- macOS and Linux have not been run. They were only tested with the platform forced. Every build is unsigned until certificates are added, including the Windows installer and portable exe built here (Windows SmartScreen warns on first run), and the Linux builds are never signed. Unsigned macOS builds cannot install updates.
- The desktop app itself (the Electron window, the OS-encrypted key store, and the utility process that runs the server) has been tested only against stand-ins, not by launching the app. That includes the approval alert, the tray count, the folder chooser behind **Browse…** and the 480 px minimum width.
- Automatic updates were tested against a stand-in updater and a local pack, not against a published release. The first real release should be tried on a Windows install, a portable exe and a Mac before it is widened.
- Cut-off replies (**Continue**) and the spend cap's refusal were checked against mock providers, not live API models. Approval cards from a live model, with their keys, reason box and **Show all**, were checked with cards made by a checkpoint restore and with page tests.
- The deb maintainer (`build.deb.maintainer` in `package.json`) is `[LICENSOR NAME] <theloved@muse.ai>`; the licensor name must be filled in before release. The author name in `package.json` (`literallyisyou`) sets the Windows company name, and `bugs.email` is the contact address the phone's Report sheet offers.
- In their read-only settings, Codex, Gemini and Muse Code can still read files on the machine and run commands that only read, so do not paste untrusted text into a council, relay, compare or pipeline run that includes them.
- Plenum cannot stop or time a subagent that runs inside Claude Code on its own; Esc stops the whole reply. Codex, Gemini and Muse Code agents are timed and stopped by Plenum, but Codex and Gemini report no tool steps headlessly, so only the time and idle limits apply to them (Muse Code is capped through its own step setting, at most 200).
- A council seat allowed to start agents can learn what is in the project through them, so the earlier sentence about untrusted text applies to those runs as well, and to every council that reads or works in the folder.
- Rewind does not cover a council message, as it does not cover /build. Files that Plenum's own tools write in a work round keep their checkpoints; files a CLI seat changes itself (Codex, for example) are only listed on the card.
- Passing the tool test shows that a model calls Plenum's tools correctly in a small sealed folder. It does not show that the model behaves safely; approvals, the deny list and plan mode are what protect a project.
- The deny list covers run_command and the Claude CLI, not commands that Codex, Gemini or Muse Code run on their own. Turn snapshots cover files any agent writes, but not files over 5 MB, ignored files, or folders over 20,000 files.
- Cursor's print transport cannot ask before it writes, and a long prompt is limited by the command line (about 7,000 characters through a .cmd shim on Windows): the newest message is kept, and a message too long to send is refused with a plain error.
- Grok Build and Cursor are read through the Agent Client Protocol (ACP), which is new in both. Their print transports are the fallback and cannot ask for approval. Headless Grok Build billing (subscription or API credits, when both exist) is not documented by xAI.
- Plenum reads a PDF's text only, not its pictures or layout. Gemini CLI image support rests on its @file syntax in non-interactive mode.
- Password fields. Windows asks UI Automation and refuses to type where it cannot tell. macOS and Linux check the programs that show their fields to the system (the accessibility API on macOS, AT-SPI on Linux), and those two checks have not been run on those systems yet. Where a check cannot tell, the model's own rule is the protection, so do a password step yourself: press Pause, type it, then Resume, or let the model hand the step over and use **Type it for me**.
- Browser typing. A page can move the keyboard focus after Plenum has checked a field and before the text goes in. Plenum looks at the focus again just before it types and keeps a listener in the page until the text is in: text is never typed into a password, one-time-code, 2FA, CVV or card field (the field is handed to you, and **Type it for me** types into that field; a field Plenum has no reference for, such as a password inside a shadow component or one the page added late, is handed over without one, so click it in the browser pane first, then press **Type it for me**), and when the page moves the focus to another field the typing stops with a message and the model takes a new snapshot. A page that cancels focus and input events before Plenum hears them can still win the last few milliseconds, and a page that always moves the focus (some pickers and comboboxes) needs a second step: the model types into the field that has the focus after the new snapshot.
- Screenshots of a whole display include every window on it, allowed or not. Choose one window when the task allows it. In one-window mode on Windows and macOS, parts of the window covered by another program show grey to the model.
- On Linux, one-window mode shows the window alone, so menus and dialogs that open as separate windows may not be visible to the model.
- Pausing when you type works on Windows. The macOS check has not been run on a Mac, and Linux cannot see the keyboard. Moving the mouse pauses on all three.
- On Linux Plenum cannot see the stacking order of windows, so a click or scroll is judged by the program in front only. On macOS, Secure Keyboard Entry in any program (Terminal has it in its menu) makes macOS report every field as secure, so Plenum refuses all typing until it is turned off; it says so once in the chat. Computer use on a Mac with displays of different scale factors has not been run on a Mac.
- Fable 5.2 and Fable 5.1 are untested for the computer toolset.
- In split view the right pane has no attachments, / commands, Council, Rewind, Regenerate, Send to, Build this or artifact buttons; Swap sides gives its thread the full message box. Notices raised by a right-pane run appear above the left message box, and a run of the right thread started in another window shows when it ends.
- If Plenum says it hit an unexpected problem, try again. The message names an id (E- and six characters); look for it in the file `server.log` in Plenum's data folder to see what went wrong. The log never holds keys.
- Businesses: sign-ins and the browser profile are shared by all your businesses; they are not kept apart yet. The Businesses pane
  says so.
- No channel sends for you yet (email, messages, posts). A lead prepares the text in `outbox/`, asks you, and after your yes the
  sending step is a tool call that shows its own card, or you send it yourself.
- There is no money ledger and no spending limit per business beyond the project's spend limit; a yes to a spend means you pay
  yourself.
- The Businesses pane sums up the record (the brief); it has no page that lists the record line by line. The file is
  `business-log/<id>.jsonl` in Plenum's data folder.
- Routines run only while Plenum runs; a time that passed while the PC was off is caught up within the routine's catch-up window, or
  skipped with a line on the record.
- A hub agent that the hub's helper starts works with the hub's tools only, for 10 minutes at most.
- Plenum writes a list of the programs it starts (`children.json` in its data folder; no prompt, key or environment is in it) and takes each line out when the program ends. Stop waits, for 2.5 seconds at most, until the program's whole process tree has ended. The clean-up at the next start, which would end programs that a crashed Plenum left running and clear their temp folders, is built and switched off: it runs only with the environment variable `PLENUM_SWEEP=1`, because ending a process by a recorded process id can hit another program when Windows reuses the id. So after a crash, or after Plenum is ended in Task Manager, a CLI that Plenum had started can keep running until you end it yourself.
- A failed relay hop cannot be retried alone; a failed council seat, a failed Quick compare column and a failed pipeline step can.
- Unsent text is kept in the browser's own storage on this computer; the queued follow-ups and the split view's own message box are not kept.
- Notifications, the Today card, Add a browser, the Android build and the sign-in repairs were tried with stand-ins and hidden windows only. Nothing was run on a real phone, a second computer or a real expired sign-in.
- Stop from a notification on a locked phone still waits for the phone's own unlock.
- Five wrong codes at the browser page end an Add a browser offer, including one a browser is already using. Press **New code**.

## Tests

The test scripts live outside this folder. They cover the security gate, projects and settings, streaming, file mentions, the Claude request shape and tool loop against a mock endpoint, path containment, approvals, the approve-all floor, the rules files and panel, build focus, the prompt wiring, the agent types and limits, the agent runner, read-only role delegation, the update outbox (including apply with backup), the Muse and Codex process handling, computer use (policy, run controller, log, the adapters for Claude, OpenAI and Gemini and the generic loop against fixtures, and the desktop backend's fake and geometry), and the smoke test. `npm run computer:smoke` (with PLENUM_SMOKE=1) checks capture and input against a throwaway window of its own.

## Extending Plenum

For builders. A feature is a file in the folder that Plenum reads for it, so it needs no edit to a central list. Each shape below is the one the code checks when it loads the file. Applied updates can add files to these folders too (see [Updates to Plenum](#updates-to-plenum)). `docs/EXTENDING.md` in the source folder is the longer guide, with the test each addition needs.

**Route modules** are `lib/routes/*.mjs`. Each exports `routes`. The server checks the token before a handler runs, and the handler answers the response itself. A handler receives `{ req, res, url, json, readBody, httpError, store, events, ... }`, and `events` is `lib/events.mjs`.

```js
export const routes = [
  { method: 'GET', path: '/api/example', handler: ({ res, json }) => json(res, 200, { ok: true }) },
];
```

**Model tools** are `lib/tools/NN-name.mjs`. Each exports `tools`, a list of entries with `name`, `description`, `input_schema` and `run(input, ctx, stamp)`, which returns `{ ok, summary, output, denied? }`. Optional fields: `plan`, `describe`, `command`, `stamped`, `scoped`, `refusal` and `when(ctx)`. A raw entry `{ raw, when }` is sent to the model exactly as given. `lib/tools.mjs` applies the approval, scope and deny-list rules, not the tool file.

```js
export const tools = [
  { name: 'example_tool', description: 'What it does.', input_schema: { type: 'object', properties: {} },
    run: async (input, ctx) => ({ ok: true, summary: 'Done', output: 'Text for the model.' }) },
];
```

**Prompt parts** are `lib/prompt-parts/NN-name.mjs`. Each exports `parts`, a list of `{ id, order, contexts, text }`. `contexts` is `'*'` or a list of names from `CONTEXTS` in `lib/prompt.mjs`. `text(ctx)` returns a string, or `null` for none. A part adds text only.

```js
export const parts = [
  { id: 'example', order: 60, contexts: ['chat'], text: async ctx => `Project folder: ${ctx.root}.` },
];
```

**Desktop handlers** are `desktop/handlers/name.cjs`. Each exports `{ name, messages, hooks }`. `messages[type](message, shell)` answers a message from the server: a reply with a `type` is sent as it is, and any other object is sent as `${type}-result` with the message's `id`. The hooks are `ready`, `windowCreated`, `serverStarted`, `serverExited`, `state` and `beforeQuit`. Server code reaches the shell through `lib/shell.mjs`: `shellRequest(type, payload, { timeoutMs })`, `onShellMessage(type, fn)` and `shellPost(message)`.

```js
module.exports = {
  name: 'example',
  messages: { 'example-ask': async (message, shell) => ({ answer: true }) },
  hooks: { state(shell, st) {} },
};
```

**Side panes** register in a `public/ext-*.js` file. `id` is 1 to 32 lower-case letters, digits or hyphens. `render(body, api)` draws into `body`, and `api` has `params`, `close()`, `setTitle()`, `badge(n)` and `isActive()`.

```js
MuseUI.pane.register({ id: 'example', title: 'Example', icon: 'chart', order: 50,
  render(body, api) {}, onShow() {}, onHide() {}, onClose() {} });
MuseUI.pane.open('example', { /* params for api.params */ });
```

`MuseUI.pane` also has `close(id)`, `toggle(id)`, `select(id)`, `show()`, `hide()`, `active()`, `isOpen(id)`, `list()` and `width(px)`.

**Settings sections** register with `MuseUI.settings.register`. Scope `'app'` puts the section in the Settings drawer, and `'project'` in the project settings drawer. `render(body, ctx)` gets `ctx.state`, `ctx.update(body)` (which saves a change), `ctx.refresh()` and `ctx.toast(message, kind)`.

```js
MuseUI.settings.register({ id: 'example', scope: 'app', title: 'Example', order: 40,
  render(body, ctx) {} });
```

**Notices and risk prompts** are `MuseUI.notice(id, { before, after })` and `await MuseUI.risk(id, { action })`, which resolves to true or false. Until a notices panel assigns the real ones, the stubs in `public/app.js` are used: `notice` draws nothing and `risk` resolves to true.

**Events** come from `GET /api/events`, one server-sent stream per window. Its types are `hello`, `state`, `run`, `approval`, `notice` and `agent`, and each has `type` and `at`. A route module publishes with `events.publish({ type, ... })`, `events.publishState(reason)` for the state, or `events.tag(runId, project, kind)` for a run's events. In the page:

```js
MuseUI.events.on('run', ev => {});                  // also off(type, fn) and the connected flag
window.addEventListener('plenum:event', e => {});   // every event, as e.detail
window.addEventListener('plenum:connection', e => {}); // e.detail.connected
```

**Page requests** always carry the token. `MuseUI.api(path, body)` returns the parsed JSON, sending a POST when a body is given, and throws the server's error message on failure. `MuseUI.request(path, { method, body, signal, headers })` returns the `Response`. `MuseUI.headers(extra)` returns the headers with `x-plenum-token`, for a request made any other way.

```js
const data = await MuseUI.api('/api/example', { name: 'x' });
const res = await MuseUI.request('/api/example', { method: 'GET' });
```

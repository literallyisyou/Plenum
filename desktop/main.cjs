// Muse Console desktop shell. Runs the local server as an Electron utility process and shows it in a window.
// The API keys live here, encrypted by the operating system (keyvault.cjs). The server is started with no key in its environment
// and gets the saved keys over its message channel; when the page saves a key, the server asks this process to store it.
// This file keeps the core: the single instance, the window, the server process, the tray and quit. What the server asks of the
// desktop (keys, the folder dialog, the alerts, and later the browser and the computer) is answered by the handler modules in
// desktop/handlers/, which desktop/handler-loader.cjs loads and routes (see that file for the shape). The over-the-air updater
// (desktop/handlers/app-update.cjs) adds a tray item and may take over the error box of a failed first start after an update.
// The app always opens and recovers by itself (DECISIONS item 91): the start check asks GET /api/health, a server that ends after it had
// answered is started again by the policy in desktop/server-supervisor.cjs while the window stays, a start that fails offers Try again,
// Open log and Quit, and the window loads its page again when its renderer is gone or its load failed. A hidden smoke mode (see SMOKE
// below) lets a test start the whole shell with nothing on screen.
// DECISIONS item 123 (shell hardening): the log is desktop/log.cjs (a time on every line, a size cap with rotation, a failed write cannot take
// the shell down), the registry's variables are read without making the start wait (desktop/registry-env.cjs), the four switches are kept in a
// cache (see settingsNow) instead of parsing the whole state file at every event, a second launch during a quit opens Plenum again once it has
// ended (relaunchAfterQuit), the question boxes can copy their details (desktop/error-box.cjs), and a quit leaves alone a hub launcher that is
// still starting the hub (hubLaunchers).
const { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, nativeTheme, powerSaveBlocker, safeStorage, shell: electronShell, utilityProcess } = require('electron');
const { execFile, execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createKeyVault, stripKeys } = require('./keyvault.cjs');
const { tooltipFor } = require('./alerts.cjs');
const { createSseParser, runEventType, runIdOf } = require('./sse.cjs');
const { loadHandlers, handleMessage, runHooks } = require('./handler-loader.cjs');
const { createSupervisor, smokeMode, RESTART_EXIT_CODE } = require('./server-supervisor.cjs');
const { createLog, makeRedactor } = require('./log.cjs');
const { createRegistryEnv } = require('./registry-env.cjs');
const { createChooser } = require('./error-box.cjs');
const { parseTable, doomedWithout } = require('./process-tree.cjs');
const { createQuietReader } = require('./notify-quiet.cjs');

// When the shell started, for the start lines in the log (the server answered after, the window loaded after).
const SHELL_STARTED = Date.now();
// The hidden smoke mode, for tests: with PLENUM_SMOKE=1, a PORT other than 4317 and a MUSE_CONSOLE_HOME all set, the window is invisible,
// no dialog is ever shown (the message goes to the log) and the app ends by itself once the page has loaded (exit code 0), or when the
// start fails (non-zero). With PLENUM_SMOKE_CRASH_SERVER=1 too, the first server is ended once after the page has loaded and the app ends
// 0 only after the server was started again and the page reconnected. Anything less than all three conditions is the normal app.
const SMOKE = smokeMode(process.env);
const BACKGROUND = process.argv.includes('--background');

// This launch's token. Every request to the server's /api/ must carry it (lib/auth.mjs). It is made once per launch of the app, so
// a server restart after an applied update keeps it and an open window keeps working. It goes to the server over the keys channel,
// to the app page through the preload bridge (preload.cjs) and to this process's own requests as a header. It is never on a
// command line, in an environment, in a URL or in the log.
const TOKEN = randomBytes(32).toString('hex');
const apiHeaders = () => ({ 'x-plenum-token': TOKEN });

const PORT = SMOKE ? SMOKE.port : 4317;
const APP_URL = `http://127.0.0.1:${PORT}/`;
// The server exits with this code when it wants a restart (after an applied update): RESTART_EXIT_CODE, from server-supervisor.cjs.
// Set once the server has been started again because it ended while an applied update was still unproven (see the exit handler in
// startServer). It is cleared when a start gets as far as answering, so one bad update costs one restart, not a loop.
let restartTried = false;
// The server is asked for its state this often while the events channel is down (while it is up, the server sends the state
// whenever it changes). A request that takes longer than the timeout is skipped.
const POLL_MS = 2_000;
const POLL_TIMEOUT_MS = 1_000;
// How long to wait before the events channel is opened again, by the number of failed tries in a row.
const EVENTS_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
// A window that does not respond for this long is asked about (onStillUnresponsive). After a renderer crash the page is loaded again by
// itself RELOADS_PER_WINDOW times in RELOAD_WINDOW_MS. A failed load of the app's page is tried LOAD_TRIES times before the person is asked.
const UNRESPONSIVE_MS = 10_000;
const RELOADS_PER_WINDOW = 2;
const RELOAD_WINDOW_MS = 60_000;
const LOAD_TRIES = 3;
// How long the port check waits for an answer before it counts the port as in use.
const PORT_PROBE_MS = 1_500;
const root = path.resolve(__dirname, '..');
// The page draws the title bar itself; Windows only overlays the minimise, maximise and close
// buttons. The height matches --bar-h and the colours match --bg in public/style.css.
const BAR_HEIGHT = 52;
const CHROME = {
  dark: { background: '#0a0a11', symbols: '#c9cce0' },
  light: { background: '#f6f6fb', symbols: '#2a2b3c' },
};
const windowButtons = look => ({ color: '#00000000', symbolColor: look.symbols, height: BAR_HEIGHT });
// A "#rrggbb" colour counts as dark when its perceived brightness is under half.
function isDark(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 < 0.5;
}

let win = null;
let tray = null;
let server = null;
let vault = null;
let quitting = false;
let logFile = '';
// The log (desktop/log.cjs). The user's name in a path and the launch token are hidden in everything it writes.
const redact = makeRedactor({
  user: (() => {
    try {
      return os.userInfo().username;
    } catch {
      return '';
    }
  })(),
  home: os.homedir(),
  secrets: () => [TOKEN],
});
const log = createLog({ fs, redact });
// The poll timer, and whether a poll is running now. The poll is the fallback while the events channel is down.
let pollTimer = null;
let polling = false;
// The number of approval cards the tray shows. The alerts handler sets it through shell.tray.count.
let trayCount = 0;
// The notice shown the first time the window is hidden to a Linux tray that may not be there (B-112). Kept, as the alerts are.
let trayNote = null;
let trayNoticeShown = false;
// The events channel (GET /api/events): the open request, whether it has delivered its first event, the failed tries in a row,
// and the timer for the next try.
let eventsReq = null;
let eventsUp = false;
let eventsFails = 0;
let eventsTimer = null;
// The desktop handlers (desktop/handlers/): their messages and hooks. Loaded once, in main(), before the window is made.
let handlers = { messages: new Map(), hooks: [], reported: new Set() };
// The handler modules that loaded, in file order ({ file, mod }). The startFailed hook is run from here, because it answers with a
// value and the loader's runHooks (desktop/handler-loader.cjs) ignores what a hook returns.
let handlerModules = [];
// The items handlers add to the tray menu, by name ({ label, click }): 'update' is the updater's (while an update is ready to install),
// 'phones' is the phones connected now. TRAY_ITEM_ORDER is the order they sit in, after the approval item and before the separator.
const trayItems = new Map();
const TRAY_ITEM_ORDER = ['update', 'phones'];
// How many phones the server reports as connected (its phones-indicator message). The tray shows them while there are some.
let phonesConnected = 0;
// The words of that tray item: 'Phones (n connected)', or 'Phones and browsers (n connected)' once a browser is among them (wave 5).
let phonesLabel = '';
// Set once a handler has taken over the error box for a failed start, so the 30-second wait and the server's exit cannot each show
// another box for the same failure.
let startFailureHandled = false;
// The restart policy (desktop/server-supervisor.cjs). everAnswered is whether a server has answered at least once in this app's life: before
// that an ended server is a failed start (the person chooses), after it the supervisor restarts the server by itself.
const supervisor = createSupervisor();
let everAnswered = false;
let restartTimer = null;
// How many times the server has answered (the first start and every restart), for the log and for the smoke mode.
let answers = 0;
// True while a recovery question (Try again, Open log, Quit) is open, so two causes never put two boxes up.
let recoveryOpen = false;
// The window's own recovery. pageReloads holds the times of the reloads made after the renderer was gone (two in a minute at most);
// loadFailures counts failed loads of the app's page in a row; pageLoadedOnce keeps the start line of the log to the first load.
const pageReloads = [];
let loadFailures = 0;
let loadRecovering = false;
let pageLoadedOnce = false;
let expectGone = false;
let unresponsiveTimer = null;
let windowOfferOpen = false;
let smokeDone = false;

// Set when a second launch comes while this copy is quitting (see onSecondInstance); will-quit then starts Plenum again, once. sessionEnding:
// Windows is ending the session, and nothing is started again then. mainStarted: main() has run, so a window may be made again.
let relaunchAfterQuit = false;
let sessionEnding = false;
let mainStarted = false;
// The hub launchers (pids) that the server said are running now. A quit does not end them (see stopServer).
const hubLaunchers = new Set();
const MAX_HUB_LAUNCHERS = 8;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch (for example from the shortcut) shows the window, even when it is hidden in the tray, and opens it again when
  // there is none. During a quit it asks this copy to start again once it has ended.
  app.on('second-instance', () => onSecondInstance());
  // macOS: a click on the Dock icon re-activates the app. The window may be hidden to the tray, so bring it back.
  // Windows and Linux never send this, so it changes nothing there.
  app.on('activate', () => showWindow());
  app.on('will-quit', () => startAgainAfterQuit());
  app.whenReady().then(main);
}

// A second launch. The person opened Plenum while this copy was still quitting (it waits up to SHUTDOWN_WAIT_MS for the server): the new
// copy found the lock taken and ended, so nothing would open. This copy remembers it and starts Plenum again after it has ended.
function onSecondInstance() {
  if (quitting) {
    relaunchAfterQuit = true;
    writeLog('a second launch came while Plenum was quitting; Plenum opens again once this copy has ended');
    return;
  }
  showWindow();
}

// will-quit: the server has been stopped (before-quit does that). Starts Plenum again, once, when a second launch asked for it during
// the quit. Never in smoke mode and never when Windows is ending the session. The lock is let go first, or the new copy would find it taken.
function startAgainAfterQuit() {
  if (!relaunchAfterQuit || sessionEnding || SMOKE) return;
  relaunchAfterQuit = false;
  try {
    app.releaseSingleInstanceLock?.();
    // The start with Windows keeps the window hidden; a person who opened Plenum wants to see it.
    app.relaunch({ args: process.argv.slice(1).filter(arg => arg !== '--background') });
  } catch (err) {
    writeLog(`Plenum could not be started again after the quit: ${String(err?.message ?? err).slice(0, 200)}`);
  }
}

function writeLog(line) {
  log.line(String(line));
}

// Calls the handlers' hooks with this name. The shell is the first argument of every hook.
function callHooks(name, ...args) {
  runHooks(handlers, name, [desktopShell, ...args], { log: writeLog });
}

// Calls every handler's event hook with one event of the events channel (see EVENT_RUN_TYPES below for which ones). The loader
// (desktop/handler-loader.cjs) does not route this hook, so the modules that loaded are asked here, in file order, as runStartFailed does.
// A hook that throws, or whose promise rejects, is logged and skipped; the others still run.
function callEventHooks(ev) {
  for (const { file, mod } of handlerModules) {
    const fn = mod.hooks?.event;
    if (typeof fn !== 'function') continue;
    const failed = err => writeLog(`hook event in ${file} failed: ${String(err?.message ?? err).replace(/[\r\n\t]+/g, ' ').slice(0, 300)}`);
    try {
      const out = fn(desktopShell, ev);
      if (out && typeof out.then === 'function') out.then(undefined, failed);
    } catch (err) {
      failed(err);
    }
  }
}

// The loader's `load`: it requires the module as the loader would, and remembers the ones that loaded (for runStartFailed below).
function loadHandlerModule(file) {
  const mod = require(file);
  if (mod && typeof mod === 'object') handlerModules.push({ file: path.basename(file), mod });
  return mod;
}

// Asks the handlers whether one of them deals with a failed start (the server exited with an error, or never answered). Every
// handler's startFailed hook runs, in file order, with { code, message }; a hook that throws is logged and skipped. The result is
// true when a hook returned true: that handler has shown its own box and quits the app itself, so the caller shows no box and does
// not quit. Once a start failure has been taken over, later calls answer true without asking again.
function runStartFailed(info) {
  if (startFailureHandled) return true;
  let taken = false;
  for (const { file, mod } of handlerModules) {
    const fn = mod.hooks?.startFailed;
    if (typeof fn !== 'function') continue;
    try {
      if (fn(desktopShell, info) === true) taken = true;
    } catch (err) {
      writeLog(`hook startFailed in ${file} failed: ${String(err?.message ?? err).replace(/[\r\n\t]+/g, ' ').slice(0, 300)}`);
    }
  }
  if (taken) startFailureHandled = true;
  return taken;
}

// The dialogs of this app. In smoke mode none is ever shown: each call is logged and answers as if the person had chosen the last
// button (Quit), cancelled, or closed the box.
function quietBox(name, args) {
  const options = [...args].reverse().find(a => a && typeof a === 'object' && !Array.isArray(a) && ('message' in a || 'buttons' in a || 'title' in a));
  writeLog(`smoke: ${name} was not shown: ${String(options?.message ?? options?.title ?? args.filter(a => typeof a === 'string').join(': ')).replace(/\s+/g, ' ').slice(0, 300)}`);
  const buttons = Array.isArray(options?.buttons) ? options.buttons : [];
  return { response: Number.isInteger(options?.cancelId) ? options.cancelId : Math.max(0, buttons.length - 1), checkboxChecked: false, canceled: true, filePaths: [], filePath: undefined };
}
const quietDialog = {
  showErrorBox: (...args) => void quietBox('an error box', args),
  showMessageBox: async (...args) => quietBox('a message box', args),
  showMessageBoxSync: (...args) => quietBox('a message box', args).response,
  showOpenDialog: async (...args) => quietBox('an open dialog', args),
  showSaveDialog: async (...args) => quietBox('a save dialog', args),
};
const dialogs = SMOKE ? quietDialog : dialog;

// What a handler module is given as its shell (desktop/handler-loader.cjs). It is this process's view for the handlers' own jobs:
// the key vault and the token are read through it, and windows, notifications and replies to the server go out through it.
// shell.log writes to the app's log; the handlers here never pass a key or the token to it.
const desktopShell = {
  app,
  dialog: dialogs,
  shell: electronShell,
  Notification,
  nativeImage,
  powerSaveBlocker,
  ipcMain,
  win: () => win,
  // A notification's click: the window comes to the front and, with a route ({ kind, id? }), the page opens that place (openInPage).
  showWindow: route => showWindow(route),
  tell: message => tell(server, message),
  get vault() {
    return vault;
  },
  token: TOKEN,
  port: PORT,
  get userData() {
    return app.getPath('userData');
  },
  get logFile() {
    return logFile;
  },
  log: writeLog,
  settings: () => alertSettings(),
  // Whether the owner's quiet hours hold now (desktop/notify-quiet.cjs, from GET /api/notify), for the run alerts (handlers/alerts.cjs).
  quietNow: () => quietHours.quietNow(),
  stateFile: () => stateFile(),
  tray: {
    count: n => {
      trayCount = n;
      refreshTray();
    },
    // A handler's item: { label, click } to show it, null to take it away. The menu is rebuilt when it changes (see setTrayItem).
    setItem: (name, item) => setTrayItem(name, item),
    // The updater's item (app-update.cjs): the same as setItem('update', item).
    setUpdateItem: item => setTrayItem('update', item),
  },
  serverPid: () => server?.pid ?? null,
};

function openLog() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'server.log');
  log.open(logFile);
  log.raw(`\n--- started ${new Date().toISOString()} ---\n`);
}

// The environment variables of the registry (desktop/registry-env.cjs): an app started from the Start menu can miss PATH or API key
// changes made after Explorer started (for example by the Muse Code installer or setx), so the server gets the current values. Both keys
// are read at once with a time limit and the answer never fails; it is asked for when the app starts (main), so only the server's fork waits.
const registry = createRegistryEnv({ execFile });

// On Windows the server gets the registry values and this process's own, merged.
function windowsEnv(registryVars) {
  const env = { ...(registryVars ?? {}) };
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === 'path') continue;
    env[key] = value;
  }
  env.Path = [env.Path, process.env.Path ?? process.env.PATH].filter(Boolean).join(';');
  // npm's global folder holds the Codex CLI shim; it is not always on the registry PATH.
  const npmBin = path.join(process.env.APPDATA || '', 'npm');
  if (process.env.APPDATA && fs.existsSync(npmBin) && !env.Path.toLowerCase().includes(npmBin.toLowerCase())) {
    env.Path = `${env.Path};${npmBin}`;
  }
  return env;
}

// The environment the server starts with. It is built here and carries no API key: the saved keys reach the server over its
// channel instead. A key that is still in the environment (for example one an older version saved to the Windows user
// environment) is left out, and the Accounts panel offers to import it.
// registryVars: what registry.get() gave (bringUp waits for it before the fork); none means this process's environment alone.
function serverEnv(registryVars) {
  // Smoke mode (a test) gives the server this process's environment as it is: the registry's PATH and variables are the real computer's.
  const env = stripKeys(process.platform === 'win32' && !SMOKE ? windowsEnv(registryVars) : { ...process.env });
  // A utility process is started by Electron itself and must not be told to run as plain Node.
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[name];
  }
  // The second look for a CLI that was installed while Plenum runs (lib/platform/winpath.mjs) is on only for the server this app
  // starts. Never in smoke mode: a test must only ever see the PATH it was given. A value that is already set (0 turns it off) stays.
  if (process.platform === 'win32' && !SMOKE && !Object.keys(env).some(name => name.toUpperCase() === 'PLENUM_PATH_REFRESH')) env.PLENUM_PATH_REFRESH = '1';
  return env;
}

function startServer(registryVars) {
  // server-entry.cjs loads server.mjs, which is an ES module.
  const child = utilityProcess.fork(path.join(__dirname, 'server-entry.cjs'), [], {
    cwd: root,
    env: serverEnv(registryVars),
    serviceName: 'Plenum server',
    // Its output goes to the log. A utility process has no stdin; it ends with the app.
    stdio: 'pipe',
  });
  server = child;
  // answered: this server has answered a start check. exited: its process has ended (the start check stops waiting for it).
  child.answered = false;
  child.exited = false;
  // What the server prints goes to the log as it comes; the end of its stderr is kept for the line that says why it ended.
  child.stderrTail = '';
  log.attach(child.stdout);
  log.attach(child.stderr, text => {
    child.stderrTail = (child.stderrTail + text).slice(-600);
  });
  child.on('message', message => {
    if (message?.type === 'shutdown-done') {
      shutdownDone?.();
      return;
    }
    // The server says it listens, right after its listen() (server.mjs): the start check ends at once (see bringUp). A port other than
    // this app's is not this start's answer, and the poll goes on.
    if (message?.type === 'listening') {
      if (child === server && Number(message.port) === PORT) {
        child.listening = true;
        child.onListening?.();
      }
      return;
    }
    onServerMessage(child, message).catch(() => writeLog('a message from the server could not be handled'));
  });
  child.on('exit', code => {
    child.exited = true;
    // One line for every end of a server: what kind it was, the code, and the last thing it printed on stderr (the cause, when it has one).
    const kind = quitting ? 'during a quit' : code === RESTART_EXIT_CODE ? 'asked for a restart' : child !== server ? 'an older server' : child.answered ? 'after it had answered' : 'before it answered';
    const why = String(child.stderrTail ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ').replace(/\s+/g, ' ').slice(0, 300);
    writeLog(`the server process ended ${kind} (exit code ${code})${why ? `; it last printed: ${why}` : ''}`);
    if (child !== server) return;
    server = null;
    // A launcher of the hub that the server told us about (hubLaunchers) belongs to this server: it is not spared at the next stop.
    hubLaunchers.clear();
    // The server's phones are gone with it, so the tray stops saying so.
    setPhonesConnected([]);
    callHooks('serverExited', code);
    if (quitting) return;
    if (code === RESTART_EXIT_CODE) {
      setTimeout(restartAndReload, 300);
      return;
    }
    // B-3: an applied update that has not started cleanly yet leaves overlay/pending.json in the state folder (lib/updates.mjs). If
    // the server ends while it is there, start it once more: the bootstrap (lib/overlay/register.cjs) then goes back to the
    // generation before. A second failure in a row shows the box below as it always did.
    if (!restartTried && fs.existsSync(path.join(stateDir(), 'overlay', 'pending.json'))) {
      restartTried = true;
      setTimeout(restartAndReload, 300);
      return;
    }
    onServerEnded(child, code);
  });
  callHooks('serverStarted', child);
  return child;
}

// The server ended on its own (not a quit, not the restart code, not the rollback above). Before any server has answered this is a
// failed start: the person chooses. After that the supervisor decides (desktop/server-supervisor.cjs): start it again by itself, keeping
// the window, until the restarts are used up (DECISIONS item 91). A handler may deal with the failure itself first (the updater does when
// this was the first start after an update); then there is no restart and no box here.
function onServerEnded(child, code) {
  const info = { code, message: `The local server exited with code ${code}.` };
  if (!everAnswered) {
    void startFailed(child, info);
    return;
  }
  // A server that was given up on (it did not answer in time and the box is open) and then ends is not started again behind the box.
  if (child.failureHandled) return;
  if (runStartFailed(info)) return;
  const verdict = supervisor.onExit({ code, quitting, answered: everAnswered });
  if (verdict.restart) {
    writeLog(`the server ended (code ${code}); starting it again in ${verdict.afterMs} ms (restart ${verdict.attempt} of ${supervisor.limit})`);
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      // The page keeps its window and reconnects by itself (public/ext-connection.js): it is not loaded again.
      void bringUp({ loadPage: false });
    }, verdict.afterMs);
    return;
  }
  writeLog(`the server ended (code ${code}); ${verdict.reason === 'used-up' ? 'the restarts are used up' : `it is not started again (${verdict.reason})`}`);
  if (verdict.reason === 'used-up') void keepsStopping(code);
}

// The server has stopped as often as the policy allows. The same three choices as a failed start.
async function keepsStopping(code) {
  const choice = await offerRecovery("Plenum's server keeps stopping.", `It was started again ${supervisor.limit} times in 5 minutes and stopped each time (last exit code ${code}). Try again starts it once more. The log says why it stopped.`);
  if (choice === 'busy') return;
  if (choice === 'quit') {
    quitApp(true);
    return;
  }
  supervisor.reset();
  await bringUp({ loadPage: false });
}

// A start that did not work: the server ended before it answered, or the wait for it ran out. One box with Try again, Open log and Quit
// instead of an error box and a quit. A handler may take it over first (runStartFailed). Each server is dealt with once, however many
// things notice that it failed. Try again ends a server that is still there, then starts and waits again.
async function startFailed(child, info) {
  if (child.failureHandled) return;
  child.failureHandled = true;
  if (runStartFailed(info)) return;
  const choice = await offerRecovery('Plenum could not start.', info.message);
  if (choice === 'busy') return;
  if (choice === 'quit') {
    quitApp(true);
    return;
  }
  supervisor.reset();
  if (child === server) stopServer();
  await bringUp({ loadPage: true });
}

// The recovery question: Try again, Open log and Quit. Open log shows the log file in the file manager and asks again. Resolves 'retry',
// 'quit' or 'busy' (another question of this kind is already open). In smoke mode nothing is shown and the answer is 'quit'.
async function offerRecovery(message, detail) {
  if (recoveryOpen) return 'busy';
  recoveryOpen = true;
  try {
    for (;;) {
      const picked = await choose({ message, detail: `${detail}\n\nLog: ${logFile}`, buttons: ['Try again', 'Open log', 'Quit'], defaultId: 0, cancelId: 2 });
      if (picked === 1) {
        try {
          electronShell.showItemInFolder?.(logFile);
        } catch {
          // The file manager could not open; the log path is in the box.
        }
        continue;
      }
      return picked === 0 ? 'retry' : 'quit';
    }
  } finally {
    recoveryOpen = false;
  }
}

// One message box: resolves with the index of the button chosen. It has a "Copy details" button before the last one (desktop/error-box.cjs).
// A box that cannot be shown falls back to the plain error box and counts as the last button, which is Quit in every box of this app.
const choose = createChooser({ dialogs: () => dialogs, clipboard, log: writeLog, describe: () => buildLine(), tail: () => log.tail(), redact });

// Ends the app. A normal quit goes through before-quit (the server is stopped cleanly). In smoke mode the exit code says whether the run
// worked: failed is true for every quit that follows a problem.
function quitApp(failed) {
  if (SMOKE) void smokeExit(failed ? 1 : 0, failed ? 'the app quit after a failure' : 'quit');
  else app.quit();
}

// Sends the server a message, if it is still the server this reply was for.
function tell(child, message) {
  if (child !== server) return;
  try {
    child.postMessage(message);
  } catch {
    // The server went away while the reply was being made.
  }
}

// The server's messages go to the handler modules (desktop/handlers/). A message from a server that is no longer the current one
// is ignored, and a message with no string type is not a request.
async function onServerMessage(child, message) {
  if (child !== server || !message || typeof message !== 'object' || typeof message.type !== 'string') return;
  // The phones connected now also show in the tray. The phones handler (desktop/handlers/phones.cjs) gets the same message for its notice.
  if (message.type === 'phones-indicator') setPhonesConnected(message.connected, message.devices);
  // The hub's launcher (lib/hub-starter.mjs, the command `up`) is running or has ended: { type: 'hub-launcher', pid, state: 'started' | 'ended' }.
  // Only the shell's own bookkeeping, no handler is asked.
  if (message.type === 'hub-launcher') {
    noteHubLauncher(message);
    return;
  }
  await handleMessage(handlers, message, desktopShell, { post: reply => tell(child, reply), log: writeLog });
}

// A clean stop first (B-29): the server stops its runs, stores their replies and saves the state, then answers shutdown-done (server.mjs).
// Resolves when it answered, or after SHUTDOWN_WAIT_MS when it did not; stopServer below then ends the process either way.
const SHUTDOWN_WAIT_MS = 4000;
let shutdownDone = null;
// Whether the server answered the last shutdown message (stopServer reads it).
let serverAnswered = false;
function askServerToStop() {
  const child = server;
  if (!child) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(false), SHUTDOWN_WAIT_MS);
    function finish(answered) {
      clearTimeout(timer);
      shutdownDone = null;
      serverAnswered = answered === true;
      resolve();
    }
    shutdownDone = () => finish(true);
    try {
      child.postMessage({ type: 'shutdown' });
    } catch {
      finish(false);
    }
  });
}

// The pids of the server's direct children, from ps. On macOS and Linux an agent run is started detached (lib/proc.mjs), so it leads its
// own process group, and the server's own signal does not reach it. A listing that fails gives none: the server is ended as before.
function serverChildPids(pid) {
  let out = '';
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map(line => line.trim().split(/\s+/).map(Number))
    .filter(([childPid, parentPid]) => childPid > 1 && parentPid === pid)
    .map(([childPid]) => childPid);
}

// The hub launcher's pid, as the server reports it. A pid that is not a plain process number is ignored; the list is short.
function noteHubLauncher(message) {
  const pid = message?.pid;
  if (!Number.isInteger(pid) || pid < 5 || pid > 4_194_304) return;
  if (message.state === 'started') {
    if (hubLaunchers.size < MAX_HUB_LAUNCHERS) hubLaunchers.add(pid);
  } else if (message.state === 'ended') hubLaunchers.delete(pid);
}

// Windows: ends the server and what it started, except a hub launcher that is still starting the hub and what that started. The table of
// processes comes from one hidden PowerShell call (wmic is gone from Windows 11). Returns true when it did that; false when the table could
// not be read, and the caller ends the whole tree as before (a run left behind is worse than a launcher ended).
function endServerTreeSparing(serverPid, spared) {
  let table = '';
  try {
    table = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }"], { encoding: 'utf8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return false;
  }
  const doomed = doomedWithout(parseTable(table), serverPid, spared);
  if (!doomed || !doomed.includes(serverPid)) return false;
  try {
    execFileSync('taskkill', ['/f', ...doomed.flatMap(pid => ['/pid', String(pid)])], { windowsHide: true, stdio: 'ignore' });
  } catch {
    // Some of them had ended already; taskkill still ended the others.
  }
  writeLog(`a quit left the hub's launcher running (pid ${spared.join(', ')}); the server and its other processes were ended`);
  return true;
}

function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  setPhonesConnected([]);
  // B-109: on macOS and Linux the agents' groups get SIGTERM first, so a server that cannot read its shutdown message does not leave them
  // running. A group that is already gone (ESRCH) is not an error, and a child that never led a group is simply skipped.
  // Only when the server did not answer shutdown: a server that answered has already stopped its runs through killTree, and a detached
  // child meant to outlive the app (the sign-in terminal, lib/platform/terminal.mjs) is left alone.
  if (process.platform !== 'win32' && !serverAnswered) {
    for (const childPid of serverChildPids(child.pid)) {
      try {
        process.kill(-childPid, 'SIGTERM');
      } catch {
        // The group has already ended.
      }
    }
  }
  // A hub launcher that is still starting the hub is left running: a quit must not end what `up` is doing (DECISIONS item 118).
  if (process.platform === 'win32' && hubLaunchers.size > 0 && endServerTreeSparing(child.pid, [...hubLaunchers])) return;
  try {
    // taskkill /t also ends anything the server started (for example a run_command process).
    execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    child.kill();
  }
}

// Whether something already answers on the app's port before this app starts its server. Only a refused connection means the
// port is free: any answer, or silence for PORT_PROBE_MS, counts as in use. The request carries no token, so a foreign listener
// is never given this launch's token.
function portInUse() {
  return new Promise(resolve => {
    let settled = false;
    const done = inUse => {
      if (settled) return;
      settled = true;
      resolve(inUse);
    };
    const req = http.get(`${APP_URL}api/status`, res => {
      res.resume();
      done(true);
      req.destroy();
    });
    req.on('error', err => done(err?.code !== 'ECONNREFUSED'));
    req.setTimeout(PORT_PROBE_MS, () => {
      req.destroy();
      done(true);
    });
  });
}

// Polls the server until it answers. Gives up after 30 seconds. It asks GET /api/health, which does no work and answers at once; a server
// from before that route answers 404 there, and is asked /api/status instead (DECISIONS item 91). Each try may take STATUS_TRY_MS:
// /api/status checks every CLI and can take a few seconds on a busy computer. On 12 Nov 2026 a limit of 1.5 s a try kept Plenum from
// starting (DECISIONS item 89). A try ends once, whichever comes first of its answer, an error or its time limit. Destroying a request
// also fires its error event, and before this each timed-out try started two retries, so a slow server got twice as many checks every
// round. There is one try at a time. abort, when given, is asked before every try: true stops the wait (the server has ended).
// heard, when given, is a promise that resolves when the server says it listens (its 'listening' message, wave 4): the wait ends at once
// then, without the next poll, and no poll starts after it. The poll stays as the way in for a server that does not send it.
const STATUS_TRY_MS = 10_000;
function waitForServer(timeoutMs = 30_000, abort = null, heard = null) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let checkPath = '/api/health';
    let done = false;
    const succeed = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const fail = message => {
      if (done) return;
      done = true;
      reject(new Error(message));
    };
    if (heard && typeof heard.then === 'function') heard.then(succeed, () => {});
    const stopped = () => typeof abort === 'function' && abort();
    const retry = () => {
      if (done) return;
      if (stopped()) fail('The local server stopped before it answered.');
      else if (Date.now() > deadline) fail('The local server did not start in time.');
      else setTimeout(tryOnce, 300);
    };
    const tryOnce = () => {
      if (done) return;
      if (stopped()) {
        fail('The local server stopped before it answered.');
        return;
      }
      let ended = false;
      const end = outcome => {
        if (ended) return;
        ended = true;
        if (outcome === 'ok') succeed();
        else if (outcome === 'older' && Date.now() <= deadline) tryOnce();
        else retry();
      };
      const req = http.get({ host: '127.0.0.1', port: PORT, path: checkPath, headers: apiHeaders() }, res => {
        res.resume();
        if (res.statusCode === 200) end('ok');
        else if (res.statusCode === 404 && checkPath === '/api/health') {
          checkPath = '/api/status';
          end('older');
        } else end('no');
      });
      req.on('error', () => end('no'));
      req.setTimeout(STATUS_TRY_MS, () => {
        req.destroy();
        end('no');
      });
    };
    tryOnce();
  });
}

// Starts the server and waits for its first answer; then the page is loaded (loadPage) and the events channel opens. The first start, the
// restart after an update (code 75) and a restart by the supervisor all come through here. A wait that ends because the server ended is
// left to onServerEnded; one that runs out of time is a failed start (startFailed).
async function bringUp({ loadPage }) {
  if (quitting) return;
  // A restart does not send this launch's token to whatever may have taken the port since the last server ended (the first start checks
  // the port before the shell starts anything, portInUse). A busy port is a failed start with the same three choices.
  if (answers > 0 && (await portInUse())) {
    if (quitting) return;
    void startFailed({}, { code: null, message: "Another program is using Plenum's port, so the server could not be started again." });
    return;
  }
  // The only thing the fork waits for: the registry's variables (read since the app started, at most 1.5 s; none in smoke mode).
  const registryVars = process.platform === 'win32' && !SMOKE ? (await registry.get()).vars : undefined;
  if (quitting) return;
  const began = Date.now();
  const child = startServer(registryVars);
  // The server's 'listening' message ends the wait at once (it comes right after listen); the poll of waitForServer is the fallback.
  const heard = new Promise(resolve => {
    child.onListening = resolve;
    if (child.listening) resolve();
  });
  try {
    await waitForServer(30_000, () => child.exited || child !== server || quitting, heard);
  } catch (err) {
    if (child.exited || child !== server || quitting) return;
    void startFailed(child, { code: null, message: err.message });
    return;
  }
  child.answered = true;
  everAnswered = true;
  restartTried = false;
  answers += 1;
  writeLog(answers === 1
    ? `start: the server answered ${Date.now() - began} ms after it was started (${Date.now() - SHELL_STARTED} ms after the shell started)`
    : `the server answered again ${Date.now() - began} ms after it was started`);
  subscribeEvents();
  if (loadPage) loadApp();
}

async function restartAndReload() {
  await bringUp({ loadPage: true });
}

// Loads the app's page into the window. A load that fails is dealt with by onLoadFailed (did-fail-load), so the promise is not.
function loadApp() {
  if (!win) return;
  try {
    win.loadURL(APP_URL)?.catch?.(() => {});
  } catch {
    // The window is gone.
  }
}

function createWindow() {
  // Until the page loads, follow Windows.
  const startLook = nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light;
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    // Narrow enough to snap beside another window; below 860 px the sidebar folds into a menu (public/ext-sidebar.js).
    minWidth: 480,
    minHeight: 480,
    title: 'Plenum',
    // Window and taskbar icon (the installed .exe gets its icon from build/icon.ico at packaging time).
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: startLook.background,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: windowButtons(startLook),
    show: false,
    // Smoke mode: never shown, no taskbar button, never takes the focus (opacity 0 as well, in case a platform shows it anyway).
    ...(SMOKE ? { opacity: 0, skipTaskbar: true, focusable: false } : {}),
    // preload.cjs gives the page its token (window.plenumShell.token). spellcheck is off because on Linux Electron downloads
    // Hunspell dictionaries from a Google-hosted server when it is on, and the Privacy Notice says Plenum makes no such request.
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs'), spellcheck: false, ...(SMOKE ? { backgroundThrottling: false } : {}) },
  });
  win.once('ready-to-show', () => {
    if (SMOKE) return;
    // Started with Windows (--background): stay in the tray until the person opens Plenum; without a tray, show the window.
    if (BACKGROUND && ensureTray()) return;
    win.show();
  });
  // The page publishes its background as its theme colour. The window buttons follow it, so they
  // stay readable when Windows changes theme or the Theme button overrides it. Electron has the overlay on Windows and Linux only
  // (B-106): on macOS the window keeps its own buttons, so the call is skipped there and the background still follows the theme.
  win.webContents.on('did-change-theme-color', (_event, color) => {
    if (!win || !/^#[0-9a-f]{6}$/i.test(color ?? '')) return;
    win.setTitleBarOverlay?.(windowButtons(isDark(color) ? CHROME.dark : CHROME.light));
    win.setBackgroundColor(color);
  });
  // Links that open a new window go to the browser; the app itself stays in this window. Plain http links go too (B-113: a model's
  // http://localhost:3000 must open); the page says once that such a link is not encrypted. Every other scheme is denied.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) electronShell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_URL)) event.preventDefault();
  });
  // With "trayOnClose" on, closing the window hides it to the tray and the server keeps running.
  // A quit (the tray's Quit, or app.quit from anywhere) is never blocked.
  win.on('close', event => {
    // The cache of the switches is looked at again for the next time (a switch changed in the last second is not in it yet).
    noteSettingsMayHaveChanged();
    if (quitting || !trayOnClose()) return;
    if (!ensureTray()) return;
    event.preventDefault();
    win.hide();
    // B-112: a Linux desktop with no tray host draws no tray icon and reports no error, so the window would stay hidden with no
    // way back on screen. Say where it went, once per launch. The notice is kept in a variable, so a click still reaches it.
    if (process.platform === 'linux' && !trayNoticeShown && Notification.isSupported()) {
      trayNoticeShown = true;
      trayNote = new Notification({ title: 'Plenum is still running', body: 'Open Plenum again, or use its tray icon, to show the window.' });
      trayNote.on('click', () => showWindow());
      trayNote.show();
    }
  });
  // Windows is ending the session, which cannot be stopped, so the window must not hide to the tray now.
  win.on('session-end', () => {
    quitting = true;
    sessionEnding = true;
  });
  win.on('closed', () => {
    clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
    win = null;
  });
  watchWindow();
  win.loadFile(path.join(__dirname, 'splash.html'));
  callHooks('windowCreated', win);
}

// The window's own recovery (DECISIONS item 91): its renderer process gone, a window that stops responding, and a load of the app's page
// that fails. Each one loads the page again by itself where that is safe, and asks the person only when it keeps happening.
function watchWindow() {
  const contents = win.webContents;
  contents.on('did-finish-load', () => {
    const url = typeof contents.getURL === 'function' ? contents.getURL() : '';
    if (!String(url).startsWith(APP_URL)) return;
    loadFailures = 0;
    // A notification was clicked while the page was not there yet: the place it names is opened now.
    if (pendingOpen) openInPage(pendingOpen);
    if (pageLoadedOnce) return;
    pageLoadedOnce = true;
    writeLog(`start: the window finished loading ${Date.now() - SHELL_STARTED} ms after the shell started`);
    if (SMOKE) smokeLoaded();
  });
  // Smoke mode: an error the page prints goes to the log, so a run that fails says why.
  if (SMOKE) contents.on('console-message', (_e, level, message) => { if (level >= 3) writeLog(`smoke: page error: ${String(message).slice(0, 200)}`); });
  contents.on('render-process-gone', (_event, details) => onRendererGone(details));
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 is a load that was stopped on purpose (a newer load replaced it).
    if (isMainFrame === false || code === -3 || !String(url ?? '').startsWith(APP_URL)) return;
    void onLoadFailed(code, description);
  });
  win.on('unresponsive', () => {
    clearTimeout(unresponsiveTimer);
    unresponsiveTimer = setTimeout(() => void onStillUnresponsive(), UNRESPONSIVE_MS);
  });
  win.on('responsive', () => {
    clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
  });
}

// The renderer process ended (a crash, the system ended it, it ran out of memory). The page is loaded again by itself, twice in a minute
// at most; after that the person is asked, so a page that crashes at once does not loop.
function onRendererGone(details) {
  const reason = String(details?.reason ?? 'unknown');
  writeLog(`the window's renderer process is gone (${reason}, exit code ${details?.exitCode ?? 'unknown'})`);
  if (quitting || reason === 'clean-exit') return;
  if (expectGone) {
    expectGone = false;
    return;
  }
  const now = Date.now();
  while (pageReloads.length && now - pageReloads[0] >= RELOAD_WINDOW_MS) pageReloads.shift();
  if (pageReloads.length < RELOADS_PER_WINDOW) {
    pageReloads.push(now);
    writeLog('loading the page again');
    loadApp();
    return;
  }
  void windowOffer("Plenum's window stopped working.", `It stopped ${RELOADS_PER_WINDOW + 1} times in a minute (${reason}). Reload loads the page again. Your chats are saved.`, ['Reload', 'Quit'], () => {
    pageReloads.length = 0;
    loadApp();
  });
}

// The window has not answered for UNRESPONSIVE_MS: Wait gives it more time, Reload ends its renderer and loads the page again.
async function onStillUnresponsive() {
  unresponsiveTimer = null;
  if (!win || quitting) return;
  writeLog('the window is not responding');
  await windowOffer("Plenum's window is not responding.", 'Wait gives it more time. Reload loads the page again; a message you typed and did not send may be lost.', ['Wait', 'Reload', 'Quit'], index => {
    if (index === 0) {
      // Still stuck after the wait: ask again in another UNRESPONSIVE_MS. The 'responsive' event cancels this.
      unresponsiveTimer = setTimeout(() => void onStillUnresponsive(), UNRESPONSIVE_MS);
      return;
    }
    expectGone = true;
    try {
      win?.webContents.forcefullyCrashRenderer?.();
    } catch {
      expectGone = false;
    }
    loadApp();
  });
}

// One question about the window with the given buttons; the last one is Quit. onChoice runs for any other button (with its index).
async function windowOffer(message, detail, buttons, onChoice) {
  if (windowOfferOpen) return;
  windowOfferOpen = true;
  try {
    const picked = await choose({ message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
    if (picked === buttons.length - 1) quitApp(true);
    else onChoice(picked);
  } finally {
    windowOfferOpen = false;
  }
}

// Loading the app's own page failed (the server was not there yet, or went away). The server is checked, then the page is loaded again;
// after LOAD_TRIES failures in a row the person is asked.
async function onLoadFailed(code, description) {
  writeLog(`the page could not be loaded (${String(description ?? '').slice(0, 80)} ${code})`);
  if (loadRecovering || quitting) return;
  loadRecovering = true;
  try {
    if (loadFailures >= LOAD_TRIES) {
      const choice = await offerRecovery('Plenum could not open its window.', 'The page did not load.');
      if (choice === 'quit') quitApp(true);
      else if (choice === 'retry') {
        loadFailures = 0;
        loadApp();
      }
      return;
    }
    loadFailures += 1;
    try {
      await waitForServer(10_000, () => quitting);
    } catch {
      // The server is not answering; the supervisor or the start check deals with that. The page is tried again below either way.
    }
    if (!quitting) loadApp();
  } finally {
    loadRecovering = false;
  }
}

// The state folder the server uses (lib/store.mjs HOME): the app state file, and the overlay of applied updates.
function stateDir() {
  return process.env.MUSE_CONSOLE_HOME || path.join(os.homedir(), '.muse-console');
}

// The app state file. lib/store.mjs writes it in the same folder, so the shell and the server share the settings.
function stateFile() {
  return path.join(stateDir(), 'state.json');
}

// The four switches ("trayOnClose", "finishedAlerts", "keepAwake", "approvalAlerts") are kept here. Before, each state event and each
// window close parsed the whole state file (4.8 MB on the owner's PC, and it changes all through a run). Now the file is read once, lazily,
// at the first question (so a window closed early still honours trayOnClose), and after that the server's own answer is used: GET
// /api/desktop-settings (lib/routes/desktop-settings.mjs), asked once for a burst of state events. A switch the page changes is saved
// by the server, which sends a state event, so the cache is up to date a moment later. Defaults: the first three on, tray off; only an
// explicit false turns one of the three off and only an explicit true turns the tray on.
const SETTINGS_DEFAULTS = { finishedAlerts: true, keepAwake: true, approvalAlerts: true, trayOnClose: false };
const SETTINGS_DEBOUNCE_MS = 250;
const SETTINGS_MIN_GAP_MS = 1_000;
const SETTINGS_TRY_MS = 1_500;
let settingsCache = null;
let settingsFetchedAt = 0;
let settingsTimer = null;
let settingsFetching = false;
let settingsAgain = false;

function settingsFrom(st) {
  const o = st && typeof st === 'object' ? st : {};
  return { finishedAlerts: o.finishedAlerts !== false, keepAwake: o.keepAwake !== false, approvalAlerts: o.approvalAlerts !== false, trayOnClose: o.trayOnClose === true };
}

// The switches now: from the cache, read from the state file once when it is first needed. A missing or unreadable file gives the defaults.
function settingsNow() {
  if (!settingsCache) {
    try {
      settingsCache = settingsFrom(JSON.parse(fs.readFileSync(stateFile(), 'utf8')));
    } catch {
      settingsCache = { ...SETTINGS_DEFAULTS };
    }
  }
  return settingsCache;
}

function trayOnClose() {
  return settingsNow().trayOnClose;
}

function alertSettings() {
  const { finishedAlerts, keepAwake, approvalAlerts } = settingsNow();
  return { finishedAlerts, keepAwake, approvalAlerts };
}

// A state event (or a window close) happened: the switches are asked of the server once, after a short wait, however many events follow,
// and at most once a second. A request still running makes the next one wait for it. Nothing runs during a quit.
function noteSettingsMayHaveChanged() {
  if (quitting) return;
  if (settingsFetching) {
    settingsAgain = true;
    return;
  }
  if (settingsTimer) return;
  const wait = Math.max(SETTINGS_DEBOUNCE_MS, settingsFetchedAt + SETTINGS_MIN_GAP_MS - Date.now());
  settingsTimer = setTimeout(() => {
    settingsTimer = null;
    void fetchSettings();
  }, wait);
  settingsTimer.unref?.();
}

// Asks the server for the four switches. An answer that is not four booleans, an error and a slow server change nothing.
function fetchSettings() {
  settingsFetching = true;
  return new Promise(resolve => {
    let finished = false;
    let guard = null;
    const finish = answer => {
      if (finished) return;
      finished = true;
      clearTimeout(guard);
      settingsFetching = false;
      settingsFetchedAt = Date.now();
      if (answer && typeof answer === 'object') {
        const next = { ...settingsNow() };
        for (const key of Object.keys(SETTINGS_DEFAULTS)) if (typeof answer[key] === 'boolean') next[key] = answer[key];
        settingsCache = next;
      }
      if (settingsAgain) {
        settingsAgain = false;
        noteSettingsMayHaveChanged();
      }
      resolve();
    };
    guard = setTimeout(() => finish(null), SETTINGS_TRY_MS + 500);
    guard.unref?.();
    try {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/desktop-settings', headers: apiHeaders() }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          if (body.length < 4096) body += chunk;
        });
        res.on('end', () => {
          try {
            finish(res.statusCode === 200 ? JSON.parse(body) : null);
          } catch {
            finish(null);
          }
        });
        res.on('error', () => finish(null));
      });
      req.setTimeout(SETTINGS_TRY_MS, () => {
        req.destroy();
        finish(null);
      });
      req.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

// Asks the server for its state. Resolves null when it does not answer in time, so a slow server changes nothing.
function fetchState() {
  return fetchJson('/api/state');
}

// The owner's quiet hours, read from the notification hub's settings (wave 5 integration). Read again on every new events channel and
// when the last reading is five minutes old; until a read worked, nothing is quiet.
const quietHours = createQuietReader({ fetchJson: apiPath => fetchJson(apiPath) });

// GET of one of the server's own JSON paths (with the app's token). Resolves null when it does not answer in time, is not 200 or not JSON.
function fetchJson(apiPath) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: apiPath, headers: apiHeaders() }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(POLL_TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

// Takes the server's state (from an event, or from the poll below) and hands it to the state hooks (the alerts, in desktop/handlers/).
function onState(st) {
  callHooks('state', st);
  noteSettingsMayHaveChanged();
}

// The fallback: runs every POLL_MS, and does nothing while the events channel is up. A poll that gets no answer changes nothing.
async function pollServer() {
  if (polling || eventsUp) return;
  polling = true;
  try {
    const st = await fetchState();
    if (st) onState(st);
  } finally {
    polling = false;
  }
}

// What the event hook of the handlers is given (wave 4): the first event of every run, whatever its type (so a run is known from its
// start, also a council, which sends no start of its own), a run's events of the types below, 'notice' and 'approval' (a card answered),
// and { type: 'hello' } when a channel opens. A run's other events (the streamed words of a reply above all: one event per word) are
// dropped by the parser before they are parsed (skipFrame, desktop/sse.cjs runEventType), so this process does no JSON work for them.
const EVENT_RUN_TYPES = new Set(['start', 'done', 'error', 'approval', 'approval-closed']);
// The runs this channel has passed on, so only a run's first frame of another type is parsed. A run's done takes it out; the set is kept
// small (a done that never came is forgotten with the oldest).
const seenRuns = new Set();
const MAX_SEEN_RUNS = 500;

function noteRun(runId, inner) {
  // A seat's or a column's own done (a compare) is not the run's end.
  if (inner.type === 'done' && (inner.seat === undefined || inner.seat === null)) {
    seenRuns.delete(runId);
    return;
  }
  seenRuns.add(runId);
  while (seenRuns.size > MAX_SEEN_RUNS) seenRuns.delete(seenRuns.values().next().value);
}

// The parser's skip: true for a run frame whose event no handler reads, once the run has been seen. Read from the text, not parsed.
function skipFrame(text) {
  const inner = runEventType(text);
  if (!inner || EVENT_RUN_TYPES.has(inner)) return false;
  const runId = runIdOf(text);
  return runId !== '' && seenRuns.has(runId);
}

// Opens the events channel (GET /api/events). Its hello and state events carry the state without messages, which is all
// onState reads. The run, notice and approval events go to the handlers' event hook (callEventHooks, above). When the channel ends or fails it is opened again after 1, 2, 4, 8 and then 10 seconds, and the poll above
// covers the gap. Calling this while a channel is open or a retry is waiting starts over with a fresh one.
function subscribeEvents() {
  if (quitting) return;
  clearTimeout(eventsTimer);
  eventsTimer = null;
  if (eventsReq) {
    const old = eventsReq;
    eventsReq = null;
    old.destroy();
  }
  eventsUp = false;
  // A new channel: every run is new to it, so the first frame of each is passed on again (see skipFrame).
  seenRuns.clear();
  const parser = createSseParser(ev => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'hello' || ev.type === 'state') {
      if (!ev.state) return;
      eventsUp = true;
      eventsFails = 0;
      // The handlers that follow runs start over on a new channel; the state that came with hello follows at once.
      if (ev.type === 'hello') {
        callEventHooks({ type: 'hello', at: ev.at });
        // A new channel may be a new server, or settings changed while it was away.
        quietHours.refresh();
      }
      onState(ev.state);
      return;
    }
    if (ev.type === 'run') {
      const inner = ev.event && typeof ev.event === 'object' ? ev.event : null;
      if (typeof ev.runId !== 'string' || !inner) return;
      const first = !seenRuns.has(ev.runId);
      noteRun(ev.runId, inner);
      if (first || EVENT_RUN_TYPES.has(inner.type)) callEventHooks(ev);
      return;
    }
    if (ev.type === 'notice' || ev.type === 'approval') callEventHooks(ev);
  }, { skip: skipFrame });
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/events', headers: { ...apiHeaders(), accept: 'text/event-stream' } }, res => {
    if (res.statusCode !== 200) {
      res.resume();
      return eventsLost(req);
    }
    res.setEncoding('utf8');
    res.on('data', chunk => parser.feed(chunk));
    res.on('end', () => eventsLost(req));
    res.on('error', () => eventsLost(req));
    return undefined;
  });
  req.on('error', () => eventsLost(req));
  eventsReq = req;
}

// The channel ended or never opened: the poll takes over and a new try is scheduled. A request that has been replaced is ignored.
function eventsLost(req) {
  if (req !== eventsReq) return;
  eventsReq = null;
  eventsUp = false;
  if (quitting) return;
  const wait = EVENTS_BACKOFF_MS[Math.min(eventsFails, EVENTS_BACKOFF_MS.length - 1)];
  eventsFails += 1;
  eventsTimer = setTimeout(subscribeEvents, wait);
}

// Brings the window back from the tray, or from behind other windows. With a route (a notification's click: { kind, id? }), the page then
// opens that place (openInPage).
function showWindow(route) {
  if (SMOKE) return;
  const open = cleanRoute(route);
  if (!win) {
    if (open) pendingOpen = open;
    reopenWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (open) openInPage(open);
}

// The places a notification can open (public/ext-open-route.js does the opening): the waiting card of a project, a project's chat, Today
// (with a business), Plan use, Accounts and Background services. An id is a plain id (a project's or a business's), never a path or text.
const OPEN_KINDS = new Set(['waiting', 'chat', 'today', 'plan-use', 'accounts', 'services']);
const OPEN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
// A route that waits for the page: the window was made again, or its page has not finished loading. Sent once it has.
let pendingOpen = null;
let openSeq = 0;

function cleanRoute(route) {
  if (!route || typeof route !== 'object' || !OPEN_KINDS.has(route.kind)) return null;
  return { kind: route.kind, ...(typeof route.id === 'string' && OPEN_ID.test(route.id) ? { id: route.id } : {}) };
}

// Tells the page to open a place: { op: 'open', kind, id }. The preload bridge has no channel for this and the page needs none: the message
// is posted to the page's own window (window.postMessage, same origin) and also left in window.__plenumPendingOpen, which
// public/ext-open-route.js takes when it loads later than the message. Only the app's own page at the app's own address is told, and only
// a cleaned route (cleanRoute) is ever put into the script. A page that is still loading gets it when it has finished (did-finish-load).
function openInPage(open) {
  const contents = win?.webContents;
  const url = typeof contents?.getURL === 'function' ? String(contents.getURL()) : '';
  if (!contents || !url.startsWith(APP_URL) || (typeof contents.isLoading === 'function' && contents.isLoading())) {
    pendingOpen = open;
    return;
  }
  pendingOpen = null;
  openSeq += 1;
  const message = JSON.stringify({ op: 'open', ...open, n: openSeq, at: Date.now() });
  try {
    contents.executeJavaScript(`(() => { const m = ${message}; window.__plenumPendingOpen = m; window.postMessage(m, location.origin); })()`)?.catch?.(() => {});
  } catch {
    // The page is gone; the window still came to the front.
  }
}

// There is no window (it was destroyed, or this is a second launch on a copy that lost its window): makes one and loads the page. Not
// before main() has made the first window and not while quitting.
function reopenWindow() {
  if (!mainStarted || quitting) return;
  writeLog('the window was made again');
  createWindow();
  // A window made on purpose is shown, also when this copy was started with Windows (--background keeps only the first one hidden).
  const made = win;
  made.once('ready-to-show', () => {
    if (win === made && !SMOKE) made.show();
  });
  if (everAnswered && server) loadApp();
}

// The tray menu. "Show waiting approval" is enabled only while an approval card waits, and then it says how many. The items a handler
// set (trayItems: the update, then the phones) sit after the approval item and before the separator.
function buildTrayMenu(waiting) {
  // The named order first; a name no one put in the order follows, in the order it was set.
  const rank = name => (TRAY_ITEM_ORDER.includes(name) ? TRAY_ITEM_ORDER.indexOf(name) : TRAY_ITEM_ORDER.length);
  const extra = [...trayItems.keys()].sort((a, b) => rank(a) - rank(b)).map(name => ({ label: trayItems.get(name).label, click: trayItems.get(name).click }));
  return Menu.buildFromTemplate([
    { label: 'Show Plenum', click: () => showWindow() },
    { label: waiting ? `Show waiting approval (${waiting})` : 'Show waiting approval', enabled: waiting > 0, click: () => showWindow() },
    ...extra,
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

// Sets or removes one tray item (desktop/handlers/ through shell.tray.setItem). item is { label, click }, or null to take it away. The menu
// is rebuilt only when the item changes.
function setTrayItem(name, item) {
  const next = item && typeof item === 'object' && typeof item.label === 'string' && typeof item.click === 'function' ? { label: item.label, click: item.click } : null;
  const prev = trayItems.get(name);
  if (next ? (prev?.label === next.label && prev?.click === next.click) : !prev) return;
  if (next) trayItems.set(name, next);
  else trayItems.delete(name);
  refreshTray();
}

// The phones the server reports connected (its phones-indicator message, lib/remote/index.mjs): the tray item 'Phones (n connected)'
// while there are some, and the same words in the tray tooltip.
// devices ([{ name, form }], wave 5) says which of them are browsers; the words come from the phones handler (trayLabel).
function setPhonesConnected(names, devices) {
  const count = Array.isArray(names) ? names.length : 0;
  let label = `Phones (${count} connected)`;
  try {
    label = require('./handlers/phones.cjs').trayLabel(count, devices);
  } catch {
    // The phones handler is missing: the words stay the plain ones.
  }
  if (count === phonesConnected && label === phonesLabel) return;
  phonesConnected = count;
  phonesLabel = label;
  setTrayItem('phones', count > 0 ? { label, click: () => showWindow() } : null);
}

// The tray tooltip: the approval count (alerts.cjs), then the phones when some are connected.
function trayTooltip() {
  const parts = [tooltipFor(trayCount)];
  if (phonesConnected > 0) parts.push(phonesLabel || `Phones (${phonesConnected} connected)`);
  return parts.join(' · ');
}

// Writes the tray's tooltip and menu from the current state. Does nothing before the tray exists.
function refreshTray() {
  if (!tray) return;
  tray.setToolTip(trayTooltip());
  tray.setContextMenu(buildTrayMenu(trayCount));
}

// Creates the tray icon on first use. Returns false when it cannot be made, and then the window
// closes as usual rather than vanishing with no way back.
function ensureTray() {
  if (tray) return true;
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
    if (icon.isEmpty()) return false;
    // Windows draws the tray icon at 16 to 32 px, so a 512 px image is scaled down once here. The macOS menu bar is about 22 pt high,
    // so there the icon is 16 pt, with its 32 px version as the @2x representation for Retina screens (B-115).
    let image = icon.resize({ width: 32, height: 32 });
    if (process.platform === 'darwin') {
      const small = icon.resize({ width: 16, height: 16 });
      small.addRepresentation({ scaleFactor: 2, buffer: image.toPNG() });
      image = small;
    }
    tray = new Tray(image);
  } catch {
    tray = null;
    return false;
  }
  // The tray starts with the count the alerts last gave it, so a tray made while an approval waits says so at once.
  refreshTray();
  // A left click on the icon shows the window; the context menu opens on a right click.
  tray.on('click', () => showWindow());
  return true;
}

// The build this is, for the log: the line GET /api/build-info gives (lib/build-info.mjs), read from build-info.json at the application root.
// A development copy has no such file and says so.
function buildLine() {
  let version = '';
  try {
    version = String(app.getVersion());
  } catch {
    version = '';
  }
  const name = version ? `Plenum ${version}` : 'Plenum';
  try {
    const info = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'));
    if (info && typeof info.build === 'string' && /^\d{8}\.\d{4}$/.test(info.build)) {
      const parts = [`build ${info.build}`];
      if (typeof info.commit === 'string' && /^[0-9a-f]{4,40}$/.test(info.commit)) parts.push(info.commit);
      if (info.dirty === true) parts.push('with local changes');
      return `${typeof info.version === 'string' && info.version ? `Plenum ${info.version}` : name} (${parts.join(', ')})`;
    }
  } catch {
    // No stamp: a development copy.
  }
  return `${name} (development copy)`;
}

// ----- the smoke mode (see SMOKE at the top) -----
const SMOKE_LIMIT_MS = 90_000;

// The first load of the app's page is done. A plain run ends here with code 0. With PLENUM_SMOKE_CRASH_SERVER=1 the run waits until the
// page is live (its events channel is connected and the connection panel has loaded: the page opens the channel only after its first
// reads and loads its panels after the server's list, and a server that ends before that is not a connection the page could lose), ends the first server once, and ends 0 only after the server was started again and the page
// reconnected (smokeAwaitReconnect).
function smokeLoaded() {
  if (!SMOKE.crashServer) {
    void smokeExit(0, 'the page loaded');
    return;
  }
  void smokeCrashServer();
}

// Evaluates a small expression in the page. Resolves the string it gave, or '' when the page cannot answer.
async function smokePage(code) {
  try {
    return String(await win.webContents.executeJavaScript(code));
  } catch {
    return '';
  }
}

async function smokeCrashServer() {
  while (!smokeDone && (await smokePage("String(window.MuseUI?.events?.connected === true && document.querySelector('.ext-conn-banner') !== null)")) !== 'true') {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (smokeDone) return;
  writeLog('smoke: the page is connected; ending the first server once');
  try {
    server.kill();
  } catch (err) {
    void smokeExit(1, `the server could not be ended (${String(err?.message ?? err).slice(0, 80)})`);
    return;
  }
  void smokeAwaitReconnect();
}

// Waits until the server has answered a second time and the page says it connected again (ext-connection.js writes how many times it
// came back into the page's data-plenum-reconnects), then ends with 0.
async function smokeAwaitReconnect() {
  let ticks = 0;
  while (!smokeDone) {
    await new Promise(resolve => setTimeout(resolve, 300));
    ticks += 1;
    if (answers < 2 || !win) continue;
    const seen = await smokePage(`'gone=' + (document.documentElement.dataset.plenumDowns ?? '0') + ' back=' + (document.documentElement.dataset.plenumReconnects ?? '0') + ' events=' + window.MuseUI?.events?.connected`);
    if (Number(/back=(\d+)/.exec(seen)?.[1] ?? 0) >= 1) {
      await smokeExit(0, 'the server was started again and the page reconnected');
      return;
    }
    // A line every 10 seconds says what the page reports (how many times it noticed the server gone, and came back), for the person who reads
    // the log of a run that does not end.
    if (ticks % 33 === 0) writeLog(`smoke: waiting for the page to reconnect (it reports: ${seen || 'nothing'})`);
  }
}

// Ends the smoke run with the code. The server is stopped first (cleanly when the run worked), because app.exit skips before-quit.
async function smokeExit(code, why) {
  if (smokeDone) return;
  smokeDone = true;
  quitting = true;
  writeLog(`smoke: ending with code ${code}: ${why}`);
  if (code === 0) await askServerToStop();
  stopServer();
  const finish = () => app.exit(code);
  const timer = setTimeout(finish, 1000);
  timer.unref?.();
  // The server's output may still arrive while it ends; the log ignores a write after its end.
  log.end(() => finish());
}

async function main() {
  // The same id as build.appId in package.json, which the installer writes into its shortcuts.
  // With matching ids, a pinned taskbar icon and the running window are one icon, not two.
  if (process.platform === 'win32') app.setAppUserModelId('com.museconsole.desktop');
  openLog();
  // The registry's variables are read now, while the window and the port check go on (desktop/registry-env.cjs); bringUp waits for them.
  if (process.platform === 'win32' && !SMOKE) void registry.get();
  writeLog(`start: ${buildLine()}${SMOKE ? ' (smoke mode: nothing is shown)' : ''}`);
  if (SMOKE) {
    // A run that never ends is a failure too.
    const watchdog = setTimeout(() => void smokeExit(1, 'the smoke run took too long'), SMOKE_LIMIT_MS);
    watchdog.unref?.();
  }
  // The encrypted keys sit beside the log, in the app's user-data folder. The vault is made before the server starts, because
  // the server asks for its keys the moment it is up.
  vault = createKeyVault({ safeStorage, file: path.join(app.getPath('userData'), 'keys.json') });
  // The app page asks for this launch's token through the preload bridge (preload.cjs). Only the app's own window, showing a page
  // from the app's own address, gets it; any other sender gets an empty string. Registered before the window is made.
  ipcMain.handle('plenum:token', event => (win && event.sender === win.webContents && String(event.senderFrame?.url ?? '').startsWith(APP_URL)) ? TOKEN : '');
  // The handler modules are loaded before the window, so their window hook sees the window made here.
  handlerModules = [];
  handlers = loadHandlers({ dir: path.join(__dirname, 'handlers'), log: writeLog, load: loadHandlerModule });
  mainStarted = true;
  createWindow();
  // B-111: a program that already listens on the port would answer the status check as if it were this app's server, and the
  // app would load it. So the port is checked first, and a busy one stops the start with a plain message.
  if (await portInUse()) {
    dialogs.showErrorBox('Plenum could not start', `Port ${PORT} is already in use by another program or another Plenum. Close it and start Plenum again.\n\nLog: ${logFile}`);
    quitApp(true);
    return;
  }
  pollTimer = setInterval(pollServer, POLL_MS);
  await bringUp({ loadPage: true });
  callHooks('ready');
}

app.on('window-all-closed', () => app.quit());
// The first quit waits for the server's clean stop (askServerToStop), then quits again; the second pass ends the process as before.
let stopAsked = false;
app.on('before-quit', event => {
  quitting = true;
  if (server && !stopAsked && typeof event?.preventDefault === 'function') {
    stopAsked = true;
    event.preventDefault();
    askServerToStop().finally(() => app.quit());
    return;
  }
  stopServer();
  clearInterval(pollTimer);
  pollTimer = null;
  clearTimeout(restartTimer);
  clearTimeout(unresponsiveTimer);
  clearTimeout(eventsTimer);
  clearTimeout(settingsTimer);
  settingsTimer = null;
  eventsReq?.destroy();
  eventsReq = null;
  callHooks('beforeQuit');
});

'use strict';
// The desktop alerts (wave 4, 16 Nov 2026). Two hooks feed them:
//  - event: the run events of every project, from the server's events channel (desktop/main.cjs passes the first event of each run, a
//    run's start, done, error, approval and approval-closed events, the 'approval' event that says a card was answered, and the hello of
//    a new channel; the streamed words of a reply never reach this file), and the notices (read here only to join a routine's notice
//    with its failed run, below). From them: the finished or failed alert for a run of ANY project, and the approval alert that names
//    the project whose card waits.
//  - state: the tray count (st.approvalsWaiting, every project) and keep-awake, which holds the PC awake while any run of any project
//    is live (st.projectThreads[id].busy, st.running, or a run that was seen and whose done was not).
// The words are Plenum's own: the project's name, the kind of run, and a plain reason picked from the error's kind. A notification never
// carries a prompt, a reply, a model's words, a command or a path. A click opens the place: the project's chat, or its waiting card.
// The rules:
//  - Finished: not for a stopped run (done.aborted, unless done.timedOut: a run that hit its time limit says "Stopped"), not for housekeeping (a compact, a check, a restore ...), not for a run shorter than
//    20 s, and not while the window is in front showing that same project. Off with the "finishedAlerts" switch.
//  - Approval: one notification, replaced by the newer one, when a card arrives while the window is not in front. It says how many
//    cards that project has waiting, and goes away when the last of them is answered. Off with the "approvalAlerts" switch.
//  - Quiet hours (wave 5 integration, 16 Nov 2026): the hub's rules of lib/notify.mjs hold for these alerts too. shell.quietNow() says
//    whether the owner's quiet hours hold now (desktop/notify-quiet.cjs reads them from GET /api/notify). In quiet hours a finished or
//    failed run shows nothing (the run's chat and the morning summary have it), and an approval card, which needs him, shows without
//    sound. A shell without quietNow, or settings not read yet, is not quiet: the alerts work as before. Business mutes are not applied
//    here: a run event names its project, not its business.
//  - Routines (wave 5 integration): a routine runs as a plain chat run (lib/routines.mjs POST /api/chat), and the routine tells its own
//    outcome through a 'routine:<id>' notice (desktop/handlers/notices.cjs), on purpose not for a failure that is tried again at once.
//    A run event marked as a routine's (ev.routine === true, or kind 'routine') shows no finished or failed alert. Until the server marks
//    them, the failure is joined as the phone does it (lib/remote/index.mjs ROUTINE_JOIN_MS): a routine notice of a project within
//    ROUTINE_JOIN_MS of that project's failed-run alert takes the alert down, and a failed run within ROUTINE_JOIN_MS after such a notice
//    shows none, so one failure is told once.
const MIN_RUN_MS = 20_000;
const ROUTINE_JOIN_MS = 120_000;
// A run whose done never came (the channel dropped at the wrong moment) is forgotten after this; a run is stopped after 3 hours anyway.
const STALE_RUN_MS = 4 * 60 * 60 * 1000;
// Runs that are the app keeping itself tidy, not work the person waits for.
const HOUSEKEEPING = new Set(['compact', 'check', 'restore', 'rewind', 'snapshot', 'checkpoint', 'worktree', 'worktree-merge']);
// The program that ran, by the provider part of the model ref (lib/providers.mjs), for "<Program> is signed out."
const PROGRAMS = { muse: 'Muse Code', anthropic: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', cursor: 'Cursor', grok: 'Grok Build', antigravity: 'Antigravity' };
const LIMIT_KINDS = new Set(['limit', 'quota']);

const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const str = v => (typeof v === 'string' ? v : '');

// The runs being followed, by runId: { project, kind, startedAt, startKnown, error, program, at }. main.cjs passes the first event of every
// run (whatever its type), so a run is known from its first event: that is its start, unless it was already going when this channel opened.
const runs = new Map();
// The approval cards waiting, by approvalId: { project, runId }.
const cards = new Map();
// The project names and the active project, from the last state.
let names = new Map();
let activeProject = '';
// Whether the last state said a run is going anywhere.
let stateBusy = false;
// The projects that had a run going when the channel opened (from the first state after hello): a run of theirs that is seen now
// started earlier, so its length is not known and the 20 s rule does not apply to it. helloPending: that state has not come yet.
let busyAtHello = new Set();
let helloPending = false;
// The notifications, kept so one is not collected before a click on it can be handled. Finished ones by project (a newer one for the same
// project replaces the older); one approval notification for all.
const finishedNotes = new Map();
let approvalNote = null;
let approvalProject = '';
// The routine join (see the top of this file), by project: when its last failed-run alert was shown, and when a routine notice of it came.
const failedShownAt = new Map();
const routineNoticeAt = new Map();
// The number of approval cards the last state counted, for the tray.
let lastWaiting = 0;
// The keep-awake blocker id. Only one blocker is held at a time.
let keepAwakeId = null;

// Holds the PC awake while a run is in progress. Only one blocker is held at a time.
function setKeepAwake(shell, on) {
  if (on && keepAwakeId === null) {
    keepAwakeId = shell.powerSaveBlocker.start('prevent-app-suspension');
  } else if (!on && keepAwakeId !== null) {
    shell.powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = null;
  }
}

function dropStale(now) {
  for (const [id, run] of runs) {
    if (now - run.at > STALE_RUN_MS) runs.delete(id);
  }
}

// Whether any run is live: the server's word, or a run that was seen and whose done has not come.
const anyRunLive = () => stateBusy || runs.size > 0;

function syncKeepAwake(shell) {
  const { keepAwake } = shell.settings();
  setKeepAwake(shell, keepAwake !== false && anyRunLive());
}

const nameOf = projectId => names.get(projectId) || 'Plenum';
const focusedNow = shell => {
  const win = shell.win();
  return Boolean(win && typeof win.isFocused === 'function' && win.isFocused());
};
// Whether the owner's quiet hours hold now. A shell without the reader, or one that throws, is not quiet.
const quietNow = shell => {
  try {
    return typeof shell.quietNow === 'function' && shell.quietNow() === true;
  } catch {
    return false;
  }
};
const within = (map, project, now) => {
  const at = map.get(project);
  return at !== undefined && now - at >= 0 && now - at < ROUTINE_JOIN_MS;
};

function close(note) {
  try {
    note?.close?.();
  } catch {
    // Already gone.
  }
}

function show(shell, opts, route) {
  if (!shell.Notification.isSupported()) return null;
  const note = new shell.Notification(opts);
  note.on('click', () => shell.showWindow(route));
  note.show();
  return note;
}

// The plain reason of a failed run, from the kind of its error. Never the error's own text, which can quote the model or a path.
function reasonOf(run) {
  const kind = run.error?.kind ?? '';
  if (kind === 'not-signed-in') return run.program ? `${run.program} is signed out.` : 'A sign-in is needed.';
  if (LIMIT_KINDS.has(kind)) return 'The plan is used up for now.';
  if (kind === 'network') return 'No internet on this computer.';
  return 'The run did not finish.';
}

// The words of the alert for a run that ended: { title, body }.
function wordsFor(run, failed, timedOut = false) {
  const name = nameOf(run.project);
  if (timedOut) return { title: `Stopped: ${name}`, body: 'It ran into the time limit.' };
  if (failed) return { title: `Stopped: ${name}`, body: reasonOf(run) };
  if (run.kind === 'council') return { title: `Council is done: ${name}`, body: 'The verdict is ready.' };
  return { title: `Done: ${name}`, body: 'The run finished.' };
}

function onDone(shell, run, done, now) {
  // The server stops a run at its time limit by aborting it, so a timed-out done says aborted: true as well (server.mjs). Only a stop
  // that was not the time limit (the person pressed Stop, the app quit) stays quiet: the longest runs, where he is most likely away, end
  // with a toast.
  const timedOut = done.timedOut === true;
  if (done.aborted === true && !timedOut) return;
  if (HOUSEKEEPING.has(run.kind)) return;
  // A routine's run: the routine's own notice tells its outcome.
  if (run.routine) return;
  if (shell.settings().finishedAlerts === false) return;
  if (focusedNow(shell) && run.project && run.project === activeProject) return;
  if (run.startKnown && now - run.startedAt < MIN_RUN_MS) return;
  if (quietNow(shell)) return;
  const failed = Boolean(run.error) || timedOut;
  const key = run.project || '';
  // A routine notice of this project came just before: it is the word on this failure.
  if (failed && key && within(routineNoticeAt, key, now)) {
    routineNoticeAt.delete(key);
    return;
  }
  const words = wordsFor(run, failed, timedOut);
  close(finishedNotes.get(key));
  finishedNotes.delete(key);
  const note = show(shell, { title: words.title, body: words.body }, { kind: 'chat', id: run.project });
  if (note) finishedNotes.set(key, note);
  if (note && failed && key) failedShownAt.set(key, now);
  else failedShownAt.delete(key);
}

// A notice of the events channel: a routine's notice of a project joins that project's failed-run alert (see the top of this file).
function onNotice(n, now) {
  if (!n || typeof n !== 'object' || n.clear === true) return;
  const key = str(n.key);
  const project = str(n.project);
  if (!key.startsWith('routine:') || !project) return;
  if (within(failedShownAt, project, now)) {
    failedShownAt.delete(project);
    close(finishedNotes.get(project));
    finishedNotes.delete(project);
    return;
  }
  routineNoticeAt.set(project, now);
}

const waitingIn = project => [...cards.values()].filter(c => c.project === project).length;

// A card arrived: the approval alert for its project, unless the window is in front or the switch is off.
function onCard(shell, project) {
  if (shell.settings().approvalAlerts === false || focusedNow(shell)) return;
  const n = Math.min(waitingIn(project), 999);
  if (n < 1) return;
  close(approvalNote);
  // A card needs him, so it comes through in quiet hours too, without sound (the hub's rule for 'needs-you').
  const opts = { title: `${nameOf(project)} needs a yes`, body: n === 1 ? '1 approval is waiting.' : `${n} approvals are waiting.` };
  if (quietNow(shell)) opts.silent = true;
  approvalNote = show(shell, opts, { kind: 'waiting', id: project });
  approvalProject = approvalNote ? project : '';
}

// A card was answered, closed or ended with its run. When the project of the approval alert has no card left, the alert goes away.
function forgetCard(id) {
  const card = cards.get(id);
  if (!card) return;
  cards.delete(id);
  if (approvalNote && approvalProject === card.project && waitingIn(card.project) === 0) {
    close(approvalNote);
    approvalNote = null;
    approvalProject = '';
  }
}

// Takes one event of the events channel (see the top of this file for which ones arrive).
function onEvent(shell, ev) {
  if (!ev || typeof ev !== 'object') return;
  const now = Number.isFinite(ev.at) ? ev.at : Date.now();
  if (ev.type === 'hello') {
    // A new channel: what was followed on the old one may have ended unseen. The state that comes with hello says what runs now.
    runs.clear();
    cards.clear();
    busyAtHello = new Set();
    helloPending = true;
    syncKeepAwake(shell);
    return;
  }
  if (ev.type === 'approval') {
    // A card was answered (here, on the board or on a phone), ran out of time, or was stopped.
    if (typeof ev.approvalId === 'string') forgetCard(ev.approvalId);
    return;
  }
  if (ev.type === 'notice') {
    onNotice(ev.notice, now);
    return;
  }
  if (ev.type !== 'run') return;
  const inner = ev.event;
  const runId = str(ev.runId) || str(inner?.runId);
  if (!inner || typeof inner !== 'object' || !runId) return;
  // An event of one seat or column (a compare's column ends with its own done) is part of the run, not its start or end.
  const seatLevel = inner.seat !== undefined && inner.seat !== null;
  dropStale(now);
  let run = runs.get(runId);
  if (!run) {
    const project = str(ev.project);
    const kind = str(ev.kind) || 'run';
    run = { project, kind, routine: ev.routine === true || kind === 'routine', startedAt: now, startKnown: !busyAtHello.has(project), error: null, program: '', at: now };
    runs.set(runId, run);
  }
  run.at = now;
  switch (inner.type) {
    case 'start':
      // The model of the run (a seat's start may name another; the first one known is kept), for the sign-in reason.
      if (!run.program) run.program = programOf(inner.model);
      break;
    case 'error':
      if (!seatLevel) run.error = { kind: str(inner.kind) };
      break;
    case 'approval': {
      const id = str(inner.approvalId);
      if (!id) break;
      cards.set(id, { project: run.project, runId });
      onCard(shell, run.project);
      break;
    }
    case 'approval-closed':
      forgetCard(str(inner.approvalId));
      break;
    case 'done':
      if (seatLevel) break;
      runs.delete(runId);
      busyAtHello.delete(run.project);
      for (const [id, card] of [...cards]) if (card.runId === runId) forgetCard(id);
      onDone(shell, run, inner, now);
      break;
    default:
      break;
  }
  syncKeepAwake(shell);
}

function programOf(ref) {
  const provider = typeof ref === 'string' ? ref.split(':')[0] : '';
  return PROGRAMS[provider] ?? '';
}

// Takes the state: the project names, the tray count and keep-awake.
function onState(shell, st) {
  if (!st || typeof st !== 'object') return;
  const next = new Map();
  for (const p of Array.isArray(st.projects) ? st.projects : []) {
    if (p && typeof p.id === 'string') next.set(p.id, oneLine(p.name, 60) || 'Project');
  }
  names = next;
  activeProject = str(st.activeProject);
  const threads = st.projectThreads && typeof st.projectThreads === 'object' ? Object.values(st.projectThreads) : [];
  stateBusy = st.running === true || threads.some(t => t && t.busy === true);
  if (helloPending) {
    helloPending = false;
    const ids = Object.keys(st.projectThreads && typeof st.projectThreads === 'object' ? st.projectThreads : {});
    busyAtHello = new Set(ids.filter(id => st.projectThreads[id]?.busy === true));
    if (st.running === true && activeProject) busyAtHello.add(activeProject);
  }
  const waiting = Number(st.approvalsWaiting) || 0;
  if (waiting !== lastWaiting) shell.tray.count(waiting);
  lastWaiting = waiting;
  syncKeepAwake(shell);
}

module.exports = {
  name: 'alerts',
  MIN_RUN_MS,
  ROUTINE_JOIN_MS,
  reasonOf,
  // For the tests: forgets everything followed (the keep-awake blocker id too, so a fake shell starts clean).
  reset: () => {
    runs.clear();
    cards.clear();
    names = new Map();
    activeProject = '';
    stateBusy = false;
    busyAtHello = new Set();
    helloPending = false;
    finishedNotes.clear();
    failedShownAt.clear();
    routineNoticeAt.clear();
    approvalNote = null;
    approvalProject = '';
    lastWaiting = 0;
    keepAwakeId = null;
  },
  hooks: {
    state: onState,
    event: onEvent,
    // Releases the keep-awake blocker when the app quits, so a quit never leaves the PC awake.
    beforeQuit: shell => setKeepAwake(shell, false),
  },
};

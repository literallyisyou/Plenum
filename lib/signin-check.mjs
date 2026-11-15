import { codexLoginStatus, forgetCodexLogin, museSignedIn, museSignInStamp, openSignIn } from './accounts.mjs';
import { antigravityModelsState, antigravitySignIn, antigravityStatus, refreshAntigravityModels } from './antigravity.mjs';
import { claudeCliStatus, claudeRoute, forgetClaudeStatus } from './claude-cli.mjs';
import { CLI_LABELS, SIGN_IN_REFUSED_WORDS } from './cli-errors.mjs';
import { cursorSignIn, cursorStatus, forgetCursorStatus } from './cursor.mjs';
import { geminiRoute, geminiSignIn, geminiSignInStamp, geminiStatus } from './gemini.mjs';
import { grokSignIn, grokSignInStamp, grokStatus } from './grok.mjs';
import { findExecutable } from './proc.mjs';
import { invalidateProviderStatus } from './provider-status.mjs';
import { codexRoute } from './providers.mjs';
import { signInWindows } from './signin-windows.mjs';

// The sign-in check of a council, and the repair of a sign-in that is gone (DECISIONS item 154, 15 Nov 2026). The owner's words:
// "before each council use event it should check whether everything is signed in, and if not, auto sign in again. It should fix
// itself." A council run makes one gate (createSignInGate) and asks it three things:
//   preflight(refs)       before any seat runs: every program the council uses is asked whether it is signed in, all at once, with a
//                         few seconds for the answer. Signed in, or no answer: the run goes on ("no answer" is never read as signed
//                         out). The program's own check says that nobody is signed in: Plenum opens that program's sign-in window
//                         itself (what "Sign in" in Accounts opens) and says so on the council's card.
//   ready(ref)            just before a turn: when a sign-in window is open for this turn's program, the turn waits for the sign-in
//                         to finish (the check is asked again every few seconds, five minutes at most) while the other seats run,
//                         and then runs. When the sign-in is not finished in time, the turn of a program whose own run said in
//                         this council that nobody is signed in fails, in plain words. Where only the program's check said so,
//                         the turn is sent all the same and the program itself says: a check can be wrong, and a turn that is
//                         never sent cannot show it.
//   failed(ref, who, kind) after a turn failed for its sign-in with nothing written: 'again' when the same turn should be sent once
//                         more, 'no' when the failure stands. A refused sign-in of a program whose own check says "signed in" (or
//                         gives no answer) is sent again at once. A program that said in its run that nobody is signed in gets the
//                         repair above first. A turn of a program with a sign-in check of its own is sent again once, never twice.
//   worked(ref)           after a turn answered: its program is signed in, so its sign-in window is off the list and the turns that
//                         wait for that sign-in run.
// A wait that ended without a sign-in does not close the door for the rest of the run: the next turn of that program looks once
// more, so a sign-in the person finished late is found by the next turn (the next round, the moderator), not by the next run.
// Three programs have no sign-in check to ask (Muse Code, Gemini CLI, Grok Build): Plenum can only see whether a sign-in file is on
// this PC, and a file that is there says nothing about whether the sign-in in it still works (an expired one leaves its file behind).
// For them the run's own word is the only word. A turn they refuse with "not signed in" while a file is there is sent again at once;
// when the program says it again, Plenum opens the sign-in window, waits until the program's sign-in files were written anew (the
// sign that a sign-in was finished) and sends the turn once more. So such a turn can be sent again twice: once at once, once after
// the sign-in.
// What it never does: type or hold a password or a key (the sign-in happens in the program's own window and the person's browser),
// change a seat's model, or read a reply for sign-in words (the kind comes from lib/cli-errors.mjs, or from the two sentences Plenum
// itself writes). One window per program and sign-out: after Plenum opened one it opens no other for that program for six hours, or
// until the program was seen signed in again (the rules are above the list of windows, below), so a routine that runs every few
// minutes does not stack windows. PLENUM_NO_SIGNIN_WINDOW=1 (every sealed test run sets it) turns the opening off: the check, the
// wait and the retry still run, no window is ever opened.

export const SIGNIN_LIMITS = Object.freeze({
  checkMs: 5_000, // how long one program's check may take before it counts as no answer
  holdMs: 5 * 60_000, // how long a turn waits for a sign-in that Plenum opened
  pollMs: 3_000, // how often the check is asked again while a turn waits
  reopenMs: 6 * 60 * 60_000, // no second window for the same program within this time
});

// Each program with a sign-in: its name, the question (true signed in, false signed out, null not known, NONE when this route has
// no sign-in: it runs with a key), whether the answer is the program's own word (said) or only Plenum's reading of its files, the
// window that signs in, and what to forget so that the next question asks the program again. `id` is the model, for a program
// whose models can take different routes. A program whose answer is only a reading of files also has `stamp`: a text that changes
// when its sign-in files are written anew.
const NONE = 'none';
const PROVIDERS = {
  anthropic: {
    name: CLI_LABELS.claude,
    said: true,
    async ask({ fresh }) {
      // On the API-key route there is no sign-in to check.
      if ((await claudeRoute()) !== 'cli') return NONE;
      const status = await claudeCliStatus({ fresh });
      return status.installed === false ? null : status.loggedIn;
    },
    open: () => openSignIn('claude', ['auth', 'login'], 'Claude sign-in'),
    forget: forgetClaudeStatus,
  },
  codex: {
    name: CLI_LABELS.codex,
    said: true,
    async ask({ fresh, waitMs }) {
      if ((await codexRoute()).route === 'key') return NONE;
      const status = await codexLoginStatus({ fresh, waitMs });
      if (status.installed === false) return null;
      // An answer that is minutes old (the check was late) counts only when it says "signed in".
      if (status.stale) return status.loggedIn === true ? true : null;
      return status.loggedIn;
    },
    open: () => openSignIn('codex', ['login'], 'Codex sign-in'),
    forget: forgetCodexLogin,
  },
  muse: {
    name: CLI_LABELS.muse,
    said: false,
    async ask() {
      if (process.env.META_API_KEY) return NONE;
      if (!(await findExecutable('muse'))) return null;
      return museSignedIn();
    },
    open: () => openSignIn('muse', ['login'], 'Muse Code sign-in'),
    stamp: museSignInStamp,
  },
  gemini: {
    name: CLI_LABELS.gemini,
    said: false,
    async ask({ id }) {
      if ((await geminiRoute(id)).route === 'key') return NONE;
      const status = await geminiStatus();
      return status.installed ? status.google === true : null;
    },
    open: () => geminiSignIn(),
    stamp: geminiSignInStamp,
  },
  cursor: {
    name: CLI_LABELS.cursor,
    said: true,
    async ask({ fresh }) {
      const status = await cursorStatus({ fresh });
      return status.installed ? status.signedIn : null;
    },
    open: () => cursorSignIn(),
    forget: forgetCursorStatus,
  },
  grok: {
    name: CLI_LABELS.grok,
    said: false,
    async ask() {
      const status = await grokStatus();
      return status.installed ? status.signedIn : null;
    },
    open: () => grokSignIn(),
    stamp: grokSignInStamp,
  },
  antigravity: {
    name: CLI_LABELS.antigravity,
    said: true,
    async ask({ fresh, waitMs }) {
      // Antigravity's sign-in is what its last read of the account's models found, and that can be half an hour old. A fresh
      // question reads the models again (a handshake that sends no prompt); without it a turn would wait its five minutes on an
      // old "signed out" after the person had signed in. One read can take longer than this question may (waitMs, five seconds),
      // so a read that ended within twice that time is fresh enough: the question after a slow read finds its answer.
      if (fresh) {
        const read = antigravityModelsState();
        if (read.reading || !read.at || Date.now() - read.at > 2 * (waitMs ?? SIGNIN_LIMITS.checkMs)) await refreshAntigravityModels({ force: true });
      }
      const status = await antigravityStatus();
      return status.installed ? status.signedIn : null;
    },
    open: () => antigravitySignIn(),
  },
};

export const SIGNIN_PROVIDERS = Object.freeze(Object.keys(PROVIDERS));

const providerOf = ref => {
  const text = String(ref ?? '');
  const colon = text.indexOf(':');
  return colon > 0 ? text.slice(0, colon) : text;
};
const idOf = ref => {
  const text = String(ref ?? '');
  const colon = text.indexOf(':');
  return colon > 0 ? text.slice(colon + 1) : '';
};

// The sign-in windows that were opened and are not known to be finished, by program: { at, by: 'plenum' | 'person', stamp, finished }.
// The list is in lib/signin-windows.mjs (one for the whole server, so a second run does not open a second window). stamp is what the
// program's sign-in files looked like when the window was opened (only for a program with no check of its own; null until it is
// read). How long a window counts:
//   - one the person opened in Accounts: five minutes (holdMs). They were at the PC: after that it is finished or given up, and a
//     sign-out that a council finds later gets a window of its own.
//   - one Plenum opened: until the program is seen signed in again, six hours at most (reopenMs), so a routine that runs every few
//     minutes does not stack windows. "Seen signed in" is the program's own check saying so anywhere in Plenum (noteSignedIn in
//     lib/signin-windows.mjs), or a council turn of the program that answered (worked).
//   - a program with no check of its own is never "seen signed in" by a check. When its sign-in files were written anew, the turns
//     that waited run, and the window stays on the list with the time (finished) until a turn of the program answered: should the
//     program still say "not signed in" after that, Plenum says so in plain words and opens no second window (files that change
//     while the sign-in in them does not work must not open a window at every run).
const windows = signInWindows;

// What a program's sign-in files look like now: a text, or null when the program has none to look at or the look failed. Never throws.
async function stampOf(entry) {
  if (typeof entry?.stamp !== 'function') return null;
  try {
    const text = await entry.stamp();
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

// A sign-in route of Accounts opened this program's window (server.mjs, lib/routes/cli-accounts.mjs): no other is opened beside it.
export function noteSignInOpened(provider, by = 'person', now = Date.now()) {
  if (!Object.hasOwn(PROVIDERS, provider)) return;
  const open = { at: now, by, stamp: null };
  windows.set(provider, open);
  // Read a moment after the window opened, long before a person can have finished a sign-in in it.
  stampOf(PROVIDERS[provider]).then(text => { open.stamp = text; });
}
// For tests: forgets every window.
export function resetSignInWindows() {
  windows.clear();
}

// The kind of a sign-in failure, or null: the kind the adapter gave it, else read from the two sentences Plenum itself writes for
// one ("<Program> is not signed in." and "... sign-in was refused for this reply ..."). Nothing else in an error text is read.
const OWN_SIGNED_OUT = new RegExp(`(?:^|[.\\n] ?)(?:${[...new Set(Object.values(CLI_LABELS))].join('|')}) is not signed in\\.`);
export function signInKind(kind, text = '') {
  if (kind === 'not-signed-in' || kind === 'sign-in-refused') return kind;
  if (kind) return null;
  const words = String(text ?? '');
  if (words.includes(SIGN_IN_REFUSED_WORDS)) return 'sign-in-refused';
  return OWN_SIGNED_OUT.test(words) ? 'not-signed-in' : null;
}

const clock = at => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const minutes = ms => {
  const n = Math.max(1, Math.round(ms / 60_000));
  return n === 1 ? '1 minute' : `${n} minutes`;
};
const firstLine = err => String(err?.message ?? err ?? '').split('\n')[0].trim().slice(0, 200);

// Waits ms, or until the signal fires: true when the time passed, false when the run was stopped.
function pause(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(false);
    let timer = null;
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve(true);
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', stop, { once: true });
  });
}

// One gate for one council run.
//   signal   the run's signal: Stop ends every wait at once
//   say      text => void: one plain sentence for the council's card (a `notice` event); never a model's words
//   limits   replaces SIGNIN_LIMITS values (tests)
//   deps     { providers, now, pause, canOpen, changed } (tests): the table above, the clock, the wait, whether a window may be opened,
//            and what to call after a window was opened or a sign-in finished (the provider status is read again)
export function createSignInGate({ signal = null, say = () => {}, limits = {}, deps = {} } = {}) {
  const L = { ...SIGNIN_LIMITS, ...limits };
  const table = deps.providers ?? PROVIDERS;
  const now = deps.now ?? Date.now;
  const wait = deps.pause ?? pause;
  // NODE_TEST_CONTEXT is set by node's test runner in a test's own process and in every program it starts: a second lock on the
  // same door, for a test that runs without the sealed runner.
  const canOpen = deps.canOpen ?? (() => process.env.PLENUM_NO_SIGNIN_WINDOW !== '1' && !process.env.NODE_TEST_CONTEXT);
  const changed = deps.changed ?? (() => invalidateProviderStatus());
  const tell = text => {
    try {
      say(String(text));
    } catch {
      // A card that cannot take the sentence must not stop the run.
    }
  };
  const entryOf = ref => (Object.hasOwn(table, providerOf(ref)) ? table[providerOf(ref)] : null);

  // One question to one program: true, false, null (no answer) or NONE (no sign-in on this route). Never throws, and never takes
  // longer than checkMs.
  async function ask(ref, fresh = false) {
    const entry = entryOf(ref);
    if (!entry) return null;
    let timer = null;
    try {
      const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), L.checkMs); });
      const answer = await Promise.race([Promise.resolve().then(() => entry.ask({ id: idOf(ref), fresh, waitMs: L.checkMs })), late]);
      return answer === true ? true : answer === false ? false : answer === NONE ? NONE : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const first = new Map(); // ref -> Promise of the first answer of this run
  const repairs = new Map(); // provider -> { started, done, end, from, worked, look }: the repair that is going on, or the last one that ended
  const sentAgain = new Map(); // turn -> { plain, repaired }: how it was sent again (at once, after a sign-in)

  // Looks whether the program is signed in now, for one repair (job), and keeps the list of windows right when it is. Returns
  // false, or how it is known: 'check' or 'files'.
  //   A program with a check of its own: its check says so, and its window is off the list.
  //   A program without one: its sign-in files were written anew since its window opened (since this repair began when there is
  //   no window, or the window has no stamp) and a sign-in is on this PC. Only files say so, so the window stays on the list with
  //   the time and the files of that sign-in (finished, finishedStamp): a repair that begins after it compares with those, so
  //   Plenum opens no second window for a program that still says "not signed in" after such a sign-in. The window's own stamp
  //   is left as it was: another run that waits on the same window finds the same sign-in. A turn of the program that answers
  //   takes the window off the list (worked).
  async function lookIn(ref, job) {
    const entry = entryOf(ref);
    const provider = providerOf(ref);
    entry.forget?.();
    if (entry.said === true) {
      if ((await ask(ref, true)) !== true) return false;
      windows.delete(provider);
      return 'check';
    }
    const open = windows.get(provider) ?? null;
    const base = open ? (open.finished && job.at >= open.finished ? open.finishedStamp : open.stamp) : null;
    const since = typeof base === 'string' ? base : job.from;
    const text = await stampOf(entry);
    if (typeof since === 'string' && (text === null || text === since)) return false;
    if ((await ask(ref, true)) !== true) return false;
    if (open) {
      open.finished = now();
      open.finishedStamp = text ?? open.stamp;
    }
    return 'files';
  }
  // What the card is told when a program was found signed in: by its own check, by its sign-in files (a program with no check:
  // Plenum cannot know more than that), or by a turn of it that answered.
  const inWords = (entry, how) => (how === 'files'
    ? `A new sign-in for ${entry.name} was written on this PC.`
    : how === 'worked'
      ? `${entry.name} answered a turn, so it is signed in.`
      : `${entry.name} is signed in again.`);

  // The repair of a program that is signed out: the window, then the wait. started resolves when the card has been told what
  // happens; done resolves to 'in' (signed in again), 'out' (not in time, or no window could be opened) or 'stopped'; end is null
  // while it runs and holds what done came to afterwards.
  function repair(ref) {
    const provider = providerOf(ref);
    const known = repairs.get(provider);
    if (known) return known;
    const entry = entryOf(ref);
    let begun = () => {};
    const started = new Promise(resolve => { begun = resolve; });
    // at: when the repair began. confirmed: a run of the program itself said in this council that nobody is signed in (failed);
    // without that only its check has said so, and the turns are sent after the wait all the same (ready).
    const job = { started, done: null, end: null, from: null, at: now(), worked: false, look: null, confirmed: false, toldTry: false };
    job.done = (async () => {
      // A program with no sign-in check of its own: what its sign-in files look like before anything is opened.
      job.from = entry.said === true ? null : await stampOf(entry);
      // From here to the claim below nothing is awaited, so two runs that start in the same moment cannot both find no window.
      let open = windows.get(provider) ?? null;
      // How long a window counts is said above the list: the person's own for five minutes, Plenum's for six hours.
      if (open && now() - open.at >= (open.by === 'person' ? L.holdMs : L.reopenMs)) open = null;
      if (!open) {
        if (!canOpen()) {
          tell(`${entry.name} is signed out. Open Accounts and choose Sign in on the ${entry.name} card.`);
          return 'out';
        }
        // The window is written down before it is there: a run that starts while it opens finds it, and opens no second one.
        open = { at: now(), by: 'plenum', stamp: job.from };
        windows.set(provider, open);
        try {
          await entry.open();
        } catch (err) {
          if (windows.get(provider) === open) windows.delete(provider);
          tell(`${entry.name} is signed out, and Plenum could not open its sign-in window: ${firstLine(err) || 'no reason was given'} Open Accounts and choose Sign in on the ${entry.name} card.`);
          return 'out';
        }
        open.at = now();
        entry.forget?.();
        Promise.resolve().then(changed).catch(() => {});
        tell(`${entry.name} is signed out. Plenum opened its sign-in window: finish the sign-in there. The turns that use ${entry.name} wait up to ${minutes(L.holdMs)} and run when it is done. Seats that answer at the same time go on.`);
      } else if (!open.finished && now() - open.at < L.holdMs) {
        // A window was opened a moment ago (by Plenum in another run, or by the person in Accounts): no second one, and the turn
        // waits for what is left of that window's time.
        tell(`${entry.name} is signed out. Its sign-in window is open since ${clock(open.at)}: finish the sign-in there. The turns that use ${entry.name} wait up to ${minutes(open.at + L.holdMs - now())} and run when it is done. Seats that answer at the same time go on.`);
      } else {
        // A window that had its time and after which the program was not seen signed in, or a sign-in that only the files showed
        // and after which the program still says "not signed in": no second window, and no wait for a person who is not there.
        // One fresh look.
        const finished = open.finished;
        const how = await lookIn(ref, job);
        if (how) {
          tell(inWords(entry, how));
          return 'in';
        }
        tell(finished
          ? `${entry.name} still says it is not signed in, although a new sign-in for it was written on this PC at ${clock(finished)}. Open Accounts and choose Sign in on the ${entry.name} card.`
          : `${entry.name} is signed out. Plenum opened its sign-in window at ${clock(open.at)} and has not seen ${entry.name} signed in since. Finish the sign-in there, or open Accounts and choose Sign in on the ${entry.name} card.`);
        return 'out';
      }
      begun();
      const until = open.at + L.holdMs;
      while (now() < until) {
        if (!(await wait(L.pollMs, signal))) return 'stopped';
        // A turn of this program ran while the others waited (worked), or the look says so.
        const how = job.worked ? 'worked' : await lookIn(ref, job);
        if (how) {
          Promise.resolve().then(changed).catch(() => {});
          tell(inWords(entry, how));
          return 'in';
        }
      }
      return 'out';
    })().catch(() => 'out').then(end => {
      job.end = end;
      return end;
    }).finally(() => begun());
    repairs.set(provider, job);
    return job;
  }

  // The first answer of this run for one program. A "signed out" of a program's own check can be a kept answer that is minutes old
  // (Antigravity's is its last read of the account's models): it is asked once more, fresh, before a window is opened for it. A
  // fresh question with no answer leaves it not known: the run itself will say.
  async function firstAnswer(ref) {
    const answer = await ask(ref);
    const entry = entryOf(ref);
    if (answer !== false || entry.said !== true) return answer;
    entry.forget?.();
    return ask(ref, true);
  }

  return {
    // Asks every program of the run once, at the same time. For each one whose own check says "signed out" the repair starts, and
    // this waits only until the card has been told (not for the sign-in). Returns [{ ref, provider, name, state }] with state 'in',
    // 'out' or 'unknown'. Never throws.
    async preflight(refs = []) {
      const unique = [...new Set(refs.map(String))].filter(entryOf);
      for (const ref of unique) if (!first.has(ref)) first.set(ref, firstAnswer(ref));
      const answers = await Promise.all(unique.map(ref => first.get(ref)));
      const out = [];
      const opening = [];
      unique.forEach((ref, i) => {
        const entry = entryOf(ref);
        const provider = providerOf(ref);
        // A "no" that is only Plenum's reading of the program's files is not acted on before the run: the run itself will say.
        const signedOut = answers[i] === false && entry.said === true;
        // Only the program's own "signed in" takes a window off the list; a sign-in file on this PC does not.
        if (answers[i] === true && entry.said === true) windows.delete(provider);
        if (signedOut && !signal?.aborted) opening.push(repair(ref).started);
        out.push({ ref, provider, name: entry.name, state: answers[i] === true ? 'in' : signedOut ? 'out' : 'unknown' });
      });
      await Promise.all(opening);
      return out;
    },

    // Just before a turn: { ok: true } to run it, or { ok: false, error } when its program is signed out and the sign-in was not
    // finished (the error is the turn's failure, in the words of a sign-in failure). A program with no repair going on runs at once.
    async ready(ref) {
      const entry = entryOf(ref);
      const provider = providerOf(ref);
      const job = entry ? repairs.get(provider) : null;
      if (!job) return { ok: true };
      // A model of this program that runs with a key has no sign-in to wait for.
      if ((await (first.get(ref) ?? ask(ref))) === NONE) return { ok: true };
      // What the repair had come to before this turn asked.
      const before = job.end;
      const end = await job.done;
      if (end === 'in') return { ok: true, waited: true };
      if (end === 'stopped' || signal?.aborted) return { ok: false, stopped: true, error: 'Stopped.' };
      if (before === 'out') {
        // The wait ended before this turn came, and the person may have signed in since: one fresh look (one for the turns that
        // come in the same moment), so a sign-in that was finished late is found by the next turn, not by the next run.
        let how = job.worked ? 'worked' : false;
        if (!how) {
          if (!job.look || now() - job.look.at >= L.pollMs) job.look = { at: now(), answer: lookIn(ref, job).catch(() => false) };
          how = (await job.look.answer) || (job.worked ? 'worked' : false);
        }
        if (how) {
          if (repairs.get(provider) === job) {
            repairs.delete(provider);
            Promise.resolve().then(changed).catch(() => {});
            tell(inWords(entry, how));
          }
          return { ok: true, waited: true };
        }
        if (signal?.aborted) return { ok: false, stopped: true, error: 'Stopped.' };
      }
      // Only the program's check has said "signed out" in this council; no run of it has. A check can be wrong, and a turn that
      // is never sent cannot show that (a false "signed out" costs more than a missing one, DECISIONS item 155): the turn is
      // sent, and the program itself says. When it says "not signed in", that failure stands (failed), and the turns after it
      // are not sent.
      if (!job.confirmed) {
        if (!job.toldTry) {
          job.toldTry = true;
          tell(`Plenum has not seen ${entry.name} signed in. It sends the turns that use ${entry.name} all the same: ${entry.name} itself will say whether it is signed in.`);
        }
        return { ok: true, waited: true, unsure: true };
      }
      return { ok: false, kind: 'not-signed-in', error: `${entry.name} is not signed in. The sign-in was not finished, so this turn did not run. Sign in (open Accounts and choose Sign in on the ${entry.name} card), then run this turn again.` };
    },

    // After a turn failed for its sign-in (kind from signInKind) with nothing written. 'again': send the same turn once more. 'no':
    // the failure stands. `who` names the turn (a seat and its round, or the moderator). A turn of a program with a sign-in check of
    // its own is sent again once at most. A turn of a program without one can be sent again twice: once at once, once after a sign-in.
    async failed(ref, who, kind, label = '') {
      const entry = entryOf(ref);
      if (!entry || !kind || signal?.aborted) return 'no';
      const provider = providerOf(ref);
      const was = sentAgain.get(who) ?? { plain: false, repaired: false };
      const own = entry.said === true;
      if (own ? was.plain || was.repaired : was.repaired) return 'no';
      const mark = how => {
        sentAgain.set(who, { ...was, [how]: true });
        return 'again';
      };
      entry.forget?.();
      const answer = await ask(ref, true);
      // This turn ran with a key: its failure is not a sign-in that a window could repair.
      if (answer === NONE) return 'no';
      const whose = label ? `the turn of ${label}` : 'a turn';
      if (own) {
        // The program's own check says it is signed in, and this one run was refused or said otherwise; or the run was refused
        // and the check gives no answer: sending the same turn again is the repair. A refusal while the check says "signed out"
        // is a sign-out: it gets the window below.
        if (answer === true || (kind === 'sign-in-refused' && answer !== false)) {
          if (answer === true) windows.delete(provider);
          tell(`${entry.name} refused ${whose} for its sign-in${answer === true ? `, although ${entry.name}'s own check says it is signed in` : ''}. Plenum sent the turn again.`);
          return mark('plain');
        }
      } else if (kind === 'sign-in-refused') {
        // A refusal, not "nobody is signed in": the same turn once more, and no window for it.
        if (was.plain) return 'no';
        tell(`${entry.name} refused ${whose} for its sign-in. Plenum sent the turn again.`);
        return mark('plain');
      } else if (!was.plain && answer === true) {
        // No check of its own to ask, and a sign-in for it is on this PC: the same turn once more, before any window is opened.
        tell(`${entry.name} said it is not signed in, although a sign-in for it is on this PC. Plenum sent ${whose} again.`);
        return mark('plain');
      }
      // The program said in its run that nobody is signed in, and nothing says otherwise (a program without a check of its own has
      // now said it twice, or has no sign-in on this PC): the window, the wait, then again. A repair of this run that ended with a
      // sign-in is over: what the program says now is a new sign-out, with a repair of its own.
      if (repairs.get(provider)?.end === 'in') repairs.delete(provider);
      const job = repair(ref);
      // The program's own run said it: the turns after this one are not sent on the chance that its check was wrong (ready).
      job.confirmed = true;
      const end = await job.done;
      if (end !== 'in' || signal?.aborted) return 'no';
      tell(`Plenum sent ${whose} again.`);
      return mark('repaired');
    },

    // A turn of this program ran and answered: it is signed in. Its window is off the list (the next sign-out gets a new one), and
    // the turns that wait for its sign-in run. Nothing is taken from a model that runs with a key. Returns nothing, never throws.
    worked(ref) {
      const entry = entryOf(ref);
      const provider = providerOf(ref);
      if (!entry || (!windows.has(provider) && !repairs.has(provider))) return;
      Promise.resolve(first.get(ref) ?? ask(ref)).then(answer => {
        if (answer === NONE) return;
        windows.delete(provider);
        const job = repairs.get(provider);
        if (job) job.worked = true;
      }).catch(() => {});
    },
  };
}

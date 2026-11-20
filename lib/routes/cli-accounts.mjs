// Accounts routes for the coding agents added after the first four (Cursor and Grok Build).
//   GET  /api/accounts/cli           -> { cursor: { installed, signedIn, email }, grok: { installed, signedIn, email } }
//                                       (cursor: lib/cursor.mjs cursorStatus, cached 20 seconds; grok: lib/grok.mjs grokStatus, local files only)
//   POST /api/accounts/cursor/login  -> { ok: true }   opens a terminal running `agent login` (lib/cursor.mjs cursorSignIn)
//   POST /api/accounts/grok/login    -> { ok: true }   opens a terminal running `grok login` (lib/grok.mjs grokSignIn)
//   POST /api/accounts/antigravity/login -> { ok: true } opens a terminal running `agy acp --login` (lib/antigravity.mjs)
// From the phone (x-plenum-device, set by the Bridge) the three POSTs answer { ok: true, where: 'computer', text }: the sign-in opened on
// the computer, and the text says so in one sentence (signInAnswer). Each POST also clears the team's "needs sign-in" mark of that program.
// The GET also reports antigravity: { installed, signedIn, email, tier }.
// The GET never holds the Accounts panel (DECISIONS item 91): it answers from what is known (the Cursor and Grok Build readings of the last
// 10 seconds, Antigravity's last model read) and starts a read in the background where that is older. Only the first call, with nothing
// known yet, waits for the readings, at most 1.5 s, and then says pending: true with the fields unknown. ?refresh=... (Accounts'
// Refresh) drops the kept CLI lookups and waits for fresh readings, at most 4 s. The sign-in routes make the next read start at once.
// The GET runs the Cursor CLI's status command, which reaches Cursor's service, so it waits for the terms like /api/accounts does
// (gated: true, see lib/legal.mjs). The POST always waits for the terms (every POST does, lib/routes/index.mjs).
import { cursorSignIn, cursorStatus, forgetCursorStatus } from '../cursor.mjs';
import { grokSignIn, grokStatus } from '../grok.mjs';
import { agyCommand, antigravitySignIn, antigravityStatus, refreshAntigravityModels } from '../antigravity.mjs';
import os from 'node:os';
import { forgetExecutables } from '../proc.mjs';
import { invalidateProviderStatus } from '../provider-status.mjs';
import { noteSignInOpened } from '../signin-check.mjs';
import { clearSignIn } from '../team.mjs';

export const routes = [
  { method: 'GET', path: '/api/accounts/cli', handler: cliStatus, gated: true },
  { method: 'POST', path: '/api/accounts/cursor/login', handler: cursorLogin },
  { method: 'POST', path: '/api/accounts/grok/login', handler: grokLogin },
  { method: 'POST', path: '/api/accounts/antigravity/login', handler: antigravityLogin },
];

const FRESH_MS = 10_000;
const FIRST_WAIT_MS = 1500;
const REFRESH_WAIT_MS = 4000;
let known = null; // { cursor, grok, at }
let flight = null;
let waitedOnce = false; // only the very first call waits for the readings (a read that keeps failing must not hold every call)
// Each read gets a number when it starts; what it found is kept only when no read that started after it has already been kept, so an
// older read that ends late never puts back what was true before a Refresh.
let started = 0;
let kept = 0;

// Reads the Cursor and Grok Build status once at a time. Never throws. fresh (Accounts' Refresh) starts a read of its own that asks the CLI
// now (cursorStatus fresh), instead of joining a read that began before the press, for example before a sign-in finished.
function readKnown({ fresh = false } = {}) {
  if (flight && !fresh) return flight;
  const n = ++started;
  const mine = Promise.all([fresh ? cursorStatus({ fresh: true }) : cursorStatus(), grokStatus()])
    .then(([cursor, grok]) => {
      if (n < kept) return;
      kept = n;
      known = { cursor, grok, at: Date.now() };
    })
    .catch(() => {})
    .finally(() => { if (flight === mine) flight = null; });
  flight = mine;
  return mine;
}

const within = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
};

async function cliStatus({ res, json, url }) {
  const refresh = Boolean(url?.searchParams?.get('refresh'));
  const installed = await agyCommand();
  if (refresh) {
    forgetExecutables();
    forgetCursorStatus();
    known = known ? { ...known, at: 0 } : null;
    await within(Promise.all([readKnown({ fresh: true }), installed ? refreshAntigravityModels({ force: true }) : null]), REFRESH_WAIT_MS);
  } else {
    if (!known) {
      if (waitedOnce) readKnown();
      else {
        waitedOnce = true;
        await within(readKnown(), FIRST_WAIT_MS);
      }
    }
    else if (Date.now() - known.at > FRESH_MS) readKnown();
    // Antigravity's models are read in the background (30 minutes between reads), never waited for here.
    if (installed) refreshAntigravityModels().catch(() => {});
  }
  const unknown = { installed: null, signedIn: null, email: null };
  return json(res, 200, {
    cursor: known?.cursor ?? unknown,
    grok: known?.grok ?? unknown,
    antigravity: await antigravityStatus(),
    ...(known ? {} : { pending: true }),
  });
}

// A sign-in was started in a terminal: the next status read starts at once and finds the new state. A council that finds this
// program signed out opens no second window beside this one (lib/signin-check.mjs).
// The team's "needs sign-in" mark for the program goes too (lib/team.mjs), so the next task may use it again.
function afterSignIn(provider, lists = []) {
  noteSignInOpened(provider);
  try {
    clearSignIn(provider);
  } catch {
    // The team's mark ends by itself after 15 minutes.
  }
  if (known) known = { ...known, at: 0 };
  invalidateProviderStatus({ lists });
}

const PROGRAM_NAMES = { antigravity: 'Antigravity', cursor: 'Cursor', grok: 'Grok Build' };
// The computer's name as the phone shows it, or "your computer" when it cannot be read.
function computerName() {
  try {
    const name = String(os.hostname() ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return name || 'your computer';
  } catch {
    return 'your computer';
  }
}

// What a sign-in route answers. A request that came from the phone (the Bridge sets x-plenum-device for a paired phone only, lib/remote/
// proxy.mjs) is told where the sign-in opened, since the window is on the computer and not in the person's hand; the desktop page gets
// { ok: true } as before.
export function signInAnswer(req, provider) {
  const device = req?.headers?.['x-plenum-device'];
  if (typeof device !== 'string' || !device.trim()) return { ok: true };
  const program = PROGRAM_NAMES[provider] ?? 'the program';
  return { ok: true, where: 'computer', text: `Plenum opened the ${program} sign-in on ${computerName()}. Finish it there; your waiting turns run when it is done.` };
}

async function antigravityLogin({ req, res, json }) {
  await antigravitySignIn();
  afterSignIn('antigravity');
  return json(res, 200, signInAnswer(req, 'antigravity'));
}

async function cursorLogin({ req, res, json }) {
  await cursorSignIn();
  afterSignIn('cursor');
  return json(res, 200, signInAnswer(req, 'cursor'));
}

async function grokLogin({ req, res, json }) {
  await grokSignIn();
  afterSignIn('grok');
  return json(res, 200, signInAnswer(req, 'grok'));
}

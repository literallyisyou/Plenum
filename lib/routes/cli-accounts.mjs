// Accounts routes for the coding agents added after the first four (Cursor and Grok Build).
//   GET  /api/accounts/cli           -> { cursor: { installed, signedIn, email }, grok: { installed, signedIn, email } }
//                                       (cursor: lib/cursor.mjs cursorStatus, cached 20 seconds; grok: lib/grok.mjs grokStatus, local files only)
//   POST /api/accounts/cursor/login  -> { ok: true }   opens a terminal running `agent login` (lib/cursor.mjs cursorSignIn)
//   POST /api/accounts/grok/login    -> { ok: true }   opens a terminal running `grok login` (lib/grok.mjs grokSignIn)
//   POST /api/accounts/antigravity/login -> { ok: true } opens a terminal running `agy acp --login` (lib/antigravity.mjs)
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
import { forgetExecutables } from '../proc.mjs';
import { invalidateProviderStatus } from '../provider-status.mjs';

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

// Reads the Cursor and Grok Build status once at a time. Never throws.
function readKnown() {
  if (!flight) {
    flight = Promise.all([cursorStatus(), grokStatus()])
      .then(([cursor, grok]) => { known = { cursor, grok, at: Date.now() }; })
      .catch(() => {})
      .finally(() => { flight = null; });
  }
  return flight;
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
    await within(Promise.all([readKnown(), installed ? refreshAntigravityModels({ force: true }) : null]), REFRESH_WAIT_MS);
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

// A sign-in was started in a terminal: the next status read starts at once and finds the new state.
function afterSignIn(lists = []) {
  if (known) known = { ...known, at: 0 };
  invalidateProviderStatus({ lists });
}

async function antigravityLogin({ res, json }) {
  await antigravitySignIn();
  afterSignIn();
  return json(res, 200, { ok: true });
}

async function cursorLogin({ res, json }) {
  await cursorSignIn();
  afterSignIn();
  return json(res, 200, { ok: true });
}

async function grokLogin({ res, json }) {
  await grokSignIn();
  afterSignIn();
  return json(res, 200, { ok: true });
}

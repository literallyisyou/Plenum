// Background services (wave 3, BUSINESS-DESIGN.md section 7): the one place that says what runs, why not, and has one button to put each
// thing right. It is also where setting up is finished. lib/hub-starter.mjs runs the hub's launcher; public/ext-services.js draws this.
//
// THE CONTRACT (pinned by build/v06/ultra-w3-services):
//   GET  /api/services               -> { services: [{ id, label, state: running|starting|stopped|needs-you|off|unknown, why, action: { id, label } | null }],
//                                        autostart: { supported, on, reason }, hubAtStart: { on, follows }, checking,
//                                        hubEngine: docker|local|unknown|null, repaired: [{ at, text }] }  (hubEngine: how the hub runs, from
//                                       the last reading of the starter's state; null before there is one. The page words its Docker
//                                       sentences by it. repaired: what Plenum put right by itself in this run, newest first, 20 at most,
//                                       in Plenum's own words (lib/hub-starter.mjs repaired()), for "Fixed by itself". Rows are unchanged.)
//                                       From memory and cached readings only: it starts no CLI and reaches no network. It never waits
//                                       for the hub's launcher: it answers from the last reading and starts a new one in the background.
//                                       Rows: server (Plenum's own server, with its build line), sign-ins (how many are ready), hub
//                                       (Plenum Hub and its helper), routines (the scheduler) while lib/routines.mjs is there, and business while lib/business.mjs is
//                                       there and no business exists. A reader that throws shows as unknown and breaks nothing.
//   POST /api/services/autostart     { on }  reaches desktop/handlers/autostart.cjs through the desktop channel; 503 outside the desktop app
//   POST /api/services/hub-at-start  { on }  true or false (the person's choice), or null (follow Connect agents again)
//   POST /api/services/action        { id: hub-start | hub-setup | hub-check }  hub-start and hub-setup run the launcher's `up`
//   Each POST answers as GET and publishes { type: "services", reason }.
// Action ids that start with "open-" (open-accounts, open-hub, open-businesses) are the page's own: it opens that part of Plenum.
// There is no registry of services: the rows are read here, by one route. A later service is one more reader in READERS.
// The server checks the Plenum token on every /api/ request before a handler runs, and every POST waits for the License Agreement; the
// POSTs check the token here as well. No answer holds a key, a token or the launcher's output as it came.
import { requireToken } from '../auth.mjs';
import { API_PROVIDERS } from '../api-providers.mjs';
import { buildLine } from '../build-info.mjs';
import { keyStatus } from '../keys.mjs';
import { readinessFrom } from '../model-info.mjs';
import { CODE_ROOT, moduleUrl } from '../overlay.mjs';
import { knownProviders } from '../provider-status.mjs';
import { shellAvailable, shellRequest } from '../shell.mjs';
import { CONTRACT, defaultWatch, repaired } from '../hub-starter.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const row = (id, label, state, why, action = null) => ({ id, label, state, why, action });
const act = (id, label) => ({ id, label });
const UNREAD = 'Plenum could not read this.';
const DOCKER_WINDOW = 'Starting the hub opens Docker\'s own window, unless you turned that off in Docker\'s settings.';
const DOCKER_MAYBE = 'If Docker Desktop is closed, starting the hub opens Docker\'s own window.';
const CHECK = act('hub-check', 'Check again');
// Docker is named only for a hub that runs in Docker (state.engine "docker"). With engine "local" Docker is not asked and not needed; an
// engine Plenum does not know gets neutral words (hub-answers.md section 5).
const inDocker = h => h.engine === 'docker';
const LOCAL_NOTE = 'It runs on this computer, without Docker.';
const NEWER_NOTE = 'This hub\'s starter speaks a newer version than this Plenum knows. Plenum shows what it understands; update Plenum if something looks wrong.';
// The hub's own sentence about why it is down, when it says more than "not running": the starter keeps what the last try to bring the
// hub up ended with in its message until the hub runs again. The plain sentences are Plenum's own to say.
const PLAIN = /^(the|plenum) hub (is not running|has not been set up)\b/i;
const reasonOf = h => (typeof h.message === 'string' && h.message && !PLAIN.test(h.message) ? h.message : '');
// Sentences in a row, each said once and each with its full stop.
const join = (...parts) => [...new Set(parts.filter(Boolean))].map(p => (/[.!?]$/.test(p) ? p : `${p}.`)).join(' ');

// The hub's row from what the watch knows: { reading, up, settling, checking, folder }. At most one button for each answer of the hub
// (the table of BUSINESS-DESIGN.md section 7). Pure: it reads nothing.
// A sentence of the hub that needs the person (needs_you) never takes the way to start the hub away: the starter keeps that sentence
// after a failed start until the hub runs again, so "Check again" alone stands only where Plenum can do nothing (the setup is needed
// and something must be installed first, or Docker Desktop is not on this computer).
export function hubRow(snap) {
  const label = 'Plenum Hub';
  const s = isObject(snap) ? snap : {};
  const res = s.reading;
  if (!res) return row('hub', label, 'unknown', 'Checking Plenum Hub...');
  if (!res.ok) {
    if (res.why === 'off') return row('hub', label, 'off', 'Plenum does not check or start the hub in this run.');
    if (res.why === 'terms') return row('hub', label, 'unknown', 'Plenum checks the hub once the License Agreement is accepted.');
    if (res.why === 'missing') return row('hub', label, 'off', `No hub was found in ${s.folder || 'the hub\'s folder'}. Its folder is set in Settings > Agents > Plenum Hub.`, act('open-hub', 'Open that section'));
    if (res.why === 'older') return row('hub', label, 'unknown', 'This hub\'s starter is older and cannot be started from Plenum yet. Update the hub, or start it from its own menu.');
    if (res.why === 'timeout') return row('hub', label, 'unknown', 'The hub\'s starter did not answer in time.', CHECK);
    return row('hub', label, 'unknown', 'The hub\'s starter could not be read.', CHECK);
  }
  // A starter with a newer contract is read as far as it is known, and says so.
  const r = hubRowOf(res.state, s);
  return Number.isFinite(res.state.contract) && res.state.contract > CONTRACT ? { ...r, why: join(r.why, NEWER_NOTE) } : r;
}

// The row for a reading the starter answered (its contract is 2 or later).
function hubRowOf(h, s) {
  const label = 'Plenum Hub';
  // What the last `up` of this run came to, while the state has not caught up with it.
  const upRes = s.up?.res;
  if (h.setup === 'running' || h.hub === 'starting') return row('hub', label, 'starting', h.message || 'Plenum Hub is starting.');
  // An `up` of a moment ago answered "starting" and the state does not say so yet (the helper takes a few seconds): no button meanwhile.
  // Not when the state has something to say by now (a sentence for the person, a reason, Docker not found): that is shown at once.
  const news = Boolean(h.needs_you) || (inDocker(h) && h.docker === 'missing') || h.setup === 'needed' || (h.hub === 'down' && Boolean(reasonOf(h)));
  if (s.settling === true && upRes?.ok && !news && !(h.hub === 'up' && h.helper === 'running')) {
    return row('hub', label, 'starting', h.hub === 'up' ? 'Plenum Hub is running. Its helper is starting.' : upRes.up.message || 'Plenum Hub is starting.');
  }
  if (h.setup === 'needed') {
    // Something the person has to do first (Node.js is missing): Plenum can do nothing until then.
    if (h.needs_you) return row('hub', label, 'needs-you', h.needs_you, CHECK);
    const parts = ['Plenum Hub is not set up on this computer yet.'];
    if (h.missing.length) parts.push(`Missing: ${h.missing.join(', ')}.`);
    if (inDocker(h) && h.docker !== 'running') parts.push(DOCKER_WINDOW);
    return row('hub', label, 'needs-you', parts.join(' '), act('hub-setup', 'Set up the hub'));
  }
  if (h.hub === 'down') {
    // Why it is down, when something said so: the hub's own reason first, else what the last press in this run of Plenum came to.
    const said = reasonOf(h) || (upRes?.ok && upRes.up.hub === 'failed' ? upRes.up.message : upRes && !upRes.ok && upRes.why === 'timeout' ? 'The hub\'s starter did not answer in time.' : '');
    if (inDocker(h) && h.docker === 'missing') return row('hub', label, 'needs-you', h.needs_you || join(said, 'Plenum Hub is not running. It needs Docker Desktop, which was not found on this computer.'), CHECK);
    // Nothing can open Docker's window unless the hub runs in Docker and Docker is not known to run.
    const quiet = !inDocker(h) || h.docker === 'running';
    const start = act('hub-start', quiet ? 'Start' : 'Start anyway');
    // The hub's sentence stays as it is, and so does the way to start: the person may have done by now what it asks for.
    if (h.needs_you) return row('hub', label, 'needs-you', join(said, h.needs_you, quiet ? '' : h.docker === 'stopped' ? DOCKER_WINDOW : DOCKER_MAYBE), start);
    if (quiet) return row('hub', label, 'stopped', join(said, 'Plenum Hub is not running.', h.engine === 'local' ? 'It does not need Docker.' : ''), start);
    if (h.docker === 'stopped') return row('hub', label, 'stopped', join(said, 'Docker Desktop is closed.', DOCKER_WINDOW), start);
    return row('hub', label, 'stopped', join(said, 'Plenum Hub is not running, and Docker Desktop did not say whether it is open. If it is closed, starting the hub opens Docker\'s own window.'), start);
  }
  if (h.hub === 'up') {
    if (h.helper === 'stopped') return row('hub', label, 'needs-you', join(h.needs_you, 'Plenum Hub is running. Its helper is not, so sleeping agents are not woken.'), act('hub-start', 'Start the helper'));
    if (h.needs_you) return row('hub', label, 'needs-you', h.needs_you, CHECK);
    const parts = [`Running${h.version ? `, version ${h.version}` : ''}.`];
    if (h.engine === 'local') parts.push(LOCAL_NOTE);
    if (h.helper === 'running' && h.helper_starts_with_windows !== null) parts.push(`The hub's helper is ${h.helper_starts_with_windows ? '' : 'not '}set to start with Windows.`);
    return row('hub', label, 'running', parts.join(' '));
  }
  if (h.needs_you) return row('hub', label, 'needs-you', h.needs_you, CHECK);
  return row('hub', label, 'unknown', h.message || 'The hub\'s starter gave an answer Plenum does not know.', CHECK);
}

// The sign-ins: how many providers can answer now. status is the provider snapshot (null before the first one).
export function signInsRow(status, keys, readiness = readinessFrom) {
  const label = 'Sign-ins';
  const open = act('open-accounts', 'Open Accounts');
  if (!status) return row('sign-ins', label, 'unknown', 'Plenum is still checking your sign-ins.', open);
  const all = Object.entries(readiness(status, keys)).filter(([id]) => id !== 'echo').map(([, r]) => r);
  const ready = all.filter(r => r.ready).length;
  if (ready === 0) return row('sign-ins', label, 'needs-you', 'No model is signed in yet. Sign in to one, or add an API key.', open);
  return row('sign-ins', label, 'running', `${ready} of ${all.length} providers are ready.`, open);
}

const clockTime = at => {
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
};
// The routines scheduler, from routines.schedulerState(): { on, lastTick, paused, why }. mod is lib/routines.mjs or null.
export function routinesRow(mod) {
  const label = 'Routines';
  if (!mod || typeof mod.schedulerState !== 'function') return row('routines', label, 'off', 'This build of Plenum has no routines yet.');
  const s = mod.schedulerState();
  if (!isObject(s)) return row('routines', label, 'unknown', UNREAD);
  // why is the scheduler's own sentence for a pause (everything paused, switched off for this run).
  if (s.paused) return row('routines', label, 'off', typeof s.why === 'string' && s.why.trim() ? s.why.trim().slice(0, 240) : 'Paused. No routine starts until you resume.');
  if (!s.on) return row('routines', label, 'off', 'No routine is switched on, so nothing is scheduled.');
  const looked = Number.isFinite(s.lastTick) ? clockTime(s.lastTick) : '';
  return row('routines', label, 'running', `On.${looked ? ` Last looked at ${looked}.` : ''}`);
}

const NO_DESKTOP = 'Start with Windows works in the Plenum desktop app, and Plenum was started with node.';
const AUTOSTART_MS = 1_200;
const AUTOSTART_AGAIN_MS = 30_000;
const AUTOSTART_MISSING_MS = 600_000;

export function createServices(deps = {}) {
  const d = {
    watch: deps.watch ?? (() => defaultWatch()),
    buildLine: deps.buildLine ?? (() => buildLine()),
    providers: deps.providers ?? knownProviders,
    keys: deps.keys ?? (() => Promise.all(API_PROVIDERS.map(async p => ({ id: p.id, configured: (await keyStatus(p.id)).configured === true })))),
    readiness: deps.readiness ?? readinessFrom,
    // Neighbour packages, loaded on first use and kept; a missing or broken one is null and its row says so.
    routines: deps.routines ?? neighbour('lib/routines.mjs'),
    business: deps.business ?? neighbour('lib/business.mjs'),
    shellAvailable: deps.shellAvailable ?? shellAvailable,
    shellRequest: deps.shellRequest ?? shellRequest,
    now: deps.now ?? (() => Date.now()),
    repaired: deps.repaired ?? repaired,
  };
  const watch = () => (typeof d.watch === 'function' ? d.watch() : d.watch);

  // ----- Start with Windows: what the desktop app last said -----
  let auto = null; // { at, value }
  let asking = null;
  const autoValue = (supported, on, reason) => ({ supported, on, reason });
  function askAutostart() {
    if (asking) return asking;
    asking = Promise.resolve()
      .then(() => d.shellRequest('autostart-get', {}, { timeoutMs: AUTOSTART_MS }))
      .then(
        // The installed app answers supported: true. A copy that is not installed answers false: the switch says where it works.
        reply => autoValue(reply?.supported === true, reply?.supported === true && reply?.on === true, reply?.supported === true ? '' : 'installed'),
        // No answer: this desktop build has no handler for it yet.
        () => autoValue(false, false, 'next-build'),
      )
      .then(value => {
        auto = { at: d.now(), value };
        asking = null;
        return value;
      });
    return asking;
  }
  async function autostart() {
    if (!d.shellAvailable()) return autoValue(false, false, 'desktop');
    if (!auto) return askAutostart();
    const age = d.now() - auto.at;
    if (age >= (auto.value.reason === 'next-build' ? AUTOSTART_MISSING_MS : AUTOSTART_AGAIN_MS)) void askAutostart().catch(() => {});
    return auto.value;
  }
  async function setAutostart(on) {
    if (!d.shellAvailable()) throw Object.assign(new Error(NO_DESKTOP), { status: 503 });
    let reply;
    try {
      reply = await d.shellRequest('autostart-set', { on }, { timeoutMs: 5_000 });
    } catch (err) {
      throw Object.assign(new Error(err?.status === 504 ? 'This build of the desktop app cannot start with Windows yet. It comes with the next build.' : 'The desktop app could not change this. Try again.'), { status: err?.status === 504 ? 503 : 500 });
    }
    if (reply?.supported !== true) throw Object.assign(new Error('Start with Windows works in the installed app.'), { status: 409 });
    if (reply.ok === false) throw Object.assign(new Error('Windows did not take the change. Try again.'), { status: 500 });
    auto = { at: d.now(), value: autoValue(true, reply.on === true, '') };
    return auto.value;
  }

  // ----- the rows -----
  const guarded = async (id, label, read) => {
    try {
      return await read();
    } catch {
      return row(id, label, 'unknown', UNREAD);
    }
  };
  // One reader for each row, in the order of the page. A reader answers a row, or null for no row.
  const READERS = [
    ['server', 'Plenum', async () => row('server', 'Plenum', 'running', `${String(d.buildLine())}. Its server is running on this computer.`)],
    ['sign-ins', 'Sign-ins', async () => {
      const status = d.providers();
      return signInsRow(status, status ? await d.keys() : [], d.readiness);
    }],
    ['hub', 'Plenum Hub', async () => hubRow(watch().look())],
    // No row while lib/routines.mjs is not part of this build (as for Businesses): the list says what runs, not what is still to come.
    ['routines', 'Routines', async () => {
      const mod = await d.routines();
      return mod ? routinesRow(mod) : null;
    }],
    ['business', 'Businesses', async () => {
      const mod = await d.business();
      if (!mod || typeof mod.list !== 'function') return null;
      const list = await mod.list();
      if (!Array.isArray(list) || list.length > 0) return null;
      return row('business', 'Businesses', 'needs-you', 'No business yet.', act('open-businesses', 'Start your first business'));
    }],
  ];

  async function answer() {
    const [services, auto1] = await Promise.all([
      Promise.all(READERS.map(([id, label, read]) => guarded(id, label, read))),
      autostart().catch(() => autoValue(false, false, 'desktop')),
    ]);
    let hubAtStart = { on: false, follows: true };
    let checking = false;
    try {
      hubAtStart = watch().hubAtStart();
      checking = watch().snapshot().checking === true;
    } catch {
      // The switch shows as off and following.
    }
    let hubEngine = null;
    try {
      const reading = watch().snapshot().reading;
      hubEngine = reading?.ok ? reading.state.engine : null;
    } catch {
      // Not known: the page words its sentences neutrally.
    }
    let fixed = [];
    try {
      const list = d.repaired();
      fixed = Array.isArray(list) ? list.filter(r => isObject(r) && Number.isFinite(r.at) && typeof r.text === 'string').slice(0, 20).map(r => ({ at: r.at, text: r.text })) : [];
    } catch {
      // Nothing to show as fixed.
    }
    return { services: services.filter(Boolean), autostart: auto1, hubAtStart, checking, hubEngine, repaired: fixed };
  }

  return { answer, setAutostart, watch };
}

// A neighbour package, loaded with import() inside try on first use and kept; null when it is missing or broken.
function neighbour(rel) {
  let p = null;
  return () => (p ??= import(moduleUrl(rel, CODE_ROOT)).then(m => m, () => null));
}

let services0 = null;
const services = () => (services0 ??= createServices());
const refuse = (httpError, err) => httpError(Number.isInteger(err?.status) ? err.status : 500, String(err?.message || 'The change was not made.'));

export const routes = [
  {
    method: 'GET',
    path: '/api/services',
    handler: async ({ res, json }) => json(res, 200, await services().answer()),
  },
  {
    method: 'POST',
    path: '/api/services/autostart',
    handler: async ({ req, res, json, readBody, httpError, events }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body) || typeof body.on !== 'boolean') throw httpError(400, 'Send on as true or false.');
      try {
        await services().setAutostart(body.on);
      } catch (err) {
        throw refuse(httpError, err);
      }
      events.publish({ type: 'services', reason: 'autostart' });
      return json(res, 200, await services().answer());
    },
  },
  {
    method: 'POST',
    path: '/api/services/hub-at-start',
    handler: async ({ req, res, json, readBody, httpError }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body) || (typeof body.on !== 'boolean' && body.on !== null)) throw httpError(400, 'Send on as true or false.');
      try {
        await services().watch().setHubAtStart(body.on); // publishes { type: 'services', reason: 'hub-at-start' }
      } catch (err) {
        throw refuse(httpError, err);
      }
      return json(res, 200, await services().answer());
    },
  },
  {
    method: 'POST',
    path: '/api/services/action',
    handler: async ({ req, res, json, readBody, httpError }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body) || typeof body.id !== 'string') throw httpError(400, 'Send the id of the action.');
      try {
        await services().watch().act(body.id); // publishes { type: 'services', reason: <the id> }
      } catch (err) {
        throw refuse(httpError, err);
      }
      return json(res, 200, await services().answer());
    },
  },
];

// The one timer this file sets: 20 seconds after the routes loaded, the look at start (lib/hub-starter.mjs startCheck, which looks
// again once a minute for at most ten minutes while only Docker Desktop is in the way). It reads nothing now, does not keep the
// process alive, and is not set at all in the smoke mode or with PLENUM_NO_SERVICES=1.
try {
  defaultWatch().armStart();
} catch {
  // Without the timer the section still works; the hub is then brought up by its button.
}

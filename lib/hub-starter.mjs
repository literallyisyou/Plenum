// The hub's starter, contract version 2 (wave 3, BUSINESS-DESIGN.md section 7; the contract itself is docs/PLENUM-INTEGRATION.md in the hub's
// folder). Plenum brings Plenum Hub and its helper up, hidden, and says what runs. lib/hub.mjs is not changed: it keeps agent-key and
// owner-status. This module runs the three commands of version 2 and keeps what the Background services section needs.
//
// THE CONTRACT THIS MODULE OWNS (pinned by build/v06/ultra-w3-services):
//   createHubStarter({ folder, spawn, clock, env, accepted, scrub, platform, limits }) -> { state, up, wake, folder }, and a default instance
//   (state, up, wake below) whose folder is hub.status().settings.starterFolder.
//     state()      runs `state --json` (8 s)  -> { ok: true, state: { contract, setup: ready|needed|running|unknown, hub: up|down|starting|unknown,
//                  version, helper: running|stopped|unknown, helper_starts_with_windows: true|false|null, engine: docker|local|unknown,
//                  docker: running|stopped|missing|null, hands_off: true|false|null, needs_you, missing: [], admin_url, message } }
//                  | { ok: false, why: missing|older|timeout|failed|off|terms }
//     up()         runs `up --json` (30 s)    -> { ok: true, up: { hub: up|starting|failed|unknown, helper: running|starting|stopped|unknown,
//                  needs_you, message } } (exit code 1 with "hub":"failed" is an answer) | { ok: false, why }
//     wake(agent)  runs `wake <agent> --json` (15 s) -> { ok: true, agent } | { ok: false, code, message } with the contract's codes (paused,
//                  stopped, everything_paused, no_helper, not_wakeable, unknown_agent, hub_down, not_set_up, failed) or older, missing,
//                  timeout, off, terms. The program hand-off calls it (DELEGATION-DESIGN.md section 15.6).
//   createHubWatch({ starter, clock, dir, env, accepted, connectAgents, publish, write }) -> what the section shows and the two switches:
//     look() (the section is on screen: renews a lease of 60 s, starts a reading in the background when one is due, answers from memory),
//     refresh(), act(id: hub-start|hub-setup|hub-check), hubAtStart() -> { on, follows }, setHubAtStart(on), armStart(), startCheck(), stop().
//     The snapshot is { reading, at, up, settling, checking, folder }; settling is true for about 30 s after an `up` that answered
//     "starting", until the state says the hub is up with its helper.
//   services.json in the data folder: { v: 1, hubAtStart: null | true | false }; null follows Connect agents. migrate(raw) reads a file
//   of any age; a file from a newer Plenum is read and never written.
//
// THE RULES IN THIS CODE:
//  - It runs the hub's LAUNCHER (Tabletalk.cmd through cmd.exe /d /s /c on Windows, tabletalk.sh elsewhere), never cli.js: only the launcher
//    answers in a folder whose starter is not built. Hidden, nothing on its input, an environment without anything that looks like a key
//    and without what is Plenum's own (ENV_DROP: ELECTRON_*, NODE_OPTIONS, PORT, MUSE_CONSOLE_*, PLENUM_*; `up` hands its environment on
//    to Docker Desktop, to the hub's helper and to every agent the helper wakes, and an Electron program that inherits
//    ELECTRON_RUN_AS_NODE=1 from Plenum's server runs as plain Node and shows nothing), arguments checked against ARG_OK, and a time
//    limit. The output is never logged and never leaves this module as it came.
//  - The answer is the last line that parses as a JSON object. Exit code 2, or no such line, is an OLDER starter, not a failure.
//  - The answer is taken when the launcher's own process ends (the exit event, not close): `up` leaves a job behind that may hold the
//    output open, and that job must outlive the call. Once a JSON line was read the process tree is never ended. The tree is ended only
//    when the limit passes with no answer line.
//  - Unknown fields are ignored, an unknown value is "unknown", null means "not known" and never "no", an admin_url that is not plain http
//    on this computer is dropped, and message and needs_you go through hub.scrub and are cut at 240 characters.
//  - One call of each command at a time: a second caller gets the first one's answer.
//  - With PLENUM_NO_SERVICES=1 in the environment nothing is started: every answer is { ok: false, why: "off" } (wake: code "off"). The
//    default folder is the person's real hub, and tests of other parts open the page this section is on.
//  - Never before the License Agreement is accepted (termsAccepted of lib/legal.mjs), whoever asks: why "terms".
//  - Plenum never stops or rebuilds the hub, never runs Docker, and never changes hands-off mode or whether the helper starts with Windows.
//    When Plenum starts it calls `up` by itself only when nothing can show on the screen and nothing is installed: the setup is ready, the
//    hub is down or its helper stopped, and Docker is running or the engine is local. At a sign-in to Windows Docker Desktop is often
//    still starting at that moment, so while that is the only thing in the way (or the License Agreement is not accepted yet, or the
//    starter did not answer) the state is read again every 60 seconds, ten minutes at most, and `up` is called once when it fits.
//    Reading the state starts nothing.
//  - Nothing here runs when the module loads. No timer exists until armStart() is called (lib/routes/services.mjs calls it once).
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as hub from './hub.mjs';
import * as store from './store.mjs';
import * as events from './events.mjs';
import { termsAccepted } from './legal.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

export const LIMITS = Object.freeze({ state: 8_000, up: 30_000, wake: 15_000 });
export const ARG_OK = /^(--json|[a-z0-9][a-z0-9_-]{0,63})$/;
export const WAKE_CODES = Object.freeze(['paused', 'stopped', 'everything_paused', 'no_helper', 'not_wakeable', 'unknown_agent', 'hub_down', 'not_set_up', 'failed']);
// What Plenum itself says when the launcher gave no sentence, or was never asked.
export const WAKE_TEXT = Object.freeze({
  off: 'Plenum does not start the hub\'s programs in this run.',
  terms: 'Accept the Plenum License Agreement first.',
  missing: 'No hub was found in the folder set in Settings > Agents > Plenum Hub.',
  older: 'This hub\'s starter is older and cannot wake an agent from Plenum yet. Update the hub.',
  timeout: 'The hub\'s starter did not answer in time.',
  unknown_agent: 'There is no agent of that name on the hub.',
  failed: 'The hub could not wake this agent.',
});
// Names that never reach the launcher, whatever their case: what looks like a key, and what belongs to Plenum's own processes.
export const ENV_DROP = Object.freeze([/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i, /(^|_)PAT$/i, /^ELECTRON_/i, /^NODE_OPTIONS$/i, /^PORT$/i, /^MUSE_CONSOLE_/i, /^PLENUM_/i]);
const MAX_OUT = 65_536;
const MAX_TEXT = 240;
// After the launcher's process ended: how long its last output may still be on its way to us.
const DRAIN_MS = 400;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const asFn = v => (typeof v === 'function' ? v : () => v);
const oneOf = (value, list, other = 'unknown') => (list.includes(value) ? value : other);
const triState = v => (v === true ? true : v === false ? false : null);

const REAL_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: t => clearTimeout(t),
});
const clockOf = clock => ({ ...REAL_CLOCK, ...(isObject(clock) ? clock : {}) });

// The folder the starter lives in: an absolute path with no character a command line could misread (the rule of lib/hub.mjs).
function cleanFolder(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > 260 || /[\u0000-\u001f"%^&|<>!`$]/.test(v) || !path.isAbsolute(v)) return null;
  return v;
}

// The last non-empty line of the output that parses as a JSON object, or null.
export function lastObject(out) {
  const lines = String(out ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i][0] !== '{') continue;
    try {
      const json = JSON.parse(lines[i]);
      if (isObject(json)) return json;
    } catch {
      // Not the line.
    }
  }
  return null;
}

// The owner's screens, only as plain http on this computer; anything else is dropped.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
export function loopbackUrl(value) {
  if (typeof value !== 'string' || value.length > 300) return null;
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname) || u.username || u.password) return null;
  return `http://${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname === '/' ? '' : u.pathname}`;
}

export function createHubStarter(deps = {}) {
  const d = {
    folder: asFn(deps.folder ?? (() => hub.status().settings.starterFolder)),
    spawn: deps.spawn ?? nodeSpawn,
    clock: clockOf(deps.clock),
    env: asFn(deps.env ?? (() => process.env)),
    accepted: deps.accepted ?? (() => termsAccepted(store.get())),
    scrub: deps.scrub ?? hub.scrub,
    platform: deps.platform ?? process.platform,
    // The time limits, for tests; the real ones are LIMITS.
    limits: { ...LIMITS, ...(isObject(deps.limits) ? deps.limits : {}) },
  };
  const inflight = new Map(); // command line -> Promise

  // One sentence the hub wrote, safe to show: no key we hold, one line, 240 characters at most. null when there is none.
  const sentence = value => {
    if (typeof value !== 'string') return null;
    const text = String(d.scrub(value)).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    return text || null;
  };
  const word = (value, max = 40) => (typeof value === 'string' && /^[\w .+-]{1,80}$/.test(value.trim()) ? value.trim().slice(0, max) : null);

  function folderNow() {
    try {
      return cleanFolder(d.folder());
    } catch {
      return null;
    }
  }
  const launcher = folder => path.join(folder, d.platform === 'win32' ? 'Tabletalk.cmd' : 'tabletalk.sh');
  // Why nothing is started, or null.
  function held() {
    let env = {};
    try {
      env = d.env() ?? {};
    } catch {
      env = {};
    }
    if (env.PLENUM_NO_SERVICES === '1') return 'off';
    let ok = false;
    try {
      ok = d.accepted() === true;
    } catch {
      ok = false;
    }
    return ok ? null : 'terms';
  }
  // The environment the launcher runs in: ours without anything that looks like a key and without Plenum's own variables (ENV_DROP).
  function childEnv() {
    const out = {};
    for (const [k, v] of Object.entries(d.env() ?? {})) if (!ENV_DROP.some(re => re.test(k))) out[k] = v;
    return out;
  }
  function killTree(child) {
    try {
      if (d.platform === 'win32' && child.pid) nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      else child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  // Runs one command of the launcher. Resolves { ran: true, code, json } (json is the answer line or null) or { ran: false, why }.
  function run(args, limitMs) {
    return new Promise(resolve => {
      const folder = folderNow();
      if (!folder) return resolve({ ran: false, why: 'missing' });
      const file = launcher(folder);
      let found = false;
      try {
        found = fs.statSync(file).isFile();
      } catch {
        // Not there.
      }
      if (!found) return resolve({ ran: false, why: 'missing' });
      if (!args.every(a => typeof a === 'string' && ARG_OK.test(a))) return resolve({ ran: false, why: 'failed' });
      let child;
      try {
        const options = { cwd: folder, env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
        child = d.platform === 'win32'
          ? d.spawn(d.env()?.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`], { ...options, windowsVerbatimArguments: true })
          : d.spawn(file, args, options);
      } catch {
        return resolve({ ran: false, why: 'failed' });
      }
      let out = '';
      let done = false;
      let timer = null;
      let drain = null;
      const finish = r => {
        if (done) return;
        done = true;
        d.clock.clearTimeout(timer);
        d.clock.clearTimeout(drain);
        // What a job left behind still writes is read and dropped, so that job never meets a closed pipe; nothing of it is kept.
        out = '';
        try {
          child.unref?.();
          child.stdout?.unref?.();
          child.stderr?.unref?.();
        } catch {
          // Nothing to let go of.
        }
        resolve(r);
      };
      timer = d.clock.setTimeout(() => {
        if (done) return;
        const json = lastObject(out);
        // An answer line was read: it is the answer, and the tree stays (the job behind `up` must outlive the call).
        if (json) return finish({ ran: true, code: null, json });
        killTree(child);
        finish({ ran: false, why: 'timeout' });
      }, limitMs);
      child.stdout?.on('data', chunk => {
        if (!done && out.length < MAX_OUT) out += chunk;
      });
      child.stderr?.on('data', () => {});
      child.stdout?.on('error', () => {});
      child.stderr?.on('error', () => {});
      child.on('error', () => finish({ ran: false, why: 'failed' }));
      const take = code => finish({ ran: true, code, json: lastObject(out) });
      child.on('exit', code => {
        if (done) return;
        if (lastObject(out)) return take(code);
        // The process ended and its last line may still be in the pipe: wait a moment for it, never for the pipe to close.
        drain = d.clock.setTimeout(() => take(code), DRAIN_MS);
      });
      child.on('close', code => take(code));
    });
  }

  // One call of a command at a time: whoever asks while it runs gets the same answer.
  function once(key, make) {
    const going = inflight.get(key);
    if (going) return going;
    const p = Promise.resolve().then(make).catch(() => ({ ok: false, why: 'failed' })).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function stateOf(j) {
    return {
      contract: j.contract,
      setup: oneOf(j.setup, ['ready', 'needed', 'running']),
      hub: oneOf(j.hub, ['up', 'down', 'starting']),
      version: word(j.version),
      helper: oneOf(j.helper, ['running', 'stopped']),
      helper_starts_with_windows: triState(j.helper_starts_with_windows),
      engine: oneOf(j.engine, ['docker', 'local']),
      docker: oneOf(j.docker, ['running', 'stopped', 'missing'], null),
      hands_off: triState(j.hands_off),
      needs_you: sentence(j.needs_you),
      missing: (Array.isArray(j.missing) ? j.missing : []).map(m => sentence(m)?.slice(0, 80)).filter(Boolean).slice(0, 12),
      admin_url: loopbackUrl(j.admin_url),
      message: sentence(j.message) ?? '',
    };
  }
  // A version 2 answer of state or up carries "contract": 2 (or later). Anything else is a starter Plenum cannot read yet.
  const version2 = j => isObject(j) && Number.isFinite(j.contract) && j.contract >= 2 && typeof j.error !== 'string';

  function state() {
    const why = held();
    if (why) return Promise.resolve({ ok: false, why });
    return once('state', async () => {
      const r = await run(['state', '--json'], d.limits.state);
      if (!r.ran) return { ok: false, why: r.why };
      if (r.code === 2 || !r.json) return { ok: false, why: 'older' };
      if (!version2(r.json)) return { ok: false, why: typeof r.json.error === 'string' ? 'failed' : 'older' };
      return { ok: true, state: stateOf(r.json) };
    });
  }

  function up() {
    const why = held();
    if (why) return Promise.resolve({ ok: false, why });
    return once('up', async () => {
      const r = await run(['up', '--json'], d.limits.up);
      if (!r.ran) return { ok: false, why: r.why };
      if (r.code === 2 || !r.json) return { ok: false, why: 'older' };
      if (!version2(r.json)) return { ok: false, why: typeof r.json.error === 'string' ? 'failed' : 'older' };
      const j = r.json;
      return {
        ok: true,
        up: {
          hub: oneOf(j.hub, ['up', 'starting', 'failed']),
          helper: oneOf(j.helper, ['running', 'starting', 'stopped']),
          needs_you: sentence(j.needs_you),
          message: sentence(j.message) ?? '',
        },
      };
    });
  }

  const noWake = (code, message) => ({ ok: false, code, message: message || WAKE_TEXT[code] || WAKE_TEXT.failed });
  function wake(agent) {
    const why = held();
    if (why) return Promise.resolve(noWake(why));
    const name = typeof agent === 'string' ? agent.trim() : '';
    if (!name || name === '--json' || !ARG_OK.test(name)) return Promise.resolve(noWake('unknown_agent'));
    return once(`wake ${name}`, async () => {
      const r = await run(['wake', name, '--json'], d.limits.wake);
      if (!r.ran) return noWake(r.why);
      if (r.code === 2 || !r.json) return noWake('older');
      const j = r.json;
      if (j.ok === true) return { ok: true, agent: typeof j.agent === 'string' && ARG_OK.test(j.agent) ? j.agent : name };
      const code = typeof j.error === 'string' && WAKE_CODES.includes(j.error) ? j.error : 'failed';
      return noWake(code, sentence(j.message));
    }).then(r => (r && r.ok === false && r.code === undefined ? noWake(r.why ?? 'failed') : r));
  }

  return { state, up, wake, folder: folderNow };
}

// ---------- services.json ----------
export const SERVICES_V = 1;
// What the file holds, whatever is in it. Never throws. newer: the file is from a later Plenum (read as far as known, never written).
export function migrate(raw) {
  const r = isObject(raw) ? raw : {};
  const v = Number.isInteger(r.v) && r.v > 0 ? r.v : SERVICES_V;
  return { v: SERVICES_V, hubAtStart: r.hubAtStart === true ? true : r.hubAtStart === false ? false : null, newer: v > SERVICES_V };
}

const NEWER = 'The services file is from a newer Plenum, so this build does not change it.';
const START_DELAY_MS = 20_000;
const LEASE_MS = 60_000;
const FAST_MS = 5_000;
const SLOW_MS = 60_000;
const FOLLOW_MS = 600_000;
// After an `up` that answered "starting": how long the state is read every 5 seconds although it does not say "starting" itself.
const SETTLE_MS = 30_000;
// The look at start, when only Docker (or the License Agreement, or a slow starter) is in the way: read again this often, this long.
const START_AGAIN_MS = 60_000;
const START_WAIT_MS = 600_000;

// Whether Plenum may call `up` by itself at start: nothing can show on the screen and nothing is installed.
export function quietStartFits(s) {
  if (!isObject(s) || s.setup !== 'ready') return false;
  const needed = s.hub === 'down' || (s.hub === 'up' && s.helper === 'stopped');
  return needed && (s.docker === 'running' || s.engine === 'local');
}
const unsettled = res => Boolean(res?.ok) && (res.state.hub === 'starting' || res.state.setup === 'running');
// The hub is set up and needs bringing up, and the one thing in the way is that Docker is not known to run (closed, or not known).
// It may be on its way at a sign-in to Windows, so the look at start reads the state again.
export function dockerMayCome(s) {
  if (!isObject(s) || s.setup !== 'ready' || s.engine === 'local') return false;
  const needed = s.hub === 'down' || (s.hub === 'up' && s.helper === 'stopped');
  return needed && (s.docker === 'stopped' || s.docker === null);
}
const allUp = res => Boolean(res?.ok) && res.state.hub === 'up' && res.state.helper === 'running';
const upStarting = res => Boolean(res?.ok) && (res.up.hub === 'starting' || res.up.helper === 'starting');

export function createHubWatch(deps = {}) {
  const d = {
    starter: deps.starter ?? null,
    clock: clockOf(deps.clock),
    dir: deps.dir ?? store.HOME,
    env: asFn(deps.env ?? (() => process.env)),
    accepted: deps.accepted ?? (() => termsAccepted(store.get())),
    connectAgents: deps.connectAgents ?? (() => hub.status().settings.agents === true),
    publish: deps.publish ?? (ev => events.publish(ev)),
    write: deps.write ?? writeFileAtomic,
  };
  const file = path.join(d.dir, 'services.json');
  const starter = () => d.starter ?? defaultStarter();

  let rec = null; // services.json as read
  let queue = Promise.resolve();
  let last = null; // { at, res }: the last answer of state
  let lastUp = null; // { at, res }: the last answer of up
  let going = null; // a reading on its way
  let leaseUntil = 0;
  let followUntil = 0;
  let followTimer = null;
  let startTimer = null;
  let settleUntil = 0; // an `up` answered "starting": the state is followed until then, or until everything runs
  let started = false; // the look at start was taken (once per run)
  let startUntil = 0; // the look at start reads the state again until then

  const tell = reason => {
    try {
      d.publish({ type: 'services', reason });
    } catch {
      // Nobody listens.
    }
  };

  function load() {
    if (rec) return rec;
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      raw = null; // No file, or one that cannot be read: the defaults are in force.
    }
    rec = migrate(raw);
    return rec;
  }
  function hubAtStart() {
    const r = load();
    let agents = false;
    try {
      agents = d.connectAgents() === true;
    } catch {
      agents = false;
    }
    return r.hubAtStart === null ? { on: agents, follows: true } : { on: r.hubAtStart, follows: false };
  }
  // Saves the switch. true and false are the person's own choice; null goes back to following Connect agents.
  function setHubAtStart(on) {
    if (on !== true && on !== false && on !== null) return Promise.reject(Object.assign(new Error('Send on as true or false.'), { status: 400 }));
    const run = async () => {
      const r = load();
      if (r.newer) throw Object.assign(new Error(NEWER), { status: 409 });
      await fsp.mkdir(d.dir, { recursive: true });
      await d.write(file, `${JSON.stringify({ v: SERVICES_V, hubAtStart: on }, null, 2)}\n`);
      rec = { ...r, hubAtStart: on };
      tell('hub-at-start');
      return hubAtStart();
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  function refresh() {
    if (going) return going;
    going = Promise.resolve()
      .then(() => starter().state())
      .catch(() => ({ ok: false, why: 'failed' }))
      .then(res => {
        const changed = !last || !same(last.res, res);
        last = { at: d.clock.now(), res };
        going = null;
        // What the last press came to is over once the hub runs: an old failure never comes back in front of a later row.
        if (res?.ok && res.state.hub === 'up' && !settling()) lastUp = null;
        if (changed) tell('state');
        follow();
        return res;
      });
    return going;
  }
  // An `up` answered "starting" a moment ago and the state does not say yet that everything runs (the helper takes a few seconds, and
  // the state does not call that "starting").
  const settling = () => d.clock.now() < settleUntil && !allUp(last?.res);
  const moving = () => unsettled(last?.res) || settling();
  // What `up` answered, kept for the row; "starting" opens the short window in which the state is followed.
  function tookUp(res) {
    const now = d.clock.now();
    lastUp = { at: now, res };
    if (res?.ok) followUntil = now + FOLLOW_MS;
    settleUntil = upStarting(res) ? now + SETTLE_MS : 0;
  }
  // While something is starting and Plenum asked for it (or the section is on screen), the state is asked every 5 seconds.
  function follow() {
    d.clock.clearTimeout(followTimer);
    followTimer = null;
    const now = d.clock.now();
    if (!moving() || (now >= followUntil && now >= leaseUntil)) return;
    followTimer = d.clock.setTimeout(() => {
      followTimer = null;
      void refresh();
    }, FAST_MS);
  }
  // The section is on screen. Answers from memory, and starts a reading in the background when one is due.
  function look() {
    const now = d.clock.now();
    leaseUntil = now + LEASE_MS;
    const due = !last || now - last.at >= (moving() ? FAST_MS : SLOW_MS);
    if (due && !going) void refresh();
    return snapshot();
  }
  const snapshot = () => ({ reading: last?.res ?? null, at: last?.at ?? null, up: lastUp, settling: settling(), checking: Boolean(going) && !last, folder: starter().folder?.() ?? null });

  // The buttons of the hub's row. hub-start and hub-setup run `up`; hub-check reads the state again. Resolves the snapshot.
  async function act(id) {
    if (id !== 'hub-start' && id !== 'hub-setup' && id !== 'hub-check') throw Object.assign(new Error('Plenum does not know this action.'), { status: 400 });
    if (id !== 'hub-check') tookUp(await starter().up());
    if (going) await going; // a reading from before the press says nothing about now
    await refresh();
    tell(id);
    return snapshot();
  }

  // The look at start (BUSINESS-DESIGN.md section 7): with the switch on, one `state`; `up` only when quietStartFits, and only once
  // per run; then the state is followed every 5 seconds until it settles, ten minutes at most. When the one thing in the way may still
  // come by itself (Docker Desktop is closed or not known, which is the usual state of things 20 seconds after a sign-in to Windows;
  // the License Agreement is not accepted yet; the starter did not answer), the state is read again every 60 seconds, for ten minutes
  // at most, and it ends at the first of: `up` was called, nothing is left to do, the ten minutes. Resolves what it did, for the tests.
  async function startCheck() {
    if (started) return 'done';
    started = true;
    startUntil = d.clock.now() + START_WAIT_MS;
    return startStep();
  }
  // One more look in START_AGAIN_MS, while the ten minutes last. Answers the word it was given.
  function again(word) {
    d.clock.clearTimeout(startTimer);
    startTimer = null;
    if (d.clock.now() + START_AGAIN_MS <= startUntil) {
      startTimer = d.clock.setTimeout(() => {
        startTimer = null;
        startStep().catch(() => {});
      }, START_AGAIN_MS);
    }
    return word;
  }
  async function startStep() {
    const env = d.env() ?? {};
    if (env.PLENUM_NO_SERVICES === '1') return 'off';
    if (env.PLENUM_SMOKE === '1') return 'smoke';
    let ok = false;
    try {
      ok = d.accepted() === true;
    } catch {
      ok = false;
    }
    if (!ok) return again('terms');
    if (!hubAtStart().on) return 'switch-off';
    const res = await refresh();
    if (!res.ok) return res.why === 'timeout' || res.why === 'failed' ? again(`state-${res.why}`) : `state-${res.why}`;
    if (unsettled(res)) {
      followUntil = d.clock.now() + FOLLOW_MS;
      follow();
      return 'following';
    }
    if (!quietStartFits(res.state)) return dockerMayCome(res.state) ? again('waiting') : 'nothing';
    tookUp(await starter().up());
    await refresh();
    tell('hub-at-start');
    return 'up';
  }
  // Sets the timer of the look at start: 20 seconds after the routes loaded (startStep sets it again, a minute ahead, while it waits).
  // No timer in the smoke mode or with PLENUM_NO_SERVICES=1.
  function armStart(delayMs = START_DELAY_MS) {
    const env = d.env() ?? {};
    if (startTimer || started || env.PLENUM_NO_SERVICES === '1' || env.PLENUM_SMOKE === '1') return false;
    startTimer = d.clock.setTimeout(() => {
      startTimer = null;
      startCheck().catch(() => {});
    }, delayMs);
    return true;
  }
  function stop() {
    d.clock.clearTimeout(startTimer);
    d.clock.clearTimeout(followTimer);
    startTimer = null;
    followTimer = null;
    followUntil = 0;
    leaseUntil = 0;
    startUntil = 0;
  }

  return { look, refresh, act, snapshot, hubAtStart, setHubAtStart, armStart, startCheck, stop, file };
}

// ---------- the default instances (made on first use, so loading this module starts and reads nothing) ----------
let starter0 = null;
let watch0 = null;
export function defaultStarter() {
  return (starter0 ??= createHubStarter());
}
export function defaultWatch() {
  return (watch0 ??= createHubWatch({ starter: defaultStarter() }));
}
export const state = () => defaultStarter().state();
export const up = () => defaultStarter().up();
export const wake = agent => defaultStarter().wake(agent);

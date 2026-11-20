import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNightShift } from '../lib/jobs.mjs';
import { createRoutines, START_WAIT_MS, TICK_MS } from '../lib/routines.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function tempDirectory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'plenum-scheduler-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const gemini = 'gemini:default';
const cursor = 'cursor:default';

async function nightFixture(t, { now = new Date(2026, 10, 17, 23, 30).getTime(), status = 'open' } = {}) {
  const dir = await tempDirectory(t);
  const jobs = Array.from({ length: 3 }, (_, index) => ({
    id: `j_0000000${index + 1}`,
    business: 'b_test',
    project: 'p_test',
    text: `Work item ${index + 1}`,
    state: 'waiting',
    order: index + 1,
    runs: [],
  }));
  await writeFile(path.join(dir, 'night-shift.json'), JSON.stringify({ v: 1, jobs }));
  const routed = [];
  const started = [];
  let planReads = 0;
  const schedule = createNightShift({
    dir,
    now: () => now,
    business: { byId: () => ({ id: 'b_test', status, autoLeads: true, leads: [gemini, cursor] }) },
    planWatch: { planState() { planReads += 1; return { on: true, subs: [] }; } },
    routines: { step(input) { started.push(input); return { outcome: 'started' }; } },
    shell: { shellRequest: () => ({ ok: true, idleSec: 3600 }) },
    autoRoute(input) {
      routed.push(input);
      return { ref: cursor, effort: 'high', why: 'Prefers Cursor', alternatives: [{ ref: cursor }] };
    },
    env: {},
  });
  t.after(() => schedule.idle());
  return { schedule, routed, started, planReads: () => planReads };
}

test('Night shift leaves outside-hours jobs queued without consulting Auto', async t => {
  const f = await nightFixture(t, { now: new Date(2026, 10, 17, 12).getTime() });
  await f.schedule.tick();
  assert.equal(f.routed.length, 0);
  assert.equal(f.planReads(), 0);
  assert.equal(f.started.length, 0);
});

test('Night shift does not poll plan usage for an entirely paused queue', async t => {
  const f = await nightFixture(t, { status: 'paused' });
  await f.schedule.tick();
  assert.equal(f.routed.length, 0);
  assert.equal(f.planReads(), 0);
  assert.equal(f.started.length, 0);
});

test('Night shift only ranks the job that can start, and skips routing while it runs', async t => {
  const f = await nightFixture(t);
  await f.schedule.tick();
  assert.equal(f.started.length, 1);
  assert.deepEqual(f.started[0].leads, [cursor]);
  assert.equal(f.started[0].effort, 'high');
  assert.deepEqual(f.routed.map(q => q.refs), [[gemini, cursor], [cursor]]);

  await f.schedule.tick();
  assert.equal(f.started.length, 1);
  assert.equal(f.routed.length, 2);
});

test('Routines recover a cut run when their file unlocks after startup', async t => {
  const dir = await tempDirectory(t);
  const file = path.join(dir, 'routines.json');
  let now = new Date(2026, 10, 17, 23, 30).getTime();
  const id = 'r_000001';
  // The routine was switched off while its last run was in progress.
  const before = { v: 1, routines: [{
    id, name: 'Interrupted routine', business: 'b_test', project: 'p_test', on: false,
    when: { type: 'every', hours: 1 }, prompt: { text: 'Do work' },
    last: { state: 'running', at: now - 60000, lead: gemini },
  }] };
  await writeFile(file, JSON.stringify(before));
  const timers = [];
  let locked = true;
  const routine = createRoutines({
    dir,
    now: () => now,
    read() {
      if (locked) throw Object.assign(new Error('Locked'), { code: 'EBUSY' });
      return JSON.stringify(before);
    },
    business: {},
    env: {},
    setTimer(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer() {},
  });
  t.after(() => routine.shutdown());
  routine.start();
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    function wait() {
      if (timers.length) resolve();
      else if (Date.now() >= deadline) reject(new Error('Boot timer did not arm'));
      else setTimeout(wait, 1);
    }
    wait();
  });

  const boot = timers.shift();
  assert.equal(boot.ms, START_WAIT_MS);
  now += boot.ms;
  await boot.fn();
  const retry = timers.shift();
  assert.ok(retry, 'the startup check schedules a retry');
  locked = false;
  now += TICK_MS;
  await routine.tick();
  await routine.idle();
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.routines[0].last.state, 'interrupted');
  assert.equal(saved.routines[0].on, false);
});

test('Stop while clearing a routine thread prevents sending its chat turn', { timeout: 3000 }, async t => {
  const dir = await tempDirectory(t);
  const id = 'r_000001';
  const clearing = deferred();
  const cleared = deferred();
  const calls = [];
  const routine = createRoutines({
    dir,
    env: {},
    port: 12345,
    token: 'test-token',
    read: () => JSON.stringify({ v: 1, routines: [{
      id, name: 'Routine', business: 'b_test', project: 'p_test', leads: [gemini],
      when: { type: 'every', hours: 1 }, prompt: { text: 'Do work' },
    }] }),
    business: { byId: () => ({ id: 'b_test' }) },
    projectById: () => ({ id: 'p_test', path: dir }),
    async fetch(url) {
      const route = new URL(url).pathname;
      calls.push(route);
      if (route === '/api/threads') return Response.json({ threads: [{ id: 'routine-thread', name: 'Routines' }] });
      if (route === '/api/clear') {
        clearing.resolve();
        await cleared.promise;
      }
      if (route === '/api/chat') return Response.json({ error: 'Unexpected model call' }, { status: 500 });
      return Response.json({});
    },
  });

  const run = routine.runNow(id);
  const rejected = assert.rejects(run, /Stopped by you/);
  await Promise.race([clearing.promise, run]);
  await routine.stop(id);
  cleared.resolve();
  await rejected;
  await routine.idle();
  assert.deepEqual(calls, ['/api/threads', '/api/clear', '/api/cancel']);
  assert.equal(routine.list()[0].last.state, 'stopped');
});

test('Public research routines select a Claude subscription and mark their chat', async t => {
  const dir = await tempDirectory(t);
  const id = 'r_000002';
  const key = 'anthropic:claude-opus-5-5';
  const plan = 'anthropic:claude-sonnet-4-6';
  const bodies = [];
  const schedule = createRoutines({
    dir, env: {}, port: 12345, token: 'test-token',
    read: () => JSON.stringify({ v: 1, routines: [{
      id, name: 'Find buyers', business: 'b_test', project: 'p_test', leads: [gemini, key, plan],
      when: { type: 'every', hours: 1 }, prompt: { text: 'Find open listings' }, webResearch: true,
    }] }),
    business: { byId: () => ({ id: 'b_test', allowApi: true }) },
    projectById: () => ({ id: 'p_test', path: dir }),
    billingFor: async ref => ref === key ? 'api' : 'plan',
    async fetch(url, options) {
      const route = new URL(url).pathname;
      if (route === '/api/threads') return Response.json({ threads: [{ id: 'routine-thread', name: 'Routines' }] });
      if (route === '/api/chat') {
        bodies.push(JSON.parse(options.body));
        assert.equal(schedule.runningRoutine('p_test', 'routine-thread').webResearch, true);
        return new Response('data: {"type":"done","ok":true}\n\n');
      }
      return Response.json({});
    },
  });
  await schedule.runNow(id);
  await schedule.idle();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, plan);
  assert.equal(bodies[0].routineWebResearch, true);
  assert.equal(schedule.runningRoutine('p_test', 'routine-thread'), null);
});

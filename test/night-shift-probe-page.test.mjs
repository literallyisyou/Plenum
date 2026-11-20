import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createNightShift } from '../lib/jobs.mjs';

function scheduler(step, count = 9) {
  const now = new Date(2026, 10, 20, 1, 0).getTime();
  const jobs = Array.from({ length: count }, (_, i) => ({
    id: 'j_' + i.toString(16).padStart(8, '0'),
    business: `business-${i}`, project: `project-${i}`, text: `Work item ${i}`,
    state: 'waiting', order: i + 1,
  }));
  let snapshot = JSON.stringify({ v: 1, jobs });
  const probes = [];
  const shift = createNightShift({
    dir: path.resolve('test', 'unused-' + randomUUID()),
    now: () => now,
    termsOk: () => true,
    read: () => snapshot,
    write: async (_file, data) => { snapshot = data; },
    business: {
      byId: async () => ({ name: 'Business', status: 'active', leads: ['gemini:test'] }),
      today: async () => ({ runs: 0, minutes: 0 }),
    },
    routines: {
      step: async ({ project }) => {
        const i = Number(project.split('-')[1]);
        probes.push(i);
        return step(i);
      },
    },
  });
  return { shift, probes, jobs };
}
const busy = () => ({ outcome: 'wait', code: 'busy', why: 'Busy temporarily' });

test('Night shift reaches a runnable ninth job without exceeding eight probes in a tick', async () => {
  const { shift, probes } = scheduler(i => i === 8 ? { outcome: 'started' } : busy());
  await shift.tick();
  assert.deepEqual(probes, [0, 1, 2, 3, 4, 5, 6, 7]);
  await shift.tick();
  assert.deepEqual(probes, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(shift.load().jobs.at(-1).state, 'running');
});

test('Night shift revisits busy jobs after reaching the end of the probe page', async () => {
  let free = false;
  const { shift, probes } = scheduler(i => free && i === 0 ? { outcome: 'started' } : busy());
  await shift.tick();
  await shift.tick();
  assert.deepEqual(probes, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  free = true;
  await shift.tick();
  assert.deepEqual(probes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 0]);
  assert.equal(shift.load().jobs[0].state, 'running');
});

test('a cancelled job is not resumed from the previous probe page', async () => {
  const { shift, probes, jobs } = scheduler(busy);
  await shift.tick();
  await shift.stop({ id: jobs.at(-1).id });
  await shift.tick();
  assert.deepEqual(probes, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(shift.load().jobs.at(-1).state, 'stopped');
});

test('a job edited after a full probe page can be reconsidered at its original priority', async () => {
  let edited = false;
  const { shift, probes, jobs } = scheduler(i => edited && i === 0 ? { outcome: 'started' } : busy());
  await shift.tick();
  await shift.update({ id: jobs[0].id, text: 'Ready after an owner edit.' });
  edited = true;
  await shift.tick();
  assert.deepEqual(probes, [0, 1, 2, 3, 4, 5, 6, 7, 0]);
  assert.equal(shift.load().jobs[0].state, 'running');
});

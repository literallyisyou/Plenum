// Night shift's routes (wave 6, ns1; lib/jobs.mjs holds the logic and the contract). All JSON.
//   GET  /api/night-shift  -> { v, settings, hours: { from, to, inHours, startsAt, endsAt }, status: { code, line, note? },
//                              awake: { on, line }, running: { jobId, lead, since } | null, jobs: [job + { pill, line, canContinue }],
//                              businesses: [{ id, name, projects: [{ id, name, canWrite, approvals }], leads: [{ ref, label }] }],
//                              empty, newer?, damaged? }
//        Not gated: it reaches no provider. It answers from the plan readings of the last tick and never calls planState() itself
//        (only the tick does, and a tick does nothing before the License Agreement; before it the GET says so in status 'terms').
//        So a phone below Full can load the pane read-only (lib/remote/tiers.mjs gives every gated GET Full), as the design asks.
//   POST /api/night-shift/jobs          { business, project?, text, doneWhen?, lead?, source? } -> { job }
//   POST /api/night-shift/jobs/update   { id, text?, doneWhen?, lead? } -> { job }          (409 while it runs)
//   POST /api/night-shift/jobs/move     { id, to: 'up' | 'down' | 'top' | 'bottom' | index } -> { ok, jobs: [id] }
//   POST /api/night-shift/jobs/remove   { id } -> { ok }                                     (409 while it runs: "Stop it first.")
//   POST /api/night-shift/jobs/continue { id } -> { job }   a job that needs you or was stopped waits again (below 3 runs)
//   POST /api/night-shift/jobs/done     { id } -> { job }
//   POST /api/night-shift/stop          { id } -> { ok: true, happened }   always answers; a run goes to routines.stop(key)
//   POST /api/night-shift/settings      { on?, from?, to?, share?, keepAwake?, countRuns? } -> { settings }
//   POST /api/night-shift/resume        {} -> { ok, was }   (routines.resume(): routines and Night shift may start again)
// A refusal is 400 (409 while a job runs, or for a file from a newer Plenum) with one plain sentence. Every change publishes
// { type: 'night-shift', action: 'changed' }. The server checks the token on every /api/ request, and every POST waits for the License
// Agreement; each route checks the token here as well, because a job lets a model run with nobody at the PC. No model can call these
// routes: a model's tools never hold the token. From a phone every POST here needs Full access (lib/remote/tiers.mjs).
//
// THE TIMER is started from here and from nowhere else: loading this module calls start() of lib/jobs.mjs, which starts nothing with
// PLENUM_NO_SCHEDULER=1 or PLENUM_SMOKE=1, reads nothing on the way, and whose ticks do nothing before the License Agreement.
import { requireToken } from '../auth.mjs';
import * as jobs from '../jobs.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createRoutes(deps = {}) {
  const api = deps.jobs ?? jobs;
  const refuse = (httpError, err) => httpError(Number.isInteger(err?.status) ? err.status : 500, String(err?.message ?? 'That could not be done.').slice(0, 600));
  const run = async (httpError, fn) => {
    try {
      return await fn();
    } catch (err) {
      throw refuse(httpError, err);
    }
  };
  const post = (path, sentence, fn) => ({
    method: 'POST',
    path,
    handler: async ({ req, res, json, readBody, httpError }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, sentence);
      return json(res, 200, await run(httpError, () => fn(body)));
    },
  });
  return [
    {
      method: 'GET',
      path: '/api/night-shift',
      handler: async ({ req, res, json, httpError }) => {
        requireToken(req, httpError);
        return json(res, 200, await run(httpError, () => api.describe()));
      },
    },
    post('/api/night-shift/jobs', 'Send an object with the job.', body => api.add(body)),
    post('/api/night-shift/jobs/update', 'Send an object that names the job.', body => api.update(body)),
    post('/api/night-shift/jobs/move', 'Send an object that names the job.', body => api.move(body)),
    post('/api/night-shift/jobs/remove', 'Send an object that names the job.', body => api.remove(body)),
    post('/api/night-shift/jobs/continue', 'Send an object that names the job.', body => api.cont(body)),
    post('/api/night-shift/jobs/done', 'Send an object that names the job.', body => api.done(body)),
    post('/api/night-shift/stop', 'Send an object that names the job.', body => api.stop(body)),
    post('/api/night-shift/settings', 'Send the settings as an object.', body => api.setSettings(body)),
    post('/api/night-shift/resume', 'Send an empty object.', () => api.resume()),
  ];
}

export const routes = createRoutes();

// The one place the Night shift timer is started. It must never stop the routes from loading.
try {
  jobs.start();
} catch (err) {
  console.error(`The Night shift timer did not start: ${String(err?.message ?? err).slice(0, 160)}`);
}

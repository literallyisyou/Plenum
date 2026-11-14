// Routines' routes (wave 3, BUSINESS-DESIGN.md section 5.1; lib/routines.mjs holds the logic and the contract). All under /api/routines, JSON.
//   GET  /api/routines?business=&project=   -> { routines: [routine + { folder: { project, thread, canWrite, approvals } }], running: [id | 'f:<project>'],
//                                               followUps: [{ key, name, business, project, since, lead }] (a follow-up run that is going on:
//                                               the timer started it after an answer of the owner's; POST /stop takes its key as id),
//                                               scheduler: { on, lastTick, paused, why, hold?: { at, until }, note? }, folders: { <project id>: { project, thread, canWrite, approvals } }, newer }
//                                               scheduler.hold is there while routines are held after a Stop from outside (Stop all, or Stop
//                                               on a run's chat): nothing starts by itself until hold.until; why says so with the time.
//                                               folder says the two things the page shows before a routine is switched on: whether the
//                                               Routines thread may write in that folder, and the folder's approval mode (ask, auto or all).
//                                               folders holds every folder of the businesses asked for, also one with no routine yet.
//                                               scheduler.paused is true while nothing starts by itself (Pause all, the License Agreement
//                                               not accepted, PLENUM_NO_SCHEDULER, no business module); why says which.
//   POST /api/routines { id?, business, project, name, on, when, prompt: { text, file }, onlyIf: { folder }, leads, maxMinutes,
//                        catchUpHours, retryMin }   create (no id) or change (id; only the fields sent change). Checks every field (400 with
//                                               one plain sentence), stores the playbook's hash, makes the folder's Routines thread when the
//                                               routine is switched on. -> { routine }
//   POST /api/routines/delete { id }         -> { ok: true }            (409 while it runs)
//   POST /api/routines/run    { id }         -> { ok: true, routine }   now; 409 with the reason when it cannot start
//   POST /api/routines/stop   { id }         -> { ok: true } or { ok: true, happened } (one sentence: the routine had not started
//                                               yet and now will not); 409 when it is not running. Stop always answers what happened.
//   GET  /api/routines/playbook?id=         -> { id, file, text, length, cut, sha256, changed }: the playbook as a run would get it (its
//                                               first 8,000 characters and its whole length), for the owner to read before Keep. 400 or 404
//                                               with one sentence when it is not a file a run would read (a link, a second name of a file).
//   POST /api/routines/keep   { id, seen }   -> { routine }             accept the changed playbook. seen is the sha256 that GET
//                                               /playbook gave with the text that was shown; 409 with one sentence when it is missing or the
//                                               file is another text now.
//   POST /api/routines/resume {}             -> { ok: true, was, scheduler }   ends the hold after a Stop (was: there was one)
// Every change is told on the events channel by lib/routines.mjs: { type: 'routine', action, routine: { id, name, business, state, why } }.
// The server checks the Plenum token on every /api/ request before a handler runs, and every POST waits for the License Agreement; the
// POSTs check the token here as well, because a routine is what lets a model run with nobody at the PC. No model can call these routes:
// a model's tools never hold the token. No answer holds a key or the token.
//
// THE SCHEDULER is armed from here and from nowhere else: loading this module (the server does, through lib/routes/index.mjs) calls
// start() of lib/routines.mjs. That reads nothing and starts no timer by itself: see the rules at the top of that file.
import { requireToken } from '../auth.mjs';
import * as routines from '../routines.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// A refusal of the routines module (an Error with a status and one sentence) as the server's own error.
const refuse = (httpError, err) => httpError(Number.isInteger(err?.status) ? err.status : 500, String(err?.message ?? 'The routine could not be saved.'));

async function body(ctx) {
  const { req, readBody, httpError } = ctx;
  requireToken(req, httpError);
  const sent = await readBody(req);
  if (!isObject(sent)) throw httpError(400, 'Send an object with the routine\'s fields.');
  return sent;
}

// One of the routes that name a routine by its id and nothing else.
const byId = (act, shape) => async ctx => {
  const sent = await body(ctx);
  if (typeof sent.id !== 'string' || !sent.id) throw ctx.httpError(400, 'Say which routine.');
  try {
    return ctx.json(ctx.res, 200, shape(await act(sent.id)));
  } catch (err) {
    throw refuse(ctx.httpError, err);
  }
};

export const routes = [
  {
    method: 'GET',
    path: '/api/routines',
    handler: async ({ res, url, json }) => {
      const q = url.searchParams;
      return json(res, 200, await routines.describe({ business: q.get('business') || undefined, project: q.get('project') || undefined }));
    },
  },
  {
    method: 'GET',
    path: '/api/routines/playbook',
    handler: async ({ res, url, json, httpError }) => {
      const id = url.searchParams.get('id');
      if (!id) throw httpError(400, 'Say which routine.');
      try {
        return json(res, 200, await routines.playbook(id));
      } catch (err) {
        throw refuse(httpError, err);
      }
    },
  },
  {
    method: 'POST',
    path: '/api/routines/resume',
    handler: async ctx => {
      await body(ctx);
      try {
        const out = routines.resume();
        return ctx.json(ctx.res, 200, { ...out, scheduler: routines.schedulerState() });
      } catch (err) {
        throw refuse(ctx.httpError, err);
      }
    },
  },
  {
    method: 'POST',
    path: '/api/routines/keep',
    handler: async ctx => {
      const sent = await body(ctx);
      if (typeof sent.id !== 'string' || !sent.id) throw ctx.httpError(400, 'Say which routine.');
      try {
        return ctx.json(ctx.res, 200, { routine: await routines.keep(sent.id, { seen: sent.seen }) });
      } catch (err) {
        throw refuse(ctx.httpError, err);
      }
    },
  },
  {
    method: 'POST',
    path: '/api/routines',
    handler: async ctx => {
      const sent = await body(ctx);
      try {
        return ctx.json(ctx.res, 200, { routine: await routines.save(sent) });
      } catch (err) {
        throw refuse(ctx.httpError, err);
      }
    },
  },
  { method: 'POST', path: '/api/routines/delete', handler: byId(routines.remove, out => out) },
  { method: 'POST', path: '/api/routines/run', handler: byId(routines.runNow, out => out) },
  { method: 'POST', path: '/api/routines/stop', handler: byId(routines.stop, out => out) },
];

// The one place the scheduler is started. It must never stop the routes from loading.
try {
  routines.start();
} catch (err) {
  console.error(`The routines scheduler did not start: ${String(err?.message ?? err).slice(0, 160)}`);
}

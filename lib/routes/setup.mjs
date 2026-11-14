// The routes of setting a business up from a council's verdict (14 Nov 2026; lib/setup.mjs holds the logic and the contract). JSON.
//   GET  /api/business/setup                          -> { v, parent, threadName, limits, auto: { on, why }, setups: [...] }
//   GET  /api/business/setup/verdicts?project=        -> { verdicts: [{ thread, threadName, ts, kind, question, head, ideas }] }
//                                                        the councils of that folder that have a verdict, newest first
//   GET  /api/business/setup/ideas?project=&thread=&ts= -> what the form shows for one verdict (or one reply): { source, ideas: [{ name,
//                                                        text }], whole, fromLayout, parent, lead, leadLabel, template, templates, ... }
//   POST /api/business/setup { source: { project, thread, ts }, ideas: [{ name, index? | whole? | text?, notes?, existing? }], parent,
//                              lead, mode: 'ask' | 'auto', template? }
//                                                     -> { made: [{ business, name, folder, state, why, skipped }], refused: [{ name, why }] }
//                                                        Nothing is made before every idea checks out: 400 or 409 with one sentence
//                                                        (a folder that is there and not empty answers 409 until the idea carries
//                                                        existing: true; "Everything is paused" answers 409).
//   POST /api/business/setup/continue { business, note? } -> { ok, setup }   one step now ("Continue setup", "Try again"); 409 with the reason
//   POST /api/business/setup/stop { business }        -> { ok, happened }    stops the step; setup does not go on by itself afterwards
//   POST /api/business/setup/hide { business }        -> { ok }              takes a setup that is not running off the pane
// The server checks the Plenum token on every /api/ request before a handler runs, and every POST waits for the License Agreement; the
// POSTs check the token here as well. From a phone every POST here needs Full access (lib/remote/tiers.mjs: a POST it does not name is
// Full); a phone below Full stops a running step with POST /api/routines/stop { id: 's:<business>' } or Stop all, which it may always
// use. No model can call these routes: a model's tools never hold the token. No route here reaches the network or starts a program
// itself: a step is an ordinary chat turn that lib/routines.mjs starts on Plenum's own server.
import { requireToken } from '../auth.mjs';
import * as setup from '../setup.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createRoutes(deps = {}) {
  const api = deps.setup ?? setup;
  const refuse = (httpError, err) => httpError(Number.isInteger(err?.status) ? err.status : 500, String(err?.message ?? 'That could not be done.').slice(0, 700));
  const run = async (httpError, fn) => {
    try {
      return await fn();
    } catch (err) {
      throw refuse(httpError, err);
    }
  };
  const post = (sentence, fn) => async ({ req, res, json, readBody, httpError }) => {
    requireToken(req, httpError);
    const body = await readBody(req);
    if (!isObject(body)) throw httpError(400, sentence);
    return json(res, 200, await run(httpError, () => fn(body)));
  };
  const idOf = body => (typeof body.business === 'string' ? body.business : '');

  return [
    {
      method: 'GET',
      path: '/api/business/setup',
      handler: async ({ res, json, httpError }) => json(res, 200, await run(httpError, () => api.list())),
    },
    {
      method: 'GET',
      path: '/api/business/setup/verdicts',
      handler: async ({ res, url, json, httpError }) => json(res, 200, { verdicts: await run(httpError, () => api.verdicts(url.searchParams.get('project') ?? '')) }),
    },
    {
      method: 'GET',
      path: '/api/business/setup/ideas',
      handler: async ({ res, url, json, httpError }) => {
        const q = url.searchParams;
        return json(res, 200, await run(httpError, () => api.propose({ project: q.get('project') ?? '', thread: q.get('thread') ?? '', ts: Number(q.get('ts') ?? '') })));
      },
    },
    { method: 'POST', path: '/api/business/setup', handler: post('Send an object with source, ideas, parent, lead and mode.', body => api.begin(body)) },
    { method: 'POST', path: '/api/business/setup/continue', handler: post('Send an object with business.', body => api.cont(idOf(body), { note: body.note })) },
    { method: 'POST', path: '/api/business/setup/stop', handler: post('Send an object with business.', body => api.stop(idOf(body))) },
    { method: 'POST', path: '/api/business/setup/hide', handler: post('Send an object with business.', body => api.hide(idOf(body))) },
  ];
}

export const routes = createRoutes();

// The one place the setup timer is started. It must never stop the routes from loading. It reads nothing and starts no timer when
// PLENUM_NO_SCHEDULER=1 or PLENUM_SMOKE=1 (lib/setup.mjs).
try {
  setup.start();
} catch (err) {
  console.error(`The setup timer did not start: ${String(err?.message ?? err).slice(0, 160)}`);
}

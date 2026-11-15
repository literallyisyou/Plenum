// Plan watch (lib/plan-watch.mjs, DECISIONS item 153): the plan use of every subscription, read by itself, projected forward and watched.
//   GET  /api/plan-watch                 -> { v: 1, at, on, why, settings, checking, nextCheckAt, note, subs, businesses, alerts }
//        It waits for the License Agreement, like GET /api/quota. It answers from memory and the history file at once; the readings
//        come from the watcher's rounds (the first answer of a run starts one in the background).
//   POST /api/plan-watch/settings { on?, paidEveryMin?, alerts? } -> { on, paidEveryMin, alerts }
//        (400 with one sentence for a value that is not allowed: paidEveryMin is 0 for never, or 30 to 360 minutes; and for a body that
//        is not an object or names none of the three. 0 means never: neither the timer nor Check now sends a request then.)
//   alerts[] of the answer: { id, level: 'short' | 'out', provider, window, business, period, title, text, notice, at, businesses, seen,
//        current }. A window alert has provider and window; a business alert has business (the id) and provider ''. title is never repeated
//        in text; notice is one line of at most 240 characters for a channel with no title; current says whether it still holds (never
//        stored); period is the period key of the window alert. The worst alert of a round comes first. The event carries
//        { id, level, title, text, notice } for each new alert, the worst last, and a state event follows (state.planAlert).
//   POST /api/plan-watch/check           -> the same answer as the GET after one round of readings now. A reading that sends one very
//        small request keeps to its budget; `note` says what was and was not asked.
//   POST /api/plan-watch/seen { id }     -> { ok: true }   (the alert is marked seen)
// Events on the page's channel: { type: 'plan-watch' } when a reading, a state or an alert changed; a new alert is carried as
// { type: 'plan-watch', alert: { id, level, title, text } }. Every POST waits for the License Agreement (lib/legal.mjs).
// The server checks the Plenum token on every /api/ request before a route runs; requireToken checks it here as well.
import { requireToken } from '../auth.mjs';
import { checkPlanNow, markPlanSeen, planState, setPlanSettings } from '../plan-watch.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const routes = [
  {
    method: 'GET',
    path: '/api/plan-watch',
    // The readings reach the providers' own programs (Codex's app server reaches OpenAI), so the read waits for the License Agreement.
    gated: true,
    handler: async ({ req, res, json, httpError }) => {
      requireToken(req, httpError);
      return json(res, 200, await planState());
    },
  },
  {
    method: 'POST',
    path: '/api/plan-watch/settings',
    handler: async ({ req, res, json, readBody, httpError }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      // readBody turns a JSON null into an empty object, so a body that names none of the three settings is refused too.
      if (!isObject(body) || !['on', 'paidEveryMin', 'alerts'].some(k => Object.hasOwn(body, k))) throw httpError(400, 'Send an object with on, paidEveryMin or alerts.');
      try {
        return json(res, 200, await setPlanSettings(body));
      } catch (err) {
        throw httpError(err?.status ?? 500, err?.status === 400 ? err.message : 'The plan watch settings could not be saved.');
      }
    },
  },
  {
    method: 'POST',
    path: '/api/plan-watch/check',
    handler: async ({ req, res, json, httpError }) => {
      requireToken(req, httpError);
      return json(res, 200, await checkPlanNow());
    },
  },
  {
    method: 'POST',
    path: '/api/plan-watch/seen',
    handler: async ({ req, res, json, readBody, httpError }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body) || typeof body.id !== 'string' || !body.id) throw httpError(400, 'Send the id of the alert.');
      try {
        return json(res, 200, await markPlanSeen(body.id));
      } catch (err) {
        throw httpError(err?.status ?? 500, err?.status === 400 ? err.message : 'The alert could not be marked.');
      }
    },
  },
];

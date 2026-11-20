// The routes of the owner-time meter (wave 8; lib/owner-time.mjs holds the count and the contract). All under /api/owner-time, JSON.
//   GET  /api/owner-time                 -> the summary: { v, estimate: true, label, counts, doesNotCount, capMinutes, idleMinutes,
//                                           floorSeconds, holdPercent, percent, state: 'ok' | 'hold' | 'over', line, nextBatch,
//                                           thisWeek: { from, to, ms, minutes, businesses: [{ id, name, status, ms, minutes, queue,
//                                           setup, charter, thread, answers, presses, floors }], other }, lastWeek: the same }
//   POST /api/owner-time/mark { what, item? | business? + kind? | project? }
//                                        -> { ok, counted, business?, kind?, floor?, why? }   what the page saw the owner do. It always
//                                           answers 200 for an object: a mark that fits no business is { ok: false }, never an error,
//                                           so nothing the owner does is ever held up or turned away by the meter.
//   POST /api/owner-time/cap { minutes } -> the summary; 400 with one sentence for anything but a whole number from 1 to 10,080
// No route here reaches the network or starts a program, and none refuses an answer or a Stop: those are other routes, and this module
// is never asked by them. The server checks the Plenum token on every /api/ request before a handler runs, and every POST waits for the
// License Agreement; the POSTs check the token here as well. createRoutes(deps) is the same routes on a fake meter, for the tests.
import { requireToken } from '../auth.mjs';
import * as ownerTime from '../owner-time.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createRoutes(deps = {}) {
  const api = deps.ownerTime ?? ownerTime;
  return [
    {
      method: 'GET',
      path: '/api/owner-time',
      handler: async ({ res, json }) => json(res, 200, await api.summary()),
    },
    {
      method: 'POST',
      path: '/api/owner-time/mark',
      handler: async ({ req, res, json, readBody, httpError }) => {
        requireToken(req, httpError);
        const body = await readBody(req);
        if (!isObject(body)) throw httpError(400, 'Send an object with what, and item, business or project.');
        return json(res, 200, await api.mark({ what: body.what, item: body.item, business: body.business, kind: body.kind, project: body.project }));
      },
    },
    {
      method: 'POST',
      path: '/api/owner-time/cap',
      handler: async ({ req, res, json, readBody, httpError }) => {
        requireToken(req, httpError);
        const body = await readBody(req);
        if (!isObject(body)) throw httpError(400, 'Send an object with minutes.');
        try {
          return json(res, 200, await api.setCap(body.minutes));
        } catch (err) {
          throw httpError(Number.isInteger(err?.status) ? err.status : 500, String(err?.message ?? 'The weekly limit could not be saved. Try again.'));
        }
      },
    },
  ];
}

export const routes = createRoutes();

// The one place the meter begins to read the owner's answers from the businesses' records. It must never stop the routes from loading:
// it starts no timer and reads no file until a business's record changes.
try {
  Promise.resolve(ownerTime.start()).catch(() => {});
} catch (err) {
  console.error(`The owner-time meter did not start: ${String(err?.message ?? err).slice(0, 160)}`);
}

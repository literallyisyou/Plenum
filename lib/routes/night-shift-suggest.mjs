// Suggested Night shift jobs (wave 6, ns4; lib/job-suggestions.mjs holds the logic).
//   GET  /api/night-shift/suggestions          -> { suggestions: [{ business, name, text, sha256, at, lead }], newer? }
//        The NEXT lines of each business's last runs, minus the ones the owner dismissed. Only text: nothing here makes a job.
//   POST /api/night-shift/suggestions/dismiss  { business, sha256 } -> { ok: true }
// Both need the token. A refusal is 400 (409 for a file from a newer Plenum) with one plain sentence. A dismissal publishes
// { type: 'night-shift', action: 'suggestions' }. No route here reaches lib/jobs.mjs: a suggestion becomes a job only through the owner's
// own "Add job" (POST /api/night-shift/jobs), after his tap on "Use as job" filled the form.
import { requireToken } from '../auth.mjs';
import * as suggest from '../job-suggestions.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createRoutes(deps = {}) {
  const api = deps.suggest ?? suggest;
  const publish = deps.publish ?? (event => {
    import('../events.mjs').then(m => { try { (m.publish ?? m.emit)?.(event); } catch { /* the pane reads again within a minute */ } }, () => {});
  });
  const refuse = (httpError, err) => httpError(Number.isInteger(err?.status) ? err.status : 500, String(err?.message ?? 'That could not be done.').slice(0, 600));
  return [
    {
      method: 'GET',
      path: '/api/night-shift/suggestions',
      gated: true,
      handler: async ({ req, res, json, httpError }) => {
        requireToken(req, httpError);
        try {
          const list = await api.suggestions();
          const body = { suggestions: list };
          if (typeof api.newer === 'function' && api.newer()) body.newer = true;
          return json(res, 200, body);
        } catch (err) {
          throw refuse(httpError, err);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/night-shift/suggestions/dismiss',
      handler: async ({ req, res, json, readBody, httpError }) => {
        requireToken(req, httpError);
        const body = await readBody(req);
        if (!isObject(body)) throw httpError(400, 'Send an object that names the suggestion.');
        try {
          const out = await api.dismiss(body);
          publish({ type: 'night-shift', action: 'suggestions' });
          return json(res, 200, out);
        } catch (err) {
          throw refuse(httpError, err);
        }
      },
    },
  ];
}

export const routes = createRoutes();

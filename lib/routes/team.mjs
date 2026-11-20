// The team's routes (wave 3, DELEGATION-DESIGN.md section 5.5; lib/team.mjs and lib/team-log.mjs hold the logic). All under /api/team, JSON.
//   GET  /api/team                              -> { v, on, saved, kinds: [{ ...kind, workers: [{ ref, label, provider, size, sizeFrom, avail }] }],
//                                                   suggested, models: [registry entries], providers: [{ id, label, state, why, usedPercent }],
//                                                   limits, sizes, hints: [text], facts: [text] }
//   POST /api/team { on?, kinds?, sizes?, limits? }  checks the whole record (400 with one plain sentence), saves, publishes
//                                                   { type: 'team', reason: 'saved' }, answers as GET. `kinds` is the WHOLE list of the
//                                                   owner's own kinds: one of his that it leaves out is removed (that is how the page
//                                                   deletes a kind). A built-in kind that is left out is kept, and a kind sent without
//                                                   `workers` keeps its models. A caller that changes one kind sends the others too.
//   POST /api/team/use-suggested                 saves the suggested team with on: true; 409 with a sentence while the sign-ins are not
//                                                   known, and 409 with a sentence when the suggestion holds no model at all (nothing is
//                                                   saved or switched on). A kind the suggestion has no model for keeps the owner's list.
//   GET  /api/team/pick?work=&project=&level=&mode=  a dry run of the choice: { ref, label, why, skipped: [{ ref, label, reason }] }
//                                                   or { ref: null, error, skipped }, with empty: true for a kind whose list holds no
//                                                   model (such a task runs on the model of its agent type)
//   GET  /api/team/log?project=&limit=&before=   -> { tasks: [log lines] }, newest first, 50 by default, 200 at most
//   GET  /api/team/usage?days=7&project=         -> { days, byProvider: [{ provider, label, count, ok, failed, minutes, input, output, dollars }],
//                                                   byKind: [{ kind, count, ok }] }
// Every answer is read from memory and from Plenum's own two files: no route here starts a CLI, reaches the network or asks for the
// plan-use reading (the team asks for that only after a delegated task). The server checks the Plenum token on every /api/ request before a
// handler runs, and every POST waits for the License Agreement; the POSTs check the token here as well. No answer holds a key.
import { requireToken } from '../auth.mjs';
import { orderModelCatalog } from '../catalog-order.mjs';
import * as team from '../team.mjs';
import * as teamLog from '../team-log.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const NOT_KNOWN = 'Plenum is still checking your sign-ins. Try again in a moment.';
const NOTHING = 'Plenum found no model it can suggest yet. Sign in under Settings > Accounts, or try again in a moment.';

// A refusal of the team module (an Error with a status and one sentence) as the server's own error.
const refuse = (httpError, err) => httpError(Number.isInteger(err?.status) ? err.status : 500, String(err?.message ?? 'The team could not be saved.'));

// What POST /api/team/use-suggested saves for a suggestion, or null when the suggestion holds no model at all (nothing is signed in, or
// how the models are billed is not known yet): saving that would switch the team on with nothing in it and empty the lists the owner
// made himself. A kind the suggestion has no model for is sent without `workers`, so it keeps the list the owner saved; every kind is
// named, so none of his own kinds is removed.
export function kindsToSave(suggestion) {
  const kinds = (Array.isArray(suggestion?.kinds) ? suggestion.kinds : []).filter(k => isObject(k) && typeof k.id === 'string');
  const has = k => Array.isArray(k.workers) && k.workers.length > 0;
  if (!kinds.some(has)) return null;
  return kinds.map(k => (has(k) ? { id: k.id, workers: [...k.workers] } : { id: k.id }));
}

async function answer() {
  await team.ready();
  const record = team.get();
  const models = orderModelCatalog(team.registry());
  const byRef = new Map(models.map(m => [m.ref, m]));
  const worker = ref => {
    const m = byRef.get(ref);
    return m
      ? { ref, label: m.label, provider: m.provider, size: m.size, sizeFrom: m.sizeFrom, avail: m.avail }
      : { ref, label: team.labelOf(ref), provider: ref.slice(0, Math.max(0, ref.indexOf(':'))), size: 'unknown', sizeFrom: 'none', avail: team.availability(ref) };
  };
  return {
    ...record,
    kinds: record.kinds.map(k => ({ ...k, workers: k.workers.map(worker) })),
    suggested: team.suggested(),
    models,
    providers: team.providersNow(),
    hints: team.hints(),
    facts: [...team.FACTS],
  };
}

export const routes = [
  {
    method: 'GET',
    path: '/api/team',
    handler: async ({ res, json }) => json(res, 200, await answer()),
  },
  {
    method: 'POST',
    path: '/api/team',
    handler: async ({ req, res, json, readBody, httpError, events }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with on, kinds, sizes or limits.');
      try {
        await team.save({ on: body.on, kinds: body.kinds, sizes: body.sizes, limits: body.limits });
      } catch (err) {
        throw refuse(httpError, err);
      }
      events?.publish?.({ type: 'team', reason: 'saved' });
      return json(res, 200, await answer());
    },
  },
  {
    method: 'POST',
    path: '/api/team/use-suggested',
    handler: async ({ req, res, json, httpError, events }) => {
      requireToken(req, httpError);
      await team.ready();
      const suggestion = team.suggested();
      if (!suggestion) throw httpError(409, NOT_KNOWN);
      const kinds = kindsToSave(suggestion);
      if (!kinds) throw httpError(409, NOTHING);
      try {
        await team.save({ on: true, kinds });
      } catch (err) {
        throw refuse(httpError, err);
      }
      events?.publish?.({ type: 'team', reason: 'saved' });
      return json(res, 200, await answer());
    },
  },
  {
    method: 'GET',
    path: '/api/team/pick',
    handler: async ({ res, url, json }) => {
      const q = url.searchParams;
      const level = q.get('level');
      const picked = await team.pick({
        work: q.get('work') ?? '',
        project: q.get('project') || null,
        mode: q.get('mode') || 'ask',
        ...(level ? { level } : {}),
      });
      const skipped = picked.skipped.map(s => ({ ref: s.ref, label: s.label, reason: s.reason }));
      if (picked.ref) return json(res, 200, { ref: picked.ref, label: picked.label, why: picked.why, skipped });
      return json(res, 200, { ref: null, error: picked.error, skipped, ...(picked.empty === true ? { empty: true } : {}) });
    },
  },
  {
    method: 'GET',
    path: '/api/team/log',
    handler: async ({ res, url, json }) => {
      const q = url.searchParams;
      const limit = Number.parseInt(q.get('limit') ?? '', 10);
      const before = Number(q.get('before') ?? NaN);
      const tasks = await teamLog.recent({
        project: q.get('project') || undefined,
        ...(Number.isInteger(limit) ? { limit } : {}),
        ...(Number.isFinite(before) && q.get('before') ? { before } : {}),
      });
      return json(res, 200, { tasks });
    },
  },
  {
    method: 'GET',
    path: '/api/team/usage',
    handler: async ({ res, url, json }) => {
      const q = url.searchParams;
      const days = Number.parseInt(q.get('days') ?? '', 10);
      const known = new Map(team.providersNow().map(p => [p.id, p.label]));
      return json(res, 200, await teamLog.usage({
        ...(Number.isInteger(days) ? { days } : {}),
        project: q.get('project') || undefined,
        labelOf: id => known.get(id) ?? null,
      }));
    },
  },
];

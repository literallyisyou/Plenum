// The Scorecard's routes (wave 6, package sc3; SCORECARD-BRIEF.md sections 5 and 6; lib/scorecard.mjs holds the counts and the rule,
// lib/scorecard-run.mjs runs the checks and the try). All under /api/scorecard, JSON.
//   GET  /api/scorecard                      -> the view of lib/scorecard.mjs view({ team, labelOf, running }): the switch, today's count,
//                                                what was skipped, what runs now, the hold after Stop, the counts of each kind and model,
//                                                the suggestions and the last try (the shape the page reads is written at the top of
//                                                public/ext-scorecard.js). From memory only: no route here starts a model, and the GET is
//                                                not behind the terms gate.
//   POST /api/scorecard { on?, resume? }     on: true | false is the switch; resume: true ends the hold after Stop. -> the view.
//   POST /api/scorecard/move { kind, above, below }   the owner pressed Move: "Move `above` above `below`" (lib/scorecard.mjs
//                                                suggestionFor: `above` is the model that passed more and is lower in the list now, `below`
//                                                the one that goes under it). The pair is
//                                                worked out again here: another pair answers 409 ("The scorecard changed."). The new list
//                                                holds exactly the same models (and every Muse Code, Codex and Gemini model that was in it);
//                                                it is saved through team.save with EVERY kind named (team.save removes an own kind that a
//                                                patch leaves out), and { type: 'team', reason: 'saved' } is published. When team.save refuses
//                                                (400, 409, 503) its own sentence is the answer. -> the view and said: "Moved. Terra is now
//                                                above Luna for Data."
//   POST /api/scorecard/keep { kind, above, below }   the owner pressed Keep: the pair is asked about again only after 20 more checks of
//                                                each (lib/scorecard.mjs keep). The same 409 for a pair that is not the suggestion. -> the
//                                                view and said: "Kept. Plenum asks again after 20 more checks of each."
//   POST /api/scorecard/try { project }      tries each worker of the team once with a tiny task, in the background, on the Agents board
//                                                of that project. -> { started: true, ...the view }.
// Every POST checks the Plenum token here as well (the server checks it on every /api/ request, and every POST waits for the License
// Agreement). A 400 is one plain sentence. Move and Keep go one after another, so two presses never overlap. With the two modules
// missing, every route answers 404 "This build has no scorecard yet." No answer holds a key, a title or an answer text: the view holds
// only counts, labels and states.
import { requireToken } from '../auth.mjs';
import * as teamModule from '../team.mjs';
import { effectiveAgents } from '../agents.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const KIND_ID = /^[a-z0-9-]{1,24}$/;
const REF = /^[a-z0-9-]{1,40}:[^\s\u0000-\u001f\u007f]{1,160}$/;
// The vendors whose models stay in every list, whatever the counts say.
const KEPT_VENDORS = ['muse:', 'codex:', 'gemini:'];

export const SAY = Object.freeze({
  missing: 'This build has no scorecard yet.',
  stale: 'The scorecard changed. Here is what it says now.',
  newer: 'These counts were saved by a newer version of Plenum.',
  unreadable: 'Plenum could not read the saved scorecard just now. Try again in a moment.',
  moved: (above, below, kind) => `Moved. ${above} is now above ${below} for ${kind}.`,
  kept: 'Kept. Plenum asks again after 20 more checks of each.',
  body: 'Send an object with on (true or false) or resume: true.',
  pair: 'Say which suggestion: send kind, above and below.',
  project: 'Open a project first. The tiny tasks run in it.',
  trying: 'The models are being tried now. Stop all ends it.',
  notStarted: 'Plenum could not start the try. Try again in a moment.',
  notMoved: 'The order could not be changed. Nothing was changed.',
});

const refOf = w => (isObject(w) ? String(w.ref ?? '') : String(w ?? ''));

// A module loaded on first use, inside a try, and kept (null when it is not there): without it the routes say the build has no scorecard.
const lazy = rel => {
  let p;
  return () => (p ??= import(new URL(rel, import.meta.url).href).then(m => m, () => null));
};

// The suggestions of a view, from either place the view may hold them: `suggestions` (each names its kind) or a kind's `suggestion`.
export function suggestionsOf(view) {
  const out = [];
  for (const s of Array.isArray(view?.suggestions) ? view.suggestions : []) if (isObject(s)) out.push(s);
  for (const k of Array.isArray(view?.kinds) ? view.kinds : []) {
    if (isObject(k?.suggestion)) out.push({ kind: k.id, ...k.suggestion });
  }
  return out;
}

export function createRoutes(deps = {}) {
  const scorecardOf = deps.scorecard ? async () => deps.scorecard : lazy('../scorecard.mjs');
  const runOf = deps.run ? async () => deps.run : lazy('../scorecard-run.mjs');
  const team = deps.team ?? teamModule;
  const agentsFor = deps.effectiveAgents ?? effectiveAgents;

  // The scorecard module, or a 404 with the one sentence when this build has none.
  async function need(httpError) {
    const sc = await scorecardOf();
    if (!sc || typeof sc.view !== 'function') throw httpError(404, SAY.missing);
    return sc;
  }

  async function viewNow(sc) {
    await team.ready?.();
    await sc.ready?.();
    const run = await runOf();
    let running = null;
    try {
      running = typeof run?.running === 'function' ? await run.running() : null;
    } catch {
      running = null;
    }
    return sc.view({ team: team.get(), labelOf: ref => team.labelOf(ref), running });
  }

  const refuse = (httpError, err, fallback) => httpError(Number.isInteger(err?.status) ? err.status : 500, String(err?.message ?? fallback));

  // Move and Keep go one after another.
  let chain = Promise.resolve();
  const serial = fn => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  // kind, above and below of a POST body, checked as plain names.
  function pairOf(body, httpError) {
    if (!isObject(body) || typeof body.kind !== 'string' || !KIND_ID.test(body.kind) || typeof body.above !== 'string' || !REF.test(body.above)
      || typeof body.below !== 'string' || !REF.test(body.below) || body.above === body.below) throw httpError(400, SAY.pair);
    return { kind: body.kind, above: body.above, below: body.below };
  }

  // The suggestion the server holds for this very pair, or a 409.
  function sameSuggestion(view, pair, httpError) {
    const s = suggestionsOf(view).find(x => x.kind === pair.kind);
    if (!s || s.above !== pair.above || s.below !== pair.below) throw httpError(409, SAY.stale);
    return s;
  }

  // A counts file this build cannot change: one from a newer Plenum (409), or one that cannot be read just now (503). The view says which, in words.
  const readOnly = (view, httpError) => {
    if (view?.newer === true) throw httpError(409, typeof view.status === 'string' && view.status ? view.status : SAY.newer);
    if (view?.unreadable === true) throw httpError(503, typeof view.status === 'string' && view.status ? view.status : SAY.unreadable);
  };

  const routes = [
    {
      method: 'GET',
      path: '/api/scorecard',
      handler: async ({ res, json, httpError }) => json(res, 200, await viewNow(await need(httpError))),
    },
    {
      method: 'POST',
      path: '/api/scorecard',
      handler: async ({ req, res, json, readBody, httpError, events }) => {
        requireToken(req, httpError);
        const body = await readBody(req);
        const hasOn = isObject(body) && body.on !== undefined;
        const hasResume = isObject(body) && body.resume !== undefined;
        if (!isObject(body) || (!hasOn && !hasResume)) throw httpError(400, SAY.body);
        if (hasOn && typeof body.on !== 'boolean') throw httpError(400, 'Send on as true or false.');
        if (hasResume && body.resume !== true) throw httpError(400, 'Send resume as true.');
        const sc = await need(httpError);
        try {
          if (hasOn) await sc.setOn(body.on);
          if (hasResume) await sc.resume();
        } catch (err) {
          throw refuse(httpError, err, 'The change was not saved. Try again.');
        }
        events?.publish?.({ type: 'scorecard', reason: 'changed' });
        return json(res, 200, await viewNow(sc));
      },
    },
    {
      method: 'POST',
      path: '/api/scorecard/move',
      handler: async ({ req, res, json, readBody, httpError, events }) => {
        requireToken(req, httpError);
        const pair = pairOf(await readBody(req), httpError);
        const sc = await need(httpError);
        return serial(async () => {
          const before = await viewNow(sc);
          readOnly(before, httpError);
          const suggested = sameSuggestion(before, pair, httpError);
          const record = team.get();
          const kinds = Array.isArray(record?.kinds) ? record.kinds : [];
          const kind = kinds.find(k => k?.id === pair.kind);
          if (!kind) throw httpError(409, SAY.stale);
          const list = (Array.isArray(kind.workers) ? kind.workers : []).map(refOf);
          let next = typeof sc.moveList === 'function' ? sc.moveList(list, pair.above, pair.below) : null;
          if (!Array.isArray(next) && Array.isArray(next?.list)) next = next.list;
          if (!Array.isArray(next)) throw httpError(409, SAY.stale);
          // The same models, the same number of them, and every Muse Code, Codex and Gemini one still there.
          const same = next.length === list.length && new Set(next).size === next.length && list.every(r => next.includes(r));
          const kept = list.filter(r => KEPT_VENDORS.some(v => r.startsWith(v))).every(r => next.includes(r));
          if (!same || !kept || next.every((r, i) => r === list[i])) throw httpError(409, SAY.stale);
          try {
            // Every kind is named: team.save removes an own kind that the patch leaves out, and a kind sent without workers keeps its list.
            await team.save({ kinds: kinds.map(k => (k.id === pair.kind ? { id: k.id, workers: next } : { id: k.id })) });
          } catch (err) {
            throw refuse(httpError, err, SAY.notMoved);
          }
          events?.publish?.({ type: 'team', reason: 'saved' });
          events?.publish?.({ type: 'scorecard', reason: 'moved' });
          const said = (sc.TEXT?.moved ?? SAY.moved)(suggested.aboveLabel ?? team.labelOf(pair.above), suggested.belowLabel ?? team.labelOf(pair.below), suggested.kindLabel ?? kind.label ?? pair.kind);
          return json(res, 200, { ...(await viewNow(sc)), said });
        });
      },
    },
    {
      method: 'POST',
      path: '/api/scorecard/keep',
      handler: async ({ req, res, json, readBody, httpError, events }) => {
        requireToken(req, httpError);
        const pair = pairOf(await readBody(req), httpError);
        const sc = await need(httpError);
        return serial(async () => {
          const before = await viewNow(sc);
          readOnly(before, httpError);
          sameSuggestion(before, pair, httpError);
          try {
            await sc.keep(pair.kind, pair.above, pair.below);
          } catch (err) {
            throw refuse(httpError, err, 'The answer was not saved. Try again.');
          }
          events?.publish?.({ type: 'scorecard', reason: 'kept' });
          return json(res, 200, { ...(await viewNow(sc)), said: sc.TEXT?.kept ?? SAY.kept });
        });
      },
    },
    {
      method: 'POST',
      path: '/api/scorecard/try',
      handler: async ({ req, res, json, readBody, httpError, events, projectById, store }) => {
        requireToken(req, httpError);
        const body = await readBody(req);
        if (!isObject(body) || typeof body.project !== 'string' || !body.project || body.project.length > 200) throw httpError(400, SAY.project);
        const sc = await need(httpError);
        const run = await runOf();
        if (!run || typeof run.tryEach !== 'function') throw httpError(404, SAY.missing);
        const before = await viewNow(sc);
        readOnly(before, httpError);
        if (before?.running?.type === 'try') throw httpError(409, SAY.trying);
        const project = projectById(body.project);
        let started;
        try {
          started = await run.tryEach({ project, root: project.path, agents: agentsFor(store?.get?.() ?? {}, project) });
        } catch (err) {
          throw refuse(httpError, err, SAY.notStarted);
        }
        if (started?.started === false) throw httpError(409, typeof started.say === 'string' && started.say ? started.say : SAY.notStarted);
        events?.publish?.({ type: 'scorecard', reason: 'try' });
        return json(res, 200, { started: true, ...(await viewNow(sc)) });
      },
    },
  ];
  return routes;
}

export const routes = createRoutes();

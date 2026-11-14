// The routes of the list of what waits for the owner (wave 3, BUSINESS-DESIGN.md section 4.2; lib/decisions.mjs holds the list and the
// contract). All under /api/decisions, JSON.
//   GET  /api/decisions?state=&business=&limit=    -> { waiting, items, hints, notes }   newest first; every item carries refuse (the one
//                                                     refusal, always its last option), payNote, and onlyRefuse + draftNote when only the
//                                                     refusal can answer it (draftLost or noDraft); notes are the sentences the page shows
//                                                     beside every item (the type and the options are the model's words); state is waiting, answered or withdrawn;
//                                                     200 items by default, 500 at most; waiting counts every business
//                                                     An item may carry ask: true (a text question: its answer is the note, which must
//                                                     not be empty), does: true (a thing only the owner can do: Done, Not now or No), link
//                                                     (an address, shown as text) and needs (what the lead needs back).
//                                                     An item with charter: true is the proposal of the owner's instructions: its
//                                                     options are the server's Yes and No, and charterNote is the sentence that
//                                                     says what Yes does (only when a Yes does adopt the text: lib/setup.mjs).
//   POST /api/decisions/answer { n, choice, note?, seen? } -> { item, waiting, record, why, followUp }
//                                                     400 with one sentence for a note that looks like a password, a key or a card number,
//                                                     and for an empty answer to a text question; nothing is saved then.
//                                                     seen: the sha256 that GET /draft gave. A yes to a step outside (a send, publish,
//                                                     spend, account or delete, any item with a draft, any item that talks of money) with
//                                                     a draft needs it, and it must be the hash of the file as it is now: else 409 "The
//                                                     draft changed after you opened it" and nothing is saved. A no needs none.
//                                                     404 for no such item, 409 when it no longer waits, 400 for a choice that is not one of
//                                                     its options. For a send, publish, spend, account or delete the line
//                                                     { type: 'outside', n, action, title, draft, sha256, choice, by: 'owner' } goes on the
//                                                     business's record (record: 'written' | 'none' | 'failed', with a sentence in why), then
//                                                     routines are asked for one follow-up run (followUp says whether they were).
//   POST /api/decisions/withdraw { n }              -> { item, waiting }          "Not needed."; 404 and 409 as above
//   GET  /api/decisions/draft?n=                    -> { name, text, cut, sha256 } the item's draft file as text, 60,000 characters at most;
//                                                     sha256 is of the bytes of the file that were read ('' when it is cut by size).
//                                                     The path is checked again to lie inside the folder and through the guard; 404 with
//                                                     one sentence when the file is gone.
// There is no route that answers several items at once: one tap each (DECISIONS item 61 decided the same for cards). No route here
// reaches the network or starts a program. The server checks the Plenum token on every /api/ request before a handler runs, and every
// POST waits for the License Agreement; the POSTs check the token here as well. Every change publishes { type: 'decisions', waiting }
// (lib/decisions.mjs does). createRoutes(deps) is the same routes on fakes, for the tests.
import { requireToken } from '../auth.mjs';
import * as list from '../decisions.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const NO_ITEM = 'That item is not on the list.';

export function createRoutes(deps = {}) {
  const api = deps.decisions ?? list;
  const business = deps.business ?? list.neighbours.business;
  const routines = deps.routines ?? list.neighbours.routines;
  const setup = deps.setup ?? list.neighbours.setup;

  // A refusal of the list (an Error with a status and one sentence) as the server's own error. Anything else is a save that failed (a
  // full disk, a locked file): nothing was changed, and the sentence says so.
  const refuse = (httpError, err) => (Number.isInteger(err?.status)
    ? httpError(err.status, String(err.message))
    : httpError(500, `Plenum could not save the list, so nothing was changed. Try again. (${list.oneLine(String(err?.message ?? err), 200)})`));

  // The folders an item's draft may be in: the folder of the thread that asked (its isolated copy, when it has one), then the project's.
  function rootsOf(item, { projectById, scopeFor }) {
    let project = null;
    try {
      project = projectById(item.project);
    } catch {
      return [];
    }
    const out = [];
    if (item.thread && typeof scopeFor === 'function') {
      try {
        const scope = scopeFor(project, item.thread);
        if (typeof scope?.root === 'string' && scope.root) out.push(scope.root);
      } catch {
        // The thread is closed or gone: the project's folder is where the draft is looked for.
      }
    }
    if (typeof project?.path === 'string' && project.path && !out.includes(project.path)) out.push(project.path);
    return out;
  }

  const numberOf = (value, httpError) => {
    const n = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(n) || n < 1) throw httpError(400, 'Send n, the number of the item.');
    return n;
  };

  return [
    {
      method: 'GET',
      path: '/api/decisions',
      handler: async ({ res, url, json, httpError }) => {
        const q = url.searchParams;
        const state = q.get('state') ?? '';
        if (state && !list.STATES.includes(state)) throw httpError(400, 'state is waiting, answered or withdrawn.');
        const asked = Number.parseInt(q.get('limit') ?? '', 10);
        const limit = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, 500) : 200;
        // Every item carries the sentence that a yes never pays and never sends by itself (payNote). An item that only the refusal can
        // answer (its draft was never found: draftLost; a send or publish with no draft at all: noDraft) says so: onlyRefuse and draftNote.
        // The proposal of the owner's instructions (charter: true) carries the sentence that says what its Yes does (charterNote), from
        // lib/setup.mjs, which is also what acts on that Yes: an item whose Yes adopts nothing carries no such sentence.
        let setupMod = null;
        try {
          setupMod = (await (typeof setup === 'function' ? setup() : setup)) ?? null;
        } catch {
          setupMod = null;
        }
        const charterNote = i => {
          if (i.charter !== true || i.state !== 'waiting') return '';
          try {
            const text = setupMod?.charterNote?.(i);
            return typeof text === 'string' ? text : '';
          } catch {
            return '';
          }
        };
        const items = api.list({ state: state || undefined, business: q.get('business') || undefined, limit }).map(i => ({ ...i, payNote: list.NO_PAY_SEND, ...(charterNote(i) ? { charterNote: charterNote(i) } : {}), ...(list.onlyRefusal(i) ? { draftNote: list.onlyRefusal(i), onlyRefuse: true, ...(list.needsDraft(i) ? { noDraft: true } : {}) } : {}) }));
        return json(res, 200, { waiting: api.waiting(), items, hints: api.hints?.() ?? [], notes: list.NOTES });
      },
    },
    {
      method: 'POST',
      path: '/api/decisions/answer',
      handler: async ctx => {
        const { req, res, json, readBody, httpError } = ctx;
        requireToken(req, httpError);
        const body = await readBody(req);
        if (!isObject(body)) throw httpError(400, 'Send an object with n and choice.');
        const n = numberOf(body.n, httpError);
        if (typeof body.choice !== 'string' || !body.choice.trim()) throw httpError(400, "Send choice, one of the item's options.");
        const item = api.list({}).find(i => i.n === n);
        try {
          return json(res, 200, await list.answerItem({ n, choice: body.choice, note: body.note, seen: body.seen }, { decisions: api, business, routines, setup, roots: item ? rootsOf(item, ctx) : [] }));
        } catch (err) {
          throw refuse(httpError, err);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/decisions/withdraw',
      handler: async ({ req, res, json, readBody, httpError }) => {
        requireToken(req, httpError);
        const body = await readBody(req);
        if (!isObject(body)) throw httpError(400, 'Send an object with n.');
        const n = numberOf(body.n, httpError);
        try {
          const item = await api.withdraw(n);
          // "Not needed" is something the lead should hear as well: the setup of a business goes on with it (lib/setup.mjs).
          list.tellSetup(setup, item);
          return json(res, 200, { item, waiting: api.waiting() });
        } catch (err) {
          throw refuse(httpError, err);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/decisions/draft',
      handler: async ctx => {
        const { res, url, json, httpError } = ctx;
        const n = numberOf(url.searchParams.get('n') ?? '', httpError);
        const item = api.list({}).find(i => i.n === n);
        if (!item) throw httpError(404, NO_ITEM);
        if (!item.draft) throw httpError(404, 'This item has no draft.');
        const roots = rootsOf(item, ctx);
        if (!roots.length) throw httpError(404, 'The folder of this item is no longer in Plenum.');
        try {
          return json(res, 200, await list.readDraft(roots, item.draft));
        } catch (err) {
          throw refuse(httpError, err);
        }
      },
    },
  ];
}

export const routes = createRoutes();

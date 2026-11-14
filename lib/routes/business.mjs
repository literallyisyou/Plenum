// The business routes (wave 3, BUSINESS-DESIGN.md section 2.2; lib/business.mjs holds the logic). All under /api/business, JSON.
//   GET  /api/business                         -> { v, paused, atOnce, saved, businesses: [record + { waiting, nextRun, lastRun }],
//                                                 templates: [{ id, label, about }] }
//                                                 waiting and nextRun are null while the list and the routines are not part of this build.
//   POST /api/business { name, purpose, project, template?, leads? }
//                                              creates the record, writes the files that are missing in the folder (never overwrites) and
//                                              creates the template's routines switched off -> { business, created: [file], skipped: [text],
//                                              routines: [name] }
//   POST /api/business/update { id, ...fields } checks every field (400 with one plain sentence) -> { business }
//                                              With no id and { atOnce } it sets how many routines may run at the same moment.
//   POST /api/business/status { id, status }    active, paused or closed; pausing and closing also stop the business's running routine
//                                              -> { business }
//   POST /api/business/pause-all { paused }     the one switch for everything -> { v, paused, atOnce, businesses }
//   POST /api/business/charter-seen { id, seen } the owner says the text he looked at is his (seen = files.charter.sha256 of one()): the seal moves to it, so the "changed since the
//                                              owner last confirmed it" line leaves the prompts -> { business, charter: { confirmedAt, changed } }
//                                              409 when BUSINESS.md is a link or in a guarded place, or is no longer the text he saw ("BUSINESS.md
//                                              changed after you opened it. Open it again and check it."; nothing is sealed), 503 when it cannot be read now
//   GET  /api/business/charter?id=              -> { name, state: 'file'|'missing'|'refused'|'unreadable', text, cut, sha256, bytes, changedAt, changed,
//                                                 unknown, confirmedAt, why }: BUSINESS.md as the page shows it before "I made this change".
//                                                 The text and the sha256 come from one read; the page sends that sha256 back as `seen`.
//                                                 sha256 is 'missing' with no file, and '' when the text cannot be confirmed here (too long
//                                                 to show whole, a link, unreadable): why is the sentence to show then.
//   GET  /api/business/one?id=                  -> { business, home, files: { charter: { exists, bytes, changedAt, changed, confirmedAt, sha256?, unknown? }, state: { exists,
//                                                 bytes, changedAt }, plan: { exists, bytes, changedAt, items: [{ mark, text }] },
//                                                 playbooks: [name] }, today: { runs, minutes, runsPerDay, minutesPerDay }, may: { ok, why } }
//   GET  /api/business/brief?range=day|week&id= -> the brief (the shape is at the top of lib/business.mjs)
//   GET  /api/business/log?id=&limit=&before=   -> { lines: [record lines] }, newest first, 50 by default, 200 at most
// An unknown id answers 404 with one sentence. No route changes or removes a line of a record. Every answer comes from Plenum's own files
// and memory: no route here starts a CLI or reaches the network. The server checks the Plenum token on every /api/ request before a
// handler runs, and every POST waits for the License Agreement; the POSTs check the token here as well. The module tells the page about a
// change itself ({ type: 'business', reason, id } on the events channel).
import { requireToken } from '../auth.mjs';
import * as business from '../business.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// A refusal of the business module (an Error with a status and one sentence) as the server's own error.
const refuse = (httpError, err) => httpError(Number.isInteger(err?.status) ? err.status : 500, String(err?.message ?? 'That could not be saved.'));

// Runs one call of the module and answers its refusal as the server's error.
async function run(httpError, fn) {
  try {
    return await fn();
  } catch (err) {
    throw refuse(httpError, err);
  }
}

async function bodyOf(req, readBody, httpError, sentence) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, sentence);
  return body;
}

export const routes = [
  {
    method: 'GET',
    path: '/api/business',
    handler: async ({ res, json }) => json(res, 200, await business.overview()),
  },
  {
    method: 'POST',
    path: '/api/business',
    handler: async ({ req, res, json, readBody, httpError }) => {
      requireToken(req, httpError);
      const body = await bodyOf(req, readBody, httpError, 'Send an object with name, purpose, project and, if you want one, template.');
      return json(res, 200, await run(httpError, () => business.create({ name: body.name, purpose: body.purpose, project: body.project, template: body.template, leads: body.leads })));
    },
  },
  {
    method: 'POST',
    path: '/api/business/update',
    handler: async ({ req, res, json, readBody, httpError }) => {
      requireToken(req, httpError);
      const body = await bodyOf(req, readBody, httpError, 'Send an object with the id of the business and the fields to change.');
      const { id, ...fields } = body;
      if (id == null && Object.keys(fields).length === 1 && Object.hasOwn(fields, 'atOnce')) return json(res, 200, await run(httpError, () => business.setAtOnce(fields.atOnce)));
      if (typeof id !== 'string' || !id) throw httpError(400, 'Send the id of the business.');
      return json(res, 200, { business: await run(httpError, () => business.update(id, fields)) });
    },
  },
  {
    method: 'POST',
    path: '/api/business/status',
    handler: async ({ req, res, json, readBody, httpError }) => {
      requireToken(req, httpError);
      const body = await bodyOf(req, readBody, httpError, 'Send an object with the id of the business and the status.');
      if (typeof body.id !== 'string' || !body.id) throw httpError(400, 'Send the id of the business.');
      return json(res, 200, { business: await run(httpError, () => business.setStatus(body.id, body.status)) });
    },
  },
  {
    method: 'POST',
    path: '/api/business/pause-all',
    handler: async ({ req, res, json, readBody, httpError }) => {
      requireToken(req, httpError);
      const body = await bodyOf(req, readBody, httpError, 'Send paused: true or false.');
      return json(res, 200, await run(httpError, () => business.pauseAll(body.paused)));
    },
  },
  {
    method: 'POST',
    path: '/api/business/charter-seen',
    handler: async ({ req, res, json, readBody, httpError }) => {
      requireToken(req, httpError);
      const body = await bodyOf(req, readBody, httpError, 'Send an object with the id of the business.');
      if (typeof body.id !== 'string' || !body.id) throw httpError(400, 'Send the id of the business.');
      if (typeof body.seen !== 'string' || !body.seen) throw httpError(400, 'Open BUSINESS.md here and read it first: the confirmation is tied to the text you were shown (send seen, the sha256 of GET /api/business/charter).');
      return json(res, 200, await run(httpError, () => business.charterSeen(body.id, body.seen)));
    },
  },
  {
    method: 'GET',
    path: '/api/business/charter',
    handler: async ({ res, url, json, httpError }) => json(res, 200, await run(httpError, () => business.charterText(url.searchParams.get('id') ?? ''))),
  },
  {
    method: 'GET',
    path: '/api/business/one',
    handler: async ({ res, url, json, httpError }) => json(res, 200, await run(httpError, () => business.one(url.searchParams.get('id') ?? ''))),
  },
  {
    method: 'GET',
    path: '/api/business/brief',
    handler: async ({ res, url, json, httpError }) => {
      const range = url.searchParams.get('range') || 'day';
      if (range !== 'day' && range !== 'week') throw httpError(400, 'The range is day or week.');
      return json(res, 200, await run(httpError, () => business.brief(range, url.searchParams.get('id') || null)));
    },
  },
  {
    method: 'GET',
    path: '/api/business/log',
    handler: async ({ res, url, json, httpError }) => {
      const q = url.searchParams;
      const limit = Number.parseInt(q.get('limit') ?? '', 10);
      const before = Number(q.get('before') ?? NaN);
      const lines = await run(httpError, () => business.log(q.get('id') ?? '', {
        ...(Number.isInteger(limit) ? { limit } : {}),
        ...(Number.isFinite(before) && q.get('before') ? { before } : {}),
      }));
      return json(res, 200, { lines });
    },
  },
];

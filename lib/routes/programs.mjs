// The routes of Programs (wave 3, DELEGATION-DESIGN.md section 15.3; lib/programs.mjs holds the logic). Both under /api/programs, JSON.
//   GET  /api/programs                       -> { v, programs: [{ ...entry, state, why, abilities, bestDefault, modelNow: { ref, label,
//                                                why } | null }], limits, hub: { connected, state, wake: 'yes' | 'older' | 'unknown' },
//                                                claudeTools: 'own' | 'type', shareRooms: [businessId], businesses: [{ id, name, hubRoom }] (the ones
//                                                with a hub room), saved, newer?, damaged? }; hub also has handsOff: true | false | null (the hub's
//                                                hands-off mode as the starter last read it), and each hub entry has hubAgent: { status, online,
//                                                wakeable, canStart, at } | null and hubNote: one sentence about being started ('' when nothing is known)
//   POST /api/programs/check {}              -> as GET plus check: { ok, asked?, why?, say? }: asks the hub's own list of agents (status, online,
//                                                presence.wakeable, presence.helper_can_start) once per agent of the record, with an agent Plenum already holds a key for, and
//                                                keeps the answer in memory; the page sends it when the section is drawn. Needs the Plenum token.
//   POST /api/programs { programs?, limits?, shareRooms?, updatedAt? }   updatedAt is the one the page last read: another one answers 409;
//                                                shareRooms are the businesses whose hub room may get a program's result (default none); checks the whole record (400 with one plain sentence), saves, publishes
//                                                { type: 'programs', reason: 'saved' }, answers as GET
//   GET  /api/programs/starts                -> { starts: [{ id, program, label, model, folder, project, scope, title, text, type, lead,
//                                                routine, sha256, askedAt, until }], waitMin, why }: the hand-offs that wait for the owner's
//                                                yes (a program that cannot ask before it acts, in a folder on Ask first; lib/programs.mjs
//                                                askStart). why is the one sentence that says what a yes does. From memory.
//   POST /api/programs/starts/answer { id, allow, seen }  the owner's answer to one such card. allow: true needs seen, the sha256 that
//                                                came with the card that was shown (409 with one sentence otherwise); 404 when the card
//                                                no longer waits. -> { ok: true, started, waiting }. This is the ONLY way such a start is
//                                                answered: it needs the Plenum token (checked here too), no tool or hook of a model calls
//                                                it, and a phone below Full cannot (lib/remote/tiers.mjs: a POST it does not name needs Full).
// state is ready, unknown, off, not-installed, sign-in, limit, other-route, hub-off or hub-down and why is one whole sentence ('' when
// there is nothing to say). abilities is the fixed sentence of what is switched on for that program in a hand-off. bestDefault is the
// built-in line of a built-in program (what Reset puts back). modelNow is the model a hand-off would run on when the lead names none.
// claudeTools says whether this build's lib/claude-cli.mjs gives Claude Code its skills in a hand-off.
// Every answer is read from memory and from Plenum's own file: no route here starts a CLI or reaches the network. The server checks the
// Plenum token on every /api/ request before a handler runs, and every POST waits for the License Agreement; the POST checks the token
// here as well. No answer holds a key.
import { requireToken } from '../auth.mjs';
import * as programs from '../programs.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const DEFAULT_BEST = new Map(programs.BUILT_IN.map(b => [b.id, b.best]));

// The two neighbours this answer reads, loaded on first use inside a try and kept: the hub (is it connected, does it answer) and the
// hub's starter (can it wake an agent). Without either the answer says "unknown".
let hubP;
const hubOf = () => (hubP ??= import(new URL('../hub.mjs', import.meta.url).href).then(m => m, () => null));
let starterP;
const starterOf = () => (starterP ??= import(new URL('../hub-starter.mjs', import.meta.url).href).then(m => m, () => null));

async function hubPart() {
  const out = { connected: false, state: 'off', wake: 'unknown', handsOff: null };
  try {
    const hub = await hubOf();
    const s = hub?.status?.();
    out.connected = s?.settings?.agents === true;
    out.state = typeof s?.health?.state === 'string' ? s.health.state : 'off';
  } catch {
    // The hub's state stays unknown.
  }
  try {
    // What the starter last learned, from its memory only: nothing is started for this answer. The reading is the one the Background
    // services section keeps (snapshot() of the starter's watch); it is null until that section, or Plenum's start, has asked once.
    const starter = await starterOf();
    const known = typeof starter?.known === 'function' ? starter.known()
      : typeof starter?.defaultWatch === 'function' ? starter.defaultWatch().snapshot?.()?.reading ?? null
        : null;
    const contract = Number(known?.state?.contract);
    if (known?.ok === true && typeof known.state?.hands_off === 'boolean') out.handsOff = known.state.hands_off;
    if (known?.ok === true && Number.isFinite(contract) && contract > 0) out.wake = contract >= 2 ? 'yes' : 'older';
    else if (known?.ok === false && known.why === 'older') out.wake = 'older';
  } catch {
    // Whether the starter can wake an agent stays unknown.
  }
  return out;
}

// The businesses that have a hub room, for the owner's switch "Share results in the business room".
let businessP;
const businessOf = () => (businessP ??= import(new URL('../business.mjs', import.meta.url).href).then(m => m, () => null));
async function businessesPart() {
  try {
    const list = (await businessOf())?.list?.();
    return (Array.isArray(list) ? list : [])
      .filter(b => isObject(b) && typeof b.id === 'string' && typeof b.hubRoom === 'string' && b.hubRoom.trim() && b.status !== 'closed')
      .slice(0, 200)
      .map(b => ({ id: b.id, name: String(b.name ?? b.id).slice(0, 60), hubRoom: b.hubRoom.trim().slice(0, 64) }));
  } catch {
    return [];
  }
}

// What the check could not do, in words for the page.
const CHECK_SAY = {
  off: 'Plenum is not connected to Plenum Hub, so it did not ask which agents exist.',
  down: 'Plenum Hub is not answering, so Plenum could not ask which agents exist.',
  'no-agent': 'No chat has used Plenum Hub yet in this version of Plenum, so there is no agent to ask the hub with. The states here come from hand-offs until one has.',
  'no-tool': 'The hub did not offer its list of agents, so Plenum could not ask which agents exist.',
  failed: 'The hub did not answer the question which agents exist.',
};

async function answer() {
  const record = programs.get();
  const hubInfo = await hubPart();
  const list = await Promise.all(record.programs.map(async entry => {
    const [state, model] = await Promise.all([
      programs.state(entry.id).catch(() => ({ state: 'unknown', why: '' })),
      entry.via === 'local' ? programs.modelFor(entry.id).catch(() => null) : null,
    ]);
    return {
      ...entry,
      state: state.state,
      why: state.why,
      abilities: programs.abilities(entry.id),
      ...(entry.builtIn ? { bestDefault: DEFAULT_BEST.get(entry.id) ?? '' } : {}),
      modelNow: model?.ref ? { ref: model.ref, label: model.label, why: model.why } : null,
      ...(entry.via === 'hub' ? { hubAgent: programs.hubAgentInfo(entry.agent), hubNote: programs.hubNote(entry.agent, hubInfo.handsOff) } : {}),
    };
  }));
  return { ...record, programs: list, hub: hubInfo, claudeTools: programs.claudeTools(), businesses: await businessesPart() };
}

// A refusal of the programs module (an Error with a status and one sentence) as the server's own error.
const refuse = (httpError, err) => httpError(Number.isInteger(err?.status) ? err.status : 500, String(err?.message ?? 'The programs could not be saved.'));

// What a yes on a start card does, for the page: said beside the cards, in the server's words.
export const STARTS_WHY = 'These programs take their own steps without asking Plenum, so in a folder on Ask first Plenum asks you once, before the program starts. A yes starts it with the task text shown here, and it then works without further cards. No answer is never a yes.';

export const routes = [
  {
    method: 'GET',
    path: '/api/programs',
    handler: async ({ res, json }) => json(res, 200, await answer()),
  },
  {
    method: 'GET',
    path: '/api/programs/starts',
    handler: async ({ res, json }) => json(res, 200, { starts: programs.starts(), waitMin: Math.max(1, Math.round(programs.START.waitMs / 60_000)), why: STARTS_WHY }),
  },
  {
    method: 'POST',
    path: '/api/programs/starts/answer',
    handler: async ({ req, res, json, readBody, httpError }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body) || typeof body.id !== 'string' || !body.id) throw httpError(400, 'Say which card: send its id, with allow: true or false.');
      try {
        programs.answerStart(body.id, { allow: body.allow, seen: body.seen });
      } catch (err) {
        throw refuse(httpError, err);
      }
      return json(res, 200, { ok: true, started: body.allow === true, waiting: programs.starts().length });
    },
  },
  {
    method: 'POST',
    path: '/api/programs/check',
    handler: async ({ req, res, json, httpError, events }) => {
      requireToken(req, httpError);
      let check = { ok: false, why: 'failed' };
      try {
        // Loaded here: the runner is heavy and nothing needs it until the page asks.
        check = await (await import('../program-run.mjs')).checkHubAgents();
      } catch {
        check = { ok: false, why: 'failed' };
      }
      const out = { ...(await answer()), check: check.ok ? { ok: true, asked: check.asked } : { ok: false, why: check.why, say: CHECK_SAY[check.why] ?? CHECK_SAY.failed } };
      if (check.ok) events?.publish?.({ type: 'programs', reason: 'checked' });
      return json(res, 200, out);
    },
  },
  {
    method: 'POST',
    path: '/api/programs',
    handler: async ({ req, res, json, readBody, httpError, events }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with programs, limits or shareRooms.');
      try {
        await programs.save({ programs: body.programs, limits: body.limits, shareRooms: body.shareRooms, updatedAt: body.updatedAt });
      } catch (err) {
        throw refuse(httpError, err);
      }
      events?.publish?.({ type: 'programs', reason: 'saved' });
      return json(res, 200, await answer());
    },
  },
];

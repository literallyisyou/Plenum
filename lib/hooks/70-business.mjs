// The record of a business's turns (wave 3, BUSINESS-DESIGN.md section 2.6; lib/business.mjs keeps the record). Outside a business both
// steps return at once, so a folder that belongs to no business behaves exactly as before.
//   beforeTurn  notes when the turn began; for a turn of any kind (chat, build, council) in a business folder it also compares BUSINESS.md
//               (the owner's instructions) with the text the owner last confirmed (lib/business.mjs charterCheck: a sha256 kept in the data
//               folder), so an edit made by a stopped turn, a build, a council or a program between turns is flagged before the next turn.
//   afterTurn   for any turn that reaches it, stopped or not, and of any kind, compares BUSINESS.md again: a change is flagged (once for the
//               same text) and the chat is told, because only the owner edits that file. A chat turn that was not stopped also appends the turn
//               line: who started it (the owner, or a routine through lib/routines.mjs isRoutineRun), the lead, how long it took, its usage,
//               and the DONE: and NEXT: lines of the reply. A stopped turn or a build writes no turn line.
//               (server.mjs calls afterTurn only for a turn that was not stopped; the next beforeTurn and the next prompt catch the rest.)
// Neither step stops a turn or changes a file of the project. lib/routines.mjs is loaded on first use through lib/business.mjs.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import * as business from '../business.mjs';
import { labelFor } from '../providers.mjs';

export const CHARTER_CHANGED = 'BUSINESS.md changed during a model\'s turn.';
export const CHARTER_CHANGED_BETWEEN = 'BUSINESS.md changed since the owner last confirmed it, outside a finished turn.';
const BETWEEN = CHARTER_CHANGED_BETWEEN;
const NOTICE = 'BUSINESS.md changed during this turn. Only you edit that file: look at the change before the next run.';
// Joint round: the same for a change found before a turn starts. The prompt is built before the hooks run and flags the change on the
// record first, so "newly flagged" is already used up when beforeTurn looks; the chat is told by what the hook itself has said so far.
export const NOTICE_BETWEEN = 'BUSINESS.md is not the text you last confirmed. Only you edit that file: read it under Setup in Businesses and confirm it, or put your own text back.';

// The last line of the reply that starts with the word (DONE: or NEXT:), without the word, or ''.
export function lineAfter(text, word) {
  const rows = String(text ?? '').split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    // A quoted row (starting with >) is somebody else's text that the reply repeats, not the reply's own DONE: or NEXT: line.
    if (rows[i].trimStart().startsWith('>')) continue;
    const row = rows[i].replace(/^[\s*_#-]+/, '');
    if (row.toUpperCase().startsWith(`${word}:`)) return row.slice(word.length + 1).replace(/^[\s*_]+/, '').replace(/[\s*_]+$/, '').slice(0, 300);
  }
  return '';
}

export function createHook(deps = {}) {
  const biz = deps.business ?? business;
  const now = deps.now ?? (() => Date.now());
  const label = deps.labelFor ?? labelFor;
  // What beforeTurn noted, by the turn's own context object (the server passes the same one to afterTurn).
  const noted = new WeakMap();
  // The text of BUSINESS.md (its hash) the chat was last told about, by business.
  const told = new Map();

  // The size and time stamp of the business's BUSINESS.md, or null when it is not there.
  async function charterOf(id) {
    const home = biz.homeOf(id);
    if (!home) return null;
    try {
      const s = await fsp.stat(path.join(home, 'BUSINESS.md'));
      return { size: s.size, changedAt: Math.round(s.mtimeMs) };
    } catch {
      return null;
    }
  }
  const same = (a, b) => (a === null || b === null ? a === b : a.size === b.size && a.changedAt === b.changedAt);

  // BUSINESS.md against the seal, for a turn of any kind; the flag line (once for the same text) and the notice go from here.
  async function checkCharter(ctx, b, text) {
    if (typeof biz.charterCheck !== 'function') return null;
    let result = null;
    try {
      result = await biz.charterCheck(b.id, text ? { text } : undefined);
    } catch {
      return null;
    }
    // Told once for the same text (by its hash; a file that cannot be hashed counts by its state), and again only after it was confirmed
    // or changed once more. A Plenum that was restarted says it once more, which is the safe side.
    if (result && result.changed !== true) told.delete(b.id);
    else if (result) {
      const key = String(result.sha256 || result.state || 'changed');
      if ((result.newlyFlagged || told.get(b.id) !== key) && typeof ctx.send === 'function') ctx.send({ type: 'notice', text: text === BETWEEN ? NOTICE_BETWEEN : NOTICE });
      told.set(b.id, key);
    }
    return result;
  }

  async function beforeTurn(ctx) {
    if (!ctx?.project?.id) return;
    const b = biz.businessFor(ctx.project.id);
    if (!b) return;
    // A follow-up of the same turn (auto-fix) keeps the first note: the turn began then, and a change made since is the turn's own.
    if (noted.has(ctx)) return;
    // Any kind of turn: what changed since the owner last confirmed BUSINESS.md is flagged before this turn starts (B2).
    await checkCharter(ctx, b, BETWEEN);
    if (ctx.kind !== 'chat') return;
    noted.set(ctx, { id: b.id, at: now(), charter: await charterOf(b.id) });
  }

  async function afterTurn(ctx, turn) {
    if (!ctx?.project?.id) return;
    const b = biz.businessFor(ctx.project.id);
    if (!b) return;
    const note = noted.get(ctx) ?? null;
    noted.delete(ctx);
    // A stopped turn, a build and a council write no turn line, but the charter is checked for them all (B2).
    if (ctx.kind !== 'chat' || ctx.signal?.aborted) {
      await checkCharter(ctx, b, CHARTER_CHANGED);
      return;
    }
    const thread = ctx.scope?.threadId ?? ctx.scope?.id ?? ctx.project.id;

    // A routine's run is a chat turn in the project's Routines thread; the routines module says whether this one is.
    let routine = null;
    try {
      const routines = await biz.neighbour('routines');
      routine = (await routines?.isRoutineRun?.(ctx.project.id, thread)) || null;
    } catch {
      routine = null;
    }
    let name = '';
    try {
      name = label(ctx.ref);
    } catch {
      name = String(ctx.ref ?? '');
    }
    const u = turn?.usage ?? null;
    // The stored reply keeps the failure's sentence; turn.error itself only says that there was one.
    let error = '';
    if (turn?.error) {
      const reply = (() => {
        try {
          return ctx.store?.transcript?.(ctx.scope?.id)?.at(-1) ?? null;
        } catch {
          return null;
        }
      })();
      error = typeof turn.error === 'string' ? turn.error : typeof reply?.error === 'string' && reply.role === 'assistant' ? reply.error : 'The reply ended with an error.';
    }
    await biz.record(b.id, {
      type: 'turn',
      project: ctx.project.id,
      thread,
      by: routine ? 'routine' : 'owner',
      ...(routine && typeof routine === 'object' ? { routine: routine.id, name: routine.name } : typeof routine === 'string' ? { routine } : {}),
      lead: { ref: ctx.ref, label: name },
      ms: note ? Math.max(0, now() - note.at) : 0,
      usage: u ? { billing: u.billing, input: u.input, output: u.output, dollars: u.cost?.dollars } : null,
      done: lineAfter(turn?.text, 'DONE'),
      next: lineAfter(turn?.text, 'NEXT'),
      ...(error ? { error } : {}),
    });

    // The turn line first, then the charter. Without a seal (a business module that has no charterCheck) the old size-and-time
    // comparison of this turn still stands.
    const checked = await checkCharter(ctx, b, CHARTER_CHANGED);
    if (checked === null && note && note.id === b.id && !same(note.charter, await charterOf(b.id))) {
      await biz.record(b.id, { type: 'flag', text: CHARTER_CHANGED });
      if (typeof ctx.send === 'function') ctx.send({ type: 'notice', text: NOTICE });
    }
  }

  return { beforeTurn, afterTurn };
}

const hook = createHook();
export const beforeTurn = ctx => hook.beforeTurn(ctx);
export const afterTurn = (ctx, turn) => hook.afterTurn(ctx, turn);

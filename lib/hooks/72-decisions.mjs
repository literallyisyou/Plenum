// What waits for the owner, around a chat turn (wave 3, BUSINESS-DESIGN.md section 4; lib/decisions.mjs holds the list and the contract).
// Only in a project that belongs to a business (lib/business.mjs businessFor, loaded on first use): any other chat gets nothing from this
// hook, and without the business module nothing happens at all.
//   expandMessage  adds the block OWNER'S ANSWERS to the next message of the thread that asked (or of the project, when that thread is
//                  closed or gone): what the owner answered, and what he said is not needed. Not in plan mode, where the model could not
//                  act on it; the answers wait for the next turn that can.
//   afterTurn      marks those answers as delivered when the turn did not fail (a stopped turn never comes here, so its answers go again),
//                  then reads the OWNER: lines at the end of the reply and puts them on the list:
//                    OWNER: <type> | <title> | recommend: <choice> | options: A / B / C | draft: outbox/<file>
//                  Five lines a turn at most; a title that already waits is not added twice; 20 wait per business at most (one notice
//                  says so); a draft that is not a file inside the turn's folder (missing, a link, a second name of a file, outside) is dropped
//                  and the item stays; a send, publish, spend, account or delete in that case can only be refused, and one notice says so.
//                  A send or a publish with no draft at all can only be refused as well (one notice); the same line written again with a
//                  draft puts the draft on the item that waits.
// Everything in a line was written by a model: it becomes text in an item, never an instruction to Plenum. The block is written only from
// Plenum's own file, which only the owner's page changes.
// Comes after 70-business.mjs in the file-name order. createHook(deps) is the same hook on fakes, for the tests.
import { labelFor } from '../providers.mjs';
import * as list from '../decisions.mjs';

const say = (ctx, text) => {
  if (typeof ctx.send === 'function') ctx.send({ type: 'notice', text });
};
const numbers = ns => {
  const tags = ns.map(n => `#${n}`);
  return tags.length > 1 ? `${tags.slice(0, -1).join(', ')} and ${tags.at(-1)}` : tags[0] ?? '';
};
const DRAFT_WHY = {
  outside: 'is not a file inside this folder',
  missing: 'was not found in this folder',
  refused: 'is a file Plenum does not open',
};
const UNREADABLE_NOTICE = "The owner's list could not be read just now, so nothing was added to it. Ask again in a moment.";
const NEWER_NOTICE = "The owner's list was saved by a newer version of Plenum, so nothing was added to it.";

export function createHook(deps = {}) {
  const d = {
    decisions: deps.decisions ?? list,
    business: deps.business ?? list.neighbours.business,
    routines: deps.routines ?? list.neighbours.routines,
    labelFor: deps.labelFor ?? labelFor,
    resolveDraft: deps.resolveDraft ?? list.resolveDraft,
  };
  // The numbers each turn's message carried, by the turn's own context object.
  const carried = new WeakMap();

  // The business a turn works for, or null. Null as well when the business module is missing or fails.
  async function businessOf(ctx) {
    if (ctx?.kind !== 'chat' || typeof ctx.project?.id !== 'string') return null;
    try {
      const mod = await d.business();
      if (typeof mod?.businessFor !== 'function') return null;
      const found = await mod.businessFor(ctx.project.id);
      return typeof found?.id === 'string' && found.id ? found : null;
    } catch {
      return null;
    }
  }

  // The routine this turn is a run of ('' for a turn the owner started).
  async function routineOf(ctx) {
    try {
      const mod = await d.routines();
      if (typeof mod?.isRoutineRun !== 'function') return '';
      const run = await mod.isRoutineRun(ctx.project.id, ctx.scope?.id ?? ctx.project.id);
      if (typeof run === 'string') return run;
      // A follow-up run has an empty id (lib/routines.mjs isRoutineRun): its name stands for it, so the item still says a routine asked.
      if (run && typeof run === 'object') return String(run.id || run.routine || run.name || 'routine');
      return run === true ? 'routine' : '';
    } catch {
      return '';
    }
  }

  async function expandMessage(ctx) {
    if (ctx?.kind !== 'chat' || ctx.planMode || typeof ctx.project?.id !== 'string') return undefined;
    // The list is read first: it is in memory, and most messages have nothing waiting for them.
    const thread = ctx.scope?.id ?? ctx.project.id;
    if (!d.decisions.pendingFor(ctx.project.id, thread).length) return undefined;
    // Only the answers of the business this lead works for: a folder that changed hands from one business to another does not hand the
    // old business's answers to the new lead (they stay on the list, for the owner).
    const business = await businessOf(ctx);
    if (!business) return undefined;
    const pending = d.decisions.pendingFor(ctx.project.id, thread, business.id).slice(0, list.LIMITS.blockLines);
    if (!pending.length) return undefined;
    const block = list.answersBlock(pending);
    if (!block) return undefined;
    carried.set(ctx, pending.map(i => i.n));
    return { blocks: [block], labels: [], notes: [`The owner's answers went to the model with this message: ${numbers(pending.map(i => i.n))}.`] };
  }

  async function afterTurn(ctx, turn) {
    if (ctx?.kind !== 'chat' || typeof ctx.project?.id !== 'string') return;
    const ns = carried.get(ctx);
    if (ns?.length && !turn?.error) {
      carried.delete(ctx);
      await d.decisions.markDelivered(ns);
    }
    const text = typeof turn?.text === 'string' ? turn.text : '';
    if (!text.includes('OWNER')) return;
    const parsed = list.parseOwnerLines(text);
    if (!parsed.lines.length && !parsed.untitled) return;
    const business = await businessOf(ctx);
    if (!business) return;

    const routine = parsed.lines.length ? await routineOf(ctx) : '';
    let label = '';
    try {
      label = String(d.labelFor(ctx.ref) ?? '');
    } catch {
      // A model Plenum has no name for is shown by its id.
    }
    const added = [];
    const notes = [];
    const lost = [];
    const bare = [];
    const mended = [];
    let full = false;
    let newer = false;
    let unreadable = false;
    for (const line of parsed.lines) {
      let draft = '';
      let dropped = '';
      if (line.draft) {
        const got = await d.resolveDraft(ctx.scope?.root ?? ctx.project.path, line.draft);
        if (got.ok) draft = got.rel;
        else dropped = DRAFT_WHY[got.why] ?? DRAFT_WHY.outside;
      }
      const res = await d.decisions.add({
        business: business.id, project: ctx.project.id, thread: ctx.scope?.id ?? ctx.project.id,
        from: { ref: typeof ctx.ref === 'string' ? ctx.ref : '', label }, routine,
        type: line.type, title: line.title, options: line.options, recommend: line.recommend, draft, draftLost: Boolean(dropped),
      });
      if (res.added) {
        added.push(res.item);
        if (res.item.draftLost) lost.push(res.item.n);
        else if (list.needsDraft(res.item)) bare.push(res.item.n);
        else if (dropped) notes.push(`The draft of #${res.item.n} (${list.oneLine(line.draft, 120)}) ${dropped}, so the item has no draft.`);
      } else if (res.mended) mended.push(res.item.n);
      else if (res.why === 'full') full = true;
      else if (res.why === 'newer') newer = true;
      else if (res.why === 'unreadable') unreadable = true;
    }
    if (added.length === 1) say(ctx, `Added to the owner's list: #${added[0].n} "${added[0].title}".`);
    else if (added.length) say(ctx, `Added to the owner's list: ${numbers(added.map(i => i.n))}.`);
    for (const note of notes) say(ctx, note);
    // A step outside whose draft could not be found inside the folder stays on the list, and only the owner's "No" can answer it: said once.
    if (lost.length) say(ctx, `${list.DRAFT_LOST} (${numbers(lost)}.) Put the draft inside this folder and write the OWNER: line again.`);
    // A send or a publish with no draft at all: the owner has nothing to read, so he can only refuse it. Said once, with the way out.
    if (bare.length) say(ctx, `${list.NO_DRAFT} (${numbers(bare)}.) Save the text under outbox/ and write the OWNER: line again with draft: outbox/<file>.`);
    if (mended.length) say(ctx, `The draft is now on ${numbers(mended)} of the owner's list.`);
    if (full) say(ctx, list.FULL_NOTICE);
    if (newer) say(ctx, NEWER_NOTICE);
    if (unreadable) say(ctx, UNREADABLE_NOTICE);
    if (parsed.more) say(ctx, `Only five OWNER: lines of a reply go on the list. ${parsed.more} more ${parsed.more === 1 ? 'was' : 'were'} left out.`);
    if (parsed.untitled) say(ctx, parsed.untitled === 1 ? 'An OWNER: line with no title was left out.' : `${parsed.untitled} OWNER: lines with no title were left out.`);
  }

  return { expandMessage, afterTurn };
}

const hook = createHook();
export const expandMessage = ctx => hook.expandMessage(ctx);
export const afterTurn = (ctx, turn) => hook.afterTurn(ctx, turn);

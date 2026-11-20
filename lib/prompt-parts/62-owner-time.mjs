// What a lead is told about the owner's time (wave 8; lib/owner-time.mjs counts it and writes the text). Only a chat in a folder that
// belongs to a business gets it, and only once the owner's minutes for all his businesses this week reach 80% of the limit he set
// (600 minutes unless he changed it): the lead is then told to hold every OWNER: ask that can wait for the next weekly batch, and to go
// on asking at once what cannot wait. Below 80%, and in any other chat, this part gives nothing, so the system text is byte for byte
// what it was without this file.
// The text is added only: nothing here approves an action, widens a folder, turns a tool on, or refuses an ask. Whether an ask is put on
// the owner's list is never decided here (lib/hooks/72-decisions.mjs puts every OWNER: line on it, as before).
import * as business from '../business.mjs';
import * as ownerTime from '../owner-time.mjs';
import { projectForRoot } from '../prompt.mjs';

// The project of this call: the one the caller named, else the one whose folder is ctx.root (as lib/prompt-parts/60-business.mjs).
const projectIdOf = ctx => ctx?.projectId ?? ctx?.project?.id ?? projectForRoot(ctx?.root)?.id ?? null;

// createPart(deps) is the same part on fakes, for the tests.
export function createPart(deps = {}) {
  const biz = deps.business ?? business;
  const meter = deps.ownerTime ?? ownerTime;
  const idOf = deps.projectIdOf ?? projectIdOf;
  return {
    id: 'owner-time',
    // After the business block (60) and before the project's file list (90).
    order: 62,
    contexts: ['chat'],
    text: async ctx => {
      const found = await biz.businessFor(idOf(ctx));
      if (typeof found?.id !== 'string' || !found.id) return null;
      return meter.promptLine(found.id);
    },
  };
}

export const parts = [createPart()];

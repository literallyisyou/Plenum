// What a lead working for a business is told (wave 3, BUSINESS-DESIGN.md section 2.5; lib/business.mjs promptFor writes the text).
// Only a chat in a folder that belongs to a business gets it: the owner's instructions (BUSINESS.md, up to 6,000 characters, with a line
// that says so when the file is longer), the state file (STATE.md, up to 3,000), the last three finished turns from the record, and the
// fixed lines on how to work there (what always waits for the owner and the OWNER: line, never a password and never a payment, delegate by
// kind of work, keep PLAN.md and STATE.md, the hub room when one is set and the hub is connected, stay inside the business's folders).
// Any other chat gets nothing, so its system text is byte for byte what it was without this file. Workers do not get this text: they get
// the one rule line in their brief (lib/team-run.mjs).
// The text is added only: nothing here approves an action, widens a folder or turns a tool on.
import * as business from '../business.mjs';
import { projectForRoot } from '../prompt.mjs';

// The project of this call: the one the caller named, else the one whose folder is ctx.root.
const projectIdOf = ctx => ctx?.projectId ?? ctx?.project?.id ?? projectForRoot(ctx?.root)?.id ?? null;

// Order 60 puts the block after the fixed texts (core, rules, focus, attachments) and before the project's file list (90).
export const parts = [
  {
    id: 'business',
    order: 60,
    contexts: ['chat'],
    text: async ctx => business.promptFor(projectIdOf(ctx)),
  },
];

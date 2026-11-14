// What waits for the owner: one list across all businesses (wave 3, BUSINESS-DESIGN.md section 4). A lead working for a business ends its
// reply with OWNER: lines; lib/hooks/72-decisions.mjs turns them into items here; the owner answers each with one tap
// (lib/routes/decisions.mjs); the answer goes to the lead with its next message. Silence is never a yes: an item waits until the owner
// answers it or says it is not needed. There is no default answer, no timer and no "answer all".
//
// THE CONTRACT (other packages build to it; build/v06/ultra-w3-decisions pins each part):
//   The line a lead writes, at the end of its reply (only the trailing lines are read: DONE:, NEXT: and OPEN: lines may stand between,
//   and at most two closing lines may follow; an OWNER: line in the middle of a reply, for example in quoted text, is never read):
//     OWNER: <type> | <title> | recommend: <choice> | options: A / B / C | draft: outbox/<file>
//     Only the title is needed. type is question (the default), plan, send, publish, spend, account or delete. Options default to Yes and
//     No. "OWNER: none" is no item. At most five lines of a reply become items.
//   The file: decisions.json in store.HOME,
//     { v: 1, n, items: [{ n, business, project, thread, from: { ref, label }, routine, type, title, options: [text], recommend, draft,
//       state: 'waiting' | 'answered' | 'withdrawn', answer: null | { choice, note, at, sha256 }, recorded (an answered item only), delivered, createdAt }] }
//     (a withdrawn item also has withdrawnAt). n counts up and is never used twice. An answered or withdrawn item is kept 30 days, and for
//     as long as it is owed: the lead has not been told of it (it has a thread) or its line is not on the business's record (recorded: false).
//     answer.sha256 is the hash of the draft the owner was shown when he said yes ('' with none); it is saved in the same atomic write as the
//     answer, so that a crash before the line reaches the record loses nothing: the line is written at the next start.
//   Every item has one refusal that the SERVER adds and words (REFUSE, "No"; item.refuse; always the last option). Whether an answer is a
//   refusal is never read from an option's text: the model's own options, even "No problem, send it", are all a yes for `seen`, the hash
//   and the pays-himself line. An item of a send, publish, spend, account or delete type (or one that talks of money) whose draft could not
//   be resolved inside the business folder has draftLost: true; only the refusal can answer it (409 with DRAFT_LOST). A send or a publish
//   with no draft at all (needsDraft) can only be refused as well (409 with NO_DRAFT); a later OWNER: line of the same title that brings a
//   draft puts it on the item that waits. A spend, an account and a delete may have no draft. Titles and options
//   lose zero-width and direction characters. Every answer block carries NO_PAY_SEND as its second line, and GET /api/decisions puts it on
//   every item (payNote). The money word list is an extra; the sentence is the guard. A line that could not be written is tried again at
//   the next add, withdraw or markDelivered of the default instance (no timer), and is looked for by its key in the record from the
//   answer's own moment back, so it is never written twice. An empty read of the file is retried and is damaged only when still empty
//   and 0 bytes (dep size).
//   createDecisions(deps) -> an instance; the default instance's functions are exported below under the same names.
//     deps: dir (the data folder), now, write (writeFileAtomic), publish (lib/events.mjs), threadOpen(projectId, threadId) -> boolean,
//     read (path -> text; the default is readFileSync), sleep (ms -> promise).
//   A file that is there but cannot be read (locked, no access: not ENOENT) is NOT an empty list. Nothing is put in force, a change reads
//   again a few times and then refuses: add answers { added: false, why: 'unreadable' }; answer and withdraw throw 503 and one sentence;
//   markDelivered marks nothing; the file on the disk is never replaced by an empty list. hints() says so.
//   Two Plenum windows share one instance (one server), so two answers to one item cannot both win: the second is a 409.
//   add(item)                 -> a promise of { added: true, item } | { added: false, why: 'title' | 'business' | 'double' | 'full' | 'newer' | 'unreadable', item? }
//                                item: { business, title, type?, options?, recommend?, draft?, project?, thread?, from?, routine? }. A title that
//                                already waits for the business is not added twice ('double', with the item that waits); at most 20 wait per
//                                business ('full'). An item with no thread was not asked in a chat (a routine's own question): its answer is
//                                never put into a message.
//   list({ state, business, project, limit }) -> copies of the items, newest first
//   answer(n, choice, note, { sha256 }) -> a promise of the item (the route calls answerItem, below, which checks the draft first); an Error with status 404 (no such item), 409 (it no longer waits) or 400 (the choice
//                                is not one of its options, or the note is too long), and one plain sentence
//   withdraw(n)               -> a promise of the item ("Not needed."); 404 and 409 as above
//   waiting(business?)        -> how many items wait (for one business, or in all)
//   pendingFor(project, thread, business?) -> with a business id, only that business's items (the hook always gives it: a folder can
//                                change hands between businesses); the answered and withdrawn items a lead has not been told yet, for the thread that asked, or for any
//                                thread of the project when the thread that asked is closed or gone; newest first
//   markDelivered(ns)         -> a promise of how many were marked      markRecorded(ns) -> the same for the record's flag
//   migrate(raw)              -> a v1 record from an older, a damaged or a newer file; it never throws
//   hints()                   -> short lines for the page (a file from a newer version, a file that could not be read)
//   Every change publishes { type: 'decisions', waiting } on the events channel.
//   Beside the instance: parseOwnerLines(text), answersBlock(items), resolveDraft(root, rel), openDraft(roots, rel), readDraft(roots, rel), hashDraft(roots, rel),
//   answerItem(input, deps) (what POST /api/decisions/answer does: it calls business.record(id, entry) and then
//   routines.followUp({ business, project, thread, n })) and neighbours (business and routines, loaded on first use).
//   What an answer looks like to the lead (answersBlock; section 4.3):
//     OWNER'S ANSWERS (from Plenum's list; act on these first)
//     #41 send "Delivery note for this week's file": chose "Yes". Note: use the short version.
//     #38 spend "A form add-on, $12 a month": chose "Yes". The owner pays himself: do not pay.
//     #37 publish "Listing text for the kit": Not needed.
//     The choice is quoted because it is the model's wording of an option. A withdrawn item prints its title cut to 40 characters.
//   Every answer goes on the business's record (business.record(id, entry)), with at = the moment of his tap:
//     (both lines carry refused: true when the answer was the program's own refusal, and note when he wrote one)
//     { type: 'outside', at, n, action, title, draft, sha256, choice, by: 'owner' }   for a send, publish, spend, account or delete, and for
//       any item with a draft or one that talks of money, whatever type the model gave it (the type is the model's word: it cannot avoid the
//       record); sha256 is the hash of the draft the owner was shown ('' with none)
//     { type: 'decision', at, n, action, title, choice, by: 'owner' }   for any other answer (lib/business.mjs lineOf must know the type)
//     A spend, or any item that talks of money, answered with anything but a no carries 'The owner pays himself: do not pay.'
//   A yes to a step outside with a draft is tied to what he was shown: POST /answer takes `seen`, the sha256 that GET /draft gave (answerItem).
//
// RULES THIS MODULE KEEPS: every text of an item came from a model, so it is data: one line, control characters removed, cut to a length,
// shown by the page through textContent and quoted in the answer block. A newer file is read and never written. Nothing is written until
// there is something to save, and one write runs at a time. It awaits no import at its top and imports nothing from lib/business.mjs,
// lib/routines.mjs, lib/routes/index.mjs or lib/turn-hooks.mjs: the two neighbours are loaded on first use, inside a function.
import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { writeFileAtomic } from './atomic-write.mjs';
import { checkAccess, isSecretFileName } from './guard.mjs';
import { publish } from './events.mjs';
import { findThread, isOpen, threadsOf } from './threads.mjs';
import { CODE_ROOT, moduleUrl } from './overlay.mjs';
import * as store from './store.mjs';

export const VERSION = 1;
export const TYPES = Object.freeze(['question', 'plan', 'send', 'publish', 'spend', 'account', 'delete']);
// The types that are a step outside the PC or one that cannot be taken back: an answer to one goes on the business's record.
export const OUTSIDE_TYPES = Object.freeze(['send', 'publish', 'spend', 'account', 'delete']);
export const STATES = Object.freeze(['waiting', 'answered', 'withdrawn']);
export const DEFAULT_OPTIONS = Object.freeze(['Yes', 'No']);
export const LIMITS = Object.freeze({
  perTurn: 5, waitingPerBusiness: 20, title: 200, options: 6, option: 60, recommend: 120, note: 500, draft: 260, label: 80, ref: 200,
  keepMs: 30 * 24 * 60 * 60_000, items: 2000, draftChars: 60_000, hashBytes: 64 * 1024 * 1024, blockLines: 20,
});
export const FULL_NOTICE = 'The owner already has 20 open items for this business.';
export const ANSWERS_HEAD = "OWNER'S ANSWERS (from Plenum's list; act on these first)";
export const PAYS_HIMSELF = 'The owner pays himself: do not pay.';
// The one sentence every answer block and every item's head carries, in any language of any title: a yes by itself neither pays nor sends.
// It promises only what the code does. Recording an answer runs nothing: it puts a line on the record and tells the lead. Whether the
// step the lead then takes shows a card is not this module's to promise: a card is shown in a folder on Ask first, by a model or a
// program whose steps come to Plenum (Codex, Gemini CLI and Muse Code take theirs without asking; in Auto-approve and Approve all
// nothing asks).
export const NO_PAY_SEND = 'A yes never pays and never sends by itself: the owner pays himself, and a send that follows shows its own card only in a folder on Ask first, from a model or program that asks Plenum before it acts.';
// The refusal every item has. The SERVER adds it and words it; whether an answer is a refusal is never read from the model's option text.
export const REFUSE = 'No';
export const DRAFT_LOST = 'The draft could not be found, so this cannot be approved here.';
// A send or a publish with no draft at all: there is nothing the owner could read, so only the refusal can answer it (the coordinator's
// decision of the joint round). A spend, an account and a delete may have no draft.
export const NO_DRAFT = 'There is no draft to read, so this cannot be approved here.';
export const DRAFT_TYPES = Object.freeze(['send', 'publish']);
export const needsDraft = item => DRAFT_TYPES.includes(item?.type) && !item?.draft && item?.draftLost !== true;
// The sentence of an item that only the refusal can answer, or '' for an item that can be approved.
export const onlyRefusal = item => (item?.draftLost === true ? DRAFT_LOST : needsDraft(item) ? NO_DRAFT : '');
export const NOT_NEEDED = 'Not needed.';
export const NEWER_TEXT = 'This list was saved by a newer version of Plenum. It is shown here and cannot be changed until Plenum is updated.';
export const DAMAGED_TEXT = 'The saved list could not be read, so it starts empty. The next change keeps the old file beside it as decisions.damaged.json.';
export const UNREADABLE_TEXT = 'Plenum could not read the list just now. Try again in a moment.';
export const UNREADABLE_HINT = 'The saved list could not be read just now (another program may hold the file). Nothing was changed or lost; Plenum tries again on the next change.';
export const DRAFT_CHANGED = 'The draft changed after you opened it. Open it again and check it.';
export const DRAFT_UNSEEN = 'Open the draft and read it before you say yes.';
export const DRAFT_TOO_LONG = 'That draft is too long to show in full. Open the file yourself; a yes cannot be recorded for text you have not seen.';
export const DRAFT_GONE_YES = 'That draft is no longer there, so a yes cannot be recorded. Answer No, or ask for a new draft.';
// Said on the page beside an item (GET /api/decisions answers them as `notes`): the type and the options are the model's words.
export const NOTES = Object.freeze({ options: 'These options were written by the model.', type: 'The type was chosen by the model.', pay: NO_PAY_SEND, draftLost: DRAFT_LOST, noDraft: NO_DRAFT });
const NO_ITEM = 'That item is not on the list.';
const NOT_WAITING = 'That item no longer waits for an answer.';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const BUSINESS_ID = /^[A-Za-z0-9_-]{1,64}$/;
const INVISIBLE = /[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
// One line of plain text: control characters and line breaks become a space, runs of space become one, and the text is cut to max.
export function oneLine(value, max) {
  if (typeof value !== 'string') return '';
  // Zero-width, soft-hyphen and direction characters are removed (a title may not hide a word with them); control characters become a space.
  const text = value.replace(INVISIBLE, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  // Never half of a character pair.
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}
const fold = text => String(text).toLowerCase().replace(/\s+/g, ' ').trim();
const posInt = v => Number.isInteger(v) && v > 0;
const time = v => (Number.isFinite(v) && v > 0 ? v : 0);

// The options of an item: the model's own (text, one line each, no two alike, six at most; none means Yes) and then the server's refusal,
// REFUSE, always last. An option of the model's that is exactly the refusal is the refusal (not repeated); one that only looks like a
// refusal ("No problem, send it") stays, and is a yes in every check. Whether an answer is a refusal is `isRefusal`, never the text.
function cleanOptions(raw) {
  const out = [];
  const seen = new Set([fold(REFUSE)]);
  for (const o of Array.isArray(raw) ? raw : []) {
    const text = oneLine(o, LIMITS.option);
    if (!text || seen.has(fold(text)) || out.length >= LIMITS.options) continue;
    seen.add(fold(text));
    out.push(text);
  }
  return [...(out.length ? out : [DEFAULT_OPTIONS[0]]), REFUSE];
}
// Whether `choice` (one of the item's options) is the server's refusal of that item.
export const isRefusal = (item, choice) => typeof choice === 'string' && fold(choice) === fold(item?.refuse || REFUSE);

// A draft path as an item keeps it: relative, forward slashes, no step upward. '' for anything else.
function cleanDraft(raw) {
  const text = oneLine(raw, LIMITS.draft + 1).replace(/\\/g, '/');
  if (!text || text.length > LIMITS.draft || text.startsWith('/') || /^[A-Za-z]:/.test(text)) return '';
  return text.split('/').some(part => part === '..' || part === '') ? '' : text;
}

// The fields of an item that a caller or a file gives, checked. null when it has no title.
function cleanFields(raw) {
  const r = isObject(raw) ? raw : {};
  const title = oneLine(r.title, LIMITS.title);
  if (!title) return null;
  const options = cleanOptions(r.options);
  const said = oneLine(r.recommend, LIMITS.recommend);
  const from = isObject(r.from) ? r.from : typeof r.from === 'string' ? { ref: r.from } : {};
  const type = TYPES.includes(r.type) ? r.type : 'question';
  const draft = cleanDraft(r.draft);
  const fields = {
    business: typeof r.business === 'string' && BUSINESS_ID.test(r.business) ? r.business : '',
    project: oneLine(r.project, LIMITS.ref),
    thread: oneLine(r.thread, LIMITS.ref),
    from: { ref: oneLine(from.ref, LIMITS.ref), label: oneLine(from.label, LIMITS.label) },
    routine: oneLine(r.routine, LIMITS.ref),
    type,
    title,
    options,
    refuse: REFUSE,
    // A recommendation that is one of the options is written as the option is.
    recommend: options.find(o => fold(o) === fold(said)) ?? said,
    draft,
  };
  // The model named a draft of a step outside that could not be resolved inside the business folder: the item stays, and only the refusal
  // can be chosen (the hook says so in one notice).
  if (r.draftLost === true && !draft && (OUTSIDE_TYPES.includes(type) || looksLikeMoney(fields))) fields.draftLost = true;
  return fields;
}

// A stored item from a file, checked. An "answered" item with no readable answer waits again: silence is never a yes.
function cleanItem(raw) {
  const fields = cleanFields(raw);
  if (!fields || !posInt(raw.n)) return null;
  const a = isObject(raw.answer) ? raw.answer : null;
  const choice = a ? oneLine(a.choice, LIMITS.option) : '';
  let state = STATES.includes(raw.state) ? raw.state : 'waiting';
  if (state === 'answered' && !choice) state = 'waiting';
  const item = {
    n: raw.n,
    ...fields,
    state,
    answer: state === 'answered' ? { choice, note: oneLine(a.note, LIMITS.note), at: time(a.at), sha256: typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256) ? a.sha256 : '' } : null,
    delivered: state !== 'waiting' && raw.delivered === true,
    createdAt: time(raw.createdAt),
  };
  // recorded: the line of this answer is on the business's record. False only between the answer and that line (a crash in between is
  // made good at the next start); a file from before this field counts as recorded.
  if (state === 'answered') item.recorded = raw.recorded !== false;
  if (state === 'withdrawn') item.withdrawnAt = time(raw.withdrawnAt);
  return item;
}

// A v1 record from anything: an older file (a bare list, items with fields missing), a damaged one, or a newer one. It never throws. An
// item that does not check out is dropped, a number is used once, and a file from a newer version keeps its version and its unknown
// fields (this build reads it and never writes it).
export function migrate(raw) {
  const r = isObject(raw) ? raw : Array.isArray(raw) ? { items: raw } : {};
  const newer = Number.isInteger(r.v) && r.v > VERSION;
  const items = [];
  const seen = new Set();
  for (const entry of Array.isArray(r.items) ? r.items : []) {
    if (!isObject(entry)) continue;
    const item = cleanItem(entry);
    if (!item || seen.has(item.n)) continue;
    seen.add(item.n);
    items.push(newer ? { ...entry, ...item } : item);
  }
  items.sort((a, b) => a.n - b.n);
  const n = Math.max(posInt(r.n) ? r.n : 0, ...items.map(i => i.n), 0);
  return newer ? { ...r, v: r.v, n, items } : { v: VERSION, n, items };
}

// ---------- the lines a lead writes ----------

const OWNER_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)?(?:\*\*|__|`)?OWNER\s*:(?:\*\*|__|`)?\s*(.*)$/;
// Lines that may stand between or after the OWNER: lines at the end of a reply: the DONE:, NEXT: and OPEN: lines of a run and a code fence.
const PASS_LINE = /^\s*(?:[-*+]\s+|>\s*)?(?:\*\*|__|`)?(?:DONE|NEXT|OPEN)\s*:|^\s*`{3,}\s*$/;
// How many closing lines of a reply may follow its OWNER: lines.
export const TAIL_LINES = 2;
// How much of the end of a reply is read for its lines.
export const TAIL_CHARS = 20_000;
const NOTHING = /^(?:none|nothing|no|n\/a|-+|\u2014|\u2013)\.?$/i;
const KEYED = /^(recommend(?:ed|ation)?|options?|draft)\s*:\s*(.*)$/i;
const typeWord = text => fold(text).replace(/^[<`*_\[(]+|[>`*_\])]+:?$|:$/g, '');
const unwrap = text => text.replace(/^[`"'<*_]+|[`"'>*_]+$/g, '').trim();

// The OWNER: lines at the end of a reply, in the order written. Returns { lines: [{ type, title, recommend, options, draft }] (five at
// most), more (how many further lines were left out), untitled (how many had no title) }. draft is the path as written (the hook
// resolves it); options is the list as written, [] for none. A line in the middle of a reply is not read: only the trailing lines are.
export function parseOwnerLines(text) {
  // Only the end of a reply can hold the lines, so only the end is taken apart (a reply can be megabytes long). The first row of a cut
  // may be half a line and is left out.
  const all = String(text ?? '');
  const end = all.length > TAIL_CHARS ? all.slice(-TAIL_CHARS) : all;
  const rows = end.replace(/\r/g, '').split('\n');
  if (end.length < all.length) rows.shift();
  const found = [];
  let after = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row.trim()) continue;
    const m = OWNER_LINE.exec(row);
    if (m) {
      found.unshift(m[1]);
      continue;
    }
    if (PASS_LINE.test(row)) continue;
    // A model may close with a sentence or two after its lines ("I will go on with the rest."); more than that, or any other line
    // above the first OWNER: line found, ends the reading.
    if (found.length || (after += 1) > TAIL_LINES) break;
  }
  const out = { lines: [], more: 0, untitled: 0 };
  for (const raw of found) {
    const body = raw.replace(/(?:\*\*|__|`)+\s*$/, '').trim();
    if (!body || NOTHING.test(body)) continue;
    const free = [];
    const keyed = { recommend: '', options: '', draft: '' };
    for (const seg of body.split('|').map(s => s.trim()).filter(Boolean)) {
      const k = KEYED.exec(seg);
      if (!k) {
        free.push(seg);
        continue;
      }
      const key = k[1].toLowerCase();
      const name = key.startsWith('recommend') ? 'recommend' : key.startsWith('option') ? 'options' : 'draft';
      if (!keyed[name]) keyed[name] = k[2].trim();
    }
    const first = free.length ? typeWord(free[0]) : '';
    const typed = TYPES.includes(first);
    const type = typed ? first : 'question';
    const title = oneLine((typed ? free.slice(1) : free).join(' | '), LIMITS.title);
    if (!title) {
      out.untitled += 1;
      continue;
    }
    if (out.lines.length >= LIMITS.perTurn) {
      out.more += 1;
      continue;
    }
    const options = keyed.options ? keyed.options.split(/\s+\/\s+/).map(o => oneLine(unwrap(o), LIMITS.option)).filter(Boolean) : [];
    out.lines.push({ type, title, recommend: oneLine(unwrap(keyed.recommend), LIMITS.recommend), options, draft: oneLine(unwrap(keyed.draft), 1000) });
  }
  return out;
}

// ---------- what the lead is told ----------

const stop = text => (/[.!?]$/.test(text) ? text : `${text}.`);
// Words and signs of money in an item's own text (English only, and an EXTRA: the guard is the sentence NO_PAY_SEND, which every answer
// block carries whatever the language). The type is the model's word, so an item that talks of paying is treated as a spend whatever
// type it carries (the owner pays himself; the answer goes on the record).
const MONEY = /(?:^|[^\p{L}\p{N}])(?:pay|pays|paid|paying|payment|purchase|purchases|buy|buys|bought|subscribe|subscription|spend|spends|spent|spending|invoice|invoices|refund|refunds|wire|wires|transfer|deposit|usd|eur|gbp|dollars?|euros?|charge|charges|charged|renew|renews|renewal|settle|donate|donation|top[- ]?up)(?![\p{L}])|[$€£¥₹₩₽₪₺฿]/iu;
export const looksLikeMoney = item => MONEY.test([item?.title, item?.recommend, ...(Array.isArray(item?.options) ? item.options : [])].filter(t => typeof t === 'string').join(' | '));
// A step outside the PC or one that cannot be taken back: one of the five types, a draft (something to send or publish), or money.
export const isOutside = item => OUTSIDE_TYPES.includes(item?.type) || Boolean(item?.draft) || looksLikeMoney(item);

// One line of the answer block. The title is quoted with its own double quotes turned into single ones, so a title cannot close the
// quotes and write an answer of its own after them; the choice is quoted too, because it is the model's wording of an option.
const quoted = text => String(text).replace(/"/g, "'");
function answerLine(item) {
  // A withdrawn item is not an answer of the owner's: only the number, the type and a short title tell the lead which one it was.
  if (item.state === 'withdrawn') return `#${item.n} ${item.type} "${quoted(oneLine(item.title, 40).trimEnd())}": ${NOT_NEEDED}`;
  const head = `#${item.n} ${item.type} "${quoted(item.title)}":`;
  const choice = oneLine(item.answer?.choice ?? '', LIMITS.option);
  const parts = [`chose "${quoted(choice)}".`];
  // Money never moves by a model: whatever a spend was answered with, short of a no, the owner pays himself.
  if ((item.type === 'spend' || looksLikeMoney(item)) && !isRefusal(item, choice)) parts.push(PAYS_HIMSELF);
  const note = oneLine(item.answer?.note ?? '', LIMITS.note);
  if (note) parts.push(`Note: ${stop(note)}`);
  return `${head} ${parts.join(' ')}`;
}

// The block the next message of the asking thread carries (section 4.3), or '' with nothing to tell.
export function answersBlock(items) {
  const rows = (Array.isArray(items) ? items : []).filter(i => i && (i.state === 'withdrawn' || (i.state === 'answered' && i.answer?.choice)));
  return rows.length ? [ANSWERS_HEAD, NO_PAY_SEND, ...rows.map(answerLine)].join('\n') : '';
}

// ---------- the draft of an item ----------

const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '' && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
};

// Where a draft path leads. { ok: true, rel (from the folder, forward slashes), real } when it is a file inside the folder that Plenum may
// read; else { ok: false, why: 'outside' | 'missing' | 'refused' }. Links are followed before the folder is compared, and the guard
// (lib/guard.mjs checkAccess, secret file names) has its say, so a draft can never name a sign-in folder or a key file.
export async function resolveDraft(root, rel, { check = checkAccess } = {}) {
  if (typeof root !== 'string' || !root || typeof rel !== 'string' || !rel.trim() || rel.includes('\u0000') || rel.length > 1000) return { ok: false, why: 'outside' };
  const base = path.resolve(root);
  const target = path.resolve(base, rel.trim());
  if (!inside(base, target)) return { ok: false, why: 'outside' };
  let realBase;
  let real;
  try {
    realBase = await fsp.realpath(base);
    real = await fsp.realpath(target);
  } catch {
    return { ok: false, why: 'missing' };
  }
  if (!inside(realBase, real)) return { ok: false, why: 'outside' };
  // A link anywhere on the way (a symbolic link or a junction) or a second name of a file (a hard link) is refused: the file the owner is
  // shown must be the file that is in the folder, not one that only looks as if it were.
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!same(real, path.resolve(realBase, path.relative(base, target)))) return { ok: false, why: 'refused' };
  try {
    const st = await fsp.stat(real);
    if (!st.isFile()) return { ok: false, why: 'missing' };
    if (st.nlink > 1) return { ok: false, why: 'refused' };
    check(real);
  } catch {
    return { ok: false, why: 'refused' };
  }
  if (isSecretFileName(real)) return { ok: false, why: 'refused' };
  const kept = cleanDraft(path.relative(realBase, real));
  return kept ? { ok: true, rel: kept, real } : { ok: false, why: 'outside' };
}

// The first of the folders in which the draft resolves, or the last refusal.
async function draftIn(roots, rel) {
  let last = { ok: false, why: 'missing' };
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    const got = await resolveDraft(root, rel);
    if (got.ok) return got;
    if (got.why !== 'missing' || last.why === 'missing') last = got;
  }
  return last;
}

// The draft, OPENED (the check-then-open gap, closed as lib/business.mjs openPlain closes it): the path is resolved and checked, the file
// is opened, and every check that matters is then made again on the open handle (its own stat: a plain file with one name) and on the
// path as it resolves AFTER the open, which must still name the very file the handle holds (same volume and file number, no link). So a
// file or link put in the draft's place between the check and the read is either seen here or is not what gets read: callers read from
// the handle, never from the path again.
//   { ok: true, rel, real, handle, size } (the caller closes the handle) | { ok: false, why: 'outside' | 'missing' | 'refused' }
// deps.afterOpen is for a test only: it runs between the open and the checks.
export async function openDraft(roots, rel, deps = {}) {
  const got = await draftIn(roots, rel);
  if (!got.ok) return got;
  let handle;
  try {
    handle = await fsp.open(got.real, 'r');
  } catch (err) {
    return { ok: false, why: err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'missing' : 'refused' };
  }
  const refuse = async why => {
    await handle.close().catch(() => {});
    return { ok: false, why };
  };
  try {
    if (typeof deps.afterOpen === 'function') await deps.afterOpen();
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || held.nlink > 1n) return refuse('refused');
    const now = await fsp.lstat(got.real, { bigint: true });
    if (now.isSymbolicLink() || now.ino !== held.ino || now.dev !== held.dev) return refuse('refused');
    // The whole path once more: no link was put anywhere on the way while the file was being opened.
    const again = await draftIn(roots, rel);
    if (!again.ok) return refuse(again.why === 'missing' ? 'refused' : again.why);
    const same = process.platform === 'win32' ? again.real.toLowerCase() === got.real.toLowerCase() : again.real === got.real;
    if (!same) return refuse('refused');
    return { ok: true, rel: got.rel, real: got.real, handle, size: Number(held.size) };
  } catch {
    return refuse('refused');
  }
}

export const DRAFT_GONE = 'That draft is no longer there.';
export const DRAFT_REFUSED = 'Plenum does not open that file as a draft.';
export const DRAFT_NOT_TEXT = 'That draft is not a text file.';

// The draft as text for the page: { name, text, cut, sha256 }. At most `max` characters; cut says there is more. An Error with status 404 when
// the file is gone, 403 when the path leaves the folder or the guard refuses it, 415 when it is not text.
export async function readDraft(roots, rel, max = LIMITS.draftChars) {
  const got = await openDraft(roots, rel);
  if (!got.ok) throw got.why === 'missing' ? bad(DRAFT_GONE, 404) : bad(DRAFT_REFUSED, 403);
  const handle = got.handle;
  try {
    const size = got.size;
    // (the hash below is of the very bytes read here, so it is the hash of the text the page shows)
    // A character is at most four bytes, so this many bytes always hold `max` characters when the file has them.
    const want = Math.min(size, max * 4 + 4);
    const buf = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const { bytesRead } = await handle.read(buf, read, want - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    let text = new StringDecoder('utf8').write(buf.subarray(0, read));
    if (text.includes('\u0000')) throw bad(DRAFT_NOT_TEXT, 415);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let cut = read < size;
    if (text.length > max) {
      text = text.slice(0, max);
      if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
      cut = true;
    }
    // sha256: of the whole file, taken from the bytes read, so what the owner saw and what the hash names cannot differ. '' when the file
    // is larger than what was read (the text is cut then, and a yes is never recorded for it).
    const sha256 = read === size ? createHash('sha256').update(buf.subarray(0, read)).digest('hex') : '';
    return { name: got.rel, text, cut, sha256 };
  } catch (err) {
    if (err?.status) throw err;
    throw bad(DRAFT_GONE, 404);
  } finally {
    await handle?.close().catch(() => {});
  }
}

// The sha256 of the draft file as it is now, in hex; '' when there is none, it cannot be read, or it is larger than 64 MB.
export async function hashDraft(roots, rel) {
  if (!rel) return '';
  const got = await openDraft(roots, rel);
  if (!got.ok) return '';
  try {
    if (got.size > LIMITS.hashBytes) return '';
    // Read from the opened handle (never from the path again), to the end of the file as it is while it is read.
    const hash = createHash('sha256');
    const buf = Buffer.alloc(1 << 16);
    for (let at = 0; ;) {
      const { bytesRead } = await got.handle.read(buf, 0, buf.length, at);
      if (!bytesRead) break;
      hash.update(buf.subarray(0, bytesRead));
      at += bytesRead;
      if (at > LIMITS.hashBytes) return '';
    }
    return hash.digest('hex');
  } catch {
    return '';
  } finally {
    await got.handle.close().catch(() => {});
  }
}

// ---------- the instance ----------

// Whether a thread of a project is still open, from Plenum's own state. When that cannot be told the thread counts as open, so an answer
// goes only to the thread that asked.
function threadOpenInState(projectId, threadId) {
  try {
    const st = store.get();
    const project = st?.projects?.find(p => p.id === projectId);
    if (!project) return true;
    if (threadId === projectId) return true;
    const entry = findThread(threadsOf(st, project), threadId);
    return Boolean(entry) && isOpen(entry);
  } catch {
    return true;
  }
}

export function createDecisions(deps = {}) {
  const d = {
    dir: deps.dir ?? store.HOME,
    now: deps.now ?? (() => Date.now()),
    write: deps.write ?? writeFileAtomic,
    publish: deps.publish ?? publish,
    threadOpen: deps.threadOpen ?? threadOpenInState,
    read: deps.read ?? (p => fs.readFileSync(p, 'utf8')),
    size: deps.size ?? (p => fs.statSync(p).size),
    business: deps.business ?? null,
    sleep: deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms))),
  };
  const file = path.join(d.dir, 'decisions.json');

  let rec = null; // the record in force
  let damaged = false; // the file could not be read as a list: an empty list is in force and the first save keeps a copy of the file
  let newer = false; // the file is from a newer version: read, never written
  let unreadable = false; // the file is there but could not be read (locked, no access): nothing is in force and nothing may be written
  let queue = Promise.resolve();

  // final: this is the last try. A read that gives no text is not a damaged file (a lock or a scanner can give an empty read of a file that
  // has its list): it is tried again like a read error, and is taken as damaged only on the last try and only when the file is 0 bytes.
  function load(final = false) {
    if (rec) return rec;
    let text;
    try {
      text = d.read(file);
      unreadable = false;
    } catch (err) {
      const fresh = migrate(null);
      // No file: an empty list, and nothing is written. A file that is there but cannot be read now (a locked file: OneDrive, a virus
      // scanner) is NOT an empty list: it is not put in force, and every change refuses until it can be read (see ready).
      if (err?.code === 'ENOENT') {
        unreadable = false;
        rec = fresh;
      } else unreadable = true;
      return fresh;
    }
    if (typeof text !== 'string' || !text.trim()) {
      let size = -1;
      if (final) {
        try {
          size = d.size(file);
        } catch {
          // The file cannot be measured: it is not known to be empty.
        }
      }
      if (size !== 0) {
        unreadable = true;
        return migrate(null);
      }
    }
    let raw = null;
    try {
      raw = JSON.parse(text);
    } catch {
      // Damaged: handled below.
    }
    damaged = !isObject(raw) && !Array.isArray(raw);
    rec = migrate(raw);
    newer = !damaged && rec.v > VERSION;
    return rec;
  }

  const copy = item => ({ ...item, from: { ...item.from }, options: [...item.options], answer: item.answer ? { ...item.answer } : null });
  const closedAt = item => (item.state === 'answered' ? item.answer?.at ?? 0 : item.state === 'withdrawn' ? item.withdrawnAt ?? 0 : 0);

  // The items a save keeps: everything that waits, and what was answered or withdrawn in the last 30 days (the business's record keeps
  // the rest). Past 2,000 items the oldest closed ones go first.
  // What a closed item still owes: a lead that has not been told of it (it has a thread and a project to be told in), or a line on the
  // business's record that is not written yet. Such an item is kept whatever its age: a yes the lead never heard would be asked again.
  const owed = i => i.state !== 'waiting' && ((!i.delivered && Boolean(i.thread) && Boolean(i.project)) || (i.state === 'answered' && i.recorded === false));
  function kept(items) {
    const cutoff = d.now() - LIMITS.keepMs;
    let out = items.filter(i => i.state === 'waiting' || closedAt(i) >= cutoff || owed(i));
    if (out.length > LIMITS.items) {
      // Past the cap the oldest closed items go first, and the ones that are still owed go last.
      const closed = out.filter(i => i.state !== 'waiting').sort((a, b) => Number(owed(a)) - Number(owed(b)) || a.n - b.n);
      const drop = new Set(closed.slice(0, out.length - LIMITS.items).map(i => i.n));
      out = out.filter(i => !drop.has(i.n));
    }
    return out;
  }

  const count = (items, business) => items.filter(i => i.state === 'waiting' && (business === undefined || i.business === business)).length;

  // Writes `next` and only then puts it in force, so a failed write changes nothing. The page hears of every change.
  async function commit(next) {
    // The last guard against writing an empty list over a file that was not read: nothing is in force, so nothing is saved.
    if (!rec) throw bad(UNREADABLE_TEXT, 503);
    await fsp.mkdir(d.dir, { recursive: true });
    if (damaged) {
      // The file that could not be read is kept beside the new one, once, so nothing is lost.
      // The first copy has the contract's name; a later one gets the time in its name (as routines.json.damaged-<ms> does), so an earlier
      // copy is never written over.
      const first = path.join(d.dir, 'decisions.damaged.json');
      const taken = await fsp.access(first).then(() => true, () => false);
      await fsp.copyFile(file, taken ? path.join(d.dir, `decisions.damaged-${d.now()}.json`) : first, fs.constants.COPYFILE_EXCL).catch(() => {});
    }
    next.items = kept(next.items);
    await d.write(file, `${JSON.stringify(next, null, 1)}\n`);
    rec = next;
    damaged = false;
    try {
      d.publish({ type: 'decisions', waiting: count(rec.items) });
    } catch {
      // A window that cannot be told asks again when it opens.
    }
  }

  // One change at a time; a change that failed does not hold up the next one.
  function change(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  const draftOf = () => ({ v: VERSION, n: load().n, items: load().items.map(copy) });

  // The file is read before a change builds on it. A file that cannot be read is tried again a few times (a lock is usually brief); if it
  // still cannot be read the change is refused with 503 and nothing is written: the list on the disk is never replaced by an empty one.
  const RETRIES = 4;
  const RETRY_MS = 50;
  async function ready() {
    for (let i = 0; i < RETRIES; i += 1) {
      load(i + 1 === RETRIES);
      if (rec) return;
      if (i + 1 < RETRIES) await d.sleep(RETRY_MS);
    }
    throw bad(UNREADABLE_TEXT, 503);
  }

  function add(input) {
    return change(async () => {
      const fields = cleanFields(input);
      if (!fields) return { added: false, why: 'title' };
      if (!fields.business) return { added: false, why: 'business' };
      try {
        await ready();
      } catch (err) {
        if (err?.status === 503) return { added: false, why: 'unreadable' };
        throw err;
      }
      const cur = load();
      if (newer) return { added: false, why: 'newer' };
      const twin = cur.items.find(i => i.state === 'waiting' && i.business === fields.business && fold(i.title) === fold(fields.title));
      if (twin) {
        // The same title waits already. When that item can only be refused for want of a draft and this line brings one that was found in
        // the folder, the draft goes on the item that waits (the owner still has to open and read it before a yes): nothing is added.
        if (onlyRefusal(twin) && fields.draft && !fields.draftLost) {
          const next = draftOf();
          const item = next.items.find(i => i.n === twin.n);
          item.draft = fields.draft;
          delete item.draftLost;
          await commit(next);
          return { added: false, why: 'double', mended: true, item: copy(item) };
        }
        return { added: false, why: 'double', item: copy(twin) };
      }
      if (count(cur.items, fields.business) >= LIMITS.waitingPerBusiness) return { added: false, why: 'full' };
      const next = draftOf();
      next.n += 1;
      const item = { n: next.n, ...fields, state: 'waiting', answer: null, delivered: false, createdAt: d.now() };
      next.items.push(item);
      await commit(next);
      retryOwed();
      return { added: true, item: copy(item) };
    });
  }

  function list({ state, business, project, limit } = {}) {
    let items = load().items.filter(i => (!state || i.state === state) && (!business || i.business === business) && (!project || i.project === project));
    items = items.sort((a, b) => b.n - a.n);
    if (posInt(limit)) items = items.slice(0, limit);
    return items.map(copy);
  }

  // The item a change is about, checked: it exists (404) and still waits (409), and the file may be written.
  function waitingItem(next, n) {
    if (newer) throw bad(NEWER_TEXT, 409);
    const item = next.items.find(i => i.n === n);
    if (!item) throw bad(NO_ITEM, 404);
    if (item.state !== 'waiting') throw bad(NOT_WAITING, 409);
    return item;
  }

  // extra.sha256: the hash of the draft the owner was shown (answerItem has checked it); it is saved in the same write as the answer, with
  // recorded: false, so a crash before the line reaches the business's record leaves what is needed to write it at the next start.
  function answer(n, choice, note = '', extra = {}) {
    return change(async () => {
      await ready();
      const next = draftOf();
      const item = waitingItem(next, n);
      const said = typeof choice === 'string' ? fold(choice) : '';
      const picked = item.options.find(o => fold(o) === said);
      if (!picked) throw bad(`Pick one of this item's options: ${item.options.join(', ')}.`);
      // The draft of this step was never found: only the server's refusal can be chosen.
      if (item.draftLost && !isRefusal(item, picked)) throw bad(DRAFT_LOST, 409);
      // A send or a publish with no draft at all: there is nothing he could have read, so only the refusal answers it.
      if (needsDraft(item) && !isRefusal(item, picked)) throw bad(NO_DRAFT, 409);
      if (note !== undefined && note !== null && typeof note !== 'string') throw bad('The note is text.');
      const words = oneLine(note ?? '', LIMITS.note + 1);
      if (words.length > LIMITS.note) throw bad(`Keep the note to ${LIMITS.note} characters.`);
      item.state = 'answered';
      const hash = typeof extra?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(extra.sha256) ? extra.sha256 : '';
      item.answer = { choice: picked, note: words, at: d.now(), sha256: hash };
      item.recorded = false;
      item.delivered = false;
      await commit(next);
      return copy(item);
    });
  }

  // The line of these answers is on the business's record: they are not owed to it any more. Never throws for an unreadable file (the
  // line is then written again at the next start, which skips a line that is there).
  function markRecorded(ns) {
    return change(async () => {
      const wanted = new Set((Array.isArray(ns) ? ns : [ns]).filter(posInt));
      if (!wanted.size || newer) return 0;
      try {
        await ready();
      } catch {
        return 0;
      }
      const next = draftOf();
      const hit = next.items.filter(i => wanted.has(i.n) && i.state === 'answered' && i.recorded === false);
      if (!hit.length) return 0;
      for (const item of hit) item.recorded = true;
      await commit(next);
      return hit.length;
    });
  }

  function withdraw(n) {
    return change(async () => {
      await ready();
      const next = draftOf();
      const item = waitingItem(next, n);
      item.state = 'withdrawn';
      item.withdrawnAt = d.now();
      item.delivered = false;
      await commit(next);
      retryOwed();
      return copy(item);
    });
  }

  const waiting = business => count(load().items, typeof business === 'string' && business ? business : undefined);

  // business: the business the lead works for. An item goes only to a lead of the business that asked it (a folder can change hands from
  // one business to another); the owner's page and the tests may leave it out to see every item of the project.
  function pendingFor(project, thread, business) {
    const cur = load();
    // A file this build may not write cannot be marked, so nothing is handed out from it.
    if (newer || typeof project !== 'string' || !project) return [];
    const mine = typeof business === 'string' && business ? business : null;
    return cur.items
      .filter(i => i.state !== 'waiting' && !i.delivered && i.thread && i.project === project && (!mine || i.business === mine) && (i.thread === thread || !d.threadOpen(project, i.thread)))
      .sort((a, b) => b.n - a.n)
      .map(copy);
  }

  function markDelivered(ns) {
    return change(async () => {
      const wanted = new Set((Array.isArray(ns) ? ns : [ns]).filter(posInt));
      if (!wanted.size || newer) return 0;
      // A list that cannot be read now is not marked: the answers go to the lead again (twice told is safe; never told is not).
      try {
        await ready();
      } catch {
        return 0;
      }
      const next = draftOf();
      const hit = next.items.filter(i => wanted.has(i.n) && i.state !== 'waiting' && !i.delivered);
      if (!hit.length) return 0;
      for (const item of hit) item.delivered = true;
      await commit(next);
      retryOwed();
      return hit.length;
    });
  }

  function hints() {
    load(true);
    return [...(newer ? [NEWER_TEXT] : []), ...(damaged ? [DAMAGED_TEXT] : []), ...(unreadable && !rec ? [UNREADABLE_HINT] : [])];
  }

  const api = { add, list, answer, withdraw, waiting, pendingFor, markDelivered, markRecorded, migrate, hints, file };

  // A line that could not be written (the business module was not there, the record was locked) is tried again with the next change of
  // the list, which is every turn (markDelivered), so it never waits for the next start. No timer: one try at a time, started by a change.
  // Only an instance that was given its business (the default one) does this.
  let retrying = false;
  function retryOwed() {
    if (retrying || newer || !d.business || !rec?.items.some(i => i.state === 'answered' && i.recorded === false)) return;
    retrying = true;
    Promise.resolve()
      .then(() => recoverRecords({ decisions: api, business: d.business }))
      .catch(() => {})
      .then(() => {
        retrying = false;
      });
  }

  return api;
}

// ---------- the neighbours ----------

// A neighbour package, loaded on first use and kept. A module that is missing or does not load answers null, and is looked for again
// after a minute (another package may be installed by an update while Plenum runs).
function lazy(rel) {
  let got = null;
  let at = 0;
  return () => {
    if (!got || (got.failed && Date.now() - at > 60_000)) {
      at = Date.now();
      const mine = { failed: false, promise: null };
      mine.promise = import(moduleUrl(rel, CODE_ROOT)).then(m => m, () => {
        mine.failed = true;
        return null;
      });
      got = mine;
    }
    return got.promise;
  };
}
export const neighbours = Object.freeze({ business: lazy('lib/business.mjs'), routines: lazy('lib/routines.mjs') });

// ---------- the default instance ----------

// Made on first use, never on the start path: it reads the file once and starts no timer. On first use the answers that were saved but
// whose line never reached the business's record (a crash between the two) are written now, in the background.
let instance = null;
const decisions = () => {
  if (!instance) {
    instance = createDecisions({ business: neighbours.business });
    Promise.resolve().then(() => recoverRecords()).catch(() => {});
  }
  return instance;
};

export const add = item => decisions().add(item);
export const list = q => decisions().list(q);
export const answer = (n, choice, note, extra) => decisions().answer(n, choice, note, extra);
export const withdraw = n => decisions().withdraw(n);
export const waiting = business => decisions().waiting(business);
export const pendingFor = (project, thread, business) => decisions().pendingFor(project, thread, business);
export const markDelivered = ns => decisions().markDelivered(ns);
export const markRecorded = ns => decisions().markRecorded(ns);
export const hints = () => decisions().hints();
const DEFAULT_API = Object.freeze({ add, list, answer, withdraw, waiting, pendingFor, markDelivered, markRecorded, hints });

// ---------- the answer, and its line on the record ----------

// The line an answered item puts on its business's record. An outside step (one of the five types, a draft, or money in the item's own
// words, whatever type the model gave it) is { type: 'outside' ... } with the hash of the draft the owner was shown; every other answer
// is { type: 'decision', n, action, title, choice, by, note? } (lib/business.mjs lineOf must know that type; until it does, such a line
// is not written and nothing fails). `at` is the moment of his tap, so a line and the item in decisions.json can be set side by side.
export function recordEntry(item) {
  const a = item.answer ?? {};
  // refused: the answer was the refusal the program adds. The record carries it as a fact, so nobody reads it from an option's words.
  const note = { ...(isRefusal(item, a.choice) ? { refused: true } : {}), ...(a.note ? { note: a.note } : {}) };
  if (isOutside(item)) {
    const action = OUTSIDE_TYPES.includes(item.type) ? item.type : looksLikeMoney(item) ? 'spend' : item.type;
    return { type: 'outside', at: a.at, n: item.n, action, title: item.title, draft: item.draft, sha256: a.sha256 ?? '', choice: a.choice, by: 'owner', ...note };
  }
  return { type: 'decision', at: a.at, n: item.n, action: item.type, title: item.title, choice: a.choice, by: 'owner', ...note };
}

// Numbers being recorded by answerItem right now: the start-up recovery leaves them alone.
const recording = new Set();

// Whether the business's record already has this answer's line, looked for by its key (n, type, at). The record is read newest first from
// the answer's own moment on, a page at a time, so however many newer lines exist the line is found (a line is never written twice).
async function lineThere(mod, item, entry) {
  if (typeof mod.log !== 'function') return false;
  const key = l => l?.n === item.n && l?.type === entry.type && l?.at === entry.at;
  let before = entry.at > 0 ? entry.at + 1 : undefined;
  for (let page = 0; page < 100; page += 1) {
    const lines = await mod.log(item.business, before === undefined ? { limit: 200 } : { limit: 200, before }).catch(() => []);
    if (!Array.isArray(lines) || !lines.length) return false;
    if (lines.some(key)) return true;
    const oldest = Math.min(...lines.map(l => Number(l?.at) || 0));
    // The record is newest first: once a page reaches back to the answer's moment, or the record has no more, the line is not there.
    if (lines.length < 200 || oldest < entry.at || (before !== undefined && !(oldest < before))) return false;
    before = oldest;
  }
  return false;
}

// Writes the line of one answered item to the business's record unless that record already has it (a crash may have come after the
// line and before the mark). Answers 'written', 'there' (it was already there), 'none' (this build's record has no line of that type,
// or no such business: nothing to write) or 'failed' with why. Marks the item as recorded for everything but 'failed'.
async function recordLine(item, api, business) {
  const entry = recordEntry(item);
  try {
    const mod = await business();
    if (typeof mod?.record !== 'function') throw new Error('The business record is not part of this build.');
    if (await lineThere(mod, item, entry)) {
      await api.markRecorded?.([item.n]);
      return { record: 'there', why: '' };
    }
    // lib/business.mjs answers null when it has no business with that id or no line of that type: nothing was written then.
    if ((await mod.record(item.business, entry)) === null) {
      if (entry.type === 'outside') throw new Error('Plenum has no record for the business of this item.');
      await api.markRecorded?.([item.n]);
      return { record: 'none', why: '' };
    }
    await api.markRecorded?.([item.n]);
    return { record: 'written', why: '' };
  } catch (err) {
    return { record: 'failed', why: `Your answer is saved. The line on the business's record could not be written: ${oneLine(String(err?.message ?? err), 200)}` };
  }
}

// At the first use of the list: every answered item whose line is not on the record yet is written now. Idempotent (a line that is there
// is not written twice). Answers how many lines were written.
export async function recoverRecords({ decisions: api = DEFAULT_API, business = neighbours.business } = {}) {
  let done = 0;
  for (const item of api.list({ state: 'answered' }).filter(i => i.recorded === false && !recording.has(i.n))) {
    if ((await recordLine(item, api, business)).record === 'written') done += 1;
  }
  return done;
}

// The draft as the owner sees it now, for the check of his yes: { ok: true, sha256, cut } or { ok: false, why, status }.
async function draftNow(roots, rel) {
  try {
    const got = await readDraft(roots, rel);
    return { ok: true, sha256: got.sha256, cut: got.cut };
  } catch (err) {
    return { ok: false, why: err?.status === 404 ? DRAFT_GONE_YES : DRAFT_REFUSED, status: 409 };
  }
}

// What POST /api/decisions/answer does, in one place (a test runs it on fakes).
//  1. A yes to a step outside (see isOutside) that has a draft is tied to what the owner was shown: `seen` is the sha256 that
//     GET /api/decisions/draft gave him. If it is missing or is not the hash of the file as it is now, the answer is refused with 409
//     ("The draft changed after you opened it") and nothing is saved. A draft too long to be shown in full, or gone, refuses a yes as well.
//     A no needs no `seen`.
//  2. The answer is saved WITH the hash (the one that was checked) and recorded: false, in one atomic write, before anything else happens.
//  3. Then the line goes on the business's record, and the item is marked recorded. A crash between 2 and 3 leaves the item recorded:
//     false, and the line is written at the next start (recoverRecords).
//  4. Then routines are told, so the lead that asked acts on the answer with one follow-up run (and a routine's own question, which has no
//     thread, is settled there); nobody waits for that.
//   deps: decisions (an instance), business and routines (functions that answer a promise of the module, or null), roots (the folders
//         the draft may be in: the asking thread's folder first, then the project's).
// Answers { item, waiting, record: 'written' | 'none' | 'failed', why (a sentence when the record failed), followUp (routines were told) }.
export async function answerItem({ n, choice, note, seen } = {}, { decisions: api = DEFAULT_API, business = neighbours.business, routines = neighbours.routines, roots = [] } = {}) {
  const before = api.list({}).find(i => i.n === n);
  const said = typeof choice === 'string' ? fold(choice) : '';
  const picked = before?.state === 'waiting' ? before.options.find(o => fold(o) === said) : undefined;
  let sha256 = '';
  if (picked && before.draft && isOutside(before)) {
    if (isRefusal(before, picked)) {
      // A no needs no check; the hash is kept as a note of what the draft was (best effort).
      sha256 = await hashDraft(roots, before.draft);
    } else {
      const now = await draftNow(roots, before.draft);
      if (!now.ok) throw bad(now.why, now.status);
      if (now.cut || !now.sha256) throw bad(DRAFT_TOO_LONG, 409);
      if (typeof seen !== 'string' || !seen) throw bad(DRAFT_UNSEEN, 409);
      if (seen !== now.sha256) throw bad(DRAFT_CHANGED, 409);
      sha256 = now.sha256;
    }
  }
  const item = await api.answer(n, choice, note, { sha256 });
  recording.add(item.n);
  const out = { item, waiting: api.waiting(), record: 'none', why: '', followUp: false };
  try {
    const got = await recordLine(item, api, business);
    out.record = got.record === 'there' ? 'written' : got.record;
    out.why = got.why;
  } finally {
    recording.delete(item.n);
  }
  try {
    const mod = await routines();
    if (typeof mod?.followUp === 'function') {
      out.followUp = true;
      Promise.resolve()
        .then(() => mod.followUp({ business: item.business, project: item.project, thread: item.thread, n: item.n }))
        .catch(() => {});
    }
  } catch {
    // Without routines the answer waits for the lead's next message.
  }
  return out;
}

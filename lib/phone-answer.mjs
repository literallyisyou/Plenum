// Answering what waits from the phone (wave 8, 17 Nov 2026). The list itself, and every rule of an answer, stays lib/decisions.mjs
// (DECISIONS item 125): this module only says HOW an item of that list can be answered on a phone, and lets a simple yes/no item be
// answered from its notification. It adds no way to say yes that the list does not already have.
//
// THE CONTRACT (build/v06/w8-phone-answer pins each part):
//   describe(item) -> null for an item that does not wait, else
//     { mode, taps, unlock, quick, why? }
//       mode   'tap'     its options are buttons: one tap answers it
//              'read'    it has a draft: the first tap opens the draft, the second answers with the hash of the text that was shown
//                        (`seen`, as POST /api/decisions/answer wants it). There is no way round the draft here either.
//              'text'    its answer is a text the owner types (ask: true): it is opened on Today, where the text box is
//              'refuse'  only the server's own No can answer it (a send or a publish with no draft, or a draft that was lost): `why`
//                        is the server's sentence for that
//       taps   how many taps an answer takes on the phone's Today card (1, 2, or 0 when it has to be typed)
//       unlock true when a yes to this item is a step outside (lib/decisions.mjs isOutside: a send, publish, spend, account or delete,
//              any item with a draft, any item that talks of money). The page asks for the phone's unlock before it sends such a yes.
//              The No never needs it.
//       quick  true for a simple yes/no item: no draft, not a step outside, not a text question, not a thing only the owner can do, not
//              the proposal of his instructions, and its two options are the program's own Yes and No (the model named no options of
//              its own). Only a quick item can be answered from a notification.
//   GET /api/decisions puts describe(item) on every waiting item as `phone` (lib/routes/decisions.mjs).
//   tokenFor(item) -> 32 hex characters: an HMAC over the item's number and title with a key made at this start of Plenum and kept in
//     memory only. A notification's Yes and No carry '<n>.<token>' (idFor). A link that somebody else made up (another app on the phone
//     can open plenum://app/#yes=..., a model can write such a link into a reply) has no token that checks out, and a notification from
//     before Plenum was started again does not either: both are told to answer on Today.
//   quickFor(business, { decisions }) -> { id, title, more } | null: the newest item that waits for that business, when it is quick
//     (more: how many others wait for it). lib/remote/index.mjs puts it on the 'needs' push; lib/remote/push.mjs shows the title and
//     the two actions only when the owner has switched on the first line in notifications, only to a phone at Full, and the Yes only to
//     a phone that has Approve from a notification.
//   quickAnswer({ id, answer: 'yes' | 'no', device? }, deps) -> what lib/decisions.mjs answerItem answers, plus said (one sentence). It
//     is what POST /api/phone-answer/quick does. An Error with status 400 (not an id and an answer), 409 and one sentence when the token
//     does not check out, the item no longer waits, or it is no longer a simple yes/no (a draft was added to it): nothing is recorded then.
//     A yes is the item's own first option, a no is the server's refusal (item.refuse): never a word the caller sent.
//     device (review of wave 8) is the phone's id when the request came through the Bridge (x-plenum-device, which only the Bridge sets).
//     A Yes with a device is taken only when deps.yesAllowed(device) answers true (the route asks the Bridge's registry whether that
//     phone has Approve from notifications, now, as the Bridge asks for Approve); anything else, a registry that cannot answer included,
//     is a 409 with TEXT.noYes. The No never needs it. Without this the No's id, which every Full phone with the first line gets, would
//     answer a Yes as well.
// Silence is never a yes: nothing here answers by itself, there is no timer and no default. Nothing here reaches the network, starts a
// program, pairs a phone, or reads a tier, a key or the lock: who may call the route is lib/remote/tiers.mjs (a POST it does not name
// needs Full), and the unlock is the phone's own.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as decisions from './decisions.mjs';

export const MODES = Object.freeze(['tap', 'read', 'text', 'refuse']);
// Said on the phone's Today card, once, when an item on it needs the unlock.
export const UNLOCK_NOTE = 'A yes that lets something leave this PC, or that is about money, asks for this phone\'s unlock first. A No never does.';
export const TEXT = Object.freeze({
  bad: 'Send id, as the notification carried it, and answer: yes or no.',
  stale: 'That notification can no longer answer by itself. Open Today in Plenum and answer there.',
  answered: 'That item no longer waits for an answer.',
  notQuick: 'That item can no longer be answered from a notification. Open Today in Plenum, read it, and answer there.',
  noYes: 'This phone does not have Approve from notifications on, so a Yes from a notification is not taken. Open Today in Plenum and answer there.',
});

const bad = (message, status) => Object.assign(new Error(message), { status });
const fold = text => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export function describe(item) {
  if (!item || typeof item !== 'object' || (item.state ?? 'waiting') !== 'waiting' || !Array.isArray(item.options)) return null;
  const why = decisions.onlyRefusal(item);
  const outside = decisions.isOutside(item);
  const mode = why ? 'refuse' : item.ask === true ? 'text' : item.draft ? 'read' : 'tap';
  const quick = mode === 'tap' && !outside && item.does !== true && item.charter !== true
    && item.options.length === 2 && fold(item.options[0]) === fold(decisions.DEFAULT_OPTIONS[0]) && decisions.isRefusal(item, item.options[1]);
  return {
    mode,
    taps: mode === 'read' ? 2 : mode === 'text' ? 0 : 1,
    unlock: !why && outside,
    quick,
    ...(why ? { why } : {}),
  };
}

// The key of this start of Plenum. It is never written, logged or sent: only tokens made with it leave this module.
const KEY = randomBytes(32);
export const TOKEN_RE = /^[0-9a-f]{32}$/;
export function tokenFor(item, key = KEY) {
  return createHmac('sha256', key).update(`${Number(item?.n) || 0}\n${String(item?.title ?? '')}`).digest('hex').slice(0, 32);
}
// '<n>.<token>': what a notification's Yes and No carry (it fits the ids every phone route takes: letters, digits, dots).
export const idFor = (item, key = KEY) => `${item.n}.${tokenFor(item, key)}`;
export function parseId(id) {
  const m = /^([1-9]\d{0,14})\.([0-9a-f]{32})$/.exec(typeof id === 'string' ? id : '');
  return m ? { n: Number(m[1]), token: m[2] } : null;
}
const sameToken = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function quickFor(business, { decisions: api = decisions, key = KEY } = {}) {
  try {
    if (typeof business !== 'string' || !business) return null;
    const waiting = api.list({ state: 'waiting', business });
    const newest = waiting[0];
    if (!newest || describe(newest)?.quick !== true) return null;
    return { id: idFor(newest, key), title: newest.title, more: waiting.length - 1 };
  } catch {
    return null;
  }
}

export async function quickAnswer({ id, answer, device } = {}, deps = {}) {
  const api = deps.decisions ?? decisions;
  const answerItem = deps.answerItem ?? decisions.answerItem;
  const parsed = parseId(id);
  if (!parsed || (answer !== 'yes' && answer !== 'no')) throw bad(TEXT.bad, 400);
  const item = api.list({}).find(i => i.n === parsed.n);
  // A number that is not on the list and a token that does not check out get the same answer: a caller without the token learns nothing.
  if (!item || !sameToken(tokenFor(item, deps.key ?? KEY), parsed.token)) throw bad(TEXT.stale, 409);
  if (item.state !== 'waiting') throw bad(TEXT.answered, 409);
  if (describe(item)?.quick !== true) throw bad(TEXT.notQuick, 409);
  // A Yes from a phone: only from one that has Approve from notifications, asked now (the push left the Yes out for the others, but the
  // No's id is the same id). A registry that cannot answer counts as no.
  if (answer === 'yes' && typeof device === 'string' && device) {
    let allowed = false;
    try { allowed = typeof deps.yesAllowed === 'function' && (await deps.yesAllowed(device)) === true; } catch { allowed = false; }
    if (!allowed) throw bad(TEXT.noYes, 409);
  }
  // The yes is the item's own first option and the no is the server's refusal: no word of the caller's is an answer.
  const choice = answer === 'yes' ? item.options[0] : item.refuse;
  const out = await answerItem({ n: item.n, choice }, { decisions: api, business: deps.business, routines: deps.routines, setup: deps.setup, roots: [] });
  return { ...out, said: `Answered #${item.n}: ${choice}.` };
}

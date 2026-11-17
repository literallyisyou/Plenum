// "<Business>: 2 things need you" (14 Nov 2026). The last notice that a business left new items on the owner's list. announce() below
// sets it: lib/setup.mjs after a setup step, lib/decisions.mjs after an add (wave 4); server.mjs puts it into the state every window gets (needsYou), and desktop/handlers/needs-you.cjs turns a new
// one into a desktop notification when the window is not in front. It holds a name and a count only: never a title or a model's text.
let last = null;
let seq = 0;

const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// note: { business, name, count, at }. A count below 1 clears the notice.
export function set(note) {
  const count = Number.isInteger(note?.count) && note.count > 0 ? Math.min(note.count, 999) : 0;
  if (!count) {
    last = null;
    return null;
  }
  seq += 1;
  last = { seq, business: oneLine(note.business, 64), name: oneLine(note.name, 60) || 'A business', count, at: Number.isFinite(note.at) ? note.at : Date.now() };
  return last;
}
export const get = () => (last ? { ...last } : null);
// The one sentence of the notice.
export const sentence = note => (note ? `${note.name}: ${note.count === 1 ? '1 thing needs you' : `${note.count} things need you`}` : '');

// announce({ business, name, count, at }, publish, { publishState, set }) (wave 4, 16 Nov 2026): the one way new items on the owner's list
// are told. lib/setup.mjs calls it after a setup step, lib/decisions.mjs after an add that raised a business's waiting count. It sets the
// notice (set), asks for the state every window gets (publishState('needs'): the desktop's notification) and publishes
// { type: 'needs-you', business, name, count } (the phone's push). A name and a count only, as before. The same business with the same
// count told by the same setter in the last minute is not told again: an add tells it, and the setup step that made the add would tell
// the same count a moment later. Answers the notice, or null when nothing was told. Never throws.
const TOLD_MS = 60_000;
const told = new WeakMap(); // setter -> Map(business -> { count, at })
export function announce(note, publish, { publishState = null, set: setter = set } = {}) {
  const count = Number.isInteger(note?.count) && note.count > 0 ? Math.min(note.count, 999) : 0;
  if (!count) return null;
  const business = oneLine(note?.business, 64);
  const name = oneLine(note?.name, 60);
  const at = Number.isFinite(note?.at) ? note.at : Date.now();
  let seen = null;
  try {
    if (!told.has(setter)) told.set(setter, new Map());
    seen = told.get(setter);
  } catch { /* a setter that cannot be a key is told every time */ }
  const before = seen?.get(business);
  if (before && before.count === count && Math.abs(at - before.at) < TOLD_MS) return null;
  seen?.set(business, { count, at });
  let out = null;
  try { out = setter({ business, name, count, at }) ?? null; } catch { /* the pane still shows them */ }
  try { publishState?.('needs'); } catch { /* as above */ }
  try { publish?.({ type: 'needs-you', business, name: name || 'A business', count }); } catch { /* as above */ }
  return out;
}

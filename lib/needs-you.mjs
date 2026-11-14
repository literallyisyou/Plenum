// "<Business>: 2 things need you" (14 Nov 2026). The last notice that a business left new items on the owner's list. lib/setup.mjs sets
// it after a setup step; server.mjs puts it into the state every window gets (needsYou), and desktop/handlers/needs-you.cjs turns a new
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

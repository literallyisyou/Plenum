// The morning and evening brief's routes (wave 8; lib/brief-notify.mjs holds the rules, the record and the words). All JSON.
//   GET  /api/brief-notify            -> { v, settings: { on, morning: { on, at }, evening: { on, at }, businesses: null | [id] },
//                                          next: { slot, at, time, moved } | null, nextText, last: entry | null, log: [entry] (newest
//                                          first), quiet: { on, from, to }, lateMinutes, running, saving, why? }
//                                        nextText is the finished sentence about the next brief ('' while the brief is off); an entry's
//                                        text is the finished sentence about a brief that was sent or not sent, and why.
//   POST /api/brief-notify/settings { on?, morning?: { on?, at? }, evening?: { on?, at? }, businesses?: null | [business id] }
//                                        times 'HH:MM', switches true or false, businesses null for all. Checked whole: one wrong value
//                                        changes nothing (400 with one sentence). -> the GET answer
//   POST /api/brief-notify/now {}     -> { ok: true, sent, why, text }   the brief as it reads now, sent once as a notice (the owner's
//                                        "Send one now"); sent is false with the reason when there is nothing to say
// The server checks the Plenum token on every /api/ request and the JSON content type of every POST before a handler runs. The GET is a
// plain read from memory (a Read-only phone may make it); the POSTs are named by no tier rule, so a phone needs Full for them
// (lib/remote/tiers.mjs). A save that did not reach the file answers 500 with the sentence, so the page never says "Saved" for a change
// that is lost on restart. Nothing here starts a CLI or reaches the network: the brief is made from Plenum's own files and memory.
//
// THE TIMER is armed from here and from nowhere else: loading this module calls start() of lib/brief-notify.mjs, which starts nothing with
// PLENUM_NO_SCHEDULER=1 or PLENUM_SMOKE=1 and reads no file until its first check. While the brief is off, a check does nothing.
import * as brief from '../brief-notify.mjs';

const refuse = (httpError, err) => httpError(Number.isInteger(err?.status) ? err.status : 500, String(err?.message ?? 'That did not work.'));
const lost = failure => `${failure} The change works until Plenum restarts.`;
const pad = n => String(n).padStart(2, '0');

// "The next brief comes today at 18:00." A brief whose time falls inside quiet hours says when it really comes, and why.
export function nextText(state, now = Date.now()) {
  const next = state?.next;
  if (!state?.settings?.on) return '';
  if (!next) return 'Both briefs are switched off, so none will come.';
  if (state.running !== true) return 'Plenum sends nothing by itself in this session, so no brief will come.';
  const d = new Date(next.at);
  const a = new Date(now);
  const sameDay = (x, y) => x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = sameDay(d, a) ? 'today' : sameDay(d, tomorrow) ? 'tomorrow' : `on ${d.toLocaleDateString('en-US', { weekday: 'long' })}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return next.moved
    ? `The next brief comes ${day} at ${time}, when quiet hours end (its own time, ${next.time}, falls inside them).`
    : `The next brief comes ${day} at ${time}.`;
}

function answer() {
  const state = brief.state();
  return { ...state, nextText: nextText(state) };
}

try {
  brief.start();
} catch {
  // A timer that cannot start is not a reason to stop the server; the settings can still be read and saved.
}

export const routes = [
  {
    method: 'GET',
    path: '/api/brief-notify',
    handler: ({ res, json }) => json(res, 200, answer()),
  },
  {
    method: 'POST',
    path: '/api/brief-notify/settings',
    handler: async ({ req, res, json, readBody, httpError }) => {
      const body = await readBody(req);
      let failure;
      try {
        failure = await brief.setSettings(body);
      } catch (err) {
        throw refuse(httpError, err);
      }
      if (failure) throw httpError(500, lost(failure));
      return json(res, 200, answer());
    },
  },
  {
    method: 'POST',
    path: '/api/brief-notify/now',
    handler: async ({ req, res, json, readBody }) => {
      await readBody(req);
      const out = await brief.sendNow();
      return json(res, 200, { ok: true, sent: out.sent === true, why: out.why ?? '', text: out.text ?? '' });
    },
  },
];

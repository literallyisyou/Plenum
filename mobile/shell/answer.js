// The Yes or No of a business's simple yes/no item, tapped on its notification (wave 8, 17 Nov 2026).
//
// The computer names such an item on its 'needs' notification with two actions (lib/remote/push.mjs): No, and, for a phone that has
// Approve from a notification, Yes. Each opens Plenum at #yes=<n>.<token> or #no=<n>.<token> (push.js parseNotificationHash); app.js
// runHash hands the link to answerFromNotification once the app is unlocked and the link is not older than a minute. It sends ONE
// request, POST /api/phone-answer/quick { id, answer }, over the channel, and the computer decides everything (lib/phone-answer.mjs):
// whether the token is one it made, whether the item still waits, whether it is still a simple yes/no, and what Yes and No are (the
// item's own Yes and the server's refusal: this file sends 'yes' or 'no', never a choice of its own). Only a phone at Full is let
// through (lib/remote/tiers.mjs: a POST it does not name needs Full).
// What is never done here: nothing is sent twice (an answer that did not reach the computer is not tried again later by itself), nothing
// is answered while the app is locked, and nothing is answered for an item with a draft: the computer refuses that with its sentence, and
// Today is opened, where the draft is read first.
// No import, so the Node suites load it as it is.

export const ANSWER_PATH = '/api/phone-answer/quick';
export const ANSWER_TEXT = Object.freeze({
  offline: 'Not connected. Open Today to answer it.',
  failed: 'Could not reach your computer. Open Today to answer it.',
  old: 'That notification is more than a minute old. Open Today to answer it.',
});

export const isAnswerLink = link => Boolean(link) && (link.kind === 'yes' || link.kind === 'no') && typeof link.id === 'string' && link.id !== '';

// deps: whenConnected() -> a promise of true once the channel is up, postJson(path, body) -> { ok, status, json, reason } (reason is the
// computer's own sentence for a refusal), say(text, tone), emitRoute(link) (opens a place of the UI), refresh().
// Resolves { ok, reason, kind }.
export async function answerFromNotification(link, { whenConnected, postJson, say = () => {}, emitRoute = () => {}, refresh = () => {} } = {}) {
  const kind = link?.kind;
  if (!isAnswerLink(link)) return { ok: false, reason: 'no link' };
  const openToday = () => {
    try { emitRoute({ kind: 'today' }); } catch { /* the notice says where to go */ }
  };
  let up = false;
  try { up = (await whenConnected()) === true; } catch { up = false; }
  if (!up) {
    say(ANSWER_TEXT.offline, 'warn');
    openToday();
    refresh();
    return { ok: false, reason: 'offline', kind };
  }
  let out = null;
  try { out = await postJson(ANSWER_PATH, { id: link.id, answer: kind }); } catch { out = null; }
  if (out?.ok === true) {
    const said = typeof out.json?.said === 'string' ? out.json.said.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : '';
    say(said || (kind === 'yes' ? 'Answered: Yes.' : 'Answered: No.'), 'ok');
    refresh();
    return { ok: true, reason: null, kind };
  }
  // A refusal with the computer's own sentence (the item no longer waits, the notification is from before Plenum was started again, the
  // item has a draft to read now, this phone is below Full): said as it is. Today is opened, where the item is read and answered.
  const refused = [400, 403, 409].includes(out?.status) && typeof out.reason === 'string' && out.reason && out.reason !== 'failed';
  say(refused ? out.reason.slice(0, 300) : ANSWER_TEXT.failed, 'warn');
  openToday();
  refresh();
  return { ok: false, reason: out?.status === 409 ? 'changed' : out?.status === 403 ? 'refused' : 'failed', kind };
}

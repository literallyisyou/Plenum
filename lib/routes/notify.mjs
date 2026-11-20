// The notification hub's routes (wave 4, n1; lib/notify.mjs holds the rules and the stamped record). All JSON.
//   GET  /api/notify                       -> { settings: { quiet: { on, from, to }, mutes: { <business>: untilMs }, summary: { on, at } },
//                                               recent: [record + { clearedAt }] (newest first, at most 50), open: [record] (newest first),
//                                               seenAt, unseen, quietNow, saving, why? }   saving is false (with why) while notify.json
//                                               cannot be read: the hub then works without saving.
//   POST /api/notify/settings { quiet?: { on?, from?, to? }, summary?: { on?, at? } }   times 'HH:MM', switches true or false. Checked
//                                               whole: one wrong value changes nothing (400). -> the GET answer
//   POST /api/notify/mute { business, minutes } minutes 60 (any whole 1..1440), 'day' (until the end of the local day), or 0 (ends the
//                                               mute). -> { ok: true, business, until }   until is 0 when the mute ended
//   POST /api/notify/test {}                -> { ok: true, notice }  publishes a notice key 'test:<ts>', level 'fyi', title 'Plenum',
//                                               text 'Test: notifications work on this computer.' (a test notice is never held back)
//   POST /api/notify/seen {}                -> { ok: true, seenAt }  the away list is read
//   POST /api/notify/clear { key }        -> { ok: true, key }  Dismiss on a Needs you row: takes the key off the open list and publishes the clear (nothing when it is not open)
// The server checks the Plenum token on every /api/ request and the JSON content type of every POST before a handler runs. The GET is a
// plain read (a Read-only phone may make it); the POSTs are named by no tier rule, so a phone needs Full for them (lib/remote/tiers.mjs).
// A save that did not reach the file answers 500 with the sentence, so the page never says "Saved" for a change that is lost on restart.
//
// THE SUMMARY TIMER is armed from here and from nowhere else: loading this module calls start() of lib/notify.mjs, which starts nothing
// with PLENUM_NO_SCHEDULER=1 or PLENUM_SMOKE=1 and reads no file by itself.
import * as notify from '../notify.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const refuse = (httpError, err) => httpError(Number.isInteger(err?.status) ? err.status : 500, String(err?.message ?? 'That did not work.'));
const lost = failure => `${failure} The change works until Plenum restarts.`;

try {
  notify.start();
} catch {
  // A summary timer that cannot start is not a reason to stop the server; notices are still stamped and logged.
}

export const routes = [
  {
    method: 'GET',
    path: '/api/notify',
    handler: ({ res, json }) => json(res, 200, notify.snapshot()),
  },
  {
    method: 'POST',
    path: '/api/notify/settings',
    handler: async ({ req, res, json, readBody, httpError }) => {
      const body = await readBody(req);
      let failure;
      try {
        failure = await notify.setSettings(body);
      } catch (err) {
        throw refuse(httpError, err);
      }
      if (failure) throw httpError(500, lost(failure));
      return json(res, 200, notify.snapshot());
    },
  },
  {
    method: 'POST',
    path: '/api/notify/mute',
    handler: async ({ req, res, json, readBody, httpError }) => {
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Say which business to mute.');
      let out;
      try {
        out = await notify.mute(body.business, body.minutes);
      } catch (err) {
        throw refuse(httpError, err);
      }
      if (out.failure) throw httpError(500, lost(out.failure));
      return json(res, 200, { ok: true, business: body.business, until: out.until });
    },
  },
  {
    method: 'POST',
    path: '/api/notify/test',
    handler: async ({ req, res, json, readBody, events }) => {
      await readBody(req);
      const ts = Date.now();
      const ev = { type: 'notice', notice: { key: `test:${ts}`, level: 'fyi', title: 'Plenum', text: 'Test: notifications work on this computer.', route: '' } };
      events.publish(ev);
      return json(res, 200, { ok: true, notice: ev.notice });
    },
  },
  {
    method: 'POST',
    path: '/api/notify/seen',
    handler: async ({ req, res, json, readBody, httpError }) => {
      await readBody(req);
      const out = await notify.seen();
      if (out.failure) throw httpError(500, lost(out.failure));
      return json(res, 200, { ok: true, seenAt: out.seenAt });
    },
  },
  {
    method: 'POST',
    path: '/api/notify/clear',
    handler: async ({ req, res, json, readBody, httpError, events }) => {
      const body = await readBody(req);
      const key = isObject(body) && typeof body.key === 'string' ? body.key : '';
      if (!key) throw httpError(400, 'Say which notice to dismiss.');
      // The record is stamped already (dismiss admits the clear), so events.publish's admit passes it through unchanged.
      const rec = notify.dismiss(key);
      if (rec) events.publish({ type: 'notice', notice: rec });
      return json(res, 200, { ok: true, key });
    },
  },
];

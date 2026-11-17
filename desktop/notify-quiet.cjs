'use strict';
// The owner's quiet hours, for the desktop's own run alerts (wave 5 integration, 16 Nov 2026). The notices of lib/notify.mjs come
// stamped (quiet, silent), but a run's finished, failed or approval alert is made here from run events, which carry no stamp. So the
// desktop reads the hub's settings (GET /api/notify, read-only: it moves no seen mark) and answers quietNow() from them with the same
// rule as lib/notify.mjs inQuietHours: from === to is no quiet hours, a span may wrap midnight, local time.
//
// createQuietReader({ fetchJson, now, maxAgeMs }) -> { quietNow(), refresh(), known() }
//   fetchJson(path) -> Promise of the parsed JSON body, or null (no answer, not 200, not JSON). Never rejects (a rejection counts as null).
//   quietNow() answers at once from the settings last read; settings older than maxAgeMs (5 minutes) are read again in the background.
//   Until a read worked it answers false: the alerts then work as they did before quiet hours were known.
//   refresh() reads now (a new events channel, a server that was started again); one read at a time.
const MAX_AGE_MS = 5 * 60_000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const minutesOf = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// The rule of lib/notify.mjs inQuietHours, on cleaned settings.
function inQuietHours(quiet, ms) {
  if (!quiet || quiet.on !== true) return false;
  if (!TIME_RE.test(quiet.from ?? '') || !TIME_RE.test(quiet.to ?? '')) return false;
  const f = minutesOf(quiet.from);
  const t = minutesOf(quiet.to);
  if (f === t) return false;
  const d = new Date(ms);
  const m = d.getHours() * 60 + d.getMinutes();
  return f < t ? m >= f && m < t : m >= f || m < t;
}

function createQuietReader({ fetchJson, now = () => Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  let quiet = null; // { on, from, to } from the last read that worked
  let readAt = -Infinity;
  let reading = null;

  function refresh() {
    if (reading) return reading;
    reading = Promise.resolve()
      .then(() => fetchJson('/api/notify'))
      .catch(() => null)
      .then(body => {
        const q = body && typeof body === 'object' && body.settings && typeof body.settings === 'object' ? body.settings.quiet : null;
        if (q && typeof q === 'object') {
          quiet = { on: q.on === true, from: String(q.from ?? ''), to: String(q.to ?? '') };
          readAt = now();
        }
        // A read that failed keeps what was known, and is tried again at the next question after a minute.
        else readAt = Math.max(readAt, now() - maxAgeMs + 60_000);
      })
      .finally(() => {
        reading = null;
      });
    return reading;
  }

  function quietNow() {
    const t = now();
    if (t - readAt >= maxAgeMs) refresh();
    return quiet ? inQuietHours(quiet, t) : false;
  }

  return { quietNow, refresh, known: () => quiet !== null };
}

module.exports = { createQuietReader, inQuietHours, MAX_AGE_MS };

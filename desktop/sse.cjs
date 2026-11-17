'use strict';
// A small pure parser for a server-sent event stream (the desktop reads GET /api/events with it). Feed it the text as it
// arrives, in any size of piece; it calls onEvent once for each complete event with the data parsed as JSON (or the raw text
// when the data is not JSON). Comment lines (": ping") and the id, retry and event fields are ignored, lines may end in LF,
// CRLF or CR, and the data lines of one event are joined with a newline. A block with no data line is not an event.
// options.skip(text), when given, is asked with the data text of each event before it is parsed: true drops the event unparsed. The
// desktop drops the streamed words of a reply that way (see runEventType), so the main process does no JSON work per word.
function createSseParser(onEvent, { skip = null } = {}) {
  let buffer = '';
  // A CR at the end of a piece may be the first half of a CRLF, so it waits for the next piece.
  let heldCr = false;
  let data = [];

  function dispatch() {
    if (!data.length) return;
    const text = data.join('\n');
    data = [];
    if (typeof skip === 'function' && skip(text) === true) return;
    let value = text;
    try {
      value = JSON.parse(text);
    } catch {
      // Not JSON: the raw text goes on as it is.
    }
    onEvent(value);
  }

  function line(text) {
    if (text === '') return dispatch();
    if (text.startsWith(':')) return undefined;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    if (field !== 'data') return undefined;
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
    return undefined;
  }

  function feed(chunk) {
    let text = (heldCr ? '\r' : '') + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    heldCr = text.endsWith('\r');
    if (heldCr) text = text.slice(0, -1);
    buffer += text.replace(/\r\n|\r/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const one = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      line(one);
    }
  }

  return { feed };
}

// The type of the run's own event inside a run frame, read from the text without parsing it. lib/events.mjs writes a run event as
// JSON.stringify({ type: 'run', runId, project, kind, event: { type, ... }, at }), so the frame starts with {"type":"run", and the inner
// type follows the first "event":{"type":" in it (a string value cannot hold that text: its quotes are escaped). '' when the text is not
// a run frame, or its inner event does not start with its type; the caller then parses it as any other event.
const RUN_HEAD = '{"type":"run",';
const INNER = '"event":{"type":"';
function runEventType(text) {
  if (typeof text !== 'string' || !text.startsWith(RUN_HEAD)) return '';
  const at = text.indexOf(INNER, RUN_HEAD.length);
  if (at === -1) return '';
  const from = at + INNER.length;
  const end = text.indexOf('"', from);
  if (end === -1 || end - from > 40) return '';
  return text.slice(from, end);
}

// The runId of a run frame, read the same way (it is the second field lib/events.mjs writes), or '' when it is not where it is expected.
const RUN_ID = '{"type":"run","runId":"';
function runIdOf(text) {
  if (typeof text !== 'string' || !text.startsWith(RUN_ID)) return '';
  const end = text.indexOf('"', RUN_ID.length);
  if (end === -1 || end - RUN_ID.length > 80) return '';
  return text.slice(RUN_ID.length, end);
}

module.exports = { createSseParser, runEventType, runIdOf };

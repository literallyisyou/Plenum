// Model replies occasionally contain the model's tool protocol as ordinary text.
// Project only the visible reply here. The original transcript and real tool events are separate.
(() => {
  'use strict';

  const TAG = '<(?:(?:antml:)?(?:function_calls|function_results|invoke)|tool_calls?|tool_results?|tool_response)';
  const NAMES = ['function_calls', 'function_results', 'invoke', 'antml:function_calls',
    'antml:function_results', 'antml:invoke', 'tool_calls', 'tool_call', 'tool_results',
    'tool_result', 'tool_response'];
  const OPEN = new RegExp('^ {0,3}(' + TAG + ')([ \\t]+name[ \\t]*=[ \\t]*(?:"[\\w.:-]{1,128}"|\'[\\w.:-]{1,128}\'))?[ \\t]*(/?)>', 'i');
  const CLOSE = new Map(NAMES.map(name => [name, new RegExp('</' + name + '[ \\t]{0,16}>', 'gi')]));
  // The suffix is longer than the longest end tag, including optional spaces.
  const CLOSE_LOOKBEHIND = 64;
  const FENCE = /^ *(?:[-*+•] +|\d{1,9}[.)] +)?([~]{3,}|\x60{3,})(.*)$/;
  const BACKTICKS = /\x60+/g;

  function opening(line) {
    const hit = OPEN.exec(line);
    if (!hit) return null;
    const name = hit[1].slice(1).toLowerCase();
    if (name.endsWith('invoke') && !hit[2]) return null;
    return { length: hit[0].length, close: CLOSE.get(name), selfClosing: hit[3] === '/' };
  }

  // At most one unfinished line is provisional. Hold a partial protocol opener
  // until enough text arrives to distinguish it from words such as "<table".
  function maybeOpening(line) {
    const prefix = /^ {0,3}(<[^>\r\n]*)$/.exec(line)?.[1]?.toLowerCase();
    if (!prefix || prefix.length > 200) return false;
    return NAMES.some(name => {
      const start = '<' + name;
      if (start.startsWith(prefix)) return true;
      if (!prefix.startsWith(start)) return false;
      return /^[ \t/]/.test(prefix.slice(start.length));
    });
  }

  function createStream() {
    let text = '';
    let tail = '';
    let tailEnd = '';
    let waitingClose = null;
    let envelope = null;
    let fence = '';
    let ticks = 0;
    let finished = null;
    const hidden = [];
    const lineEnd = /\r\n|\r(?!$)|\n/g;

    // An end tag can share a line with its entire block or with subsequent prose.
    // Keep the latter in the reply. Only the original hidden text goes into details.
    function protocol(raw, line, commit) {
      let pos = 0;
      let active = envelope;
      while (active || pos < line.length) {
        const from = pos;
        if (!active) {
          const open = opening(line.slice(pos));
          if (!open) break;
          pos += open.length;
          if (open.selfClosing) {
            if (commit) hidden.push(raw.slice(from, pos));
            continue;
          }
          active = { close: open.close, parts: [] };
        }
        active.close.lastIndex = pos;
        if (!active.close.test(line)) {
          if (commit) {
            active.parts.push(raw.slice(from));
            envelope = active;
          }
          return { text: '', waitingClose: active.close };
        }
        pos = active.close.lastIndex;
        if (commit) {
          active.parts.push(raw.slice(from, pos));
          hidden.push(active.parts.join(''));
          envelope = null;
        }
        active = null;
      }
      const rest = line.slice(pos);
      return { text: rest.trim() && (commit || !maybeOpening(rest)) ? raw.slice(pos) : '', waitingClose: null };
    }

    function accept(raw, line) {
      if (envelope) return protocol(raw, line, true).text;
      if (fence) {
        const end = line.trim();
        if (end.length >= fence.length && end[0] === fence[0] && end === fence[0].repeat(end.length)) fence = '';
        return raw;
      }
      const start = FENCE.exec(line);
      if (start && (start[1][0] === '~' || !start[2].includes('\x60'))) {
        fence = start[1];
        ticks = 0;
        return raw;
      }
      if (!line.trim()) ticks = 0;
      if (/^ {0,3}(?:>|#{1,6} )/.test(line)) {
        ticks = 0;
        return raw;
      }
      const display = !ticks && opening(line) ? protocol(raw, line, true).text : raw;
      // Inline code can cross a line in the same paragraph. When in doubt, keep
      // literal text intact until its matching delimiter or a paragraph break.
      for (const mark of display.matchAll(BACKTICKS)) {
        if (!ticks) ticks = mark[0].length;
        else if (ticks === mark[0].length) ticks = 0;
      }
      return display;
    }

    return {
      push(chunk) {
        if (!chunk || finished) return;
        // Avoid rescanning a growing protocol payload (for example, one JSON
        // line). Only the new bytes and the possible split end tag need a look.
        const endsWithCR = tailEnd.endsWith('\r');
        if (!endsWithCR && !/[\r\n]/.test(chunk)) {
          if (waitingClose) {
            waitingClose.lastIndex = 0;
            if (waitingClose.test(tailEnd + chunk)) waitingClose = null;
          }
          tail += chunk;
          tailEnd = (tailEnd + chunk.slice(-CLOSE_LOOKBEHIND)).slice(-CLOSE_LOOKBEHIND);
          return;
        }
        waitingClose = null;
        const source = tail + chunk;
        // Newline search starts at the join. A trailing CR may be the first half
        // of a CRLF, so carry it over if it is the final character of the chunk.
        lineEnd.lastIndex = tail.length - Number(endsWithCR);
        let from = 0;
        let end;
        while ((end = lineEnd.exec(source))) {
          text += accept(source.slice(from, lineEnd.lastIndex), source.slice(from, end.index));
          from = lineEnd.lastIndex;
        }
        tail = source.slice(from);
        tailEnd = tail.slice(-CLOSE_LOOKBEHIND);
      },
      get text() {
        if (finished) return finished.text;
        if (waitingClose) return text;
        if (!envelope && (fence || ticks)) return text + tail;
        if (envelope || opening(tail)) {
          const preview = protocol(tail, tail, false);
          waitingClose = preview.waitingClose;
          return text + preview.text;
        }
        return text + (maybeOpening(tail) ? '' : tail);
      },
      finish() {
        if (finished) return finished;
        if (tail) text += accept(tail, tail.endsWith('\r') ? tail.slice(0, -1) : tail);
        if (envelope) hidden.push(envelope.parts.join(''));
        finished = { text, hidden };
        tail = '';
        envelope = null;
        return finished;
      },
    };
  }

  function clean(src, { streaming = false } = {}) {
    const source = String(src ?? '');
    if (!source.includes('<')) return { text: source, hidden: [] };
    const stream = createStream();
    stream.push(source);
    return streaming ? { text: stream.text, hidden: [] } : stream.finish();
  }

  // The diagnostic is inert text and built only when opened. It is the exact
  // model text omitted above, never a real tool call, result, or approval card.
  function details(hidden) {
    if (!hidden.length) return null;
    const item = document.createElement('details');
    item.className = 'turn-work assistant-protocol';
    const summary = document.createElement('summary');
    summary.textContent = 'Show raw model text';
    item.append(summary);
    const reveal = () => {
      if (!item.open) return;
      const raw = document.createElement('pre');
      raw.className = 'raw-stream';
      raw.textContent = hidden.join('\n');
      item.append(raw);
      item.removeEventListener('toggle', reveal);
    };
    item.addEventListener('toggle', reveal);
    return item;
  }

  globalThis.PlenumAssistantContent = Object.freeze({ clean, createStream, details });
})();

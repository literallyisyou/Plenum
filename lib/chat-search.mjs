import { threadsOf } from './threads.mjs';
import '../public/assistant-content.js';

export const MAX_QUERY = 200;
const MAX_RESULTS = 50;
const SNIPPET_CHARS = 160;

function plainPattern(query) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
}

function snippetAround(content, hit) {
  const room = Math.max(0, SNIPPET_CHARS - hit[0].length);
  const start = Math.max(0, hit.index - Math.floor(room / 2));
  const end = Math.min(content.length, hit.index + hit[0].length + Math.ceil(room / 2));
  const excerpt = content.slice(start, end).replace(/\s+/gu, ' ').trim();
  return `${start ? '…' : ''}${excerpt}${end < content.length ? '…' : ''}`;
}

const visibleMessage = m => m?.draft !== true && (m?.role === 'user' || m?.role === 'assistant') && !(m.role === 'user' && m.kind === 'build');
const timestamp = m => Number.isFinite(m?.ts) ? m.ts : 0;
const visibleText = m => m.role === 'assistant' ? globalThis.PlenumAssistantContent.clean(m.content).text : m.content;

function messageHit(role, index, content, hit) {
  return { index, role, snippet: snippetAround(content, hit) };
}

// Keep the single-thread API for callers that name a thread explicitly.
export function searchMessages(messages = [], query = '') {
  const q = String(query ?? '').trim();
  if (!q || q.length > MAX_QUERY) return [];
  const pattern = plainPattern(q);
  const results = [];
  for (let index = messages.length - 1; index >= 0 && results.length < MAX_RESULTS; index--) {
    const m = messages[index];
    if (!visibleMessage(m) || typeof m.content !== 'string') continue;
    const content = visibleText(m);
    const hit = pattern.exec(content);
    if (hit) results.push(messageHit(m.role, index, content, hit));
  }
  return results;
}

// Title matches lead, then the newest messages. The kept list stays bounded even when a common word has thousands of matches.
const compare = (a, b) => b.rank - a.rank || b.ts - a.ts || b.index - a.index;

export function searchChats(state, projects, query) {
  if (!query || query.length > MAX_QUERY) return { results: [], more: false };
  const pattern = plainPattern(query);
  const kept = [];
  let more = false;

  function keep(candidate, makeResult) {
    const last = kept[kept.length - 1];
    if (kept.length === MAX_RESULTS) {
      more = true;
      if (compare(candidate, last) >= 0) return;
      kept.pop();
    }
    let lo = 0;
    let hi = kept.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(candidate, kept[mid]) < 0) hi = mid;
      else lo = mid + 1;
    }
    kept.splice(lo, 0, { ...candidate, result: makeResult() });
  }

  for (const project of projects) {
    const where = { project: { id: project.id, name: project.name || 'Project' } };
    for (const t of threadsOf(state, project).list) {
      const thread = { id: t.id, name: t.name, main: t.main === true, closed: Boolean(t.closedAt) };
      const log = state.chats?.[t.id];
      const messages = Array.isArray(log) ? log : [];
      const title = thread.main ? `${where.project.name} · ${thread.name}` : thread.name;
      const titleHit = pattern.exec(title);
      if (titleHit) {
        const ts = timestamp(messages.findLast(visibleMessage)) || t.createdAt;
        keep({ rank: 1, ts, index: -1 }, () => ({ ...where, thread, kind: 'title', ts, snippet: snippetAround(title, titleHit) }));
      }
      for (let index = messages.length - 1; index >= 0; index--) {
        const m = messages[index];
        if (!visibleMessage(m) || typeof m.content !== 'string') continue;
        const content = visibleText(m);
        const match = pattern.exec(content);
        if (!match) continue;
        const ts = timestamp(m);
        keep({ rank: 0, ts, index }, () => ({ ...where, thread, kind: 'message', ts, ...messageHit(m.role, index, content, match) }));
      }
    }
  }
  return { results: kept.map(x => x.result), more };
}

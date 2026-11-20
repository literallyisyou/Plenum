// Search every saved chat in one project, or name a thread to search only that transcript.
// Markdown export stays scoped to the chat on screen, or the thread explicitly named in the query.
import { requireToken } from '../auth.mjs';
import { MAX_QUERY, searchChats, searchMessages } from '../chat-search.mjs';
import { labelFor } from '../providers.mjs';
import { scopeOrMain, threadOf } from '../scope.mjs';

export { searchMessages } from '../chat-search.mjs';

export const routes = [
  { method: 'GET', path: '/api/history/search', handler: searchRoute },
  { method: 'GET', path: '/api/history/export', handler: exportRoute },
];

// Line breaks and runs of spaces become one space, so a snippet or a heading stays on one line.
const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// The heading for a message: "You" for the user, the model's short name for a reply (the name the chat shows, see
// modelName in public/app.js), and "Conversation summary" for the summary that /compact leaves.
function headingFor(m) {
  if (m.compact) return 'Conversation summary';
  if (m.role === 'user') return 'You';
  if (!m.model) return 'Assistant';
  return oneLine(labelFor(m.model).replace(/\s*\(.*\)$/, '').replace(/^Claude\s+/, '')) || 'Assistant';
}

// The chat as Markdown: the project's name, then one section for each message. Tool steps come first, one line
// each, as the chat shows them, and a failed step is marked. The text is kept as the user wrote or the model replied.
export function exportMarkdown(project, messages = [], { thread } = {}) {
  // A thread other than Main says so in the title ("Project · Thread").
  const title = [oneLine(project?.name) || 'Chat', oneLine(thread)].filter(Boolean).join(' · ');
  const parts = [`# ${title}`];
  // A reply still being written is a draft row, not part of the chat yet, so it is left out.
  const shown = messages.filter(m => m?.draft !== true);
  if (!shown.length) parts.push('This chat has no messages yet.');
  for (const m of shown) {
    parts.push(`## ${headingFor(m)}`);
    const steps = (m.tools ?? []).map(t => `- \`${oneLine(t.name)}\`: ${oneLine(t.summary)}${t.ok ? '' : ' (failed)'}`);
    if (steps.length) parts.push(['Tool steps:', '', ...steps].join('\n'));
    const body = String(m.content ?? '').trim();
    if (body) parts.push(body);
    // The pictures and files that came with the message, by name, as the chat's chips show them. Backticks in a name are
    // replaced, so the quoting holds.
    const files = (Array.isArray(m.images) ? m.images : []).map(f => `\`${oneLine(f?.name).replace(/`/g, "'") || 'file'}\``);
    if (files.length) parts.push(`Attached: ${files.join(', ')}`);
  }
  return `${parts.join('\n\n')}\n`;
}

// The project a request names. A missing id gets its own message; an unknown id is refused by projectById.
function projectParam(url, projectById, httpError) {
  const id = url.searchParams.get('project');
  if (!id) throw httpError(400, 'Choose a project first.');
  return projectById(id);
}

// The saved transcript of one thread (the scope, see lib/scope.mjs). Reading it does not create an entry, as store.transcript would.
const messagesOf = (store, scope) => store.get().chats?.[scope.id] ?? [];

// The thread a request names (the thread query), else the project's active thread.
const scopeOf = (store, project, url) => scopeOrMain(store, project, threadOf(url.searchParams));

export function searchQuery(url, httpError) {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q) throw httpError(400, 'Type a word or phrase to search for.');
  if (q.length > MAX_QUERY) throw httpError(400, `The search is limited to ${MAX_QUERY} characters.`);
  return q;
}

async function searchRoute({ req, url, res, json, httpError, store, projectById }) {
  requireToken(req, httpError);
  const project = projectParam(url, projectById, httpError);
  const q = searchQuery(url, httpError);
  if (threadOf(url.searchParams)) {
    const scope = scopeOf(store, project, url);
    return json(res, 200, { results: searchMessages(messagesOf(store, scope), q) });
  }
  return json(res, 200, searchChats(store.get(), [project], q));
}

// The download's file name: the project name without the characters a Windows file name cannot hold, and without
// control characters, trailing dots or spaces. "chat" is used when nothing is left.
function fileNameFor(name, thread) {
  const base = [name, thread].filter(Boolean).join(' - ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"\/\\|?*]/g, '')
    // A lone surrogate cannot be sent in a header (encodeURIComponent throws on it), so it is dropped before the cut.
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // The cut is by code point, so a character outside the BMP that straddles the 80th place is not split.
    .match(/^[\s\S]{0,80}/u)[0]
    .replace(/[. ]+$/, '')
    .trim();
  return `${base || 'chat'}.md`;
}

async function exportRoute({ url, res, httpError, store, projectById }) {
  const project = projectParam(url, projectById, httpError);
  const scope = scopeOf(store, project, url);
  // Main's file keeps the project's name; another thread's adds its own ("Project - Thread").
  const threadName = scope.main ? '' : scope.name;
  const name = fileNameFor(project.name, threadName);
  // The plain copy is for clients that cannot read UTF-8 names. Both copies come from the cleaned name, so no header
  // can carry a line break or a quote.
  const plain = name.replace(/[^\x20-\x7e]/g, '_');
  res.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  return res.end(exportMarkdown(project, messagesOf(store, scope), { thread: threadName }));
}

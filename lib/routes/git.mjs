// Git status route for the project header: GET /api/git?project=ID[&thread=ID][&fresh=1]. The command and the parsing are in
// lib/git-status.mjs. The folder is the project's own path, which was checked when the project was added, or, when the request names a
// thread that works in an isolated copy (lib/worktree.mjs), that copy's folder, which Plenum made itself: the chip then shows the copy's
// branch and files, not the project folder's. Main, a thread without a ready copy and a request that names no thread are answered from the
// project folder. Nothing in the request reaches the git command; a thread id only picks one of the folders Plenum already holds.
// The answer is kept for 5 seconds per folder, so several windows and the page's own timer never start more than one git process at a
// time for a folder.
import { gitStatus } from '../git-status.mjs';
import { scopeFor, threadOf } from '../scope.mjs';

const TTL_MS = 5000;
// The page asks for a fresh answer when a run has just ended. That still waits a second, so a loop of requests cannot start
// git again and again.
const FRESH_TTL_MS = 1000;

// The most answers kept. Each isolated copy has one of its own, so answers past their time are dropped when the map grows beyond this.
const CACHE_MAX = 64;

// key -> { at, value, path }: the last answer and when it was read. The key is the project id for the project folder, and the project id
// with the copy's folder for a thread's isolated copy.
const cache = new Map();
// key -> the answer being read now, so two requests at the same moment share one git process.
const reading = new Map();

// The folder of the isolated copy the named thread works in, or null when the project folder is the one to read: no thread named, Main, a
// thread that shares the project folder, or a copy that is not ready. A thread that is not open is refused (404), as in every route that
// takes a thread.
function copyFolder({ store, httpError }, project, thread) {
  if (!thread) return null;
  let scope;
  try {
    scope = scopeFor(store, project, thread);
  } catch (err) {
    if (err?.status && typeof httpError === 'function') throw httpError(err.status, err.message);
    throw err;
  }
  return scope.worktree?.state === 'ready' && typeof scope.root === 'string' && scope.root !== project.path ? scope.root : null;
}

// Keeps an answer, and drops the ones past their time when there are many.
function keep(key, entry) {
  cache.set(key, entry);
  if (cache.size <= CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at >= TTL_MS) cache.delete(k);
}

export const routes = [
  { method: 'GET', path: '/api/git', handler: statusRoute },
];

async function statusRoute({ res, url, json, projectById, store, httpError }) {
  // A project id that is not known is refused by projectById.
  const project = projectById(url.searchParams.get('project'));
  const ttl = url.searchParams.get('fresh') === '1' ? FRESH_TTL_MS : TTL_MS;
  const copy = copyFolder({ store, httpError }, project, threadOf(url.searchParams));
  const folder = copy ?? project.path;
  const key = copy ? `${project.id}\n${copy}` : project.id;
  const hit = cache.get(key);
  // The path is compared too, so a project whose folder was changed never shows the old folder's answer.
  if (hit && hit.path === folder && Date.now() - hit.at < ttl) return json(res, 200, hit.value);

  let pending = reading.get(key);
  if (!pending || pending.path !== folder) {
    pending = { path: folder, promise: copy ? gitStatus(copy) : gitStatus(project.path) };
    reading.set(key, pending);
    pending.promise.then(value => {
      keep(key, { at: Date.now(), value, path: folder });
    }).finally(() => {
      if (reading.get(key) === pending) reading.delete(key);
    });
  }
  return json(res, 200, await pending.promise);
}

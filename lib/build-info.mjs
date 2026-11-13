import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './overlay.mjs';

// Which build this is (DECISIONS item 91). scripts/stamp-build.mjs writes build-info.json at the application root when a pack or a
// dist runs: { version, build, commit, dirty, builtAt }. A development copy has no such file and says so. The file is read once per
// root, because it cannot change while Plenum runs. A file that cannot be read, is not JSON or has the wrong shape is treated as
// missing, so a damaged stamp never stops Plenum or shows a made-up build. Nothing here holds a path, a user name or a secret.

const FILE = 'build-info.json';
const BUILD = /^\d{8}\.\d{4}$/;
const COMMIT = /^[0-9a-f]{4,40}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;

const cache = new Map();

const readJson = file => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The line a person reads and copies into a report. A build that was stamped says its number and commit (and says so when the tree had
// local changes); a development copy says that.
function lineOf(info) {
  const name = info.version ? `Plenum ${info.version}` : 'Plenum';
  if (!info.build) return `${name} (development copy)`;
  const parts = [`build ${info.build}`];
  if (info.commit) parts.push(info.commit);
  if (info.dirty === true) parts.push('with local changes');
  return `${name} (${parts.join(', ')})`;
}

// The version of package.json at the root, or null.
function packageVersion(root) {
  const v = readJson(path.join(root, 'package.json'))?.version;
  return typeof v === 'string' && VERSION.test(v) ? v : null;
}

// The stamp as { version, build, commit, dirty, builtAt }, or null when it is missing or not usable. build must have the shape
// YYYYMMDD.HHmm; commit is a short hash or null; dirty is a boolean or null; builtAt is an ISO time or null.
function readStamp(root) {
  const raw = readJson(path.join(root, FILE));
  if (!isObj(raw) || typeof raw.build !== 'string' || !BUILD.test(raw.build)) return null;
  const version = typeof raw.version === 'string' && VERSION.test(raw.version) ? raw.version : packageVersion(root);
  return {
    version,
    build: raw.build,
    commit: typeof raw.commit === 'string' && COMMIT.test(raw.commit) ? raw.commit : null,
    dirty: typeof raw.dirty === 'boolean' ? raw.dirty : null,
    builtAt: typeof raw.builtAt === 'string' && Number.isFinite(Date.parse(raw.builtAt)) ? raw.builtAt : null,
  };
}

// { version, build, commit, dirty, builtAt, line }. The root is the application root (the same folder as lib/updates.mjs APP_ROOT);
// tests pass a folder of their own.
export function buildInfo(root = APP_ROOT) {
  if (cache.has(root)) return cache.get(root);
  const stamp = readStamp(root) ?? { version: packageVersion(root), build: null, commit: null, dirty: null, builtAt: null };
  const info = Object.freeze({ ...stamp, line: lineOf(stamp) });
  cache.set(root, info);
  return info;
}

// The line alone: "Plenum 0.6.0 (build 20261113.0412, 0af7276)" or "Plenum 0.6.0 (development copy)".
export const buildLine = root => buildInfo(root).line;

// For tests: forget what was read.
export const forgetBuildInfo = () => cache.clear();

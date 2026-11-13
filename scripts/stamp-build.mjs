// Writes build-info.json at the project root: which build this is (DECISIONS item 91). The pack and dist scripts run it first, and the
// file ships in the package (build.files) but is not committed (.gitignore). lib/build-info.mjs reads it; the desktop shell reads it too.
//   { version, build, commit, dirty, builtAt }
//   version  from package.json
//   build    the UTC time as YYYYMMDD.HHmm
//   commit   the short hash of HEAD ("git rev-parse --short HEAD"), or null
//   dirty    true when "git status --porcelain" lists anything, false when it lists nothing, or null
//   builtAt  the same moment as an ISO time
// Git is only read, and a missing git, a folder that is not a repository or a git that fails gives null for commit and dirty: a build
// never fails for that. Usage: node scripts/stamp-build.mjs [--out <file>] [--root <project folder>]
// --out is where the file goes (tests use it so they never write into the project); --root is the project folder to read
// package.json and git from (default: the folder above scripts/).
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pad = n => String(n).padStart(2, '0');

// UTC "YYYYMMDD.HHmm".
export const buildNumber = (date = new Date()) =>
  `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}.${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;

// Runs git read-only in root and answers its output, or null when git is missing, fails or the folder is not itself a repository.
// GIT_CEILING_DIRECTORIES stops git from looking above root, so a folder that only sits inside another repository does not take that
// repository's commit.
function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
      windowsHide: true,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(root)) },
    });
  } catch {
    return null;
  }
}

// The stamp for the project at root.
export function makeStamp(root, now = new Date()) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version === '') throw new Error('package.json has no version.');
  const head = git(root, ['rev-parse', '--short', 'HEAD']);
  const commit = head !== null && /^[0-9a-f]{4,40}$/.test(head.trim()) ? head.trim() : null;
  const status = commit === null ? null : git(root, ['status', '--porcelain']);
  return {
    version: pkg.version,
    build: buildNumber(now),
    commit,
    dirty: status === null ? null : status.trim() !== '',
    builtAt: now.toISOString(),
  };
}

// Writes the stamp to out in one rename, so a reader never sees half a file.
export function writeStamp(root, out) {
  const stamp = makeStamp(root);
  mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stamp, null, 2)}\n`);
  renameSync(tmp, out);
  return stamp;
}

const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(flag(process.argv, '--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const out = path.resolve(flag(process.argv, '--out') ?? path.join(root, 'build-info.json'));
  try {
    const s = writeStamp(root, out);
    console.log(`Stamped ${path.basename(out)}: ${s.version} build ${s.build}${s.commit ? `, ${s.commit}` : ''}${s.dirty ? ', with local changes' : ''}`);
  } catch (err) {
    console.error(`Could not write the build stamp: ${err.message}`);
    process.exit(1);
  }
}

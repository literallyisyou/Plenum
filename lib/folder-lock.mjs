// The folder lock for commands (DECISIONS item 197, the open hole of item 150). In a folder that belongs to a business that is not closed,
// on Auto-approve ("Work on its own inside this folder"), a command whose working folder or plain path words reach outside the folder shows
// its card, as on Ask first; a command that stays inside runs without one, as before. Ask first shows every card anyway, Approve all answers
// this card as it answers the outside-write card, and a project that belongs to no business is not changed.
// The places a command is answered call heldCommand: run_command (lib/tools.mjs runTool), Claude Code's Bash and PowerShell (lib/claude-cli.mjs
// answer), Grok Build and Antigravity (lib/grok.mjs acpRun) and Cursor (lib/cursor.mjs). Codex, Gemini CLI and Muse Code never send their
// commands to Plenum, so nothing here reads them: their own settings hold them (Codex's sandbox, the approval modes of the other two).
//
// What is read, from the command text only: every word as written and as it really is (.., ~, %VAR%, $env:VAR, ${VAR} and $VAR from this
// process, links and junctions followed as far as the path exists); a cd (cd, chdir, pushd, Set-Location, sl, Push-Location) moves the folder
// later words are read from, and a bare cd counts as the home folder; the working folder a program gives with its request (cwd); redirections
// (> file), name=value and --flag=value words, a path glued to a short flag (-IC:\x, -o/tmp/x); a quoted piece with spaces is read as one path
// and as a command line of its own; the commands inside powershell -EncodedCommand; the program a command starts when it is written as a path;
// registry keys (HKCU:\..., HKEY_...) and network paths (\\server\share) count as outside. A word whose place cannot be read (a variable
// this process does not know, used as part of a path; cd -; a command too long to read whole) asks as well.
// What cannot be known from a command line, and is not held: a script or program that opens other paths when it runs (node build.js, npm run,
// a .bat file, git hooks), a path built at run time from pieces (a bare variable such as $f is not read as a path), what a program's own
// shell keeps between commands (Claude Code keeps its working folder from one command to the next), and changes that are not paths (services,
// scheduled tasks, settings, the network). This is a check of the command line, not a sandbox. Each command is read with its shell's rules
// (commandReach's shell: sh for Claude Code's Bash tool, cmd for run_command on Windows and for the ACP programs); in cmd's and PowerShell's
// reading a word /name is a switch, so PowerShell's Remove-Item /data is not held, and .. after a link is folded first, as Windows does (Linux
// and macOS follow the link first).
//
// THE CONTRACT (build/v06/w8-folder-lock pins it):
//   commandReach(command, { root, cwd?, home?, shell? }) -> { outside: [{ word, place }], unknown: [word] }
//       outside: the words that reach outside root, each with the place it was read as (the real path, or the word itself for a registry key or
//       a network path); unknown: the words whose place cannot be read. cwd is the folder the command starts in (root when left out).
//       shell is 'sh', 'cmd' or 'powershell' (left out: cmd's rules on Windows, sh's elsewhere); see the rules at the top of commandReach.
//   lockFor(ctx, { root, businessFor? }) -> a promise of null | { root, business: { id, name } }: ctx.mode is 'auto' and ctx.project (or the
//       project whose folder is root) belongs to a business that is not closed. businessFor(projectId) defaults to lib/business.mjs.
//   heldCommand(ctx, command, { root, cwd?, shell?, businessFor? }) -> a promise of null | { business, root, places: [text], unknown: boolean, line }:
//       null when the command may run without a card; else why it asks (line is the sentence the card carries).
//   heldCard(card, held) -> a copy of the card whose detail starts with held.line (the card itself when held is null).
// The setup form says the same in words (public/ext-biz-setup.js, TEXT.autoNote).
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_CHARS = 100_000;
const MAX_WORDS = 4000;
const MAX_DEPTH = 3;
const MAX_PLACES = 3;

// ---------- the words of a command ----------

// The pieces of a command, in order: a quoted string whole (quotes kept), a run of command separators (& | ; and line breaks), or a word (split
// at spaces, quotes and the shell's other separators). cmd's escape character is removed first, as lib/tools.mjs commandTokens does.
const tokensOf = text => text.replace(/\^/g, '').matchAll(/"[^"]*"|'[^']*'|[&|;\r\n]+|[^\s"'`&|;<>(),=]+/g);

const CD_WORDS = new Set(['cd', 'chdir', 'pushd', 'push-location', 'set-location', 'sl']);
// A word after one of these starts a command of its own: cmd /c x, bash -c x, powershell -Command x.
const SHELL_FLAGS = new Set(['/c', '/k', '-c', '-lc', '-ic', '-command']);
// Words that come before a command without being one.
const COMMAND_PREFIX = new Set(['{', '}', 'then', 'do', 'else', 'elif', 'fi', 'done', 'call', 'start', '&', '.', 'exec', 'time', 'sudo', 'env', 'nohup']);
// The top folders of a POSIX system: /tmp is a path, /s is a cmd switch.
const POSIX_TOPS = new Set(['tmp', 'etc', 'usr', 'var', 'dev', 'opt', 'bin', 'sbin', 'home', 'root', 'mnt', 'proc', 'sys', 'srv', 'lib', 'lib64', 'boot', 'media', 'run', 'private', 'users', 'volumes', 'windows', 'program files']);
const DEVICES = /^(?:\/dev\/(?:null|zero|stdin|stdout|stderr|tty|fd\/\d+|random|urandom)|\\\\\.\\(?:nul|con))$/i;
const URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const REMOTE = /^[\w.-]+@[\w.-]+:/;
const REGISTRY = /^(?:hklm|hkcu|hkcr|hku|hkcc|hkey_[a-z_]+)(?::|\\|\/|$)|^registry::|^(?:cert|wsman):/i;
const NOT_FOLDERS = /^(?:env|variable|function|alias):/i;
const NETWORK = /^(?:\\\\|\/\/)(?![?.][\\/])/;
const LONG_PREFIX = /^\\\\[?.]\\(?=[a-z]:)/i;
const DRIVE = /^[a-z]:/i;
// A path glued to a short or long flag: -IC:\x, -o/tmp/x, --out:C:\x.
const GLUED = /^-{1,2}[A-Za-z0-9_-]*?:?((?:[A-Za-z]:)?[\\/].*)$/;

// The value of a variable as this process sees it; a list of paths (PATH and the like) is not one path and is left as it is. HOME and
// USERPROFILE are the home folder even where the variable is not set, as lib/tools.mjs reads them.
function variable(name, home, base) {
  const lower = name.toLowerCase();
  if (lower === 'pwd' || lower === 'cd') return base;
  // $_ is PowerShell's pipeline item (and bash's last word), never the _ this process was started with.
  if (lower === '_') return undefined;
  let v = process.env[name];
  if (typeof v !== 'string') {
    const key = Object.keys(process.env).find(k => k.toLowerCase() === lower);
    v = key === undefined ? undefined : process.env[key];
  }
  if (typeof v !== 'string' && (lower === 'home' || lower === 'userprofile')) v = home;
  if (typeof v !== 'string' || v.includes(';') || (process.platform !== 'win32' && v.includes(':'))) return undefined;
  return v;
}

// A word with its variables replaced. unknown is true when it held a variable that could not be replaced. bang: cmd's delayed expansion
// (!VAR!, on with cmd /v:on or setlocal enabledelayedexpansion) is read too.
function expand(word, home, base, bang = false) {
  let unknown = false;
  const put = (m, name) => {
    const v = variable(name, home, base);
    if (v === undefined) unknown = true;
    return v ?? m;
  };
  let text = word.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, put);
  if (bang) text = text.replace(/!([A-Za-z_][A-Za-z0-9_]*)!/g, put);
  text = text
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, put)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, put)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, put);
  return { text, unknown };
}

const tilde = (word, home) => (word === '~' || /^~[\\/]/.test(word) ? path.join(home, word.slice(1)) : word);

// The place a path really is: links and junctions are followed as far as the path exists, and the part that does not exist yet is kept as
// written after the part that does. Falls back to the path as written. The folders are looked up from the top down and each one once per
// cache (a Map that one command's reading shares), so a word costs about one file-system call, and none is spent below a folder that is not
// there. A network path is never looked up (a server that does not answer would hold the server's one thread); it counts as written.
export function realPlaceOf(p, cache = null) {
  const full = path.resolve(p);
  const { root } = path.parse(full);
  if (/^[\\/]{2}/.test(root)) return full;
  const parts = full.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let found = null;
  let at = 0;
  let prefix = root;
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) prefix = path.join(prefix, parts[i - 1]);
    let real = cache?.get(prefix);
    if (real === undefined) {
      try {
        real = realpathSync.native(prefix);
      } catch {
        real = null;
      }
      cache?.set(prefix, real);
    }
    if (real === null) break;
    found = real;
    at = i;
  }
  return found === null ? full : path.join(found, ...parts.slice(at));
}

const insideOrSame = (outer, inner) => {
  const rel = path.relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// The commands inside powershell -EncodedCommand (-e, -ec, ... any start of the word): base64 of UTF-16 text.
function encodedCommands(text) {
  const found = [];
  for (const m of text.matchAll(/(?:^|\s)-(e[a-z]*)\s+["']?([A-Za-z0-9+/]{8,}={0,2})["']?/gi)) {
    const flag = m[1].toLowerCase();
    if (flag !== 'ec' && !'encodedcommand'.startsWith(flag)) continue;
    const decoded = Buffer.from(m[2], 'base64').toString('utf16le');
    if (decoded.trim()) found.push(decoded);
  }
  return found;
}

// ---------- the reach of one command line ----------

export function commandReach(command, { root, cwd, home = os.homedir(), shell } = {}) {
  const text = String(command ?? '');
  const out = { outside: [], unknown: [] };
  if (typeof root !== 'string' || !root) {
    out.unknown.push('(no folder)');
    return out;
  }
  // The shell's own rules. sh (Claude Code's Bash tool, which is Git Bash on Windows, and every shell off Windows): /x is a path (on Windows
  // /d is the drive D:) and a lone \ is an escape (find ... -exec rm {} \;). cmd (run_command on Windows, and a program that does not say
  // which shell it uses): /x is a switch, \ the root of the drive, and !VAR! a variable too. powershell: /x stays a switch (the programs it
  // starts read it so), and !VAR! is not a variable.
  const sh = (shell ?? (process.platform === 'win32' ? 'cmd' : 'sh')) === 'sh';
  const bang = !sh && shell !== 'powershell';
  const mount = word => (sh && process.platform === 'win32' ? word.replace(/^\/([a-z])(?=[\\/]|$)/i, (m, d) => `${d.toUpperCase()}:\\`) : word);
  const cache = new Map();
  const realPlace = p => realPlaceOf(p, cache);
  const realRoot = realPlace(root);
  const start = path.resolve(root, typeof cwd === 'string' && cwd.trim() ? expand(tilde(cwd.trim(), home), home, root).text : '.');
  const seen = new Set();
  const outside = (word, place) => {
    const key = `${word}\n${place}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.outside.push({ word, place });
    }
  };
  const unknown = word => {
    if (!out.unknown.includes(word)) out.unknown.push(word);
  };
  if (text.length > MAX_CHARS) {
    unknown('(a command too long to read whole)');
    return out;
  }
  if (!insideOrSame(realRoot, realPlace(start))) outside(String(cwd), realPlace(start));
  let words = 0;

  // Reads one word as a path from the folder base. strictBare: a bare name (no slash, no drive, not . or ..) is still followed through a
  // link or junction of that name; the program word skips bare names, which the shell looks up on PATH.
  const readWord = (raw, base, { program = false } = {}) => {
    if (raw === '' || raw === '-' || raw === '--') return;
    if (sh && raw === '\\') return;
    const { text: expanded, unknown: hasUnknown } = expand(raw, home, base, bang);
    const word = tilde(expanded, home);
    if (URL.test(word) || REMOTE.test(word) || DEVICES.test(word) || NOT_FOLDERS.test(word)) return;
    if (/^\$(?:null|true|false|_)$/i.test(raw)) return;
    if (REGISTRY.test(word)) return outside(raw, word);
    if (NETWORK.test(word)) return outside(raw, word);
    const local = word.replace(LONG_PREFIX, '');
    let candidate = local;
    if (candidate.startsWith('-')) {
      const glued = GLUED.exec(candidate);
      if (!glued) return;
      candidate = glued[1];
    }
    candidate = mount(candidate);
    // A cmd switch (/s, /b, /a:d, /MIR) is not a path; a POSIX top folder (/tmp, /etc) is. In sh every /x is a path.
    const slashOnly = !sh && /^\/([^\\/]+)$/.exec(candidate);
    if (slashOnly && !POSIX_TOPS.has(slashOnly[1].toLowerCase().replace(/:.*$/, ''))) return;
    const pathLike = candidate === '.' || candidate === '..' || /[\\/]/.test(candidate) || DRIVE.test(candidate);
    if (hasUnknown) {
      if (pathLike) unknown(raw);
      return;
    }
    if (!pathLike && program) return;
    const lexical = path.resolve(base, candidate);
    const real = realPlace(lexical);
    if (!insideOrSame(realRoot, real)) outside(raw, real);
  };

  // Walks one command line from the folder `from`; a quoted piece with spaces is walked as a line of its own, whose cd does not carry on.
  const walk = (line, from, depth) => {
    let base = from;
    let atCommand = true;
    let cdWait = false;
    let prog = ''; // the program of the command being read, for sh's /c
    const cdTo = (raw, quoted) => {
      if (raw === '-') return unknown('cd -');
      const { text: expanded, unknown: hasUnknown } = expand(raw, home, base, bang);
      if (hasUnknown) return unknown(raw);
      const target = mount(tilde(expanded, home));
      if (!quoted && (REGISTRY.test(target) || NETWORK.test(target))) return outside(raw, target);
      base = path.resolve(base, target.replace(LONG_PREFIX, ''));
      const real = realPlace(base);
      if (!insideOrSame(realRoot, real)) outside(`cd ${raw}`, real);
    };
    for (const [token] of tokensOf(line)) {
      if (++words > MAX_WORDS) {
        unknown('(a command too long to read whole)');
        return;
      }
      if (/^[&|;\r\n]/.test(token)) {
        // A cd with no folder goes to the home folder in a POSIX shell and in PowerShell 7.
        if (cdWait) cdTo('~', false);
        cdWait = false;
        atCommand = true;
        continue;
      }
      const quoted = token[0] === '"' || token[0] === "'";
      const word = quoted ? token.slice(1, -1) : token;
      if (quoted && depth < MAX_DEPTH && /[\s"'`&|;<>(),=]/.test(word)) walk(word, base, depth + 1);
      const lower = word.toLowerCase();
      if (cdWait) {
        if (!quoted && /^-[a-z@]*$/i.test(word) && word !== '-') continue; // a flag: -P, -Path, -LiteralPath
        if (!sh && !quoted && lower === '/d') continue;
        cdWait = false;
        cdTo(word, quoted);
        continue;
      }
      if (atCommand) {
        if (!quoted && COMMAND_PREFIX.has(lower)) continue;
        atCommand = false;
        prog = lower.split(/[\\/]/).pop().replace(/\.exe$/, '');
        if (CD_WORDS.has(lower)) {
          cdWait = true;
          continue;
        }
        // cmd takes the target right after the command: cd.. and cd\Users.
        const glued = !quoted && /^(?:cd|chdir)([.\\/].*)$/i.exec(word);
        if (glued) {
          cdTo(glued[1], false);
          continue;
        }
        readWord(word, base, { program: true });
        continue;
      }
      // In sh, /c and /k (and Git Bash's //c) start a command only after cmd: elsewhere /c is the drive C:.
      const flag = sh && prog === 'cmd' ? lower.replace(/^\/\//, '/') : lower;
      if (!quoted && SHELL_FLAGS.has(flag) && (!sh || flag.startsWith('-') || prog === 'cmd')) {
        atCommand = true;
        continue;
      }
      readWord(word, base);
    }
    if (cdWait) cdTo('~', false);
  };

  walk(text, start, 0);
  let depth = 0;
  let inner = encodedCommands(text);
  while (inner.length && depth < MAX_DEPTH) {
    for (const line of inner) walk(line, start, 0);
    inner = inner.flatMap(encodedCommands);
    depth += 1;
  }
  return out;
}

// ---------- whether the lock holds for a run ----------

let businessLib = null;
const defaultBusinessFor = async () => {
  businessLib ??= import('./business.mjs');
  const mod = await businessLib;
  return id => mod.businessFor(id);
};
let storeLib = null;
// The project whose folder is root, for a ctx that carries no project record.
async function projectIdByFolder(root) {
  try {
    storeLib ??= import('./store.mjs');
    const projects = (await storeLib).get()?.projects ?? [];
    const want = realPlaceOf(root);
    const hit = projects.find(p => typeof p?.path === 'string' && p.path && path.relative(realPlaceOf(p.path), want) === '');
    return typeof hit?.id === 'string' ? hit.id : '';
  } catch {
    return '';
  }
}

export async function lockFor(ctx, { root, businessFor } = {}) {
  if (ctx?.mode !== 'auto') return null;
  const folder = typeof root === 'string' && root ? root : (typeof ctx?.root === 'string' ? ctx.root : '');
  let id = typeof ctx?.project?.id === 'string' ? ctx.project.id : '';
  if (!id && folder && !businessFor) id = await projectIdByFolder(folder);
  if (!id) return null;
  let business;
  try {
    const find = businessFor ?? (await defaultBusinessFor());
    business = find(id);
  } catch {
    // The business record could not be asked: the command is held, because a lock that cannot be checked is not let go.
    return { root: folder, business: { id: '', name: '' } };
  }
  if (!business || typeof business !== 'object' || business.status === 'closed') return null;
  return { root: folder, business: { id: String(business.id ?? ''), name: String(business.name ?? '') } };
}

const shown = s => (s.length > 160 ? `${s.slice(0, 160)}…` : s);

export async function heldCommand(ctx, command, { root, cwd, shell, businessFor } = {}) {
  const lock = await lockFor(ctx, { root, businessFor });
  if (!lock) return null;
  const reach = commandReach(command, { root: lock.root, cwd, shell });
  if (!reach.outside.length && !reach.unknown.length) return null;
  // Each place as it was written, with where it really is when that reads differently (a relative path, a variable, a junction).
  const places = reach.outside.slice(0, MAX_PLACES).map(({ word, place }) => {
    const w = shown(word);
    const p = shown(place);
    return w.toLowerCase() === p.toLowerCase() ? w : `${w} (${p})`;
  });
  const more = reach.outside.length > MAX_PLACES ? ` and ${reach.outside.length - MAX_PLACES} more` : '';
  const whose = lock.business.name ? `${lock.business.name}'s folder` : 'this business\'s folder';
  const line = places.length
    ? `This command reaches outside ${whose} (${lock.root}): ${places.join(', ')}${more}. On Auto-approve a command runs without a card only while it stays inside the folder.`
    : `Plenum cannot tell from this command where it reaches (${shown(reach.unknown.slice(0, MAX_PLACES).join(', '))}), so it asks. On Auto-approve a command runs without a card only while it stays inside ${whose}.`;
  return { business: lock.business, root: lock.root, places, unknown: !places.length, line };
}

export function heldCard(card, held) {
  if (!held) return card;
  const detail = typeof card?.detail === 'string' && card.detail ? `${held.line}\n\n${card.detail}` : held.line;
  return { ...card, detail };
}

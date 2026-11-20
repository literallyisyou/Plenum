// npm run check: the gate that runs before a build and on every push (.github/workflows/core.yml, and release.yml before a draft).
//
// 1. Syntax. Every source file of the app is parsed, none is run: server.mjs and plenum.mjs, lib/, desktop/, public/ (the page's
//    scripts) and scripts/. A .mjs file is parsed as an ES module, a .cjs file as the body of a CommonJS module, and a .js file
//    under public/ as a classic browser script.
// 2. Imports. Every relative import (static import, export ... from, a literal import('./x.mjs'), a literal require('./x.cjs'))
//    must name a file that exists, and every named import of one ES module from another must be an export of it. V8 itself does
//    the second check: all the modules are linked together without being run, so `export *`, `export { a as b }`, default
//    exports and cycles are judged by the engine and not by a pattern. Imports of node: modules are checked against the real
//    export list of the running Node. Packages named in static imports or literal import()/require() must be declared and present.
//    Packages and non-ES-module targets are never run. Their exports and package subpaths are left to runtime checks.
//
// One command, no network, nothing started, nothing written. About a second on a developer PC.
//   node scripts/check.mjs [--root <folder>]     --root checks another copy of the project (the default is this one).
// Exit code 0 when everything passes, 1 when anything is wrong (each problem is printed as "file:line  what"), 2 when the
// check itself could not run.
//
// Linking ES modules without running them needs vm.SourceTextModule, which Node offers only behind --experimental-vm-modules.
// So when the flag is missing the script starts itself once with it (the same file, the same arguments, output passed through).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire, isBuiltin } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);

if (typeof vm.SourceTextModule !== 'function') {
  if (process.env.PLENUM_CHECK_CHILD === '1') {
    console.error('check: this Node has no vm.SourceTextModule even with --experimental-vm-modules. Use Node 20.19 or newer.');
    process.exit(2);
  }
  const run = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', SELF, ...args], {
    stdio: 'inherit',
    env: { ...process.env, PLENUM_CHECK_CHILD: '1' },
  });
  process.exit(run.status ?? 2);
}

if (args.length && (args.length !== 2 || args[0] !== '--root' || !args[1] || args[1].startsWith('--'))) {
  console.error('Usage: node scripts/check.mjs [--root <folder>]');
  process.exit(2);
}
const ROOT = path.resolve(args[1] ?? path.join(path.dirname(SELF), '..'));
const started = Date.now();

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('expected a JSON object');
} catch (e) {
  console.error(`check: cannot read package.json in ${ROOT}: ${e.message}`);
  process.exit(2);
}

// ---------- what is checked ----------
const TOP_FILES = ['server.mjs', 'plenum.mjs'];
const TOP_DIRS = ['lib', 'desktop', 'public', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'release', 'dist', 'coverage']);
const SOURCE = /\.(mjs|cjs|js)$/i;

const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const findings = [];
const seenFinding = new Set();
function report(file, line, message) {
  const key = `${file}:${line ?? 0}:${message}`;
  if (seenFinding.has(key)) return;
  seenFinding.add(key);
  findings.push({ file, line: line ?? null, message });
}

function listFiles() {
  const out = [];
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
      report(rel(dir), null, `cannot list source directory (${e.code ?? 'error'})`);
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); } else if (e.isFile() && SOURCE.test(e.name)) out.push(full);
    }
  };
  for (const f of TOP_FILES) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) out.push(p);
    else report(f, null, 'required source file is missing');
  }
  for (const d of TOP_DIRS) walk(path.join(ROOT, d));
  return out;
}

// How a file is read: 'esm', 'cjs' or 'classic' (a browser script).
function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mjs') return 'esm';
  if (ext === '.cjs') return 'cjs';
  return rel(file).startsWith('public/') ? 'classic' : 'esm';
}

const stripBang = text => (text.startsWith('#!') ? '//' + text.slice(2) : text);
function lineOf(err) {
  const m = /:(\d+)(?::\d+)?\r?\n/.exec(String(err?.stack ?? '').split('\n').slice(0, 2).join('\n') + '\n');
  return m ? Number(m[1]) : null;
}
// A module's SyntaxError carries no line. Only for a file that already failed, node --check is asked for it (the first line of its report).
function lineFromNode(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  const m = /:(\d+)\r?\n/.exec(String(r.stderr ?? '').split('\n').slice(0, 2).join('\n') + '\n');
  return m ? Number(m[1]) : null;
}
const oneLine = err => String(err?.message ?? err).split('\n')[0];

// ---------- 1. syntax ----------
const files = listFiles();
const text = new Map();
const kind = new Map();
const esm = new Map(); // file -> SourceTextModule, parsed once; rebuilt when a link attempt fails
const mkModule = file => new vm.SourceTextModule(stripBang(extraSource.get(file) ? text.get(file) + extraSource.get(file) : text.get(file)), { identifier: pathToFileURL(file).href });
const extraSource = new Map(); // file -> text appended after a missing export was found (see link phase), so the run can go on and report the rest

for (const file of files) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { report(rel(file), null, `cannot be read: ${oneLine(e)}`); continue; }
  text.set(file, src);
  const k = kindOf(file);
  kind.set(file, k);
  try {
    if (k === 'esm') esm.set(file, mkModule(file));
    else if (k === 'cjs') vm.compileFunction(stripBang(src), ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file });
    else new vm.Script(stripBang(src), { filename: file });
  } catch (e) {
    report(rel(file), lineOf(e) ?? (kind.get(file) === 'esm' ? lineFromNode(file) : null), `syntax error: ${oneLine(e)}`);
  }
}

// ---------- 2. relative references ----------
const isRelative = spec => spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..' || spec.startsWith('file:');
const fileExists = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const dirExists = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
function esmPath(from, spec) {
  try { return fileURLToPath(new URL(spec, pathToFileURL(from))); } catch { return null; }
}
// Use Node's lookup so directory entries honor their package.json and no module code is run.
function resolveRequire(from, spec) {
  try { return createRequire(from).resolve(spec); } catch { return null; }
}
// An ES module's lookup: the exact file, nothing else (Node adds no extension and reads no folder index).
const resolveEsm = (from, spec) => { const p = esmPath(from, spec); return p && fileExists(p) ? p : null; };
const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }));
const pkgNameOf = spec => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
function checkPackage(file, spec, label, line = null) {
  const name = pkgNameOf(spec);
  const dir = path.join(ROOT, 'node_modules', ...name.split('/'));
  if (!declared.has(name)) report(rel(file), line, `${label} needs the package "${name}", which package.json does not list`);
  else if (!dirExists(dir)) report(rel(file), line, `${label} needs the package "${name}", which is not installed (run npm ci)`);
}

// Lines that are plainly comments are skipped, so a sentence that quotes require('./x') is not a reference.
const codeLines = src => src.split('\n').map(l => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n');
const REQUIRE_RE = /(?<![\w$.])require\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const DYNAMIC_RE = /(?<![\w$.])import\(\s*(['"])([^'"\n]+)\1\s*[,)]/g;
for (const file of files) {
  if (!text.has(file)) continue;
  const src = codeLines(text.get(file));
  const k = kind.get(file);
  const scan = (re, resolver, label) => {
    for (const m of src.matchAll(re)) {
      const spec = m[2];
      const line = src.slice(0, m.index).split('\n').length;
      const reference = `${label}('${spec}')`;
      if (isRelative(spec)) {
        if (!resolver(file, spec)) report(rel(file), line, `${reference} names a file that does not exist`);
      } else if (!isBuiltin(spec) && !spec.startsWith('#') && !spec.includes(':') && !path.isAbsolute(spec)) {
        checkPackage(file, spec, reference, line);
      }
    }
  };
  if (k === 'cjs') scan(REQUIRE_RE, resolveRequire, 'require');
  if (k !== 'classic') scan(DYNAMIC_RE, resolveEsm, 'import');
}

// ---------- 3. named imports, by linking the modules (nothing is run) ----------
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What each import clause asks for, read with a plain pattern. It is used only to give a non-ES-module target (a CommonJS file, a JSON file,
// a package) the names that are asked of it: V8 needs a module's export names before it will link to it, and Node itself decides those
// at run time. A name this pattern misses is added when V8 names it in an error (below), so a miss costs a pass, never a wrong verdict.
const IMPORT_CLAUSE_RE = /\b(?:import|export)\s*(?:type\s+)?([\w$\s,*{}]*?)\s*from\s*(['"])([^'"\n]+)\2/g;
function namesOfClause(clause) {
  const names = new Set(['default']);
  const brace = /\{([^}]*)\}/.exec(clause);
  if (brace) for (const part of brace[1].split(',')) { const n = part.trim().split(/\s+as\s+/)[0].trim(); if (n && n !== 'type') names.add(n); }
  return names;
}

const foreignNames = new Map(); // key (an absolute path, a node: name or a package name) -> Set of export names to give it
const addForeign = (key, names) => { const s = foreignNames.get(key) ?? new Set(['default']); for (const n of names) s.add(n); foreignNames.set(key, s); };
const keyFor = (from, spec) => {
  if (isBuiltin(spec)) return { type: 'builtin', key: spec.startsWith('node:') ? spec : `node:${spec}` };
  if (isRelative(spec)) {
    return { type: 'file', key: esmPath(from, spec) };
  }
  return { type: 'package', key: pkgNameOf(spec), spec };
};
for (const [file] of esm) {
  const src = codeLines(text.get(file));
  for (const m of src.matchAll(IMPORT_CLAUSE_RE)) {
    const t = keyFor(file, m[3]);
    if (t.type === 'file' && esm.has(t.key)) continue;
    addForeign(t.key, namesOfClause(m[1]));
  }
}

// Real export names of the Node's own modules, so a wrong name from 'node:fs' is caught.
const builtinNames = new Map();
async function realBuiltinNames(key) {
  if (!builtinNames.has(key)) {
    try { builtinNames.set(key, new Set(['default', ...Object.keys(await import(key))])); } catch { builtinNames.set(key, null); }
  }
  return builtinNames.get(key);
}

let requestLog = []; // { importer, spec, key } for every link request of the current pass
async function linker(spec, referencing) {
  const importer = fileURLToPath(referencing.identifier);
  const t = keyFor(importer, spec);
  requestLog.push({ importer, spec, key: t.key, type: t.type });
  if (t.type === 'file') {
    if (esm.has(t.key)) return esm.get(t.key);
    if (!t.key || !fileExists(t.key)) {
      report(rel(importer), null, `import '${spec}' names a file that does not exist`);
      return foreignModule(t.key);
    }
    return foreignModule(t.key); // a .cjs, .json or classic file: Node lets an ES module take its default and any names it can find
  }
  if (t.type === 'builtin') {
    const names = await realBuiltinNames(t.key);
    if (names) return foreignModule(t.key, names);
    return foreignModule(t.key);
  }
  // a package
  checkPackage(importer, spec, `import '${spec}'`);
  return foreignModule(t.key);
}
const foreignCache = new Map();
function foreignModule(key, fixedNames) {
  if (!foreignCache.has(key)) {
    const names = fixedNames ?? foreignNames.get(key) ?? new Set(['default']);
    foreignCache.set(key, new vm.SyntheticModule([...names], function () {}));
  }
  return foreignCache.get(key);
}

const MISSING_RE = /^The requested module '(.+)' does not provide an export named '(.+)'$/;
const MAX_PASSES = 40;
let linkedCount = 0;
let passes = 0;
let stoppedEarly = false;
const syntaxBad = new Set(findings.filter(f => /^syntax error/.test(f.message)).map(f => f.file));

async function linkPass() {
  foreignCache.clear();
  requestLog = [];
  for (const [file, mod] of esm) {
    if (mod.status !== 'unlinked') continue;
    await mod.link(linker);
  }
}

if (!syntaxBad.size) {
  for (passes = 1; passes <= MAX_PASSES; passes++) {
    try { await linkPass(); linkedCount = esm.size; break; } catch (e) {
      const m = MISSING_RE.exec(oneLine(e));
      if (!m) { report('(link)', null, `the modules could not be linked: ${oneLine(e)}`); break; }
      const [, spec, name] = m;
      const word = new RegExp(`\\b${escapeRe(name)}\\b`);
      const clauseRe = new RegExp(`(?:import|export)\\s*[^;'"]*?\\b${escapeRe(name)}\\b[^;'"]*?from\\s*['"]${escapeRe(spec)}['"]`);
      const asked = requestLog.filter(r => r.spec === spec);
      let culprits = asked.filter(r => clauseRe.test(codeLines(text.get(r.importer) ?? '')));
      if (!culprits.length) culprits = asked.filter(r => word.test(text.get(r.importer) ?? ''));
      if (!culprits.length) culprits = asked;
      const fixed = new Set();
      for (const r of culprits) {
        const target = r.key;
        if (r.type === 'package' || (r.type === 'file' && !esm.has(target))) { addForeign(target, [name]); fixed.add(target); continue; }
        if (r.type === 'builtin') {
          report(rel(r.importer), lineOfImport(r.importer, name, spec), `imports { ${name} } from '${spec}', which the running Node does not export`);
          addForeign(target, [name]);
          builtinNames.get(target)?.add(name);
          fixed.add(target);
          continue;
        }
        const here = culprits.length > 1 ? ' (one of the files that import it this way)' : '';
        report(rel(r.importer), lineOfImport(r.importer, name, spec), `imports { ${name} } from '${spec}', but ${rel(target)} has no export named '${name}'${here}`);
        extraSource.set(target, (extraSource.get(target) ?? '') + (name === 'default' ? '\nexport default undefined;\n' : `\nexport var ${name};\n`));
        fixed.add(target);
      }
      // Every module is made again: one that failed to link cannot be linked a second time.
      for (const file of [...esm.keys()]) { try { esm.set(file, mkModule(file)); } catch { esm.delete(file); } }
      if (!fixed.size) { report('(link)', null, `the modules could not be linked: ${oneLine(e)}`); break; }
      if (passes === MAX_PASSES) stoppedEarly = true;
    }
  }
}
function lineOfImport(file, name, spec) {
  const src = text.get(file) ?? '';
  const m = new RegExp(`(?:import|export)\\s*[^;'"]*?\\b${escapeRe(name)}\\b[^;'"]*?from\\s*['"]${escapeRe(spec)}['"]`).exec(src);
  return m ? src.slice(0, m.index).split('\n').length : null;
}

// ---------- the answer ----------
findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0)));
for (const f of findings) console.log(`FAIL ${f.file}${f.line ? ':' + f.line : ''}  ${f.message}`);
const ms = Date.now() - started;
if (stoppedEarly) console.log(`FAIL (link)  stopped after ${MAX_PASSES} passes; more problems may follow once these are fixed`);
if (findings.length || stoppedEarly) {
  console.log(`check: ${findings.length} problem${findings.length === 1 ? '' : 's'} in ${files.length} files (${ms} ms).`);
  process.exit(1);
}
console.log(`check: ok. ${files.length} files parsed, ${linkedCount} ES modules linked. Local ES module and Node builtin exports checked (${ms} ms).`);

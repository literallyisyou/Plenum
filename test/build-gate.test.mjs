import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const check = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'plenum-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function populate(dir) {
  for (const name of ['desktop', 'lib', 'public', 'scripts']) mkdirSync(path.join(dir, name));
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const name of ['server.mjs', 'plenum.mjs', 'lib/task.js']) writeFileSync(path.join(dir, name), 'export {};');
}

function run(dir) {
  const result = spawnSync(process.execPath, [check, '--root', dir], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

test('the build gate fails for empty and incomplete checkouts', t => {
  const dir = fixture(t);
  const empty = run(dir);
  assert.equal(empty.status, 2, empty.output);
  assert.match(empty.output, /cannot read package\.json/);
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const incomplete = run(dir);
  assert.equal(incomplete.status, 1, incomplete.output);
  assert.match(incomplete.output, /FAIL server\.mjs {2}required source file is missing/);
  assert.match(incomplete.output, /FAIL desktop {2}cannot list source directory/);
});

test('a dynamic import in CommonJS must use an exact ESM specifier', t => {
  const dir = fixture(t);
  populate(dir);
  const entry = path.join(dir, 'desktop', 'loader.cjs');
  writeFileSync(entry, "import('../lib/task');");
  const missing = run(dir);
  assert.equal(missing.status, 1, missing.output);
  assert.match(missing.output, /FAIL desktop\/loader\.cjs:1 {2}import\('\.\.\/lib\/task'\) names a file that does not exist/);
  writeFileSync(entry, "import('../lib/task.js?mode=dev#fixture');");
  const exact = run(dir);
  assert.equal(exact.status, 0, exact.output);
});

test('require follows directory entry points and the gate catches unlisted literal packages', t => {
  const dir = fixture(t);
  populate(dir);
  const entry = path.join(dir, 'desktop', 'loader.cjs');
  const folder = path.join(dir, 'desktop', 'folder');
  mkdirSync(folder);
  writeFileSync(path.join(folder, 'package.json'), '{"main":"custom.cjs"}');
  writeFileSync(path.join(folder, 'custom.cjs'), 'module.exports = 1;');
  writeFileSync(entry, "require('./folder');");
  const valid = run(dir);
  assert.equal(valid.status, 0, valid.output);
  writeFileSync(entry, "require('missing-build-gate-package'); import('missing-build-gate-package');");
  const missing = run(dir);
  assert.equal(missing.status, 1, missing.output);
  assert.equal(missing.output.match(/which package\.json does not list/g)?.length, 2, missing.output);
});

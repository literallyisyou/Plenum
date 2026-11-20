import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { clientCount, publish, subscribe } from '../lib/events.mjs';
import { runShell, streamProcess } from '../lib/proc.mjs';

function localNode(t) {
  const originalPath = process.env.PATH;
  process.env.PATH = [dirname(process.execPath), originalPath].filter(Boolean).join(delimiter);
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
  return basename(process.execPath);
}

class Response extends EventEmitter {
  writableLength = 0;
  writes = [];
  destroyed = false;
  writeHead() {}
  write(text) { this.writes.push(text); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

test('a stalled SSE response is destroyed before it accumulates an oversized frame', () => {
  const stalled = new Response();
  const healthy = new Response();
  try {
    subscribe(null, stalled, { type: 'hello' });
    subscribe(null, healthy, { type: 'hello' });
    stalled.writableLength = 7_999_950;
    const event = { type: 'run', text: 'é'.repeat(40) };
    publish(event);
    assert.equal(stalled.destroyed, true);
    assert.equal(stalled.writes.length, 2);
    assert.equal(healthy.destroyed, false);
    assert.match(healthy.writes.at(-1), /é{40}/);
    assert.equal(clientCount(), 1);
  } finally {
    stalled.destroy();
    healthy.destroy();
  }
});

test('the provider stdout pipe applies backpressure and still drains in order', { timeout: 12_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'plenum-pipe-'));
  const marker = join(dir, 'flushed');
  const chunks = 48;
  const chunkSize = 128 * 1024;
  const code = `
    const { writeFileSync, writeSync } = require('node:fs');
    for (let i = 0; i < ${chunks}; ++i) {
      const data = Buffer.alloc(${chunkSize}, 65 + i % 26);
      for (let offset = 0; offset < data.length;) offset += writeSync(1, data, offset, data.length - offset);
    }
    writeSync(1, 'END');
    writeFileSync(${JSON.stringify(marker)}, 'yes');
  `;
  const ac = new AbortController();
  const stream = streamProcess({ command: localNode(t), args: ['-e', code], cwd: dir, signal: ac.signal });
  try {
    const first = await stream.next();
    assert.equal(first.done, false);
    await sleep(550);
    assert.equal(existsSync(marker), false, 'child should block while its output is undrained');
    let output = first.value;
    for await (const text of stream) output += text;
    const expected = Array.from({ length: chunks }, (_, i) => String.fromCharCode(65 + i % 26).repeat(chunkSize)).join('') + 'END';
    assert.equal(output.length, expected.length);
    assert.ok(output === expected, 'provider output should be complete and in order');
    assert.equal(existsSync(marker), true);
  } finally {
    ac.abort();
    await stream.return();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('abort releases a child with a backpressured stdout pipe', { timeout: 12_000 }, async t => {
  const ac = new AbortController();
  const code = 'const chunk = "A".repeat(131072); for (let i = 0; i < 64; i++) process.stdout.write(chunk);';
  const stream = streamProcess({ command: localNode(t), args: ['-e', code], signal: ac.signal });
  try {
    assert.equal((await stream.next()).done, false);
    await sleep(150);
    ac.abort();
    assert.deepEqual(await stream.next(), { done: true, value: undefined });
  } finally {
    ac.abort();
    await stream.return();
  }
});

test('an already cancelled shell returns without preparing a command', async () => {
  const signal = AbortSignal.abort();
  const result = await runShell('unused', {
    signal, shell: { argv: () => assert.fail('cancelled command was prepared') },
  });
  assert.deepEqual(result, { code: null, output: '', timedOut: false, aborted: true, error: undefined, droppedChars: 0 });
});

test('long stderr and throwing observers preserve the diagnostic tail and provider exit', { timeout: 12_000 }, async t => {
  const code = `
    const fs = require('node:fs');
    fs.writeSync(2, 'first ordinary line\\n');
    fs.writeSync(2, 'diagnostic heading:');
    for (let i = 0; i < 32; i++) fs.writeSync(2, 'x'.repeat(65536));
    fs.writeSync(2, ' provider-failure-marker');
    process.exitCode = 17;
  `;
  const lines = [];
  const stream = streamProcess({
    command: localNode(t), args: ['-e', code],
    onStderrLine(line) { lines.push(line); throw new Error('broken observer'); },
  });
  await assert.rejects(stream.next(), error => {
    assert.equal(error.code, 17);
    assert.match(error.raw, /provider-failure-marker/);
    return true;
  });
  assert.equal(lines[0], 'first ordinary line\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].length < 5_100);
  assert.match(lines[1], /^diagnostic heading:[\s\S]*stderr line truncated[\s\S]*provider-failure-marker$/);
});

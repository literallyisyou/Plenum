import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moderatorMessage } from '../lib/council.mjs';

const FABLE = 'anthropic:claude-fable-5-2';
const HAIKU = 'anthropic:claude-haiku-5-5';
const GROK = 'xai:grok-4.7';
const ASTRA = 'codex:gpt-6.2-astra';

function makeSeats({ rounds = 1, sizes = [24_000, 24_000, 24_000, 24_000], character = 'a' } = {}) {
  return sizes.map((size, i) => ({
    id: String.fromCharCode(97 + i),
    label: `Seat ${i + 1}`,
    role: 'architect',
    rounds: Object.fromEntries(Array.from({ length: rounds }, (_, j) => [
      j + 1, { ok: true, text: character.repeat(size) + ` END OF SEAT ${i + 1} ROUND ${j + 1}` },
    ])),
  }));
}

function message(ref, states, options = {}) {
  return moderatorMessage({
    question: 'Keep the question.', history: 'Keep the history.', system: 'Write a verdict.',
    files: { names: [], blocks: [], documents: [] }, pictures: { images: [], note: '' },
    states, rounds: Object.keys(states[0].rounds).length, ref, ...options,
  });
}

test('Fable and Astra see the end of every long answer when they fit, including all three rounds', () => {
  const states = makeSeats({ rounds: 3 });
  for (const ref of [FABLE, ASTRA]) {
    const { prompt, read } = message(ref, states);
    assert.equal(read.length, 12);
    assert.ok(read.every(turn => !turn.cut));
    for (const { rounds } of states) {
      for (const turn of Object.values(rounds)) assert.ok(prompt.includes(turn.text));
    }
    assert.ok(prompt.includes('Keep the question.'));
    assert.ok(prompt.includes('Keep the history.'));
  }
});

test('a moderator with no documented context keeps the previous per-answer ceiling', () => {
  const states = makeSeats();
  const { prompt, read } = message(HAIKU, states);
  assert.deepEqual(read.map(turn => turn.cap), [12_000, 12_000, 12_000, 12_000]);
  assert.ok(read.every(turn => turn.cut));
  assert.equal(prompt.match(/cut at 12000 characters/g)?.length, 4);
  assert.doesNotMatch(prompt, /END OF SEAT/);
});

test('a larger question and attachments shrink the allowance, with short answers giving back unused space', () => {
  const states = makeSeats({ sizes: [1000, 24_000, 24_000, 24_000] });
  const files = { names: ['example.txt'], blocks: ['F'.repeat(315_000)], documents: [] };
  const { prompt, read } = message(GROK, states, { question: 'Q'.repeat(70_000), history: 'H'.repeat(6000), files });
  assert.equal(read[0].cut, false);
  assert.ok(read.slice(1).every(turn => turn.cut && turn.cap > 13_000 && turn.cap < 17_000));
  assert.equal(new Set(read.slice(1).map(turn => turn.cap)).size, 1);
  assert.ok(prompt.includes(files.blocks[0]));
  assert.ok(Buffer.byteLength(prompt) + 64_000 <= 500_000);
  const withNativeDocument = message(GROK, states, { files: { ...files, documents: [{}] } });
  assert.ok(withNativeDocument.read.slice(1).every(turn => turn.cut && turn.cap < 2000));
});

test('large moderator transcripts stay bounded and clipping respects UTF-8 characters', () => {
  const states = makeSeats({ rounds: 3, sizes: [28_000, 28_000, 28_000, 28_000], character: '🌲' });
  for (const { rounds } of states) {
    for (const turn of Object.values(rounds)) {
      turn.text = `${'Tool preamble. '.repeat(3000)}\nPOSITION: The answer\nANSWER:\n${turn.text}`;
    }
  }
  const { read } = message(FABLE, states);
  assert.ok(read.every(turn => turn.cut && !turn.text.includes('Tool preamble')));
  assert.ok(read.every(turn => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(turn.text)));
  assert.ok(read.every(turn => !turn.text.includes('\uFFFD')));
  assert.ok(read.reduce((total, turn) => total + Buffer.byteLength(turn.text), 0) <= 320 * 1024);
});

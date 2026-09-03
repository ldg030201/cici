import { test } from 'node:test';
import assert from 'node:assert/strict';

import { uncompress } from '../src/snappy.js';
import { compress, literal, copy1, copy2, copy4, stream, listOps, varint32 } from './helpers/snappy-compress.js';

/**
 * Deterministic 32-bit PRNG (mulberry32) so failures are reproducible.
 * @param {number} seed
 * @returns {() => number} next uint32
 */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) >>> 0;
  };
}

/**
 * @param {number} length
 * @param {number} seed
 * @returns {Uint8Array}
 */
function randomBytes(length, seed) {
  const next = prng(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = next() & 0xff;
  return out;
}

/** @param {Uint8Array} bytes */
const text = (bytes) => Buffer.from(bytes).toString('utf8');
/** @param {string} s */
const bytes = (s) => new Uint8Array(Buffer.from(s, 'utf8'));

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {string} [message]
 */
function assertBytesEqual(a, b, message) {
  assert.equal(a.length, b.length, message ? `${message} (length)` : 'length');
  assert.ok(Buffer.from(a).equals(Buffer.from(b)), message ?? 'bytes differ');
}

/** @param {() => unknown} fn */
function assertThrowsError(fn, label) {
  assert.throws(
    fn,
    (err) => {
      assert.ok(err instanceof Error, `${label}: thrown value is not an Error`);
      assert.ok(typeof err.message === 'string' && err.message.length > 0, `${label}: empty error message`);
      return true;
    },
    label,
  );
}

test('helper sanity: varint32 and listOps agree with the format', () => {
  assert.deepEqual([...varint32(0)], [0x00]);
  assert.deepEqual([...varint32(127)], [0x7f]);
  assert.deepEqual([...varint32(300)], [0xac, 0x02]);
  assert.deepEqual([...varint32(0xffffffff)], [0xff, 0xff, 0xff, 0xff, 0x0f]);
  const s = stream(12, literal('abcd'), copy1(4, 4), copy2(2, 8), copy4(2, 2));
  const { uncompressedLength, ops } = listOps(s);
  assert.equal(uncompressedLength, 12);
  assert.deepEqual(ops, [
    { op: 'literal', length: 4 },
    { op: 'copy1', length: 4, offset: 4 },
    { op: 'copy2', length: 2, offset: 8 },
    { op: 'copy4', length: 2, offset: 2 },
  ]);
});

test('empty input: a bare zero-length preamble decodes to zero bytes', () => {
  assertBytesEqual(uncompress(Uint8Array.of(0x00)), new Uint8Array(0), 'hand-crafted');
  const compressed = compress(new Uint8Array(0));
  assert.deepEqual([...compressed], [0x00]);
  assertBytesEqual(uncompress(compressed), new Uint8Array(0), 'compress(empty)');
});

test('all-literal stream', () => {
  assert.equal(text(uncompress(stream(5, literal('hello')))), 'hello');
  assert.equal(text(uncompress(stream(11, literal('hello'), literal(' '), literal('world')))), 'hello world');
  // one byte literal: tag 0x00
  assert.deepEqual([...uncompress(stream(1, [0x00, 0x41]))], [0x41]);
  // 60 bytes is the largest inline literal length (tag upper bits = 59)
  const sixty = randomBytes(60, 1);
  const s = stream(60, literal(sixty));
  assert.equal(s[1] >>> 2, 59);
  assertBytesEqual(uncompress(s), sixty);
});

test('long literals use the 1/2/3-byte extended length encoding', () => {
  const cases = [
    { length: 61, tagUpper: 60, extraBytes: 1 },
    { length: 256, tagUpper: 60, extraBytes: 1 },
    { length: 257, tagUpper: 61, extraBytes: 2 },
    { length: 300, tagUpper: 61, extraBytes: 2 },
    { length: 65536, tagUpper: 61, extraBytes: 2 },
    { length: 65537, tagUpper: 62, extraBytes: 3 },
    { length: 70000, tagUpper: 62, extraBytes: 3 },
  ];
  for (const { length, tagUpper, extraBytes } of cases) {
    const data = randomBytes(length, length);
    const lit = literal(data);
    assert.equal(lit[0] & 3, 0, `literal tag kind for ${length}`);
    assert.equal(lit[0] >>> 2, tagUpper, `literal tag upper bits for ${length}`);
    assert.equal(lit.length, 1 + extraBytes + length, `literal encoded size for ${length}`);
    assertBytesEqual(uncompress(stream(length, lit)), data, `literal length ${length}`);
    // The compressor emits mostly literals for random input (a rare accidental
    // 4-byte repeat may add a copy), so its first element must be a long literal.
    const compressed = compress(data);
    const ops = listOps(compressed).ops;
    assert.equal(ops[0].op, 'literal', `compress() of ${length} random bytes should start with a literal`);
    assert.ok(ops[0].length > 60, `compress() of ${length} random bytes should use an extended literal length`);
    assertBytesEqual(uncompress(compressed), data, `compress roundtrip ${length}`);
  }
});

test('copy with 1-byte offset (tag & 3 == 1)', () => {
  assert.equal(text(uncompress(stream(8, literal('abcd'), copy1(4, 4)))), 'abcdabcd');
  // maximum length 11 and maximum offset 2047 (upper 3 bits of the tag hold offset bits 8..10)
  const head = randomBytes(2047, 7);
  const out = uncompress(stream(2047 + 11, literal(head), copy1(11, 2047)));
  assertBytesEqual(out.subarray(0, 2047), head);
  assertBytesEqual(out.subarray(2047), head.subarray(0, 11));
  // offset that needs the high bits: 0x123 = 291
  const head2 = randomBytes(300, 8);
  const out2 = uncompress(stream(300 + 5, literal(head2), copy1(5, 291)));
  assertBytesEqual(out2.subarray(300), head2.subarray(300 - 291, 300 - 291 + 5));
});

test('copy with 2-byte offset (tag & 3 == 2)', () => {
  assert.equal(text(uncompress(stream(7, literal('abcd'), copy2(3, 4)))), 'abcdabc');
  // length 1 and length 64 are both legal for copy2
  assert.equal(text(uncompress(stream(5, literal('abcd'), copy2(1, 1)))), 'abcdd');
  const head = randomBytes(65535, 9);
  const out = uncompress(stream(65535 + 64, literal(head), copy2(64, 65535)));
  assertBytesEqual(out.subarray(65535), head.subarray(0, 64));
});

test('copy with 4-byte offset (tag & 3 == 3)', () => {
  assert.equal(text(uncompress(stream(6, literal('xyz'), copy4(3, 3)))), 'xyzxyz');
  const head = randomBytes(70000, 10);
  const out = uncompress(stream(70000 + 64, literal(head), copy4(64, 70000)));
  assertBytesEqual(out.subarray(70000), head.subarray(0, 64));
  // small offset is still legal with a 4-byte encoding
  assert.equal(text(uncompress(stream(9, literal('abcd'), copy4(5, 2)))), 'abcdcdcdc');
});

test('overlapping copies (offset < length) produce runs', () => {
  assert.equal(text(uncompress(stream(11, literal('a'), copy2(10, 1)))), 'a'.repeat(11));
  assert.equal(text(uncompress(stream(9, literal('ab'), copy1(7, 2)))), 'ababababa');
  assert.equal(text(uncompress(stream(3 + 64, literal('xyz'), copy4(64, 3)))), 'xyz'.repeat(23).slice(0, 67));
  // several chained overlapping copies
  const out = uncompress(stream(1 + 4 + 8 + 64, literal('q'), copy1(4, 1), copy2(8, 5), copy4(64, 13)));
  assert.equal(text(out), 'q'.repeat(77));
});

test('roundtrip: random data (seeded)', () => {
  for (const [length, seed] of [
    [1, 11],
    [2, 12],
    [3, 13],
    [4, 14],
    [100, 15],
    [4096, 16],
    [100000, 17],
  ]) {
    const data = randomBytes(length, seed);
    const compressed = compress(data);
    assert.equal(listOps(compressed).uncompressedLength, length);
    assertBytesEqual(uncompress(compressed), data, `random ${length}`);
  }
});

test('roundtrip: highly repetitive data exercises every copy element type', () => {
  const inputs = [
    bytes('bridgeDeviceId'.repeat(2000)),
    bytes('a'.repeat(5000)),
    bytes('ab'.repeat(3000)),
    bytes('abcdefgh__abcdefgh'),
    bytes(JSON.stringify(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`key-${i}`, `value-${i % 7}`])))),
  ];
  // a 70000-byte chunk repeated three times: matches at offset 70000 need copy4
  const chunk = randomBytes(70000, 18);
  const tripled = new Uint8Array(chunk.length * 3);
  tripled.set(chunk, 0);
  tripled.set(chunk, chunk.length);
  tripled.set(chunk, chunk.length * 2);
  inputs.push(tripled);

  const seen = new Set();
  for (const data of inputs) {
    const compressed = compress(data);
    assert.ok(compressed.length < data.length, `repetitive input of ${data.length} bytes should shrink`);
    const { ops } = listOps(compressed);
    for (const op of ops) seen.add(op.op);
    assert.ok(ops.some((o) => o.op !== 'literal'), 'compressor must emit at least one copy for repetitive data');
    assertBytesEqual(uncompress(compressed), data, `repetitive ${data.length}`);
  }
  assert.ok(seen.has('copy1'), 'corpus should exercise copy1');
  assert.ok(seen.has('copy2'), 'corpus should exercise copy2');
  assert.ok(seen.has('copy4'), 'corpus should exercise copy4');
});

test('roundtrip: mixed literal and copy elements', () => {
  const next = prng(19);
  const words = ['bridgeDeviceId', 'bridgeDisplayName', 'deadbeef', '"', ':', ',', ' ', '\n'];
  const parts = [];
  for (let i = 0; i < 3000; i++) {
    parts.push(words[next() % words.length]);
    if (next() % 5 === 0) parts.push(String.fromCharCode(0x20 + (next() % 90)));
  }
  const data = bytes(parts.join(''));
  const compressed = compress(data);
  const kinds = new Set(listOps(compressed).ops.map((o) => o.op));
  assert.ok(kinds.has('literal') && kinds.size >= 2, 'expected a mix of literals and copies');
  assertBytesEqual(uncompress(compressed), data);
});

test('malformed: copy with offset 0 throws', () => {
  assertThrowsError(() => uncompress(stream(8, literal('abcd'), copy1(4, 0))), 'copy1 offset 0');
  assertThrowsError(() => uncompress(stream(8, literal('abcd'), copy2(4, 0))), 'copy2 offset 0');
  assertThrowsError(() => uncompress(stream(8, literal('abcd'), copy4(4, 0))), 'copy4 offset 0');
});

test('malformed: copy offset beyond produced output throws', () => {
  assertThrowsError(() => uncompress(stream(8, literal('abcd'), copy1(4, 5))), 'copy1 offset 5 > 4 produced');
  assertThrowsError(() => uncompress(stream(8, literal('abcd'), copy2(4, 1000))), 'copy2 offset 1000');
  assertThrowsError(() => uncompress(stream(8, literal('abcd'), copy4(4, 0x7fffffff))), 'copy4 huge offset');
  // a copy as the very first element has nothing to copy from
  assertThrowsError(() => uncompress(stream(4, copy2(4, 1))), 'copy before any output');
});

test('malformed: truncated streams throw', () => {
  // literal tag promises 10 bytes but only 3 follow
  assertThrowsError(() => uncompress(stream(10, [9 << 2, 0x61, 0x62, 0x63])), 'truncated literal body');
  // extended literal length missing its length bytes
  assertThrowsError(() => uncompress(stream(100, [60 << 2])), 'truncated literal length');
  // copy tags missing their offset bytes
  assertThrowsError(() => uncompress(stream(8, literal('abcd'), [copy1(4, 4)[0]])), 'truncated copy1');
  assertThrowsError(() => uncompress(stream(8, literal('abcd'), [copy2(4, 4)[0], 0x04])), 'truncated copy2');
  assertThrowsError(() => uncompress(stream(8, literal('abcd'), [copy4(4, 4)[0], 0x04, 0x00])), 'truncated copy4');
  // preamble problems
  assertThrowsError(() => uncompress(new Uint8Array(0)), 'empty buffer has no preamble');
  assertThrowsError(() => uncompress(Uint8Array.of(0x80)), 'unterminated preamble varint');
  // stream ends right after the preamble although it promised bytes
  assertThrowsError(() => uncompress(Uint8Array.of(0x05)), 'preamble promises 5 bytes, no elements');
});

test('malformed: output length mismatch throws', () => {
  assertThrowsError(() => uncompress(stream(5, literal('abc'))), 'declared 5, produced 3');
  assertThrowsError(() => uncompress(stream(2, literal('abc'))), 'declared 2, produced 3');
  assertThrowsError(() => uncompress(stream(0, literal('a'))), 'declared 0, produced 1');
  assertThrowsError(() => uncompress(stream(6, literal('abcd'), copy1(4, 4))), 'copy overruns declared length');
});

test('uncompress returns a Uint8Array that does not alias the input', () => {
  const s = stream(4, literal('abcd'));
  const out = uncompress(s);
  assert.ok(out instanceof Uint8Array);
  s.fill(0);
  assert.equal(text(out), 'abcd');
});

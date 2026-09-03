// Independent raw-snappy *compressor* used only by the test-suite.
//
// src/snappy.js only decompresses. To test it (and the LevelDB reader that
// depends on it) we need the other direction, written from the format
// description rather than from the decoder, so that a shared misreading of
// the spec cannot make both sides agree on wrong bytes.
//
// Raw snappy block format (not the framing format):
//   varint32 uncompressed length, then tagged elements:
//     tag & 3 == 0  literal   upper 6 bits: 0..59 -> length-1 inline,
//                             60/61/62/63 -> length-1 follows in 1/2/3/4 LE bytes
//     tag & 3 == 1  copy1     len = ((tag >> 2) & 7) + 4 (4..11),
//                             offset = ((tag >> 5) << 8) | next byte (0..2047)
//     tag & 3 == 2  copy2     len = (tag >> 2) + 1 (1..64), offset = next 2 bytes LE
//     tag & 3 == 3  copy4     len = (tag >> 2) + 1 (1..64), offset = next 4 bytes LE

const HASH_BITS = 16;
const HASH_SIZE = 1 << HASH_BITS;
const MAX_COPY1_LEN = 11;
const MIN_COPY1_LEN = 4;
const MAX_COPY1_OFFSET = 2047;
const MAX_COPY_LEN = 64;
const MAX_COPY2_OFFSET = 0xffff;

/**
 * Growable byte sink; avoids building huge JS arrays for big inputs.
 */
class ByteSink {
  /** @param {number} [initial] */
  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
    this.length = 0;
  }

  /** @param {number} extra */
  ensure(extra) {
    const need = this.length + extra;
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  /** @param {number} byte */
  push(byte) {
    this.ensure(1);
    this.buf[this.length++] = byte & 0xff;
  }

  /**
   * @param {Uint8Array} bytes
   * @param {number} [start]
   * @param {number} [end]
   */
  append(bytes, start = 0, end = bytes.length) {
    const len = end - start;
    if (len <= 0) return;
    this.ensure(len);
    this.buf.set(bytes.subarray(start, end), this.length);
    this.length += len;
  }

  /** @returns {Uint8Array} */
  finish() {
    return this.buf.slice(0, this.length);
  }
}

/**
 * @param {Uint8Array|string|number[]} x
 * @returns {Uint8Array}
 */
function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (typeof x === 'string') return new TextEncoder().encode(x);
  if (Array.isArray(x)) return Uint8Array.from(x);
  throw new TypeError('expected Uint8Array, string or number[]');
}

/**
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/**
 * @param {ByteSink} sink
 * @param {number} value
 */
function pushVarint32(sink, value) {
  let v = value >>> 0;
  while (v >= 0x80) {
    sink.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  sink.push(v);
}

/**
 * Encode an unsigned 32-bit varint (LEB128).
 * @param {number} value
 * @returns {Uint8Array}
 */
export function varint32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`varint32 out of range: ${value}`);
  }
  const sink = new ByteSink(8);
  pushVarint32(sink, value);
  return sink.finish();
}

/**
 * @param {ByteSink} sink
 * @param {Uint8Array} src
 * @param {number} start
 * @param {number} end
 */
function emitLiteral(sink, src, start, end) {
  const n = end - start;
  if (n <= 0) return;
  const m = n - 1;
  if (m < 60) {
    sink.push(m << 2);
  } else if (m < 0x100) {
    sink.push(60 << 2);
    sink.push(m);
  } else if (m < 0x10000) {
    sink.push(61 << 2);
    sink.push(m & 0xff);
    sink.push(m >>> 8);
  } else if (m < 0x1000000) {
    sink.push(62 << 2);
    sink.push(m & 0xff);
    sink.push((m >>> 8) & 0xff);
    sink.push(m >>> 16);
  } else {
    sink.push(63 << 2);
    sink.push(m & 0xff);
    sink.push((m >>> 8) & 0xff);
    sink.push((m >>> 16) & 0xff);
    sink.push(m >>> 24);
  }
  sink.append(src, start, end);
}

/**
 * @param {ByteSink} sink
 * @param {number} len 4..11
 * @param {number} offset 0..2047
 */
function emitCopy1(sink, len, offset) {
  sink.push(1 | ((len - 4) << 2) | ((offset >>> 8) << 5));
  sink.push(offset & 0xff);
}

/**
 * @param {ByteSink} sink
 * @param {number} len 1..64
 * @param {number} offset 0..65535
 */
function emitCopy2(sink, len, offset) {
  sink.push(2 | ((len - 1) << 2));
  sink.push(offset & 0xff);
  sink.push(offset >>> 8);
}

/**
 * @param {ByteSink} sink
 * @param {number} len 1..64
 * @param {number} offset 0..2^32-1
 */
function emitCopy4(sink, len, offset) {
  sink.push(3 | ((len - 1) << 2));
  sink.push(offset & 0xff);
  sink.push((offset >>> 8) & 0xff);
  sink.push((offset >>> 16) & 0xff);
  sink.push(offset >>> 24);
}

/**
 * Emit a (possibly long) back-reference as a sequence of copy elements,
 * picking the shortest encoding available for each chunk.
 * @param {ByteSink} sink
 * @param {number} offset
 * @param {number} len
 */
function emitCopy(sink, offset, len) {
  let remaining = len;
  while (remaining > 0) {
    if (offset > MAX_COPY2_OFFSET) {
      const l = Math.min(remaining, MAX_COPY_LEN);
      emitCopy4(sink, l, offset);
      remaining -= l;
    } else if (remaining >= MIN_COPY1_LEN && remaining <= MAX_COPY1_LEN && offset <= MAX_COPY1_OFFSET) {
      emitCopy1(sink, remaining, offset);
      remaining = 0;
    } else if (remaining <= MAX_COPY_LEN) {
      emitCopy2(sink, remaining, offset);
      remaining = 0;
    } else {
      emitCopy2(sink, MAX_COPY_LEN, offset);
      remaining -= MAX_COPY_LEN;
    }
  }
}

/**
 * @param {Uint8Array} src
 * @param {number} i  position with at least 4 bytes available
 */
function hashAt(src, i) {
  const v = (src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)) >>> 0;
  return Math.imul(v, 0x1e35a7bd) >>> (32 - HASH_BITS);
}

/**
 * Compress `input` into a valid raw snappy stream.
 *
 * A simple greedy LZ77 matcher: a hash table over 4-byte windows finds an
 * earlier occurrence, the match is extended as far as it goes and emitted
 * as copy elements; everything else becomes literals. Not tuned for ratio
 * or speed, only for producing every element type a decoder must handle.
 *
 * @param {Uint8Array|string|number[]} input
 * @returns {Uint8Array}
 */
export function compress(input) {
  const src = toBytes(input);
  const n = src.length;
  const sink = new ByteSink(Math.max(16, (n >>> 1) + 16));
  pushVarint32(sink, n);
  if (n === 0) return sink.finish();

  // table[h] = position + 1 of the most recent 4-byte window with hash h (0 = empty)
  const table = new Int32Array(HASH_SIZE);
  let litStart = 0;
  let i = 0;
  while (i + 4 <= n) {
    const h = hashAt(src, i);
    const cand = table[h] - 1;
    table[h] = i + 1;
    if (
      cand >= 0 &&
      src[cand] === src[i] &&
      src[cand + 1] === src[i + 1] &&
      src[cand + 2] === src[i + 2] &&
      src[cand + 3] === src[i + 3]
    ) {
      emitLiteral(sink, src, litStart, i);
      let len = 4;
      while (i + len < n && src[cand + len] === src[i + len]) len++;
      emitCopy(sink, i - cand, len);
      i += len;
      litStart = i;
      if (i - 1 + 4 <= n) table[hashAt(src, i - 1)] = i; // remember the window ending at the match
    } else {
      i++;
    }
  }
  emitLiteral(sink, src, litStart, n);
  return sink.finish();
}

// ---------------------------------------------------------------------------
// Builders for hand-crafted streams.

/**
 * A literal element carrying `bytes` (uses the extended length encoding
 * automatically for lengths above 60).
 * @param {Uint8Array|string|number[]} bytes
 * @returns {Uint8Array}
 */
export function literal(bytes) {
  const data = toBytes(bytes);
  if (data.length === 0) throw new RangeError('a literal element cannot be empty');
  const sink = new ByteSink(data.length + 5);
  emitLiteral(sink, data, 0, data.length);
  return sink.finish();
}

/**
 * Copy with 1-byte offset. `offset` 0 is encodable (so tests can craft
 * malformed streams) but invalid for decoders.
 * @param {number} len 4..11
 * @param {number} offset 0..2047
 * @returns {Uint8Array}
 */
export function copy1(len, offset) {
  if (len < MIN_COPY1_LEN || len > MAX_COPY1_LEN) throw new RangeError(`copy1 length must be 4..11, got ${len}`);
  if (offset < 0 || offset > MAX_COPY1_OFFSET) throw new RangeError(`copy1 offset must be 0..2047, got ${offset}`);
  const sink = new ByteSink(2);
  emitCopy1(sink, len, offset);
  return sink.finish();
}

/**
 * Copy with 2-byte little-endian offset.
 * @param {number} len 1..64
 * @param {number} offset 0..65535
 * @returns {Uint8Array}
 */
export function copy2(len, offset) {
  if (len < 1 || len > MAX_COPY_LEN) throw new RangeError(`copy2 length must be 1..64, got ${len}`);
  if (offset < 0 || offset > MAX_COPY2_OFFSET) throw new RangeError(`copy2 offset must be 0..65535, got ${offset}`);
  const sink = new ByteSink(3);
  emitCopy2(sink, len, offset);
  return sink.finish();
}

/**
 * Copy with 4-byte little-endian offset.
 * @param {number} len 1..64
 * @param {number} offset 0..2^32-1
 * @returns {Uint8Array}
 */
export function copy4(len, offset) {
  if (len < 1 || len > MAX_COPY_LEN) throw new RangeError(`copy4 length must be 1..64, got ${len}`);
  if (offset < 0 || offset > 0xffffffff) throw new RangeError(`copy4 offset must be 0..2^32-1, got ${offset}`);
  const sink = new ByteSink(5);
  emitCopy4(sink, len, offset);
  return sink.finish();
}

/**
 * Assemble a full stream: varint32 preamble followed by the given parts.
 * The preamble is *not* checked against the parts so tests can lie.
 * @param {number} uncompressedLength
 * @param {...(Uint8Array|string|number[])} parts
 * @returns {Uint8Array}
 */
export function stream(uncompressedLength, ...parts) {
  return concat([varint32(uncompressedLength), ...parts.map(toBytes)]);
}

/**
 * Walk the element structure of a compressed stream without decoding it.
 * Used by tests to check that the compressor actually produced the element
 * types they wanted to exercise. Throws on a structurally truncated stream.
 *
 * @param {Uint8Array} compressed
 * @returns {{ uncompressedLength: number, ops: Array<{ op: 'literal'|'copy1'|'copy2'|'copy4', length: number, offset?: number }> }}
 */
export function listOps(compressed) {
  let pos = 0;
  let shift = 0;
  let uncompressedLength = 0;
  for (;;) {
    if (pos >= compressed.length) throw new Error('truncated preamble');
    const b = compressed[pos++];
    uncompressedLength |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new Error('preamble varint too long');
  }
  uncompressedLength >>>= 0;
  /** @type {Array<{ op: 'literal'|'copy1'|'copy2'|'copy4', length: number, offset?: number }>} */
  const ops = [];
  while (pos < compressed.length) {
    const tag = compressed[pos++];
    const kind = tag & 3;
    if (kind === 0) {
      let len = tag >>> 2;
      if (len >= 60) {
        const extra = len - 59;
        if (pos + extra > compressed.length) throw new Error('truncated literal length');
        len = 0;
        for (let k = 0; k < extra; k++) len |= compressed[pos + k] << (8 * k);
        len >>>= 0;
        pos += extra;
      }
      len += 1;
      if (pos + len > compressed.length) throw new Error('truncated literal');
      ops.push({ op: 'literal', length: len });
      pos += len;
    } else if (kind === 1) {
      if (pos + 1 > compressed.length) throw new Error('truncated copy1');
      ops.push({ op: 'copy1', length: ((tag >>> 2) & 7) + 4, offset: ((tag >>> 5) << 8) | compressed[pos] });
      pos += 1;
    } else if (kind === 2) {
      if (pos + 2 > compressed.length) throw new Error('truncated copy2');
      ops.push({ op: 'copy2', length: (tag >>> 2) + 1, offset: compressed[pos] | (compressed[pos + 1] << 8) });
      pos += 2;
    } else {
      if (pos + 4 > compressed.length) throw new Error('truncated copy4');
      const offset =
        (compressed[pos] | (compressed[pos + 1] << 8) | (compressed[pos + 2] << 16) | (compressed[pos + 3] << 24)) >>> 0;
      ops.push({ op: 'copy4', length: (tag >>> 2) + 1, offset });
      pos += 4;
    }
  }
  return { uncompressedLength, ops };
}

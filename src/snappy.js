/**
 * Minimal decoder for the raw snappy block format (the format LevelDB uses
 * for compressed SSTable blocks). This is NOT the snappy *framing* format.
 *
 * Layout: a varint32 with the uncompressed length, followed by a sequence of
 * tagged elements:
 *   tag & 3 === 0  literal      length = (tag >> 2) + 1 when < 60, otherwise
 *                               the next (tag >> 2) - 59 bytes (1..4, little
 *                               endian) hold length - 1
 *   tag & 3 === 1  copy, 1-byte offset   len = ((tag >> 2) & 7) + 4,
 *                               offset = ((tag >> 5) << 8) | next byte
 *   tag & 3 === 2  copy, 2-byte offset   len = (tag >> 2) + 1, offset = u16 LE
 *   tag & 3 === 3  copy, 4-byte offset   len = (tag >> 2) + 1, offset = u32 LE
 * Copies may overlap their own output (offset < len), which is how snappy
 * encodes runs, so overlapping copies are done byte by byte.
 *
 * @module snappy
 */

/**
 * Decompress a raw snappy block.
 *
 * @param {Uint8Array} input compressed bytes (a Buffer is fine too)
 * @returns {Uint8Array} the uncompressed bytes
 * @throws {Error} on malformed input (bad preamble, truncated element,
 *   zero offset, offset before the start of the output, output overflow,
 *   or a final length that does not match the preamble)
 */
export function uncompress(input) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('snappy.uncompress: input must be a Uint8Array');
  }
  const n = input.length;
  let pos = 0;

  // --- preamble: varint32 uncompressed length -------------------------------
  let expected = 0;
  let shift = 0;
  for (;;) {
    if (pos >= n) throw new Error('snappy: truncated length preamble');
    const b = input[pos++];
    if (shift === 28 && (b & 0x70) !== 0) {
      throw new Error('snappy: uncompressed length preamble overflows 32 bits');
    }
    expected = (expected | ((b & 0x7f) << shift)) >>> 0;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new Error('snappy: malformed length preamble');
  }

  const out = new Uint8Array(expected);
  let outPos = 0;

  // --- elements --------------------------------------------------------------
  while (pos < n) {
    const tag = input[pos++];
    const kind = tag & 3;

    if (kind === 0) {
      // literal
      let len = tag >>> 2;
      if (len < 60) {
        len += 1;
      } else {
        const extra = len - 59; // 1..4 bytes of (length - 1)
        if (pos + extra > n) throw new Error('snappy: truncated literal length');
        let v = 0;
        for (let i = 0; i < extra; i++) v |= input[pos + i] << (8 * i);
        pos += extra;
        len = (v >>> 0) + 1;
      }
      if (pos + len > n) throw new Error('snappy: truncated literal data');
      if (outPos + len > expected) throw new Error('snappy: literal overflows declared output length');
      out.set(input.subarray(pos, pos + len), outPos);
      pos += len;
      outPos += len;
      continue;
    }

    // copy
    let len;
    let offset;
    if (kind === 1) {
      if (pos + 1 > n) throw new Error('snappy: truncated 1-byte copy offset');
      len = ((tag >>> 2) & 7) + 4;
      offset = ((tag >>> 5) << 8) | input[pos];
      pos += 1;
    } else if (kind === 2) {
      if (pos + 2 > n) throw new Error('snappy: truncated 2-byte copy offset');
      len = (tag >>> 2) + 1;
      offset = input[pos] | (input[pos + 1] << 8);
      pos += 2;
    } else {
      if (pos + 4 > n) throw new Error('snappy: truncated 4-byte copy offset');
      len = (tag >>> 2) + 1;
      offset = (input[pos] | (input[pos + 1] << 8) | (input[pos + 2] << 16) | (input[pos + 3] << 24)) >>> 0;
      pos += 4;
    }

    if (offset === 0) throw new Error('snappy: copy with zero offset');
    if (offset > outPos) {
      throw new Error(`snappy: copy offset ${offset} reaches before the start of the output (produced ${outPos})`);
    }
    if (outPos + len > expected) throw new Error('snappy: copy overflows declared output length');

    const src = outPos - offset;
    if (offset >= len) {
      // non-overlapping: bulk copy is safe
      out.copyWithin(outPos, src, src + len);
    } else {
      // overlapping run: must go byte by byte so earlier output feeds later bytes
      for (let i = 0; i < len; i++) out[outPos + i] = out[src + i];
    }
    outPos += len;
  }

  if (outPos !== expected) {
    throw new Error(`snappy: output length mismatch (expected ${expected}, produced ${outPos})`);
  }
  return out;
}

// Independent LevelDB *writer* used only by the test-suite.
//
// src/leveldb.js reads Chrome's "Local Extension Settings" databases. To test
// it we need to produce .ldb / .log / MANIFEST files ourselves, from the
// on-disk format description (LevelDB's table_format.md, log_format.md,
// version_edit.cc), not from the reader, so that the two implementations
// are genuinely independent.
//
// Everything here is synchronous "build a Buffer" code plus thin async
// wrappers that write the Buffer to disk.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { compress as snappyCompress } from './snappy-compress.js';

export const WAL_BLOCK_SIZE = 32768;
export const WAL_HEADER_SIZE = 7;
export const FOOTER_SIZE = 48;
/** 0xdb4775248b80fb57 little-endian */
export const TABLE_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);
export const MAX_SEQUENCE = (1n << 56n) - 1n;
export const TYPE_DELETION = 0;
export const TYPE_VALUE = 1;
export const BLOCK_NONE = 0;
export const BLOCK_SNAPPY = 1;
export const BLOCK_ZSTD = 2;
export const RECORD_FULL = 1;
export const RECORD_FIRST = 2;
export const RECORD_MIDDLE = 3;
export const RECORD_LAST = 4;
export const DEFAULT_COMPARATOR = 'leveldb.BytewiseComparator';

// ---------------------------------------------------------------------------
// CRC32C (Castagnoli) + LevelDB's masking, as used in block trailers and
// log record headers.

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * crc32c(data) or, with `crc` given, crc32c::Extend(crc, data).
 * @param {Uint8Array} data
 * @param {number} [crc]
 * @returns {number}
 */
export function crc32c(data, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC32C_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CRC_MASK_DELTA = 0xa282ead8;

/** @param {number} crc */
export function maskCrc(crc) {
  return ((((crc >>> 15) | (crc << 17)) >>> 0) + CRC_MASK_DELTA) >>> 0;
}

/** @param {number} masked */
export function unmaskCrc(masked) {
  const rot = (masked - CRC_MASK_DELTA) >>> 0;
  return ((rot >>> 17) | (rot << 15)) >>> 0;
}

// ---------------------------------------------------------------------------
// Small encoders.

/**
 * @param {string|Uint8Array} x
 * @returns {Buffer}
 */
export function toBuffer(x) {
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof Uint8Array) return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  if (typeof x === 'string') return Buffer.from(x, 'utf8');
  throw new TypeError('expected string, Buffer or Uint8Array');
}

class ByteWriter {
  constructor() {
    /** @type {Buffer[]} */
    this.chunks = [];
    this.length = 0;
  }

  /** @param {Uint8Array} bytes */
  putBytes(bytes) {
    const b = toBuffer(bytes);
    this.chunks.push(b);
    this.length += b.length;
  }

  /** @param {number} byte */
  putByte(byte) {
    this.putBytes(Buffer.from([byte & 0xff]));
  }

  /** @param {number} value */
  putVarint32(value) {
    this.putBytes(encodeVarint32(value));
  }

  /** @param {bigint|number} value */
  putVarint64(value) {
    this.putBytes(encodeVarint64(value));
  }

  /** @param {number} value */
  putFixed32(value) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value >>> 0, 0);
    this.putBytes(b);
  }

  /** @param {bigint|number} value */
  putFixed64(value) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(value), 0);
    this.putBytes(b);
  }

  /** @param {string|Uint8Array} bytes */
  putLengthPrefixed(bytes) {
    const b = toBuffer(bytes);
    this.putVarint32(b.length);
    this.putBytes(b);
  }

  /** @returns {Buffer} */
  toBuffer() {
    return Buffer.concat(this.chunks, this.length);
  }
}

/**
 * @param {number} value
 * @returns {Buffer}
 */
export function encodeVarint32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`varint32 out of range: ${value}`);
  const out = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

/**
 * @param {bigint|number} value
 * @returns {Buffer}
 */
export function encodeVarint64(value) {
  let v = BigInt(value);
  if (v < 0n || v > 0xffffffffffffffffn) throw new RangeError(`varint64 out of range: ${value}`);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

/**
 * user_key + 8 bytes little-endian (sequence << 8 | type).
 * @param {string|Uint8Array} userKey
 * @param {bigint|number} sequence
 * @param {number} type 0 deletion, 1 value
 * @returns {Buffer}
 */
export function encodeInternalKey(userKey, sequence, type) {
  const seq = BigInt(sequence);
  if (seq < 0n || seq > MAX_SEQUENCE) throw new RangeError(`sequence out of range: ${sequence}`);
  if (type !== TYPE_DELETION && type !== TYPE_VALUE) throw new RangeError(`bad value type: ${type}`);
  const key = toBuffer(userKey);
  const out = Buffer.alloc(key.length + 8);
  key.copy(out, 0);
  out.writeBigUInt64LE((seq << 8n) | BigInt(type), key.length);
  return out;
}

/**
 * @param {Buffer} internalKey
 * @returns {{ userKey: Buffer, sequence: bigint, type: number }}
 */
export function splitInternalKey(internalKey) {
  if (internalKey.length < 8) throw new RangeError('internal key shorter than 8 bytes');
  const tail = internalKey.readBigUInt64LE(internalKey.length - 8);
  return { userKey: internalKey.subarray(0, internalKey.length - 8), sequence: tail >> 8n, type: Number(tail & 0xffn) };
}

/**
 * InternalKeyComparator: user key ascending, then (sequence, type) descending.
 * @param {Buffer} a
 * @param {Buffer} b
 */
export function compareInternalKeys(a, b) {
  const ka = splitInternalKey(a);
  const kb = splitInternalKey(b);
  const c = Buffer.compare(ka.userKey, kb.userKey);
  if (c !== 0) return c;
  const ta = a.readBigUInt64LE(a.length - 8);
  const tb = b.readBigUInt64LE(b.length - 8);
  if (ta > tb) return -1;
  if (ta < tb) return 1;
  return 0;
}

/**
 * @param {Buffer} a
 * @param {Buffer} b
 */
function commonPrefixLength(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** PackSequenceAndType(kMaxSequenceNumber, kValueTypeForSeek) */
const MAX_SEQ_TRAILER = (() => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE((MAX_SEQUENCE << 8n) | 1n, 0);
  return b;
})();

/**
 * BytewiseComparator::FindShortestSeparator on user keys.
 * @param {Buffer} start
 * @param {Buffer} limit
 * @returns {Buffer}
 */
function bytewiseShortestSeparator(start, limit) {
  const minLength = Math.min(start.length, limit.length);
  let diff = 0;
  while (diff < minLength && start[diff] === limit[diff]) diff++;
  if (diff >= minLength) return start; // one is a prefix of the other
  const diffByte = start[diff];
  if (diffByte < 0xff && diffByte + 1 < limit[diff]) {
    const out = Buffer.from(start.subarray(0, diff + 1));
    out[diff] = diffByte + 1;
    return out;
  }
  return start;
}

/**
 * BytewiseComparator::FindShortSuccessor on user keys.
 * @param {Buffer} key
 * @returns {Buffer}
 */
function bytewiseShortSuccessor(key) {
  for (let i = 0; i < key.length; i++) {
    if (key[i] !== 0xff) {
      const out = Buffer.from(key.subarray(0, i + 1));
      out[i] = key[i] + 1;
      return out;
    }
  }
  return key;
}

/**
 * InternalKeyComparator::FindShortestSeparator.
 * @param {Buffer} start internal key
 * @param {Buffer} limit internal key
 * @returns {Buffer}
 */
export function shortestSeparator(start, limit) {
  const userStart = splitInternalKey(start).userKey;
  const userLimit = splitInternalKey(limit).userKey;
  const tmp = bytewiseShortestSeparator(userStart, userLimit);
  if (tmp.length < userStart.length && Buffer.compare(userStart, tmp) < 0) {
    return Buffer.concat([tmp, MAX_SEQ_TRAILER]);
  }
  return start;
}

/**
 * InternalKeyComparator::FindShortSuccessor.
 * @param {Buffer} key internal key
 * @returns {Buffer}
 */
export function shortSuccessor(key) {
  const userKey = splitInternalKey(key).userKey;
  const tmp = bytewiseShortSuccessor(userKey);
  if (tmp.length < userKey.length && Buffer.compare(userKey, tmp) < 0) {
    return Buffer.concat([tmp, MAX_SEQ_TRAILER]);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Blocks.

/**
 * Mirrors leveldb::BlockBuilder: prefix-compressed entries plus a restart
 * array. Index blocks use restartInterval 1 (no prefix compression).
 */
export class BlockBuilder {
  /** @param {number} restartInterval */
  constructor(restartInterval = 16) {
    if (!Number.isInteger(restartInterval) || restartInterval < 1) throw new RangeError('restartInterval must be >= 1');
    this.restartInterval = restartInterval;
    this.writer = new ByteWriter();
    this.restarts = [0];
    this.counter = 0;
    this.lastKey = Buffer.alloc(0);
    this.entries = 0;
  }

  /**
   * @param {Buffer} key
   * @param {Buffer} value
   */
  add(key, value) {
    let shared = 0;
    if (this.counter < this.restartInterval) {
      shared = commonPrefixLength(this.lastKey, key);
    } else {
      this.restarts.push(this.writer.length);
      this.counter = 0;
    }
    const nonShared = key.length - shared;
    this.writer.putVarint32(shared);
    this.writer.putVarint32(nonShared);
    this.writer.putVarint32(value.length);
    this.writer.putBytes(key.subarray(shared));
    this.writer.putBytes(value);
    this.lastKey = key;
    this.counter++;
    this.entries++;
  }

  isEmpty() {
    return this.entries === 0;
  }

  /** Approximate size of the finished block (entries + restart array). */
  estimate() {
    return this.writer.length + this.restarts.length * 4 + 4;
  }

  /** @returns {Buffer} block contents (before compression / trailer) */
  finish() {
    for (const r of this.restarts) this.writer.putFixed32(r);
    this.writer.putFixed32(this.restarts.length);
    return this.writer.toBuffer();
  }
}

/**
 * Build one block's contents from already-sorted [internalKey, value] pairs.
 * @param {Array<[Buffer, Buffer]>} pairs
 * @param {number} [restartInterval]
 * @returns {Buffer}
 */
export function buildBlock(pairs, restartInterval = 16) {
  const b = new BlockBuilder(restartInterval);
  for (const [k, v] of pairs) b.add(k, v);
  return b.finish();
}

/**
 * @typedef {{ offset: number, size: number }} BlockHandle
 */

/**
 * @param {BlockHandle} handle
 * @returns {Buffer}
 */
export function encodeBlockHandle(handle) {
  return Buffer.concat([encodeVarint64(handle.offset), encodeVarint64(handle.size)]);
}

/**
 * @typedef {'none'|'snappy'|'zstd'} BlockCompression
 * @typedef {{ kind: 'data'|'index'|'metaindex', index: number }} BlockInfo
 */

/**
 * Append `contents` as an on-disk block (body + 1 type byte + 4 byte masked
 * crc32c over body+type) and return its handle. 'zstd' writes the raw bytes
 * with type byte 2: it is only there to test the reader's "unsupported
 * compression" path, no real zstd stream is produced.
 * @param {ByteWriter} out
 * @param {Buffer} contents
 * @param {BlockCompression} compression
 * @returns {BlockHandle}
 */
function appendBlock(out, contents, compression) {
  let type;
  let body;
  if (compression === 'snappy') {
    type = BLOCK_SNAPPY;
    body = Buffer.from(snappyCompress(contents));
  } else if (compression === 'zstd') {
    type = BLOCK_ZSTD;
    body = contents;
  } else if (compression === 'none') {
    type = BLOCK_NONE;
    body = contents;
  } else {
    throw new RangeError(`unknown block compression: ${compression}`);
  }
  const handle = { offset: out.length, size: body.length };
  out.putBytes(body);
  out.putByte(type);
  out.putFixed32(maskCrc(crc32c(Buffer.from([type]), crc32c(body))));
  return handle;
}

// ---------------------------------------------------------------------------
// SSTable (.ldb / .sst).

/**
 * @typedef {object} SstEntry
 * @property {string|Uint8Array} key user key
 * @property {bigint|number} sequence
 * @property {0|1} type 0 deletion, 1 value
 * @property {string|Uint8Array} [value] required when type is 1
 */

/**
 * @typedef {object} SstOptions
 * @property {'none'|'snappy'|((info: BlockInfo) => BlockCompression)} [compression] default 'none'
 * @property {number} [blockSize] flush a data block once it reaches this many bytes (default 4096)
 * @property {number} [restartInterval] restart point interval inside data blocks (default 16)
 * @property {boolean} [shortenKeys] use FindShortestSeparator / FindShortSuccessor for index keys (default true)
 */

/**
 * @typedef {object} SstResult
 * @property {Buffer} buffer the whole file
 * @property {number} size
 * @property {Buffer|null} smallest smallest internal key (null when empty)
 * @property {Buffer|null} largest largest internal key (null when empty)
 * @property {number} count number of entries
 * @property {number} dataBlocks number of data blocks written
 * @property {BlockHandle} metaindexHandle
 * @property {BlockHandle} indexHandle
 */

/**
 * @param {SstOptions['compression']} compression
 * @returns {(info: BlockInfo) => BlockCompression}
 */
function compressionChooser(compression) {
  if (typeof compression === 'function') return compression;
  const value = compression ?? 'none';
  if (value !== 'none' && value !== 'snappy') throw new RangeError(`compression must be 'none', 'snappy' or a function, got ${value}`);
  return () => value;
}

/**
 * Build a complete SSTable in memory. Entries are sorted by the internal key
 * comparator (user key ascending, sequence descending) before writing.
 * @param {SstEntry[]} entries
 * @param {SstOptions} [options]
 * @returns {SstResult}
 */
export function buildSstFile(entries, options = {}) {
  const blockSize = options.blockSize ?? 4096;
  const restartInterval = options.restartInterval ?? 16;
  const shortenKeys = options.shortenKeys ?? true;
  const chooser = compressionChooser(options.compression);

  const sorted = entries
    .map((e, i) => {
      if (e.type === TYPE_VALUE && e.value === undefined) throw new TypeError(`entry ${i}: value entries need a value`);
      return {
        internalKey: encodeInternalKey(e.key, e.sequence, e.type),
        value: e.type === TYPE_VALUE ? toBuffer(e.value) : Buffer.alloc(0),
      };
    })
    .sort((a, b) => compareInternalKeys(a.internalKey, b.internalKey));
  for (let i = 1; i < sorted.length; i++) {
    if (compareInternalKeys(sorted[i - 1].internalKey, sorted[i].internalKey) === 0) {
      throw new Error(`duplicate internal key at sorted position ${i}`);
    }
  }

  const out = new ByteWriter();
  const index = new BlockBuilder(1);
  let data = new BlockBuilder(restartInterval);
  let dataBlocks = 0;
  /** @type {BlockHandle|null} */
  let pendingHandle = null;
  /** @type {Buffer|null} */
  let lastKey = null;

  for (const e of sorted) {
    if (pendingHandle && lastKey) {
      const sep = shortenKeys ? shortestSeparator(lastKey, e.internalKey) : lastKey;
      index.add(sep, encodeBlockHandle(pendingHandle));
      pendingHandle = null;
    }
    data.add(e.internalKey, e.value);
    lastKey = e.internalKey;
    if (data.estimate() >= blockSize) {
      pendingHandle = appendBlock(out, data.finish(), chooser({ kind: 'data', index: dataBlocks++ }));
      data = new BlockBuilder(restartInterval);
    }
  }
  if (!data.isEmpty()) {
    pendingHandle = appendBlock(out, data.finish(), chooser({ kind: 'data', index: dataBlocks++ }));
  }
  if (pendingHandle && lastKey) {
    index.add(shortenKeys ? shortSuccessor(lastKey) : lastKey, encodeBlockHandle(pendingHandle));
  }

  const metaindexHandle = appendBlock(out, new BlockBuilder(1).finish(), chooser({ kind: 'metaindex', index: 0 }));
  const indexHandle = appendBlock(out, index.finish(), chooser({ kind: 'index', index: 0 }));

  const footer = new ByteWriter();
  footer.putBytes(encodeBlockHandle(metaindexHandle));
  footer.putBytes(encodeBlockHandle(indexHandle));
  if (footer.length > 40) throw new Error('footer handles longer than 40 bytes');
  footer.putBytes(Buffer.alloc(40 - footer.length));
  footer.putBytes(TABLE_MAGIC);
  out.putBytes(footer.toBuffer());

  const buffer = out.toBuffer();
  return {
    buffer,
    size: buffer.length,
    smallest: sorted.length ? sorted[0].internalKey : null,
    largest: sorted.length ? sorted[sorted.length - 1].internalKey : null,
    count: sorted.length,
    dataBlocks,
    metaindexHandle,
    indexHandle,
  };
}

/**
 * Write a valid .ldb/.sst file.
 * @param {string} filePath
 * @param {SstEntry[]} entries
 * @param {SstOptions} [options]
 * @returns {Promise<SstResult & { path: string }>}
 */
export async function writeSstFile(filePath, entries, options = {}) {
  const result = buildSstFile(entries, options);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, result.buffer);
  return { path: filePath, ...result };
}

// ---------------------------------------------------------------------------
// Write-ahead log (.log) and MANIFEST framing.

/**
 * @typedef {object} LogFramingOptions
 * @property {number} [blockSize] default 32768. Readers assume 32768; only
 *   change this for writer self-tests.
 * @property {boolean} [forceFragment] split every record into FIRST/MIDDLE/LAST
 *   fragments even when it would fit in the current block.
 * @property {number} [fragmentSize] fragment payload size used by forceFragment
 *   (default: a third of the record).
 * @property {number} [trailingZeros] append this many zero bytes after the
 *   last record (mimics pre-allocated file space).
 */

/**
 * Mirrors leveldb::log::Writer.
 */
export class LogWriter {
  /** @param {number} [blockSize] */
  constructor(blockSize = WAL_BLOCK_SIZE) {
    if (!Number.isInteger(blockSize) || blockSize <= WAL_HEADER_SIZE) throw new RangeError('blockSize must exceed the 7-byte header');
    this.blockSize = blockSize;
    this.writer = new ByteWriter();
    this.blockOffset = 0;
  }

  /**
   * @param {Uint8Array} payload
   * @param {{ forceFragment?: boolean, fragmentSize?: number }} [options]
   */
  addRecord(payload, options = {}) {
    const record = toBuffer(payload);
    /** @type {Buffer[]} */
    let pieces = [record];
    if (options.forceFragment && record.length > 1) {
      const size = Math.max(1, options.fragmentSize ?? Math.ceil(record.length / 3));
      pieces = [];
      for (let p = 0; p < record.length; p += size) pieces.push(record.subarray(p, Math.min(record.length, p + size)));
    }
    let begin = true;
    for (let p = 0; p < pieces.length; p++) {
      const piece = pieces[p];
      let pos = 0;
      do {
        const leftover = this.blockSize - this.blockOffset;
        if (leftover < WAL_HEADER_SIZE) {
          if (leftover > 0) this.writer.putBytes(Buffer.alloc(leftover));
          this.blockOffset = 0;
        }
        const avail = this.blockSize - this.blockOffset - WAL_HEADER_SIZE;
        const fragLen = Math.min(piece.length - pos, avail);
        const endOfPiece = pos + fragLen === piece.length;
        const end = endOfPiece && p === pieces.length - 1;
        let type;
        if (begin && end) type = RECORD_FULL;
        else if (begin) type = RECORD_FIRST;
        else if (end) type = RECORD_LAST;
        else type = RECORD_MIDDLE;
        this.emitPhysicalRecord(type, piece.subarray(pos, pos + fragLen));
        begin = false;
        pos += fragLen;
      } while (pos < piece.length);
    }
  }

  /**
   * @param {number} type
   * @param {Buffer} fragment
   */
  emitPhysicalRecord(type, fragment) {
    if (fragment.length > 0xffff) throw new RangeError('fragment longer than 65535');
    const header = Buffer.alloc(WAL_HEADER_SIZE);
    header.writeUInt32LE(maskCrc(crc32c(fragment, crc32c(Buffer.from([type])))), 0);
    header.writeUInt16LE(fragment.length, 4);
    header[6] = type;
    this.writer.putBytes(header);
    this.writer.putBytes(fragment);
    this.blockOffset += WAL_HEADER_SIZE + fragment.length;
  }

  /** @param {number} count */
  addZeros(count) {
    if (count <= 0) return;
    this.writer.putBytes(Buffer.alloc(count));
    this.blockOffset = (this.blockOffset + count) % this.blockSize;
  }

  /** @returns {Buffer} */
  finish() {
    return this.writer.toBuffer();
  }
}

/**
 * @typedef {object} LogRecord
 * @property {0|1} type 0 deletion, 1 value
 * @property {string|Uint8Array} key
 * @property {string|Uint8Array} [value] required when type is 1
 */

/**
 * @typedef {object} LogBatch
 * @property {bigint|number} sequence sequence of the first record; record i gets sequence + i
 * @property {LogRecord[]} records
 */

/**
 * WriteBatch wire format: sequence (8 LE) + count (4 LE) + records.
 * @param {LogBatch} batch
 * @returns {Buffer}
 */
export function encodeWriteBatch(batch) {
  const w = new ByteWriter();
  w.putFixed64(batch.sequence);
  w.putFixed32(batch.records.length);
  batch.records.forEach((r, i) => {
    if (r.type !== TYPE_DELETION && r.type !== TYPE_VALUE) throw new RangeError(`record ${i}: bad type ${r.type}`);
    w.putByte(r.type);
    w.putLengthPrefixed(r.key);
    if (r.type === TYPE_VALUE) {
      if (r.value === undefined) throw new TypeError(`record ${i}: value records need a value`);
      w.putLengthPrefixed(r.value);
    }
  });
  return w.toBuffer();
}

/**
 * @param {LogBatch[]} batches
 * @param {LogFramingOptions} [options]
 * @returns {Buffer}
 */
export function buildLogFile(batches, options = {}) {
  const w = new LogWriter(options.blockSize ?? WAL_BLOCK_SIZE);
  for (const batch of batches) w.addRecord(encodeWriteBatch(batch), options);
  if (options.trailingZeros) w.addZeros(options.trailingZeros);
  return w.finish();
}

/**
 * Write a valid write-ahead log.
 * @param {string} filePath
 * @param {LogBatch[]} batches
 * @param {LogFramingOptions} [options]
 * @returns {Promise<{ path: string, size: number, buffer: Buffer }>}
 */
export async function writeLogFile(filePath, batches, options = {}) {
  const buffer = buildLogFile(batches, options);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
  return { path: filePath, size: buffer.length, buffer };
}

// ---------------------------------------------------------------------------
// MANIFEST / VersionEdit.

const TAG_COMPARATOR = 1;
const TAG_LOG_NUMBER = 2;
const TAG_NEXT_FILE_NUMBER = 3;
const TAG_LAST_SEQUENCE = 4;
const TAG_COMPACT_POINTER = 5;
const TAG_DELETED_FILE = 6;
const TAG_NEW_FILE = 7;
const TAG_PREV_LOG_NUMBER = 9;

/**
 * @typedef {object} TableMeta
 * @property {number} level
 * @property {number} number file number (000005.ldb -> 5)
 * @property {number} size file size in bytes
 * @property {string|Uint8Array} smallest internal key (Buffer as produced by
 *   writeSstFile) or a plain user key string (encoded with sequence 0 / type 1)
 * @property {string|Uint8Array} largest same as smallest
 */

/**
 * @typedef {object} VersionEdit
 * @property {string} [comparator]
 * @property {bigint|number} [logNumber]
 * @property {bigint|number} [prevLogNumber]
 * @property {bigint|number} [nextFileNumber]
 * @property {bigint|number} [lastSequence]
 * @property {Array<{ level: number, key: Uint8Array }>} [compactPointers]
 * @property {Array<{ level: number, number: bigint|number }>} [deletedFiles]
 * @property {TableMeta[]} [newFiles]
 */

/**
 * @param {string|Uint8Array} key
 * @returns {Buffer}
 */
function toInternalKey(key) {
  if (typeof key === 'string') return encodeInternalKey(key, 0, TYPE_VALUE);
  const b = toBuffer(key);
  if (b.length < 8) throw new RangeError('internal key Buffer must be at least 8 bytes');
  return b;
}

/**
 * VersionEdit::EncodeTo.
 * @param {VersionEdit} edit
 * @returns {Buffer}
 */
export function encodeVersionEdit(edit) {
  const w = new ByteWriter();
  if (edit.comparator !== undefined) {
    w.putVarint32(TAG_COMPARATOR);
    w.putLengthPrefixed(edit.comparator);
  }
  if (edit.logNumber !== undefined) {
    w.putVarint32(TAG_LOG_NUMBER);
    w.putVarint64(edit.logNumber);
  }
  if (edit.prevLogNumber !== undefined) {
    w.putVarint32(TAG_PREV_LOG_NUMBER);
    w.putVarint64(edit.prevLogNumber);
  }
  if (edit.nextFileNumber !== undefined) {
    w.putVarint32(TAG_NEXT_FILE_NUMBER);
    w.putVarint64(edit.nextFileNumber);
  }
  if (edit.lastSequence !== undefined) {
    w.putVarint32(TAG_LAST_SEQUENCE);
    w.putVarint64(edit.lastSequence);
  }
  for (const cp of edit.compactPointers ?? []) {
    w.putVarint32(TAG_COMPACT_POINTER);
    w.putVarint32(cp.level);
    w.putLengthPrefixed(toInternalKey(cp.key));
  }
  for (const d of edit.deletedFiles ?? []) {
    w.putVarint32(TAG_DELETED_FILE);
    w.putVarint32(d.level);
    w.putVarint64(d.number);
  }
  for (const f of edit.newFiles ?? []) {
    w.putVarint32(TAG_NEW_FILE);
    w.putVarint32(f.level);
    w.putVarint64(f.number);
    w.putVarint64(f.size);
    w.putLengthPrefixed(toInternalKey(f.smallest));
    w.putLengthPrefixed(toInternalKey(f.largest));
  }
  return w.toBuffer();
}

/**
 * A MANIFEST is a log file whose records are encoded VersionEdits.
 * @param {VersionEdit[]} edits
 * @param {LogFramingOptions} [options]
 * @returns {Buffer}
 */
export function buildManifest(edits, options = {}) {
  const w = new LogWriter(options.blockSize ?? WAL_BLOCK_SIZE);
  for (const edit of edits) w.addRecord(encodeVersionEdit(edit), options);
  return w.finish();
}

/**
 * @typedef {object} ManifestOptions
 * @property {bigint|number} logNumber number of the live .log file; logs with a
 *   smaller number are considered obsolete by readers
 * @property {TableMeta[]} liveTables tables that are part of the current version
 * @property {TableMeta[]} [deletedTables] tables recorded as added in the first
 *   edit and then removed by a second edit (models a compaction that made
 *   them obsolete while the files still linger on disk)
 * @property {bigint|number} lastSequence
 * @property {bigint|number} [prevLogNumber]
 * @property {bigint|number} [nextFileNumber] default: one past every number mentioned
 * @property {string} [comparator] default 'leveldb.BytewiseComparator'
 * @property {number} [manifestNumber] default 1 (-> MANIFEST-000001)
 * @property {VersionEdit[]} [edits] write exactly these edits instead of building them
 * @property {LogFramingOptions} [framing]
 */

/**
 * @param {number} n
 * @returns {string}
 */
export function fileNumberName(n) {
  return String(n).padStart(6, '0');
}

/**
 * Write CURRENT + MANIFEST-NNNNNN into `dir`.
 * @param {string} dir
 * @param {ManifestOptions} options
 * @returns {Promise<{ manifestPath: string, currentPath: string, edits: VersionEdit[] }>}
 */
export async function writeManifest(dir, options) {
  const manifestNumber = options.manifestNumber ?? 1;
  /** @type {VersionEdit[]} */
  let edits;
  if (options.edits) {
    edits = options.edits;
  } else {
    if (options.logNumber === undefined) throw new TypeError('writeManifest: logNumber is required');
    if (options.lastSequence === undefined) throw new TypeError('writeManifest: lastSequence is required');
    const liveTables = options.liveTables ?? [];
    const deletedTables = options.deletedTables ?? [];
    let nextFileNumber = options.nextFileNumber;
    if (nextFileNumber === undefined) {
      let max = Math.max(Number(options.logNumber), manifestNumber, Number(options.prevLogNumber ?? 0));
      for (const t of [...liveTables, ...deletedTables]) max = Math.max(max, Number(t.number));
      nextFileNumber = max + 1;
    }
    /** @type {VersionEdit} */
    const snapshot = {
      comparator: options.comparator ?? DEFAULT_COMPARATOR,
      logNumber: options.logNumber,
      nextFileNumber,
      lastSequence: options.lastSequence,
      newFiles: [...liveTables, ...deletedTables],
    };
    if (options.prevLogNumber !== undefined) snapshot.prevLogNumber = options.prevLogNumber;
    edits = [snapshot];
    if (deletedTables.length) {
      edits.push({ deletedFiles: deletedTables.map((t) => ({ level: t.level, number: t.number })) });
    }
  }
  const manifestName = `MANIFEST-${fileNumberName(manifestNumber)}`;
  const manifestPath = path.join(dir, manifestName);
  const currentPath = path.join(dir, 'CURRENT');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(manifestPath, buildManifest(edits, options.framing ?? {}));
  await fs.writeFile(currentPath, `${manifestName}\n`);
  return { manifestPath, currentPath, edits };
}

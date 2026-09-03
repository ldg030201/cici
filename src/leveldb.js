/**
 * Read-only LevelDB reader.
 *
 * Reads a LevelDB directory (as written by Chromium for extension storage)
 * without taking the LOCK, so it works while the browser has the database
 * open. It understands:
 *   - SSTables (*.ldb / *.sst): footer, index block, data blocks, prefix
 *     compressed entries, snappy compressed blocks (zstd is reported and
 *     skipped)
 *   - write-ahead logs (*.log): 32 KiB block framing, crc32c verification,
 *     fragment reassembly, write batches
 *   - CURRENT + MANIFEST-*: VersionEdit replay to find the live table set and
 *     the oldest log that still matters
 *
 * Everything is best effort: a corrupt or partially written file produces a
 * warning and, like LevelDB's own recovery, costs at most the damaged part of
 * the file (the rest of a 32 KiB log block, one data block of a table, or the
 * whole MANIFEST, which falls back to scanning every file). readLevelDb()
 * never throws because of file contents.
 *
 * @module leveldb
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { uncompress } from './snappy.js';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Footer size of an SSTable: 2 BlockHandles (padded to 40 bytes) + 8 byte magic. */
const FOOTER_SIZE = 48;
/** 0xdb4775248b80fb57 little-endian. */
const TABLE_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);
/** Block trailer: 1 byte compression type + 4 byte crc32c. */
const BLOCK_TRAILER_SIZE = 5;

const COMPRESSION_NONE = 0;
const COMPRESSION_SNAPPY = 1;
const COMPRESSION_ZSTD = 2;

/** Internal key value types. */
const TYPE_DELETION = 0;
const TYPE_VALUE = 1;

/** Write-ahead log framing. */
const LOG_BLOCK_SIZE = 32768;
const LOG_HEADER_SIZE = 7;
const RECORD_ZERO = 0;
const RECORD_FULL = 1;
const RECORD_FIRST = 2;
const RECORD_MIDDLE = 3;
const RECORD_LAST = 4;

/** VersionEdit tags. */
const TAG_COMPARATOR = 1;
const TAG_LOG_NUMBER = 2;
const TAG_NEXT_FILE_NUMBER = 3;
const TAG_LAST_SEQUENCE = 4;
const TAG_COMPACT_POINTER = 5;
const TAG_DELETED_FILE = 6;
const TAG_NEW_FILE = 7;
const TAG_PREV_LOG_NUMBER = 9;

const RE_TABLE = /^(\d+)\.(ldb|sst)$/;
const RE_LOG = /^(\d+)\.log$/;
const RE_MANIFEST = /^MANIFEST-(\d+)$/;

// ---------------------------------------------------------------------------
// CRC32C (Castagnoli) + LevelDB's crc masking
// ---------------------------------------------------------------------------

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** LevelDB rotates the crc before storing it so a raw crc never appears on disk. */
const CRC_MASK_DELTA = 0xa282ead8;

/**
 * crc32c(data), or crc32c::Extend(crc, data) when `crc` is given.
 *
 * @param {Uint8Array} data
 * @param {number} [crc] crc of everything before `data`
 * @returns {number} unsigned 32 bit
 */
function crc32c(data, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC32C_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Undo crc32c::Mask (rotate right by 15, then add the delta).
 *
 * @param {number} masked
 * @returns {number}
 */
function unmaskCrc(masked) {
  const rot = (masked - CRC_MASK_DELTA) >>> 0;
  return ((rot >>> 17) | (rot << 15)) >>> 0;
}

/** One reusable 1-byte buffer for the record type that the crc covers. */
const CRC_TYPE_BYTE = Buffer.alloc(1);

/**
 * crc32c of a log record as LevelDB computes it: the type byte followed by the
 * payload.
 *
 * @param {number} type
 * @param {Uint8Array} payload
 * @returns {number}
 */
function logRecordCrc(type, payload) {
  CRC_TYPE_BYTE[0] = type & 0xff;
  return crc32c(payload, crc32c(CRC_TYPE_BYTE));
}

// ---------------------------------------------------------------------------
// varints / internal keys
// ---------------------------------------------------------------------------

/**
 * Decode a LevelDB varint32.
 *
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {{ value: number, next: number }} the value and the offset just past it
 * @throws {Error} when the buffer ends before the varint does or the varint is too long
 */
export function decodeVarint32(buf, offset) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('varint32: truncated');
    const b = buf[pos++];
    if (shift === 28 && (b & 0x70) !== 0) throw new Error('varint32: overflow');
    value = (value | ((b & 0x7f) << shift)) >>> 0;
    if ((b & 0x80) === 0) return { value, next: pos };
    shift += 7;
    if (shift > 28) throw new Error('varint32: too long');
  }
}

/**
 * Decode a LevelDB varint64 as a BigInt.
 *
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {{ value: bigint, next: number }}
 * @throws {Error} when truncated or longer than 10 bytes
 */
export function decodeVarint64(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('varint64: truncated');
    const b = buf[pos++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      if (value > 0xffffffffffffffffn) throw new Error('varint64: overflow');
      return { value, next: pos };
    }
    shift += 7n;
    if (shift > 63n) throw new Error('varint64: too long');
  }
}

/**
 * Read a varint32 length-prefixed byte string.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ value: Buffer, next: number }}
 */
function readLengthPrefixed(buf, offset) {
  const { value: len, next } = decodeVarint32(buf, offset);
  if (next + len > buf.length) throw new Error('length-prefixed slice: truncated');
  return { value: buf.subarray(next, next + len), next: next + len };
}

/**
 * Split a LevelDB internal key into user key, sequence number and type.
 * Internal key = user_key + 8 bytes little-endian ((sequence << 8) | type).
 *
 * @param {Buffer} buf
 * @returns {{ userKey: Buffer, sequence: bigint, type: number }}
 * @throws {Error} when the key is shorter than 8 bytes
 */
export function parseInternalKey(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 8) throw new Error('internal key: shorter than 8 bytes');
  const packed = buf.readBigUInt64LE(buf.length - 8);
  return {
    userKey: buf.subarray(0, buf.length - 8),
    sequence: packed >> 8n,
    type: Number(packed & 0xffn),
  };
}

// ---------------------------------------------------------------------------
// SSTable
// ---------------------------------------------------------------------------

/**
 * @typedef {object} BlockHandle
 * @property {number} offset
 * @property {number} size
 */

/**
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ value: BlockHandle, next: number }}
 */
function decodeBlockHandle(buf, offset) {
  const off = decodeVarint64(buf, offset);
  const size = decodeVarint64(buf, off.next);
  if (off.value > BigInt(Number.MAX_SAFE_INTEGER) || size.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('block handle: offset/size out of range');
  }
  return { value: { offset: Number(off.value), size: Number(size.value) }, next: size.next };
}

/**
 * Walk the entries of one block (index or data). Entries are prefix
 * compressed against the previous key and are followed by the restart array
 * and the restart count; we only need the sequential walk.
 *
 * @param {Buffer} contents block contents without the trailer
 * @param {(key: Buffer, value: Buffer) => void} onEntry
 */
function forEachBlockEntry(contents, onEntry) {
  const n = contents.length;
  if (n < 4) throw new Error('block: too small for restart count');
  const numRestarts = contents.readUInt32LE(n - 4);
  const restartOffset = n - 4 - numRestarts * 4;
  if (restartOffset < 0) throw new Error('block: restart array larger than block');

  let pos = 0;
  let prevKey = Buffer.alloc(0);
  while (pos < restartOffset) {
    const shared = decodeVarint32(contents, pos);
    const nonShared = decodeVarint32(contents, shared.next);
    const valueLen = decodeVarint32(contents, nonShared.next);
    pos = valueLen.next;
    if (shared.value > prevKey.length) throw new Error('block: shared prefix longer than previous key');
    if (pos + nonShared.value + valueLen.value > restartOffset) throw new Error('block: entry overruns block');

    const key = shared.value === 0
      ? contents.subarray(pos, pos + nonShared.value)
      : Buffer.concat([prevKey.subarray(0, shared.value), contents.subarray(pos, pos + nonShared.value)]);
    pos += nonShared.value;
    const value = contents.subarray(pos, pos + valueLen.value);
    pos += valueLen.value;

    onEntry(key, value);
    prevKey = key;
  }
}

/**
 * Read one block (contents + 1 byte type + 4 byte crc) out of a table file.
 *
 * @param {Buffer} file
 * @param {BlockHandle} handle
 * @returns {{ contents: Buffer, compression: number }}
 * @throws {Error} on out-of-range handles, unsupported compression or a snappy error
 */
function readBlock(file, handle) {
  const end = handle.offset + handle.size;
  if (handle.offset < 0 || end + BLOCK_TRAILER_SIZE > file.length) {
    throw new Error(`block handle (offset ${handle.offset}, size ${handle.size}) is outside the file`);
  }
  const compression = file[end];
  // The trailer crc covers the block contents plus the compression type byte.
  // LevelDB makes this optional (ReadOptions::verify_checksums defaults to
  // false), but cici's whole output is a UUID the user pastes somewhere, so a
  // silently wrong value is the worst failure mode: check it and let the
  // caller drop just this block.
  if (unmaskCrc(file.readUInt32LE(end + 1)) !== crc32c(file.subarray(handle.offset, end + 1))) {
    throw new Error('block checksum mismatch');
  }
  const raw = file.subarray(handle.offset, end);
  switch (compression) {
    case COMPRESSION_NONE:
      return { contents: raw, compression };
    case COMPRESSION_SNAPPY: {
      const out = uncompress(raw);
      return { contents: Buffer.from(out.buffer, out.byteOffset, out.byteLength), compression };
    }
    case COMPRESSION_ZSTD:
      throw new Error('zstd compressed block is not supported');
    default:
      throw new Error(`unknown block compression type ${compression}`);
  }
}

/**
 * Parse a whole SSTable held in memory and report every entry.
 * Exported for tests and diagnostics; readLevelDb() is the normal entry point.
 *
 * @param {Buffer} file the entire *.ldb / *.sst file
 * @param {object} options
 * @param {(entry: { userKey: Buffer, sequence: bigint, type: number, value: Buffer }) => void} options.onEntry
 * @param {(info: { compression: number, handle: BlockHandle }) => void} [options.onBlock] called for every data block that was decoded
 * @param {string[]} [options.warnings] warnings are pushed here, prefixed with `label`
 * @param {string} [options.label] name used in warnings
 */
export function readTableBuffer(file, { onEntry, onBlock, warnings = [], label = 'table' }) {
  const warn = (msg) => warnings.push(`${label}: ${msg}`);

  if (file.length < FOOTER_SIZE) {
    warn(`file is ${file.length} bytes, too small to be an SSTable`);
    return;
  }
  const footer = file.subarray(file.length - FOOTER_SIZE);
  if (!footer.subarray(FOOTER_SIZE - 8).equals(TABLE_MAGIC)) {
    warn('bad footer magic, not an SSTable');
    return;
  }

  let indexHandle;
  try {
    const meta = decodeBlockHandle(footer, 0);
    indexHandle = decodeBlockHandle(footer, meta.next).value;
  } catch (err) {
    warn(`cannot decode footer: ${err.message}`);
    return;
  }

  /** @type {BlockHandle[]} */
  const dataHandles = [];
  try {
    const index = readBlock(file, indexHandle);
    forEachBlockEntry(index.contents, (_key, value) => {
      // One unreadable handle costs its own data block, not the whole table.
      try {
        dataHandles.push(decodeBlockHandle(value, 0).value);
      } catch (err) {
        warn(`index entry ${dataHandles.length} has an unreadable block handle: ${err.message}; that data block is skipped`);
      }
    });
  } catch (err) {
    // Damage in the middle of the index block still leaves the entries before
    // it usable, exactly like LevelDB's two-level iterator.
    warn(`index block unusable after ${dataHandles.length} entr${dataHandles.length === 1 ? 'y' : 'ies'}: ${err.message}`);
    if (dataHandles.length === 0) return;
  }

  for (let i = 0; i < dataHandles.length; i++) {
    const handle = dataHandles[i];
    try {
      const block = readBlock(file, handle);
      if (onBlock) onBlock({ compression: block.compression, handle });
      forEachBlockEntry(block.contents, (key, value) => {
        const ik = parseInternalKey(key);
        onEntry({ userKey: ik.userKey, sequence: ik.sequence, type: ik.type, value });
      });
    } catch (err) {
      warn(`data block ${i} at offset ${handle.offset} skipped: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// write-ahead log framing (shared by *.log and MANIFEST-*)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LogScanResult
 * @property {number} records number of complete records delivered
 * @property {boolean} truncated the file ends in the middle of a record (the
 *   writer is probably still appending; LevelDB treats this as end-of-file)
 * @property {boolean} corrupt a record was damaged (bad length, unknown type,
 *   checksum mismatch, orphaned fragment)
 */

/**
 * Iterate over the logical records of a LevelDB log file.
 *
 * Follows log::Reader: a damaged record is reported and the rest of its 32 KiB
 * block is dropped, then reading resumes at the next block, so records written
 * after the damage are still delivered. A record cut off by the end of the file
 * is treated as end-of-file (the writer may still be appending) and stops the
 * scan. Every record's masked crc32c is verified, which is what makes resyncing
 * safe.
 *
 * @param {Buffer} file
 * @param {object} options
 * @param {(record: Buffer, index: number) => void} options.onRecord
 * @param {string[]} [options.warnings]
 * @param {string} [options.label]
 * @returns {LogScanResult}
 */
export function readLogBuffer(file, { onRecord, warnings = [], label = 'log' }) {
  const warn = (msg) => warnings.push(`${label}: ${msg}`);
  const truncated = (pos, detail) =>
    warn(`truncated record at offset ${pos} (${detail}; the writer may still be appending, so this is normal); rest of file ignored`);
  let pos = 0;
  let count = 0;
  let wasTruncated = false;
  let corrupt = false;
  /** @type {Buffer[] | null} fragments of the record being reassembled */
  let fragments = null;

  /** Damaged record: drop what was reassembled and skip the rest of the block. */
  const dropBlock = (blockEnd, msg) => {
    warn(msg);
    corrupt = true;
    fragments = null;
    return blockEnd;
  };

  while (pos < file.length) {
    const blockStart = pos - (pos % LOG_BLOCK_SIZE);
    const blockEnd = blockStart + LOG_BLOCK_SIZE;
    if (blockEnd - pos < LOG_HEADER_SIZE) {
      // trailer of a block: zero padding. A fragmented record continues in the
      // next block, so pending fragments are kept.
      pos = blockEnd;
      continue;
    }
    if (pos + LOG_HEADER_SIZE > file.length) {
      // partial header at EOF: the writer has not finished this record
      truncated(pos, `only ${file.length - pos} of the ${LOG_HEADER_SIZE} header bytes are present`);
      fragments = null;
      wasTruncated = true;
      break;
    }
    const length = file.readUInt16LE(pos + 4);
    const type = file[pos + 6];
    const recordEnd = pos + LOG_HEADER_SIZE + length;

    // A genuine record never reaches past its own block. Past the block but
    // inside the final, partial block means the writer was interrupted (EOF);
    // anywhere else it is a corrupt length.
    if (recordEnd > blockEnd || recordEnd > file.length) {
      if (blockEnd > file.length) {
        truncated(pos, `${length} payload bytes declared, ${Math.max(0, file.length - pos - LOG_HEADER_SIZE)} present`);
        fragments = null;
        wasTruncated = true;
        break;
      }
      pos = dropBlock(blockEnd, `bad record length ${length} at offset ${pos}: it does not fit in its 32 KiB block; rest of the block ignored`);
      continue;
    }

    if (type === RECORD_ZERO && length === 0) {
      // Zero-filled area (preallocated or padded): skip the rest of the block.
      // log::Reader treats a zero record as kBadRecord, which only *matters*
      // when a fragmented record is pending — then it reports "error in middle
      // of record", because the rest of that record is gone.
      if (fragments) {
        pos = dropBlock(
          blockEnd,
          `zero/padding record at offset ${pos} interrupts a fragmented record; the record is dropped and the rest of the block ignored`,
        );
        continue;
      }
      pos = blockEnd;
      continue;
    }

    const payload = file.subarray(pos + LOG_HEADER_SIZE, recordEnd);
    const storedCrc = file.readUInt32LE(pos);
    if (unmaskCrc(storedCrc) !== logRecordCrc(type, payload)) {
      pos = dropBlock(blockEnd, `checksum mismatch for the record at offset ${pos}; rest of the block ignored`);
      continue;
    }
    const recordStart = pos;
    pos = recordEnd;

    switch (type) {
      case RECORD_FULL:
        if (fragments) {
          warn('unfinished fragmented record dropped');
          corrupt = true;
        }
        fragments = null;
        onRecord(payload, count++);
        break;
      case RECORD_FIRST:
        if (fragments) {
          warn('unfinished fragmented record dropped');
          corrupt = true;
        }
        fragments = [payload];
        break;
      case RECORD_MIDDLE:
        if (!fragments) {
          warn('MIDDLE fragment without a FIRST fragment ignored');
          corrupt = true;
        } else {
          fragments.push(payload);
        }
        break;
      case RECORD_LAST:
        if (!fragments) {
          warn('LAST fragment without a FIRST fragment ignored');
          corrupt = true;
        } else {
          fragments.push(payload);
          onRecord(Buffer.concat(fragments), count++);
          fragments = null;
        }
        break;
      default:
        // log::Reader reports the drop and carries on with the next record.
        warn(`unknown record type ${type} at offset ${recordStart} ignored`);
        corrupt = true;
        fragments = null;
        break;
    }
  }
  if (fragments) {
    warn('fragmented record without a LAST fragment at end of file dropped (the writer may still be appending, so this is normal)');
    wasTruncated = true;
  }
  return { records: count, truncated: wasTruncated, corrupt };
}

/**
 * @typedef {object} BatchRecord
 * @property {number} type 1 = value, 0 = deletion
 * @property {Buffer} key
 * @property {Buffer|null} value
 */

/**
 * Parse a write batch (the payload of a *.log record).
 *
 * @param {Buffer} payload
 * @returns {{ sequence: bigint, records: BatchRecord[] }}
 * @throws {Error} when malformed
 */
export function parseWriteBatch(payload) {
  if (payload.length < 12) throw new Error('write batch: shorter than its 12 byte header');
  const sequence = payload.readBigUInt64LE(0);
  const count = payload.readUInt32LE(8);
  const records = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    if (pos >= payload.length) throw new Error(`write batch: only ${i} of ${count} records present`);
    const type = payload[pos++];
    const key = readLengthPrefixed(payload, pos);
    pos = key.next;
    if (type === TYPE_VALUE) {
      const value = readLengthPrefixed(payload, pos);
      pos = value.next;
      records.push({ type, key: key.value, value: value.value });
    } else if (type === TYPE_DELETION) {
      records.push({ type, key: key.value, value: null });
    } else {
      throw new Error(`write batch: unknown record type ${type}`);
    }
  }
  if (pos !== payload.length) throw new Error('write batch: trailing bytes after the last record');
  return { sequence, records };
}

// ---------------------------------------------------------------------------
// MANIFEST / VersionEdit
// ---------------------------------------------------------------------------

/**
 * @typedef {object} VersionEdit
 * @property {string} [comparator]
 * @property {bigint} [logNumber]
 * @property {bigint} [prevLogNumber]
 * @property {bigint} [nextFileNumber]
 * @property {bigint} [lastSequence]
 * @property {Array<{ level: number, key: Buffer }>} compactPointers
 * @property {Array<{ level: number, file: bigint }>} deletedFiles
 * @property {Array<{ level: number, file: bigint, size: bigint, smallest: Buffer, largest: Buffer }>} newFiles
 */

/**
 * Decode one VersionEdit record from a MANIFEST file.
 *
 * @param {Buffer} payload
 * @returns {VersionEdit}
 * @throws {Error} on an unknown tag or truncated field
 */
export function parseVersionEdit(payload) {
  /** @type {VersionEdit} */
  const edit = { compactPointers: [], deletedFiles: [], newFiles: [] };
  let pos = 0;
  while (pos < payload.length) {
    const tag = decodeVarint32(payload, pos);
    pos = tag.next;
    switch (tag.value) {
      case TAG_COMPARATOR: {
        const s = readLengthPrefixed(payload, pos);
        edit.comparator = s.value.toString('utf8');
        pos = s.next;
        break;
      }
      case TAG_LOG_NUMBER: {
        const v = decodeVarint64(payload, pos);
        edit.logNumber = v.value;
        pos = v.next;
        break;
      }
      case TAG_NEXT_FILE_NUMBER: {
        const v = decodeVarint64(payload, pos);
        edit.nextFileNumber = v.value;
        pos = v.next;
        break;
      }
      case TAG_LAST_SEQUENCE: {
        const v = decodeVarint64(payload, pos);
        edit.lastSequence = v.value;
        pos = v.next;
        break;
      }
      case TAG_COMPACT_POINTER: {
        const level = decodeVarint32(payload, pos);
        const key = readLengthPrefixed(payload, level.next);
        edit.compactPointers.push({ level: level.value, key: key.value });
        pos = key.next;
        break;
      }
      case TAG_DELETED_FILE: {
        const level = decodeVarint32(payload, pos);
        const file = decodeVarint64(payload, level.next);
        edit.deletedFiles.push({ level: level.value, file: file.value });
        pos = file.next;
        break;
      }
      case TAG_NEW_FILE: {
        const level = decodeVarint32(payload, pos);
        const file = decodeVarint64(payload, level.next);
        const size = decodeVarint64(payload, file.next);
        const smallest = readLengthPrefixed(payload, size.next);
        const largest = readLengthPrefixed(payload, smallest.next);
        edit.newFiles.push({
          level: level.value,
          file: file.value,
          size: size.value,
          smallest: smallest.value,
          largest: largest.value,
        });
        pos = largest.next;
        break;
      }
      case TAG_PREV_LOG_NUMBER: {
        const v = decodeVarint64(payload, pos);
        edit.prevLogNumber = v.value;
        pos = v.next;
        break;
      }
      default:
        throw new Error(`version edit: unknown tag ${tag.value}`);
    }
  }
  return edit;
}

/**
 * @typedef {object} ManifestState
 * @property {Set<number>} liveTables file numbers of the tables in the current version
 * @property {bigint|null} logNumber logs with a smaller number are already in a table
 * @property {bigint|null} prevLogNumber older LevelDB versions kept one extra log alive
 * @property {number} edits number of VersionEdits applied
 */

/**
 * Replay a MANIFEST file and return the resulting live state.
 *
 * Like LevelDB, a record cut off at the end of the file is treated as
 * end-of-file: the version reconstructed from the complete records is kept
 * (Chrome may be appending right now, and every table of the previous version
 * is still on disk). Anything else — a damaged record or a VersionEdit that
 * does not decode — makes the whole MANIFEST unusable, exactly as
 * VersionSet::Recover would: a partial live set would silently hide the tables
 * added by the edits after the damage, so the caller must fall back to
 * scanning every file instead.
 *
 * @param {Buffer} file
 * @param {object} options
 * @param {string[]} options.warnings
 * @param {string} options.label
 * @returns {{ state: ManifestState|null, reason: string|null }} state is null when
 *   the MANIFEST cannot be trusted; reason then says why
 */
function replayManifest(file, { warnings, label }) {
  const liveTables = new Set();
  let logNumber = null;
  let prevLogNumber = null;
  let edits = 0;
  let badEdit = false;
  const localWarnings = [];

  const scan = readLogBuffer(file, {
    warnings: localWarnings,
    label,
    onRecord(payload, index) {
      if (badEdit) return;
      let edit;
      try {
        edit = parseVersionEdit(payload);
      } catch (err) {
        localWarnings.push(`${label}: record ${index} is not a valid VersionEdit (${err.message})`);
        badEdit = true;
        return;
      }
      for (const d of edit.deletedFiles) liveTables.delete(Number(d.file));
      for (const f of edit.newFiles) liveTables.add(Number(f.file));
      if (edit.logNumber !== undefined) logNumber = edit.logNumber;
      if (edit.prevLogNumber !== undefined) prevLogNumber = edit.prevLogNumber;
      edits++;
    },
  });

  if (badEdit || scan.corrupt || edits === 0) {
    const reason = localWarnings.length > 0
      ? localWarnings.map((w) => (w.startsWith(`${label}: `) ? w.slice(label.length + 2) : w)).join('; ')
      : 'no version edits found';
    return { state: null, reason };
  }
  warnings.push(...localWarnings);
  return { state: { liveTables, logNumber, prevLogNumber, edits }, reason: null };
}

/** @param {number} n */
function tableFileName(n) {
  return `${String(n).padStart(6, '0')}.ldb`;
}

/**
 * Look for the SSTable with file number `n` by name. The directory listing can
 * predate a flush or compaction that created it, in which case the MANIFEST
 * mentions a table the listing does not have.
 *
 * @param {string} dir
 * @param {number} n
 * @returns {Promise<string|null>} the file name, or null when neither
 *   NNNNNN.ldb nor NNNNNN.sst is there
 */
async function findTableFile(dir, n) {
  const base = String(n).padStart(6, '0');
  for (const ext of ['ldb', 'sst']) {
    const name = `${base}.${ext}`;
    try {
      if ((await stat(path.join(dir, name))).isFile()) return name;
    } catch {
      // not there (or not readable): try the next extension
    }
  }
  return null;
}

/**
 * Whether a directory entry is worth reading as a file. readdir does not follow
 * symlinks, so a link named "000005.log" that points at a FIFO, a device or a
 * file on an unreachable mount would otherwise be read: readFile() on a FIFO
 * never resolves and hangs cici forever. Resolve the link first, exactly like
 * browsers.js does for directories.
 *
 * @param {import('node:fs').Dirent} dirent
 * @param {string} dir directory the entry was listed from
 * @param {string[]} warnings
 * @returns {Promise<boolean>}
 */
async function direntIsFile(dirent, dir, warnings) {
  if (dirent.isFile()) return true;
  if (!dirent.isSymbolicLink()) return false;
  const target = path.join(dir, dirent.name);
  try {
    if ((await stat(target)).isFile()) return true;
    warnings.push(`${target} is a symlink to something that is not a regular file; ignored`);
  } catch (err) {
    // A dangling link is normal enough (a profile moved between disks); the
    // per-file read below reports it if the name matters.
    if (!err || err.code !== 'ENOENT') warnings.push(`cannot resolve the symlink ${target}: ${err.message}; ignored`);
  }
  return false;
}

/**
 * Render untrusted file content for a warning: quoted, with control characters
 * escaped, so a CURRENT file full of ANSI escapes cannot repaint the terminal
 * of whoever prints the warning.
 *
 * @param {string} s
 * @returns {string}
 */
function quoteText(s) {
  const escaped = String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.codePointAt(0).toString(16).padStart(2, '0')}`);
  return `"${escaped.length > 80 ? `${escaped.slice(0, 77)}...` : escaped}"`;
}

// ---------------------------------------------------------------------------
// readLevelDb
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LevelDbFiles
 * @property {string[]} tables absolute paths of the SSTables that were read
 * @property {string[]} logs absolute paths of the write-ahead logs that were read
 * @property {string|null} manifest absolute path of the MANIFEST that was used, or null
 */

/**
 * @typedef {object} LevelDbResult
 * @property {Map<string, Buffer>} entries latest live value per user key (keys decoded as UTF-8)
 * @property {string[]} warnings human readable problems that were tolerated
 * @property {LevelDbFiles} files
 */

/**
 * Read a LevelDB directory read-only and return the latest live value of every
 * user key. Never throws because of file contents; problems become warnings.
 *
 * @param {string} dir
 * @param {{ useManifest?: boolean }} [options] set useManifest to false to scan every table/log regardless of the MANIFEST
 * @returns {Promise<LevelDbResult>}
 */
export async function readLevelDb(dir, options = {}) {
  const useManifest = options.useManifest !== false;
  /** @type {string[]} */
  const warnings = [];
  /** @type {LevelDbFiles} */
  const files = { tables: [], logs: [], manifest: null };

  /**
   * user key (latin1, lossless) -> winning entry
   * @type {Map<string, { key: Buffer, sequence: bigint, type: number, value: Buffer|null }>}
   */
  const latest = new Map();
  const consider = (key, sequence, type, value) => {
    const id = key.toString('latin1');
    const cur = latest.get(id);
    if (cur === undefined || sequence > cur.sequence) {
      latest.set(id, { key, sequence, type, value });
    }
  };

  // --- directory listing -----------------------------------------------------
  let names;
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    const kept = await Promise.all(dirents.map((d) => direntIsFile(d, dir, warnings)));
    names = dirents.filter((_d, i) => kept[i]).map((d) => d.name);
  } catch (err) {
    warnings.push(`cannot list ${dir}: ${err.message}`);
    return { entries: new Map(), warnings, files };
  }

  /** @type {Map<number, string>} file number -> table file name */
  const tableByNumber = new Map();
  /** @type {Map<number, string>} file number -> log file name */
  const logByNumber = new Map();
  let hasCurrent = false;
  for (const name of names) {
    let m;
    if ((m = RE_TABLE.exec(name))) tableByNumber.set(Number(m[1]), name);
    else if ((m = RE_LOG.exec(name))) logByNumber.set(Number(m[1]), name);
    else if (name === 'CURRENT') hasCurrent = true;
  }

  // --- MANIFEST ------------------------------------------------------------
  let tableNumbers = [...tableByNumber.keys()].sort((a, b) => a - b);
  let logNumbers = [...logByNumber.keys()].sort((a, b) => a - b);

  if (useManifest) {
    let state = null;
    if (!hasCurrent) {
      if (tableNumbers.length > 0 || logNumbers.length > 0) {
        warnings.push(`${path.join(dir, 'CURRENT')} is missing; scanning every table and log`);
      }
    } else {
      let manifestName = null;
      try {
        manifestName = (await readFile(path.join(dir, 'CURRENT'), 'utf8')).trim();
      } catch (err) {
        warnings.push(`cannot read ${path.join(dir, 'CURRENT')}: ${err.message}; scanning every table and log`);
      }
      if (manifestName !== null) {
        const manifestPath = path.join(dir, manifestName);
        if (!RE_MANIFEST.test(manifestName) || !names.includes(manifestName)) {
          warnings.push(`CURRENT points to ${quoteText(manifestName)} which does not exist in ${dir}; scanning every table and log`);
        } else {
          let buf = null;
          try {
            buf = await readFile(manifestPath);
          } catch (err) {
            warnings.push(`cannot read ${manifestPath}: ${err.message}; scanning every table and log`);
          }
          if (buf !== null) {
            const replay = replayManifest(buf, { warnings, label: manifestPath });
            state = replay.state;
            if (state === null) {
              warnings.push(`${manifestPath}: could not be parsed (${replay.reason}); scanning every table and log`);
            } else {
              files.manifest = manifestPath;
            }
          }
        }
      }
    }

    if (state !== null) {
      // A live table can be missing from the listing when the directory moved
      // on between readdir() and reading the MANIFEST (Chrome just finished a
      // flush or compaction), so look it up by name before giving up.
      const missing = [];
      for (const n of state.liveTables) {
        if (tableByNumber.has(n)) continue;
        const name = await findTableFile(dir, n);
        if (name === null) missing.push(n);
        else {
          tableByNumber.set(n, name);
          tableNumbers = [...tableByNumber.keys()].sort((a, b) => a - b);
        }
      }

      if (missing.length > 0) {
        // The version we read is not what is on disk any more. Scanning every
        // table AND every log is a superset of any consistent version, and the
        // sequence-number rule still picks the newest value for each key —
        // whereas applying only half of this version (its tables are gone, but
        // its log_number would drop the log that still holds their contents)
        // could lose a key entirely.
        warnings.push(`${files.manifest}: live table(s) ${missing.map(tableFileName).join(', ')} are missing from ${dir}; scanning every table and log on disk`);
      } else {
        // Only the live set: anything else on disk is a stale table that has
        // not been unlinked yet (or an orphan from a crash) and may hold values
        // that a later, already compacted-away deletion superseded.
        tableNumbers = tableNumbers.filter((n) => state.liveTables.has(n));
        if (state.logNumber !== null) {
          const minLog = state.logNumber;
          const prevLog = state.prevLogNumber;
          logNumbers = logNumbers.filter((n) => BigInt(n) >= minLog || (prevLog !== null && BigInt(n) === prevLog));
        }
      }
    }
  }

  // --- SSTables --------------------------------------------------------------
  for (const n of tableNumbers) {
    const filePath = path.join(dir, tableByNumber.get(n));
    let buf;
    try {
      buf = await readFile(filePath);
    } catch (err) {
      warnings.push(`cannot read ${filePath}: ${err.message}`);
      continue;
    }
    files.tables.push(filePath);
    readTableBuffer(buf, {
      warnings,
      label: filePath,
      onEntry({ userKey, sequence, type, value }) {
        if (type === TYPE_VALUE) consider(userKey, sequence, type, value);
        else if (type === TYPE_DELETION) consider(userKey, sequence, type, null);
        // other types do not exist in LevelDB; ignore silently
      },
    });
  }

  // --- write-ahead logs ------------------------------------------------------
  for (const n of logNumbers) {
    const filePath = path.join(dir, logByNumber.get(n));
    let buf;
    try {
      buf = await readFile(filePath);
    } catch (err) {
      warnings.push(`cannot read ${filePath}: ${err.message}`);
      continue;
    }
    files.logs.push(filePath);
    readLogBuffer(buf, {
      warnings,
      label: filePath,
      onRecord(payload, index) {
        let batch;
        try {
          batch = parseWriteBatch(payload);
        } catch (err) {
          // Like DBImpl::RecoverLogFile with paranoid_checks off: report the
          // damaged batch and carry on with the following records.
          warnings.push(`${filePath}: record ${index} is not a valid write batch (${err.message}); record ignored`);
          return;
        }
        for (let i = 0; i < batch.records.length; i++) {
          const r = batch.records[i];
          consider(r.key, batch.sequence + BigInt(i), r.type, r.value);
        }
      },
    });
  }

  // --- materialise -----------------------------------------------------------
  const entries = new Map();
  for (const entry of latest.values()) {
    if (entry.type !== TYPE_VALUE || entry.value === null) continue;
    entries.set(entry.key.toString('utf8'), Buffer.from(entry.value));
  }
  return { entries, warnings, files };
}

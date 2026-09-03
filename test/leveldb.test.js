import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readLevelDb, decodeVarint32, parseInternalKey } from '../src/leveldb.js';
import {
  buildSstFile,
  writeSstFile,
  writeLogFile,
  writeManifest,
  buildLogFile,
  encodeInternalKey,
  fileNumberName,
  TABLE_MAGIC,
  FOOTER_SIZE,
  WAL_BLOCK_SIZE,
  WAL_HEADER_SIZE,
  RECORD_FULL,
  RECORD_FIRST,
  RECORD_MIDDLE,
  RECORD_LAST,
  TYPE_VALUE,
  TYPE_DELETION,
} from './helpers/leveldb-writer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const J = JSON.stringify;

// Real Chrome data on the machine that produced the expected values in the
// task description; only used by the integration test at the bottom, which
// skips itself when the directory is missing.
const REAL_CHROME_STORAGE = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Google',
  'Chrome',
  'Default',
  'Local Extension Settings',
  'fcoeoabgfenejglbffodgkkbkcdhcgfn',
);

/**
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>}
 */
async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cici-leveldb-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * @param {Map<string, Uint8Array>} entries
 * @param {string} key
 * @returns {string|undefined}
 */
function text(entries, key) {
  const v = entries.get(key);
  return v === undefined ? undefined : Buffer.from(v).toString('utf8');
}

/**
 * @param {string[]} files
 * @returns {string[]}
 */
const basenames = (files) => files.map((f) => path.basename(f));

/**
 * @typedef {object} DbSpec
 * @property {Array<{ number: number, entries: import('./helpers/leveldb-writer.js').SstEntry[], options?: object, ext?: 'ldb'|'sst', level?: number, stale?: boolean }>} [tables]
 * @property {Array<{ number: number, batches: import('./helpers/leveldb-writer.js').LogBatch[], options?: object }>} [logs]
 * @property {boolean} [manifest] write CURRENT + MANIFEST (default true)
 * @property {number} [logNumber]
 * @property {Array<{ level: number, number: number }>} [deletedTables]
 */

/**
 * Write a complete database directory: tables, logs and (unless disabled) a
 * MANIFEST whose live set is every table not marked `stale`.
 * @param {import('node:test').TestContext} t
 * @param {DbSpec} spec
 */
async function makeDb(t, spec) {
  const dir = await tmpDir(t);
  const live = [];
  const stale = [];
  let lastSequence = 0n;
  for (const tbl of spec.tables ?? []) {
    const file = path.join(dir, `${fileNumberName(tbl.number)}.${tbl.ext ?? 'ldb'}`);
    const r = await writeSstFile(file, tbl.entries, tbl.options ?? {});
    const meta = { level: tbl.level ?? 0, number: tbl.number, size: r.size, smallest: r.smallest ?? 'a', largest: r.largest ?? 'a' };
    (tbl.stale ? stale : live).push(meta);
    for (const e of tbl.entries) if (BigInt(e.sequence) > lastSequence) lastSequence = BigInt(e.sequence);
  }
  let maxLog = 0;
  for (const log of spec.logs ?? []) {
    await writeLogFile(path.join(dir, `${fileNumberName(log.number)}.log`), log.batches, log.options ?? {});
    maxLog = Math.max(maxLog, log.number);
    for (const b of log.batches) {
      const last = BigInt(b.sequence) + BigInt(Math.max(0, b.records.length - 1));
      if (last > lastSequence) lastSequence = last;
    }
  }
  if (spec.manifest !== false) {
    const deletedTables = spec.deletedTables ? stale.filter((s) => spec.deletedTables.some((d) => d.number === s.number)) : [];
    await writeManifest(dir, {
      logNumber: spec.logNumber ?? (maxLog || Math.max(0, ...live.map((l) => l.number), ...stale.map((s) => s.number)) + 1),
      lastSequence,
      liveTables: live,
      deletedTables,
    });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// helpers exported by the reader

test('decodeVarint32 decodes 1..5 byte varints at an offset', () => {
  assert.deepEqual(decodeVarint32(Buffer.from([0x00]), 0), { value: 0, next: 1 });
  assert.deepEqual(decodeVarint32(Buffer.from([0x7f]), 0), { value: 127, next: 1 });
  assert.deepEqual(decodeVarint32(Buffer.from([0x80, 0x01]), 0), { value: 128, next: 2 });
  assert.deepEqual(decodeVarint32(Buffer.from([0xac, 0x02]), 0), { value: 300, next: 2 });
  assert.deepEqual(decodeVarint32(Buffer.from([0xff, 0xe5, 0x8e, 0x26, 0xff]), 1), { value: 624485, next: 4 });
  assert.deepEqual(decodeVarint32(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f]), 0), { value: 0xffffffff, next: 5 });
});

test('parseInternalKey splits user key, sequence (bigint) and type', () => {
  const value = parseInternalKey(encodeInternalKey('bridgeDeviceId', 12345n, TYPE_VALUE));
  assert.equal(Buffer.from(value.userKey).toString('utf8'), 'bridgeDeviceId');
  assert.equal(typeof value.sequence, 'bigint');
  assert.equal(value.sequence, 12345n);
  assert.equal(value.type, TYPE_VALUE);

  const big = 1n << 40n;
  const del = parseInternalKey(encodeInternalKey(Buffer.from([0xff, 0x00, 0x7f]), big, TYPE_DELETION));
  assert.deepEqual([...Buffer.from(del.userKey)], [0xff, 0x00, 0x7f]);
  assert.equal(del.sequence, big);
  assert.equal(del.type, TYPE_DELETION);

  // an empty user key is legal
  const empty = parseInternalKey(encodeInternalKey('', 1, TYPE_VALUE));
  assert.equal(Buffer.from(empty.userKey).length, 0);
  assert.equal(empty.sequence, 1n);
});

// ---------------------------------------------------------------------------
// (1) single uncompressed .ldb

test('reads a single uncompressed .ldb', async (t) => {
  const uuid = '11111111-2222-4333-8444-555555555555';
  const dir = await makeDb(t, {
    tables: [
      {
        number: 5,
        entries: [
          { key: 'bridgeDeviceId', sequence: 3, type: TYPE_VALUE, value: J(uuid) },
          { key: 'bridgeDisplayName', sequence: 4, type: TYPE_VALUE, value: J('My Laptop') },
          { key: 'someOtherSetting', sequence: 5, type: TYPE_VALUE, value: J({ enabled: true, n: 1 }) },
        ],
        options: { compression: 'none' },
      },
    ],
  });
  const file = await fs.readFile(path.join(dir, '000005.ldb'));
  assert.ok(file.subarray(file.length - 8).equals(TABLE_MAGIC), 'fixture has the LevelDB footer magic');
  assert.ok(file.length > FOOTER_SIZE);

  const db = await readLevelDb(dir);
  assert.ok(db.entries instanceof Map);
  assert.equal(db.entries.size, 3);
  assert.equal(text(db.entries, 'bridgeDeviceId'), J(uuid));
  assert.equal(JSON.parse(text(db.entries, 'bridgeDeviceId')), uuid);
  assert.equal(text(db.entries, 'bridgeDisplayName'), J('My Laptop'));
  assert.deepEqual(JSON.parse(text(db.entries, 'someOtherSetting')), { enabled: true, n: 1 });
  assert.deepEqual(db.warnings, []);
  assert.ok(basenames(db.files.tables).includes('000005.ldb'));
  assert.deepEqual(db.files.logs, []);
  assert.equal(typeof db.files.manifest, 'string');
  assert.ok(db.files.manifest.endsWith('MANIFEST-000001'));
});

test('values are raw Buffers and keys are decoded as UTF-8 strings', async (t) => {
  const dir = await makeDb(t, {
    tables: [
      {
        number: 5,
        entries: [
          { key: '한글키', sequence: 1, type: TYPE_VALUE, value: J('한글 값') },
          { key: 'binary', sequence: 2, type: TYPE_VALUE, value: Buffer.from([0x00, 0xff, 0x10, 0x80]) },
          { key: 'empty', sequence: 3, type: TYPE_VALUE, value: '' },
        ],
        options: { compression: 'snappy' },
      },
    ],
  });
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, '한글키'), J('한글 값'));
  assert.ok(Buffer.isBuffer(db.entries.get('binary')), 'value should be a Buffer');
  assert.deepEqual([...db.entries.get('binary')], [0x00, 0xff, 0x10, 0x80]);
  assert.equal(db.entries.get('empty').length, 0);
  assert.equal(db.entries.size, 3);
});

test('an .sst file is read like an .ldb file', async (t) => {
  const dir = await makeDb(t, {
    tables: [{ number: 9, ext: 'sst', entries: [{ key: 'k', sequence: 1, type: TYPE_VALUE, value: J('v') }] }],
  });
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'k'), J('v'));
  assert.ok(basenames(db.files.tables).includes('000009.sst'));
});

test('an empty directory yields no entries and does not throw', async (t) => {
  const dir = await tmpDir(t);
  const db = await readLevelDb(dir, { useManifest: false });
  assert.equal(db.entries.size, 0);
  assert.deepEqual(db.files.tables, []);
  assert.deepEqual(db.files.logs, []);
});

// ---------------------------------------------------------------------------
// (2) snappy block where the key bytes exist only as a back-reference

test('snappy .ldb: key that only exists as a back-reference inside the block', async (t) => {
  const uuid = '0f0f0f0f-1111-4222-8333-444444444444';
  // Earlier values contain the two halves of the key, so the compressor emits
  // the key "bridgeDeviceId" as two copy elements and the bytes never appear
  // contiguously anywhere in the file.
  const dir = await makeDb(t, {
    tables: [
      {
        number: 12,
        entries: [
          { key: 'a1', sequence: 1, type: TYPE_VALUE, value: J('bridgeDev') },
          { key: 'a2', sequence: 2, type: TYPE_VALUE, value: J('iceId') },
          { key: 'bridgeDeviceId', sequence: 3, type: TYPE_VALUE, value: J(uuid) },
        ],
        options: { compression: 'snappy' },
      },
    ],
  });
  const raw = await fs.readFile(path.join(dir, '000012.ldb'));
  assert.equal(raw.indexOf('bridgeDeviceId'), -1, 'premise: key must not be present as contiguous bytes');
  assert.equal(raw.indexOf(uuid), -1, 'premise: block should be compressed, uuid not stored as-is either');

  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'bridgeDeviceId'), J(uuid));
  assert.equal(text(db.entries, 'a1'), J('bridgeDev'));
  assert.equal(text(db.entries, 'a2'), J('iceId'));
  assert.deepEqual(db.warnings, []);
});

test('snappy .ldb: many similar JSON values', async (t) => {
  const entries = [];
  for (let i = 0; i < 120; i++) {
    entries.push({ key: `setting.${i}`, sequence: 1000 + i, type: TYPE_VALUE, value: J({ enabled: i % 2 === 0, label: `label ${i}` }) });
  }
  const dir = await makeDb(t, { tables: [{ number: 3, entries, options: { compression: 'snappy' } }] });
  const db = await readLevelDb(dir);
  assert.equal(db.entries.size, 120);
  assert.deepEqual(JSON.parse(text(db.entries, 'setting.7')), { enabled: false, label: 'label 7' });
  assert.deepEqual(JSON.parse(text(db.entries, 'setting.118')), { enabled: true, label: 'label 118' });
});

// ---------------------------------------------------------------------------
// (3) sequence numbers decide, not file type

test('newer value in .log overrides older .ldb value', async (t) => {
  const dir = await makeDb(t, {
    tables: [
      {
        number: 5,
        entries: [
          { key: 'bridgeDeviceId', sequence: 5, type: TYPE_VALUE, value: J('old-id') },
          { key: 'untouched', sequence: 6, type: TYPE_VALUE, value: J('same') },
        ],
      },
    ],
    logs: [{ number: 6, batches: [{ sequence: 10, records: [{ type: TYPE_VALUE, key: 'bridgeDeviceId', value: J('new-id') }] }] }],
  });
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'bridgeDeviceId'), J('new-id'));
  assert.equal(text(db.entries, 'untouched'), J('same'));
  assert.equal(db.entries.size, 2);
  assert.ok(basenames(db.files.logs).includes('000006.log'));
});

test('older value in .log does not override newer .ldb value', async (t) => {
  const dir = await makeDb(t, {
    tables: [{ number: 5, entries: [{ key: 'bridgeDeviceId', sequence: 50, type: TYPE_VALUE, value: J('table-wins') }] }],
    logs: [{ number: 6, batches: [{ sequence: 7, records: [{ type: TYPE_VALUE, key: 'bridgeDeviceId', value: J('log-loses') }] }] }],
  });
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'bridgeDeviceId'), J('table-wins'));
});

test('record i of a write batch has sequence base + i', async (t) => {
  // table: a@11, c@11 ; log batch base 10: a@10, b@11, c@12
  const dir = await makeDb(t, {
    tables: [
      {
        number: 5,
        entries: [
          { key: 'a', sequence: 11, type: TYPE_VALUE, value: J('a-table') },
          { key: 'c', sequence: 11, type: TYPE_VALUE, value: J('c-table') },
        ],
      },
    ],
    logs: [
      {
        number: 6,
        batches: [
          {
            sequence: 10,
            records: [
              { type: TYPE_VALUE, key: 'a', value: J('a-log') },
              { type: TYPE_VALUE, key: 'b', value: J('b-log') },
              { type: TYPE_VALUE, key: 'c', value: J('c-log') },
            ],
          },
        ],
      },
    ],
  });
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'a'), J('a-table'), 'a@10 in log loses to a@11 in table');
  assert.equal(text(db.entries, 'b'), J('b-log'));
  assert.equal(text(db.entries, 'c'), J('c-log'), 'c@12 in log beats c@11 in table');
});

test('across two tables the highest sequence wins', async (t) => {
  const dir = await makeDb(t, {
    tables: [
      { number: 5, entries: [{ key: 'k', sequence: 5, type: TYPE_VALUE, value: J('five') }] },
      { number: 8, entries: [{ key: 'k', sequence: 9, type: TYPE_VALUE, value: J('nine') }] },
    ],
  });
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'k'), J('nine'));
});

// ---------------------------------------------------------------------------
// (4) deletions

test('deletion in .log removes an .ldb key', async (t) => {
  const dir = await makeDb(t, {
    tables: [
      {
        number: 5,
        entries: [
          { key: 'bridgeDeviceId', sequence: 5, type: TYPE_VALUE, value: J('gone-soon') },
          { key: 'bridgeDisplayName', sequence: 6, type: TYPE_VALUE, value: J('kept') },
        ],
      },
    ],
    logs: [{ number: 6, batches: [{ sequence: 9, records: [{ type: TYPE_DELETION, key: 'bridgeDeviceId' }] }] }],
  });
  const db = await readLevelDb(dir);
  assert.equal(db.entries.has('bridgeDeviceId'), false);
  assert.equal(text(db.entries, 'bridgeDisplayName'), J('kept'));
  assert.equal(db.entries.size, 1);
});

test('a deletion older than the value does not remove it', async (t) => {
  const dir = await makeDb(t, {
    tables: [{ number: 5, entries: [{ key: 'k', sequence: 20, type: TYPE_VALUE, value: J('alive') }] }],
    logs: [{ number: 6, batches: [{ sequence: 3, records: [{ type: TYPE_DELETION, key: 'k' }] }] }],
  });
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'k'), J('alive'));
});

test('delete then re-add inside one log yields the re-added value', async (t) => {
  const dir = await makeDb(t, {
    logs: [
      {
        number: 4,
        batches: [
          { sequence: 1, records: [{ type: TYPE_VALUE, key: 'k', value: J('first') }] },
          { sequence: 2, records: [{ type: TYPE_DELETION, key: 'k' }] },
          { sequence: 3, records: [{ type: TYPE_VALUE, key: 'k', value: J('second') }] },
        ],
      },
    ],
  });
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'k'), J('second'));
});

// ---------------------------------------------------------------------------
// (5) multi-block table with prefix-compressed keys

test('multi-block .ldb with small blocks, restart points and prefix compression', async (t) => {
  const entries = [];
  for (let i = 0; i < 300; i++) {
    entries.push({ key: `pref/key/${String(i).padStart(3, '0')}`, sequence: 1000 + i, type: TYPE_VALUE, value: J(`value-${i}`) });
  }
  // several versions of one key inside the same table: newest wins
  entries.push({ key: 'pref/key/050', sequence: 5000, type: TYPE_VALUE, value: J('newest-050') });
  entries.push({ key: 'pref/key/050', sequence: 4000, type: TYPE_VALUE, value: J('middle-050') });
  // a tombstone newer than the value: key is gone
  entries.push({ key: 'pref/key/060', sequence: 5001, type: TYPE_DELETION });
  // a tombstone older than the value: key stays
  entries.push({ key: 'pref/key/070', sequence: 2, type: TYPE_DELETION });

  for (const compression of ['none', 'snappy']) {
    const options = { compression, blockSize: 128, restartInterval: 4 };
    const built = buildSstFile(entries, options);
    assert.ok(built.dataBlocks > 20, `premise (${compression}): fixture has many data blocks, got ${built.dataBlocks}`);
    const dir = await makeDb(t, { tables: [{ number: 21, entries, options }] });

    const db = await readLevelDb(dir);
    assert.equal(db.entries.size, 299, `${compression}: 300 keys minus one deleted`);
    assert.equal(text(db.entries, 'pref/key/000'), J('value-0'), compression);
    assert.equal(text(db.entries, 'pref/key/299'), J('value-299'), compression);
    assert.equal(text(db.entries, 'pref/key/123'), J('value-123'), compression);
    assert.equal(text(db.entries, 'pref/key/050'), J('newest-050'), compression);
    assert.equal(db.entries.has('pref/key/060'), false, compression);
    assert.equal(text(db.entries, 'pref/key/070'), J('value-70'), compression);
    assert.deepEqual(db.warnings, [], compression);
  }
});

test('restart interval 1 (no prefix compression) is also fine', async (t) => {
  const entries = Array.from({ length: 40 }, (_, i) => ({ key: `same-prefix-${i}`, sequence: i + 1, type: TYPE_VALUE, value: J(i) }));
  const dir = await makeDb(t, { tables: [{ number: 2, entries, options: { restartInterval: 1, blockSize: 200, compression: 'snappy' } }] });
  const db = await readLevelDb(dir);
  assert.equal(db.entries.size, 40);
  assert.equal(text(db.entries, 'same-prefix-39'), '39');
});

// ---------------------------------------------------------------------------
// (6) WAL records fragmented across 32 KiB blocks

test('WAL record fragmented FIRST/MIDDLE/LAST across 32 KiB blocks', async (t) => {
  const big = 'x'.repeat(70000);
  const dir = await makeDb(t, {
    logs: [
      {
        number: 4,
        batches: [
          { sequence: 1, records: [{ type: TYPE_VALUE, key: 'big', value: big }] },
          { sequence: 2, records: [{ type: TYPE_VALUE, key: 'after', value: J('after the big one') }] },
        ],
      },
    ],
  });
  const raw = await fs.readFile(path.join(dir, '000004.log'));
  assert.equal(raw[6], RECORD_FIRST, 'premise: first physical record is FIRST');
  assert.equal(raw[WAL_BLOCK_SIZE + 6], RECORD_MIDDLE, 'premise: second block starts with MIDDLE');
  assert.equal(raw[2 * WAL_BLOCK_SIZE + 6], RECORD_LAST, 'premise: third block starts with LAST');

  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'big'), big);
  assert.equal(text(db.entries, 'after'), J('after the big one'));
  assert.deepEqual(db.warnings, []);
});

test('WAL record forced into FIRST/MIDDLE/LAST fragments inside one block', async (t) => {
  const dir = await makeDb(t, {
    logs: [
      {
        number: 4,
        batches: [
          { sequence: 1, records: [{ type: TYPE_VALUE, key: 'bridgeDeviceId', value: J('frag-id') }] },
          { sequence: 2, records: [{ type: TYPE_VALUE, key: 'bridgeDisplayName', value: J('frag-name') }] },
        ],
        options: { forceFragment: true, fragmentSize: 5 },
      },
    ],
  });
  const raw = await fs.readFile(path.join(dir, '000004.log'));
  assert.equal(raw[6], RECORD_FIRST, 'premise: forced fragmentation starts with FIRST');
  assert.equal(raw[WAL_HEADER_SIZE + 5 + 6], RECORD_MIDDLE, 'premise: second fragment is MIDDLE');

  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'bridgeDeviceId'), J('frag-id'));
  assert.equal(text(db.entries, 'bridgeDisplayName'), J('frag-name'));
});

test('WAL block trailer shorter than a header is padding, next record starts in the next block', async (t) => {
  // batch header 12 + type 1 + keylen 1 + key 1 + vallen varint 3 + value = 32758 bytes payload,
  // which leaves 32768 - 7 - 32758 = 3 bytes in the block: too small for a header.
  const value = 'p'.repeat(32758 - 12 - 1 - 1 - 1 - 3);
  const dir = await makeDb(t, {
    logs: [
      {
        number: 4,
        batches: [
          { sequence: 1, records: [{ type: TYPE_VALUE, key: 'k', value }] },
          { sequence: 2, records: [{ type: TYPE_VALUE, key: 'z', value: J('next block') }] },
        ],
      },
    ],
  });
  const raw = await fs.readFile(path.join(dir, '000004.log'));
  assert.equal(raw.readUInt16LE(4), 32758, 'premise: first record payload length');
  assert.equal(raw[6], RECORD_FULL);
  assert.ok(raw.subarray(WAL_BLOCK_SIZE - 3, WAL_BLOCK_SIZE).equals(Buffer.alloc(3)), 'premise: 3 zero padding bytes');
  assert.equal(raw[WAL_BLOCK_SIZE + 6], RECORD_FULL, 'premise: second record starts at the next block');

  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'k'), value);
  assert.equal(text(db.entries, 'z'), J('next block'));
  assert.deepEqual(db.warnings, []);
});

// ---------------------------------------------------------------------------
// (7) truncated trailing WAL record

test('truncated trailing WAL record: warning, earlier records still returned', async (t) => {
  const dir = await makeDb(t, {
    logs: [
      {
        number: 4,
        batches: [
          { sequence: 1, records: [{ type: TYPE_VALUE, key: 'bridgeDeviceId', value: J('intact') }] },
          { sequence: 2, records: [{ type: TYPE_VALUE, key: 'partial', value: 'q'.repeat(5000) }] },
        ],
      },
    ],
  });
  const logPath = path.join(dir, '000004.log');
  const raw = await fs.readFile(logPath);
  const firstLen = WAL_HEADER_SIZE + raw.readUInt16LE(4);
  // keep the whole first record plus the second record's header and half of its payload
  await fs.truncate(logPath, firstLen + WAL_HEADER_SIZE + 2500);

  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'bridgeDeviceId'), J('intact'));
  assert.equal(db.entries.has('partial'), false);
  assert.ok(db.warnings.length >= 1, 'a truncated record should produce a warning');
});

test('WAL cut inside a record header: earlier records still returned, no throw', async (t) => {
  const dir = await makeDb(t, {
    logs: [
      {
        number: 4,
        batches: [
          { sequence: 1, records: [{ type: TYPE_VALUE, key: 'first', value: J(1) }] },
          { sequence: 2, records: [{ type: TYPE_VALUE, key: 'second', value: J(2) }] },
        ],
      },
    ],
  });
  const logPath = path.join(dir, '000004.log');
  const raw = await fs.readFile(logPath);
  const firstLen = WAL_HEADER_SIZE + raw.readUInt16LE(4);
  await fs.truncate(logPath, firstLen + 3);

  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'first'), '1');
  assert.equal(db.entries.has('second'), false);
});

test('truncated fragmented WAL record drops only that record', async (t) => {
  const big = 'y'.repeat(70000);
  const dir = await makeDb(t, {
    logs: [
      {
        number: 4,
        batches: [
          { sequence: 1, records: [{ type: TYPE_VALUE, key: 'ok', value: J('ok') }] },
          { sequence: 2, records: [{ type: TYPE_VALUE, key: 'big', value: big }] },
        ],
      },
    ],
  });
  const logPath = path.join(dir, '000004.log');
  // cut in the middle of the MIDDLE fragment (second block)
  await fs.truncate(logPath, WAL_BLOCK_SIZE + 1000);
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'ok'), J('ok'));
  assert.equal(db.entries.has('big'), false);
  assert.ok(db.warnings.length >= 1);
});

test('zero-filled tail (pre-allocated space) after the last record is ignored', async (t) => {
  const dir = await makeDb(t, {
    logs: [
      {
        number: 4,
        batches: [{ sequence: 1, records: [{ type: TYPE_VALUE, key: 'k', value: J('v') }] }],
        options: { trailingZeros: 4096 },
      },
    ],
  });
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'k'), J('v'));
  assert.equal(db.entries.size, 1);
});

test('a corrupt .log (garbage bytes) does not throw and other files are still read', async (t) => {
  const dir = await makeDb(t, {
    tables: [{ number: 5, entries: [{ key: 'fromTable', sequence: 1, type: TYPE_VALUE, value: J('t') }] }],
    logNumber: 6,
  });
  const garbage = Buffer.alloc(3000);
  for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 131 + 17) & 0xff;
  await fs.writeFile(path.join(dir, '000006.log'), garbage);
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'fromTable'), J('t'));
});

test('a corrupt .ldb (garbage bytes) does not throw and other files are still read', async (t) => {
  const dir = await makeDb(t, {
    tables: [{ number: 5, entries: [{ key: 'good', sequence: 1, type: TYPE_VALUE, value: J('g') }] }],
    manifest: false,
  });
  const garbage = Buffer.alloc(2000);
  for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 71 + 5) & 0xff;
  await fs.writeFile(path.join(dir, '000007.ldb'), garbage);
  const db = await readLevelDb(dir, { useManifest: false });
  assert.equal(text(db.entries, 'good'), J('g'));
  assert.ok(db.warnings.length >= 1, 'corrupt table should be reported');
});

// ---------------------------------------------------------------------------
// (8) MANIFEST decides which tables and logs are live

/**
 * @param {import('node:test').TestContext} t
 * @param {{ viaDeletedEdit: boolean }} opts
 */
async function makeManifestDb(t, { viaDeletedEdit }) {
  return makeDb(t, {
    tables: [
      {
        number: 5,
        entries: [
          { key: 'bridgeDeviceId', sequence: 20, type: TYPE_VALUE, value: J('LIVE') },
          { key: 'onlyInLive', sequence: 21, type: TYPE_VALUE, value: J(1) },
        ],
      },
      {
        number: 7,
        stale: true,
        entries: [
          // higher sequence than the live table: only wins if the stale table is wrongly read
          { key: 'bridgeDeviceId', sequence: 50, type: TYPE_VALUE, value: J('STALE-TABLE') },
          { key: 'onlyInStale', sequence: 51, type: TYPE_VALUE, value: J(1) },
        ],
      },
    ],
    logs: [
      { number: 8, batches: [{ sequence: 60, records: [{ type: TYPE_VALUE, key: 'fromLog', value: J('log') }] }] },
      // number < log_number: obsolete
      { number: 2, batches: [{ sequence: 70, records: [{ type: TYPE_VALUE, key: 'bridgeDeviceId', value: J('STALE-LOG') }] }] },
    ],
    logNumber: 8,
    deletedTables: viaDeletedEdit ? [{ level: 0, number: 7 }] : undefined,
  });
}

test('MANIFEST: tables and logs not in the live set are ignored', async (t) => {
  const dir = await makeManifestDb(t, { viaDeletedEdit: false });
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'bridgeDeviceId'), J('LIVE'));
  assert.equal(text(db.entries, 'onlyInLive'), '1');
  assert.equal(db.entries.has('onlyInStale'), false, 'stale table must be ignored');
  assert.equal(text(db.entries, 'fromLog'), J('log'));
  assert.ok(basenames(db.files.tables).includes('000005.ldb'));
  assert.ok(basenames(db.files.logs).includes('000008.log'));
  assert.equal(typeof db.files.manifest, 'string');
});

test('MANIFEST: a table added by one edit and deleted by a later edit is stale', async (t) => {
  const dir = await makeManifestDb(t, { viaDeletedEdit: true });
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'bridgeDeviceId'), J('LIVE'));
  assert.equal(db.entries.has('onlyInStale'), false);
  assert.equal(text(db.entries, 'fromLog'), J('log'));
});

test('MANIFEST: useManifest:false scans every file instead', async (t) => {
  const dir = await makeManifestDb(t, { viaDeletedEdit: false });
  const db = await readLevelDb(dir, { useManifest: false });
  assert.equal(text(db.entries, 'bridgeDeviceId'), J('STALE-LOG'), 'highest sequence across all files');
  assert.equal(text(db.entries, 'onlyInStale'), '1');
  assert.equal(text(db.entries, 'onlyInLive'), '1');
  assert.equal(text(db.entries, 'fromLog'), J('log'));
  assert.ok(basenames(db.files.tables).includes('000007.ldb'));
  assert.ok(basenames(db.files.logs).includes('000002.log'));
});

test('MANIFEST: a multi-edit manifest is applied in order', async (t) => {
  const dir = await tmpDir(t);
  const a = await writeSstFile(path.join(dir, '000003.ldb'), [{ key: 'k', sequence: 1, type: TYPE_VALUE, value: J('from-3') }]);
  const b = await writeSstFile(path.join(dir, '000004.ldb'), [{ key: 'k', sequence: 2, type: TYPE_VALUE, value: J('from-4') }]);
  const c = await writeSstFile(path.join(dir, '000006.ldb'), [{ key: 'k', sequence: 3, type: TYPE_VALUE, value: J('from-6') }]);
  const meta = (n, r) => ({ level: 0, number: n, size: r.size, smallest: r.smallest, largest: r.largest });
  await writeManifest(dir, {
    edits: [
      { comparator: 'leveldb.BytewiseComparator', logNumber: 2, nextFileNumber: 3, lastSequence: 0 },
      { logNumber: 5, nextFileNumber: 6, lastSequence: 2, newFiles: [meta(3, a), meta(4, b)] },
      // compaction: 3 and 4 merged into 6 -- but 6 is what we want NOT to see, so delete it right away
      { logNumber: 7, nextFileNumber: 8, lastSequence: 3, newFiles: [meta(6, c)] },
      { deletedFiles: [{ level: 0, number: 6 }], lastSequence: 3 },
    ],
  });
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'k'), J('from-4'), 'file 6 was deleted by the last edit; 4 beats 3 by sequence');
});

// ---------------------------------------------------------------------------
// (9) fallback when the manifest is unusable

test('missing CURRENT: falls back to scanning every file and warns', async (t) => {
  const dir = await makeDb(t, {
    tables: [
      { number: 5, entries: [{ key: 'a', sequence: 1, type: TYPE_VALUE, value: J('a') }] },
      { number: 7, entries: [{ key: 'b', sequence: 2, type: TYPE_VALUE, value: J('b') }] },
    ],
    manifest: false,
  });
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'a'), J('a'));
  assert.equal(text(db.entries, 'b'), J('b'));
  assert.ok(db.warnings.length >= 1, 'fallback should be reported');
  assert.ok(db.warnings.some((w) => /current|manifest/i.test(w)), `warning should mention CURRENT/MANIFEST: ${JSON.stringify(db.warnings)}`);
  assert.equal(db.files.manifest, null);
});

test('CURRENT pointing at a missing MANIFEST: falls back to scanning and warns', async (t) => {
  const dir = await makeDb(t, {
    tables: [
      { number: 5, entries: [{ key: 'a', sequence: 1, type: TYPE_VALUE, value: J('a') }] },
      { number: 7, entries: [{ key: 'b', sequence: 2, type: TYPE_VALUE, value: J('b') }] },
    ],
    manifest: false,
  });
  await fs.writeFile(path.join(dir, 'CURRENT'), 'MANIFEST-000042\n');
  const db = await readLevelDb(dir);
  assert.equal(text(db.entries, 'a'), J('a'));
  assert.equal(text(db.entries, 'b'), J('b'));
  assert.ok(db.warnings.some((w) => /current|manifest/i.test(w)), `warning should mention CURRENT/MANIFEST: ${JSON.stringify(db.warnings)}`);
});

// ---------------------------------------------------------------------------
// (10) unsupported (zstd) block

test('zstd block: warning, other blocks still read', async (t) => {
  const entries = [];
  for (let i = 0; i < 90; i++) entries.push({ key: `k${String(i).padStart(3, '0')}`, sequence: 1 + i, type: TYPE_VALUE, value: J(`v${i}`) });
  const blockSize = 160;

  // control: identical layout, every block snappy
  const controlDir = await makeDb(t, { tables: [{ number: 5, entries, options: { compression: 'snappy', blockSize } }] });
  const control = await readLevelDb(controlDir);
  assert.equal(control.entries.size, 90);

  const options = { blockSize, compression: ({ kind, index }) => (kind === 'data' && index === 1 ? 'zstd' : 'snappy') };
  const built = buildSstFile(entries, options);
  assert.ok(built.dataBlocks >= 3, `premise: need at least 3 data blocks, got ${built.dataBlocks}`);
  const dir = await makeDb(t, { tables: [{ number: 5, entries, options }] });

  const db = await readLevelDb(dir);
  assert.ok(db.warnings.length >= 1, 'unsupported block should produce a warning');
  assert.ok(db.entries.size > 0, 'other blocks are still read');
  assert.ok(db.entries.size < 90, 'the zstd block is skipped');
  assert.equal(text(db.entries, 'k000'), J('v0'), 'first block readable');
  assert.equal(text(db.entries, 'k089'), J('v89'), 'last block readable');
  for (const [key, value] of db.entries) {
    assert.equal(Buffer.from(value).toString('utf8'), text(control.entries, key), `value of ${key} matches control`);
  }
});

test('an .ldb without the footer magic is reported, not thrown', async (t) => {
  const dir = await makeDb(t, {
    tables: [{ number: 5, entries: [{ key: 'good', sequence: 1, type: TYPE_VALUE, value: J('g') }] }],
    manifest: false,
  });
  const raw = await fs.readFile(path.join(dir, '000005.ldb'));
  const broken = Buffer.from(raw);
  broken.fill(0, broken.length - 8);
  await fs.writeFile(path.join(dir, '000006.ldb'), broken);
  const db = await readLevelDb(dir, { useManifest: false });
  assert.equal(text(db.entries, 'good'), J('g'));
  assert.ok(db.warnings.length >= 1);
});

// ---------------------------------------------------------------------------
// (11) real Chrome data (only on the machine that has it)

test('integration: real Claude in Chrome storage has a UUID-shaped bridgeDeviceId', async (t) => {
  let exists = false;
  try {
    exists = (await fs.stat(REAL_CHROME_STORAGE)).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    t.skip(`no Chrome profile storage at ${REAL_CHROME_STORAGE}`);
    return;
  }
  const db = await readLevelDb(REAL_CHROME_STORAGE);
  const raw = text(db.entries, 'bridgeDeviceId');
  assert.ok(raw !== undefined, 'bridgeDeviceId should be present');
  const parsed = JSON.parse(raw);
  assert.equal(typeof parsed, 'string');
  assert.match(parsed, UUID_RE);
  const name = text(db.entries, 'bridgeDisplayName');
  if (name !== undefined) assert.equal(typeof JSON.parse(name), 'string');
  assert.ok(db.files.tables.length + db.files.logs.length > 0);
});

// keep the helper import list honest: buildLogFile is used to double check the
// writer's own framing in-process, which other tests rely on as a premise
test('helper sanity: buildLogFile framing', () => {
  const buf = buildLogFile([{ sequence: 7, records: [{ type: TYPE_VALUE, key: 'k', value: 'v' }] }]);
  assert.equal(buf.readUInt16LE(4), 12 + 1 + 1 + 1 + 1 + 1);
  assert.equal(buf[6], RECORD_FULL);
  assert.equal(buf.readBigUInt64LE(WAL_HEADER_SIZE), 7n);
  assert.equal(buf.readUInt32LE(WAL_HEADER_SIZE + 8), 1);
});

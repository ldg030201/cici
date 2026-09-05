/**
 * Tests for src/leveldb-core.js: the parser with no platform imports, the half
 * a browser extension can load as-is.
 *
 * Two things are checked here that leveldb.test.js cannot check, because it
 * always goes through the node:fs adapter:
 *   (a) the core really is portable — no node: imports, no Buffer, no process,
 *       and it still parses with those globals removed;
 *   (b) readLevelDbFrom() produces the same results over a byte source that is
 *       nothing but a Map of names to plain Uint8Arrays, which is exactly the
 *       shape a file:// fetch gives an extension.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readLevelDbFrom,
  readTableBuffer,
  readLogBuffer,
  parseWriteBatch,
  parseVersionEdit,
  parseInternalKey,
  decodeVarint32,
  decodeVarint64,
} from '../src/leveldb-core.js';
import { readLevelDb } from '../src/leveldb.js';
import {
  buildSstFile,
  buildLogFile,
  buildManifest,
  encodeInternalKey,
  fileNumberName,
  DEFAULT_COMPARATOR,
  TYPE_VALUE,
  TYPE_DELETION,
} from './helpers/leveldb-writer.js';

const J = JSON.stringify;
const UUID = '11111111-2222-4333-8444-555555555555';
const OLD_UUID = '99999999-8888-4777-8666-555555555555';

const decoder = new TextDecoder();
/** @param {Uint8Array|undefined} bytes */
const utf8 = (bytes) => (bytes === undefined ? undefined : decoder.decode(bytes));

/**
 * A copy as a plain Uint8Array, never the writer's own byte container: the
 * core must not depend on anything a Node Buffer adds on top of Uint8Array.
 *
 * @param {Uint8Array} x
 * @returns {Uint8Array}
 */
function plain(x) {
  const out = new Uint8Array(x.length);
  out.set(x);
  return out;
}

/** @param {string} name file under src/ */
function readSource(name) {
  return fs.readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
}

// ---------------------------------------------------------------------------
// (a) the core is portable
// ---------------------------------------------------------------------------

const PORTABLE_MODULES = ['leveldb-core.js', 'snappy.js'];

/** Things that only exist under Node, in any form, comments included. */
const FORBIDDEN = [
  ['a node: module specifier', /node:/],
  ['require()', /\brequire\s*\(/],
  ['Buffer', /\bBuffer\b/],
  ['process', /\bprocess\b/],
  ['__dirname', /\b__dirname\b/],
  ['__filename', /\b__filename\b/],
  // Not Node-only, but the only plausible way to smuggle the above past the
  // checks above, so it is banned outright.
  ['globalThis', /\bglobalThis\b/],
];

test('the portable modules mention nothing that only exists under Node', async () => {
  for (const name of PORTABLE_MODULES) {
    const src = await readSource(name);
    for (const [what, re] of FORBIDDEN) {
      assert.equal(re.test(src), false, `src/${name} must not mention ${what}`);
    }
  }
});

test('the portable modules import nothing but each other', async () => {
  const specifiers = async (name) =>
    [...(await readSource(name)).matchAll(/\bfrom\s+'([^']*)'/g)].map((m) => m[1]);

  assert.deepEqual(await specifiers('leveldb-core.js'), ['./snappy.js']);
  assert.deepEqual(await specifiers('snappy.js'), []);
  for (const name of PORTABLE_MODULES) {
    // no dynamic import() either, which would sidestep the check above
    assert.equal(/\bimport\s*\(/.test(await readSource(name)), false, `src/${name} must not use import()`);
  }
});

test('the parser still works with Buffer and process removed from globalThis', () => {
  const table = plain(buildSstFile(
    [{ key: 'bridgeDeviceId', sequence: 3, type: TYPE_VALUE, value: J(UUID) }],
    { compression: 'snappy' },
  ).buffer);
  const log = plain(buildLogFile([
    { sequence: 10, records: [{ type: TYPE_VALUE, key: 'bridgeDisplayName', value: J('Work') }] },
  ]));
  const manifest = plain(buildManifest([
    { comparator: DEFAULT_COMPARATOR, logNumber: 7, nextFileNumber: 8, lastSequence: 10 },
  ]));
  const internalKey = plain(encodeInternalKey('bridgeDeviceId', 3, TYPE_VALUE));

  /** @type {string[]} */
  const seen = [];
  /** @type {unknown} */
  let thrown = null;
  // Everything below is synchronous, so nothing else in the process can run
  // (and trip over the missing globals) between removing and restoring them.
  const savedBuffer = globalThis.Buffer;
  const savedProcess = globalThis.process;
  try {
    globalThis.Buffer = undefined;
    globalThis.process = undefined;
    readTableBuffer(table, { onEntry: (e) => seen.push(`${utf8(e.userKey)}=${utf8(e.value)}@${e.sequence}`) });
    readLogBuffer(log, {
      onRecord(payload) {
        const batch = parseWriteBatch(payload);
        for (const r of batch.records) seen.push(`${utf8(r.key)}=${utf8(r.value)}@${batch.sequence}`);
      },
    });
    readLogBuffer(manifest, {
      onRecord(payload) {
        seen.push(`manifest logNumber=${parseVersionEdit(payload).logNumber}`);
      },
    });
    seen.push(`key=${utf8(parseInternalKey(internalKey).userKey)}`);
    seen.push(`varint32=${decodeVarint32(Uint8Array.from([0xac, 0x02]), 0).value}`);
    seen.push(`varint64=${decodeVarint64(Uint8Array.from([0xac, 0x02]), 0).value}`);
  } catch (err) {
    thrown = err;
  } finally {
    globalThis.Buffer = savedBuffer;
    globalThis.process = savedProcess;
  }

  assert.equal(thrown, null, `the parser touched a Node global: ${thrown && thrown.stack}`);
  assert.deepEqual(seen, [
    `bridgeDeviceId=${J(UUID)}@3`,
    `bridgeDisplayName=${J('Work')}@10`,
    'manifest logNumber=7',
    'key=bridgeDeviceId',
    'varint32=300',
    'varint64=300',
  ]);
});

// ---------------------------------------------------------------------------
// an in-memory byte source
// ---------------------------------------------------------------------------

/**
 * @typedef {object} MemoryDbSpec
 * @property {Array<{ number: number, entries: object[], options?: object, ext?: 'ldb'|'sst', level?: number, stale?: boolean }>} [tables]
 * @property {Array<{ number: number, batches: object[], options?: object }>} [logs]
 * @property {boolean} [manifest] write CURRENT + MANIFEST (default true)
 * @property {number} [logNumber]
 */

/**
 * Build a whole database as bytes, never touching a disk. Mirrors the makeDb()
 * helper of leveldb.test.js so the two suites describe the same fixtures.
 *
 * @param {MemoryDbSpec} spec
 * @returns {Record<string, Uint8Array>} file name -> contents
 */
function makeMemoryDb(spec) {
  /** @type {Record<string, Uint8Array>} */
  const files = {};
  const live = [];
  const stale = [];
  let lastSequence = 0n;

  for (const tbl of spec.tables ?? []) {
    const r = buildSstFile(tbl.entries, tbl.options ?? {});
    files[`${fileNumberName(tbl.number)}.${tbl.ext ?? 'ldb'}`] = plain(r.buffer);
    (tbl.stale ? stale : live).push({
      level: tbl.level ?? 0,
      number: tbl.number,
      size: r.size,
      smallest: r.smallest ?? 'a',
      largest: r.largest ?? 'a',
    });
    for (const e of tbl.entries) if (BigInt(e.sequence) > lastSequence) lastSequence = BigInt(e.sequence);
  }

  let maxLog = 0;
  for (const log of spec.logs ?? []) {
    files[`${fileNumberName(log.number)}.log`] = plain(buildLogFile(log.batches, log.options ?? {}));
    maxLog = Math.max(maxLog, log.number);
    for (const b of log.batches) {
      const last = BigInt(b.sequence) + BigInt(Math.max(0, b.records.length - 1));
      if (last > lastSequence) lastSequence = last;
    }
  }

  if (spec.manifest !== false) {
    const manifestNumber = 1;
    const highest = Math.max(0, ...live.map((t) => t.number), ...stale.map((t) => t.number));
    const logNumber = spec.logNumber ?? (maxLog || highest + 1);
    const edits = [{
      comparator: DEFAULT_COMPARATOR,
      logNumber,
      nextFileNumber: Math.max(highest, maxLog, manifestNumber, Number(logNumber)) + 1,
      lastSequence,
      newFiles: [...live, ...stale],
    }];
    if (stale.length > 0) {
      edits.push({ deletedFiles: stale.map((t) => ({ level: t.level, number: t.number })) });
    }
    const manifestName = `MANIFEST-${fileNumberName(manifestNumber)}`;
    files[manifestName] = plain(buildManifest(edits));
    files.CURRENT = new TextEncoder().encode(`${manifestName}\n`);
  }
  return files;
}

/**
 * The byte source an extension would build out of file:// fetches: a name
 * list and whole-file reads, nothing more. `read` hands back a plain
 * Uint8Array so the core cannot lean on a Node byte container by accident.
 *
 * @param {Record<string, Uint8Array>} files
 * @param {{ root?: string, path?: (name: string) => string, has?: boolean }} [options]
 * @returns {import('../src/leveldb-core.js').ByteSource}
 */
function memorySource(files, options = {}) {
  const root = options.root ?? 'memory:/db';
  const map = new Map(Object.entries(files));
  /** @type {import('../src/leveldb-core.js').ByteSource} */
  const source = {
    root,
    path: options.path ?? ((name) => `${root}/${name}`),
    async list() {
      return [...map.keys()];
    },
    async read(name) {
      const bytes = map.get(name);
      if (bytes === undefined) throw new Error(`no such file: ${name}`);
      return plain(bytes);
    },
  };
  // Optional: with `has` the core probes by existence, without it the core
  // probes by reading. Both paths are exercised below.
  if (options.has) source.has = async (name) => map.has(name);
  return source;
}

// ---------------------------------------------------------------------------
// (b) readLevelDbFrom over a memory source
// ---------------------------------------------------------------------------

test('memory source: a snappy compressed .ldb', async () => {
  const files = makeMemoryDb({
    tables: [{
      number: 5,
      options: { compression: 'snappy' },
      entries: [
        { key: 'bridgeDeviceId', sequence: 3, type: TYPE_VALUE, value: J(UUID) },
        { key: 'bridgeDisplayName', sequence: 4, type: TYPE_VALUE, value: J('Work') },
        { key: '한글키', sequence: 5, type: TYPE_VALUE, value: J('한글 값') },
        { key: 'binary', sequence: 6, type: TYPE_VALUE, value: Uint8Array.from([0x00, 0xff, 0x10, 0x80]) },
      ],
    }],
  });

  const db = await readLevelDbFrom(memorySource(files));
  assert.deepEqual(db.warnings, []);
  assert.equal(db.entries.size, 4);
  assert.equal(JSON.parse(utf8(db.entries.get('bridgeDeviceId'))), UUID);
  assert.equal(JSON.parse(utf8(db.entries.get('bridgeDisplayName'))), 'Work');
  assert.equal(JSON.parse(utf8(db.entries.get('한글키'))), '한글 값');
  assert.deepEqual([...db.entries.get('binary')], [0x00, 0xff, 0x10, 0x80]);

  // values are plain Uint8Arrays: the Node-only wrapper is the adapter's job
  assert.equal(Object.getPrototypeOf(db.entries.get('binary')), Uint8Array.prototype);

  // the `path` hook decides what shows up in warnings and in `files`
  assert.deepEqual(db.files.tables, ['memory:/db/000005.ldb']);
  assert.deepEqual(db.files.logs, []);
  assert.equal(db.files.manifest, 'memory:/db/MANIFEST-000001');
});

test('memory source: a write-ahead log', async () => {
  const files = makeMemoryDb({
    logs: [{
      number: 7,
      batches: [
        { sequence: 1, records: [{ type: TYPE_VALUE, key: 'bridgeDeviceId', value: J(OLD_UUID) }] },
        {
          sequence: 2,
          records: [
            { type: TYPE_VALUE, key: 'bridgeDeviceId', value: J(UUID) },
            { type: TYPE_VALUE, key: 'bridgeDisplayName', value: J('Personal') },
          ],
        },
      ],
    }],
  });

  const db = await readLevelDbFrom(memorySource(files));
  assert.deepEqual(db.warnings, []);
  assert.equal(JSON.parse(utf8(db.entries.get('bridgeDeviceId'))), UUID, 'the higher sequence wins');
  assert.equal(JSON.parse(utf8(db.entries.get('bridgeDisplayName'))), 'Personal');
  assert.deepEqual(db.files.logs, ['memory:/db/000007.log']);
  assert.deepEqual(db.files.tables, []);
});

test('memory source: a value split across two 32 KiB log blocks is reassembled', async () => {
  // The batch is deliberately sized so the record fragments right in the
  // middle of the UUID: the 7 byte header of the second fragment lands inside
  // it. A substring search over the file therefore cannot find the UUID, which
  // is why the reader has to understand the framing.
  const FRAGMENT_ONE = 32768 - 7;
  const key = 'bridgeDeviceId';
  // batch header 12 + filler record (1 type + 1 key length + 6 key + 3 value
  // length + L value) + this record's prefix (1 type + 1 key length + 14 key +
  // 1 value length) = 40 + L bytes before the UUID's JSON string starts.
  const valueStart = FRAGMENT_ONE - 11;
  const fillerLength = valueStart - 40;

  const files = makeMemoryDb({
    logs: [{
      number: 7,
      batches: [{
        sequence: 1,
        records: [
          { type: TYPE_VALUE, key: 'filler', value: 'f'.repeat(fillerLength) },
          { type: TYPE_VALUE, key, value: J(UUID) },
        ],
      }],
    }],
  });

  const raw = files['000007.log'];
  assert.ok(raw.length > 32768, 'premise: the log is longer than one block');
  let asText = '';
  for (const b of raw) asText += String.fromCharCode(b);
  assert.equal(asText.includes(UUID), false, 'premise: a substring search cannot find the UUID');

  const db = await readLevelDbFrom(memorySource(files));
  assert.deepEqual(db.warnings, []);
  assert.equal(JSON.parse(utf8(db.entries.get(key))), UUID);
});

test('memory source: deletions hide values, in a log and inside a table', async () => {
  const files = makeMemoryDb({
    tables: [{
      number: 5,
      entries: [
        { key: 'bridgeDeviceId', sequence: 3, type: TYPE_VALUE, value: J(UUID) },
        { key: 'unpaired', sequence: 4, type: TYPE_VALUE, value: J('gone') },
        // a deletion recorded in the table itself, above the value's sequence
        { key: 'unpaired', sequence: 5, type: TYPE_DELETION },
        { key: 'keep', sequence: 6, type: TYPE_VALUE, value: J('still here') },
      ],
    }],
    logs: [{
      number: 9,
      batches: [{ sequence: 20, records: [{ type: TYPE_DELETION, key: 'bridgeDeviceId' }] }],
    }],
  });

  const db = await readLevelDbFrom(memorySource(files));
  assert.deepEqual(db.warnings, []);
  assert.equal(db.entries.has('bridgeDeviceId'), false, 'deleted by the log');
  assert.equal(db.entries.has('unpaired'), false, 'deleted inside the table');
  assert.equal(JSON.parse(utf8(db.entries.get('keep'))), 'still here');
  assert.equal(db.entries.size, 1);
});

test('memory source: the MANIFEST decides which tables count', async () => {
  const files = makeMemoryDb({
    tables: [
      // an obsolete table that a compaction dropped from the live set but that
      // is still on disk, holding a *newer* sequence than the live table
      { number: 5, stale: true, entries: [{ key: 'bridgeDeviceId', sequence: 20, type: TYPE_VALUE, value: J(OLD_UUID) }] },
      { number: 8, entries: [{ key: 'bridgeDeviceId', sequence: 9, type: TYPE_VALUE, value: J(UUID) }] },
    ],
  });

  const db = await readLevelDbFrom(memorySource(files));
  assert.deepEqual(db.warnings, []);
  assert.deepEqual(db.files.tables, ['memory:/db/000008.ldb'], 'the stale table is skipped');
  assert.equal(db.files.manifest, 'memory:/db/MANIFEST-000001');
  assert.equal(JSON.parse(utf8(db.entries.get('bridgeDeviceId'))), UUID);

  const all = await readLevelDbFrom(memorySource(files), { useManifest: false });
  assert.deepEqual(all.files.tables, ['memory:/db/000005.ldb', 'memory:/db/000008.ldb']);
  assert.equal(all.files.manifest, null);
  assert.equal(
    JSON.parse(utf8(all.entries.get('bridgeDeviceId'))),
    OLD_UUID,
    'without the MANIFEST the stale table wins on sequence, which is exactly what it is there to prevent',
  );
});

test('memory source: a live table missing from the listing is found by name', async () => {
  const files = makeMemoryDb({
    tables: [{ number: 8, entries: [{ key: 'bridgeDeviceId', sequence: 9, type: TYPE_VALUE, value: J(UUID) }] }],
  });

  for (const has of [false, true]) {
    const source = memorySource(files, { has });
    // Chrome finished a flush between the listing and the MANIFEST read.
    source.list = async () => Object.keys(files).filter((n) => n !== '000008.ldb');
    const db = await readLevelDbFrom(source);
    assert.deepEqual(db.warnings, [], `has: ${has}`);
    assert.deepEqual(db.files.tables, ['memory:/db/000008.ldb'], `has: ${has}`);
    assert.equal(JSON.parse(utf8(db.entries.get('bridgeDeviceId'))), UUID, `has: ${has}`);
  }
});

test('memory source: a table the MANIFEST names and nobody has falls back to a full scan', async () => {
  const files = makeMemoryDb({
    tables: [
      { number: 5, entries: [{ key: 'bridgeDeviceId', sequence: 2, type: TYPE_VALUE, value: J(OLD_UUID) }] },
      { number: 8, entries: [{ key: 'bridgeDeviceId', sequence: 9, type: TYPE_VALUE, value: J(UUID) }] },
    ],
  });
  const withoutTable8 = { ...files };
  delete withoutTable8['000008.ldb'];

  const db = await readLevelDbFrom(memorySource(withoutTable8));
  assert.deepEqual(db.warnings, [
    'memory:/db/MANIFEST-000001: live table(s) 000008.ldb are missing from memory:/db; scanning every table and log on disk',
  ]);
  assert.deepEqual(db.files.tables, ['memory:/db/000005.ldb']);
  assert.equal(JSON.parse(utf8(db.entries.get('bridgeDeviceId'))), OLD_UUID);
});

test('memory source: list() may report problems of its own, and they come first', async () => {
  const files = makeMemoryDb({
    manifest: false,
    tables: [{ number: 5, entries: [{ key: 'bridgeDeviceId', sequence: 1, type: TYPE_VALUE, value: J(UUID) }] }],
  });
  const source = memorySource(files);
  source.list = async () => ({
    names: Object.keys(files),
    warnings: ['memory:/db/000006.log is a symlink to something that is not a regular file; ignored'],
  });

  const db = await readLevelDbFrom(source);
  assert.deepEqual(db.warnings, [
    'memory:/db/000006.log is a symlink to something that is not a regular file; ignored',
    'memory:/db/CURRENT is missing; scanning every table and log',
  ]);
  assert.equal(JSON.parse(utf8(db.entries.get('bridgeDeviceId'))), UUID);
});

test('memory source: a failing list() is a warning naming the source root', async () => {
  const source = memorySource({});
  source.list = async () => {
    throw new Error('Failed to fetch');
  };
  const db = await readLevelDbFrom(source);
  assert.deepEqual(db.warnings, ['cannot list memory:/db: Failed to fetch']);
  assert.equal(db.entries.size, 0);
  assert.deepEqual(db.files.tables, []);
  assert.deepEqual(db.files.logs, []);
  assert.equal(db.files.manifest, null);
  // 목록을 못 읽었으면 한 바이트도 못 읽은 것이다. 부르는 쪽이 "키가 없다"와
  // "못 읽었다"를 가르는 근거가 이 배열이므로, 비어 있으면 안 된다.
  assert.deepEqual(db.files.failed, [
    { path: 'memory:/db', message: 'Failed to fetch' },
  ]);
});

test('memory source: an unreadable file costs only that file', async () => {
  const files = makeMemoryDb({
    tables: [
      { number: 5, entries: [{ key: 'a', sequence: 1, type: TYPE_VALUE, value: J('one') }] },
      { number: 8, entries: [{ key: 'b', sequence: 2, type: TYPE_VALUE, value: J('two') }] },
    ],
  });
  const source = memorySource(files);
  const read = source.read.bind(source);
  source.read = async (name) => {
    if (name === '000005.ldb') throw new Error('Failed to fetch');
    return read(name);
  };

  const db = await readLevelDbFrom(source);
  assert.deepEqual(db.warnings, ['cannot read memory:/db/000005.ldb: Failed to fetch']);
  assert.deepEqual(db.files.tables, ['memory:/db/000008.ldb']);
  assert.equal(JSON.parse(utf8(db.entries.get('b'))), 'two');
  assert.equal(db.entries.has('a'), false);
  // 'a' 가 없는 것은 **키가 없어서가 아니라 못 읽어서**다. 그 둘을 가르는 것이
  // files.failed 다 — 이게 비어 있으면 부르는 쪽이 "페어링 안 됨" 이라고
  // 단정해 버린다.
  assert.deepEqual(db.files.failed, [
    { path: 'memory:/db/000005.ldb', message: 'Failed to fetch' },
  ]);
});

test('memory source: a fully readable database reports no failures', async () => {
  const files = makeMemoryDb({
    tables: [{ number: 5, entries: [{ key: 'a', sequence: 1, type: TYPE_VALUE, value: J('one') }] }],
  });
  const db = await readLevelDbFrom(memorySource(files));
  // 반대 방향도 고정해 둔다. failed 가 항상 차 있으면 아무것도 가르지 못한다.
  assert.deepEqual(db.files.failed, []);
  assert.equal(JSON.parse(utf8(db.entries.get('a'))), 'one');
});

test('readLevelDbFrom works with the bare { list, read } contract', async () => {
  const files = makeMemoryDb({
    tables: [{ number: 5, entries: [{ key: 'bridgeDeviceId', sequence: 1, type: TYPE_VALUE, value: J(UUID) }] }],
  });
  const bare = {
    list: async () => Object.keys(files),
    read: async (name) => plain(files[name]),
  };

  const db = await readLevelDbFrom(bare);
  assert.deepEqual(db.warnings, []);
  assert.equal(JSON.parse(utf8(db.entries.get('bridgeDeviceId'))), UUID);
  // with no `path` hook the names are reported as they are
  assert.deepEqual(db.files.tables, ['000005.ldb']);
  assert.equal(db.files.manifest, 'MANIFEST-000001');
});

// ---------------------------------------------------------------------------
// the two halves agree
// ---------------------------------------------------------------------------

test('the node adapter and a memory source over the same bytes agree', async (t) => {
  const files = makeMemoryDb({
    tables: [
      { number: 5, stale: true, options: { compression: 'snappy' }, entries: [{ key: 'stale', sequence: 30, type: TYPE_VALUE, value: J('ignored') }] },
      {
        number: 8,
        options: { compression: 'snappy' },
        entries: [
          { key: 'bridgeDeviceId', sequence: 3, type: TYPE_VALUE, value: J(UUID) },
          { key: 'binary', sequence: 4, type: TYPE_VALUE, value: Uint8Array.from([0x00, 0xff, 0x10, 0x80]) },
        ],
      },
    ],
    logs: [{
      number: 9,
      batches: [{
        sequence: 40,
        records: [
          { type: TYPE_VALUE, key: 'bridgeDisplayName', value: J('Personal') },
          { type: TYPE_DELETION, key: 'binary' },
        ],
      }],
    }],
  });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cici-core-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(dir, name), bytes);

  const viaFs = await readLevelDb(dir);
  const viaMemory = await readLevelDbFrom(
    memorySource(files, { root: dir, path: (name) => path.join(dir, name) }),
  );

  assert.deepEqual(viaFs.warnings, viaMemory.warnings);
  assert.deepEqual(viaFs.warnings, []);
  assert.deepEqual(viaFs.files, viaMemory.files);
  assert.deepEqual([...viaFs.entries.keys()], [...viaMemory.entries.keys()]);
  for (const [key, value] of viaMemory.entries) {
    assert.deepEqual([...viaFs.entries.get(key)], [...value], `value of ${key}`);
  }
  assert.equal(JSON.parse(utf8(viaMemory.entries.get('bridgeDeviceId'))), UUID);
  assert.equal(JSON.parse(utf8(viaMemory.entries.get('bridgeDisplayName'))), 'Personal');
  assert.equal(viaMemory.entries.has('binary'), false, 'deleted by the log');
  assert.equal(viaMemory.entries.has('stale'), false, 'not in the live set');

  // The one deliberate difference: the adapter keeps handing Node callers the
  // byte container they have always got, the core hands out plain Uint8Arrays.
  assert.equal(Buffer.isBuffer(viaFs.entries.get('bridgeDeviceId')), true);
  assert.equal(Object.getPrototypeOf(viaMemory.entries.get('bridgeDeviceId')), Uint8Array.prototype);
});

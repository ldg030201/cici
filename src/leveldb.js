/**
 * Read-only LevelDB reader, `node:fs` adapter.
 *
 * The parser itself lives in `leveldb-core.js`, which has no platform imports
 * at all so the exact same code can run inside a browser extension (where a
 * Chrome profile is reachable only through `fetch('file:///...')`). This module
 * is the thin half that knows about directories: it turns a path into the
 * {@link import('./leveldb-core.js').ByteSource} the core reads from, and
 * re-exports everything the core exports, so `leveldb.js` stays the single
 * import for Node callers.
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
import { readLevelDbFrom } from './leveldb-core.js';

export {
  decodeVarint32,
  decodeVarint64,
  parseInternalKey,
  readTableBuffer,
  readLogBuffer,
  parseWriteBatch,
  parseVersionEdit,
  readLevelDbFrom,
} from './leveldb-core.js';

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
 * @typedef {import('./leveldb-core.js').LevelDbFiles} LevelDbFiles
 */

/**
 * @typedef {object} LevelDbResult
 * @property {Map<string, Buffer>} entries latest live value per user key (keys decoded as UTF-8)
 * @property {string[]} warnings human readable problems that were tolerated
 * @property {LevelDbFiles} files absolute paths of what was read
 */

/**
 * A byte source that reads the files of `dir` with `node:fs`.
 *
 * @param {string} dir
 * @returns {import('./leveldb-core.js').ByteSource}
 */
export function directorySource(dir) {
  return {
    root: dir,
    path: (name) => path.join(dir, name),

    async list() {
      /** @type {string[]} */
      const warnings = [];
      const dirents = await readdir(dir, { withFileTypes: true });
      const kept = await Promise.all(dirents.map((d) => direntIsFile(d, dir, warnings)));
      return { names: dirents.filter((_d, i) => kept[i]).map((d) => d.name), warnings };
    },

    read(name) {
      return readFile(path.join(dir, name));
    },

    async has(name) {
      try {
        return (await stat(path.join(dir, name))).isFile();
      } catch {
        // not there, or not readable
        return false;
      }
    },
  };
}

/**
 * Read a LevelDB directory read-only and return the latest live value of every
 * user key. Never throws because of file contents; problems become warnings.
 *
 * @param {string} dir
 * @param {{ useManifest?: boolean }} [options] set useManifest to false to scan every table/log regardless of the MANIFEST
 * @returns {Promise<LevelDbResult>}
 */
export async function readLevelDb(dir, options = {}) {
  const result = await readLevelDbFrom(directorySource(dir), options);
  // The core hands out plain Uint8Arrays; Node callers have always been given
  // Buffers, so keep that. Each value already owns its bytes, so wrapping is a
  // view, not another copy.
  for (const [key, value] of result.entries) {
    result.entries.set(key, Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return result;
}

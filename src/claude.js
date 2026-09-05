/**
 * Claude in Chrome specifics: the extension ids to look for and how to pull
 * the bridge pairing info out of the extension's chrome.storage.local
 * LevelDB.
 *
 * @module claude
 */

import fs from 'node:fs/promises';
import { readLevelDb } from './leveldb.js';

/**
 * Extension ids that may hold Claude in Chrome's storage, in priority order.
 * @type {ReadonlyArray<string>}
 */
export const CLAUDE_EXTENSION_IDS = Object.freeze([
  // Chrome Web Store id of the public "Claude" (Claude in Chrome) extension.
  'fcoeoabgfenejglbffodgkkbkcdhcgfn',
  // Additional ids listed in "allowed_origins" of Anthropic's native
  // messaging host manifest (the Claude Code <-> browser bridge); most likely
  // internal / development builds of the same extension.
  'dihbgbndebgnbjfmelmegjepbnkhlgni',
  'dngcpimnedloihjnnfngkgjoidhnaolf',
]);

/** chrome.storage.local key holding the UUID Claude Code shows in its browser picker. */
export const BRIDGE_DEVICE_ID_KEY = 'bridgeDeviceId';

/** chrome.storage.local key holding the name typed when pairing (optional). */
export const BRIDGE_DISPLAY_NAME_KEY = 'bridgeDisplayName';

/**
 * @typedef {object} BridgeInfo
 * @property {string|null} deviceId     bridgeDeviceId, or null when not paired / unreadable.
 * @property {string|null} displayName  bridgeDisplayName, or null.
 * @property {boolean} readFailed       Some data file could not be read, so a
 *   null `deviceId` means "we do not know", not "not paired". Telling an
 *   already-paired profile that it is unpaired is the one answer this tool must
 *   never give — that is the question it exists to answer.
 * @property {string[]} warnings        Non-fatal problems met while reading.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEVELDB_FILE_RE = /\.(?:ldb|sst|log)$/i;

/**
 * Read bridgeDeviceId / bridgeDisplayName from an extension storage directory
 * ("<profile>/Local Extension Settings/<extensionId>").
 *
 * Read-only: the LevelDB LOCK is never taken, so this is safe while Chrome is
 * running. Never throws for a missing or broken database; problems are
 * reported through `warnings`.
 *
 * @param {string} storageDir
 * @returns {Promise<BridgeInfo>}
 */
export async function readBridgeInfo(storageDir) {
  /** @type {BridgeInfo} */
  const result = { deviceId: null, displayName: null, readFailed: false, warnings: [] };

  let names;
  try {
    names = await fs.readdir(storageDir);
  } catch (err) {
    const enoent = err && err.code === 'ENOENT';
    const reason = enoent ? 'does not exist' : `cannot be read (${errorMessage(err)})`;
    result.warnings.push(`extension storage dir ${reason}: ${storageDir}`);
    // "없다" 와 "못 읽었다" 는 다른 답이다. 후자만 readFailed 다.
    result.readFailed = !enoent;
    return result;
  }
  if (!names.some((n) => LEVELDB_FILE_RE.test(n))) {
    result.warnings.push(`no LevelDB files (*.ldb, *.sst, *.log) in ${storageDir}`);
    return result;
  }

  let entries;
  try {
    const db = await readLevelDb(storageDir);
    entries = db.entries;
    // 파서는 읽기 실패를 던지지 않고 삼킨다. 무엇을 못 읽었는지는 files.failed
    // 에만 구조화돼 있고, 경고 문자열을 검사하는 건 파서의 영어 문구에 기대는
    // 짓이라 문구가 바뀌면 조용히 깨진다.
    if (db.files.failed.length > 0) result.readFailed = true;
    for (const w of db.warnings) result.warnings.push(`${storageDir}: ${w}`);
  } catch (err) {
    result.warnings.push(`failed to read LevelDB at ${storageDir}: ${errorMessage(err)}`);
    result.readFailed = true;
    return result;
  }

  const rawId = entries.get(BRIDGE_DEVICE_ID_KEY);
  if (rawId !== undefined) {
    const { value, text, error } = decodeJsonValue(rawId);
    if (error) {
      if (UUID_RE.test(text.trim())) {
        result.deviceId = text.trim();
        result.warnings.push(`${BRIDGE_DEVICE_ID_KEY} is not valid JSON (${error}); using the raw text`);
      } else {
        result.warnings.push(`${BRIDGE_DEVICE_ID_KEY} is not valid JSON (${error}): ${preview(text)}`);
      }
    } else if (typeof value === 'string') {
      result.deviceId = value;
      if (!UUID_RE.test(value)) {
        result.warnings.push(`${BRIDGE_DEVICE_ID_KEY} does not look like a UUID: ${preview(value)}`);
      }
    } else {
      result.warnings.push(`${BRIDGE_DEVICE_ID_KEY} is not a JSON string: ${preview(text)}`);
    }
  }

  const rawName = entries.get(BRIDGE_DISPLAY_NAME_KEY);
  if (rawName !== undefined) {
    const { value, text, error } = decodeJsonValue(rawName);
    if (error) {
      result.warnings.push(`${BRIDGE_DISPLAY_NAME_KEY} is not valid JSON (${error}): ${preview(text)}`);
    } else if (typeof value === 'string') {
      result.displayName = value;
    } else if (value !== null && value !== undefined) {
      result.warnings.push(`${BRIDGE_DISPLAY_NAME_KEY} is not a JSON string: ${preview(text)}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// internals

/**
 * @param {Uint8Array|string} raw
 * @returns {{ value: unknown, text: string, error: string|null }}
 */
function decodeJsonValue(raw) {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  try {
    return { value: JSON.parse(text), text, error: null };
  } catch (err) {
    return { value: undefined, text, error: errorMessage(err) };
  }
}

/**
 * A short, printable excerpt of a stored value for a warning. Whitespace is
 * collapsed and the remaining control characters are escaped: these bytes come
 * from a file cici does not control, and the warning goes to a terminal.
 *
 * @param {string} s
 */
function preview(s) {
  const one = String(s)
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.codePointAt(0).toString(16).padStart(2, '0')}`);
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
}

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

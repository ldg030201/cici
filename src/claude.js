/**
 * Claude in Chrome specifics: the extension ids to look for and how to pull
 * the bridge pairing info out of the extension's chrome.storage.local
 * LevelDB.
 *
 * @module claude
 */

import fs from 'node:fs/promises';

import {
  BRIDGE_DEVICE_ID_KEY,
  BRIDGE_DISPLAY_NAME_KEY,
  CLAUDE_EXTENSION_IDS,
  LEVELDB_FILE_RE,
  pickBridge,
} from './claude-core.js';
import { readLevelDb } from './leveldb.js';

// How a stored value is interpreted lives in `claude-core.js`, which the
// extension gets a verbatim copy of. Re-exported here because this module is
// the package's entry point for it.
export { BRIDGE_DEVICE_ID_KEY, BRIDGE_DISPLAY_NAME_KEY, CLAUDE_EXTENSION_IDS };

/**
 * English sentences for the warning codes `pickBridge` returns.
 *
 * The rule that produces a warning is shared with the extension; the sentence
 * is not, because a sentence only fits one language. The extension renders the
 * same codes through `_locales`.
 *
 * @type {Record<string, (params: string[]) => string>}
 */
const WARNING_TEXT = {
  warnBadJsonRaw: ([key, error]) => `${key} is not valid JSON (${error}); using the raw text`,
  warnBadJson: ([key, error, sample]) => `${key} is not valid JSON (${error}): ${sample}`,
  warnNotUuid: ([key, sample]) => `${key} does not look like a UUID: ${sample}`,
  warnNotJsonString: ([key, sample]) => `${key} is not a JSON string: ${sample}`,
};

/**
 * @param {{ code: string, params: string[] }} warning
 * @returns {string}
 */
function warningText({ code, params }) {
  const render = WARNING_TEXT[code];
  // An unknown code would otherwise vanish. Say it out loud instead.
  return render ? render(params) : `${code}: ${params.join(', ')}`;
}

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
    // 우리가 원하는 값은 둘뿐이다. 나머지 키를 위해 수 MB 를 압축 해제할
    // 이유가 없다 — 실측으로 프로필당 48ms 가 8ms 로 줄었다.
    const db = await readLevelDb(storageDir, {
      keys: [BRIDGE_DEVICE_ID_KEY, BRIDGE_DISPLAY_NAME_KEY],
    });
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

  const found = pickBridge(entries);
  result.deviceId = found.deviceId;
  result.displayName = found.displayName;
  for (const w of found.warnings) result.warnings.push(warningText(w));

  return result;
}

// ---------------------------------------------------------------------------
// internals

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 프로필 하나에서 Claude in Chrome 의 페어링 정보를 꺼낸다.
 *
 * Claude Code 가 브라우저 선택창에 띄우는 UUID 는 확장의
 * `chrome.storage.local` 에 `bridgeDeviceId` 로 들어 있고, 그 저장소는
 * `<profile>/Local Extension Settings/<확장 id>/` 의 LevelDB 다. 읽기 전용으로
 * 열며 LOCK 을 잡지 않으므로 브라우저가 켜져 있어도 안전하다.
 *
 * `src/claude.js` 의 브라우저판이다. 값 해석 규칙(따옴표 붙은 JSON, UUID 모양
 * 검사, 깨진 값 처리)을 그대로 맞춰 두었다.
 *
 * @module read
 */

import { decodeUtf8, findChildDir, listDirOrNull, makeSource } from './fileurl.js';
import { readLevelDbFrom } from './leveldb-core.js';

/**
 * Claude in Chrome 의 저장소가 있을 수 있는 확장 id. 우선순위 순.
 * `src/claude.js` 의 목록과 같아야 한다.
 * @type {ReadonlyArray<string>}
 */
export const CLAUDE_EXTENSION_IDS = Object.freeze([
  // 크롬 웹스토어의 공개 "Claude" (Claude in Chrome) 확장.
  'fcoeoabgfenejglbffodgkkbkcdhcgfn',
  // Anthropic 네이티브 메시징 호스트 매니페스트의 allowed_origins 에 함께 적힌
  // id 들. 같은 확장의 내부/개발 빌드로 보인다.
  'dihbgbndebgnbjfmelmegjepbnkhlgni',
  'dngcpimnedloihjnnfngkgjoidhnaolf',
]);

/** Claude Code 가 브라우저 선택창에 띄우는 UUID 가 들어 있는 키. */
export const BRIDGE_DEVICE_ID_KEY = 'bridgeDeviceId';

/** 페어링할 때 입력한 이름(선택 사항). */
export const BRIDGE_DISPLAY_NAME_KEY = 'bridgeDisplayName';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEVELDB_FILE_RE = /\.(?:ldb|sst|log)$/i;

/**
 * @typedef {object} BridgeInfo
 * @property {string|null} extensionId  값을 찾은(또는 설치돼 있던) 확장 id. 없으면 null.
 * @property {string|null} deviceId     bridgeDeviceId. 없거나 못 읽으면 null.
 * @property {string|null} displayName  bridgeDisplayName. 없으면 null.
 * @property {string[]} warnings        치명적이지 않은 문제들.
 */

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 경고에 넣을 짧고 안전한 발췌. 값은 우리가 만들지 않은 파일에서 온 것이므로
 * 제어문자를 escape 한다.
 *
 * @param {string} s
 * @returns {string}
 */
function preview(s) {
  const one = String(s)
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.codePointAt(0).toString(16).padStart(2, '0')}`);
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
}

/**
 * @param {Uint8Array|string} raw
 * @returns {{ value: unknown, text: string, error: string|null }}
 */
function decodeJsonValue(raw) {
  const text = typeof raw === 'string' ? raw : decodeUtf8(raw);
  try {
    return { value: JSON.parse(text), text, error: null };
  } catch (err) {
    return { value: undefined, text, error: errorMessage(err) };
  }
}

/**
 * LevelDB 항목에서 bridgeDeviceId / bridgeDisplayName 을 꺼낸다.
 *
 * @param {Map<string, Uint8Array>} entries
 * @param {string[]} warnings
 * @returns {{ deviceId: string|null, displayName: string|null }}
 */
function pickBridge(entries, warnings) {
  let deviceId = null;
  let displayName = null;

  const rawId = entries.get(BRIDGE_DEVICE_ID_KEY);
  if (rawId !== undefined) {
    const { value, text, error } = decodeJsonValue(rawId);
    if (error) {
      if (UUID_RE.test(text.trim())) {
        deviceId = text.trim();
        warnings.push(`${BRIDGE_DEVICE_ID_KEY} 가 올바른 JSON 이 아닙니다 (${error}). 날값을 그대로 씁니다`);
      } else {
        warnings.push(`${BRIDGE_DEVICE_ID_KEY} 가 올바른 JSON 이 아닙니다 (${error}): ${preview(text)}`);
      }
    } else if (typeof value === 'string') {
      deviceId = value;
      if (!UUID_RE.test(value)) {
        warnings.push(`${BRIDGE_DEVICE_ID_KEY} 가 UUID 처럼 보이지 않습니다: ${preview(value)}`);
      }
    } else {
      warnings.push(`${BRIDGE_DEVICE_ID_KEY} 가 JSON 문자열이 아닙니다: ${preview(text)}`);
    }
  }

  const rawName = entries.get(BRIDGE_DISPLAY_NAME_KEY);
  if (rawName !== undefined) {
    const { value, text, error } = decodeJsonValue(rawName);
    if (error) {
      warnings.push(`${BRIDGE_DISPLAY_NAME_KEY} 가 올바른 JSON 이 아닙니다 (${error}): ${preview(text)}`);
    } else if (typeof value === 'string') {
      displayName = value;
    } else if (value !== null && value !== undefined) {
      warnings.push(`${BRIDGE_DISPLAY_NAME_KEY} 가 JSON 문자열이 아닙니다: ${preview(text)}`);
    }
  }

  return { deviceId, displayName };
}

/**
 * 프로필 하나의 Claude in Chrome 페어링 정보를 읽는다.
 *
 * 후보 확장 id 를 우선순위대로 시도한다. 디렉터리가 아예 없으면 그 프로필에는
 * 확장이 설치돼 있지 않다는 뜻이라 조용히 넘어간다. 디렉터리는 있는데
 * `bridgeDeviceId` 가 없으면 "설치는 됐지만 아직 페어링 안 됨"이고,
 * `extensionId` 는 채워지고 `deviceId` 만 null 로 남는다.
 *
 * @param {string} profileDir 프로필 디렉터리 절대 경로
 * @returns {Promise<BridgeInfo>}
 */
export async function readBridge(profileDir) {
  /** @type {BridgeInfo} */
  const result = { extensionId: null, deviceId: null, displayName: null, warnings: [] };
  // 없는 경로를 fetch 하면 콘솔에 `net::ERR_FILE_NOT_FOUND` 가 남고, 잡아도
  // 지워지지 않는다. 그래서 목록으로 있는 것만 골라 연다.
  const settingsRoot = await findChildDir(profileDir, 'Local Extension Settings');
  if (settingsRoot === null) return result;

  for (const id of CLAUDE_EXTENSION_IDS) {
    const dir = await findChildDir(settingsRoot, id);
    // 이 프로필에는 그 확장이 없다. 정상적인 경우다.
    if (dir === null) continue;

    // 디렉터리가 있다 = 그 확장이 설치돼 있다. 뒤의 후보가 값을 갖고 있으면
    // 그쪽으로 덮어쓴다.
    if (result.extensionId === null) result.extensionId = id;

    const entries = await listDirOrNull(dir);
    if (entries === null) {
      result.warnings.push(`${dir}: 디렉터리를 읽지 못했습니다`);
      continue;
    }

    if (!entries.some((e) => !e.isDir && LEVELDB_FILE_RE.test(e.name))) {
      result.warnings.push(`${dir}: LevelDB 파일(*.ldb, *.sst, *.log)이 없습니다`);
      continue;
    }

    let db;
    try {
      db = await readLevelDbFrom(makeSource(dir, { entries }));
    } catch (err) {
      result.warnings.push(`${dir}: LevelDB 를 읽지 못했습니다 (${errorMessage(err)})`);
      continue;
    }
    for (const w of db.warnings) result.warnings.push(`${dir}: ${w}`);

    const found = pickBridge(db.entries, result.warnings);
    if (found.deviceId !== null || found.displayName !== null) {
      result.extensionId = id;
      result.deviceId = found.deviceId;
      result.displayName = found.displayName;
      return result;
    }
  }

  return result;
}

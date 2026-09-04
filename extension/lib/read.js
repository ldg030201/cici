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

import { decodeUtf8, findChildDirEx, listDirOrNull, makeSource } from './fileurl.js';
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
 * 사람에게 보여 줄 경고 한 줄.
 *
 * **문장을 여기서 만들지 않는다.** `_locales` 의 메시지 키와 그 자리에 넣을
 * 값만 담고, 실제 문장은 popup.js 가 `chrome.i18n` 으로 조립한다. 라이브러리가
 * 한국어 문장을 직접 만들면 en 로케일 화면에 한글이 그대로 박히고(그 반대도
 * 마찬가지다) 한 상자 안에서 언어가 섞인다.
 *
 * @typedef {object} Warning
 * @property {string} code   `_locales` 메시지 키
 * @property {string[]} params  `$1`, `$2` ... 자리에 들어갈 값
 */

/**
 * @typedef {object} BridgeInfo
 * @property {string|null} extensionId  값을 찾은(또는 설치돼 있던) 확장 id. 없으면 null.
 * @property {string|null} deviceId     bridgeDeviceId. 없거나 못 읽으면 null.
 * @property {string|null} displayName  bridgeDisplayName. 없으면 null.
 * @property {boolean} unreadable       프로필 폴더 자체를 읽지 못했으면 true.
 *   `extensionId === null` 이 "확장이 없다"는 뜻인지 **"모른다"**는 뜻인지 가른다.
 * @property {boolean} readFailed       확장 저장소 안쪽에서 읽기가 실패했으면 true.
 *   확장이 있는 건 알지만 `deviceId === null` 이 "페어링 안 됨"인지
 *   **"모름"**인지 가른다. 이걸 세우지 않으면 이미 페어링된 프로필에게
 *   "페어링하세요"라고 말하게 된다.
 * @property {Warning[]} warnings       치명적이지 않은 문제들.
 */

/**
 * @param {string} code
 * @param {...string} params
 * @returns {Warning}
 */
function warn(code, ...params) {
  return { code, params: params.map((p) => String(p)) };
}

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
 * @param {Warning[]} warnings
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
        warnings.push(warn('warnBadJsonRaw', BRIDGE_DEVICE_ID_KEY, error));
      } else {
        warnings.push(warn('warnBadJson', BRIDGE_DEVICE_ID_KEY, error, preview(text)));
      }
    } else if (typeof value === 'string') {
      deviceId = value;
      if (!UUID_RE.test(value)) {
        warnings.push(warn('warnNotUuid', BRIDGE_DEVICE_ID_KEY, preview(value)));
      }
    } else {
      warnings.push(warn('warnNotJsonString', BRIDGE_DEVICE_ID_KEY, preview(text)));
    }
  }

  const rawName = entries.get(BRIDGE_DISPLAY_NAME_KEY);
  if (rawName !== undefined) {
    const { value, text, error } = decodeJsonValue(rawName);
    if (error) {
      warnings.push(warn('warnBadJson', BRIDGE_DISPLAY_NAME_KEY, error, preview(text)));
    } else if (typeof value === 'string') {
      displayName = value;
    } else if (value !== null && value !== undefined) {
      warnings.push(warn('warnNotJsonString', BRIDGE_DISPLAY_NAME_KEY, preview(text)));
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
 * **"없다"와 "못 읽었다"를 절대 섞지 않는다.** 목록을 읽지 못하면
 * `unreadable` 을 세우고 경고를 남긴다. 그러지 않으면 권한 문제로 못 읽은
 * 프로필이 "Claude 확장이 없는 프로필"로 조용히 둔갑한다.
 *
 * 같은 이유로 **저장소 안쪽**에서 읽기가 실패하면 `readFailed` 를 세운다. 확장
 * 폴더는 보이는데 그 안의 `.ldb`/`.log` 를 못 읽는 일은 실제로 생긴다(우리가
 * 목록을 뜬 뒤 크롬이 컴팩션으로 WAL 을 갈아 치우거나, 읽기가 타임아웃에
 * 걸리거나). 그때 `deviceId === null` 을 "아직 페어링 안 됨"으로 읽으면, 이미
 * 페어링돼서 디스크에 UUID 가 멀쩡히 있는 프로필에게 "페어링하세요"라고 말하게
 * 된다 — 이 확장의 존재 이유가 바로 그 화면에서 무너진다.
 *
 * @param {string} profileDir 프로필 디렉터리 절대 경로
 * @returns {Promise<BridgeInfo>}
 */
export async function readBridge(profileDir) {
  /** @type {BridgeInfo} */
  const result = {
    extensionId: null,
    deviceId: null,
    displayName: null,
    unreadable: false,
    readFailed: false,
    warnings: [],
  };

  // 없는 경로를 fetch 하면 콘솔에 `net::ERR_FILE_NOT_FOUND` 가 남고, 잡아도
  // 지워지지 않는다. 그래서 목록으로 있는 것만 골라 연다.
  const settings = await findChildDirEx(profileDir, 'Local Extension Settings');
  if (settings.unreadable) {
    result.unreadable = true;
    result.warnings.push(warn('warnProfileUnreadable', profileDir));
    return result;
  }

  if (settings.path !== null) {
    const found = await readFromSettings(settings.path, result);
    if (found) return result;
  }

  // 저장소 디렉터리가 없어도 확장은 설치돼 있을 수 있다. 크롬은
  // `Local Extension Settings/<id>/` 를 그 확장이 storage 에 **처음 쓰는 순간**
  // 만들기 때문이다(이 머신의 실제 프로필 4개에서 설치된 확장 23개 중 11개가
  // 그 상태였다). CLI 의 `src/browsers.js` findExtension() 도 같은 이유로
  // `Extensions/<id>` 를 함께 본다. 여기서 보지 않으면 방금 설치한 사용자에게
  // "설치하세요"라고 말하게 된다.
  if (result.extensionId === null && !result.unreadable) {
    const installed = await findInstalledExtensionDir(profileDir);
    if (installed !== null) result.extensionId = installed;
  }

  return result;
}

/**
 * `<profile>/Local Extension Settings/` 아래에서 후보 id 를 훑는다.
 *
 * @param {string} settingsRoot
 * @param {BridgeInfo} result 제자리에서 채운다
 * @returns {Promise<boolean>} 값을 찾아서 더 볼 필요가 없으면 true
 */
async function readFromSettings(settingsRoot, result) {
  const settingsEntries = await listDirOrNull(settingsRoot);
  if (settingsEntries === null) {
    result.unreadable = true;
    result.warnings.push(warn('warnDirUnreadable', settingsRoot));
    return false;
  }

  for (const id of CLAUDE_EXTENSION_IDS) {
    // 이 프로필에는 그 확장이 없다. 정상적인 경우다.
    if (!settingsEntries.some((e) => e.isDir && e.name === id)) continue;
    const dir = `${settingsRoot}/${id}`;

    // 디렉터리가 있다 = 그 확장이 설치돼 있다. 뒤의 후보가 값을 갖고 있으면
    // 그쪽으로 덮어쓴다.
    if (result.extensionId === null) result.extensionId = id;

    const entries = await listDirOrNull(dir);
    if (entries === null) {
      // 확장 폴더는 보이는데 그 안을 못 읽었다. 페어링 여부는 모르는 것이지
      // "안 됐다"가 아니다.
      result.readFailed = true;
      result.warnings.push(warn('warnDirUnreadable', dir));
      continue;
    }

    if (!entries.some((e) => !e.isDir && LEVELDB_FILE_RE.test(e.name))) {
      // 목록은 읽혔는데 안에 LevelDB 파일이 없다. 읽기 실패가 아니라 값이 없는
      // 상태다(설치만 되고 아직 아무것도 저장하지 않은 확장). readFailed 를
      // 세우지 않는다.
      result.warnings.push(warn('warnNoLevelDbFiles', dir));
      continue;
    }

    const source = makeSource(dir, { entries });
    let db;
    try {
      db = await readLevelDbFrom(source);
    } catch (err) {
      result.readFailed = true;
      result.warnings.push(warn('warnLevelDbUnreadable', dir, errorMessage(err)));
      continue;
    }
    for (const w of db.warnings) result.warnings.push(warn('warnParserNote', dir, w));

    // `readLevelDbFrom` 은 파일 읽기 실패에 예외를 던지지 않고 경고로 삼킨다.
    // 그래서 위 catch 만으로는 ".ldb/.log 를 하나도 못 읽었는데 조용히 빈 결과"
    // 를 잡지 못한다. 소스가 세어 둔 실패를 직접 본다.
    const failedReads = source.readErrors();
    if (failedReads.length > 0) result.readFailed = true;

    const found = pickBridge(db.entries, result.warnings);
    if (found.deviceId !== null || found.displayName !== null) {
      result.extensionId = id;
      result.deviceId = found.deviceId;
      result.displayName = found.displayName;
      return true;
    }
  }
  return false;
}

/**
 * `<profile>/Extensions/<id>` 로 설치 여부만 확인한다. 페어링 정보는 없다.
 *
 * @param {string} profileDir
 * @returns {Promise<string|null>} 설치된 후보 id
 */
async function findInstalledExtensionDir(profileDir) {
  const root = await findChildDirEx(profileDir, 'Extensions');
  if (root.path === null) return null;
  const entries = await listDirOrNull(root.path);
  if (entries === null) return null;
  for (const id of CLAUDE_EXTENSION_IDS) {
    if (entries.some((e) => e.isDir && e.name === id)) return id;
  }
  return null;
}

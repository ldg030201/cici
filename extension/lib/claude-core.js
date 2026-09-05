// 이 파일은 scripts/build-extension.mjs 가 자동 생성합니다. 직접 수정하지 마세요. 원본: src/claude-core.js
/**
 * Claude in Chrome 저장소에서 꺼낸 값을 해석하는 규칙.
 *
 * **이 파일은 플랫폼을 모른다.** 파일 시스템도, 노드 전용 바이트 컨테이너도,
 * DOM 도 건드리지 않는다(그 금지는 테스트가 주석까지 훑어 강제한다).
 * `scripts/build-extension.mjs` 가 `extension/lib/` 로 그대로 복사해서
 * CLI 와 확장이 **같은 코드**를 쓴다 — `leveldb-core.js` 와 같은 자격이다.
 *
 * 왜 공유해야 하는가. 여기 담긴 판정은 여섯 갈래다.
 *
 *   1. JSON 이 깨졌는데 본문이 UUID 모양   → 그 값을 쓴다 (경고)
 *   2. JSON 이 깨졌고 UUID 모양도 아님      → 버린다 (경고)
 *   3. JSON 문자열인데 UUID 모양이 아님     → 그 값을 쓴다 (경고)
 *   4. JSON 문자열이고 UUID 모양            → 그 값을 쓴다 (조용히)
 *   5. JSON 이지만 문자열이 아님            → 버린다 (경고)
 *   6. displayName 이 JSON null            → 없는 것으로 (경고 없음)
 *
 * 이걸 두 벌로 두면 한쪽만 고쳐지고 다른 쪽은 조용히 옛 규칙으로 남는다.
 * 실제로 그랬다 — 테스트가 CLI 쪽만 덮고 있어서, 정작 사용자에게 배포되는
 * 확장 쪽이 미검증인 채로 있었다.
 *
 * 경고는 문장이 아니라 `{code, params}` 로 돌려준다. 확장은 그걸 `_locales`
 * 로 번역하고, CLI 는 영어 문장으로 옮긴다. 라이브러리가 사람 문장을 만들면
 * 그 문장은 한 언어에만 맞는다.
 */

/**
 * 후보 확장 id. 앞의 것부터 시도한다.
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

/** LevelDB 가 실제 데이터를 담는 파일 이름. */
export const LEVELDB_FILE_RE = /\.(?:ldb|sst|log)$/i;

/** 저장된 값이 UUID 모양인지. 모양이 아니어도 버리지는 않는다 — 경고만 한다. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * @typedef {object} BridgeWarning
 * @property {string} code   메시지 키
 * @property {string[]} params 그 자리에 넣을 값들
 */

/**
 * @typedef {object} BridgeValues
 * @property {string|null} deviceId
 * @property {string|null} displayName
 * @property {BridgeWarning[]} warnings
 */

/** @param {unknown} err @returns {string} */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/** @param {string} code @param {...unknown} params @returns {BridgeWarning} */
function warn(code, ...params) {
  return { code, params: params.map((p) => String(p)) };
}

/**
 * 저장된 값을 JSON 으로 읽는다. 크롬은 `base::JSONWriter::Write()` 로 쓰므로
 * 문자열 값에는 따옴표가 붙어 있다.
 *
 * @param {Uint8Array|string} raw
 * @returns {{ value: unknown, text: string, error: string|null }}
 */
export function decodeJsonValue(raw) {
  const text = typeof raw === 'string' ? raw : decoder.decode(raw);
  try {
    return { value: JSON.parse(text), text, error: null };
  } catch (err) {
    return { value: undefined, text, error: errorMessage(err) };
  }
}

/**
 * 경고에 실을 짧은 발췌.
 *
 * 자르는 것은 라이브러리의 일이다 — 1MB 짜리 값을 경고에 통째로 실으면 안 된다.
 * 제어문자 이스케이프도 여기서 한다. 이 바이트는 cici 가 만들지 않은 파일에서
 * 왔고, 어느 싱크로 갈지는 모르지만 어디로도 날것으로 나가면 안 된다.
 *
 * @param {string} s
 * @returns {string}
 */
export function preview(s) {
  const one = String(s)
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.codePointAt(0).toString(16).padStart(2, '0')}`);
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
}

/**
 * LevelDB 항목에서 bridgeDeviceId / bridgeDisplayName 을 꺼낸다.
 *
 * @param {Map<string, Uint8Array|string>} entries
 * @returns {BridgeValues}
 */
export function pickBridge(entries) {
  /** @type {BridgeWarning[]} */
  const warnings = [];
  let deviceId = null;
  let displayName = null;

  const rawId = entries.get(BRIDGE_DEVICE_ID_KEY);
  if (rawId !== undefined) {
    const { value, text, error } = decodeJsonValue(rawId);
    if (error) {
      // 따옴표가 날아간 값이 실제로 나온다. 본문이 UUID 모양이면 살린다 —
      // 버리면 사용자는 있는 답을 못 받는다.
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
      // JSON `null` 은 "이름 없음" 이라는 정상적인 답이다. 경고하지 않는다.
      warnings.push(warn('warnNotJsonString', BRIDGE_DISPLAY_NAME_KEY, preview(text)));
    }
  }

  return { deviceId, displayName, warnings };
}

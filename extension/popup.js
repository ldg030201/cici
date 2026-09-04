/**
 * cici 팝업 진입점.
 *
 * 동작 순서
 *   1) chrome.extension.isAllowedFileSchemeAccess() 로 파일 URL 접근 여부를 **먼저** 본다.
 *      토글이 꺼져 있으면 file:// fetch 가 TypeError("Failed to fetch") 로 실패하는데,
 *      이 에러는 "디렉터리가 없음"과 구별이 불가능하다. 그래서 이 확인이 반드시 앞에 온다.
 *   2) 접근이 있으면 프로필을 열거하고, nonce 왕복으로 현재 프로필을 찾고,
 *      각 프로필의 bridgeDeviceId 를 읽는다.
 *   3) 현재 프로필 카드를 맨 위에 크게, 나머지는 조밀한 목록으로 그린다.
 *
 * 파일 접근 토글을 켜거나 끄면 크롬이 확장을 리로드하므로 열려 있던 팝업 문서는 죽는다.
 * 그래서 그 자리에서 자동 복구하지 않고 "켠 뒤 팝업을 다시 열어 주세요"라고만 안내한다.
 *
 * 디스크에서 읽은 값(프로필 이름, 이메일, UUID)은 전부 textContent 로만 넣는다.
 *
 * 사람에게 보이는 문장은 **전부 여기서** 만든다. `lib/*.js` 는 `_locales` 메시지
 * 키와 값만 담은 `{code, params}` 를 올려 보내고, 문장 조립은 formatWarning() 이
 * 한다. 라이브러리가 한국어 문장을 직접 만들면 en 로케일 경고 상자에 한글이
 * 그대로 박힌다(그 반대도 마찬가지다).
 */

import { resetDirCache } from './lib/fileurl.js';
import { detectPlatform, listProfileDirs, readProfileMeta, locateSelf, writeNonce } from './lib/locate.js';
import { readBridge } from './lib/read.js';

const PANELS = ['loading', 'access', 'result', 'error'];

// ---------------------------------------------------------------------------
// 작은 도우미들

/** @param {string} id */
const byId = (id) => document.getElementById(id);

/**
 * 로케일 문자열. 메시지가 없어도 팝업이 비지 않도록 키 이름으로 되돌린다.
 * @param {string} key
 * @param {string[]} [subs]
 * @returns {string}
 */
function t(key, subs) {
  try {
    const msg = globalThis.chrome?.i18n?.getMessage(key, subs);
    if (msg) return msg;
  } catch {
    // i18n 을 못 쓰는 환경(확장 밖에서 연 경우 등)
  }
  return key;
}

/**
 * createElement 축약. props 의 text 는 textContent 로 들어가므로
 * 디스크에서 온 문자열을 그대로 넘겨도 안전하다.
 *
 * @param {string} tag
 * @param {Record<string, unknown>} [props]
 * @param {...(Node|string|null|false|undefined|Array<Node|string|null|false|undefined>)} kids
 * @returns {HTMLElement}
 */
function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid);
  }
  return node;
}

/** @param {unknown} err */
function messageOf(err) {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

/** @param {string} name 보여줄 패널 이름 */
function show(name) {
  for (const panel of PANELS) {
    const node = byId(`panel-${panel}`);
    if (node) node.hidden = panel !== name;
  }
}

/** 복사 아이콘 SVG. */
function copyIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M5.5 5.5v-3h8v8h-3M2.5 5.5h8v8h-8z');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

// ---------------------------------------------------------------------------
// i18n / 클립보드 / 토스트

/** data-i18n* 속성이 붙은 정적 노드를 채운다. */
function applyStaticI18n() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll('[data-i18n-title]')) {
    node.title = t(node.dataset.i18nTitle);
  }
  for (const node of document.querySelectorAll('[data-i18n-aria]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nAria));
  }
  // `<html lang>` 은 **실제로 그려진 언어**여야 한다. `getUILanguage()` 는 브라우저
  // UI 언어일 뿐이라 그 답이 아니다. `_locales` 에는 ko/en 만 있고 default_locale
  // 은 ko 이므로, 예컨대 프랑스어 크롬에서는 화면이 전부 한국어인데 lang 은 "fr"
  // 이 된다(실측). 그러면 스크린리더가 프랑스어 음성으로 한글을 읽는다(WCAG 3.1.1).
  // 그래서 카탈로그가 스스로 자기 언어를 말하게 한다.
  const lang = t('htmlLang');
  if (lang && lang !== 'htmlLang') document.documentElement.setAttribute('lang', lang);
}

let toastTimer = 0;

/**
 * 스크린리더에만 들리는 알림.
 *
 * 팝업은 `show()` 로 패널을 통째로 바꾸는데, 포커스도 옮기지 않고 라이브 리전도
 * 건드리지 않으면 스크린리더 사용자에게는 **아무 일도 일어나지 않은 것과 같다**.
 * "다시 검사"를 눌러도 눌렸는지 끝났는지 알 방법이 없다(WCAG 4.1.3).
 *
 * 로딩 시작은 알리지 않는다. 전체 검사가 실측 13~50ms 라, 곧바로 결과 문구가
 * 덮어써서 polite 큐에서 앞 문구가 삼켜지거나 두 번 읽힌다. 끝났을 때만 알린다.
 *
 * @param {string} text
 */
function announce(text) {
  const live = byId('live');
  if (live) live.textContent = text;
}

/** @param {string} text */
function toast(text) {
  const node = byId('toast');
  announce(text);
  if (!node) return;
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 1500);
}

/**
 * 클립보드 복사. navigator.clipboard 가 막힌 상황을 대비해 execCommand 로 물러선다.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 아래 대체 경로
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok === true;
  } catch {
    return false;
  }
}

/**
 * @param {string} text
 * @param {HTMLElement} [flashNode] 성공했을 때 잠깐 강조할 요소
 */
async function copyWithFeedback(text, flashNode) {
  const ok = await copyText(text);
  toast(ok ? t('copied') : t('copyFailed'));
  if (ok && flashNode) {
    flashNode.classList.add('is-copied');
    setTimeout(() => flashNode.classList.remove('is-copied'), 900);
  }
}

// ---------------------------------------------------------------------------
// 파일 URL 접근 확인

/**
 * @returns {Promise<boolean|'unknown'>} 'unknown' 은 API 자체를 쓸 수 없다는 뜻.
 */
async function checkFileAccess() {
  const ext = globalThis.chrome?.extension;
  if (!ext || typeof ext.isAllowedFileSchemeAccess !== 'function') return 'unknown';

  // 프로미스형(MV3)
  try {
    const maybe = ext.isAllowedFileSchemeAccess();
    if (maybe && typeof maybe.then === 'function') {
      const value = await maybe;
      if (typeof value === 'boolean') return value;
    }
  } catch {
    // 콜백만 받는 빌드일 수 있다
  }

  // 콜백형
  try {
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => finish('unknown'), 3000);
      ext.isAllowedFileSchemeAccess((allowed) => {
        clearTimeout(timer);
        finish(typeof allowed === 'boolean' ? allowed : 'unknown');
      });
    });
  } catch {
    return 'unknown';
  }
}

/** chrome://extensions 의 이 확장 세부정보 주소. */
function settingsUrl() {
  let id = '';
  try {
    id = globalThis.chrome?.runtime?.id ?? '';
  } catch {
    id = '';
  }
  return id ? `chrome://extensions/?id=${id}` : 'chrome://extensions';
}

// ---------------------------------------------------------------------------
// 수집

/**
 * @typedef {object} Row
 * @property {string} browserName
 * @property {string} userDataDir
 * @property {string} profileDir
 * @property {string} profileDirName
 * @property {string} label     화면에 크게 쓸 프로필 이름
 * @property {string|null} sublabel 이메일 등 보조 줄
 * @property {{extensionId: string|null, deviceId: string|null, displayName: string|null, unreadable?: boolean, warnings: Array<{code: string, params: string[]}>}} bridge
 * @property {boolean} isSelf
 */

/**
 * 검사 전체에 걸리는 상한.
 *
 * `lib/fileurl.js` 가 fetch 하나하나에 이미 타임아웃을 걸지만, 그것만으로는
 * 부족하다. Chromium 의 `file://` 로더는 문서마다 요청을 직렬로 처리해서, 멈춘
 * 읽기 하나가 그 뒤 모든 읽기를 막는다(실측: FIFO 를 abort 로 끊어도 같은
 * 문서의 다음 읽기는 계속 pending). 그래서 개별 타임아웃이 차례로 만료되기를
 * 기다리면 전체가 몇 분이 될 수 있다. 이 예산이 실질적인 탈출구다.
 */
const SCAN_BUDGET_MS = 15000;

/**
 * 마감시한 하나. 시간이 다 되거나 사용자가 "중단"을 누르면 열린다.
 *
 * @param {number} ms
 */
function makeDeadline(ms) {
  let open = () => {};
  const promise = new Promise((resolve) => {
    open = () => resolve(TIMED_OUT);
  });
  const timer = setTimeout(() => open(), ms);
  return {
    promise,
    /** 사용자가 기다리기를 그만뒀다. */
    fire() {
      open();
    },
    cancel() {
      clearTimeout(timer);
    },
  };
}

/** `makeDeadline` 이 이겼음을 나타내는 표식. 값과 헷갈릴 수 없어야 한다. */
const TIMED_OUT = Symbol('timed-out');

/**
 * `promise` 를 기다리되 마감시한을 넘기면 `fallback` 으로 넘어간다.
 *
 * 넘어간 뒤에도 원래 promise 는 계속 돌아간다(멈춰 있을 뿐 취소할 방법이 없다).
 * unhandled rejection 이 되지 않도록 잡아 둔다.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {{promise: Promise<symbol>}} deadline
 * @param {T} fallback
 * @param {() => void} [onTimeout]
 * @returns {Promise<T>}
 */
async function withDeadline(promise, deadline, fallback, onTimeout) {
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {});
  const winner = await Promise.race([guarded, deadline.promise]);
  if (winner === TIMED_OUT) {
    if (onTimeout) onTimeout();
    return fallback;
  }
  return winner;
}

/** 지금 도는 검사의 마감시한. "중단" 버튼이 이걸 연다. */
let currentDeadline = null;

/** 로딩 화면의 "중단" 버튼. */
function abortScan() {
  if (currentDeadline) currentDeadline.fire();
}

/**
 * 프로필 열거 → 자기 탐지 + bridge 조회를 한 번에.
 * 개별 실패는 경고로 흡수하고, 전체가 죽지 않게 한다.
 */
async function collect() {
  /** @type {Array<{code: string, params: string[]}>} */
  const warnings = [];

  // 디렉터리 목록 캐시를 비운다. "다시 검사"는 그 사이에 바뀐 디스크를 봐야 한다.
  resetDirCache();

  const deadline = makeDeadline(SCAN_BUDGET_MS);
  currentDeadline = deadline;
  // 예산을 넘긴 사실은 한 줄이면 충분하다. 프로필마다 따로 끊기 때문에 그대로
  // 두면 같은 문구가 여러 번 쌓인다.
  let noted = false;
  const noteTimeout = () => {
    if (noted) return;
    noted = true;
    warnings.push({ code: 'warnScanTimeout', params: [] });
  };

  try {
    const platform = await detectPlatform();

    // 자기 표식을 **디렉터리를 훑기 전에** 남긴다. 확장을 갓 설치한 프로필에는
    // 우리 저장소 디렉터리가 아직 없고, 그건 이 write 가 만든다. 목록을 먼저
    // 읽으면 없는 상태가 캐시에 굳어서 첫 팝업이 자기를 놓친다(실측 확인).
    let nonce = null;
    try {
      nonce = await writeNonce();
    } catch (err) {
      warnings.push(warningFromError(err));
    }

    const profiles = await withDeadline(listProfileDirs(platform, warnings), deadline, [], noteTimeout);

    if (!Array.isArray(profiles) || profiles.length === 0) {
      // `noted` 를 함께 실어 보낸다. "정말 하나도 없다"와 "검사가 잘려서 못
      // 찾았다"는 사용자가 취할 행동이 완전히 다르다.
      return { rows: [], selfFound: false, warnings, truncated: noted };
    }

    const [self, bridges, metas] = await Promise.all([
      nonce === null
        ? Promise.resolve(null)
        : withDeadline(
            Promise.resolve()
              .then(() => locateSelf(profiles, nonce, warnings))
              .catch((err) => {
                warnings.push(warningFromError(err));
                return null;
              }),
            deadline,
            null,
            noteTimeout,
          ),
      Promise.all(
        // 프로필마다 따로 끊는다. 하나가 멈춰도 나머지는 그대로 나온다.
        profiles.map((p) =>
          withDeadline(
            Promise.resolve()
              .then(() => readBridge(p.profileDir))
              .catch((err) => {
                warnings.push({ code: 'warnProfileRead', params: [p.profileDir, messageOf(err)] });
                return unreadableBridge();
              }),
            deadline,
            unreadableBridge(),
            noteTimeout,
          ),
        ),
      ),
      withDeadline(loadMetas(profiles, warnings), deadline, new Map(), noteTimeout),
    ]);

    const selfDir = self && typeof self.profileDir === 'string' ? self.profileDir : null;

    /** @type {Row[]} */
    const rows = profiles.map((p, i) => {
      const bridge = bridges[i] ?? unreadableBridge();
      for (const w of bridge.warnings ?? []) warnings.push(w);
      const meta = metas.get(p.userDataDir)?.get(p.profileDirName) ?? null;
      return {
        browserName: p.browserName || '',
        userDataDir: p.userDataDir,
        profileDir: p.profileDir,
        profileDirName: p.profileDirName,
        label:
          nonEmpty(meta?.name) ??
          nonEmpty(meta?.gaiaName) ??
          nonEmpty(p.profileDirName) ??
          t('unnamedProfile'),
        sublabel: subLabel(meta, p.profileDirName),
        bridge,
        isSelf: selfDir !== null && p.profileDir === selfDir,
      };
    });

    return { rows, selfFound: rows.some((r) => r.isSelf), warnings, truncated: noted };
  } finally {
    deadline.cancel();
    currentDeadline = null;
  }
}

/** 못 읽은 프로필의 bridge 자리. "확장이 없다"와 구별된다. */
function unreadableBridge() {
  return {
    extensionId: null,
    deviceId: null,
    displayName: null,
    unreadable: true,
    readFailed: false,
    warnings: [],
  };
}

/**
 * 에러 하나를 경고 한 줄로.
 *
 * `lib/*.js` 가 던지는 에러에는 `_locales` 키가 붙어 있다. 그 밖의 에러(브라우저가
 * 만든 "Failed to fetch" 같은 것)는 우리가 번역할 수 없으므로 그대로 끼워 넣는다.
 *
 * @param {unknown} err
 * @returns {{code: string, params: string[]}}
 */
function warningFromError(err) {
  if (err && typeof err === 'object' && typeof err.i18nCode === 'string') {
    return { code: err.i18nCode, params: Array.isArray(err.i18nParams) ? err.i18nParams : [] };
  }
  return { code: 'warnSelfDetect', params: [messageOf(err)] };
}

/**
 * `{code, params}` 를 사람이 읽는 한 줄로. 문자열이 그대로 오면 그대로 쓴다.
 *
 * @param {{code: string, params: string[]}|string} warning
 * @returns {string}
 */
function formatWarning(warning) {
  if (typeof warning === 'string') return warning;
  if (!warning || typeof warning.code !== 'string') return String(warning);
  return t(warning.code, Array.isArray(warning.params) ? warning.params.map(String) : []);
}

/**
 * user-data-dir 별로 Local State 를 한 번씩만 읽는다.
 * @param {Array<{userDataDir: string}>} profiles
 * @param {Array<{code: string, params: string[]}>} warnings
 */
async function loadMetas(profiles, warnings) {
  const dirs = [...new Set(profiles.map((p) => p.userDataDir))];
  const results = await Promise.all(
    dirs.map((dir) =>
      Promise.resolve()
        .then(() => readProfileMeta(dir))
        .catch((err) => {
          warnings.push({ code: 'warnLocalState', params: [dir, messageOf(err)] });
          return new Map();
        }),
    ),
  );
  return new Map(dirs.map((dir, i) => [dir, results[i] instanceof Map ? results[i] : new Map()]));
}

/** @param {unknown} value */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * 카드/행의 둘째 줄. 이름과 겹치는 값은 넣지 않는다.
 * @param {{name?: string, email?: string, gaiaName?: string}|null} meta
 * @param {string} dirName
 */
function subLabel(meta, dirName) {
  const parts = [];
  const email = nonEmpty(meta?.email);
  const name = nonEmpty(meta?.name);
  if (email && email !== name) parts.push(email);
  if (dirName && dirName !== name && dirName !== email) parts.push(dirName);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// ---------------------------------------------------------------------------
// 렌더링

/** 현재 프로필 카드. */
function renderSelfCard(row) {
  const card = h('article', { class: 'card card-self' });

  card.append(
    h(
      'div',
      { class: 'card-top' },
      row.browserName ? h('span', { class: 'browser', text: row.browserName }) : null,
      h('span', { class: 'badge', text: t('badgeCurrent') }),
    ),
    h('div', { class: 'pname', text: row.label }),
    row.sublabel ? h('div', { class: 'psub', text: row.sublabel }) : null,
  );

  if (row.bridge.deviceId) {
    // 복사 버튼은 라벨 줄에 둔다. 그래야 아래 UUID 상자가 카드 폭을 전부 써서
    // 36자가 한 줄에 들어간다. 키보드 접근은 이 버튼이 담당하고,
    // 상자는 마우스로 클릭(복사)하거나 드래그(전체 선택)할 수 있다.
    const button = h(
      'button',
      { class: 'copy-btn copy-btn-lead', type: 'button', 'aria-label': t('copyDeviceIdAria') },
      copyIcon(),
      h('span', { text: t('copy') }),
    );
    const box = h(
      'div',
      { class: 'uuid', title: t('clickToCopy') },
      h('span', { class: 'uuid-text', text: row.bridge.deviceId }),
    );
    const copy = () => copyWithFeedback(row.bridge.deviceId, box);
    button.addEventListener('click', copy);
    box.addEventListener('click', copy);

    card.append(
      h(
        'div',
        { class: 'field-row' },
        h('span', { class: 'field-label', text: t('deviceIdLabel') }),
        button,
      ),
      box,
    );

    if (row.bridge.displayName) {
      card.append(
        h(
          'div',
          { class: 'kv' },
          h('span', { class: 'k', text: t('pairingNameLabel') }),
          h('span', { class: 'v', text: row.bridge.displayName }),
        ),
      );
    }
  } else {
    card.append(stateNote(row.bridge));
  }

  return card;
}

/**
 * bridgeDeviceId 가 없을 때의 안내 블록.
 *
 * 네 가지가 서로 다른 답이다.
 *   - 프로필 폴더를 못 읽음 → 확장이 있는지 **모른다**. "없다"고 단정하면 거짓말이다.
 *   - 확장 저장소를 못 읽음 → 페어링됐는지 **모른다**. "안 됐다"고 단정하면 거짓말이다.
 *   - 설치는 됐지만 페어링 전
 *   - 확장 자체가 없음
 *
 * 판정 순서가 중요하다. "모른다"를 먼저 본다. 예전에는 `extensionId === null` 을
 * 함께 요구했는데, 확장 폴더가 보이는 순간 extensionId 가 채워지므로 그 조건
 * 아래에서는 "저장소를 못 읽었다"를 화면에 표현할 방법 자체가 없었다.
 */
function stateNote(bridge) {
  if (bridge.unreadable && bridge.extensionId === null) {
    return h(
      'div',
      { class: 'state state-warn' },
      h('div', { class: 'state-title', text: t('profileUnreadable') }),
      h('div', { class: 'state-hint', text: t('profileUnreadableHint') }),
    );
  }
  if (bridge.readFailed || bridge.unreadable) {
    return h(
      'div',
      { class: 'state state-warn' },
      h('div', { class: 'state-title', text: t('pairingUnknown') }),
      h('div', { class: 'state-hint', text: t('pairingUnknownHint') }),
    );
  }
  const paired = Boolean(bridge.extensionId);
  return h(
    'div',
    { class: paired ? 'state state-warn' : 'state' },
    h('div', { class: 'state-title', text: paired ? t('notPaired') : t('claudeNotInstalled') }),
    h('div', { class: 'state-hint', text: paired ? t('notPairedHint') : t('claudeNotInstalledHint') }),
  );
}

/** 목록 행에 쓸 짧은 상태 문구. stateNote 와 같은 네 갈래다. */
function rowNote(bridge) {
  if (bridge.unreadable && bridge.extensionId === null) return t('profileUnreadable');
  if (bridge.readFailed || bridge.unreadable) return t('pairingUnknown');
  return bridge.extensionId ? t('notPaired') : t('claudeNotInstalled');
}

/** 현재 프로필을 못 찾았을 때 카드 자리에 넣는 안내. */
function renderSelfUnknown() {
  return h(
    'article',
    { class: 'card' },
    h('div', { class: 'state-title', text: t('selfNotFoundTitle') }),
    h('div', { class: 'state-hint', text: t('selfNotFoundHint') }),
  );
}

/** 다른 프로필 한 줄. */
function renderRow(row) {
  // 보조 줄(이메일 · 폴더 이름)이 없으면 이름이 같은 두 프로필을 구별할 방법이
  // 사라진다. 로그인한 프로필은 이름을 안 바꾸면 크롬이 gaia_name 을 그대로
  // 쓰므로 "Work"가 둘인 상황은 드물지 않고, 그때 두 행은 UUID 만 빼고 글자
  // 하나까지 같아진다 — 어느 UUID 가 어느 프로필인지 알려 주는 것이 이 확장의
  // 존재 이유인데 그 화면에서 그게 무너진다.
  const main = h(
    'div',
    { class: 'row-main' },
    h(
      'div',
      { class: 'row-title' },
      row.browserName ? h('span', { class: 'row-browser', text: row.browserName }) : null,
      row.browserName ? h('span', { class: 'row-sep', text: ' \u00b7 ' }) : null,
      h('span', { class: 'row-name', title: row.label, text: row.label }),
    ),
    row.sublabel ? h('div', { class: 'row-sub', title: row.sublabel, text: row.sublabel }) : null,
    row.bridge.deviceId
      ? h('code', { class: 'row-uuid', text: row.bridge.deviceId })
      : h('span', { class: 'row-note', text: rowNote(row.bridge) }),
  );

  const item = h('li', { class: 'row' }, main);

  if (row.bridge.deviceId) {
    const label = row.sublabel ? `${row.label} (${row.sublabel})` : row.label;
    const button = h('button', {
      class: 'copy-btn',
      type: 'button',
      text: t('copy'),
      'aria-label': t('copyOfAria', [label]),
    });
    button.addEventListener('click', () => copyWithFeedback(row.bridge.deviceId, item));
    item.append(button);
  }

  return item;
}

/**
 * @param {{rows: Row[], selfFound: boolean, warnings: Array<{code: string, params: string[]}>}} data
 */
function render(data) {
  const selfSlot = byId('self-slot');
  const othersSlot = byId('others-slot');
  const selfLabel = byId('self-label');
  const othersLabel = byId('others-label');
  selfSlot.replaceChildren();
  othersSlot.replaceChildren();

  if (data.rows.length === 0) {
    // 프로필이 하나도 없으면 "현재 프로필"이라는 제목도 거짓말이 된다.
    selfLabel.hidden = true;
    // 검사가 예산을 넘겨(또는 사용자가 "중단"을 눌러) 잘렸다면 "하나도 없다"는
    // 단정이 거짓이다. 우리는 세다가 만 것이지 다 세고 0을 얻은 게 아니다.
    // 할 일도 다르다 — 이쪽은 "다시 검사", 저쪽은 설치 위치 확인이다.
    const cut = Boolean(data.truncated);
    const title = cut ? t('scanCutShortTitle') : t('noProfilesTitle');
    selfSlot.append(
      h(
        'article',
        { class: 'card' },
        h('div', { class: 'state-title', text: title }),
        h('div', { class: 'state-hint', text: cut ? t('scanCutShortHint') : t('noProfilesHint') }),
      ),
    );
    othersLabel.hidden = true;
    // 이 화면에는 결과가 한 줄도 없다. 유일한 단서를 접어 두면 안 된다.
    renderWarnings(data.warnings, { open: cut });
    show('result');
    announce(title);
    return;
  }

  selfLabel.hidden = false;
  const self = data.rows.find((r) => r.isSelf) ?? null;
  selfSlot.append(self ? renderSelfCard(self) : renderSelfUnknown());

  const others = data.rows
    .filter((r) => r !== self)
    .sort((a, b) => {
      // ID 가 있는 프로필을 먼저, 그다음 브라우저 이름, 그다음 프로필 이름.
      const byId_ = Number(Boolean(b.bridge.deviceId)) - Number(Boolean(a.bridge.deviceId));
      if (byId_ !== 0) return byId_;
      return (
        a.browserName.localeCompare(b.browserName) || a.label.localeCompare(b.label)
      );
    });

  // 자기 프로필을 못 찾았으면 이 목록에는 현재 프로필도 들어 있다. 그때
  // "이 컴퓨터의 다른 프로필"이라는 제목은 바로 위 안내("아래 목록에서 직접
  // 찾아 주세요")와 정면으로 모순된다. "모든 프로필"이라고 하면 이번엔 열거에
  // 실패한 경우(커스텀 --user-data-dir 등)에 과장이 되므로, 중립적으로 적는다.
  othersLabel.textContent = self ? t('otherProfiles') : t('foundProfiles');
  othersLabel.hidden = false;
  if (others.length === 0) {
    othersSlot.append(h('li', { class: 'empty-line small', text: t('noOtherProfiles') }));
  } else {
    for (const row of others) othersSlot.append(renderRow(row));
  }

  renderWarnings(data.warnings);
  show('result');
  announce(
    self
      ? t('statusScanned', [self.label, String(others.length)])
      : t('statusScannedNoSelf', [String(others.length)]),
  );
}

/**
 * @param {Array<{code: string, params: string[]}|string>} warnings
 * @param {{open?: boolean}} [options] 접힌 상자가 유일한 단서일 때는 펼쳐 둔다
 */
function renderWarnings(warnings, options = {}) {
  const box = byId('warn-box');
  const text = byId('warn-text');
  // 같은 줄이 두 번 나오는 일이 실제로 있다. 예컨대 프로필 폴더를 못 읽으면
  // 열거(listProfileDirs)와 조회(readBridge)가 각각 같은 말을 한다. 사용자에게는
  // 한 번이면 충분하다.
  const list = [...new Set((warnings ?? []).filter(Boolean).map(formatWarning).filter(Boolean))];
  if (list.length === 0) {
    box.hidden = true;
    box.open = false;
    text.textContent = '';
    return;
  }
  text.textContent = list.join('\n');
  box.hidden = false;
  box.open = Boolean(options.open);
}

/** 파일 URL 접근이 꺼져 있을 때. */
function renderNeedAccess() {
  const url = settingsUrl();
  byId('settings-url').textContent = url;
  byId('btn-refresh').hidden = true;
  show('access');
  announce(t('needFileAccessTitle'));
}

/**
 * 이 확장을 알릴 곳. `manifest.json` 의 `homepage_url` 에서 가져온다.
 * 코드에 주소를 박아 두지 않으므로 저장소 위치가 바뀌어도 한 군데만 고치면 된다.
 *
 * @returns {string} 없으면 빈 문자열
 */
/** 푸터의 깃허브 링크를 manifest 의 homepage_url 로 채운다. 주소가 없으면 숨긴 채 둔다. */
function fillSourceLink() {
  const node = byId('gh-link');
  if (!node) return;
  const home = homepageUrl();
  if (home === '') return;
  node.href = home;
  node.hidden = false;
}

function homepageUrl() {
  try {
    const url = globalThis.chrome?.runtime?.getManifest?.()?.homepage_url;
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
}

/** 오류 화면에 담을 진단 텍스트. */
let errorDetails = '';

/** @param {unknown} err */
function renderFatal(err) {
  try {
    errorDetails = err instanceof Error && err.stack ? err.stack : messageOf(err);
    byId('error-text').textContent = errorDetails;
    // "알려 주세요"라고 말하면서 알릴 곳을 안 알려 주면 지시를 따를 수가 없다.
    // 웹스토어로 설치한 사용자는 이 확장의 소스가 어디 있는지 알 방법이 없다.
    const home = homepageUrl();
    const node = byId('issue-url');
    if (node) {
      node.textContent = home;
      const line = byId('issue-url-line');
      if (line) line.hidden = home === '';
    }
    byId('btn-refresh').hidden = false;
    show('error');
    announce(t('errorTitle'));
  } catch {
    // 마지막 안전망: 최소한의 텍스트라도 남긴다.
    document.body.textContent = `${t('errorTitle')}: ${messageOf(err)}`;
  }
}

// ---------------------------------------------------------------------------
// 실행

let running = false;

async function run() {
  if (running) return;
  running = true;
  const refresh = byId('btn-refresh');
  refresh.setAttribute('data-busy', '');
  // prefers-reduced-motion 에서는 data-busy 의 회전이 꺼지므로, 그것만으로는
  // "지금 도는 중"이라는 정보가 아무에게도 닿지 않는다.
  refresh.setAttribute('aria-busy', 'true');

  try {
    const access = await checkFileAccess();
    if (access === false) {
      renderNeedAccess();
      return;
    }

    show('loading');
    const data = await collect();

    // API 를 못 써서 그냥 시도한 경우, 결과가 비었다면 십중팔구 토글이 꺼진 것이다.
    if (access === 'unknown' && data.rows.length === 0) {
      renderNeedAccess();
      return;
    }

    refresh.hidden = false;
    render(data);
  } catch (err) {
    renderFatal(err);
  } finally {
    refresh.removeAttribute('data-busy');
    refresh.setAttribute('aria-busy', 'false');
    running = false;
  }
}

function wire() {
  byId('btn-refresh').addEventListener('click', run);
  byId('btn-retry').addEventListener('click', run);

  // 읽기 하나가 멈춰도 사용자가 기다림을 끝낼 수 있어야 한다. 누르면 그때까지
  // 모인 결과가 그려진다.
  byId('btn-cancel').addEventListener('click', abortScan);

  byId('btn-copy-url').addEventListener('click', () => {
    copyWithFeedback(settingsUrl());
  });

  byId('btn-copy-error').addEventListener('click', () => {
    copyWithFeedback(errorDetails || t('errorTitle'));
  });

  byId('btn-open-settings').addEventListener('click', () => {
    const url = settingsUrl();
    try {
      // tabs 권한 없이도 chrome.tabs.create 로 새 탭을 열 수 있다.
      // 탭이 열리면 이 팝업은 닫힌다 — 그래서 주소 복사 버튼을 함께 둔다.
      if (globalThis.chrome?.tabs?.create) chrome.tabs.create({ url });
      else window.open(url, '_blank');
    } catch {
      copyWithFeedback(url);
    }
  });
}

function boot() {
  try {
    applyStaticI18n();
    fillSourceLink();
    wire();
  } catch (err) {
    renderFatal(err);
    return;
  }
  run();
}

boot();

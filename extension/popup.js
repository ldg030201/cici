/**
 * cici 팝업 진입점.
 *
 * 동작 순서
 *   1) 지난 검사 결과가 세션 캐시(chrome.storage.session)에 있으면 **그것부터
 *      즉시 그린다.** 검사는 디스크를 처음부터 다시 훑는 일이라 프로필이 많은
 *      컴퓨터에서는 몇 초씩 걸리는데, 그 결과는 브라우저를 껐다 켜기 전에는
 *      거의 바뀌지 않기 때문이다.
 *   2) chrome.extension.isAllowedFileSchemeAccess() 로 파일 URL 접근 여부를 **먼저** 본다.
 *      토글이 꺼져 있으면 file:// fetch 가 TypeError("Failed to fetch") 로 실패하는데,
 *      이 에러는 "디렉터리가 없음"과 구별이 불가능하다. 그래서 이 확인이 반드시 앞에 온다.
 *   3) 접근이 있으면 프로필을 열거하고, nonce 왕복으로 현재 프로필을 찾고,
 *      각 프로필의 bridgeDeviceId 를 읽는다. 캐시를 그려 뒀어도 이 재검사는
 *      항상 돌고, 결과가 캐시와 다를 때만 화면을 갈아 끼운다(stale-while-revalidate).
 *   4) 현재 프로필 카드를 맨 위에 크게, 나머지는 조밀한 목록으로 그린다.
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

import { resetDirCache, resetFetchStats, snapshotFetchStats } from './lib/fileurl.js';
import { detectPlatform, listProfileDirs, readProfileMeta, locateSelf, writeNonce } from './lib/locate.js';
import { readBridge } from './lib/read.js';

const PANELS = ['loading', 'access', 'result', 'error'];

// ---------------------------------------------------------------------------
// 작은 도우미들

/** @param {string} id */
const byId = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// 표시 언어
//
// chrome.i18n 은 브라우저 UI 언어에 고정돼 있어 확장이 바꿀 방법이 없다. 그래서
// 사용자가 헤더에서 언어를 고르면, 그 로케일의 messages.json 을 확장 패키지에서
// 직접 읽어 t() 가 chrome.i18n 보다 먼저 보게 한다. 'auto' 는 브라우저 언어
// 그대로다. 선택은 chrome.storage.local 에 남는다 — 이 확장이 자기 저장소에
// 쓰는 값은 자기 탐지용 난수(lib/locate.js), 이 설정, 그리고 검사 결과 캐시
// (chrome.storage.session, 아래 SCAN_CACHE_KEY) 셋뿐이다(개인정보 문서가 이
// 사실을 그대로 나열하므로, 여기에 키를 더하거나 빼면 그 문서도 고쳐야 한다).

const LANG_PREF_KEY = '__cici_lang';

/** 고른 로케일의 카탈로그. null 이면 chrome.i18n(브라우저 언어)을 쓴다. */
let overrideCatalog = null;

/**
 * 패키지 안의 카탈로그를 읽는다. CSP 의 connect-src 'self' 가 허용하는 경로다.
 * @param {string} lang `_locales` 디렉터리 이름
 */
async function loadCatalog(lang) {
  // 옵션 value 는 popup.html 이 정의하고 테스트가 _locales 와 대조하지만,
  // 저장소에서 읽은 값이 흘러들 수도 있으니 경로 조각으로 안전한지 한 번 더 본다.
  if (!/^[A-Za-z_]+$/.test(lang)) throw new Error(`unexpected locale: ${lang}`);
  const getURL = globalThis.chrome?.runtime?.getURL;
  if (typeof getURL !== 'function') throw new Error('no extension context');
  const res = await fetch(getURL(`_locales/${lang}/messages.json`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

/**
 * 카탈로그 항목 하나를 크롬과 같은 규칙으로 조립한다.
 * `$NAME$`(대소문자 무관) → placeholders[name].content 의 `$1…$9` → subs.
 * `$$` 는 `$` 하나다.
 *
 * @param {{message: string, placeholders?: Record<string, {content?: string}>}} entry
 * @param {string[]} subs
 */
function catalogMessage(entry, subs) {
  const byName = new Map(
    Object.entries(entry.placeholders ?? {}).map(([name, p]) => [
      name.toLowerCase(),
      String(p?.content ?? ''),
    ]),
  );
  return entry.message.replace(/\$\$|\$([A-Za-z0-9_@]+)\$/g, (match, name) => {
    if (match === '$$') return '$';
    const content = byName.get(String(name).toLowerCase());
    if (content === undefined) return match;
    return content.replace(/\$(\d)/g, (_, digit) => String(subs[Number(digit) - 1] ?? ''));
  });
}

/** @returns {Promise<string>} 저장된 선택. 없거나 못 읽으면 'auto'. */
async function readLangPref() {
  try {
    const got = await globalThis.chrome?.storage?.local?.get(LANG_PREF_KEY);
    const value = got?.[LANG_PREF_KEY];
    return typeof value === 'string' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

/** @param {string} value */
async function writeLangPref(value) {
  try {
    await globalThis.chrome?.storage?.local?.set({ [LANG_PREF_KEY]: value });
  } catch {
    // 저장이 안 돼도 이번 팝업이 열려 있는 동안은 고른 언어로 동작한다.
  }
}

/**
 * 선택을 적용하고 셀렉터 표시를 실제 상태와 맞춘다. 카탈로그를 못 읽으면
 * (지워진 로케일이 저장돼 있던 경우 등) 조용히 'auto' 로 물러선다 — 팝업이
 * 언어 설정 때문에 죽으면 안 된다.
 *
 * @param {string} value 'auto' 또는 `_locales` 디렉터리 이름
 */
async function applyLangChoice(value) {
  overrideCatalog = value === 'auto' ? null : await loadCatalog(value).catch(() => null);
  const select = byId('lang-select');
  if (select) select.value = overrideCatalog === null ? 'auto' : value;
}

/**
 * 언어 단추에 **지금 보고 있는 언어**의 국기를 그린다.
 *
 * 지구본은 "언어를 바꿀 수 있다"까지만 말하고 "지금 무슨 언어인가"는 말하지
 * 않는다. 화면 글자를 못 읽는 사람에게 정작 필요한 정보가 그것이다.
 *
 * 국기 글자의 출처는 `popup.html` 의 `<option>` 들이다 — 목록에 이미 언어마다
 * 국기가 붙어 있으므로, 여기서 같은 표를 코드에 또 적으면 둘이 갈라진다.
 * 어느 언어인지는 카탈로그가 스스로 말하는 `htmlLang` 으로 정한다. `auto` 일
 * 때도 그 값은 **실제로 그려진 언어**라서, 브라우저 언어가 `_locales` 에 없어
 * 영어(default_locale)로 떨어진 경우에도 영국/미국기가 정직하게 나온다.
 */
function updateLangFlag() {
  const node = byId('lang-flag');
  if (!node) return;
  const lang = t('htmlLang');
  const select = byId('lang-select');
  // `.options` 가 아니라 querySelectorAll 을 쓴다 — 어느 DOM 구현에서나 있다.
  const options = select ? [...select.querySelectorAll('option')] : [];
  const valueOf = (o) => String(o.getAttribute('value') ?? '').toLowerCase();
  // `htmlLang` 은 BCP 47(zh-CN)이고 option value 는 디렉터리 이름(zh_CN)이다.
  const wanted = String(lang).replace(/-/g, '_').toLowerCase();
  const hit =
    options.find((o) => valueOf(o) === wanted) ?? options.find((o) => valueOf(o) === wanted.split('_')[0]);
  // 옵션 텍스트의 맨 앞 이모지(또는 지역표시 문자 두 글자)만 떼어 쓴다.
  const flag = hit
    ? (/^\s*(\p{Regional_Indicator}{2}|\p{Extended_Pictographic})/u.exec(hit.textContent ?? '')?.[1] ?? '')
    : '';
  // 국기를 못 고르면 언어 코드를 대문자로 보여 준다. 빈 상자보다는 낫다.
  node.textContent = flag || String(lang).slice(0, 5).toUpperCase();
}

/**
 * 로케일 문자열. 사용자가 고른 카탈로그가 먼저고, 다음이 브라우저 언어이며,
 * 그래도 없으면 팝업이 비지 않도록 키 이름으로 되돌린다.
 * @param {string} key
 * @param {string[]} [subs]
 * @returns {string}
 */
function t(key, subs) {
  const entry = overrideCatalog?.[key];
  if (entry && typeof entry.message === 'string') {
    const list = Array.isArray(subs) ? subs.map(String) : subs === undefined ? [] : [String(subs)];
    return catalogMessage(entry, list);
  }
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
  updateLangFlag();
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
// 검사 결과 캐시 (stale-while-revalidate)
//
// 검사는 디스크를 처음부터 다시 훑는 일이고, Chromium 의 file:// 로더는 한
// 문서의 요청을 직렬로 처리하므로 프로필이 많은 컴퓨터에서는 몇 초씩 걸린다.
// 그런데 그 결과(UUID·프로필 목록)는 브라우저를 껐다 켜기 전에는 거의 바뀌지
// 않는다. 그래서 마지막 결과를 chrome.storage.session 에 두고, 팝업이 열리면
// 캐시부터 즉시 그린 뒤(체감 0초) 검사를 뒤에서 다시 돌린다.
//
// local 이 아니라 **session** 인 이유: 메모리에만 있어 디스크에 아무것도 남지
// 않고, 브라우저를 끄면 사라진다. 캐시를 "정답"으로 믿지는 않는다 — 재페어링
// 으로 UUID 가 바뀌거나 프로필이 늘어나는 일은 세션 안에서도 생기므로, 재검사가
// 항상 따라붙고 결과가 다르면 화면을 갈아 끼운다. "다시 검사" 버튼은 예전처럼
// 언제나 디스크를 새로 읽는다.

/** 마지막 검사 결과를 넣어 두는 `chrome.storage.session` 키. */
const SCAN_CACHE_KEY = '__cici_scan';

/**
 * 이번 브라우저 세션에서 자기 프로필로 **확인된** 디렉터리. null 이면 아직
 * 모른다. 팝업과 프로필은 1:1 이라 같은 세션 안에서 이 답이 바뀔 방법이 없고,
 * 이 값이 있으면 nonce 왕복(모든 프로필의 우리 저장소 LevelDB 읽기)을 통째로
 * 건너뛸 수 있다.
 */
let cachedSelfDir = null;

/**
 * 캐시에서 꺼낸 데이터가 render() 가 그릴 수 있는 모양인지.
 * 캐시는 우리 확장만 쓰는 저장소지만, 확장 업데이트로 모양이 바뀐 옛 캐시가
 * 남아 있을 수 있다(v 필드가 1차 방어, 이 검사가 2차다).
 *
 * @param {unknown} data
 * @returns {boolean}
 */
function validScanData(data) {
  if (!data || typeof data !== 'object') return false;
  if (!Array.isArray(data.rows) || !Array.isArray(data.warnings)) return false;
  return data.rows.every(
    (r) => r && typeof r === 'object' && typeof r.label === 'string' && r.bridge && typeof r.bridge === 'object',
  );
}

/**
 * @returns {Promise<{data: object, selfProfileDir: string|null}|null>}
 *   캐시가 없거나, 못 읽거나, 모양이 이상하면 null.
 */
async function readScanCache() {
  try {
    const got = await globalThis.chrome?.storage?.session?.get(SCAN_CACHE_KEY);
    const hit = got?.[SCAN_CACHE_KEY];
    if (!hit || typeof hit !== 'object' || hit.v !== 1 || !validScanData(hit.data)) return null;
    return {
      data: hit.data,
      selfProfileDir: typeof hit.selfProfileDir === 'string' ? hit.selfProfileDir : null,
    };
  } catch {
    return null;
  }
}

/**
 * 검사 결과를 캐시에 남긴다.
 *
 * 잘린 검사(truncated)는 남기지 않는다 — 다음 팝업의 첫 화면이 "검사가
 * 잘렸습니다"가 되면 캐시가 있으나 마나다. 확인된 빈 결과(프로필 0개)는 낡은
 * 캐시를 **지운다**. 지우지 않으면 이제는 없는 프로필 목록이 열 때마다 깜빡
 * 보인다.
 *
 * @param {{rows: Row[], truncated?: boolean}} data collect() 의 결과
 */
async function writeScanCache(data) {
  try {
    const session = globalThis.chrome?.storage?.session;
    if (!session) return;
    if (data.truncated) return;
    if (data.rows.length === 0) {
      await session.remove(SCAN_CACHE_KEY);
      return;
    }
    await session.set({ [SCAN_CACHE_KEY]: { v: 1, data, selfProfileDir: cachedSelfDir } });
  } catch {
    // 캐시가 안 돼도 검사는 이미 끝났다. 다음 팝업이 조금 느릴 뿐이다.
  }
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
 * @property {import('./lib/read.js').BridgeInfo} bridge
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

/** performance.now 가 없는 런타임(테스트 등)을 대비한다. */
function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * 계측 한 줄을 콘솔에 남긴다. 사람에게 보이는 화면이 아니라 DevTools 의
 * Verbose 레벨에만 나오므로(console.debug) 영어로 적는다 — `lib/*.js` 의 에러
 * 문구와 같은 이유다. 검사가 느리다는 제보가 오면 이 줄이 첫 단서다:
 * enumerate/self/bridge/meta 는 동시에 돌므로 합이 total 보다 클 수 있고,
 * fetch 의 ms 합이 total 과 비슷하면 병목은 직렬 file:// 읽기다.
 *
 * @param {number} total 검사 전체(ms)
 * @param {number} profiles 찾은 프로필 수
 * @param {Record<string, number>} phases 단계별 소요(ms)
 * @param {string[]} [notes] 덧붙일 표식 ("self-cache" 등)
 */
function logScanTiming(total, profiles, phases, notes = []) {
  try {
    const s = snapshotFetchStats();
    const phaseText = Object.entries(phases)
      .map(([name, ms]) => `${name} ${Math.round(ms)}ms`)
      .join(', ');
    const extra = notes.length > 0 ? ` [${notes.join(', ')}]` : '';
    console.debug(
      `[cici] scan ${Math.round(total)}ms · ${profiles} profile(s) · ` +
        `${s.count} reads ${(s.bytes / 1024).toFixed(1)}KB ${Math.round(s.ms)}ms (${phaseText})${extra}`,
    );
  } catch {
    // 계측이 검사를 죽이면 안 된다.
  }
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
  resetFetchStats();
  const scanStart = nowMs();

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
    // 자기 프로필을 이미 아는 세션에서는 왕복 자체가 없으므로 쓰지도 않는다.
    let nonce = null;
    if (cachedSelfDir === null) {
      try {
        nonce = await writeNonce();
      } catch (err) {
        warnings.push(warningFromError(err));
      }
    }

    const enumStart = nowMs();
    const profiles = await withDeadline(listProfileDirs(platform, warnings), deadline, [], noteTimeout);
    const enumMs = nowMs() - enumStart;

    if (!Array.isArray(profiles) || profiles.length === 0) {
      logScanTiming(nowMs() - scanStart, 0, { enumerate: enumMs });
      // `noted` 를 함께 실어 보낸다. "정말 하나도 없다"와 "검사가 잘려서 못
      // 찾았다"는 사용자가 취할 행동이 완전히 다르다.
      return { rows: [], selfFound: false, warnings, truncated: noted };
    }

    // 자기 탐지 캐시. 지난 검사에서 nonce 왕복으로 확인한 자기 프로필이 신선한
    // 목록에 그대로 있으면 그 답을 재사용한다 — 같은 팝업이 다른 프로필에서 돌
    // 수는 없기 때문이다. 목록에 없으면(열거가 잘렸거나 캐시가 이상하면) 지금
    // 표식을 남기고 정직하게 다시 찾는다. 표식을 이렇게 늦게 쓰는 것은 이
    // 경로에서는 안전하다: 우리 저장소 디렉터리는 지난 실행이 이미 만들었고,
    // 캐시되는 것은 디렉터리 **목록**뿐이라 파일 내용은 늘 새로 읽는다.
    const cachedSelf =
      cachedSelfDir !== null && profiles.some((p) => p.profileDir === cachedSelfDir) ? cachedSelfDir : null;
    if (cachedSelfDir !== null && cachedSelf === null) {
      try {
        nonce = await writeNonce();
      } catch (err) {
        warnings.push(warningFromError(err));
      }
    }

    // 세 갈래는 동시에 돈다. 각자의 소요 시간은 "병렬 구간 시작"부터 잰다 —
    // 합이 total 을 넘으면 그만큼 겹쳐 돌았다는 뜻이다.
    const parallelStart = nowMs();
    let selfMs = 0;
    let bridgeMs = 0;
    let metaMs = 0;
    const [self, bridges, metas] = await Promise.all([
      (cachedSelf !== null
        ? Promise.resolve({ profileDir: cachedSelf, nonce: '' })
        : nonce === null
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
            )
      ).finally(() => {
        selfMs = nowMs() - parallelStart;
      }),
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
      ).finally(() => {
        bridgeMs = nowMs() - parallelStart;
      }),
      withDeadline(loadMetas(profiles, warnings), deadline, new Map(), noteTimeout).finally(() => {
        metaMs = nowMs() - parallelStart;
      }),
    ]);

    const selfDir = self && typeof self.profileDir === 'string' ? self.profileDir : null;
    // nonce 왕복까지 마친 확정 답만 캐시한다. 다음 검사(그리고 다음 팝업)가
    // 왕복을 건너뛰는 근거다.
    if (selfDir !== null) cachedSelfDir = selfDir;

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

    logScanTiming(
      nowMs() - scanStart,
      rows.length,
      { enumerate: enumMs, self: selfMs, bridge: bridgeMs, meta: metaMs },
      cachedSelf !== null ? ['self-cache'] : [],
    );

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
 * `lib/*.js` 가 던지는 에러에는 경고가 통째로(`err.warning = {code, params}`)
 * 붙어 있다. 그 밖의 에러(브라우저가 만든 "Failed to fetch" 같은 것)는 우리가
 * 번역할 수 없으므로 그대로 끼워 넣는다.
 *
 * @param {unknown} err
 * @returns {{code: string, params: string[]}}
 */
function warningFromError(err) {
  const warning = err && typeof err === 'object' ? err.warning : null;
  if (warning && typeof warning.code === 'string') {
    return { code: warning.code, params: Array.isArray(warning.params) ? warning.params : [] };
  }
  return { code: 'warnSelfDetect', params: [messageOf(err)] };
}

/**
 * `{code, params}` 를 사람이 읽는 한 줄로.
 *
 * 경고를 만드는 곳은 이 파일과 `lib/read.js`, `lib/locate.js` 셋뿐이고 전부
 * `{code, params}` 만 올려 보낸다(맨 위 모듈 주석). 그래서 여기서 갈리는 것은
 * 채워 넣을 값이 있느냐 없느냐뿐이다.
 *
 * @param {{code: string, params?: string[]}} warning
 * @returns {string}
 */
function formatWarning(warning) {
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
 * bridgeDeviceId 가 없을 때 그 프로필에 대해 할 수 있는 말.
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
 *
 * 카드(`stateNote`)와 목록 행(`rowNote`)이 같은 네 갈래를 쓰므로 판정은 여기
 * 한 곳에만 둔다. 문장이 아니라 `_locales` 키를 돌려준다 — 문장 조립은 t() 가
 * 한다.
 *
 * @param {import('./lib/read.js').BridgeInfo} bridge
 * @returns {{title: string, hint: string, warn: boolean}}
 */
function bridgeState(bridge) {
  if (bridge.unreadable && bridge.extensionId === null) {
    return { title: 'profileUnreadable', hint: 'profileUnreadableHint', warn: true };
  }
  if (bridge.readFailed || bridge.unreadable) {
    return { title: 'pairingUnknown', hint: 'pairingUnknownHint', warn: true };
  }
  if (bridge.extensionId) return { title: 'notPaired', hint: 'notPairedHint', warn: true };
  return { title: 'claudeNotInstalled', hint: 'claudeNotInstalledHint', warn: false };
}

/** 카드에 넣는 안내 블록. {@link bridgeState} 의 세 값을 모두 쓴다. */
function stateNote(bridge) {
  const state = bridgeState(bridge);
  return h(
    'div',
    { class: state.warn ? 'state state-warn' : 'state' },
    h('div', { class: 'state-title', text: t(state.title) }),
    h('div', { class: 'state-hint', text: t(state.hint) }),
  );
}

/** 목록 행에 쓸 짧은 상태 문구. 제목만 쓴다. */
function rowNote(bridge) {
  return t(bridgeState(bridge).title);
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

/** 지금 화면에 검사 결과가 그려져 있나(캐시든 실검사든). 로딩 화면 여부를 가른다. */
let resultShown = false;

/** 마지막으로 그린 데이터의 직렬화본. 같은 결과를 같은 언어로 다시 그리는 일을 막는다. */
let renderedJson = '';

/**
 * 마지막으로 그린 데이터 그 자체. 언어를 바꿀 때 이것만 다시 그리면 되므로
 * 디스크를 다시 읽지 않는다 — 예전에는 언어를 고를 때마다 검사를 통째로 다시
 * 돌려서, 프로필이 여럿인 컴퓨터에서는 메뉴를 고르고 몇 초를 기다려야 했다.
 */
let lastData = null;

/**
 * 검사가 끝났음을 스크린리더에 알린다. 문장은 render() 가 그리는 화면과 같은
 * 데이터에서 나온다 — 재검사 결과가 화면과 같아서 다시 그리지 않을 때도 "끝났다"
 * 는 말은 가야 하므로(announce() 의 주석), 이 부분만 render() 에서 떼어 두었다.
 *
 * @param {{rows: Row[], truncated?: boolean}} data
 */
function announceData(data) {
  if (data.rows.length === 0) {
    announce(data.truncated ? t('scanCutShortTitle') : t('noProfilesTitle'));
    return;
  }
  const self = data.rows.find((r) => r.isSelf) ?? null;
  const others = data.rows.length - (self ? 1 : 0);
  announce(
    self ? t('statusScanned', [self.label, String(others)]) : t('statusScannedNoSelf', [String(others)]),
  );
}

/**
 * @param {{rows: Row[], selfFound: boolean, warnings: Array<{code: string, params: string[]}>}} data
 */
function render(data) {
  lastData = data;
  // 접근 안내 화면이 숨겨 두었을 수 있다. 결과가 보이는 화면에는 언제나
  // "다시 검사"가 함께 있다.
  byId('btn-refresh').hidden = false;
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
    resultShown = true;
    announceData(data);
    return;
  }

  selfLabel.hidden = false;
  const self = data.rows.find((r) => r.isSelf) ?? null;
  selfSlot.append(self ? renderSelfCard(self) : renderSelfUnknown());

  // ID 가 있는 프로필을 먼저. **그 뒤는 건드리지 않는다** — `listProfileDirs`
  // 가 이미 BROWSERS 선언 순서(Chrome 먼저) → user-data-dir → 프로필 폴더 이름
  // 으로 정렬해서 준다. 여기서 이름순으로 다시 세우면 그 선언 순서가 거짓말이
  // 되고(가나다/알파벳순으로는 Arc·Brave·Chromium 이 Google Chrome 앞에 온다),
  // 같은 컴퓨터를 CLI 와 팝업이 서로 다른 순서로 보여 준다.
  // `Array#sort` 는 안정 정렬이라 두 무리 안의 순서는 그대로 남는다.
  const others = data.rows
    .filter((r) => r !== self)
    .sort((a, b) => Number(Boolean(b.bridge.deviceId)) - Number(Boolean(a.bridge.deviceId)));

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
  resultShown = true;
  announceData(data);
}

/**
 * @param {Array<{code: string, params: string[]}>} warnings
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
  // 결과 화면이 아니다. 다음 검사는 로딩부터 다시 시작하고, 화면 생략 비교도
  // 처음부터 한다.
  resultShown = false;
  renderedJson = '';
  announce(t('needFileAccessTitle'));
}

/** 푸터의 깃허브 링크를 manifest 의 homepage_url 로 채운다. 주소가 없으면 숨긴 채 둔다. */
function fillSourceLink() {
  const node = byId('gh-link');
  if (!node) return;
  const home = homepageUrl();
  if (home === '') return;
  node.href = home;
  node.hidden = false;
}

/** 푸터의 버전. 출처는 manifest 하나뿐이다 — 코드에 버전을 두 번 적지 않는다. */
function fillVersion() {
  const node = byId('version');
  if (!node) return;
  let version = '';
  try {
    version = globalThis.chrome?.runtime?.getManifest?.()?.version ?? '';
  } catch {
    version = '';
  }
  if (typeof version !== 'string' || version === '') return;
  node.textContent = `v${version}`;
  node.hidden = false;
}

/**
 * 이 확장을 알릴 곳. `manifest.json` 의 `homepage_url` 에서 가져온다.
 * 코드에 주소를 박아 두지 않으므로 저장소 위치가 바뀌어도 한 군데만 고치면 된다.
 *
 * @returns {string} 없으면 빈 문자열
 */
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
  resultShown = false;
  renderedJson = '';
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

    // 캐시가 이미 그려져 있으면 로딩 화면으로 갈아엎지 않는다. 재검사는 뒤에서
    // 돌고, 그동안은 "다시 검사" 버튼의 회전(aria-busy)이 진행 중임을 말한다.
    if (!resultShown) show('loading');
    const data = await collect();

    // API 를 못 써서 그냥 시도한 경우, 결과가 비었다면 십중팔구 토글이 꺼진 것이다.
    if (access === 'unknown' && data.rows.length === 0) {
      renderNeedAccess();
      return;
    }

    const json = JSON.stringify(data);
    if (json !== renderedJson) {
      render(data);
      renderedJson = json;
    } else {
      // 화면은 그대로 두지만, 재검사를 시킨 사용자에게 "끝났고 그대로다"라는
      // 말은 가야 한다(announce() 의 주석 — 침묵은 아무 일도 없던 것과 같다).
      announceData(data);
    }
    await writeScanCache(data);
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

  byId('lang-select').addEventListener('change', async (event) => {
    const value = String(event.target?.value ?? 'auto');
    await writeLangPref(value);
    await applyLangChoice(value);
    applyStaticI18n();
    // 동적 텍스트(카드·목록·경고)는 그릴 때 t() 를 부르므로 다시 그려야 바뀐다.
    // **다시 그리기만 한다.** 언어가 바뀌었다고 디스크가 바뀐 것은 아니므로
    // 검사를 다시 돌릴 이유가 없다(그렇게 했더니 메뉴를 고를 때마다 몇 초씩
    // 걸렸다). 아직 결과가 없을 때만 검사를 시작한다.
    if (lastData !== null) {
      render(lastData);
      renderedJson = JSON.stringify(lastData);
    } else if (!running) {
      renderedJson = '';
      await run();
    }
  });
}

async function boot() {
  // 언어 선택을 **첫 그리기 전에** 읽는다. 나중에 읽으면 저장된 언어로
  // 갈아입는 깜빡임이 매번 보인다.
  try {
    await applyLangChoice(await readLangPref());
  } catch {
    overrideCatalog = null;
  }
  try {
    applyStaticI18n();
    fillSourceLink();
    fillVersion();
    wire();
  } catch (err) {
    renderFatal(err);
    return;
  }

  // 지난 검사 결과가 세션 캐시에 있으면 그것부터 그린다. run() 은 그 위에서
  // 재검사를 돌리고, 결과가 달라졌을 때만 화면을 갈아 끼운다.
  const cache = await readScanCache();
  if (cache) {
    cachedSelfDir = cache.selfProfileDir;
    try {
      render(cache.data);
      renderedJson = JSON.stringify(cache.data);
    } catch {
      // 캐시가 화면을 못 그리면 없는 셈 친다. 곧바로 정식 검사가 따라온다.
      renderedJson = '';
    }
  }
  run();
}

boot();

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
 */

import { resetDirCache } from './lib/fileurl.js';
import { detectPlatform, listProfileDirs, readProfileMeta, locateSelf } from './lib/locate.js';
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
  try {
    const lang = globalThis.chrome?.i18n?.getUILanguage?.();
    if (lang) document.documentElement.lang = lang;
  } catch {
    // 그대로 ko 로 둔다
  }
}

let toastTimer = 0;

/** @param {string} text */
function toast(text) {
  const node = byId('toast');
  const live = byId('live');
  if (live) live.textContent = text;
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
 * @property {{extensionId: string|null, deviceId: string|null, displayName: string|null, warnings: string[]}} bridge
 * @property {boolean} isSelf
 */

/**
 * 프로필 열거 → 자기 탐지 + bridge 조회를 한 번에.
 * 개별 실패는 경고로 흡수하고, 전체가 죽지 않게 한다.
 */
async function collect() {
  /** @type {string[]} */
  const warnings = [];

  // 디렉터리 목록 캐시를 비운다. "다시 검사"는 그 사이에 바뀐 디스크를 봐야 한다.
  resetDirCache();

  const platform = await detectPlatform();
  const profiles = await listProfileDirs(platform);

  if (!Array.isArray(profiles) || profiles.length === 0) {
    return { rows: [], selfFound: false, warnings };
  }

  const [self, bridges, metas] = await Promise.all([
    Promise.resolve()
      .then(() => locateSelf(profiles))
      .catch((err) => {
        warnings.push(t('warnSelfDetect', [messageOf(err)]));
        return null;
      }),
    Promise.all(
      profiles.map((p) =>
        Promise.resolve()
          .then(() => readBridge(p.profileDir))
          .catch((err) => {
            warnings.push(`${p.profileDir}: ${messageOf(err)}`);
            return { extensionId: null, deviceId: null, displayName: null, warnings: [] };
          }),
      ),
    ),
    loadMetas(profiles, warnings),
  ]);

  const selfDir = self && typeof self.profileDir === 'string' ? self.profileDir : null;

  /** @type {Row[]} */
  const rows = profiles.map((p, i) => {
    const bridge = bridges[i] ?? { extensionId: null, deviceId: null, displayName: null, warnings: [] };
    for (const w of bridge.warnings ?? []) warnings.push(`${p.profileDirName}: ${w}`);
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

  return { rows, selfFound: rows.some((r) => r.isSelf), warnings };
}

/**
 * user-data-dir 별로 Local State 를 한 번씩만 읽는다.
 * @param {Array<{userDataDir: string}>} profiles
 * @param {string[]} warnings
 */
async function loadMetas(profiles, warnings) {
  const dirs = [...new Set(profiles.map((p) => p.userDataDir))];
  const results = await Promise.all(
    dirs.map((dir) =>
      Promise.resolve()
        .then(() => readProfileMeta(dir))
        .catch((err) => {
          warnings.push(`${dir}/Local State: ${messageOf(err)}`);
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
 * extensionId 가 있으면 "설치는 됐지만 페어링 전", 없으면 "확장 자체가 없음".
 */
function stateNote(bridge) {
  const paired = Boolean(bridge.extensionId);
  return h(
    'div',
    { class: paired ? 'state state-warn' : 'state' },
    h('div', { class: 'state-title', text: paired ? t('notPaired') : t('claudeNotInstalled') }),
    h('div', { class: 'state-hint', text: paired ? t('notPairedHint') : t('claudeNotInstalledHint') }),
  );
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
  const main = h(
    'div',
    { class: 'row-main' },
    h(
      'div',
      { class: 'row-title' },
      row.browserName ? h('span', { class: 'row-browser', text: row.browserName }) : null,
      row.browserName ? h('span', { class: 'row-sep', text: '·' }) : null,
      h('span', { class: 'row-name', title: row.label, text: row.label }),
    ),
    row.bridge.deviceId
      ? h('code', { class: 'row-uuid', text: row.bridge.deviceId })
      : h('span', {
          class: 'row-note',
          text: row.bridge.extensionId ? t('notPaired') : t('claudeNotInstalled'),
        }),
  );

  const item = h('li', { class: 'row' }, main);

  if (row.bridge.deviceId) {
    const button = h('button', {
      class: 'copy-btn',
      type: 'button',
      text: t('copy'),
      'aria-label': t('copyOfAria', [row.label]),
    });
    button.addEventListener('click', () => copyWithFeedback(row.bridge.deviceId, item));
    item.append(button);
  }

  return item;
}

/**
 * @param {{rows: Row[], selfFound: boolean, warnings: string[]}} data
 */
function render(data) {
  const selfSlot = byId('self-slot');
  const othersSlot = byId('others-slot');
  const othersLabel = byId('others-label');
  selfSlot.replaceChildren();
  othersSlot.replaceChildren();

  if (data.rows.length === 0) {
    selfSlot.append(
      h(
        'article',
        { class: 'card' },
        h('div', { class: 'state-title', text: t('noProfilesTitle') }),
        h('div', { class: 'state-hint', text: t('noProfilesHint') }),
      ),
    );
    othersLabel.hidden = true;
    renderWarnings(data.warnings);
    show('result');
    return;
  }

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

  othersLabel.hidden = false;
  if (others.length === 0) {
    othersSlot.append(h('li', { class: 'empty-line small', text: t('noOtherProfiles') }));
  } else {
    for (const row of others) othersSlot.append(renderRow(row));
  }

  renderWarnings(data.warnings);
  show('result');
}

/** @param {string[]} warnings */
function renderWarnings(warnings) {
  const box = byId('warn-box');
  const text = byId('warn-text');
  const list = (warnings ?? []).filter(Boolean);
  if (list.length === 0) {
    box.hidden = true;
    text.textContent = '';
    return;
  }
  text.textContent = list.join('\n');
  box.hidden = false;
}

/** 파일 URL 접근이 꺼져 있을 때. */
function renderNeedAccess() {
  const url = settingsUrl();
  byId('settings-url').textContent = url;
  byId('btn-refresh').hidden = true;
  show('access');
}

/** @param {unknown} err */
function renderFatal(err) {
  try {
    byId('error-text').textContent = err instanceof Error && err.stack ? err.stack : messageOf(err);
    byId('btn-refresh').hidden = false;
    show('error');
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
    running = false;
  }
}

function wire() {
  byId('btn-refresh').addEventListener('click', run);
  byId('btn-retry').addEventListener('click', run);

  byId('btn-copy-url').addEventListener('click', () => {
    copyWithFeedback(settingsUrl());
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
    wire();
  } catch (err) {
    renderFatal(err);
    return;
  }
  run();
}

boot();

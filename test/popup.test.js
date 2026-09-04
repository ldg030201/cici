/**
 * `extension/popup.js` 통합 테스트.
 *
 * 다른 테스트들은 라이브러리를 하나씩 본다. 하지만 조각들이 **서로 맞는지**는
 * popup.js 를 실제로 실행해 봐야만 알 수 있다. popup.js 는 세 곳에 동시에
 * 의존한다.
 *
 *   1. `lib/*.js` 의 export 이름과 반환 모양
 *   2. `popup.html` 의 요소 id (`byId('...')` 가 null 이면 그 자리에서 죽는다)
 *   3. `_locales` 각 언어 `messages.json` 의 메시지 키
 *
 * 셋 중 하나만 어긋나도 팝업은 빈 화면이 되는데, 파일을 따로따로 보는 검사로는
 * 절대 잡히지 않는다. 그래서 여기서는 `test/helpers/mini-dom.js` 로 popup.html 을
 * 진짜 트리로 만들고, `chrome` / `fetch` / `navigator` 를 갈아 끼운 뒤 popup.js 를
 * import 해서 **화면에 실제로 나온 글자**를 단언한다.
 *
 * 저장소에 진짜 값은 넣지 않는다. 프로필 이름·이메일·UUID 는 전부 가짜다.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NONCE_KEY } from '../extension/lib/locate.js';
import { CLAUDE_EXTENSION_IDS } from '../extension/lib/read.js';
import { resetDirCache } from '../extension/lib/fileurl.js';
import { FakeFs, fakeResponse, listingHtml, stub, walWith } from './helpers/fake-file-url.js';
import { buildManifest } from './helpers/leveldb-writer.js';
import { parseHtml } from './helpers/mini-dom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const EXT = path.join(REPO, 'extension');

/** 전부 가짜 값이다. */
const DEVICE_A = '11111111-2222-4333-8444-555555555555';
const DEVICE_B = '99999999-8888-4777-8666-555555555555';
const SELF_ID = 'abcdefghijklmnopabcdefghijklmnop';
const CLAUDE_ID = CLAUDE_EXTENSION_IDS[0];

/** 가짜 프로젝트 주소. 실제 저장소 주소는 manifest.json 에만 있다. */
const HOMEPAGE = 'https://example.invalid/cici';

const HOME = '/Users/you';
const CHROME_DIR = `${HOME}/Library/Application Support/Google/Chrome`;
const BRAVE_DIR = `${HOME}/Library/Application Support/BraveSoftware/Brave-Browser`;

/** 실제 팝업이 쓰는 카탈로그. 화면 글자를 여기와 대조한다. */
const ko = JSON.parse(await readFile(path.join(EXT, '_locales/ko/messages.json'), 'utf8'));

/** @param {string} key */
const msg = (key) => {
  assert.ok(ko[key], `_locales/ko 에 ${key} 가 없습니다`);
  return ko[key].message;
};

let mountCount = 0;

// ---------------------------------------------------------------------------
// 가짜 디스크
// ---------------------------------------------------------------------------

/**
 * 진짜 `chrome.storage.local` 디렉터리처럼 CURRENT + MANIFEST + WAL 을 갖춘
 * LevelDB 를 만든다.
 *
 * CURRENT 가 없으면 파서가 "모든 테이블과 로그를 훑겠다"는 경고를 남기는데,
 * 그건 정상적인 프로필에서는 나오지 않아야 할 경고다. 픽스처를 진짜에 맞춰
 * 두어야 "경고가 하나도 없어야 한다"는 단언에 뜻이 생긴다.
 *
 * @param {FakeFs} fs
 * @param {string} dir LevelDB 디렉터리
 * @param {Array<[string, string]>} pairs 키 -> 저장된 JSON 문자열
 * @param {number} [sequence]
 */
function addLevelDb(fs, dir, pairs, sequence = 1) {
  fs.addFile(`${dir}/000003.log`, walWith(pairs, sequence));
  fs.addFile(
    `${dir}/MANIFEST-000001`,
    buildManifest([
      {
        comparator: 'leveldb.BytewiseComparator',
        logNumber: 3,
        nextFileNumber: 4,
        lastSequence: sequence + pairs.length,
      },
    ]),
  );
  fs.addFile(`${dir}/CURRENT`, 'MANIFEST-000001\n');
}

/**
 * 프로필 하나를 만든다.
 *
 * @param {FakeFs} fs
 * @param {string} userDataDir
 * @param {string} dirName
 * @param {object} [opts]
 * @param {string|null} [opts.deviceId]    Claude 확장의 bridgeDeviceId
 * @param {string|null} [opts.displayName] bridgeDisplayName
 * @param {boolean} [opts.claudeInstalled] 확장 디렉터리 자체의 존재 여부
 * @param {boolean} [opts.selfStorage]     우리 확장의 저장소를 둘지
 * @returns {string} 프로필 디렉터리 절대 경로
 */
function addProfile(fs, userDataDir, dirName, opts = {}) {
  const { deviceId = null, displayName = null, claudeInstalled = deviceId !== null, selfStorage = false } = opts;
  const profileDir = `${userDataDir}/${dirName}`;
  // 프로필 판정은 이름이 아니라 이 파일로 이뤄진다.
  fs.addFile(`${profileDir}/Preferences`, '{}');

  if (claudeInstalled) {
    /** @type {Array<[string, string]>} */
    const pairs = [];
    if (deviceId !== null) pairs.push(['bridgeDeviceId', JSON.stringify(deviceId)]);
    if (displayName !== null) pairs.push(['bridgeDisplayName', JSON.stringify(displayName)]);
    // 페어링 전이라면 다른 키만 들어 있다. 디렉터리와 LevelDB 파일은 존재한다.
    if (pairs.length === 0) pairs.push(['someOtherKey', JSON.stringify('x')]);
    addLevelDb(fs, `${profileDir}/Local Extension Settings/${CLAUDE_ID}`, pairs);
  }

  if (selfStorage) {
    // 우리 확장의 WAL. 아직 nonce 는 없다 — `chrome.storage.local.set` 이 쓴다.
    addLevelDb(fs, `${profileDir}/Local Extension Settings/${SELF_ID}`, [['boot', '"1"']]);
  }
  return profileDir;
}

/**
 * `<userDataDir>/Local State`.
 *
 * @param {FakeFs} fs
 * @param {string} userDataDir
 * @param {Record<string, {name?: string, user_name?: string, gaia_name?: string}>} infoCache
 */
function addLocalState(fs, userDataDir, infoCache) {
  fs.addFile(`${userDataDir}/Local State`, JSON.stringify({ profile: { info_cache: infoCache } }));
}

/** 프로필 두 개짜리 표준 배치. 자기 자신은 Chrome 의 "Profile 1". */
function standardFs() {
  const fs = new FakeFs();
  // 사람 계정이 아닌 홈은 걸러져야 한다.
  fs.addDir('/Users/Shared');
  fs.addDir('/Users/Guest');

  addProfile(fs, CHROME_DIR, 'Default', { deviceId: DEVICE_A, displayName: '내 노트북' });
  addProfile(fs, CHROME_DIR, 'Profile 1', { deviceId: DEVICE_B, selfStorage: true });
  addLocalState(fs, CHROME_DIR, {
    Default: { name: 'Personal', user_name: 'you@example.com' },
    'Profile 1': { name: 'Work', user_name: 'work@example.com' },
  });
  return { fs, selfProfileDir: `${CHROME_DIR}/Profile 1` };
}

// ---------------------------------------------------------------------------
// 팝업 마운트
// ---------------------------------------------------------------------------

/**
 * popup.html 을 트리로 만들고 전역을 갈아 끼운 뒤 popup.js 를 실행한다.
 *
 * popup.js 는 최상위에서 `boot()` 를 부르므로 import 하는 순간 돌기 시작한다.
 * 그래서 전역은 **import 전에** 준비돼 있어야 하고, 끝났는지는 화면을 보고
 * 판단한다.
 *
 * @param {object} opts
 * @param {FakeFs} [opts.fs]
 * @param {string|null} [opts.selfProfileDir] nonce 를 흘려 넣을 프로필. null 이면 자기 탐지 실패.
 * @param {boolean} [opts.selfStorageExists] false 면 우리 저장소 디렉터리가 아직 **없고**,
 *   `chrome.storage.local.set` 이 그 순간 만든다(확장을 갓 설치한 프로필의 실제 모습).
 * @param {boolean|'missing'} [opts.fileAccess] `isAllowedFileSchemeAccess` 의 답. 'missing' 은 API 부재.
 * @param {boolean} [opts.storagePermission] false 면 `chrome.storage` 가 아예 없다.
 * @param {'mac'|'win'|'linux'} [opts.platform]
 * @param {Record<string, {message: string}>} [opts.catalog] 쓸 메시지 카탈로그
 * @param {string[]} [opts.denyDirs] 이 디렉터리 리스팅만 TypeError 로 만든다.
 *   권한 없는 폴더(EACCES)의 모습이고, "경로가 없음"과 구별할 수 없는 바로 그 에러다.
 * @param {boolean} [opts.cancelDuringScan] 프로필 열거가 **끝나기 전에** 마감시한을
 *   연다. 사용자가 "중단"을 누른 경우와 전체 예산(SCAN_BUDGET_MS)을 넘긴 경우가
 *   똑같이 밟는 경로다. 홈 루트 리스팅을 영영 멈춰 두고, popup.js 가 건 타이머를
 *   실제로 터뜨려서 재현한다.
 * @param {string} [opts.breakDom] 이 id 의 요소를 지워서 렌더링을 죽인다(오류 화면 확인용).
 */
async function mountPopup(opts = {}) {
  const {
    fs = new FakeFs(),
    selfProfileDir = null,
    selfStorageExists = true,
    fileAccess = true,
    storagePermission = true,
    platform = 'mac',
    catalog = ko,
    denyDirs = [],
    cancelDuringScan = false,
    breakDom = null,
  } = opts;

  const html = await readFile(path.join(EXT, 'popup.html'), 'utf8');
  const doc = parseHtml(html);
  // mini-dom 의 getElementById 는 미리 만든 표를 본다. 표에서 지워야 popup.js 의
  // byId() 가 null 을 받고, 그 자리에서 죽는 경로(=오류 화면)를 밟는다.
  if (breakDom) doc.ids.delete(breakDom);

  /** popup.js 가 건 타이머. 자동으로 터지지 않게 잡아 둔다. */
  const timers = [];
  const realSetTimeout = setTimeout;

  /** @type {string[]} 열린 file:// 경로 */
  const fetched = [];
  /** @type {string[]} chrome.tabs.create 로 연 주소 */
  const openedTabs = [];
  /** @type {string[]} 클립보드에 들어간 것 */
  const clipboard = [];
  let clipboardWorks = true;

  const store = new Map();
  const chromeStub = {
    runtime: {
      id: SELF_ID,
      // 오류 화면은 "알릴 곳"을 코드에 박지 않고 매니페스트에서 읽는다.
      getManifest: () => ({ homepage_url: HOMEPAGE }),
    },
    i18n: {
      getMessage(key, subs) {
        const entry = catalog[key];
        if (!entry) return '';
        let out = entry.message;
        const names = Object.keys(entry.placeholders ?? {});
        // 크롬은 $NAME$ 을 placeholders 의 content($1, $2 ...)를 거쳐 치환한다.
        names.forEach((name) => {
          const content = entry.placeholders[name].content ?? '';
          const index = Number(/^\$(\d+)$/.exec(content)?.[1] ?? 0) - 1;
          const value = Array.isArray(subs) ? (subs[index] ?? '') : (subs ?? '');
          out = out.replaceAll(`$${name.toUpperCase()}$`, String(value));
        });
        return out;
      },
      // 일부러 카탈로그와 다른 값을 준다. `<html lang>` 이 이걸 그대로 쓰면 안 된다.
      getUILanguage: () => 'fr',
    },
    tabs: {
      create({ url }) {
        openedTabs.push(url);
      },
    },
    extension:
      fileAccess === 'missing'
        ? {}
        : {
            async isAllowedFileSchemeAccess() {
              return fileAccess;
            },
          },
  };
  if (storagePermission) {
    chromeStub.storage = {
      local: {
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
          // 진짜 크롬처럼, 값은 즉시 그 프로필의 WAL 에 나타난다. 파일 경로는
          // 이미 있는 것을 덮어쓴다 — 새 파일을 만들면 디렉터리 목록 캐시와
          // 어긋나고, 실제로도 WAL 은 이미 존재한다.
          if (selfProfileDir === null) return;
          const nonce = obj[NONCE_KEY];
          if (typeof nonce !== 'string') return;
          const dir = `${selfProfileDir}/Local Extension Settings/${SELF_ID}`;
          if (selfStorageExists) {
            fs.addFile(
              `${dir}/000003.log`,
              walWith(
                [
                  ['boot', '"1"'],
                  [NONCE_KEY, JSON.stringify(nonce)],
                ],
                2,
              ),
            );
            return;
          }
          // 확장을 갓 설치한 프로필: 이 write 가 디렉터리 자체를 만든다.
          // 그래서 디렉터리 목록을 이 write 보다 **먼저** 읽어 캐시에 굳히면
          // 자기 프로필을 영영 못 찾는다.
          addLevelDb(fs, dir, [[NONCE_KEY, JSON.stringify(nonce)]], 2);
        },
      },
    };
  }

  /**
   * 팝업이 보는 전역 전부. 최초 실행과 버튼 클릭(=재실행) 양쪽에서 똑같이
   * 씌워야 한다 — "다시 검사" 도 결국 file:// 을 다시 읽기 때문이다.
   *
   * @returns {Array<() => void>}
   */
  const applyStubs = () => [
    stub(globalThis, 'document', doc),
    stub(globalThis, 'window', { open: (url) => openedTabs.push(url) }),
    stub(globalThis, 'navigator', {
      platform: { mac: 'MacIntel', win: 'Win32', linux: 'Linux x86_64' }[platform],
      clipboard: {
        async writeText(text) {
          if (!clipboardWorks) throw new Error('클립보드 거부');
          clipboard.push(text);
        },
      },
    }),
    stub(globalThis, 'chrome', chromeStub),
    // 타이머는 잡아만 둔다. 실제로 터지면 테스트가 끝난 뒤에 죽은 document 를
    // 만지게 된다.
    stub(globalThis, 'setTimeout', (fn) => timers.push(fn)),
    stub(globalThis, 'clearTimeout', () => {}),
    stub(globalThis, 'fetch', async (url) => {
      const u = new URL(String(url));
      if (u.protocol !== 'file:') throw new TypeError('Failed to fetch');
      let p = decodeURIComponent(u.pathname);
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
      fetched.push(p);
      if (denyDirs.includes(p)) throw new TypeError('Failed to fetch');
      // 영영 오지 않는 응답. 진짜 Chromium 에서도 열거할 수 없는 디렉터리는
      // reject 하지 않고 그냥 멈춰 있다(docs/why.md §2.3).
      if (cancelDuringScan && p === '/Users/') return new Promise(() => {});
      const isDirRequest = p.endsWith('/');
      const dir = isDirRequest ? p.replace(/\/+$/, '') : p;
      const kids = fs.children(dir);
      if (kids) return fakeResponse(0, new TextEncoder().encode(listingHtml(dir, kids, fs)));
      if (isDirRequest) throw new TypeError('Failed to fetch');
      const bytes = fs.files.get(p);
      if (!bytes) throw new TypeError('Failed to fetch');
      return fakeResponse(200, bytes);
    }),
  ];

  /** 팝업이 로딩을 벗어났는가. */
  const settled = () =>
    ['access', 'result', 'error'].some((n) => doc.getElementById(`panel-${n}`)?.hidden === false);

  /** popup.js 의 async 실행이 끝날 때까지 진짜 타이머로 기다린다. */
  const waitSettled = async () => {
    for (let i = 0; i < 500 && !settled(); i++) {
      // 마감시한도 popup.js 가 setTimeout 으로 걸어 둔 것이다. 실제로 터뜨려야
      // "검사가 잘렸다" 경로를 밟는다.
      if (cancelDuringScan) for (const fn of timers.splice(0)) fn();
      await new Promise((resolve) => realSetTimeout(resolve, 0));
    }
    assert.ok(settled(), '팝업이 어떤 화면에도 도달하지 못했습니다 (로딩에서 멈춤)');
  };

  // 검사 사이의 격리는 **여기서만** 한다. 끝나고 비우면 안 된다 — "다시 검사"가
  // 캐시를 스스로 비우는지 확인하려면, 클릭 시점에 앞 실행의 캐시가 그대로
  // 남아 있어야 한다.
  resetDirCache();
  const restores = applyStubs();
  try {
    // 캐시 무력화 쿼리로 매번 새로 실행한다. 상대 임포트는 쿼리 없이 풀리므로
    // lib/*.js 는 한 번만 평가된다(전부 무상태다).
    await import(`../extension/popup.js?mount=${++mountCount}`);
    await waitSettled();
  } finally {
    for (const restore of restores) restore();
  }

  return {
    doc,
    fetched,
    openedTabs,
    clipboard,
    store,
    timers,
    /** 지금 보이는 패널 이름 */
    panel: () => ['loading', 'access', 'result', 'error'].find((n) => doc.getElementById(`panel-${n}`)?.hidden === false),
    /** @param {string} selector */
    texts: (selector) => doc.querySelectorAll(selector).map((n) => n.textContent),
    /** @param {string} selector */
    text: (selector) => doc.querySelector(selector)?.textContent ?? null,
    /** 클립보드가 실패하도록 만든다. */
    breakClipboard() {
      clipboardWorks = false;
    },
    /** 화면 전체의 글자. */
    all: () => doc.body.textContent,
    /**
     * 버튼을 누른다. popup.js 의 리스너가 async 여도, 그리고 그 안에서 다시
     * 디스크를 읽어도 끝까지 기다린다.
     *
     * @param {string} selector
     * @param {{ rerun?: boolean }} [opts] rerun 이면 화면이 다시 정해질 때까지 기다린다
     */
    async click(selector, opts = {}) {
      const node = doc.querySelector(selector);
      assert.ok(node, `${selector} 를 찾지 못했습니다`);
      // 캐시를 일부러 비우지 않는다. 비우는 것은 popup.js 의 collect() 책임이고,
      // 그게 이 클릭으로 검사하려는 것이다.
      const previous = applyStubs();
      try {
        await node.dispatch('click');
        if (opts.rerun) await waitSettled();
      } finally {
        for (const restore of previous) restore();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 1. 정상 경로
// ---------------------------------------------------------------------------

test('팝업은 현재 프로필의 bridgeDeviceId 를 카드로 보여 준다', async () => {
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir });

  assert.equal(app.panel(), 'result', `결과 화면이어야 합니다 (지금: ${app.panel()})`);

  const card = app.doc.querySelector('.card-self');
  assert.ok(card, '현재 프로필 카드가 없습니다');

  // 1순위 목표: 이 프로필의 UUID 가 그대로 보인다.
  assert.equal(app.text('.card-self .uuid-text'), DEVICE_B);
  // 신원은 디렉터리 이름이 아니라 Local State 에서 온다.
  assert.equal(app.text('.card-self .pname'), 'Work');
  assert.match(app.text('.card-self .psub'), /work@example\.com/);
  assert.equal(app.text('.card-self .badge'), msg('badgeCurrent'));
  assert.equal(app.text('.card-self .browser'), 'Google Chrome');

  // 다른 프로필은 아래 목록에.
  const rows = app.doc.querySelectorAll('#others-slot .row');
  assert.equal(rows.length, 1, '다른 프로필이 한 줄이어야 합니다');
  assert.equal(app.text('#others-slot .row-uuid'), DEVICE_A);
  assert.equal(app.text('#others-slot .row-name'), 'Personal');

  // 두 프로필의 UUID 가 섞이지 않았다.
  assert.notEqual(DEVICE_A, DEVICE_B);
  assert.equal(app.doc.querySelectorAll('.card-self').length, 1);

  // 경고가 없으면 경고 상자는 닫혀 있다.
  assert.equal(app.doc.getElementById('warn-box').hidden, true, `경고: ${app.text('#warn-text')}`);
});

test('페어링 이름이 있으면 함께 보여 준다', async () => {
  const fs = new FakeFs();
  addProfile(fs, CHROME_DIR, 'Default', { deviceId: DEVICE_A, displayName: '내 노트북', selfStorage: true });
  addLocalState(fs, CHROME_DIR, { Default: { name: 'Personal', user_name: 'you@example.com' } });

  const app = await mountPopup({ fs, selfProfileDir: `${CHROME_DIR}/Default` });
  assert.equal(app.text('.card-self .uuid-text'), DEVICE_A);
  assert.equal(app.text('.card-self .kv .v'), '내 노트북');
  assert.equal(app.text('.card-self .kv .k'), msg('pairingNameLabel'));
});

test('여러 브라우저 계열의 프로필을 한 화면에 모은다', async () => {
  const fs = new FakeFs();
  addProfile(fs, CHROME_DIR, 'Default', { deviceId: DEVICE_A, selfStorage: true });
  addProfile(fs, BRAVE_DIR, 'Default', { deviceId: DEVICE_B });
  addLocalState(fs, CHROME_DIR, { Default: { name: 'Personal' } });
  addLocalState(fs, BRAVE_DIR, { Default: { name: 'Brave 프로필' } });

  const app = await mountPopup({ fs, selfProfileDir: `${CHROME_DIR}/Default` });
  assert.equal(app.text('.card-self .browser'), 'Google Chrome');
  assert.equal(app.text('#others-slot .row-browser'), 'Brave');
  assert.equal(app.text('#others-slot .row-uuid'), DEVICE_B);
});

// ---------------------------------------------------------------------------
// 2. 복사
// ---------------------------------------------------------------------------

test('복사 버튼은 UUID 를 클립보드에 넣고 "복사됨"이라고 알린다', async () => {
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir });

  await app.click('.card-self .copy-btn');
  assert.deepEqual(app.clipboard, [DEVICE_B]);
  assert.equal(app.text('#toast'), msg('copied'));
  // 스크린리더에도 같은 말이 간다.
  assert.equal(app.text('#live'), msg('copied'));
});

test('UUID 상자를 눌러도 복사된다', async () => {
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir });
  await app.click('.card-self .uuid');
  assert.deepEqual(app.clipboard, [DEVICE_B]);
});

test('다른 프로필 줄의 복사 버튼은 그 줄의 UUID 를 복사한다', async () => {
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir });
  await app.click('#others-slot .copy-btn');
  assert.deepEqual(app.clipboard, [DEVICE_A]);
});

test('복사 버튼에는 키보드 사용자를 위한 aria-label 이 있다', async () => {
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir });

  assert.equal(app.doc.querySelector('.card-self .copy-btn').getAttribute('aria-label'), msg('copyDeviceIdAria'));
  const rowLabel = app.doc.querySelector('#others-slot .copy-btn').getAttribute('aria-label');
  assert.ok(rowLabel && rowLabel.includes('Personal'), `프로필 이름이 들어가야 합니다: ${rowLabel}`);
  // 치환이 실제로 일어났는지 — $PROFILE$ 이 남아 있으면 안 된다.
  assert.doesNotMatch(rowLabel, /\$[A-Z]+\$/);
});

test('클립보드가 막히면 execCommand 로 물러선다', async () => {
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir });
  app.breakClipboard();

  await app.click('.card-self .copy-btn');
  assert.deepEqual(app.doc.execCommandCalls, ['copy'], 'execCommand 대체 경로를 타야 합니다');
  assert.equal(app.text('#toast'), msg('copied'));
  // 임시 textarea 를 남기지 않는다.
  assert.equal(app.doc.querySelectorAll('textarea').length, 0);
});

// ---------------------------------------------------------------------------
// 3. 파일 URL 접근 토글
// ---------------------------------------------------------------------------

test('파일 접근이 꺼져 있으면 안내 화면을 띄우고 디스크를 아예 건드리지 않는다', async () => {
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir, fileAccess: false });

  assert.equal(app.panel(), 'access');
  // 이게 핵심이다. 토글이 꺼졌을 때의 fetch 실패는 "없는 디렉터리"와 구별할 수
  // 없으므로, 먼저 물어보고 아예 시도하지 않아야 한다.
  assert.deepEqual(app.fetched, [], `토글이 꺼졌는데 file:// 을 열었습니다: ${app.fetched[0]}`);

  assert.equal(app.text('#settings-url'), `chrome://extensions/?id=${SELF_ID}`);
  const body = app.all();
  assert.ok(body.includes(msg('needFileAccessTitle')));
  // "팝업을 다시 열어라"가 반드시 안내에 있어야 한다 — 토글을 켜면 확장이
  // 리로드돼서 열려 있던 팝업이 죽기 때문이다.
  assert.ok(body.includes(msg('howToStep3')));
  assert.ok(body.includes(msg('needFileAccessNote')));
});

test('안내 화면의 버튼은 확장 세부정보 페이지를 열고, 주소도 복사해 준다', async () => {
  const app = await mountPopup({ fileAccess: false });

  await app.click('#btn-open-settings');
  assert.deepEqual(app.openedTabs, [`chrome://extensions/?id=${SELF_ID}`]);

  await app.click('#btn-copy-url');
  assert.deepEqual(app.clipboard, [`chrome://extensions/?id=${SELF_ID}`]);
});

test('접근 API 를 못 쓰는데 아무것도 못 찾으면 안내 화면으로 간다', async () => {
  // 토글 OFF 와 "프로필 없음"은 fetch 만으로는 구별되지 않는다. 이때는 사용자가
  // 고칠 수 있는 쪽(토글)을 안내하는 편이 낫다.
  const app = await mountPopup({ fs: new FakeFs(), fileAccess: 'missing' });
  assert.equal(app.panel(), 'access');
});

test('접근 API 를 못 써도 프로필이 보이면 결과를 그린다', async () => {
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir, fileAccess: 'missing' });
  assert.equal(app.panel(), 'result');
  assert.equal(app.text('.card-self .uuid-text'), DEVICE_B);
});

// ---------------------------------------------------------------------------
// 4. 빈 상태 / 실패
// ---------------------------------------------------------------------------

test('프로필을 하나도 못 찾으면 그렇게 말하고, 거짓 제목을 남기지 않는다', async () => {
  const app = await mountPopup({ fs: new FakeFs(), fileAccess: true });

  assert.equal(app.panel(), 'result');
  assert.ok(app.all().includes(msg('noProfilesTitle')));
  // 프로필이 없는데 "현재 프로필" 이라는 제목만 남으면 거짓말이 된다.
  assert.equal(app.doc.getElementById('self-label').hidden, true);
  assert.equal(app.doc.getElementById('others-label').hidden, true);
  assert.equal(app.doc.querySelectorAll('.card-self').length, 0);
});

test('자기 프로필을 못 찾아도 다른 프로필은 그대로 보여 준다', async () => {
  const { fs } = standardFs();
  // nonce 를 어느 프로필에도 흘리지 않는다 = 표준 위치가 아닌 user-data-dir 로
  // 뜬 브라우저에서 실제로 일어나는 일이다.
  const app = await mountPopup({ fs, selfProfileDir: null });

  assert.equal(app.panel(), 'result');
  assert.ok(app.all().includes(msg('selfNotFoundTitle')));
  assert.equal(app.doc.querySelectorAll('.card-self').length, 0);
  // 두 프로필 모두 아래 목록으로 내려간다.
  assert.equal(app.doc.querySelectorAll('#others-slot .row').length, 2);
  assert.deepEqual(app.texts('#others-slot .row-uuid').sort(), [DEVICE_A, DEVICE_B].sort());
});

test('갓 설치한 프로필 — 저장소가 nonce 로 처음 생겨도 첫 실행에 자기를 찾는다', async () => {
  // 웹스토어에서 막 설치한 사용자의 실제 모습이다. `Local Extension Settings/<우리 id>`
  // 는 아직 없고, 우리가 nonce 를 쓰는 그 순간 크롬이 만든다. 그러므로 표식은
  // 디렉터리 목록을 훑기 **전에** 남겨야 한다. 나중에 남기면 "없음"이 목록
  // 캐시에 굳어서 첫 팝업이 자기를 놓치고, 두 번째 열 때부터 찾아진다.
  // (Chrome 148 + 새 프로필로 실제 재현했다.)
  const fs = new FakeFs();
  addProfile(fs, CHROME_DIR, 'Default', { deviceId: DEVICE_A });
  // 자기 프로필에는 아직 아무 확장 저장소도 없다 = `Local Extension Settings`
  // 디렉터리 자체가 없다. 프로필 판정은 Preferences 로 이뤄진다.
  addProfile(fs, CHROME_DIR, 'Profile 1', { claudeInstalled: false });
  addLocalState(fs, CHROME_DIR, {
    Default: { name: 'Personal' },
    'Profile 1': { name: 'Work' },
  });

  const app = await mountPopup({
    fs,
    selfProfileDir: `${CHROME_DIR}/Profile 1`,
    selfStorageExists: false,
  });

  assert.equal(app.panel(), 'result');
  assert.equal(app.doc.querySelectorAll('.card-self').length, 1, '첫 실행에서 현재 프로필 카드가 나와야 합니다');
  assert.equal(app.text('.card-self .pname'), 'Work');
  // 자기 프로필에는 Claude 확장이 없으니 그 안내가 나온다.
  assert.equal(app.text('.card-self .state-title'), msg('claudeNotInstalled'));
  // 다른 프로필의 ID 는 그대로 보인다.
  assert.deepEqual(app.texts('#others-slot .row-uuid'), [DEVICE_A]);
  assert.equal(app.doc.getElementById('warn-box').hidden, true);
});

test('Claude 확장이 없는 프로필과 아직 페어링 안 된 프로필을 구분한다', async () => {
  const fs = new FakeFs();
  addProfile(fs, CHROME_DIR, 'Default', { claudeInstalled: false, selfStorage: true });
  addProfile(fs, CHROME_DIR, 'Profile 1', { claudeInstalled: true, deviceId: null });
  addLocalState(fs, CHROME_DIR, {
    Default: { name: 'Personal' },
    'Profile 1': { name: 'Work' },
  });

  const app = await mountPopup({ fs, selfProfileDir: `${CHROME_DIR}/Default` });

  // 자기 프로필: 확장 자체가 없다.
  assert.equal(app.text('.card-self .state-title'), msg('claudeNotInstalled'));
  assert.equal(app.text('.card-self .state-hint'), msg('claudeNotInstalledHint'));
  // 다른 프로필: 설치는 됐는데 페어링 전.
  assert.equal(app.text('#others-slot .row-note'), msg('notPaired'));
  assert.equal(app.doc.querySelectorAll('#others-slot .row-uuid').length, 0);
});

test('프로필이 자기 하나뿐이면 "다른 프로필 없음"이라고 한다', async () => {
  const fs = new FakeFs();
  addProfile(fs, CHROME_DIR, 'Default', { deviceId: DEVICE_A, selfStorage: true });
  const app = await mountPopup({ fs, selfProfileDir: `${CHROME_DIR}/Default` });

  assert.equal(app.doc.querySelectorAll('#others-slot .row').length, 0);
  assert.equal(app.text('#others-slot .empty-line'), msg('noOtherProfiles'));
});

test('이름이 같은 두 프로필도 목록에서 구별된다', async () => {
  // 로그인한 프로필의 이름을 바꾸지 않으면 크롬이 gaia_name 을 그대로 쓴다.
  // 그래서 "Work"가 둘인 상황은 드물지 않다. 보조 줄(이메일 · 폴더 이름)이
  // 없으면 두 행은 UUID 만 빼고 글자 하나까지 같아지고, 어느 UUID 가 어느
  // 프로필인지 알려 주는 이 확장의 존재 이유가 그 화면에서 무너진다.
  const fs = new FakeFs();
  addProfile(fs, CHROME_DIR, 'Default', { deviceId: DEVICE_A });
  addProfile(fs, CHROME_DIR, 'Profile 1', { deviceId: DEVICE_B });
  addLocalState(fs, CHROME_DIR, {
    Default: { name: 'Work', user_name: 'a@example.com' },
    'Profile 1': { name: 'Work', user_name: 'b@example.com' },
  });

  const app = await mountPopup({ fs, selfProfileDir: null });

  const rows = app.doc.querySelectorAll('#others-slot .row');
  assert.equal(rows.length, 2);
  const subs = app.texts('#others-slot .row-sub');
  assert.equal(subs.length, 2, '행마다 보조 줄이 있어야 합니다');
  assert.ok(subs.some((x) => x.includes('a@example.com')), `이메일이 없습니다: ${subs.join(' | ')}`);
  assert.ok(subs.some((x) => x.includes('b@example.com')), `이메일이 없습니다: ${subs.join(' | ')}`);
  assert.notEqual(rows[0].textContent, rows[1].textContent, '두 행이 글자까지 같으면 구별할 수 없습니다');
  // 스크린리더도 구별할 수 있어야 한다.
  const labels = app.doc.querySelectorAll('#others-slot .copy-btn').map((b) => b.getAttribute('aria-label'));
  assert.notEqual(labels[0], labels[1], '복사 버튼 이름이 같으면 스크린리더로는 구별이 안 됩니다');
});

test('자기 프로필을 못 찾으면 목록 제목이 "다른 프로필" 이라고 우기지 않는다', async () => {
  // 바로 위 안내가 "아래 목록에서 직접 찾아 주세요"라고 말하는데, 그 목록의
  // 제목이 "이 컴퓨터의 다른 프로필"이면 한 화면 안에서 두 문구가 서로를
  // 부정한다. 현재 프로필이 분명히 그 안에 들어 있기 때문이다.
  const { fs } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir: null });

  const label = app.doc.getElementById('others-label');
  assert.equal(label.hidden, false);
  assert.equal(label.textContent, msg('foundProfiles'));
  assert.notEqual(label.textContent, msg('otherProfiles'));
  assert.equal(app.doc.querySelectorAll('#others-slot .row').length, 2);

  // 자기 프로필을 찾은 정상 경로에서는 원래 제목 그대로다.
  const ok = await mountPopup(standardFs());
  assert.equal(ok.doc.getElementById('others-label').textContent, msg('otherProfiles'));
});

test('프로필 폴더를 못 읽으면 "확장이 없습니다" 라고 단정하지 않는다', async () => {
  // listDirOrNull 은 모든 실패를 null 로 뭉갠다. 그걸 "없음"으로 읽으면 못 읽은
  // 프로필이 경고 한 줄 없이 "Claude 확장이 없는 프로필"로 둔갑한다.
  const fs = new FakeFs();
  addProfile(fs, CHROME_DIR, 'Default', { deviceId: DEVICE_A, selfStorage: true });
  addProfile(fs, CHROME_DIR, 'Profile 1', { deviceId: DEVICE_B });
  addLocalState(fs, CHROME_DIR, { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } });

  const app = await mountPopup({
    fs,
    selfProfileDir: `${CHROME_DIR}/Default`,
    // "Profile 1" 목록만 EACCES 처럼 만든다 — 토글 OFF 와 구별 불가능한 에러다.
    denyDirs: [`${CHROME_DIR}/Profile 1/Local Extension Settings/`],
  });

  assert.equal(app.panel(), 'result');
  assert.equal(app.text('#others-slot .row-note'), msg('profileUnreadable'));
  assert.equal(app.doc.getElementById('warn-box').hidden, false, '왜 못 읽었는지 남겨야 합니다');
  assert.match(app.text('#warn-text'), /Profile 1/);
});

test('Claude 저장소를 못 읽으면 "아직 페어링되지 않았습니다" 라고 단정하지 않는다', async () => {
  // 확장 폴더는 목록에 보여서 extensionId 가 채워진 뒤 그 안쪽을 못 읽는 경우다.
  // 이미 페어링된 브라우저에게 "페어링하세요"라고 말하면, 어느 UUID 가 어느
  // 프로필인지 알려 준다는 이 확장의 존재 이유가 그 화면에서 무너진다.
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({
    fs,
    selfProfileDir,
    denyDirs: [`${selfProfileDir}/Local Extension Settings/${CLAUDE_ID}/`],
  });

  assert.equal(app.panel(), 'result');
  assert.equal(app.text('.card-self .state-title'), msg('pairingUnknown'));
  assert.notEqual(app.text('.card-self .state-title'), msg('notPaired'));
  assert.equal(app.doc.getElementById('warn-box').hidden, false, '왜 못 읽었는지 남겨야 합니다');
});

test('다른 프로필의 Claude 저장소를 못 읽어도 마찬가지다', async () => {
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({
    fs,
    selfProfileDir,
    denyDirs: [`${CHROME_DIR}/Default/Local Extension Settings/${CLAUDE_ID}/`],
  });

  assert.equal(app.text('#others-slot .row-note'), msg('pairingUnknown'));
});

test('저장소 안의 파일 하나만 못 읽어도 페어링 여부를 단정하지 않는다', async () => {
  // 크롬이 우리가 목록을 뜬 뒤 컴팩션으로 WAL 을 갈아 치우면 실제로 이렇게 된다.
  // readLevelDbFrom 은 이 실패에 예외를 던지지 않고 경고로 삼키므로, try/catch
  // 만으로는 절대 잡히지 않는 경로다.
  const { fs, selfProfileDir } = standardFs();
  const storage = `${selfProfileDir}/Local Extension Settings/${CLAUDE_ID}`;
  const wal = [...fs.files.keys()].find((f) => f.startsWith(`${storage}/`) && f.endsWith('.log'));
  assert.ok(wal, '가짜 배치에 WAL 이 없습니다');

  const app = await mountPopup({ fs, selfProfileDir, denyDirs: [wal] });
  assert.equal(app.text('.card-self .state-title'), msg('pairingUnknown'));
});

test('프로필을 못 세고 끝났으면 "하나도 없다" 고 하지 않는다', async () => {
  // 중단 버튼을 누르거나 예산을 넘겨 열거가 잘리면 rows 가 0 이 된다. 그때
  // "하나도 찾지 못했습니다 / 브라우저 설치 위치를 확인하세요" 는 거짓이다 —
  // 우리는 세다가 만 것이지 다 세고 0 을 얻은 게 아니고, 할 일도 다르다.
  const { fs } = standardFs();
  const app = await mountPopup({ fs, cancelDuringScan: true });

  assert.equal(app.panel(), 'result');
  assert.equal(app.text('.card .state-title'), msg('scanCutShortTitle'));
  assert.notEqual(app.text('.card .state-title'), msg('noProfilesTitle'));
  const box = app.doc.getElementById('warn-box');
  assert.equal(box.hidden, false);
  assert.equal(box.open, true, '결과가 한 줄도 없는 화면에서 유일한 단서를 접어 두면 안 됩니다');
  assert.match(app.text('#warn-text'), /검사/);
});

test('프로필이 정말 하나도 없으면 켜져 있는 토글을 다시 확인하라고 하지 않는다', async () => {
  // 이 화면은 isAllowedFileSchemeAccess() 가 true 를 준 뒤에만 나온다. 그런데도
  // "파일 URL 접근이 켜져 있는지 확인" 이라고 말하면, 사용자가 토글을 만지고
  // 확장만 리로드되고 아무것도 해결되지 않는다.
  const app = await mountPopup({ fs: new FakeFs(), fileAccess: true });

  assert.equal(app.panel(), 'result');
  assert.equal(app.text('.card .state-title'), msg('noProfilesTitle'));
  const hint = app.text('.card .state-hint');
  assert.equal(hint, msg('noProfilesHint'));
  assert.doesNotMatch(hint, /파일 URL/, '켜져 있음을 방금 확인한 토글을 다시 확인하라고 하면 안 됩니다');
});

test('검사가 끝나면 스크린리더에 결과를 알린다', async () => {
  // 패널을 통째로 갈아 끼워도 포커스가 그대로면 스크린리더에는 아무 일도
  // 일어나지 않은 것과 같다. "다시 검사"를 눌러도 끝났는지 알 방법이 없다.
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir });

  const live = app.doc.getElementById('live');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(live.getAttribute('role'), 'status');
  assert.match(live.textContent, /Work/, `결과 요약이 없습니다: "${live.textContent}"`);
  assert.match(live.textContent, /1/, '다른 프로필 개수가 없습니다');
  assert.equal(app.doc.getElementById('btn-refresh').getAttribute('aria-busy'), 'false');
});

test('오류 화면은 알릴 곳과 복사 수단을 함께 준다', async () => {
  // "알려 주세요"라고 말하면서 알릴 곳을 안 주면 지시를 따를 수가 없다.
  // 웹스토어로 설치한 사용자는 이 확장의 소스가 어디 있는지 알 방법이 없다.
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir, breakDom: 'self-slot' });

  assert.equal(app.panel(), 'error');
  assert.equal(app.doc.getElementById('issue-url-line').hidden, false);
  assert.equal(app.text('#issue-url'), HOMEPAGE);
  assert.notEqual(app.text('#error-text').trim(), '');

  await app.click('#btn-copy-error');
  assert.equal(app.clipboard.length, 1);
  assert.equal(app.clipboard[0], app.text('#error-text'));
});

test('로딩 화면에는 빠져나올 버튼이 있다', async () => {
  // file:// 읽기 하나가 영원히 멈출 수 있다(FIFO, 응답 없는 네트워크 마운트).
  // 그때 로딩 화면에 조작 가능한 컨트롤이 하나도 없으면 팝업에 갇힌다.
  const html = await readFile(path.join(EXT, 'popup.html'), 'utf8');
  assert.match(html, /id="btn-cancel"/);
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir });
  const cancel = app.doc.getElementById('btn-cancel');
  assert.ok(cancel, '로딩 화면에 중단 버튼이 없습니다');
  assert.equal(cancel.textContent, msg('cancelScan'));
});

// ---------------------------------------------------------------------------
// 5. manifest 권한과의 연결
// ---------------------------------------------------------------------------

test('"storage" 권한이 없으면 자기 탐지만 실패하고 팝업은 살아남는다', async () => {
  // chrome.storage 는 "storage" 권한 없이는 undefined 다. 그때 locateSelf 가
  // 던지는데, 그 예외가 팝업 전체를 죽이면 안 된다.
  const { fs } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir: null, storagePermission: false });

  assert.equal(app.panel(), 'result', '팝업이 통째로 죽으면 안 됩니다');
  assert.equal(app.doc.getElementById('warn-box').hidden, false, '왜 실패했는지 알려 줘야 합니다');
  assert.match(app.text('#warn-text'), /storage/);
  // 프로필 목록 자체는 멀쩡하다.
  assert.equal(app.doc.querySelectorAll('#others-slot .row').length, 2);
});

// ---------------------------------------------------------------------------
// 6. i18n
// ---------------------------------------------------------------------------

test('화면에 나오는 글자는 전부 카탈로그에서 온다 — 키 이름이 새지 않는다', async () => {
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir });

  assertNoKeyLeak(app, ko);
  // 치환되지 않은 자리 표시자도 없어야 한다.
  assert.doesNotMatch(app.all(), /\$[A-Z_]{3,}\$/);
});

test('정적 문구와 lang 속성이 카탈로그대로 채워진다', async () => {
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir });

  assert.equal(app.text('.hd-title'), msg('appTitle'));
  assert.equal(app.text('.hd-sub'), msg('appSubtitle'));
  assert.equal(app.doc.getElementById('btn-refresh').getAttribute('aria-label'), msg('refresh'));
  assert.equal(app.doc.getElementById('btn-refresh').title, msg('refresh'));
  // `<html lang>` 은 브라우저 UI 언어가 아니라 **실제로 그려진 언어**여야 한다.
  // 스텁의 getUILanguage 는 일부러 'fr' 을 준다 — 그 값을 그대로 쓰면 프랑스어
  // 크롬에서 화면은 한국어인데 lang 은 "fr" 이 되어 스크린리더가 프랑스어
  // 음성으로 한글을 읽는다(WCAG 3.1.1).
  assert.equal(app.doc.lang, 'ko');
  // data-i18n 이 붙은 노드 중 빈 것이 없어야 한다(보이는 패널 기준).
  for (const node of app.doc.querySelectorAll('[data-i18n]')) {
    assert.notEqual(node.textContent.trim(), '', `${node.getAttribute('data-i18n')} 이 비었습니다`);
  }
});

test('en 카탈로그로도 같은 화면이 그려진다', async () => {
  const en = JSON.parse(await readFile(path.join(EXT, '_locales/en/messages.json'), 'utf8'));
  const { fs, selfProfileDir } = standardFs();
  const app = await mountPopup({ fs, selfProfileDir, catalog: en });

  assert.equal(app.panel(), 'result');
  assert.equal(app.doc.lang, 'en', 'lang 은 그려진 카탈로그의 언어여야 합니다');
  assert.equal(app.text('.card-self .uuid-text'), DEVICE_B);
  assert.equal(app.text('.card-self .badge'), en.badgeCurrent.message);
  assertNoKeyLeak(app, en);
  assert.doesNotMatch(app.all(), /\$[A-Z_]{3,}\$/);
});

test('en 로케일 경고 상자에는 한글이 한 글자도 없다', async () => {
  // 예전에는 lib 이 한국어 문장을 직접 만들어서, 영어 사용자에게 "Could not
  // determine the current profile: chrome.storage.local 을 쓸 수 없습니다..."
  // 처럼 한 문장 안에서 언어가 갈렸다. 이제 lib 은 `{code, params}` 만 올리고
  // 문장은 popup.js 가 카탈로그에서 만든다.
  const en = JSON.parse(await readFile(path.join(EXT, '_locales/en/messages.json'), 'utf8'));

  const fs = new FakeFs();
  // 경고가 실제로 생기는 배치: 확장 폴더는 있는데 LevelDB 파일이 없고(흔한
  // 경로다 — 크롬이 디렉터리만 막 만든 직후), 값 하나는 깨진 JSON 이다.
  addProfile(fs, CHROME_DIR, 'Default', { claudeInstalled: false, selfStorage: true });
  fs.addDir(`${CHROME_DIR}/Profile 1/Local Extension Settings/${CLAUDE_ID}`);
  fs.addFile(`${CHROME_DIR}/Profile 1/Preferences`, '{}');
  addProfile(fs, CHROME_DIR, 'Profile 2', {});
  addLevelDb(fs, `${CHROME_DIR}/Profile 2/Local Extension Settings/${CLAUDE_ID}`, [
    ['bridgeDeviceId', '{not json'],
  ]);
  addLocalState(fs, CHROME_DIR, {
    Default: { name: 'Personal' },
    'Profile 1': { name: 'Work' },
    'Profile 2': { name: 'Spare' },
  });

  const app = await mountPopup({ fs, selfProfileDir: `${CHROME_DIR}/Default`, catalog: en });

  assert.equal(app.doc.getElementById('warn-box').hidden, false, '경고가 생기는 배치여야 의미가 있습니다');
  const text = app.text('#warn-text');
  assert.doesNotMatch(text, /[가-힣]/, `en 화면에 한글이 섞였습니다: ${text}`);
  // 화면 전체도 마찬가지다.
  assert.doesNotMatch(app.all(), /[가-힣]/, 'en 화면 어딘가에 한글이 남아 있습니다');
});

test('ko 로케일에서도 경고는 카탈로그 문장으로 나온다', async () => {
  const fs = new FakeFs();
  addProfile(fs, CHROME_DIR, 'Default', { claudeInstalled: false, selfStorage: true });
  fs.addFile(`${CHROME_DIR}/Profile 1/Preferences`, '{}');
  fs.addDir(`${CHROME_DIR}/Profile 1/Local Extension Settings/${CLAUDE_ID}`);
  addLocalState(fs, CHROME_DIR, { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } });

  const app = await mountPopup({ fs, selfProfileDir: `${CHROME_DIR}/Default` });
  const text = app.text('#warn-text');
  assert.match(text, /LevelDB/);
  assert.match(text, /[가-힣]/, 'ko 화면인데 경고가 영어입니다');
  assert.doesNotMatch(text, /^warn[A-Z]/m, '메시지 키가 그대로 새어 나왔습니다');
});

/**
 * `t()` 는 메시지를 못 찾으면 **키 이름 자체**를 그린다. 그러니 화면의 어떤
 * 글자 조각이 키 이름과 정확히 같으면 카탈로그에 구멍이 있다는 뜻이다.
 *
 * `includes` 로 훑으면 안 된다 — 영어 메시지 "Click to copy" 안에는 `copy` 키가
 * 부분 문자열로 들어 있어서 멀쩡한 화면을 실패로 만든다.
 *
 * @param {{doc: import('./helpers/mini-dom.js').MiniDocument}} app
 * @param {Record<string, {message: string}>} catalog
 */
function assertNoKeyLeak(app, catalog) {
  const keys = new Set(Object.keys(catalog));
  const seen = [];
  const walk = (node) => {
    for (const kid of node.childNodes) {
      if (kid.nodeType === 3) seen.push(kid.data.trim());
      else walk(kid);
    }
  };
  walk(app.doc.body);
  for (const text of seen) {
    assert.equal(keys.has(text), false, `키 이름 "${text}" 이 번역 대신 화면에 나왔습니다`);
  }
  // aria-label / title 도 t() 를 거친다.
  for (const el of app.doc.querySelectorAll('[aria-label]')) {
    assert.equal(keys.has(el.getAttribute('aria-label')), false, `aria-label 이 키 이름입니다`);
  }
}

// ---------------------------------------------------------------------------
// 7. 다시 검사
// ---------------------------------------------------------------------------

test('"다시 검사" 는 디렉터리 목록 캐시를 비우고 디스크를 다시 읽는다', async () => {
  // 새로 설치된 확장은 **디렉터리 목록 자체**를 바꾼다. 캐시를 비우지 않으면
  // 앞 실행에서 읽어 둔 "Local Extension Settings" 목록에 Claude 확장이 없어서
  // 영영 못 찾는다.
  const fs = new FakeFs();
  addProfile(fs, CHROME_DIR, 'Default', { claudeInstalled: false, selfStorage: true });
  addLocalState(fs, CHROME_DIR, { Default: { name: 'Personal' } });

  const app = await mountPopup({ fs, selfProfileDir: `${CHROME_DIR}/Default` });
  assert.equal(app.text('.card-self .state-title'), msg('claudeNotInstalled'));
  assert.equal(app.doc.getElementById('btn-refresh').hidden, false, '결과 화면에서는 새로고침이 보여야 합니다');

  // 그 사이에 사용자가 Claude 확장을 깔고 페어링까지 마쳤다.
  addLevelDb(fs, `${CHROME_DIR}/Default/Local Extension Settings/${CLAUDE_ID}`, [
    ['bridgeDeviceId', JSON.stringify(DEVICE_A)],
  ]);

  await app.click('#btn-refresh', { rerun: true });
  assert.equal(app.text('.card-self .uuid-text'), DEVICE_A, '캐시를 비우지 않아 옛 결과가 남았습니다');
});

// ---------------------------------------------------------------------------
// 8. 계약 대조 (정적)
// ---------------------------------------------------------------------------

test('popup.js 가 부르는 byId 는 전부 popup.html 에 있다', async () => {
  const js = await readFile(path.join(EXT, 'popup.js'), 'utf8');
  const html = await readFile(path.join(EXT, 'popup.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  const wanted = [...js.matchAll(/byId\(\s*'([^'`]+)'\s*\)/g)].map((m) => m[1]);
  assert.ok(wanted.length >= 8, `byId 호출을 찾지 못했습니다: ${wanted.length}개`);
  for (const id of wanted) assert.ok(ids.has(id), `popup.js 가 #${id} 를 찾는데 popup.html 에 없습니다`);

  // 동적으로 만드는 panel-* 도 확인한다.
  for (const name of ['loading', 'access', 'result', 'error']) {
    assert.ok(ids.has(`panel-${name}`), `panel-${name} 이 popup.html 에 없습니다`);
  }
});

test('manifest 가 가리키는 파일은 전부 실제로 있다', async () => {
  const manifest = JSON.parse(await readFile(path.join(EXT, 'manifest.json'), 'utf8'));
  /** @type {Array<[string, string]>} */
  const refs = [];
  for (const [size, rel] of Object.entries(manifest.icons ?? {})) refs.push([`icons.${size}`, rel]);
  for (const [size, rel] of Object.entries(manifest.action?.default_icon ?? {})) {
    refs.push([`action.default_icon.${size}`, rel]);
  }
  if (manifest.action?.default_popup) refs.push(['action.default_popup', manifest.action.default_popup]);

  assert.ok(refs.length >= 9, `manifest 참조가 너무 적습니다: ${refs.length}개`);
  for (const [where, rel] of refs) {
    const buf = await readFile(path.join(EXT, rel)).catch(() => null);
    assert.ok(buf, `manifest 의 ${where} 이 가리키는 ${rel} 이 없습니다`);
    assert.ok(buf.length > 0, `${rel} 이 비어 있습니다`);
  }

  // 아이콘은 진짜 PNG 여야 한다. 크롬은 깨진 아이콘을 조용히 무시한다.
  for (const [size, rel] of Object.entries(manifest.icons ?? {})) {
    const buf = await readFile(path.join(EXT, rel));
    assert.deepEqual(
      [...buf.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${rel} 이 PNG 가 아닙니다`,
    );
    assert.equal(buf.readUInt32BE(16), Number(size), `${rel} 의 가로 크기가 ${size} 가 아닙니다`);
    assert.equal(buf.readUInt32BE(20), Number(size), `${rel} 의 세로 크기가 ${size} 가 아닙니다`);
  }
});

test('popup.js 가 만드는 클래스는 popup.css 에 전부 있다', async () => {
  // popup.js 와 popup.css 는 서로를 문자열로만 안다. 한쪽에서 이름을 바꾸면
  // 아무 에러 없이 스타일만 조용히 사라진다.
  const js = await readFile(path.join(EXT, 'popup.js'), 'utf8');
  const html = await readFile(path.join(EXT, 'popup.html'), 'utf8');
  const css = await readFile(path.join(EXT, 'popup.css'), 'utf8');

  const used = new Set();
  for (const m of js.matchAll(/class:\s*'([^']+)'/g)) for (const c of m[1].split(/\s+/)) used.add(c);
  for (const m of js.matchAll(/class:\s*[^,}]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) {
    for (const c of `${m[1]} ${m[2]}`.split(/\s+/)) used.add(c);
  }
  for (const m of js.matchAll(/classList\.(?:add|remove)\('([^']+)'\)/g)) used.add(m[1]);
  for (const m of html.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) used.add(c);
  used.delete('');

  const styled = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  assert.ok(used.size > 30, `클래스를 제대로 못 모았습니다: ${used.size}개`);

  const unstyled = [...used].filter((c) => !styled.has(c)).sort();
  assert.deepEqual(unstyled, [], 'popup.css 에 규칙이 없는 클래스입니다');

  const orphan = [...styled].filter((c) => !used.has(c)).sort();
  assert.deepEqual(orphan, [], 'popup.css 에만 있고 아무도 쓰지 않는 클래스입니다');
});

test('popup.html 이 부르는 파일은 전부 실제로 있다', async () => {
  const html = await readFile(path.join(EXT, 'popup.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(?:https?:|data:|#)/.test(u));
  assert.ok(refs.includes('popup.js') && refs.includes('popup.css'), `참조: ${refs.join(', ')}`);
  for (const rel of refs) {
    const buf = await readFile(path.join(EXT, rel)).catch(() => null);
    assert.ok(buf, `popup.html 이 가리키는 ${rel} 이 없습니다`);
  }
});

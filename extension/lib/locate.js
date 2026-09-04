/**
 * 이 머신의 크롬 프로필을 찾아내고, 그중 **어느 것이 지금 이 창의 프로필인지**
 * 알아낸다.
 *
 * 확장은 자기가 어느 프로필에서 돌고 있는지 물어볼 API 가 없다.
 * `chrome.identity.getProfileUserInfo` 는 로그아웃 프로필에서 빈 값을 주고,
 * 디렉터리 이름(`Default`, `Profile 3`)은 신원이 아니다. 그래서 nonce 왕복을
 * 쓴다.
 *
 *   1. 난수 UUID 를 `chrome.storage.local` 에 쓴다.
 *   2. 그 값은 곧바로(측정상 0ms) 이 프로필의
 *      `<profile>/Local Extension Settings/<확장 id>/*.log` 에 나타난다.
 *   3. 모든 프로필의 같은 경로를 파서로 읽어, 그 UUID 가 들어 있는 프로필이
 *      바로 자기 자신이다.
 *
 * WAL 을 문자열 `includes` 로 뒤지면 안 된다. 레코드가 32KiB 블록 경계를 넘으면
 * 7바이트 레코드 헤더가 값 한복판에 박혀서 조용히 못 찾는다. 반드시
 * `readLevelDbFrom` 으로 읽는다.
 *
 * @module locate
 */

import {
  decodeUtf8,
  fetchBytes,
  findChildDirEx,
  findChildFile,
  joinPath,
  listDirOrNull,
  makeSource,
  resolveDirPath,
} from './fileurl.js';
import { readLevelDbFrom } from './leveldb-core.js';

/** nonce 를 넣어 두는 `chrome.storage.local` 키. 매 실행마다 새 값으로 덮어쓴다. */
export const NONCE_KEY = '__cici_nonce';

/**
 * 확장을 설치할 수 있는 브라우저 계열. `src/browsers.js` 의 `BROWSERS` 와 같다.
 * @type {ReadonlyArray<{id: string, name: string}>}
 */
export const BROWSERS = Object.freeze([
  { id: 'chrome', name: 'Google Chrome' },
  { id: 'chrome-beta', name: 'Google Chrome Beta' },
  { id: 'chrome-dev', name: 'Google Chrome Dev' },
  { id: 'chrome-canary', name: 'Google Chrome Canary' },
  { id: 'chromium', name: 'Chromium' },
  { id: 'brave', name: 'Brave' },
  { id: 'edge', name: 'Microsoft Edge' },
  { id: 'arc', name: 'Arc' },
  { id: 'vivaldi', name: 'Vivaldi' },
  { id: 'opera', name: 'Opera' },
]);

/** @param {string} id */
function browserName(id) {
  const found = BROWSERS.find((b) => b.id === id);
  return found ? found.name : id;
}

/**
 * @param {Array<[string, string]>} pairs
 * @returns {ReadonlyArray<{browser: string, browserName: string, path: string}>}
 */
function browserDirs(pairs) {
  return Object.freeze(
    pairs.map(([browser, rel]) => Object.freeze({ browser, browserName: browserName(browser), path: rel })),
  );
}

/**
 * 홈 디렉터리 기준 상대 경로로 적은 user-data-dir 후보.
 *
 * 확장은 환경변수도 홈 경로도 알 수 없으므로 절대 경로를 적을 수 없다.
 * `listHomes()` 가 찾아 준 홈 앞에 붙여서 쓴다. 윈도우의 `LOCALAPPDATA` /
 * `APPDATA` 는 기본값(`AppData/Local`, `AppData/Roaming`)만 다룬다.
 *
 * @type {Readonly<Record<'mac'|'win'|'linux', ReadonlyArray<{browser: string, browserName: string, path: string}>>>}
 */
export const BROWSER_DIRS = Object.freeze({
  mac: browserDirs([
    ['chrome', 'Library/Application Support/Google/Chrome'],
    ['chrome-beta', 'Library/Application Support/Google/Chrome Beta'],
    ['chrome-dev', 'Library/Application Support/Google/Chrome Dev'],
    ['chrome-canary', 'Library/Application Support/Google/Chrome Canary'],
    ['chromium', 'Library/Application Support/Chromium'],
    ['brave', 'Library/Application Support/BraveSoftware/Brave-Browser'],
    ['edge', 'Library/Application Support/Microsoft Edge'],
    ['arc', 'Library/Application Support/Arc/User Data'],
    ['vivaldi', 'Library/Application Support/Vivaldi'],
    ['opera', 'Library/Application Support/com.operasoftware.Opera'],
  ]),
  win: browserDirs([
    ['chrome', 'AppData/Local/Google/Chrome/User Data'],
    ['chrome-beta', 'AppData/Local/Google/Chrome Beta/User Data'],
    ['chrome-dev', 'AppData/Local/Google/Chrome Dev/User Data'],
    ['chrome-canary', 'AppData/Local/Google/Chrome SxS/User Data'],
    ['chromium', 'AppData/Local/Chromium/User Data'],
    ['brave', 'AppData/Local/BraveSoftware/Brave-Browser/User Data'],
    ['edge', 'AppData/Local/Microsoft/Edge/User Data'],
    ['vivaldi', 'AppData/Local/Vivaldi/User Data'],
    ['opera', 'AppData/Roaming/Opera Software/Opera Stable'],
  ]),
  linux: browserDirs([
    ['chrome', '.config/google-chrome'],
    ['chrome-beta', '.config/google-chrome-beta'],
    ['chrome-dev', '.config/google-chrome-unstable'],
    ['chromium', '.config/chromium'],
    ['brave', '.config/BraveSoftware/Brave-Browser'],
    ['edge', '.config/microsoft-edge'],
    ['vivaldi', '.config/vivaldi'],
    ['opera', '.config/opera'],
  ]),
});

/** 홈 디렉터리들이 들어 있는 곳. 확장은 여기서부터 훑어 내려갈 수밖에 없다. */
export const HOME_ROOTS = Object.freeze({ mac: '/Users', win: 'C:/Users', linux: '/home' });

/** 사람 계정이 아닌 홈 이름. */
const SYSTEM_HOME_NAMES = new Set([
  'shared',
  'guest',
  'public',
  'default',
  'default user',
  'defaultuser0',
  'all users',
  'localservice',
  'networkservice',
  'systemprofile',
  'lost+found',
  'desktop.ini',
]);

/** 절대 사용자 프로필이 아닌 user-data-dir 하위 디렉터리. */
const NON_PROFILE_DIRS = new Set([
  'System Profile',
  'Guest Profile',
  'Crashpad',
  'ShaderCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'Safe Browsing',
  'SwReporter',
  'Subresource Filter',
  'CertificateRevocation',
  'OriginTrials',
  'FileTypePolicies',
  'PKIMetadata',
  'MEIPreload',
  'SSLErrorAssistant',
  'TpcdMetadata',
  'ZxcvbnData',
  'AutofillStates',
  'OptimizationHints',
  'OptimizationGuidePredictionModels',
  'WidevineCdm',
  'component_crx_cache',
  'extensions_crx_cache',
  'BrowserMetrics',
  'Webstore Downloads',
  'Snapshots',
  'hyphen-data',
  'segmentation_platform',
  'first_party_sets',
  'Floc',
  'RecoveryImproved',
  'CookieReadinessList',
  'TrustTokenKeyCommitments',
  'AmountExtractionHeuristicRegexes',
  'MediaFoundationWidevineCdm',
  'OnDeviceHeadSuggestModel',
  'PrivacySandboxAttestationsPreloaded',
  'ProbabilisticRevealTokenRegistry',
  'ClientSidePhishing',
  'Default Dictionary',
  'Local Traces',
  'GCM Store',
  'Consent To Send Stats',
  'Module Info Cache',
  'Crowd Deny',
  'Screen AI',
  'ScreenAI',
  'Speech Recognition',
  'SODA Models',
  'OpenCookieDatabase',
  'MaskedDomainList',
  'ThirdPartyModuleList64',
  'AutofillRegex',
  // 실제 Chrome 148 user-data-dir 에서 확인한 것들.
  'ActorSafetyLists',
  'Avatars',
  'CaptchaProviders',
  'FirstPartySetsPreloaded',
  'GPUPersistentCache',
  'NativeMessagingHosts',
  'OptimizationGuideModelsManifest',
  'optimization_guide_model_store',
  'SafetyTips',
  'screen_ai',
  'WasmTtsEngine',
]);

/**
 * 사람 계정의 홈으로 볼 수 없는 이름인지.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSystemHomeName(name) {
  if (typeof name !== 'string' || name === '') return true;
  if (name.startsWith('.')) return true;
  return SYSTEM_HOME_NAMES.has(name.toLowerCase());
}

/**
 * user-data-dir 안에서 프로필일 리 없는 디렉터리인지.
 *
 * 이름으로 프로필을 **판정**하지는 않는다(그건 `isProfileDir()` 이 파일로 한다).
 * 여기서는 확실히 아닌 것만 미리 걸러서 fetch 를 아낀다.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isNonProfileDirName(name) {
  return NON_PROFILE_DIRS.has(name);
}

/**
 * 플랫폼을 알아낸다.
 *
 * @returns {Promise<'mac'|'win'|'linux'>}
 */
export async function detectPlatform() {
  let raw = '';
  try {
    const nav = globalThis.navigator;
    raw = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  } catch {
    raw = '';
  }
  const s = String(raw).toLowerCase();
  if (s.includes('mac') || s.includes('darwin') || s.includes('iphone') || s.includes('ipad')) return 'mac';
  if (s.includes('win')) return 'win';
  return 'linux';
}

/**
 * 홈 디렉터리 후보.
 *
 * @param {'mac'|'win'|'linux'} platform
 * @returns {Promise<string[]>} 절대 경로 (`/Users/you`, `C:/Users/you`, `/home/you`)
 */
export async function listHomes(platform) {
  const root = HOME_ROOTS[platform] ?? HOME_ROOTS.linux;
  // 홈 루트를 못 읽으면 프로필도 못 찾는다. 팝업이 "프로필 없음" 화면을 띄운다.
  const entries = await listDirOrNull(root);
  if (!entries) return [];
  return entries.filter((e) => e.isDir && !isSystemHomeName(e.name)).map((e) => joinPath(root, e.name));
}

/**
 * 프로필 디렉터리인지 파일로 확인한다. 이름은 보지 않는다.
 *
 * **답이 셋이다.** 목록을 못 읽었으면 `'no'` 가 아니라 `'unknown'` 이다. 둘을
 * 뭉개면 읽지 못한 프로필이 통째로 목록에서 사라지고, 그게 하필 지금 창의
 * 프로필이면 자기 탐지까지 실패하면서 경고는 한 줄도 안 남는다.
 *
 * @param {string} profileDir
 * @returns {Promise<'yes'|'no'|'unknown'>}
 */
async function probeProfileDir(profileDir) {
  const entries = await listDirOrNull(profileDir);
  if (!entries) return 'unknown';
  const hit = entries.some(
    (e) => (!e.isDir && e.name === 'Preferences') || (e.isDir && e.name === 'Local Extension Settings'),
  );
  return hit ? 'yes' : 'no';
}

/**
 * @typedef {object} ProfileDirInfo
 * @property {string} browser        브라우저 id ("chrome", "brave", ...)
 * @property {string} browserName    표시 이름 ("Google Chrome")
 * @property {string} userDataDir    user-data-dir 절대 경로
 * @property {string} profileDir     프로필 디렉터리 절대 경로
 * @property {string} profileDirName 프로필 디렉터리 이름 ("Default", "Profile 3")
 */

/**
 * 프로필 디렉터리 이름 정렬 순서. `Default` 가 먼저, 그다음 `Profile N` 을 숫자
 * 순으로, 나머지는 사전순.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareProfileDirNames(a, b) {
  const rank = (n) => (n === 'Default' ? 0 : /^Profile \d+$/.test(n) ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) return Number(a.slice(8)) - Number(b.slice(8));
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 이 머신의 크롬 계열 프로필을 모두 열거한다.
 *
 * 없는 경로는 조용히 건너뛴다. 모든 fetch 는 병렬로 나간다.
 *
 * **읽지 못한 후보는 조용히 버리지 않는다.** 목록이 실패한 디렉터리는 경고로
 * 남기고, `Local State` 의 `profile.info_cache` 가 그것을 프로필이라고 확인해
 * 주면 결과에 그대로 실어 보낸다. 확인해 주지 못하면 (프로필인지 아닌지도 모르는
 * 잡동사니 디렉터리일 수 있으므로) 행으로 만들지는 않되 경고는 남긴다.
 *
 * @param {'mac'|'win'|'linux'} [platform] 생략하면 {@link detectPlatform} 으로 판정
 * @param {Array<{code: string, params: string[]}>} [warnings] 읽지 못한 후보를 적어 둔다
 * @returns {Promise<ProfileDirInfo[]>}
 */
export async function listProfileDirs(platform, warnings) {
  const plat = platform ?? (await detectPlatform());
  const homes = await listHomes(plat);
  const dirs = BROWSER_DIRS[plat] ?? [];

  // 후보 경로를 바로 열지 않고 한 조각씩 확인하며 내려간다. 설치되지 않은
  // 브라우저의 경로를 그냥 fetch 하면 콘솔에 `net::ERR_FILE_NOT_FOUND` 가 남는데,
  // 잡아도 지워지지 않기 때문이다. 앞부분이 겹치는 후보들은 캐시가 흡수한다.
  const resolved = await Promise.all(
    homes.flatMap((home) =>
      dirs.map(async (d) => {
        const userDataDir = await resolveDirPath(home, d.path);
        return userDataDir === null
          ? null
          : { browser: d.browser, browserName: d.browserName, userDataDir };
      }),
    ),
  );
  /** @type {Array<{browser: string, browserName: string, userDataDir: string}>} */
  const userDataDirs = resolved.filter((u) => u !== null);

  const listings = await Promise.all(userDataDirs.map((u) => listDirOrNull(u.userDataDir)));

  /** @type {ProfileDirInfo[]} */
  const candidates = [];
  userDataDirs.forEach((u, i) => {
    const entries = listings[i];
    if (!entries) return;
    for (const e of entries) {
      if (!e.isDir || isNonProfileDirName(e.name)) continue;
      candidates.push({
        browser: u.browser,
        browserName: u.browserName,
        userDataDir: u.userDataDir,
        profileDir: joinPath(u.userDataDir, e.name),
        profileDirName: e.name,
      });
    }
  });

  const probes = await Promise.all(candidates.map((c) => probeProfileDir(c.profileDir)));
  const found = candidates.filter((_c, i) => probes[i] === 'yes');
  const unknown = candidates.filter((_c, i) => probes[i] === 'unknown');

  if (unknown.length > 0) {
    // 읽지 못한 후보. 사용자에게는 무조건 알린다.
    if (Array.isArray(warnings)) {
      for (const c of unknown) warnings.push({ code: 'warnProfileUnreadable', params: [c.profileDir] });
    }
    // 그리고 `Local State` 가 "이건 진짜 프로필"이라고 확인해 주는 것만 목록에
    // 넣는다. 그 파일은 프로필 디렉터리와 별개라서 프로필 폴더를 못 읽는
    // 상황에서도 대개 읽힌다. 확인 없이 전부 넣으면 이름만 낯선 디렉터리가
    // 유령 프로필 행으로 뜬다.
    const roots = [...new Set(unknown.map((c) => c.userDataDir))];
    const metas = new Map(
      await Promise.all(
        roots.map(async (root) => [root, await readProfileMeta(root).catch(() => new Map())]),
      ),
    );
    for (const c of unknown) {
      if (metas.get(c.userDataDir)?.has(c.profileDirName)) found.push(c);
    }
  }

  const order = new Map(BROWSERS.map((b, i) => [b.id, i]));
  found.sort((a, b) => {
    const ba = order.get(a.browser) ?? BROWSERS.length;
    const bb = order.get(b.browser) ?? BROWSERS.length;
    if (ba !== bb) return ba - bb;
    if (a.userDataDir !== b.userDataDir) return a.userDataDir < b.userDataDir ? -1 : 1;
    return compareProfileDirNames(a.profileDirName, b.profileDirName);
  });
  return found;
}

/**
 * @typedef {object} ProfileMeta
 * @property {string|null} name      프로필 이름 ("Work")
 * @property {string|null} email     로그인된 계정 ("you@example.com")
 * @property {string|null} gaiaName  구글 계정 표시 이름
 */

/** @param {unknown} v */
function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * `<userDataDir>/Local State` 의 `profile.info_cache` 를 읽는다.
 *
 * 디렉터리 이름(`Default`, `Profile 3`)은 신원이 아니다. 사람이 알아볼 수 있는
 * 이름과 이메일은 여기에만 있다.
 *
 * @param {string} userDataDir
 * @returns {Promise<Map<string, ProfileMeta>>} 실패하면 빈 Map
 */
export async function readProfileMeta(userDataDir) {
  /** @type {Map<string, ProfileMeta>} */
  const out = new Map();
  // 있는지 목록으로 먼저 확인한다. 없는 파일을 열면 콘솔에 에러가 남는다.
  const path = await findChildFile(userDataDir, 'Local State');
  if (path === null) return out;
  let json;
  try {
    json = JSON.parse(decodeUtf8(await fetchBytes(path)));
  } catch {
    return out;
  }
  const cache = json && typeof json === 'object' ? json.profile?.info_cache : null;
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return out;
  for (const [dirName, info] of Object.entries(cache)) {
    if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
    out.set(dirName, {
      name: nonEmptyString(info.name),
      email: nonEmptyString(info.user_name),
      gaiaName: nonEmptyString(info.gaia_name),
    });
  }
  return out;
}

/**
 * 랜덤 UUID. 확장 페이지는 보안 컨텍스트라 `crypto.randomUUID()` 가 항상 있지만,
 * 없을 때를 대비해 직접 만드는 길도 둔다.
 *
 * @returns {string}
 */
function randomUuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 화면에 보여 줄 문장을 만들 수 있는 에러.
 *
 * `message` 는 영어로 고정한다(개발자용). 사람에게 보일 문장은 popup.js 가
 * `i18nCode` / `i18nParams` 로 `_locales` 에서 만든다. 라이브러리가 한국어
 * 문장을 직접 던지면 en 로케일 경고 상자에 한글이 그대로 박힌다.
 *
 * @param {string} message 영어 개발자용 메시지
 * @param {string} code `_locales` 메시지 키
 * @param {...string} params
 * @returns {Error}
 */
function codedError(message, code, ...params) {
  const err = new Error(message);
  err.i18nCode = code;
  err.i18nParams = params.map((p) => String(p));
  return err;
}

/**
 * @typedef {object} NonceHit
 * @property {boolean} match     nonce 가 그 프로필에 있으면 true
 * @property {boolean} unreadable 읽지 못해서 판정 자체를 못 했으면 true
 * @property {Array<{dir: string, note: string}>} notes 파서가 남긴 진단.
 *   왜 못 읽었는지는 여기에만 있다. 버리면 사용자에게 남는 단서가 0이 된다.
 */

/**
 * 한 프로필의 우리 확장 저장소에 `nonce` 가 들어 있는지 본다.
 *
 * `chrome.storage.local` 은 값을 JSON 으로 저장하므로 디스크에는 따옴표까지 붙어
 * 있다. 혹시 모르니 날값 비교도 함께 한다.
 *
 * "우리 확장이 그 프로필에 없다"와 "그 프로필을 못 읽었다"는 다른 답이다.
 * 뒤엣것을 `false` 로 뭉개면 자기 프로필 탐지가 조용히 실패한다.
 *
 * @param {string} profileDir 프로필 디렉터리
 * @param {string} selfId 이 확장의 id
 * @param {string} nonce
 * @returns {Promise<NonceHit>}
 */
async function storageHasNonce(profileDir, selfId, nonce) {
  // 우리 확장이 그 프로필에 깔려 있는지부터 목록으로 확인한다. 없는 경로를
  // 그냥 열면 콘솔에 `net::ERR_FILE_NOT_FOUND` 가 남는다.
  const settings = await findChildDirEx(profileDir, 'Local Extension Settings');
  if (settings.unreadable) return { match: false, unreadable: true, notes: [] };
  if (settings.path === null) return { match: false, unreadable: false, notes: [] };

  const storage = await findChildDirEx(settings.path, selfId);
  if (storage.unreadable) return { match: false, unreadable: true, notes: [] };
  if (storage.path === null) return { match: false, unreadable: false, notes: [] };

  try {
    const entries = await listDirOrNull(storage.path);
    if (entries === null) return { match: false, unreadable: true, notes: [] };
    const source = makeSource(storage.path, { entries });
    const db = await readLevelDbFrom(source);
    const raw = db.entries.get(NONCE_KEY);
    if (raw !== undefined) {
      const text = decodeUtf8(raw);
      if (text === nonce) return { match: true, unreadable: false, notes: [] };
      try {
        return { match: JSON.parse(text) === nonce, unreadable: false, notes: [] };
      } catch {
        return { match: false, unreadable: false, notes: [] };
      }
    }

    // 표식이 없다. 그런데 `readLevelDbFrom` 은 파일 읽기 실패에 예외를 던지지
    // 않고 경고로 삼키므로, 여기까지 오는 길에는 "정말 없다"와 "못 읽어서
    // 안 보인다" 두 가지가 섞여 있다. 뒤엣것을 `false` 로 뭉개면 자기 프로필
    // 탐지가 이유 한 줄 없이 실패한다.
    const failedReads = source.readErrors();
    const readNothing = db.files.tables.length === 0 && db.files.logs.length === 0;
    if (failedReads.length === 0 && !readNothing) return { match: false, unreadable: false, notes: [] };

    const notes = [...db.warnings, ...failedReads].map((note) => ({ dir: storage.path, note }));
    return { match: false, unreadable: true, notes };
  } catch (err) {
    return {
      match: false,
      unreadable: true,
      notes: [{ dir: storage.path, note: err instanceof Error ? err.message : String(err) }],
    };
  }
}

/**
 * 자기 표식(nonce)을 `chrome.storage.local` 에 남긴다. 남긴 값을 돌려준다.
 *
 * **디렉터리 목록을 훑기 전에 불러야 한다.** 확장을 갓 설치한 프로필에는
 * `<프로필>/Local Extension Settings/<우리 id>/` 가 아직 없다. 이 디렉터리는
 * 우리가 storage 에 처음 쓰는 순간 크롬이 만든다. 목록을 먼저 읽어서 캐시에
 * 굳혀 버리면 그 뒤에 생긴 디렉터리를 못 보고, 첫 팝업이 자기 프로필을 놓친다.
 * (Chrome 148 실측: 새 프로필에서 첫 번째 팝업은 자기를 못 찾고 두 번째부터
 * 찾았다. 웹스토어로 갓 설치한 사용자가 정확히 이 경우다.)
 *
 * @returns {Promise<string>} 방금 남긴 nonce
 */
export async function writeNonce() {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage) {
    throw codedError(
      'chrome.storage.local is unavailable; manifest.json needs "storage" in "permissions"',
      'warnStorageUnavailable',
    );
  }
  const nonce = randomUuid();
  await storage.set({ [NONCE_KEY]: nonce });
  return nonce;
}

/**
 * 지금 이 창의 프로필을 찾는다.
 *
 * 난수를 자기 `chrome.storage.local` 에 쓰면 같은 값이 곧바로 이 프로필의
 * WAL 에 나타난다. 그 값을 가진 프로필이 자기 자신이다. nonce 는 지우지 않는다
 * (다음 실행에서 새 값으로 덮어쓴다).
 *
 * @param {Array<ProfileDirInfo|string>} profileDirs {@link listProfileDirs} 결과
 * @param {string} [nonce] 이미 {@link writeNonce} 로 남겨 둔 표식.
 *   주면 여기서 다시 쓰지 않는다. 디렉터리 목록을 훑기 **전에** 표식을 남겨야
 *   갓 설치된 프로필에서도 첫 시도에 자기를 찾는다({@link writeNonce} 설명 참고).
 * @param {Array<{code: string, params: string[]}>} [warnings] 읽지 못한 프로필을
 *   여기에 적어 둔다. 못 찾은 이유가 "없어서"가 아니라 "못 읽어서"일 수 있다는
 *   사실이 사용자에게 닿아야 한다.
 * @returns {Promise<{profileDir: string, nonce: string}|null>} 못 찾으면 null
 */
export async function locateSelf(profileDirs, nonce, warnings) {
  const dirs = (profileDirs ?? []).map((p) => (typeof p === 'string' ? p : p.profileDir));
  if (dirs.length === 0) return null;

  const mark = typeof nonce === 'string' && nonce !== '' ? nonce : await writeNonce();

  const selfId = globalThis.chrome?.runtime?.id;
  if (!selfId) {
    throw codedError('chrome.runtime.id is unavailable; this is not an extension context', 'warnNoExtensionContext');
  }

  const hits = await Promise.all(dirs.map((dir) => storageHasNonce(dir, selfId, mark)));
  const i = hits.findIndex((h) => h.match);
  if (i >= 0) return { profileDir: dirs[i], nonce: mark };

  if (Array.isArray(warnings)) {
    hits.forEach((h, k) => {
      if (!h.unreadable) return;
      warnings.push({ code: 'warnProfileUnreadable', params: [dirs[k]] });
      // 어느 파일을 왜 못 읽었는지까지 올려 보낸다. "찾지 못했습니다"만 남기고
      // 이유를 버리면 사용자가 할 수 있는 일이 없다.
      for (const n of h.notes ?? []) warnings.push({ code: 'warnParserNote', params: [n.dir, n.note] });
    });
  }
  return null;
}

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
  findChildDir,
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
 * @param {string} profileDir
 * @returns {Promise<boolean>}
 */
async function isProfileDir(profileDir) {
  const entries = await listDirOrNull(profileDir);
  if (!entries) return false;
  return entries.some(
    (e) => (!e.isDir && e.name === 'Preferences') || (e.isDir && e.name === 'Local Extension Settings'),
  );
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
 * @param {'mac'|'win'|'linux'} [platform] 생략하면 {@link detectPlatform} 으로 판정
 * @returns {Promise<ProfileDirInfo[]>}
 */
export async function listProfileDirs(platform) {
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

  const keep = await Promise.all(candidates.map((c) => isProfileDir(c.profileDir)));
  const found = candidates.filter((_c, i) => keep[i]);

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
 * 한 프로필의 우리 확장 저장소에 `nonce` 가 들어 있는지 본다.
 *
 * `chrome.storage.local` 은 값을 JSON 으로 저장하므로 디스크에는 따옴표까지 붙어
 * 있다. 혹시 모르니 날값 비교도 함께 한다.
 *
 * @param {string} profileDir 프로필 디렉터리
 * @param {string} selfId 이 확장의 id
 * @param {string} nonce
 * @returns {Promise<boolean>}
 */
async function storageHasNonce(profileDir, selfId, nonce) {
  // 우리 확장이 그 프로필에 깔려 있는지부터 목록으로 확인한다. 없는 경로를
  // 그냥 열면 콘솔에 `net::ERR_FILE_NOT_FOUND` 가 남는다.
  const settingsRoot = await findChildDir(profileDir, 'Local Extension Settings');
  if (settingsRoot === null) return false;
  const storageDir = await findChildDir(settingsRoot, selfId);
  if (storageDir === null) return false;

  try {
    const entries = await listDirOrNull(storageDir);
    const db = await readLevelDbFrom(makeSource(storageDir, entries ? { entries } : {}));
    const raw = db.entries.get(NONCE_KEY);
    if (raw === undefined) return false;
    const text = decodeUtf8(raw);
    if (text === nonce) return true;
    try {
      return JSON.parse(text) === nonce;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * 지금 이 창의 프로필을 찾는다.
 *
 * 난수를 자기 `chrome.storage.local` 에 쓰면 같은 값이 곧바로 이 프로필의
 * WAL 에 나타난다. 그 값을 가진 프로필이 자기 자신이다. nonce 는 지우지 않는다
 * (다음 실행에서 새 값으로 덮어쓴다).
 *
 * @param {Array<ProfileDirInfo|string>} profileDirs {@link listProfileDirs} 결과
 * @returns {Promise<{profileDir: string, nonce: string}|null>} 못 찾으면 null
 */
export async function locateSelf(profileDirs) {
  const dirs = (profileDirs ?? []).map((p) => (typeof p === 'string' ? p : p.profileDir));
  if (dirs.length === 0) return null;

  const storage = globalThis.chrome?.storage?.local;
  const selfId = globalThis.chrome?.runtime?.id;
  if (!storage || !selfId) {
    throw new Error('chrome.storage.local 을 쓸 수 없습니다. manifest.json 의 "permissions" 에 "storage" 가 있어야 합니다.');
  }

  const nonce = randomUuid();
  await storage.set({ [NONCE_KEY]: nonce });

  const hits = await Promise.all(dirs.map((dir) => storageHasNonce(dir, selfId, nonce)));
  const i = hits.indexOf(true);
  return i < 0 ? null : { profileDir: dirs[i], nonce };
}

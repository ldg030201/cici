/**
 * Browser discovery for Chromium-based browsers: well-known user-data
 * directories per platform, profile enumeration, and per-profile extension
 * lookup.
 *
 * Everything in this module is strictly read-only. Files are only ever
 * touched through fs.readFile / fs.readdir / fs.stat so it is safe to run
 * while the browser is open.
 *
 * @module browsers
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {object} BrowserInfo
 * @property {string} id    Stable machine id (e.g. "chrome", "brave").
 * @property {string} name  Human readable name.
 */

/**
 * @typedef {object} UserDataDirCandidate
 * @property {string} browser      Browser id from {@link BROWSERS}.
 * @property {string} browserName  Human readable browser name.
 * @property {string} userDataDir  Absolute path of the browser's user-data dir.
 */

/**
 * @typedef {object} ProfileInfo
 * @property {string} dir            Absolute path of the profile directory.
 * @property {string} dirName        Directory name ("Default", "Profile 3", ...).
 * @property {string|null} name      Profile display name.
 * @property {string|null} email     Signed-in account (Local State "user_name").
 * @property {string|null} gaiaName  Account display name (Local State "gaia_name").
 * @property {string[]} warnings     Non-fatal problems met while reading.
 */

/**
 * @typedef {object} ExtensionInfo
 * @property {string} id                Extension id that was found.
 * @property {string|null} version      Highest installed version, or null.
 * @property {string|null} storageDir   "<profile>/Local Extension Settings/<id>" if it exists.
 * @property {boolean} installed        Always true for a non-null result.
 */

/**
 * Browsers that can install Chrome Web Store extensions, in display order.
 * @type {ReadonlyArray<BrowserInfo>}
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

/** Profile directories that never hold a real user profile. */
const EXCLUDED_PROFILE_DIRS = new Set(['System Profile', 'Guest Profile']);

/**
 * Per-platform user-data-dir layouts, as path segments relative to a base.
 * On Windows `base` selects LOCALAPPDATA ("local") or APPDATA ("roaming").
 */
const LAYOUTS = {
  darwin: [
    ['chrome', ['Google', 'Chrome']],
    ['chrome-beta', ['Google', 'Chrome Beta']],
    ['chrome-dev', ['Google', 'Chrome Dev']],
    ['chrome-canary', ['Google', 'Chrome Canary']],
    ['chromium', ['Chromium']],
    ['brave', ['BraveSoftware', 'Brave-Browser']],
    ['edge', ['Microsoft Edge']],
    ['arc', ['Arc', 'User Data']],
    ['vivaldi', ['Vivaldi']],
    ['opera', ['com.operasoftware.Opera']],
  ],
  win32: [
    ['chrome', 'local', ['Google', 'Chrome', 'User Data']],
    ['chrome-beta', 'local', ['Google', 'Chrome Beta', 'User Data']],
    ['chrome-dev', 'local', ['Google', 'Chrome Dev', 'User Data']],
    ['chrome-canary', 'local', ['Google', 'Chrome SxS', 'User Data']],
    ['chromium', 'local', ['Chromium', 'User Data']],
    ['brave', 'local', ['BraveSoftware', 'Brave-Browser', 'User Data']],
    ['edge', 'local', ['Microsoft', 'Edge', 'User Data']],
    ['vivaldi', 'local', ['Vivaldi', 'User Data']],
    ['opera', 'roaming', ['Opera Software', 'Opera Stable']],
  ],
  linux: [
    ['chrome', ['google-chrome']],
    ['chrome-beta', ['google-chrome-beta']],
    ['chrome-dev', ['google-chrome-unstable']],
    ['chromium', ['chromium']],
    ['brave', ['BraveSoftware', 'Brave-Browser']],
    ['edge', ['microsoft-edge']],
    ['vivaldi', ['vivaldi']],
    ['opera', ['opera']],
  ],
};

/**
 * @param {string} id
 * @returns {string}
 */
function browserName(id) {
  const found = BROWSERS.find((b) => b.id === id);
  return found ? found.name : id;
}

/**
 * Well-known user-data directories for every supported browser on a platform.
 * Pure: never touches the filesystem, so it can be exercised for any platform
 * from any platform.
 *
 * @param {object} [options]
 * @param {string} [options.platform]  process.platform-style string ("darwin", "win32", "linux", ...).
 * @param {string} [options.home]      Home directory (defaults to os.homedir()).
 * @param {object} [options.env]       Environment (defaults to process.env).
 * @returns {UserDataDirCandidate[]}
 */
export function candidateUserDataDirs(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();

  if (platform === 'darwin') {
    const p = path.posix;
    const base = p.join(home, 'Library', 'Application Support');
    return LAYOUTS.darwin.map(([id, segments]) => ({
      browser: id,
      browserName: browserName(id),
      userDataDir: p.join(base, ...segments),
    }));
  }

  if (platform === 'win32') {
    const p = path.win32;
    const local = nonEmptyString(env.LOCALAPPDATA) ?? p.join(home, 'AppData', 'Local');
    const roaming = nonEmptyString(env.APPDATA) ?? p.join(home, 'AppData', 'Roaming');
    return LAYOUTS.win32.map(([id, base, segments]) => ({
      browser: id,
      browserName: browserName(id),
      userDataDir: p.join(base === 'roaming' ? roaming : local, ...segments),
    }));
  }

  // Linux and other unixes (FreeBSD, ...): XDG base directory spec.
  const p = path.posix;
  const config = nonEmptyString(env.XDG_CONFIG_HOME) ?? p.join(home, '.config');
  return LAYOUTS.linux.map(([id, segments]) => ({
    browser: id,
    browserName: browserName(id),
    userDataDir: p.join(config, ...segments),
  }));
}

/**
 * {@link candidateUserDataDirs} filtered down to directories that exist.
 *
 * @param {{ platform?: string, home?: string, env?: object }} [options]
 * @returns {Promise<UserDataDirCandidate[]>}
 */
export async function discoverBrowsers(options = {}) {
  const candidates = candidateUserDataDirs(options);
  const exists = await Promise.all(candidates.map((c) => isDirectory(c.userDataDir)));
  return candidates.filter((_, i) => exists[i]);
}

/**
 * Enumerate the profiles of a user-data directory.
 *
 * Primary source is "<userDataDir>/Local State" (profile.info_cache). Any
 * subdirectory holding a "Preferences" file that the cache does not mention
 * is added from a directory scan, with its name read from
 * Preferences.profile.name. "System Profile" and "Guest Profile" are skipped.
 *
 * Throws only if `userDataDir` itself cannot be listed; a missing or corrupt
 * Local State produces per-profile warnings instead.
 *
 * @param {string} userDataDir
 * @returns {Promise<ProfileInfo[]>}
 */
export async function listProfiles(userDataDir) {
  /** @type {ProfileInfo[]} */
  const profiles = [];
  const seen = new Set();
  /** Warnings about Local State itself; attached to scan-discovered profiles. */
  const localStateWarnings = [];
  /** @type {Record<string, any>|null} */
  let infoCache = null;

  const localStatePath = path.join(userDataDir, 'Local State');
  try {
    const text = await fs.readFile(localStatePath, 'utf8');
    const json = JSON.parse(text);
    const cache = json?.profile?.info_cache;
    if (isPlainObject(cache)) {
      infoCache = cache;
    } else {
      localStateWarnings.push(`${localStatePath}: no profile.info_cache; using directory scan instead`);
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      localStateWarnings.push(`Local State not found (${localStatePath}); using directory scan instead`);
    } else {
      localStateWarnings.push(`Could not parse ${localStatePath} (${errorMessage(err)}); using directory scan instead`);
    }
  }

  if (infoCache) {
    for (const [dirName, rawInfo] of Object.entries(infoCache)) {
      if (EXCLUDED_PROFILE_DIRS.has(dirName) || !isPlainDirName(dirName)) continue;
      seen.add(dirName);
      const info = isPlainObject(rawInfo) ? rawInfo : {};
      const dir = path.join(userDataDir, dirName);
      const warnings = [];
      let name = nonEmptyString(info.name);
      if (!(await isDirectory(dir))) {
        warnings.push(`profile directory listed in Local State but not found: ${dir}`);
      } else if (name === null) {
        name = await readPreferencesName(dir);
      }
      profiles.push({
        dir,
        dirName,
        name,
        email: nonEmptyString(info.user_name),
        gaiaName: nonEmptyString(info.gaia_name),
        warnings,
      });
    }
  }

  // Directory scan for profiles missing from info_cache (or all of them when
  // Local State is unusable).
  let dirents;
  try {
    dirents = await fs.readdir(userDataDir, { withFileTypes: true });
  } catch (err) {
    const e = new Error(`Cannot read user data dir ${userDataDir}: ${errorMessage(err)}`);
    if (err && err.code) e.code = err.code;
    throw e;
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const dirName = dirent.name;
    if (seen.has(dirName) || EXCLUDED_PROFILE_DIRS.has(dirName)) continue;
    const dir = path.join(userDataDir, dirName);
    if (!(await isFile(path.join(dir, 'Preferences')))) continue;
    seen.add(dirName);
    const warnings = [...localStateWarnings];
    if (infoCache) warnings.push(`profile not listed in Local State info_cache: ${dirName}`);
    profiles.push({
      dir,
      dirName,
      name: await readPreferencesName(dir),
      email: null,
      gaiaName: null,
      warnings,
    });
  }

  profiles.sort((a, b) => compareProfileDirNames(a.dirName, b.dirName));
  return profiles;
}

/**
 * Locate the first installed extension among `extensionIds` in a profile.
 *
 * An extension counts as installed when "<profile>/Extensions/<id>" or
 * "<profile>/Local Extension Settings/<id>" exists. The version is the highest
 * version directory under Extensions/<id> ("1.0.90_0" → "1.0.90").
 *
 * @param {string} profileDir
 * @param {string[]} extensionIds  Candidate ids, in priority order.
 * @returns {Promise<ExtensionInfo|null>}
 */
export async function findExtension(profileDir, extensionIds) {
  for (const id of extensionIds) {
    if (typeof id !== 'string' || !isPlainDirName(id)) continue;
    const storageDir = path.join(profileDir, 'Local Extension Settings', id);
    const extensionDir = path.join(profileDir, 'Extensions', id);
    const [hasStorage, hasExtensionDir] = await Promise.all([
      isDirectory(storageDir),
      isDirectory(extensionDir),
    ]);
    if (!hasStorage && !hasExtensionDir) continue;
    const version = hasExtensionDir ? await highestVersionDir(extensionDir) : null;
    return {
      id,
      version,
      storageDir: hasStorage ? storageDir : null,
      installed: true,
    };
  }
  return null;
}

/**
 * Order profile directory names the way Chrome's picker does: "Default"
 * first, then "Profile N" numerically, then anything else alphabetically.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareProfileDirNames(a, b) {
  const ra = profileRank(a);
  const rb = profileRank(b);
  if (ra.group !== rb.group) return ra.group - rb.group;
  if (ra.group === 1) return ra.n - rb.n;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Parse a Chrome extension version directory name ("1.0.90_0" → "1.0.90").
 * Returns null when the name does not look like a version.
 *
 * @param {string} dirName
 * @returns {string|null}
 */
export function parseVersionDirName(dirName) {
  const m = /^(\d+(?:\.\d+)*)(?:_\d+)?$/.exec(dirName);
  return m ? m[1] : null;
}

/**
 * Compare dotted numeric versions ("1.0.9" < "1.0.10"). Missing parts count
 * as 0, so "1.0" equals "1.0.0".
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(toInt);
  const pb = String(b).split('.').map(toInt);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// internals

/**
 * @param {string} dirName
 * @returns {{ group: number, n: number }}
 */
function profileRank(dirName) {
  if (dirName === 'Default') return { group: 0, n: 0 };
  const m = /^Profile (\d+)$/.exec(dirName);
  if (m) return { group: 1, n: Number(m[1]) };
  return { group: 2, n: 0 };
}

/**
 * Highest version directory under an Extensions/<id> directory.
 * @param {string} extensionDir
 * @returns {Promise<string|null>}
 */
async function highestVersionDir(extensionDir) {
  let dirents;
  try {
    dirents = await fs.readdir(extensionDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const version = parseVersionDirName(dirent.name);
    if (version === null) continue;
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/**
 * Preferences.profile.name of a profile directory, or null.
 * @param {string} profileDir
 * @returns {Promise<string|null>}
 */
async function readPreferencesName(profileDir) {
  try {
    const text = await fs.readFile(path.join(profileDir, 'Preferences'), 'utf8');
    const json = JSON.parse(text);
    return nonEmptyString(json?.profile?.name);
  } catch {
    return null;
  }
}

/** @param {string} p */
async function isDirectory(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} p */
async function isFile(p) {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * True for names that are a single path component (no separators, not
 * "." / ".."), so untrusted JSON can never escape the user-data dir.
 * @param {string} name
 */
function isPlainDirName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

/** @param {unknown} v */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** @param {string} s */
function toInt(s) {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

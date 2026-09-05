/**
 * cici - Claude in Chrome ID.
 *
 * Public API. `scan()` returns one row per Chromium browser profile with the
 * Claude in Chrome extension's `bridgeDeviceId`, read straight from the
 * profile's "Local Extension Settings" LevelDB files (read-only; the browser
 * is never touched, nothing is written).
 *
 * @module cici
 */
import os from 'node:os';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

import {
  BROWSERS,
  candidateUserDataDirs,
  compareProfileDirNames,
  discoverBrowsers,
  errorMessage,
  kindError,
  listProfiles,
  findExtension,
  findExtensions,
  statKind,
} from './browsers.js';
import {
  CLAUDE_EXTENSION_IDS,
  BRIDGE_DEVICE_ID_KEY,
  BRIDGE_DISPLAY_NAME_KEY,
  readBridgeInfo,
} from './claude.js';
import { readLevelDb } from './leveldb.js';

export {
  BROWSERS,
  candidateUserDataDirs,
  discoverBrowsers,
  listProfiles,
  findExtension,
  findExtensions,
  CLAUDE_EXTENSION_IDS,
  BRIDGE_DEVICE_ID_KEY,
  BRIDGE_DISPLAY_NAME_KEY,
  readBridgeInfo,
  readLevelDb,
};

/**
 * One browser profile.
 *
 * @typedef {object} Row
 * @property {string} browser               Browser id from {@link BROWSERS}, or "custom" for --user-data-dir.
 * @property {string} browserName           Human-readable browser name ("Chrome", "Brave", "Custom", ...).
 * @property {string} userDataDir           Browser user-data directory containing the profile.
 * @property {string} profileDir            Absolute profile directory.
 * @property {string} profileDirName        Profile directory name ("Default", "Profile 3", ...).
 * @property {string|null} profileName      Profile name shown by the browser.
 * @property {string|null} email            Signed-in account email, if any.
 * @property {string|null} gaiaName         Signed-in account display name, if any.
 * @property {string|null} extensionId      Installed Claude extension id, or null when not installed.
 * @property {string|null} extensionVersion Installed extension version (from the Extensions dir), or null.
 * @property {string|null} deviceId         bridgeDeviceId — the id Claude Code's browser picker shows.
 * @property {string|null} displayName      bridgeDisplayName — the name typed when pairing, if any.
 * @property {boolean} readFailed           A data file could not be read, so a null `deviceId`
 *   means "unknown", not "not paired". Callers that render "not paired" must check this first.
 * @property {string[]} warnings            Non-fatal problems met while reading this profile.
 */

/**
 * @typedef {object} ScanOptions
 * @property {string[]} [userDataDirs]       Scan only these user-data directories (browser = "custom").
 * @property {string[]} [extensionIds]       Extension ids to look for; defaults to {@link CLAUDE_EXTENSION_IDS}.
 * @property {boolean} [includeUninstalled]  Keep rows for profiles where the extension is not installed.
 * @property {string} [platform]             Override process.platform for browser discovery.
 * @property {string} [home]                 Override os.homedir() for browser discovery.
 * @property {object} [env]                  Override process.env for browser discovery.
 */

/**
 * A user-data directory that was considered by a scan.
 *
 * @typedef {object} SearchedDir
 * @property {string} browser
 * @property {string} browserName
 * @property {string} userDataDir
 * @property {boolean} exists        Whether the directory exists (only existing ones are scanned).
 * @property {number} profileCount   Number of profiles found inside it.
 */

/**
 * @typedef {object} ScanReport
 * @property {Row[]} rows
 * @property {SearchedDir[]} searched  Every user-data directory that was considered, in scan order.
 * @property {string[]} warnings       Warnings that are not tied to a single profile.
 */

const CUSTOM_BROWSER = Object.freeze({ id: 'custom', name: 'Custom' });

/**
 * A key that identifies a directory even when it is spelled differently.
 * fs.realpath() resolves symlinks and, on macOS and Windows, restores the real
 * case, so "…/Google/Chrome" and "…/google/chrome" collapse into one scan
 * instead of listing every bridgeDeviceId twice. Paths that do not exist (or
 * that we may not resolve) keep their own spelling.
 *
 * @param {string} absPath
 * @returns {Promise<string>}
 */
async function canonicalKey(absPath) {
  try {
    return await realpath(absPath);
  } catch {
    return absPath;
  }
}

/**
 * Case-folded lookup key for the well-known-directory map. macOS and Windows
 * filesystems are case-insensitive, so a lowercase argument still names the
 * browser instead of falling back to "Custom".
 *
 * @param {string} p
 * @param {string} platform
 * @returns {string}
 */
function foldKey(p, platform) {
  return platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p;
}

/**
 * Expand a leading "~" (shells do this, but a quoted "~/..." reaches us verbatim)
 * and make the path absolute.
 *
 * @param {string} dir
 * @param {string} home
 * @returns {string}
 */
function normalizeDir(dir, home) {
  let d = String(dir);
  if (d === '~') d = home;
  else if (d.startsWith('~/') || d.startsWith('~\\')) d = path.join(home, d.slice(2));
  return path.resolve(d);
}

/**
 * Users sometimes pass a *profile* directory ("…/Chrome/Default") instead of its
 * parent user-data directory. Detect that (a "Preferences" file but no
 * "Local State") and scan just that profile of the parent directory.
 *
 * @param {string} dir absolute directory
 * @returns {Promise<{ userDataDir: string, onlyProfile: string|null }>}
 */
async function resolveUserDataDir(dir) {
  const hasLocalState = (await statKind(path.join(dir, 'Local State'))) === 'file';
  const hasPreferences = (await statKind(path.join(dir, 'Preferences'))) === 'file';
  if (!hasLocalState && hasPreferences) {
    return { userDataDir: path.dirname(dir), onlyProfile: path.basename(dir) };
  }
  return { userDataDir: dir, onlyProfile: null };
}

/**
 * Label the user-data directories that were named explicitly. A directory that
 * is one of the well-known locations gets that browser's name; the rest stay
 * "Custom", disambiguated by directory name when several were given so two
 * "Default" rows can be told apart.
 *
 * @param {string[]} dirs absolute, de-duplicated
 * @param {Map<string, { browser: string, browserName: string }>} known well-known dirs by path
 * @param {string} platform process.platform-style string, for case-folded lookups
 * @returns {Map<string, { browser: string, browserName: string }>}
 */
function labelExplicitDirs(dirs, known, platform) {
  /** @type {Map<string, number>} */
  const basenameCount = new Map();
  for (const dir of dirs) {
    if (lookupKnown(known, dir, platform)) continue;
    const base = path.basename(dir) || dir;
    basenameCount.set(base, (basenameCount.get(base) ?? 0) + 1);
  }

  /** @type {Map<string, { browser: string, browserName: string }>} */
  const labels = new Map();
  for (const dir of dirs) {
    const match = lookupKnown(known, dir, platform);
    if (match) {
      labels.set(dir, { browser: match.browser, browserName: match.browserName });
      continue;
    }
    let browserName = CUSTOM_BROWSER.name;
    if (dirs.length > 1) {
      const base = path.basename(dir) || dir;
      browserName = `${CUSTOM_BROWSER.name} (${basenameCount.get(base) > 1 ? dir : base})`;
    }
    labels.set(dir, { browser: CUSTOM_BROWSER.id, browserName });
  }
  return labels;
}

/**
 * Look a directory up in the well-known map, tolerating a different spelling of
 * the same case-insensitive path.
 *
 * @param {Map<string, { browser: string, browserName: string }>} known
 * @param {string} dir
 * @param {string} platform
 * @returns {{ browser: string, browserName: string }|undefined}
 */
function lookupKnown(known, dir, platform) {
  return known.get(dir) ?? known.get(foldKey(dir, platform));
}

/** Display position of every known browser id, for the final sort. */
const BROWSER_ORDER = new Map(BROWSERS.map((b, i) => [b.id, i]));

/**
 * Display position of a browser id; unknown ids ("custom") sort last.
 *
 * @param {string} browser
 * @returns {number}
 */
function browserRank(browser) {
  return BROWSER_ORDER.get(browser) ?? BROWSERS.length;
}

/**
 * Build the row for one profile, or null when the extension is not installed
 * and uninstalled profiles were not requested.
 *
 * @param {{ browser: string, browserName: string, userDataDir: string }} target
 * @param {{ dir: string, dirName: string, name?: string|null, email?: string|null, gaiaName?: string|null, warnings?: string[] }} profile
 * @param {string[]} extensionIds
 * @param {boolean} includeUninstalled
 * @returns {Promise<Row|null>}
 */
async function buildRow(target, profile, extensionIds, includeUninstalled) {
  const warnings = Array.isArray(profile.warnings) ? [...profile.warnings] : [];

  /** @type {import('./browsers.js').ExtensionInfo[]} */
  let matches = [];
  try {
    matches = await findExtensions(profile.dir, extensionIds);
  } catch (err) {
    warnings.push(`could not inspect extensions: ${errorMessage(err)}`);
  }
  const installed = matches.length > 0;
  if (!installed && !includeUninstalled) return null;

  // Several Claude builds can be installed side by side (the Web Store one and
  // an internal build). Having a storage directory does not make one "the
  // paired one" — a build that was installed but never paired has storage too.
  // So read every candidate's storage and keep the first that actually holds a
  // value; only fall back to the first readable one when none does. Stopping at
  // the first storage directory would report "not paired" while the bridge id
  // sits in the next candidate (the extension popup already picks this way).
  let extension = null;
  let bridge = { deviceId: null, displayName: null, readFailed: false, warnings: [] };
  // 후보 확장이 여럿일 수 있다. 그중 **하나라도** 못 읽었으면 "값이 없다" 고
  // 단정할 수 없다 — 못 읽은 쪽에 있었을 수 있기 때문이다.
  let readFailed = false;
  for (const m of matches) {
    if (m.storageDir === null) continue;
    let info;
    try {
      info = await readBridgeInfo(m.storageDir);
    } catch (err) {
      warnings.push(`could not read extension storage: ${errorMessage(err)}`);
      readFailed = true;
      continue;
    }
    if (info.readFailed) readFailed = true;
    if (info.deviceId !== null || info.displayName !== null) {
      extension = m;
      bridge = info;
      break;
    }
    if (extension === null) {
      extension = m;
      bridge = info;
    }
  }
  if (extension === null) {
    extension = matches[0] ?? null;
    if (installed) warnings.push('extension is installed but has no storage directory yet (never paired?)');
  }
  if (Array.isArray(bridge.warnings)) warnings.push(...bridge.warnings);

  return {
    browser: target.browser,
    browserName: target.browserName,
    userDataDir: target.userDataDir,
    profileDir: profile.dir,
    profileDirName: profile.dirName,
    profileName: profile.name ?? null,
    email: profile.email ?? null,
    gaiaName: profile.gaiaName ?? null,
    extensionId: installed ? extension.id : null,
    extensionVersion: extension?.version ?? null,
    deviceId: bridge.deviceId ?? null,
    displayName: bridge.displayName ?? null,
    readFailed: readFailed || Boolean(bridge.readFailed),
    warnings,
  };
}

/**
 * Like {@link scan}, but also reports which user-data directories were
 * considered and any warnings that do not belong to a single profile. The CLI
 * uses this for its "nothing found — here is where I looked" hint.
 *
 * @param {ScanOptions} [options]
 * @returns {Promise<ScanReport>}
 */
export async function scanReport(options = {}) {
  const extensionIds =
    Array.isArray(options.extensionIds) && options.extensionIds.length > 0
      ? options.extensionIds
      : CLAUDE_EXTENSION_IDS;
  const includeUninstalled = Boolean(options.includeUninstalled);
  const discovery = { platform: options.platform, home: options.home, env: options.env };
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;

  /** @type {string[]} */
  const warnings = [];
  /** @type {SearchedDir[]} */
  const searched = [];

  /**
   * Well-known user-data directories by absolute path, for labelling.
   * @type {Map<string, { browser: string, browserName: string }>}
   */
  const known = new Map();
  /** Directories the caller named explicitly: always scanned, missing ones warn. */
  const explicitDirs = new Set();

  if (Array.isArray(options.userDataDirs) && options.userDataDirs.length > 0) {
    // The same directory can arrive twice ("X" and "X/", or "X" and its
    // profile "X/Default"); scanning it once keeps rows unique.
    const dirs = [];
    const seenDirs = new Set();
    for (const dir of options.userDataDirs) {
      const abs = normalizeDir(dir, home);
      const key = await canonicalKey(abs);
      if (seenDirs.has(key)) continue;
      seenDirs.add(key);
      dirs.push(abs);
    }
    for (const candidate of candidateUserDataDirs(discovery)) {
      known.set(candidate.userDataDir, candidate);
      const folded = foldKey(candidate.userDataDir, platform);
      if (!known.has(folded)) known.set(folded, candidate);
    }
    const labels = labelExplicitDirs(dirs, known, platform);
    for (const dir of dirs) {
      explicitDirs.add(dir);
      searched.push({ ...labels.get(dir), userDataDir: dir, exists: false, profileCount: 0 });
    }
  } else {
    const found = new Set((await discoverBrowsers(discovery)).map((b) => b.userDataDir));
    for (const candidate of candidateUserDataDirs(discovery)) {
      searched.push({ ...candidate, exists: found.has(candidate.userDataDir), profileCount: 0 });
    }
  }

  /** @type {Array<{ row: Row, order: number }>} */
  const collected = [];
  /** Profile directories already collected, so overlapping arguments cannot duplicate a row. */
  const seenProfileDirs = new Set();

  for (const [order, entry] of searched.entries()) {
    if (explicitDirs.has(entry.userDataDir)) {
      const kind = await statKind(entry.userDataDir);
      // A directory we may not stat counts as present, the way browsers.js
      // treats one: the scan below then reports the real reason (EACCES, ...)
      // instead of an unreadable directory reading "directory not found".
      entry.exists = kind === 'dir' || kindError(kind) !== null;
      if (!entry.exists) {
        warnings.push(`${entry.userDataDir}: directory not found`);
        continue;
      }
    } else if (!entry.exists) {
      continue;
    }

    let userDataDir = entry.userDataDir;
    let profiles;
    try {
      const resolved = await resolveUserDataDir(entry.userDataDir);
      userDataDir = resolved.userDataDir;
      profiles = await listProfiles(userDataDir);
      if (!Array.isArray(profiles)) profiles = [];
      if (resolved.onlyProfile !== null) {
        const only = profiles.filter((p) => p.dirName === resolved.onlyProfile);
        profiles = only.length > 0
          ? only
          : [{ dir: entry.userDataDir, dirName: resolved.onlyProfile, name: null, email: null, gaiaName: null, warnings: [] }];
      }
    } catch (err) {
      warnings.push(`${entry.userDataDir}: ${errorMessage(err)}`);
      continue;
    }
    entry.profileCount = profiles.length;

    const target = { browser: entry.browser, browserName: entry.browserName, userDataDir };
    const match = target.browser === CUSTOM_BROWSER.id ? lookupKnown(known, userDataDir, platform) : null;
    if (match) {
      // A profile directory of a well-known browser was given: name the browser.
      target.browser = match.browser;
      target.browserName = match.browserName;
    }
    for (const profile of profiles) {
      const profileKey = await canonicalKey(profile.dir);
      if (seenProfileDirs.has(profileKey)) continue;
      let row = null;
      try {
        row = await buildRow(target, profile, extensionIds, includeUninstalled);
      } catch (err) {
        warnings.push(`${profile.dir}: ${errorMessage(err)}`);
      }
      seenProfileDirs.add(profileKey);
      if (row) collected.push({ row, order });
    }
  }

  collected.sort(
    (a, b) =>
      browserRank(a.row.browser) - browserRank(b.row.browser) ||
      a.order - b.order ||
      compareProfileDirNames(a.row.profileDirName, b.row.profileDirName),
  );

  return { rows: collected.map((c) => c.row), searched, warnings };
}

/**
 * Find the Claude in Chrome bridgeDeviceId for every browser profile.
 *
 * @param {ScanOptions} [options]
 * @returns {Promise<Row[]>}
 */
export async function scan(options = {}) {
  return (await scanReport(options)).rows;
}

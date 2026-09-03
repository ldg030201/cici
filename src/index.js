/**
 * cici — Claude In Chrome Id.
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
import { stat } from 'node:fs/promises';

import {
  BROWSERS,
  candidateUserDataDirs,
  discoverBrowsers,
  listProfiles,
  findExtension,
} from './browsers.js';
import {
  CLAUDE_EXTENSION_IDS,
  BRIDGE_DEVICE_ID_KEY,
  BRIDGE_DISPLAY_NAME_KEY,
  readBridgeInfo,
} from './claude.js';
import { readLevelDb, decodeVarint32, parseInternalKey } from './leveldb.js';
import { uncompress } from './snappy.js';

export {
  BROWSERS,
  candidateUserDataDirs,
  discoverBrowsers,
  listProfiles,
  findExtension,
  CLAUDE_EXTENSION_IDS,
  BRIDGE_DEVICE_ID_KEY,
  BRIDGE_DISPLAY_NAME_KEY,
  readBridgeInfo,
  readLevelDb,
  decodeVarint32,
  parseInternalKey,
  uncompress,
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
 * @param {string} p
 * @returns {Promise<'dir'|'file'|'other'|null>}
 */
async function pathKind(p) {
  try {
    const s = await stat(p);
    if (s.isDirectory()) return 'dir';
    if (s.isFile()) return 'file';
    return 'other';
  } catch {
    return null;
  }
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
  const hasLocalState = (await pathKind(path.join(dir, 'Local State'))) === 'file';
  const hasPreferences = (await pathKind(path.join(dir, 'Preferences'))) === 'file';
  if (!hasLocalState && hasPreferences) {
    return { userDataDir: path.dirname(dir), onlyProfile: path.basename(dir) };
  }
  return { userDataDir: dir, onlyProfile: null };
}

/**
 * @param {string} browser
 * @returns {number}
 */
function browserRank(browser) {
  const index = BROWSERS.findIndex((b) => b.id === browser);
  return index === -1 ? BROWSERS.length : index;
}

/**
 * "Default" first, then "Profile N" by number, then anything else by name.
 *
 * @param {string} dirName
 * @returns {[number, number, string]}
 */
function profileRank(dirName) {
  if (dirName === 'Default') return [0, 0, ''];
  const match = /^Profile (\d+)$/.exec(dirName);
  if (match) return [1, Number(match[1]), ''];
  return [2, 0, dirName];
}

/**
 * @param {[number, number, string]} a
 * @param {[number, number, string]} b
 * @returns {number}
 */
function compareRank(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
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

  let extension = null;
  try {
    extension = await findExtension(profile.dir, extensionIds);
  } catch (err) {
    warnings.push(`could not inspect extensions: ${err && err.message ? err.message : String(err)}`);
  }
  const installed = Boolean(extension && extension.installed);
  if (!installed && !includeUninstalled) return null;

  let bridge = { deviceId: null, displayName: null, warnings: [] };
  if (extension && extension.storageDir) {
    try {
      bridge = await readBridgeInfo(extension.storageDir);
    } catch (err) {
      warnings.push(`could not read extension storage: ${err && err.message ? err.message : String(err)}`);
    }
  } else if (installed) {
    warnings.push('extension is installed but has no storage directory yet (never paired?)');
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
    extensionVersion: extension && extension.version ? extension.version : null,
    deviceId: bridge.deviceId ?? null,
    displayName: bridge.displayName ?? null,
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

  /** @type {string[]} */
  const warnings = [];
  /** @type {SearchedDir[]} */
  const searched = [];

  if (Array.isArray(options.userDataDirs) && options.userDataDirs.length > 0) {
    for (const dir of options.userDataDirs) {
      searched.push({
        browser: CUSTOM_BROWSER.id,
        browserName: CUSTOM_BROWSER.name,
        userDataDir: normalizeDir(dir, home),
        exists: false,
        profileCount: 0,
      });
    }
  } else {
    const found = new Set((await discoverBrowsers(discovery)).map((b) => b.userDataDir));
    for (const candidate of candidateUserDataDirs(discovery)) {
      searched.push({ ...candidate, exists: found.has(candidate.userDataDir), profileCount: 0 });
    }
  }

  /** @type {Array<{ row: Row, order: number, rank: [number, number, string] }>} */
  const collected = [];

  for (const [order, entry] of searched.entries()) {
    if (entry.browser === CUSTOM_BROWSER.id) {
      entry.exists = (await pathKind(entry.userDataDir)) === 'dir';
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
      warnings.push(`${entry.userDataDir}: ${err && err.message ? err.message : String(err)}`);
      continue;
    }
    entry.profileCount = profiles.length;

    const target = { browser: entry.browser, browserName: entry.browserName, userDataDir };
    for (const profile of profiles) {
      let row = null;
      try {
        row = await buildRow(target, profile, extensionIds, includeUninstalled);
      } catch (err) {
        warnings.push(`${profile.dir}: ${err && err.message ? err.message : String(err)}`);
      }
      if (row) collected.push({ row, order, rank: profileRank(row.profileDirName) });
    }
  }

  collected.sort(
    (a, b) =>
      browserRank(a.row.browser) - browserRank(b.row.browser) ||
      a.order - b.order ||
      compareRank(a.rank, b.rank),
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

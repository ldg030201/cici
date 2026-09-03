import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BROWSERS,
  candidateUserDataDirs,
  discoverBrowsers,
  listProfiles,
  findExtension,
  compareProfileDirNames,
  compareVersions,
  parseVersionDirName,
} from '../src/browsers.js';

const EXT_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const OTHER_ID = 'dihbgbndebgnbjfmelmegjepbnkhlgni';

/** @type {string[]} */
const tempDirs = [];

async function mkTemp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cici-browsers-test-'));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value), 'utf8');
}

after(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('BROWSERS', () => {
  test('lists the supported browsers in display order with unique ids', () => {
    const ids = BROWSERS.map((b) => b.id);
    assert.deepEqual(ids, [
      'chrome',
      'chrome-beta',
      'chrome-dev',
      'chrome-canary',
      'chromium',
      'brave',
      'edge',
      'arc',
      'vivaldi',
      'opera',
    ]);
    assert.equal(new Set(ids).size, ids.length);
    for (const b of BROWSERS) {
      assert.equal(typeof b.name, 'string');
      assert.ok(b.name.length > 0);
    }
  });
});

describe('candidateUserDataDirs', () => {
  test('macOS paths live under ~/Library/Application Support', () => {
    const rows = candidateUserDataDirs({ platform: 'darwin', home: '/Users/alice', env: {} });
    const byId = Object.fromEntries(rows.map((r) => [r.browser, r.userDataDir]));
    assert.deepEqual(rows.map((r) => r.browser), BROWSERS.map((b) => b.id));
    assert.equal(byId.chrome, '/Users/alice/Library/Application Support/Google/Chrome');
    assert.equal(byId['chrome-beta'], '/Users/alice/Library/Application Support/Google/Chrome Beta');
    assert.equal(byId['chrome-dev'], '/Users/alice/Library/Application Support/Google/Chrome Dev');
    assert.equal(byId['chrome-canary'], '/Users/alice/Library/Application Support/Google/Chrome Canary');
    assert.equal(byId.chromium, '/Users/alice/Library/Application Support/Chromium');
    assert.equal(byId.brave, '/Users/alice/Library/Application Support/BraveSoftware/Brave-Browser');
    assert.equal(byId.edge, '/Users/alice/Library/Application Support/Microsoft Edge');
    assert.equal(byId.arc, '/Users/alice/Library/Application Support/Arc/User Data');
    assert.equal(byId.vivaldi, '/Users/alice/Library/Application Support/Vivaldi');
    assert.equal(byId.opera, '/Users/alice/Library/Application Support/com.operasoftware.Opera');
    for (const r of rows) {
      assert.equal(r.browserName, BROWSERS.find((b) => b.id === r.browser).name);
    }
  });

  test('Windows paths come from LOCALAPPDATA / APPDATA and use backslashes', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
    };
    const rows = candidateUserDataDirs({ platform: 'win32', home: 'C:\\Users\\alice', env });
    const byId = Object.fromEntries(rows.map((r) => [r.browser, r.userDataDir]));
    assert.equal(byId.chrome, 'C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data');
    assert.equal(byId['chrome-beta'], 'C:\\Users\\alice\\AppData\\Local\\Google\\Chrome Beta\\User Data');
    assert.equal(byId['chrome-dev'], 'C:\\Users\\alice\\AppData\\Local\\Google\\Chrome Dev\\User Data');
    assert.equal(byId['chrome-canary'], 'C:\\Users\\alice\\AppData\\Local\\Google\\Chrome SxS\\User Data');
    assert.equal(byId.chromium, 'C:\\Users\\alice\\AppData\\Local\\Chromium\\User Data');
    assert.equal(byId.brave, 'C:\\Users\\alice\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data');
    assert.equal(byId.edge, 'C:\\Users\\alice\\AppData\\Local\\Microsoft\\Edge\\User Data');
    assert.equal(byId.vivaldi, 'C:\\Users\\alice\\AppData\\Local\\Vivaldi\\User Data');
    assert.equal(byId.opera, 'C:\\Users\\alice\\AppData\\Roaming\\Opera Software\\Opera Stable');
    assert.equal(byId.arc, undefined);
    for (const r of rows) assert.ok(!r.userDataDir.includes('/'), r.userDataDir);
  });

  test('Windows falls back to <home>\\AppData when the env vars are missing', () => {
    const rows = candidateUserDataDirs({ platform: 'win32', home: 'C:\\Users\\bob', env: {} });
    const byId = Object.fromEntries(rows.map((r) => [r.browser, r.userDataDir]));
    assert.equal(byId.chrome, 'C:\\Users\\bob\\AppData\\Local\\Google\\Chrome\\User Data');
    assert.equal(byId.opera, 'C:\\Users\\bob\\AppData\\Roaming\\Opera Software\\Opera Stable');
  });

  test('Linux paths live under ~/.config', () => {
    const rows = candidateUserDataDirs({ platform: 'linux', home: '/home/alice', env: {} });
    const byId = Object.fromEntries(rows.map((r) => [r.browser, r.userDataDir]));
    assert.equal(byId.chrome, '/home/alice/.config/google-chrome');
    assert.equal(byId['chrome-beta'], '/home/alice/.config/google-chrome-beta');
    assert.equal(byId['chrome-dev'], '/home/alice/.config/google-chrome-unstable');
    assert.equal(byId.chromium, '/home/alice/.config/chromium');
    assert.equal(byId.brave, '/home/alice/.config/BraveSoftware/Brave-Browser');
    assert.equal(byId.edge, '/home/alice/.config/microsoft-edge');
    assert.equal(byId.vivaldi, '/home/alice/.config/vivaldi');
    assert.equal(byId.opera, '/home/alice/.config/opera');
    assert.equal(byId['chrome-canary'], undefined);
    assert.equal(byId.arc, undefined);
  });

  test('Linux honors $XDG_CONFIG_HOME', () => {
    const rows = candidateUserDataDirs({
      platform: 'linux',
      home: '/home/alice',
      env: { XDG_CONFIG_HOME: '/xdg/config' },
    });
    const chrome = rows.find((r) => r.browser === 'chrome');
    assert.equal(chrome.userDataDir, '/xdg/config/google-chrome');
  });

  test('every candidate browser id is a known BROWSERS id, in BROWSERS order', () => {
    const order = BROWSERS.map((b) => b.id);
    for (const platform of ['darwin', 'win32', 'linux']) {
      const rows = candidateUserDataDirs({ platform, home: '/h', env: {} });
      const idx = rows.map((r) => order.indexOf(r.browser));
      assert.ok(idx.every((i) => i >= 0), `${platform}: unknown browser id`);
      assert.deepEqual(idx, [...idx].sort((a, b) => a - b), `${platform}: not in BROWSERS order`);
    }
  });

  test('defaults to the current platform and home when called without options', () => {
    const rows = candidateUserDataDirs();
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length > 0);
    // The expected root depends on the platform: everything but Windows lives
    // under the home directory, except on Linux where $XDG_CONFIG_HOME (which
    // containers and CI often point outside $HOME) wins.
    let root = null;
    if (process.platform === 'darwin') root = path.join(os.homedir(), 'Library', 'Application Support');
    else if (process.platform !== 'win32') root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    for (const r of rows) {
      assert.ok(path.isAbsolute(r.userDataDir), r.userDataDir);
      if (root !== null) assert.ok(r.userDataDir.startsWith(root), `${r.userDataDir} should start with ${root}`);
    }
  });
});

describe('discoverBrowsers', () => {
  test('keeps only user-data dirs that exist on disk', async () => {
    const home = await mkTemp();
    await fs.mkdir(path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'), { recursive: true });
    await fs.mkdir(path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'), { recursive: true });
    // A file, not a directory, must not count.
    await fs.mkdir(path.join(home, 'Library', 'Application Support', 'Google'), { recursive: true });
    await fs.writeFile(path.join(home, 'Library', 'Application Support', 'Chromium'), 'x');

    const found = await discoverBrowsers({ platform: 'darwin', home, env: {} });
    assert.deepEqual(found.map((r) => r.browser), ['chrome', 'brave']);
    assert.equal(found[0].browserName, 'Google Chrome');
    assert.equal(found[0].userDataDir, path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'));
  });

  test('returns an empty list when nothing is installed', async () => {
    const home = await mkTemp();
    const found = await discoverBrowsers({ platform: 'linux', home, env: {} });
    assert.deepEqual(found, []);
  });
});

describe('listProfiles', () => {
  /** @type {string} */
  let userDataDir;

  before(async () => {
    userDataDir = await mkTemp();
    await writeJson(path.join(userDataDir, 'Local State'), {
      profile: {
        info_cache: {
          'Profile 1': { name: 'Work', user_name: 'work@example.com', gaia_name: 'Work Person' },
          Default: { name: 'Personal', user_name: 'me@example.com', gaia_name: 'Me' },
          'Profile 10': { name: 'Ten', user_name: '', gaia_name: '' },
          'Guest Profile': { name: 'Guest' },
        },
      },
    });
    for (const dirName of ['Default', 'Profile 1', 'Profile 10']) {
      await writeJson(path.join(userDataDir, dirName, 'Preferences'), { profile: { name: `${dirName} prefs` } });
    }
    // Only discoverable by directory scan.
    await writeJson(path.join(userDataDir, 'Profile 2', 'Preferences'), { profile: { name: 'Scanned' } });
    // Must be excluded even though they hold a Preferences file.
    await writeJson(path.join(userDataDir, 'Guest Profile', 'Preferences'), { profile: { name: 'Guest' } });
    await writeJson(path.join(userDataDir, 'System Profile', 'Preferences'), { profile: { name: 'System' } });
    // Directories without Preferences are not profiles.
    await fs.mkdir(path.join(userDataDir, 'ShaderCache'), { recursive: true });
    // Files are ignored.
    await fs.writeFile(path.join(userDataDir, 'Last Version'), '1.2.3');
  });

  test('merges Local State info_cache with a directory scan, sorted Default first', async () => {
    const profiles = await listProfiles(userDataDir);
    assert.deepEqual(
      profiles.map((p) => p.dirName),
      ['Default', 'Profile 1', 'Profile 2', 'Profile 10'],
    );

    const byDir = Object.fromEntries(profiles.map((p) => [p.dirName, p]));
    assert.equal(byDir.Default.name, 'Personal');
    assert.equal(byDir.Default.email, 'me@example.com');
    assert.equal(byDir.Default.gaiaName, 'Me');
    assert.equal(byDir.Default.dir, path.join(userDataDir, 'Default'));
    assert.ok(path.isAbsolute(byDir.Default.dir));
    assert.deepEqual(byDir.Default.warnings, []);

    assert.equal(byDir['Profile 1'].name, 'Work');
    assert.equal(byDir['Profile 1'].email, 'work@example.com');

    // Empty strings become null.
    assert.equal(byDir['Profile 10'].email, null);
    assert.equal(byDir['Profile 10'].gaiaName, null);

    // Scan-only profile: name from Preferences, no account info, flagged.
    assert.equal(byDir['Profile 2'].name, 'Scanned');
    assert.equal(byDir['Profile 2'].email, null);
    assert.equal(byDir['Profile 2'].gaiaName, null);
    assert.ok(byDir['Profile 2'].warnings.some((w) => /info_cache/.test(w)));
  });

  test('excludes Guest Profile and System Profile', async () => {
    const profiles = await listProfiles(userDataDir);
    const names = profiles.map((p) => p.dirName);
    assert.ok(!names.includes('Guest Profile'));
    assert.ok(!names.includes('System Profile'));
    assert.ok(!names.includes('ShaderCache'));
  });

  test('falls back to a directory scan when Local State is missing', async () => {
    const dir = await mkTemp();
    await writeJson(path.join(dir, 'Profile 3', 'Preferences'), { profile: { name: 'Three' } });
    await writeJson(path.join(dir, 'Default', 'Preferences'), { profile: { name: 'Dflt' } });

    const profiles = await listProfiles(dir);
    assert.deepEqual(profiles.map((p) => p.dirName), ['Default', 'Profile 3']);
    assert.equal(profiles[0].name, 'Dflt');
    assert.equal(profiles[1].name, 'Three');
    for (const p of profiles) {
      assert.equal(p.email, null);
      assert.ok(p.warnings.some((w) => /Local State/.test(w)), JSON.stringify(p.warnings));
    }
  });

  test('falls back to a directory scan when Local State is not valid JSON', async () => {
    const dir = await mkTemp();
    await fs.writeFile(path.join(dir, 'Local State'), '{ this is not json', 'utf8');
    await writeJson(path.join(dir, 'Default', 'Preferences'), { profile: { name: 'Dflt' } });

    const profiles = await listProfiles(dir);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].dirName, 'Default');
    assert.equal(profiles[0].name, 'Dflt');
    assert.ok(profiles[0].warnings.some((w) => /Local State/.test(w)));
  });

  test('tolerates Local State without profile.info_cache', async () => {
    const dir = await mkTemp();
    await writeJson(path.join(dir, 'Local State'), { profile: {} });
    await writeJson(path.join(dir, 'Default', 'Preferences'), { profile: { name: 'Dflt' } });

    const profiles = await listProfiles(dir);
    assert.deepEqual(profiles.map((p) => p.dirName), ['Default']);
  });

  test('uses Preferences.profile.name when info_cache has no name', async () => {
    const dir = await mkTemp();
    await writeJson(path.join(dir, 'Local State'), {
      profile: { info_cache: { Default: { user_name: 'x@example.com' } } },
    });
    await writeJson(path.join(dir, 'Default', 'Preferences'), { profile: { name: 'From Prefs' } });

    const [p] = await listProfiles(dir);
    assert.equal(p.name, 'From Prefs');
    assert.equal(p.email, 'x@example.com');
  });

  test('unreadable Preferences yields a null name instead of an error', async () => {
    const dir = await mkTemp();
    await fs.mkdir(path.join(dir, 'Default'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Default', 'Preferences'), 'garbage', 'utf8');

    const profiles = await listProfiles(dir);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, null);
  });

  test('flags info_cache entries whose directory is gone', async () => {
    const dir = await mkTemp();
    await writeJson(path.join(dir, 'Local State'), {
      profile: { info_cache: { 'Profile 9': { name: 'Ghost' } } },
    });
    const profiles = await listProfiles(dir);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].dirName, 'Profile 9');
    assert.ok(profiles[0].warnings.some((w) => /not found/.test(w)));
  });

  test('ignores info_cache keys that are not plain directory names', async () => {
    const dir = await mkTemp();
    await writeJson(path.join(dir, 'Local State'), {
      profile: { info_cache: { '../escape': { name: 'Evil' }, 'a/b': { name: 'Nested' } } },
    });
    assert.deepEqual(await listProfiles(dir), []);
  });

  test('rejects a user data dir that does not exist', async () => {
    const dir = path.join(await mkTemp(), 'nope');
    await assert.rejects(() => listProfiles(dir), /nope/);
  });

  test('a symlinked profile directory is found by the directory scan', async (t) => {
    const dir = await mkTemp();
    const elsewhere = await mkTemp();
    await writeJson(path.join(elsewhere, 'linked', 'Preferences'), { profile: { name: 'Linked' } });
    await writeJson(path.join(dir, 'Default', 'Preferences'), { profile: { name: 'Dflt' } });
    await writeJson(path.join(dir, 'Local State'), {
      profile: { info_cache: { Default: { name: 'Dflt' } } },
    });
    try {
      await fs.symlink(path.join(elsewhere, 'linked'), path.join(dir, 'Profile 1'), 'junction');
    } catch (err) {
      t.skip(`cannot create symlinks here: ${err.message}`);
      return;
    }

    const profiles = await listProfiles(dir);
    assert.deepEqual(profiles.map((p) => p.dirName), ['Default', 'Profile 1']);
    assert.equal(profiles[1].name, 'Linked');
  });
});

describe('compareProfileDirNames', () => {
  test('orders Default, then Profile N numerically, then the rest', () => {
    const names = ['Profile 10', 'zzz', 'Profile 2', 'Default', 'Profile 1', 'aaa'];
    names.sort(compareProfileDirNames);
    assert.deepEqual(names, ['Default', 'Profile 1', 'Profile 2', 'Profile 10', 'aaa', 'zzz']);
  });
});

describe('findExtension', () => {
  test('picks the highest version directory, comparing numerically', async () => {
    const profileDir = await mkTemp();
    for (const v of ['1.0.9_0', '1.0.10_0', '1.0.2_1', 'README']) {
      await fs.mkdir(path.join(profileDir, 'Extensions', EXT_ID, v), { recursive: true });
    }
    await fs.writeFile(path.join(profileDir, 'Extensions', EXT_ID, '1.0.9_0', 'manifest.json'), '{}');
    await fs.writeFile(path.join(profileDir, 'Extensions', EXT_ID, '2.0.0_0'), 'a file, not a version dir');
    await fs.mkdir(path.join(profileDir, 'Local Extension Settings', EXT_ID), { recursive: true });

    const ext = await findExtension(profileDir, [EXT_ID]);
    assert.deepEqual(ext, {
      id: EXT_ID,
      version: '1.0.10',
      storageDir: path.join(profileDir, 'Local Extension Settings', EXT_ID),
      installed: true,
    });
  });

  test('returns null when none of the ids is installed', async () => {
    const profileDir = await mkTemp();
    await fs.mkdir(path.join(profileDir, 'Extensions'), { recursive: true });
    assert.equal(await findExtension(profileDir, [EXT_ID, OTHER_ID]), null);
    assert.equal(await findExtension(profileDir, []), null);
  });

  test('returns null for a profile directory that does not exist', async () => {
    const profileDir = path.join(await mkTemp(), 'missing');
    assert.equal(await findExtension(profileDir, [EXT_ID]), null);
  });

  test('storage dir alone counts as installed (version null)', async () => {
    const profileDir = await mkTemp();
    await fs.mkdir(path.join(profileDir, 'Local Extension Settings', EXT_ID), { recursive: true });
    const ext = await findExtension(profileDir, [EXT_ID]);
    assert.deepEqual(ext, {
      id: EXT_ID,
      version: null,
      storageDir: path.join(profileDir, 'Local Extension Settings', EXT_ID),
      installed: true,
    });
  });

  test('Extensions dir alone counts as installed (storageDir null)', async () => {
    const profileDir = await mkTemp();
    await fs.mkdir(path.join(profileDir, 'Extensions', EXT_ID, '1.0.90_0'), { recursive: true });
    const ext = await findExtension(profileDir, [EXT_ID]);
    assert.deepEqual(ext, { id: EXT_ID, version: '1.0.90', storageDir: null, installed: true });
  });

  test('respects the order of extensionIds', async () => {
    const profileDir = await mkTemp();
    await fs.mkdir(path.join(profileDir, 'Extensions', EXT_ID, '1.0.1_0'), { recursive: true });
    await fs.mkdir(path.join(profileDir, 'Extensions', OTHER_ID, '9.9.9_0'), { recursive: true });

    assert.equal((await findExtension(profileDir, [EXT_ID, OTHER_ID])).id, EXT_ID);
    assert.equal((await findExtension(profileDir, [OTHER_ID, EXT_ID])).id, OTHER_ID);
  });

  test('skips ids that are not installed and continues to the next', async () => {
    const profileDir = await mkTemp();
    await fs.mkdir(path.join(profileDir, 'Local Extension Settings', OTHER_ID), { recursive: true });
    const ext = await findExtension(profileDir, [EXT_ID, OTHER_ID]);
    assert.equal(ext.id, OTHER_ID);
    assert.equal(ext.version, null);
  });

  test('a symlinked version directory still counts as the highest version', async (t) => {
    const profileDir = await mkTemp();
    const elsewhere = await mkTemp();
    await fs.mkdir(path.join(elsewhere, '1.0.90_0'), { recursive: true });
    await fs.mkdir(path.join(profileDir, 'Extensions', EXT_ID, '1.0.80_0'), { recursive: true });
    try {
      await fs.symlink(path.join(elsewhere, '1.0.90_0'), path.join(profileDir, 'Extensions', EXT_ID, '1.0.90_0'), 'junction');
    } catch (err) {
      t.skip(`cannot create symlinks here: ${err.message}`);
      return;
    }
    assert.equal((await findExtension(profileDir, [EXT_ID])).version, '1.0.90');
  });

  test('a storage dir that is a file, not a directory, does not count', async () => {
    const profileDir = await mkTemp();
    await fs.mkdir(path.join(profileDir, 'Local Extension Settings'), { recursive: true });
    await fs.writeFile(path.join(profileDir, 'Local Extension Settings', EXT_ID), 'x');
    assert.equal(await findExtension(profileDir, [EXT_ID]), null);
  });

  test('an id with storage wins over an earlier id that has none', async () => {
    // The realistic mixed setup the three-id list exists for: the Web Store
    // build is installed but was never paired, an internal build holds the
    // bridgeDeviceId. Stopping at the first installed id would lose it.
    const profileDir = await mkTemp();
    await fs.mkdir(path.join(profileDir, 'Extensions', EXT_ID, '1.0.90_0'), { recursive: true });
    await fs.mkdir(path.join(profileDir, 'Local Extension Settings', OTHER_ID), { recursive: true });

    const ext = await findExtension(profileDir, [EXT_ID, OTHER_ID]);
    assert.equal(ext.id, OTHER_ID);
    assert.equal(ext.storageDir, path.join(profileDir, 'Local Extension Settings', OTHER_ID));
  });

  test('ids that are not a single path component can never escape the profile', async () => {
    const profileDir = await mkTemp();
    // Every traversal target below exists on disk, so only the guard can
    // explain a null result.
    await fs.mkdir(path.join(profileDir, 'Local Extension Settings'), { recursive: true });
    await fs.mkdir(path.join(profileDir, 'Extensions'), { recursive: true });
    await fs.mkdir(path.join(path.dirname(profileDir), 'Outside'), { recursive: true });

    for (const id of ['..', '../..', '../../Outside', 'a/b', 'a\\b', '.', '', 'x\u0000y']) {
      assert.equal(await findExtension(profileDir, [id]), null, `id ${JSON.stringify(id)} must be rejected`);
    }
  });

  test('a directory we may not stat is reported, not silently "not installed"', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      t.skip('needs POSIX permissions and a non-root user');
      return;
    }
    const profileDir = await mkTemp();
    const settings = path.join(profileDir, 'Local Extension Settings');
    await fs.mkdir(path.join(settings, EXT_ID), { recursive: true });
    await fs.chmod(settings, 0o000);
    try {
      const ext = await findExtension(profileDir, [EXT_ID]);
      assert.ok(ext, 'EACCES must not look like "the extension is not installed"');
      assert.equal(ext.storageDir, path.join(settings, EXT_ID), 'readBridgeInfo then reports the real reason');
    } finally {
      await fs.chmod(settings, 0o700);
    }
  });
});

describe('version helpers', () => {
  test('parseVersionDirName strips the _N suffix and rejects junk', () => {
    assert.equal(parseVersionDirName('1.0.90_0'), '1.0.90');
    assert.equal(parseVersionDirName('1.0.90'), '1.0.90');
    assert.equal(parseVersionDirName('12_3'), '12');
    assert.equal(parseVersionDirName('Temp'), null);
    assert.equal(parseVersionDirName('1.0.90_x'), null);
    assert.equal(parseVersionDirName(''), null);
  });

  test('compareVersions compares dotted parts numerically', () => {
    assert.ok(compareVersions('1.0.9', '1.0.10') < 0);
    assert.ok(compareVersions('1.0.10', '1.0.9') > 0);
    assert.equal(compareVersions('1.0', '1.0.0'), 0);
    assert.ok(compareVersions('1.0.0.1', '1.0') > 0);
    assert.ok(compareVersions('2', '1.99.99') > 0);
  });
});

describe('listProfiles under a permission error', () => {
  test('a profile directory that cannot be read is listed with a warning', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      t.skip('needs POSIX permissions and a non-root user');
      return;
    }
    const userDataDir = await mkTemp();
    const profileDir = path.join(userDataDir, 'Default');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(path.join(profileDir, 'Preferences'), '{}');
    await fs.chmod(profileDir, 0o000);
    try {
      const profiles = await listProfiles(userDataDir);
      // "I could not look" must never be reported the same way as "nothing here".
      assert.equal(profiles.length, 1, 'the profile must not vanish because of EACCES');
      assert.equal(profiles[0].dirName, 'Default');
      assert.ok(
        profiles[0].warnings.some((w) => /cannot stat/.test(w)),
        `the permission error must be reported: ${JSON.stringify(profiles[0].warnings)}`,
      );
    } finally {
      await fs.chmod(profileDir, 0o700);
    }
  });
});

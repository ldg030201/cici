// End-to-end tests for src/index.js (scan) and src/cli.js (main) against a
// fake Chromium user-data directory built with the LevelDB writer helper.
// Nothing here touches a real browser profile; every value is made up.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scan, scanReport, CLAUDE_EXTENSION_IDS } from '../src/index.js';
import { main } from '../src/cli.js';
import { writeSstFile, writeLogFile, writeManifest, TYPE_VALUE, BLOCK_SNAPPY } from './helpers/leveldb-writer.js';

const EXT_ID = CLAUDE_EXTENSION_IDS[0];
const OTHER_EXT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UUID = '11111111-2222-4333-8444-555555555555';
const OLD_NAME = 'Old name';
const NEW_NAME = '테스트 노트북';
const J = JSON.stringify;
const ANSI = /\x1b\[[0-9;]*m/;

/**
 * @param {string} file
 * @param {unknown} value
 */
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

/**
 * Build a fake user-data directory:
 *   Default     extension 1.0.90 installed and paired; bridgeDeviceId and an old
 *               bridgeDisplayName sit in a snappy compressed .ldb, the current
 *               bridgeDisplayName only exists in the .log (a later rename)
 *   Profile 1   extension 1.0.80 installed with a storage dir but no bridgeDeviceId
 *   Profile 10  in Local State, a different extension only
 *   Profile 2   not in Local State (directory scan), no extension
 *   System Profile / Guest Profile / a directory without Preferences: ignored
 *
 * @returns {Promise<string>}
 */
async function makeUserDataDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cici-index-'));

  await writeJson(path.join(root, 'Local State'), {
    profile: {
      info_cache: {
        Default: { name: 'Work', user_name: 'you@example.com', gaia_name: 'You Example' },
        'Profile 1': { name: 'Play', user_name: '', gaia_name: '' },
        'Profile 10': { name: 'Spare' },
        'System Profile': { name: 'System' },
      },
      last_used: 'Default',
    },
  });

  // --- Default ---------------------------------------------------------------
  const def = path.join(root, 'Default');
  await writeJson(path.join(def, 'Preferences'), { profile: { name: 'Work' } });
  // two version dirs: numeric comparison must pick 1.0.90 over 1.0.9
  await fs.mkdir(path.join(def, 'Extensions', EXT_ID, '1.0.9_0'), { recursive: true });
  await fs.mkdir(path.join(def, 'Extensions', EXT_ID, '1.0.90_0'), { recursive: true });
  const storage = path.join(def, 'Local Extension Settings', EXT_ID);
  const table = await writeSstFile(
    path.join(storage, '000005.ldb'),
    [
      { key: 'bridgeDeviceId', sequence: 1, type: TYPE_VALUE, value: J(UUID) },
      { key: 'bridgeDisplayName', sequence: 2, type: TYPE_VALUE, value: J(OLD_NAME) },
      { key: 'settings', sequence: 3, type: TYPE_VALUE, value: J({ theme: 'dark', count: 3 }) },
    ],
    { compression: 'snappy' },
  );
  // premise: one data block, and it really is snappy compressed (type byte 1)
  assert.equal(table.dataBlocks, 1);
  assert.equal(table.buffer[table.metaindexHandle.offset - 5], BLOCK_SNAPPY);
  await writeLogFile(path.join(storage, '000007.log'), [
    { sequence: 4, records: [{ type: TYPE_VALUE, key: 'bridgeDisplayName', value: J(NEW_NAME) }] },
    { sequence: 5, records: [] },
  ]);
  await writeManifest(storage, {
    logNumber: 7,
    lastSequence: 5,
    liveTables: [{ level: 0, number: 5, size: table.size, smallest: table.smallest, largest: table.largest }],
  });
  await fs.writeFile(path.join(storage, 'LOCK'), '');
  await fs.writeFile(path.join(storage, 'LOG'), '2026/01/01-00:00:00.000 1 Recovering log #6\n');

  // --- Profile 1: installed, storage exists, never paired --------------------
  const p1 = path.join(root, 'Profile 1');
  await writeJson(path.join(p1, 'Preferences'), { profile: { name: 'Play' } });
  await fs.mkdir(path.join(p1, 'Extensions', EXT_ID, '1.0.80_0'), { recursive: true });
  const storage1 = path.join(p1, 'Local Extension Settings', EXT_ID);
  const table1 = await writeSstFile(path.join(storage1, '000003.ldb'), [
    { key: 'settings', sequence: 1, type: TYPE_VALUE, value: J({ theme: 'light' }) },
  ]);
  await writeManifest(storage1, {
    logNumber: 4,
    lastSequence: 1,
    liveTables: [{ level: 0, number: 3, size: table1.size, smallest: table1.smallest, largest: table1.largest }],
  });

  // --- Profile 10: listed, a different extension only -------------------------
  const p10 = path.join(root, 'Profile 10');
  await writeJson(path.join(p10, 'Preferences'), { profile: { name: 'Spare' } });
  await fs.mkdir(path.join(p10, 'Extensions', OTHER_EXT_ID, '2.0_0'), { recursive: true });

  // --- Profile 2: not in Local State, no extension ---------------------------
  const p2 = path.join(root, 'Profile 2');
  await writeJson(path.join(p2, 'Preferences'), { profile: { name: 'Scanned' } });

  // --- never profiles ----------------------------------------------------------
  await writeJson(path.join(root, 'System Profile', 'Preferences'), { profile: { name: 'System' } });
  await writeJson(path.join(root, 'Guest Profile', 'Preferences'), { profile: { name: 'Guest' } });
  await fs.mkdir(path.join(root, 'ShaderCache'), { recursive: true });

  return root;
}

/**
 * @param {string} root
 * @param {object} overrides
 * @returns {import('../src/index.js').Row}
 */
function expectedRow(root, overrides) {
  return {
    browser: 'custom',
    browserName: 'Custom',
    userDataDir: root,
    profileDir: path.join(root, overrides.profileDirName),
    profileName: null,
    email: null,
    gaiaName: null,
    extensionId: null,
    extensionVersion: null,
    deviceId: null,
    displayName: null,
    warnings: [],
    ...overrides,
  };
}

function captureIo(extra = {}) {
  const out = [];
  const err = [];
  return {
    io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s), isTTY: false, env: {}, ...extra },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

/** @type {string} */
let root;
/** @type {string} */
let emptyDir;

before(async () => {
  root = path.resolve(await makeUserDataDir());
  emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cici-empty-'));
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(emptyDir, { recursive: true, force: true });
});

describe('scan', () => {
  test('lists only profiles with the extension by default', async () => {
    const rows = await scan({ userDataDirs: [root] });
    assert.deepEqual(rows, [
      expectedRow(root, {
        profileDirName: 'Default',
        profileName: 'Work',
        email: 'you@example.com',
        gaiaName: 'You Example',
        extensionId: EXT_ID,
        extensionVersion: '1.0.90',
        deviceId: UUID,
        displayName: NEW_NAME,
      }),
      expectedRow(root, {
        profileDirName: 'Profile 1',
        profileName: 'Play',
        extensionId: EXT_ID,
        extensionVersion: '1.0.80',
      }),
    ]);
  });

  test('the .log rename wins over the older .ldb value', async () => {
    const [def] = await scan({ userDataDirs: [root] });
    assert.equal(def.displayName, NEW_NAME);
    assert.notEqual(def.displayName, OLD_NAME);
  });

  test('includeUninstalled adds the other profiles, sorted Default, Profile 1, 2, 10', async () => {
    const rows = await scan({ userDataDirs: [root], includeUninstalled: true });
    assert.deepEqual(rows.map((r) => r.profileDirName), ['Default', 'Profile 1', 'Profile 2', 'Profile 10']);

    const p2 = rows[2];
    assert.ok(p2.warnings.length >= 1, 'a scan-discovered profile should say it is missing from Local State');
    assert.match(p2.warnings.join('\n'), /Local State/);
    assert.deepEqual({ ...p2, warnings: [] }, expectedRow(root, { profileDirName: 'Profile 2', profileName: 'Scanned' }));

    assert.deepEqual(rows[3], expectedRow(root, { profileDirName: 'Profile 10', profileName: 'Spare' }));
    for (const dirName of ['System Profile', 'Guest Profile', 'ShaderCache']) {
      assert.ok(!rows.some((r) => r.profileDirName === dirName), `${dirName} must never be a row`);
    }
  });

  test('extensionIds narrows the search; an installed-but-storageless extension warns', async () => {
    const rows = await scan({ userDataDirs: [root], extensionIds: [OTHER_EXT_ID] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].profileDirName, 'Profile 10');
    assert.equal(rows[0].extensionId, OTHER_EXT_ID);
    assert.equal(rows[0].extensionVersion, '2.0');
    assert.equal(rows[0].deviceId, null);
    assert.equal(rows[0].warnings.length, 1);
    assert.match(rows[0].warnings[0], /no storage directory/);
  });

  test('a profile directory given instead of the user-data dir scans just that profile', async () => {
    const rows = await scan({ userDataDirs: [path.join(root, 'Default')] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].profileDirName, 'Default');
    assert.equal(rows[0].userDataDir, root);
    assert.equal(rows[0].deviceId, UUID);
  });

  test('a user-data dir without profiles yields no rows', async () => {
    assert.deepEqual(await scan({ userDataDirs: [emptyDir] }), []);
    assert.deepEqual(await scan({ userDataDirs: [emptyDir], includeUninstalled: true }), []);
  });

  test('the same directory given twice does not duplicate rows', async () => {
    const once = await scan({ userDataDirs: [root] });
    for (const dirs of [
      [root, root],
      [root, `${root}${path.sep}`],
      [root, path.join(root, 'Default')],
      [path.join(root, 'Default'), root],
    ]) {
      const rows = await scan({ userDataDirs: dirs });
      assert.deepEqual(
        rows.map((r) => r.profileDir),
        [...new Set(rows.map((r) => r.profileDir))],
        `duplicate profileDir for ${JSON.stringify(dirs)}`,
      );
      assert.ok(rows.length <= once.length, `${JSON.stringify(dirs)} should not add rows`);
    }
    assert.deepEqual(await scan({ userDataDirs: [root, root] }), once);
  });

  test('several custom dirs are labelled by directory name so rows stay distinguishable', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'cici-second-'));
    try {
      await writeJson(path.join(other, 'Default', 'Preferences'), { profile: { name: 'Other' } });
      await fs.mkdir(path.join(other, 'Default', 'Local Extension Settings', EXT_ID), { recursive: true });

      const rows = await scan({ userDataDirs: [root, other] });
      const defaults = rows.filter((r) => r.profileDirName === 'Default');
      assert.equal(defaults.length, 2, 'both user-data dirs have a Default profile');
      assert.notEqual(defaults[0].browserName, defaults[1].browserName, 'labels must differ');
      for (const r of defaults) assert.match(r.browserName, /^Custom \(cici-/);

      // A single dir keeps the plain "Custom" label.
      const single = await scan({ userDataDirs: [other] });
      assert.equal(single[0].browserName, 'Custom');
      assert.equal(single[0].browser, 'custom');
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  test('a well-known user-data dir passed explicitly is named after its browser', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cici-home-'));
    try {
      const chrome = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
      await writeJson(path.join(chrome, 'Default', 'Preferences'), { profile: { name: 'Real' } });
      await fs.mkdir(path.join(chrome, 'Default', 'Local Extension Settings', EXT_ID), { recursive: true });

      const report = await scanReport({ userDataDirs: [chrome], platform: 'darwin', home, env: {} });
      assert.equal(report.rows.length, 1);
      assert.equal(report.rows[0].browser, 'chrome');
      assert.equal(report.rows[0].browserName, 'Google Chrome');
      // The "where did I look" hint names it too, instead of "Custom".
      assert.equal(report.searched[0].browserName, 'Google Chrome');
      assert.equal(report.searched[0].browser, 'chrome');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test('scanReport records the searched dirs and reports a missing one as a warning', async () => {
    const missing = path.join(root, 'does-not-exist');
    const report = await scanReport({ userDataDirs: [root, missing] });
    assert.equal(report.rows.length, 2);
    assert.deepEqual(
      report.searched.map((s) => [s.userDataDir, s.exists, s.profileCount]),
      [[root, true, 4], [missing, false, 0]],
    );
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /not found/);
  });
});

describe('main', () => {
  test('exit 0 with a table when a bridgeDeviceId is found', async () => {
    const { io, stdout, stderr } = captureIo();
    assert.equal(await main(['--user-data-dir', root], io), 0);
    const out = stdout();
    assert.equal(stderr(), '');
    assert.doesNotMatch(out, ANSI);
    const lines = out.split('\n');
    assert.match(lines[0], /^Browser\s+Profile\s+Name\s+Email\s+Paired name\s+bridgeDeviceId\s+Ext$/);
    const def = lines.find((l) => l.includes(UUID));
    assert.ok(def, 'the Default row shows the device id');
    assert.match(def, new RegExp(`^Custom\\s+Default\\s+Work\\s+you@example\\.com\\s+${NEW_NAME}\\s+${UUID}\\s+1\\.0\\.90$`));
    const p1 = lines.find((l) => l.includes('Profile 1'));
    assert.match(p1, /^Custom\s+Profile 1\s+Play\s+-\s+-\s+not paired\s+1\.0\.80$/);
    assert.ok(!out.includes('Profile 2') && !out.includes('Profile 10'), 'uninstalled profiles are hidden without --all');
    assert.ok(!out.includes('not installed'));
    assert.match(out, /bridgeDeviceId is the id Claude Code shows/);
  });

  test('--json prints exactly what scan() returns', async () => {
    const { io, stdout, stderr } = captureIo();
    assert.equal(await main(['--user-data-dir', root, '--json'], io), 0);
    assert.equal(stderr(), '');
    const parsed = JSON.parse(stdout());
    assert.deepEqual(parsed, await scan({ userDataDirs: [root] }));
    assert.equal(parsed[0].deviceId, UUID);
  });

  test('--all --json includes uninstalled profiles and prints their warnings on stderr', async () => {
    const { io, stdout, stderr } = captureIo();
    assert.equal(await main(['--user-data-dir', root, '--all', '--json'], io), 0);
    const parsed = JSON.parse(stdout());
    assert.deepEqual(parsed.map((r) => r.profileDirName), ['Default', 'Profile 1', 'Profile 2', 'Profile 10']);
    // The warning names the profile directory, so several --user-data-dir
    // arguments with a "Default" profile each stay distinguishable.
    const prefix = `cici: warning: ${path.join(root, 'Profile 2')}: `;
    assert.ok(
      stderr().split('\n').some((line) => line.startsWith(prefix)),
      `stderr should carry a warning prefixed with the profile dir:\n${stderr()}`,
    );
  });

  test('--all table shows "not installed" and -q silences warnings', async () => {
    const { io, stdout, stderr } = captureIo();
    assert.equal(await main(['--user-data-dir', root, '--all', '-q'], io), 0);
    assert.equal(stderr(), '');
    assert.match(stdout(), /Profile 10\s+Spare\s+-\s+-\s+not installed\s+-$/m);
  });

  test('colors only when stdout is a TTY and NO_COLOR is unset', async () => {
    const tty = captureIo({ isTTY: true });
    assert.equal(await main(['--user-data-dir', root], tty.io), 0);
    assert.ok(tty.stdout().includes(`\x1b[1m\x1b[36m${UUID}\x1b[0m`), 'device id is bold cyan on a TTY');
    assert.ok(tty.stdout().includes('\x1b[2mnot paired\x1b[0m'));

    const noColor = captureIo({ isTTY: true, env: { NO_COLOR: '1' } });
    assert.equal(await main(['--user-data-dir', root], noColor.io), 0);
    assert.doesNotMatch(noColor.stdout(), ANSI);

    const flag = captureIo({ isTTY: true });
    assert.equal(await main(['--user-data-dir', root, '--no-color'], flag.io), 0);
    assert.doesNotMatch(flag.stdout(), ANSI);
  });

  test('exit 1 with a hint when nothing is paired', async () => {
    const { io, stdout, stderr } = captureIo();
    assert.equal(await main(['--user-data-dir', emptyDir], io), 1);
    assert.match(stdout(), /\(no profiles found\)/);
    assert.match(stderr(), /no bridgeDeviceId found/);
    assert.ok(stderr().includes(emptyDir), 'the hint lists the searched directory');
    assert.match(stderr(), /--all/);
  });

  test('exit 1 when the extension is installed but never paired', async () => {
    const { io, stdout, stderr } = captureIo();
    assert.equal(await main(['--user-data-dir', root, '--ext-id', OTHER_EXT_ID], io), 1);
    assert.match(stdout(), /not paired/);
    assert.match(stderr(), /no bridgeDeviceId found/);
  });

  test('exit 1 for a user-data dir that does not exist', async () => {
    const missing = path.join(root, 'nope');
    const { io, stderr } = captureIo();
    assert.equal(await main(['--user-data-dir', missing, '--json'], io), 1);
    assert.match(stderr(), /not found/);
    assert.ok(stderr().includes(missing));
  });

  test('exit 2 on usage errors without scanning', async () => {
    const a = captureIo();
    assert.equal(await main(['--user-data-dir', root, '--bogus'], a.io), 2);
    assert.equal(a.stdout(), '');
    assert.match(a.stderr(), /unknown option: --bogus/);

    const b = captureIo();
    assert.equal(await main(['--user-data-dir'], b.io), 2);
    assert.match(b.stderr(), /requires a value/);

    const c = captureIo();
    assert.equal(await main(['--ext-id', 'nope', '--user-data-dir', root], c.io), 2);
    assert.match(c.stderr(), /invalid extension id/);
  });
});

// ---------------------------------------------------------------------------
// regressions from the code review

describe('scan: browser auto-discovery (no --user-data-dir)', () => {
  /** @type {string} */
  let home;
  /** @type {string} */
  let chromeDir;
  /** @type {string} */
  let braveDir;

  before(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'cici-discover-'));
    const support = path.join(home, 'Library', 'Application Support');
    chromeDir = path.join(support, 'Google', 'Chrome');
    braveDir = path.join(support, 'BraveSoftware', 'Brave-Browser');
    for (const dir of [chromeDir, braveDir]) {
      await writeJson(path.join(dir, 'Default', 'Preferences'), { profile: { name: 'Only' } });
      await fs.mkdir(path.join(dir, 'Default', 'Local Extension Settings', EXT_ID), { recursive: true });
    }
  });

  after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  test('discovers the installed browsers and orders rows by BROWSERS, not by disk order', async () => {
    const report = await scanReport({ platform: 'darwin', home, env: {} });
    assert.deepEqual(report.rows.map((r) => r.browser), ['chrome', 'brave']);
    assert.deepEqual(report.rows.map((r) => r.userDataDir), [chromeDir, braveDir]);
    assert.equal(report.rows[0].browserName, 'Google Chrome');

    // Every well-known location is reported, so the "here is where I looked"
    // hint can list the ones that do not exist.
    assert.ok(report.searched.length >= 10, `all candidates should be listed: ${report.searched.length}`);
    const existing = report.searched.filter((s) => s.exists);
    assert.deepEqual(existing.map((s) => s.userDataDir).sort(), [braveDir, chromeDir].sort());
    for (const s of existing) assert.equal(s.profileCount, 1);
    for (const s of report.searched.filter((s2) => !s2.exists)) assert.equal(s.profileCount, 0);
  });

  test('BROWSERS order wins over the order the directories were given in', async () => {
    const rows = await scan({ userDataDirs: [braveDir, chromeDir], platform: 'darwin', home, env: {} });
    assert.deepEqual(rows.map((r) => r.browser), ['chrome', 'brave']);
  });

  test('a well-known directory spelled in another case keeps its browser name', async (t) => {
    const variant = path.join(home, 'library', 'application support', 'google', 'chrome');
    try {
      const [a, b] = await Promise.all([fs.stat(chromeDir), fs.stat(variant)]);
      if (a.ino !== b.ino) throw new Error('different directory');
    } catch {
      t.skip('the filesystem here is case-sensitive');
      return;
    }
    const report = await scanReport({ userDataDirs: [variant], platform: 'darwin', home, env: {} });
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].browser, 'chrome');
    assert.equal(report.rows[0].browserName, 'Google Chrome');
  });
});

describe('scan: path handling', () => {
  test('a leading ~ is expanded (a quoted "~/..." reaches us verbatim)', async () => {
    const expected = await scan({ userDataDirs: [root] });
    assert.ok(expected.length > 0, 'premise: the fixture has rows');

    const tilde = await scan({ userDataDirs: [`~/${path.basename(root)}`], home: path.dirname(root) });
    assert.deepEqual(tilde, expected, 'a tilde path must find the same profiles');

    const bare = await scan({ userDataDirs: ['~'], home: root });
    assert.deepEqual(bare, expected, 'a bare ~ is the home directory itself');
  });

  test('the same directory in a different case is scanned once', async (t) => {
    const variant = path.join(path.dirname(root), path.basename(root).toUpperCase());
    try {
      const [a, b] = await Promise.all([fs.stat(root), fs.stat(variant)]);
      if (a.ino !== b.ino) throw new Error('different directory');
    } catch {
      t.skip('the filesystem here is case-sensitive');
      return;
    }
    const once = await scan({ userDataDirs: [root] });
    const report = await scanReport({ userDataDirs: [root, variant] });
    assert.deepEqual(report.rows, once, 'every bridgeDeviceId would otherwise be listed twice');
    assert.equal(
      report.searched.reduce((n, s) => n + s.profileCount, 0),
      once.length > 0 ? report.searched.find((s) => s.exists).profileCount : 0,
      'profiles must not be counted twice either',
    );
  });
});

describe('warnings from the extension storage', () => {
  /** @type {string} */
  let broken;

  before(async () => {
    broken = await fs.mkdtemp(path.join(os.tmpdir(), 'cici-broken-'));
    const def = path.join(broken, 'Default');
    await writeJson(path.join(def, 'Preferences'), { profile: { name: 'Broken' } });
    await writeLogFile(path.join(def, 'Local Extension Settings', EXT_ID, '000003.log'), [
      { sequence: 1, records: [{ type: TYPE_VALUE, key: 'bridgeDeviceId', value: J('not-a-uuid') }] },
    ]);
  });

  after(async () => {
    await fs.rm(broken, { recursive: true, force: true });
  });

  test('readBridgeInfo warnings end up on the row', async () => {
    const rows = await scan({ userDataDirs: [broken] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].deviceId, 'not-a-uuid', 'the stored value is still reported');
    assert.match(rows[0].warnings.join('\n'), /does not look like a UUID/);
  });

  test('main prints them on stderr, prefixed with the profile directory', async () => {
    const { io, stderr } = captureIo();
    await main(['--user-data-dir', broken], io);
    const prefix = `cici: warning: ${path.join(broken, 'Default')}: `;
    const lines = stderr().split('\n').filter((l) => l.startsWith(prefix));
    assert.ok(lines.length > 0, `stderr should carry the profile's warnings:\n${stderr()}`);
    assert.match(lines.join('\n'), /does not look like a UUID/);
  });

  test('-q silences them', async () => {
    const { io, stderr } = captureIo();
    await main(['--user-data-dir', broken, '-q'], io);
    assert.doesNotMatch(stderr(), /does not look like a UUID/);
  });
});

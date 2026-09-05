// Tests for src/claude.js: how bridgeDeviceId / bridgeDisplayName are pulled
// out of an extension storage directory and which values are rejected.
// Every fixture is synthetic; no real profile is read.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CLAUDE_EXTENSION_IDS,
  BRIDGE_DEVICE_ID_KEY,
  BRIDGE_DISPLAY_NAME_KEY,
  readBridgeInfo,
} from '../src/claude.js';
import { writeLogFile, writeManifest, TYPE_VALUE } from './helpers/leveldb-writer.js';

const UUID = '11111111-2222-4333-8444-555555555555';
const J = JSON.stringify;

/**
 * A storage directory holding one write batch with the given raw values.
 *
 * @param {import('node:test').TestContext} t
 * @param {Array<[string, string]>} pairs key -> raw stored bytes (already JSON text, or not)
 * @returns {Promise<string>}
 */
async function storageDir(t, pairs) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cici-claude-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  if (pairs.length > 0) {
    await writeLogFile(path.join(dir, '000003.log'), [
      { sequence: 1, records: pairs.map(([key, value]) => ({ type: TYPE_VALUE, key, value })) },
    ]);
    await writeManifest(dir, { logNumber: 3, lastSequence: pairs.length, liveTables: [] });
  }
  return dir;
}

describe('CLAUDE_EXTENSION_IDS', () => {
  test('starts with the Chrome Web Store id and holds only valid ids', () => {
    assert.equal(CLAUDE_EXTENSION_IDS[0], 'fcoeoabgfenejglbffodgkkbkcdhcgfn');
    assert.equal(CLAUDE_EXTENSION_IDS.length, 3);
    for (const id of CLAUDE_EXTENSION_IDS) assert.match(id, /^[a-p]{32}$/);
    assert.equal(BRIDGE_DEVICE_ID_KEY, 'bridgeDeviceId');
    assert.equal(BRIDGE_DISPLAY_NAME_KEY, 'bridgeDisplayName');
  });
});

describe('readBridgeInfo', () => {
  test('reads a JSON string device id and display name without warnings', async (t) => {
    const dir = await storageDir(t, [
      [BRIDGE_DEVICE_ID_KEY, J(UUID)],
      [BRIDGE_DISPLAY_NAME_KEY, J('테스트 노트북')],
      ['anonymousId', J('unrelated')],
    ]);
    assert.deepEqual(await readBridgeInfo(dir), {
      deviceId: UUID,
      displayName: '테스트 노트북',
      readFailed: false,
      warnings: [],
    });
  });

  test('a missing bridgeDeviceId is a null, not a warning', async (t) => {
    const dir = await storageDir(t, [['anonymousId', J('only onboarding keys so far')]]);
    const info = await readBridgeInfo(dir);
    assert.equal(info.deviceId, null);
    assert.equal(info.displayName, null);
    assert.deepEqual(info.warnings, []);
  });

  test('a string that is not a UUID is still returned, with a warning', async (t) => {
    const dir = await storageDir(t, [[BRIDGE_DEVICE_ID_KEY, J('not-a-uuid')]]);
    const info = await readBridgeInfo(dir);
    assert.equal(info.deviceId, 'not-a-uuid');
    assert.equal(info.warnings.length, 1);
    assert.match(info.warnings[0], /does not look like a UUID/);
  });

  test('a JSON value that is not a string yields null and a warning', async (t) => {
    const dir = await storageDir(t, [[BRIDGE_DEVICE_ID_KEY, '123']]);
    const info = await readBridgeInfo(dir);
    assert.equal(info.deviceId, null);
    assert.equal(info.warnings.length, 1);
    assert.match(info.warnings[0], /not a JSON string/);
  });

  test('a bare (unquoted) UUID is accepted with a warning', async (t) => {
    const dir = await storageDir(t, [[BRIDGE_DEVICE_ID_KEY, UUID]]);
    const info = await readBridgeInfo(dir);
    assert.equal(info.deviceId, UUID);
    assert.equal(info.warnings.length, 1);
    assert.match(info.warnings[0], /not valid JSON/);
  });

  test('invalid JSON that is not a UUID yields null and a warning', async (t) => {
    const dir = await storageDir(t, [[BRIDGE_DEVICE_ID_KEY, '{ broken']]);
    const info = await readBridgeInfo(dir);
    assert.equal(info.deviceId, null);
    assert.equal(info.warnings.length, 1);
    assert.match(info.warnings[0], /not valid JSON/);
  });

  test('a display name that is not a string warns; JSON null does not', async (t) => {
    const object = await readBridgeInfo(await storageDir(t, [[BRIDGE_DISPLAY_NAME_KEY, J({ a: 1 })]]));
    assert.equal(object.displayName, null);
    assert.equal(object.warnings.length, 1);
    assert.match(object.warnings[0], /bridgeDisplayName is not a JSON string/);

    const nulled = await readBridgeInfo(await storageDir(t, [[BRIDGE_DISPLAY_NAME_KEY, 'null']]));
    assert.equal(nulled.displayName, null);
    assert.deepEqual(nulled.warnings, []);

    const broken = await readBridgeInfo(await storageDir(t, [[BRIDGE_DISPLAY_NAME_KEY, 'not json']]));
    assert.equal(broken.displayName, null);
    assert.equal(broken.warnings.length, 1);
    assert.match(broken.warnings[0], /bridgeDisplayName is not valid JSON/);
  });

  test('a storage directory that does not exist warns instead of throwing', async (t) => {
    const dir = path.join(await storageDir(t, []), 'missing');
    const info = await readBridgeInfo(dir);
    assert.deepEqual({ deviceId: info.deviceId, displayName: info.displayName }, { deviceId: null, displayName: null });
    assert.equal(info.warnings.length, 1);
    assert.match(info.warnings[0], /does not exist/);
    assert.ok(info.warnings[0].includes(dir));
  });

  test('a directory without LevelDB files warns instead of parsing', async (t) => {
    const dir = await storageDir(t, []);
    await fs.writeFile(path.join(dir, 'LOCK'), '');
    await fs.writeFile(path.join(dir, 'LOG'), 'nothing to see here\n');
    const info = await readBridgeInfo(dir);
    assert.equal(info.deviceId, null);
    assert.equal(info.warnings.length, 1);
    assert.match(info.warnings[0], /no LevelDB files/);
  });

  test('LevelDB warnings are passed through, prefixed with the directory', async (t) => {
    const dir = await storageDir(t, [[BRIDGE_DEVICE_ID_KEY, J(UUID)]]);
    // A second log whose contents are garbage: the good value must survive and
    // the problem must be reported.
    const garbage = Buffer.alloc(400);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37 + 11) & 0xff;
    await fs.writeFile(path.join(dir, '000009.log'), garbage);

    const info = await readBridgeInfo(dir);
    assert.equal(info.deviceId, UUID);
    assert.ok(info.warnings.length >= 1, 'the damaged log should be reported');
    for (const w of info.warnings) assert.ok(w.startsWith(`${dir}: `), w);
  });
});

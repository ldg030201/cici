/**
 * MV3 확장 쪽 코드 테스트.
 *
 * 여기서 지키려는 것은 네 가지다.
 *
 *   1. `extension/lib/leveldb-core.js` 와 `snappy.js` 가 `src/` 원본과 같다
 *      (`scripts/build-extension.mjs` 가 만든 복사본이 뒤처지지 않았는지).
 *   2. `extension/` 안에는 `node:` 임포트가 없다 — 브라우저에서 그대로 로드된다.
 *   3. `extension/manifest.json` 이 MV3 이고 권한이 최소한이다.
 *   4. `file://` 디렉터리 리스팅 파서가 **진짜 Chromium 이 뱉은 HTML** 을
 *      정확히 읽는다. 그 샘플이 `test/fixtures/dir-listing.html` 이고, Chrome
 *      for Testing 148 이 한글·공백·따옴표·역슬래시·`#`·`?`·`%` 가 든 이름의
 *      파일들이 있는 디렉터리를 열어서 실제로 만들어 낸 응답 본문이다
 *      (경로만 `/Users/you/cici-lab/` 으로 바꿨다).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COPIED_FILES, generatedContent } from '../scripts/build-extension.mjs';
import {
  decodeUtf8,
  fetchBytes,
  joinPath,
  listDir,
  findChildDir,
  findChildFile,
  listDirOrNull,
  makeSource,
  parseDirectoryListing,
  resetDirCache,
  resolveDirPath,
  toFileUrl,
} from '../extension/lib/fileurl.js';
import {
  BROWSER_DIRS,
  BROWSERS,
  HOME_ROOTS,
  NONCE_KEY,
  detectPlatform,
  isNonProfileDirName,
  isSystemHomeName,
  listHomes,
  listProfileDirs,
  locateSelf,
  readProfileMeta,
} from '../extension/lib/locate.js';
import { CLAUDE_EXTENSION_IDS, readBridge } from '../extension/lib/read.js';
import { buildLogFile, TYPE_VALUE } from './helpers/leveldb-writer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const EXT = path.join(REPO, 'extension');
const LIB = path.join(EXT, 'lib');

/** 저장소에는 진짜 값을 절대 넣지 않는다. 전부 가짜다. */
const FAKE_DEVICE_ID = '11111111-2222-4333-8444-555555555555';
const FAKE_DEVICE_ID_2 = '99999999-8888-4777-8666-555555555555';
const SELF_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const CLAUDE_ID = CLAUDE_EXTENSION_IDS[0];

// ---------------------------------------------------------------------------
// 1. 복사본 동기화
// ---------------------------------------------------------------------------

test('extension/lib 의 복사본은 src/ 원본과 헤더 주석만 다르다', async () => {
  for (const name of COPIED_FILES) {
    const source = await readFile(path.join(REPO, 'src', name), 'utf8');
    const copied = await readFile(path.join(LIB, name), 'utf8');
    assert.equal(
      copied,
      generatedContent(name, source),
      `extension/lib/${name} 이 src/${name} 과 다릅니다. "npm run build:ext" 를 돌리세요.`,
    );
  }
});

test('복사본은 서로를 상대 경로로 임포트한다', async () => {
  const core = await readFile(path.join(LIB, 'leveldb-core.js'), 'utf8');
  assert.match(core, /from '\.\/snappy\.js'/);
});

// ---------------------------------------------------------------------------
// 2. 브라우저에서 그대로 로드되는가
// ---------------------------------------------------------------------------

test('extension/ 의 자바스크립트에는 node: 임포트가 없다', async () => {
  const files = await extensionScripts();
  assert.ok(files.length >= 4, `확장 스크립트를 찾지 못했습니다: ${files.length}개`);
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const rel = path.relative(REPO, file);
    assert.equal(/(?:from|import)\s*\(?\s*['"]node:/.test(text), false, `${rel} 에 node: 임포트가 있습니다`);
    assert.equal(/\brequire\s*\(/.test(text), false, `${rel} 에 require() 가 있습니다`);
    assert.equal(/\bprocess\.(?:env|argv|platform)\b/.test(text), false, `${rel} 이 process 를 씁니다`);
  }
});

test('extension/lib 은 CommonJS 가 아니라 ES 모듈이다', async () => {
  for (const name of ['fileurl.js', 'locate.js', 'read.js']) {
    const text = await readFile(path.join(LIB, name), 'utf8');
    assert.match(text, /^export /m, `${name} 에 export 가 없습니다`);
    assert.equal(/module\.exports/.test(text), false, `${name} 이 module.exports 를 씁니다`);
  }
});

// ---------------------------------------------------------------------------
// 3. manifest.json
// ---------------------------------------------------------------------------

/**
 * 허용되는 `permissions`.
 *
 * 계약은 "permissions 는 비어 있어야 한다"였지만, 자기 프로필을 찾는 nonce 왕복이
 * `chrome.storage.local` 을 쓴다. `chrome.storage` 는 "storage" 권한 없이는 아예
 * `undefined` 다. 다행히 "storage" 는 설치할 때 사용자에게 경고 문구가 뜨지 않는
 * 유일한 부류라서 스토어 심사에도 영향이 없다. 그 하나만 예외로 둔다.
 */
const ALLOWED_PERMISSIONS = new Set(['storage']);

test('manifest.json 은 MV3 이고 권한이 최소한이다', async () => {
  const manifest = await readManifest();
  assert.equal(manifest.manifest_version, 3, 'manifest_version 은 3 이어야 합니다');
  assert.deepEqual(manifest.host_permissions, ['file:///*'], 'host_permissions 는 file:///* 하나뿐이어야 합니다');

  const permissions = manifest.permissions ?? [];
  assert.ok(Array.isArray(permissions), 'permissions 는 배열이어야 합니다');
  const extra = permissions.filter((p) => !ALLOWED_PERMISSIONS.has(p));
  assert.deepEqual(extra, [], `허용되지 않은 권한: ${extra.join(', ')}`);

  assert.equal(
    manifest.background,
    undefined,
    '서비스워커는 두지 않는다 — 팝업에서 전부 처리하므로 필요 없고, 권한 인상만 나빠진다',
  );
});

test('chrome.storage 를 쓰는 이상 manifest 에 "storage" 가 있어야 한다', async () => {
  const locate = await readFile(path.join(LIB, 'locate.js'), 'utf8');
  if (!/\bchrome\??\.storage\b/.test(locate)) return; // 안 쓰면 필요 없다
  const manifest = await readManifest();
  const permissions = manifest.permissions ?? [];
  assert.ok(
    permissions.includes('storage'),
    'lib/locate.js 의 nonce 왕복이 chrome.storage.local 을 씁니다. ' +
      '"storage" 권한이 없으면 chrome.storage 가 undefined 라 자기 프로필을 절대 찾지 못합니다. ' +
      '("storage" 는 설치 경고가 뜨지 않는 권한이라 최소 권한 원칙에 어긋나지 않습니다.)',
  );
});

test('manifest.json 은 확장 파일들과 아귀가 맞는다', async () => {
  const manifest = await readManifest();
  assert.equal(manifest.action?.default_popup, 'popup.html');
  assert.equal(manifest.default_locale, 'ko');
});

// ---------------------------------------------------------------------------
// 4. toFileUrl
// ---------------------------------------------------------------------------

test('toFileUrl 은 경로 조각만 인코딩하고 / 는 남긴다', () => {
  assert.equal(toFileUrl('/Users/you'), 'file:///Users/you');
  assert.equal(toFileUrl('/Users/you/'), 'file:///Users/you/');
  assert.equal(toFileUrl('/'), 'file:///');
});

test('toFileUrl 은 공백·한글·# ? % 를 인코딩한다', () => {
  assert.equal(toFileUrl('/Users/you/space name.txt'), 'file:///Users/you/space%20name.txt');
  assert.equal(toFileUrl('/Users/you/한글 파일.txt'), 'file:///Users/you/%ED%95%9C%EA%B8%80%20%ED%8C%8C%EC%9D%BC.txt');
  assert.equal(toFileUrl('/a/hash#tag.txt'), 'file:///a/hash%23tag.txt');
  assert.equal(toFileUrl('/a/question?.txt'), 'file:///a/question%3F.txt');
  assert.equal(toFileUrl('/a/percent%20literal.txt'), 'file:///a/percent%2520literal.txt');
  assert.equal(toFileUrl('/a/quote"name.txt'), 'file:///a/quote%22name.txt');
});

test('toFileUrl 은 POSIX 경로의 역슬래시를 구분자로 보지 않는다', () => {
  // POSIX 에서 back\slash.txt 는 파일 이름 하나다. 실제로 Chromium 도
  // back%5Cslash.txt 로 인코딩한다.
  assert.equal(toFileUrl('/a/back\\slash.txt'), 'file:///a/back%5Cslash.txt');
});

test('toFileUrl 은 윈도우 경로를 처리한다', () => {
  assert.equal(toFileUrl('C:\\Users\\you'), 'file:///C:/Users/you');
  assert.equal(toFileUrl('c:/Users/you/App Data'), 'file:///C:/Users/you/App%20Data');
  assert.equal(toFileUrl('C:\\'), 'file:///C:/');
  assert.equal(toFileUrl('C:'), 'file:///C:/');
  assert.equal(toFileUrl('\\\\server\\share\\a b'), 'file://server/share/a%20b');
});

test('toFileUrl 은 상대 경로를 거부한다', () => {
  assert.throws(() => toFileUrl('Users/you'), TypeError);
  assert.throws(() => toFileUrl(''), TypeError);
  assert.throws(() => toFileUrl(undefined), TypeError);
});

test('toFileUrl 이 만든 URL 은 다시 원래 경로로 풀린다', () => {
  const names = [
    '/Users/you/한글 파일.txt',
    '/Users/you/quote"name.txt',
    '/Users/you/back\\slash.txt',
    '/Users/you/hash#tag.txt',
    "/Users/you/apostrophe'name.txt",
    '/Users/you/amp&lt;name.txt',
    '/Users/you/<script>tag.txt',
    '/Users/you/newline\ttab.txt',
  ];
  for (const p of names) {
    assert.equal(decodeURIComponent(new URL(toFileUrl(p)).pathname), p);
  }
});

test('joinPath 는 구분자를 겹치지 않는다', () => {
  assert.equal(joinPath('/a/b', 'c'), '/a/b/c');
  assert.equal(joinPath('/a/b/', 'c'), '/a/b/c');
  assert.equal(joinPath('/a/b//', 'c'), '/a/b/c');
});

// ---------------------------------------------------------------------------
// 5. 진짜 Chromium 리스팅 HTML 파싱
// ---------------------------------------------------------------------------

/** 픽스처를 만든 랩 디렉터리에 실제로 있던 것들. */
const FIXTURE_ENTRIES = [
  { name: 'CURRENT_like_dir', isDir: true },
  { name: 'sub dir 하위', isDir: true },
  { name: '<script>tag.txt', isDir: false, size: '3 B' },
  { name: '000005.log', isDir: false, size: '1 B' },
  { name: '000007.ldb', isDir: false, size: '1 B' },
  { name: '한글 파일.txt', isDir: false, size: '1 B' },
  { name: 'amp&lt;name.txt', isDir: false, size: '2 B' },
  { name: "apostrophe'name.txt", isDir: false, size: '1 B' },
  { name: 'back\\slash.txt', isDir: false, size: '4 B' },
  { name: 'hash#tag.txt', isDir: false, size: '6 B' },
  { name: 'newline\ttab.txt', isDir: false, size: '4 B' },
  { name: 'percent%20literal.txt', isDir: false, size: '5 B' },
  { name: 'question?.txt', isDir: false, size: '7 B' },
  { name: 'quote"name.txt', isDir: false, size: '3 B' },
  { name: 'space name.txt', isDir: false, size: '2 B' },
];

test('진짜 Chromium 리스팅에서 이름을 한 글자도 틀리지 않고 되살린다', async () => {
  const html = await readFile(path.join(HERE, 'fixtures', 'dir-listing.html'), 'utf8');
  const rows = parseDirectoryListing(html);

  assert.deepEqual(
    rows.map((r) => r.name).sort(),
    FIXTURE_ENTRIES.map((e) => e.name).sort(),
    '이름 목록이 다릅니다',
  );
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const want of FIXTURE_ENTRIES) {
    const got = byName.get(want.name);
    assert.equal(got.isDir, want.isDir, `${want.name} 의 isDir`);
    if (want.size !== undefined) assert.equal(got.size, want.size, `${want.name} 의 size`);
  }
});

test('리스팅 헤더의 addRow 함수 "선언" 은 항목으로 잡히지 않는다', async () => {
  const html = await readFile(path.join(HERE, 'fixtures', 'dir-listing.html'), 'utf8');
  // 픽스처에는 addRow( 가 항목 수보다 한 번 더 나온다: 헤더의 함수 선언.
  const occurrences = html.match(/\baddRow\s*\(/g) ?? [];
  assert.equal(occurrences.length, FIXTURE_ENTRIES.length + 1);
  const rows = parseDirectoryListing(html);
  assert.equal(rows.length, FIXTURE_ENTRIES.length);
  assert.equal(
    rows.some((r) => r.name === 'name'),
    false,
    'function addRow(name, url, ...) 선언을 항목으로 잘못 읽었습니다',
  );
});

test('parseDirectoryListing 은 이스케이프를 제대로 푼다', () => {
  const rows = parseDirectoryListing(
    '<script>addRow("\\u003Ca\\u003E\\t\\"b\\"\\\\c","x",0,1,"1 B",0,"-");</script>',
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    ['<a>\t"b"\\c'],
  );
});

test('parseDirectoryListing 은 서러게이트 쌍을 합친다', () => {
  const rows = parseDirectoryListing('<script>addRow("\\uD83D\\uDE00.txt","x",0,1,"1 B",0,"-");</script>');
  assert.deepEqual(
    rows.map((r) => r.name),
    ['\u{1F600}.txt'],
  );
});

test('parseDirectoryListing 은 상위 디렉터리와 빈 이름을 버린다', () => {
  const rows = parseDirectoryListing(
    ['..', '.', '', 'real.txt'].map((n) => `<script>addRow("${n}","u",0,1,"1 B",0,"-");</script>`).join('\n'),
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    ['real.txt'],
  );
});

test('parseDirectoryListing 은 파일 이름 속 가짜 addRow 에 속지 않는다', () => {
  // 이름 자체가 addRow 호출처럼 생긴 파일. Chromium 은 따옴표를 \" 로 escape 하므로
  // 진짜 호출은 하나뿐이고, 파서는 그 하나만 읽어야 한다.
  const html = '<script>addRow("addRow(\'x\',\'y\',1,0,\'a\',0,\'b\').txt","u",0,9,"9 B",0,"-");</script>';
  const rows = parseDirectoryListing(html);
  assert.deepEqual(
    rows.map((r) => r.name),
    ["addRow('x','y',1,0,'a',0,'b').txt"],
  );
});

test('parseDirectoryListing 은 이름 뒤에 붙은 / 를 디렉터리로 본다', () => {
  const rows = parseDirectoryListing('<script>addRow("d/","d/",0,0,"",0,"-");</script>');
  assert.deepEqual(rows, [{ name: 'd', isDir: true, size: '', bytes: 0 }]);
});

test('parseDirectoryListing 은 addRow 가 없으면 빈 배열이다', () => {
  assert.deepEqual(parseDirectoryListing('<html><body>hello</body></html>'), []);
  assert.deepEqual(parseDirectoryListing(''), []);
});

// ---------------------------------------------------------------------------
// 6. 홈/프로필 열거 (fetch 를 가짜로 갈아 끼운다)
// ---------------------------------------------------------------------------

test('isSystemHomeName 은 시스템 계정을 걸러 낸다', () => {
  for (const n of ['Shared', 'Guest', 'Public', 'Default', 'All Users', '.localized', 'defaultuser0', '']) {
    assert.equal(isSystemHomeName(n), true, `${n} 은 걸러져야 합니다`);
  }
  for (const n of ['you', 'ada', 'Administrator', 'user.name', 'Shared Folder']) {
    assert.equal(isSystemHomeName(n), false, `${n} 은 남아야 합니다`);
  }
});

test('isNonProfileDirName 은 프로필일 리 없는 디렉터리만 거른다', () => {
  assert.equal(isNonProfileDirName('Crashpad'), true);
  assert.equal(isNonProfileDirName('System Profile'), true);
  assert.equal(isNonProfileDirName('Guest Profile'), true);
  assert.equal(isNonProfileDirName('Default'), false);
  assert.equal(isNonProfileDirName('Profile 3'), false);
  assert.equal(isNonProfileDirName('내 프로필'), false);
});

test('BROWSER_DIRS 는 src/browsers.js 와 같은 브라우저 계열을 다룬다', () => {
  const ids = new Set(BROWSERS.map((b) => b.id));
  assert.deepEqual([...new Set(BROWSER_DIRS.mac.map((d) => d.browser))].sort(), [...ids].sort());
  for (const platform of ['mac', 'win', 'linux']) {
    for (const d of BROWSER_DIRS[platform]) {
      assert.ok(ids.has(d.browser), `${platform}: 모르는 브라우저 ${d.browser}`);
      assert.equal(d.path.startsWith('/'), false, `${platform}/${d.browser}: 홈 기준 상대 경로여야 합니다`);
      assert.equal(d.path.includes('\\'), false, `${platform}/${d.browser}: 구분자는 / 여야 합니다`);
      assert.equal(typeof d.browserName, 'string');
    }
  }
  assert.deepEqual(Object.keys(HOME_ROOTS).sort(), ['linux', 'mac', 'win']);
});

test('detectPlatform 은 navigator 로 판정한다', async (t) => {
  const cases = [
    [{ userAgentData: { platform: 'macOS' } }, 'mac'],
    [{ platform: 'MacIntel' }, 'mac'],
    [{ userAgentData: { platform: 'Windows' } }, 'win'],
    [{ platform: 'Win32' }, 'win'],
    [{ userAgentData: { platform: 'Linux' } }, 'linux'],
    [{ platform: 'Linux x86_64' }, 'linux'],
    [{}, 'linux'],
  ];
  for (const [nav, want] of cases) {
    await t.test(JSON.stringify(nav), async () => {
      const restore = stub(globalThis, 'navigator', nav);
      try {
        assert.equal(await detectPlatform(), want);
      } finally {
        restore();
      }
    });
  }
});

test('listHomes 는 /Users 에서 사람 계정만 고른다', async () => {
  const fs = new FakeFs();
  fs.addFile('/Users/you/.keep', '');
  fs.addFile('/Users/ada/.keep', '');
  fs.addDir('/Users/Shared');
  fs.addDir('/Users/Guest');
  fs.addFile('/Users/.localized', '');
  await withFetch(fs, async () => {
    assert.deepEqual(await listHomes('mac'), ['/Users/ada', '/Users/you']);
  });
});

test('listHomes 는 홈 루트를 못 읽으면 빈 배열이다', async () => {
  await withFetch(new FakeFs(), async () => {
    assert.deepEqual(await listHomes('mac'), []);
  });
});

test('listProfileDirs 는 Preferences 나 Local Extension Settings 로 프로필을 가린다', async () => {
  const fs = new FakeFs();
  const udd = '/Users/you/Library/Application Support/Google/Chrome';
  fs.addFile(`${udd}/Local State`, '{}');
  fs.addFile(`${udd}/Default/Preferences`, '{}');
  fs.addFile(`${udd}/Profile 3/Local Extension Settings/${CLAUDE_ID}/000005.log`, 'x');
  fs.addDir(`${udd}/Profile 10/Cache`); // Preferences 도 확장 저장소도 없다 -> 프로필 아님
  fs.addDir(`${udd}/Crashpad`);
  fs.addFile(`${udd}/System Profile/Preferences`, '{}');
  fs.addFile(`${udd}/Guest Profile/Preferences`, '{}');
  const brave = '/Users/you/Library/Application Support/BraveSoftware/Brave-Browser';
  fs.addFile(`${brave}/Default/Preferences`, '{}');

  await withFetch(fs, async () => {
    const found = await listProfileDirs('mac');
    assert.deepEqual(
      found.map((p) => `${p.browserName}/${p.profileDirName}`),
      ['Google Chrome/Default', 'Google Chrome/Profile 3', 'Brave/Default'],
    );
    assert.equal(found[0].userDataDir, udd);
    assert.equal(found[0].profileDir, `${udd}/Default`);
    assert.equal(found[0].browser, 'chrome');
  });
});

test('listProfileDirs 는 프로필 디렉터리 이름으로 신원을 추정하지 않는다', async () => {
  const fs = new FakeFs();
  const udd = '/Users/you/Library/Application Support/Google/Chrome';
  // "Default" 도 "Profile N" 도 아닌 이름이지만 진짜 프로필이다.
  fs.addFile(`${udd}/사내 계정/Preferences`, '{}');
  await withFetch(fs, async () => {
    const found = await listProfileDirs('mac');
    assert.deepEqual(
      found.map((p) => p.profileDirName),
      ['사내 계정'],
    );
  });
});

test('readProfileMeta 는 Local State 의 info_cache 를 읽는다', async () => {
  const fs = new FakeFs();
  const udd = '/Users/you/Library/Application Support/Google/Chrome';
  fs.addFile(
    `${udd}/Local State`,
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: 'Personal', user_name: 'you@example.com', gaia_name: 'You' },
          'Profile 3': { name: 'Work', user_name: '', gaia_name: null },
          Broken: 'not an object',
        },
      },
    }),
  );
  await withFetch(fs, async () => {
    const meta = await readProfileMeta(udd);
    assert.deepEqual(meta.get('Default'), { name: 'Personal', email: 'you@example.com', gaiaName: 'You' });
    assert.deepEqual(meta.get('Profile 3'), { name: 'Work', email: null, gaiaName: null });
    assert.equal(meta.has('Broken'), false);
  });
});

test('readProfileMeta 는 Local State 가 없거나 깨졌으면 빈 Map 이다', async () => {
  const fs = new FakeFs();
  const udd = '/Users/you/Library/Application Support/Google/Chrome';
  fs.addFile(`${udd}/Local State`, '{ this is not json');
  await withFetch(fs, async () => {
    assert.equal((await readProfileMeta(udd)).size, 0);
    assert.equal((await readProfileMeta('/nope')).size, 0);
  });
});

// ---------------------------------------------------------------------------
// 7. bridgeDeviceId 읽기
// ---------------------------------------------------------------------------

test('readBridge 는 프로필의 bridgeDeviceId 를 읽는다', async () => {
  const fs = new FakeFs();
  const profile = '/Users/you/Library/Application Support/Google/Chrome/Default';
  fs.addFile(
    `${profile}/Local Extension Settings/${CLAUDE_ID}/000005.log`,
    walWith([
      ['bridgeDeviceId', JSON.stringify(FAKE_DEVICE_ID)],
      ['bridgeDisplayName', JSON.stringify('Work')],
    ]),
  );
  await withFetch(fs, async () => {
    const info = await readBridge(profile);
    assert.equal(info.deviceId, FAKE_DEVICE_ID);
    assert.equal(info.displayName, 'Work');
    assert.equal(info.extensionId, CLAUDE_ID);
  });
});

test('readBridge 는 확장이 없는 프로필에 deviceId=null 을 준다', async () => {
  const fs = new FakeFs();
  const profile = '/Users/you/Library/Application Support/Google/Chrome/Default';
  fs.addFile(`${profile}/Preferences`, '{}');
  await withFetch(fs, async () => {
    const info = await readBridge(profile);
    assert.equal(info.deviceId, null);
    assert.equal(info.extensionId, null, '설치돼 있지 않으면 extensionId 도 null');
  });
});

test('readBridge 는 설치는 됐지만 아직 페어링 안 된 경우를 구분한다', async () => {
  const fs = new FakeFs();
  const profile = '/Users/you/Library/Application Support/Google/Chrome/Default';
  fs.addFile(
    `${profile}/Local Extension Settings/${CLAUDE_ID}/000005.log`,
    walWith([['someOtherKey', JSON.stringify('x')]]),
  );
  await withFetch(fs, async () => {
    const info = await readBridge(profile);
    assert.equal(info.deviceId, null);
    assert.equal(info.extensionId, CLAUDE_ID, '디렉터리가 있으면 "설치는 됨" 이다');
  });
});

test('readBridge 는 후보 확장 id 를 우선순위대로 본다', async () => {
  const fs = new FakeFs();
  const profile = '/Users/you/Library/Application Support/Google/Chrome/Default';
  // 첫 후보는 디렉터리만 있고 값이 없다. 두 번째 후보에 값이 있다.
  fs.addFile(
    `${profile}/Local Extension Settings/${CLAUDE_ID}/000005.log`,
    walWith([['other', JSON.stringify('x')]]),
  );
  fs.addFile(
    `${profile}/Local Extension Settings/${CLAUDE_EXTENSION_IDS[1]}/000005.log`,
    walWith([['bridgeDeviceId', JSON.stringify(FAKE_DEVICE_ID_2)]]),
  );
  await withFetch(fs, async () => {
    const info = await readBridge(profile);
    assert.equal(info.deviceId, FAKE_DEVICE_ID_2);
    assert.equal(info.extensionId, CLAUDE_EXTENSION_IDS[1]);
  });
});

test('makeSource 는 디렉터리를 빼고 파일 이름만 넘긴다', async () => {
  const fs = new FakeFs();
  fs.addFile('/db/000005.log', 'x');
  fs.addFile('/db/000007.ldb', 'y');
  fs.addDir('/db/lost');
  await withFetch(fs, async () => {
    const src = makeSource('/db');
    const listed = await src.list();
    assert.deepEqual(listed.names.sort(), ['000005.log', '000007.ldb']);
    assert.equal(decodeUtf8(await src.read('000005.log')), 'x');
    assert.equal(src.path('000005.log'), 'file:///db/000005.log');
  });
});

// ---------------------------------------------------------------------------
// 8. 자기 프로필 탐지 (nonce 왕복)
// ---------------------------------------------------------------------------

test('locateSelf 는 nonce 가 디스크에 나타난 프로필을 고른다', async () => {
  const fs = new FakeFs();
  const udd = '/Users/you/Library/Application Support/Google/Chrome';
  const profiles = [`${udd}/Default`, `${udd}/Profile 3`, `${udd}/Profile 7`];
  for (const p of profiles) {
    // 모든 프로필에 우리 확장이 깔려 있다. 셋 다 같은 키를 갖고 있고, 값만 다르다.
    fs.addFile(
      `${p}/Local Extension Settings/${SELF_EXTENSION_ID}/000005.log`,
      walWith([[NONCE_KEY, JSON.stringify('예전에 다른 창이 쓴 값')]]),
    );
  }
  const self = profiles[1];

  const restoreChrome = stub(globalThis, 'chrome', {
    runtime: { id: SELF_EXTENSION_ID },
    storage: {
      local: {
        // 진짜 크롬처럼: set() 하면 그 값이 곧바로 이 프로필의 WAL 에 나타난다.
        async set(items) {
          fs.addFile(
            `${self}/Local Extension Settings/${SELF_EXTENSION_ID}/000006.log`,
            walWith(
              Object.entries(items).map(([k, v]) => [k, JSON.stringify(v)]),
              1000,
            ),
          );
        },
      },
    },
  });
  try {
    await withFetch(fs, async () => {
      const found = await locateSelf(profiles.map((profileDir) => ({ profileDir })));
      assert.ok(found, '자기 프로필을 찾지 못했습니다');
      assert.equal(found.profileDir, self);
      assert.match(found.nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  } finally {
    restoreChrome();
  }
});

test('locateSelf 는 nonce 가 32KiB 블록 경계를 넘어가도 찾아낸다', async () => {
  // WAL 레코드가 블록 경계를 넘으면 7바이트 헤더가 값 한복판에 박힌다.
  // 부분문자열 검색이었다면 여기서 조용히 실패했을 것이다.
  const fs = new FakeFs();
  const profile = '/Users/you/Library/Application Support/Google/Chrome/Default';
  const dir = `${profile}/Local Extension Settings/${SELF_EXTENSION_ID}`;
  const filler = 'F'.repeat(32 * 1024 - 40);

  const restoreChrome = stub(globalThis, 'chrome', {
    runtime: { id: SELF_EXTENSION_ID },
    storage: {
      local: {
        async set(items) {
          const bytes = walWith([
            ['pad', JSON.stringify(filler)],
            ...Object.entries(items).map(([k, v]) => [k, JSON.stringify(v)]),
          ]);
          // 값이 정말로 블록을 넘겼는지 확인한다. 아니면 이 테스트는 의미가 없다.
          assert.ok(bytes.length > 32 * 1024, 'WAL 이 한 블록 안에 들어가 버렸습니다');
          fs.addFile(`${dir}/000005.log`, bytes);
        },
      },
    },
  });
  try {
    await withFetch(fs, async () => {
      const found = await locateSelf([profile]);
      assert.ok(found, '블록 경계를 넘는 nonce 를 놓쳤습니다');
      assert.equal(found.profileDir, profile);
    });
  } finally {
    restoreChrome();
  }
});

test('locateSelf 는 못 찾으면 null 이다', async () => {
  const fs = new FakeFs();
  const profile = '/Users/you/Library/Application Support/Google/Chrome/Default';
  fs.addFile(`${profile}/Preferences`, '{}');
  const restoreChrome = stub(globalThis, 'chrome', {
    runtime: { id: SELF_EXTENSION_ID },
    storage: { local: { async set() {} } },
  });
  try {
    await withFetch(fs, async () => {
      assert.equal(await locateSelf([profile]), null);
      assert.equal(await locateSelf([]), null);
    });
  } finally {
    restoreChrome();
  }
});

test('locateSelf 는 storage 권한이 없으면 그렇게 말한다', async () => {
  const restoreChrome = stub(globalThis, 'chrome', { runtime: { id: SELF_EXTENSION_ID } });
  try {
    await assert.rejects(() => locateSelf(['/p']), /storage/);
  } finally {
    restoreChrome();
  }
});

// ---------------------------------------------------------------------------
// 9. file:// 응답의 함정
// ---------------------------------------------------------------------------

test('listDir 은 res.ok 나 res.status 를 믿지 않는다', async () => {
  // 진짜 Chromium 은 디렉터리에 status 0 / ok false 를 준다. 그래도 본문은 온다.
  const fs = new FakeFs();
  fs.addFile('/db/000005.log', 'x');
  await withFetch(fs, async () => {
    const entries = await listDir('/db');
    assert.deepEqual(
      entries.map((e) => e.name),
      ['000005.log'],
    );
  });
});

test('listDir 은 없는 디렉터리에서 던진다', async () => {
  await withFetch(new FakeFs(), async () => {
    await assert.rejects(() => listDir('/nope'), /읽지 못했습니다/);
  });
});

test('listDir 은 리스팅이 아닌 응답에서 던진다', async () => {
  // 본문은 왔지만 addRow 도, 리스팅 표식도 없다. 빈 디렉터리와 구별해야 한다.
  const restore = stub(globalThis, 'fetch', async () =>
    fakeResponse(200, new TextEncoder().encode('<html><body>hello</body></html>')),
  );
  try {
    await assert.rejects(() => listDir('/a.txt'), /디렉터리 목록이 아닙니다/);
  } finally {
    restore();
  }
});

test('빈 디렉터리는 에러가 아니라 빈 목록이다', async () => {
  const fs = new FakeFs();
  fs.addDir('/empty');
  await withFetch(fs, async () => {
    assert.deepEqual(await listDir('/empty'), []);
  });
});

test('fetchBytes 는 파일 바이트를 그대로 준다', async () => {
  const fs = new FakeFs();
  fs.addFile('/Users/you/한글 파일.txt', 'ㄱㄴㄷ');
  await withFetch(fs, async () => {
    assert.equal(decodeUtf8(await fetchBytes('/Users/you/한글 파일.txt')), 'ㄱㄴㄷ');
    await assert.rejects(() => fetchBytes('/Users/you/없음.txt'), /읽지 못했습니다/);
  });
});

test('토글이 꺼졌을 때의 에러는 그 사실을 알려 준다', async () => {
  const restore = stub(globalThis, 'fetch', () => Promise.reject(new TypeError('Failed to fetch')));
  try {
    await assert.rejects(() => fetchBytes('/Users/you/a.txt'), /파일 URL에 대한 액세스 허용/);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 10. 없는 경로는 아예 열지 않는다 (콘솔에 남는 net::ERR_FILE_NOT_FOUND 방지)
//
// 크롬은 없는 파일을 fetch 하면 네트워크 스택 차원에서 콘솔에
// `net::ERR_FILE_NOT_FOUND` 를 남긴다. 우리 코드가 그 예외를 잡아도 그 빨간 줄은
// 지워지지 않는다. 그래서 "있는지 모르는 경로"는 부모 목록으로 먼저 확인해야
// 하고, 아래 테스트들이 그 규칙을 고정한다.
// ---------------------------------------------------------------------------

/** 이 머신에 흔한 모양의 가짜 파일 시스템. 브라우저는 크롬 하나만 설치돼 있다. */
function homeWithOneBrowser() {
  const fs = new FakeFs();
  const udd = '/Users/you/Library/Application Support/Google/Chrome';
  fs.addFile(`${udd}/Local State`, JSON.stringify({ profile: { info_cache: { Default: { name: 'Work' } } } }));
  fs.addFile(`${udd}/Default/Preferences`, '{}');
  fs.addFile(
    `${udd}/Default/Local Extension Settings/${CLAUDE_ID}/000004.log`,
    walWith([['bridgeDeviceId', JSON.stringify(FAKE_DEVICE_ID)]]),
  );
  fs.addFile(`${udd}/Profile 1/Preferences`, '{}'); // Claude 도 cici 도 없는 프로필
  fs.addDir(`${udd}/Crashpad`);
  return { fs, udd };
}

/**
 * @param {string[]} log fetch 된 경로들
 * @param {FakeFs} fs
 * @returns {string[]} 존재하지 않는데 열어 본 경로
 */
function missingFetches(log, fs) {
  return log.filter((p) => {
    const clean = p.replace(/\/+$/, '');
    return !fs.files.has(clean) && !fs.dirs.has(clean);
  });
}

test('listProfileDirs 는 설치되지 않은 브라우저의 경로를 열어 보지 않는다', async () => {
  const { fs } = homeWithOneBrowser();
  /** @type {string[]} */
  const log = [];
  await withFetch(
    fs,
    async () => {
      const found = await listProfileDirs('mac');
      assert.deepEqual(found.map((p) => p.profileDirName), ['Default', 'Profile 1']);
    },
    log,
  );
  assert.deepEqual(missingFetches(log, fs), [], '없는 경로를 열면 콘솔에 net::ERR_FILE_NOT_FOUND 가 남습니다');
});

test('readBridge 는 설치되지 않은 확장의 경로를 열어 보지 않는다', async () => {
  const { fs, udd } = homeWithOneBrowser();
  /** @type {string[]} */
  const log = [];
  await withFetch(
    fs,
    async () => {
      // 확장이 있는 프로필과 없는 프로필 둘 다.
      assert.equal((await readBridge(`${udd}/Default`)).deviceId, FAKE_DEVICE_ID);
      const none = await readBridge(`${udd}/Profile 1`);
      assert.equal(none.deviceId, null);
      assert.equal(none.extensionId, null);
      assert.deepEqual(none.warnings, []);
    },
    log,
  );
  assert.deepEqual(missingFetches(log, fs), []);
  // 후보 id 3개를 각각 열어 보지 않았는지 (Local Extension Settings 목록 한 번이면 된다)
  for (const id of CLAUDE_EXTENSION_IDS.slice(1)) {
    assert.equal(log.some((p) => p.includes(id)), false, `${id} 를 열어 봤습니다`);
  }
});

test('locateSelf 는 우리 확장이 없는 프로필의 저장소를 열어 보지 않는다', async () => {
  const { fs, udd } = homeWithOneBrowser();
  /** @type {string[]} */
  const log = [];
  const restore = stub(globalThis, 'chrome', {
    runtime: { id: SELF_EXTENSION_ID },
    storage: {
      local: {
        async set(items) {
          fs.addFile(
            `${udd}/Default/Local Extension Settings/${SELF_EXTENSION_ID}/000007.log`,
            walWith(Object.entries(items).map(([k, v]) => [k, JSON.stringify(v)])),
          );
        },
      },
    },
  });
  try {
    await withFetch(
      fs,
      async () => {
        const self = await locateSelf([`${udd}/Default`, `${udd}/Profile 1`]);
        assert.equal(self?.profileDir, `${udd}/Default`);
      },
      log,
    );
  } finally {
    restore();
  }
  assert.deepEqual(missingFetches(log, fs), []);
});

test('readProfileMeta 는 Local State 가 없으면 열어 보지도 않는다', async () => {
  const fs = new FakeFs();
  const udd = '/Users/you/Library/Application Support/Chromium';
  fs.addFile(`${udd}/Default/Preferences`, '{}'); // Local State 없음
  /** @type {string[]} */
  const log = [];
  await withFetch(
    fs,
    async () => {
      assert.equal((await readProfileMeta(udd)).size, 0);
    },
    log,
  );
  assert.deepEqual(missingFetches(log, fs), []);
});

test('makeSource 의 has() 는 목록으로 답한다 (MANIFEST 가 없는 테이블을 가리켜도 열지 않는다)', async () => {
  const fs = new FakeFs();
  const dir = '/Users/you/db';
  fs.addFile(`${dir}/000001.log`, 'x');
  /** @type {string[]} */
  const log = [];
  await withFetch(
    fs,
    async () => {
      const source = makeSource(dir);
      assert.equal(await source.has('000001.log'), true);
      assert.equal(await source.has('000009.ldb'), false);
      assert.deepEqual((await source.list()).names, ['000001.log']);
    },
    log,
  );
  assert.deepEqual(missingFetches(log, fs), []);
  assert.equal(log.filter((p) => p.endsWith('/db/')).length, 1, '목록은 한 번만 읽어야 합니다');
});

test('listDirOrNull 은 결과를 캐시하고 resetDirCache 로 비워진다', async () => {
  const fs = new FakeFs();
  fs.addFile('/Users/you/a/b.txt', 'x');
  /** @type {string[]} */
  const log = [];
  await withFetch(
    fs,
    async () => {
      assert.equal((await listDirOrNull('/Users/you/a')).length, 1);
      assert.equal((await listDirOrNull('/Users/you/a/')).length, 1);
      assert.equal(log.length, 1, '두 번째 호출은 캐시에서 와야 합니다');
      assert.equal(await listDirOrNull('/Users/you/없음'), null);

      resetDirCache();
      await listDirOrNull('/Users/you/a');
      assert.equal(log.filter((p) => p.startsWith('/Users/you/a')).length, 2, '캐시를 비우면 다시 읽어야 합니다');
    },
    log,
  );
});

test('resolveDirPath 는 한 조각씩 확인하며 내려간다', async () => {
  const fs = new FakeFs();
  fs.addFile('/Users/you/Library/Application Support/Google/Chrome/Local State', '{}');
  fs.addFile('/Users/you/Library/Application Support/Google/Chrome/Default/Preferences', '{}');
  /** @type {string[]} */
  const log = [];
  await withFetch(
    fs,
    async () => {
      assert.equal(
        await resolveDirPath('/Users/you', 'Library/Application Support/Google/Chrome'),
        '/Users/you/Library/Application Support/Google/Chrome',
      );
      // 마지막 조각이 없으면 null 이고, 그 경로를 열어 보지도 않는다.
      assert.equal(await resolveDirPath('/Users/you', 'Library/Application Support/Google/Chrome Beta'), null);
      // 파일은 디렉터리가 아니다.
      assert.equal(await resolveDirPath('/Users/you', 'Library/Application Support/Google/Chrome/Local State'), null);
      // 없는 홈: 시작점 자체는 열어 보지만(그것 말고는 확인할 방법이 없다)
      // 그 아래로는 한 조각도 더 내려가지 않는다. 실제로는 시작점이 언제나
      // listHomes 가 목록에서 골라 준 홈이라 존재한다.
      assert.equal(await resolveDirPath('/Users/nobody', 'Library'), null);
    },
    log,
  );
  assert.deepEqual(missingFetches(log, fs), ['/Users/nobody/']);
});

test('findChildFile 은 파일만 고르고 findChildDir 은 디렉터리만 고른다', async () => {
  const fs = new FakeFs();
  fs.addFile('/Users/you/dir/f.txt', 'x');
  await withFetch(fs, async () => {
    assert.equal(await findChildFile('/Users/you/dir', 'f.txt'), '/Users/you/dir/f.txt');
    assert.equal(await findChildFile('/Users/you', 'dir'), null);
    assert.equal(await findChildDir('/Users/you', 'dir'), '/Users/you/dir');
    assert.equal(await findChildDir('/Users/you/dir', 'f.txt'), null);
    assert.equal(await findChildDir('/Users/nobody', 'dir'), null);
  });
});

// ---------------------------------------------------------------------------
// 11. _locales 카탈로그
// ---------------------------------------------------------------------------

/** ko / en 두 카탈로그를 읽는다. */
async function locales() {
  const out = {};
  for (const lang of ['ko', 'en']) {
    out[lang] = JSON.parse(await readFile(path.join(EXT, '_locales', lang, 'messages.json'), 'utf8'));
  }
  return out;
}

/** popup.html / popup.js / manifest.json 이 실제로 쓰는 메시지 키. */
async function usedMessageKeys() {
  const html = await readFile(path.join(EXT, 'popup.html'), 'utf8');
  const js = await readFile(path.join(EXT, 'popup.js'), 'utf8');
  const manifest = await readFile(path.join(EXT, 'manifest.json'), 'utf8');
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-title|-aria)?="([^"]+)"/g)) keys.add(m[1]);
  for (const m of js.matchAll(/\bt\(\s*'([^']+)'/g)) keys.add(m[1]);
  for (const m of manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) keys.add(m[1]);
  return keys;
}

test('_locales: ko 와 en 의 키가 정확히 같다', async () => {
  const { ko, en } = await locales();
  assert.deepEqual(Object.keys(ko).sort(), Object.keys(en).sort());
  for (const key of Object.keys(ko)) {
    for (const [lang, cat] of [['ko', ko], ['en', en]]) {
      assert.equal(typeof cat[key].message, 'string', `${lang}/${key}: message 가 없습니다`);
      assert.notEqual(cat[key].message.trim(), '', `${lang}/${key}: message 가 비었습니다`);
    }
    assert.deepEqual(
      Object.keys(ko[key].placeholders ?? {}).sort(),
      Object.keys(en[key].placeholders ?? {}).sort(),
      `${key}: placeholders 가 다릅니다`,
    );
  }
});

test('_locales: 쓰는 키는 다 있고, 안 쓰는 키는 없다', async () => {
  const { ko } = await locales();
  const used = await usedMessageKeys();
  const have = new Set(Object.keys(ko));
  const missing = [...used].filter((k) => !have.has(k)).sort();
  const unused = [...have].filter((k) => !used.has(k)).sort();
  assert.deepEqual(missing, [], '카탈로그에 없는 키를 쓰고 있습니다');
  assert.deepEqual(unused, [], '아무도 쓰지 않는 키가 남아 있습니다');
});

test('_locales: $PLACEHOLDER$ 는 선언된 것만 쓴다', async () => {
  const { ko, en } = await locales();
  for (const [lang, cat] of [['ko', ko], ['en', en]]) {
    for (const [key, entry] of Object.entries(cat)) {
      const declared = new Set(Object.keys(entry.placeholders ?? {}).map((n) => n.toLowerCase()));
      for (const m of entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)) {
        assert.ok(declared.has(m[1].toLowerCase()), `${lang}/${key}: 선언되지 않은 $${m[1]}$`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 도우미
// ---------------------------------------------------------------------------

/**
 * `extension/` 아래의 모든 .js / .mjs 파일.
 * @returns {Promise<string[]>}
 */
async function extensionScripts() {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = async (dir) => {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) await walk(full);
      else if (/\.m?js$/.test(d.name)) out.push(full);
    }
  };
  await walk(EXT);
  return out;
}

/**
 * manifest.json 을 읽는다. 없으면 테스트가 실패한다(다른 파일들이 그걸 전제한다).
 * @returns {Promise<Record<string, any>>}
 */
async function readManifest() {
  const file = path.join(EXT, 'manifest.json');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    assert.fail(`extension/manifest.json 이 없습니다 (${err.code ?? err.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    return assert.fail(`extension/manifest.json 이 올바른 JSON 이 아닙니다: ${err.message}`);
  }
}

/**
 * 전역 속성을 잠깐 갈아 끼운다.
 *
 * @param {object} target
 * @param {string} key
 * @param {unknown} value
 * @returns {() => void} 되돌리는 함수
 */
function stub(target, key, value) {
  const had = Object.prototype.hasOwnProperty.call(target, key);
  const old = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  return () => {
    if (had && old) Object.defineProperty(target, key, old);
    else delete target[key];
  };
}

/**
 * `chrome.storage.local` 이 저장하는 그대로: 키는 날문자열, 값은 JSON.
 *
 * @param {Array<[string, string]>} pairs
 * @param {number} [sequence] 나중에 쓴 값이 이겨야 하므로 시퀀스가 중요하다
 * @returns {Uint8Array}
 */
function walWith(pairs, sequence = 1) {
  return buildLogFile([
    {
      sequence,
      records: pairs.map(([key, value]) => ({ type: TYPE_VALUE, key, value })),
    },
  ]);
}

/**
 * 아주 작은 가짜 파일 시스템. 디렉터리는 파일 경로에서 자동으로 생긴다.
 */
class FakeFs {
  constructor() {
    /** @type {Map<string, Uint8Array>} */
    this.files = new Map();
    /** @type {Set<string>} */
    this.dirs = new Set(['']);
  }

  /**
   * @param {string} p 절대 경로
   * @param {string|Uint8Array} content
   */
  addFile(p, content) {
    this.files.set(p, typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content));
    this.addDir(p.slice(0, p.lastIndexOf('/')));
  }

  /** @param {string} p */
  addDir(p) {
    let d = p;
    while (d !== '' && !this.dirs.has(d)) {
      this.dirs.add(d);
      d = d.slice(0, d.lastIndexOf('/'));
    }
  }

  /**
   * @param {string} dir 끝에 / 가 없는 절대 경로 ("" 는 루트)
   * @returns {Map<string, boolean>|null} 이름 -> 디렉터리인가
   */
  children(dir) {
    if (!this.dirs.has(dir)) return null;
    const prefix = `${dir}/`;
    /** @type {Map<string, boolean>} */
    const out = new Map();
    const add = (p, isDir) => {
      if (!p.startsWith(prefix)) return;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) out.set(rest, isDir);
      else out.set(rest.slice(0, slash), true);
    };
    for (const p of this.files.keys()) add(p, false);
    for (const p of this.dirs) if (p !== dir) add(p, true);
    // 진짜 리스팅처럼 디렉터리를 먼저, 그다음 이름순으로 낸다.
    return new Map(
      [...out].sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) : a[1] ? -1 : 1)),
    );
  }
}

/** Chromium 의 `base::EscapeJSONString` 과 같은 규칙. */
function escapeJsonString(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '<') out += '\\u003C';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out;
}

/**
 * Chromium 이 만드는 것과 같은 모양의 디렉터리 리스팅 HTML.
 * 헤더의 `function addRow(...)` 선언까지 그대로 넣어, 파서가 매번 그걸 걸러야
 * 하도록 만든다.
 *
 * @param {string} dirPath
 * @param {Map<string, boolean>} children
 * @param {FakeFs} fs
 * @returns {string}
 */
function listingHtml(dirPath, children, fs) {
  let html =
    '<!DOCTYPE html>\n<html dir="ltr" lang="ko">\n<head>\n<meta charset="utf-8">\n<script>\n' +
    'function addRow(name, url, isdir,\n    size, size_string, date_modified, date_modified_string) {\n' +
    '  if (name == "." || name == "..")\n    return;\n  /* ... */\n}\n</script>\n</head>\n<body>\n';
  html += `<script>start("${escapeJsonString(`${dirPath}/`)}");</script>\n`;
  html += '<script>onHasParentDirectory();</script>\n';
  for (const [name, isDir] of children) {
    const bytes = isDir ? 64 : (fs.files.get(`${dirPath}/${name}`)?.length ?? 0);
    html +=
      `<script>addRow("${escapeJsonString(name)}","${encodeURIComponent(name)}",${isDir ? 1 : 0},` +
      `${bytes},"${bytes} B",1788438416,"26. 9. 3.");</script>\n`;
  }
  return `${html}</body>\n</html>\n`;
}

/**
 * `file://` fetch 를 가짜 파일 시스템으로 갈아 끼우고 `fn` 을 돌린다.
 *
 * 진짜 Chromium 을 그대로 흉내 낸다: 디렉터리는 status 0 / ok false 에 리스팅
 * 본문, 파일은 status 200, 없는 경로는 `TypeError("Failed to fetch")` 로 reject.
 *
 * @param {FakeFs} fs
 * @param {() => Promise<void>} fn
 */
async function withFetch(fs, fn, log) {
  const restore = stub(globalThis, 'fetch', async (url) => {
    const u = new URL(String(url));
    if (u.protocol !== 'file:') throw new TypeError('Failed to fetch');
    let p = decodeURIComponent(u.pathname);
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    const isDirRequest = p.endsWith('/');
    const dir = isDirRequest ? p.replace(/\/+$/, '') : p;
    if (log) log.push(p);

    const kids = fs.children(dir);
    if (kids) {
      const html = listingHtml(dir, kids, fs);
      const bytes = new TextEncoder().encode(html);
      return fakeResponse(0, bytes);
    }
    if (isDirRequest) throw new TypeError('Failed to fetch');
    const bytes = fs.files.get(p);
    if (!bytes) throw new TypeError('Failed to fetch');
    return fakeResponse(200, bytes);
  });
  // 디렉터리 목록 캐시는 한 번의 검사 안에서만 유효하다. 가짜 파일 시스템이
  // 바뀌었는데 앞 테스트의 목록이 남아 있으면 안 된다.
  resetDirCache();
  try {
    await fn();
  } finally {
    restore();
    resetDirCache();
  }
}

/**
 * `Response` 로는 status 0 을 만들 수 없어서(생성자가 200 미만을 거부한다) 직접
 * 만든다. 우리 코드가 쓰는 표면은 status / text() / arrayBuffer() 뿐이다.
 *
 * @param {number} status
 * @param {Uint8Array} bytes
 */
function fakeResponse(status, bytes) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return decodeUtf8(bytes);
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

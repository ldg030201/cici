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
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COPIED_FILES, generatedContent, generatedHeader } from '../scripts/build-extension.mjs';
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
// src/ 쪽 원본. 확장에 손으로 옮겨 적은 표들이 원본과 어긋나지 않았는지 대조한다.
// (확장 코드가 src 를 import 하는 것이 아니라 테스트만 양쪽을 본다. "extension 에
// node: 임포트 없음" 규칙은 그대로다.)
import {
  BRIDGE_DEVICE_ID_KEY as SRC_DEVICE_ID_KEY,
  BRIDGE_DISPLAY_NAME_KEY as SRC_DISPLAY_NAME_KEY,
  CLAUDE_EXTENSION_IDS as SRC_CLAUDE_EXTENSION_IDS,
} from '../src/claude.js';
import { BROWSERS as SRC_BROWSERS, candidateUserDataDirs } from '../src/browsers.js';
import { BRIDGE_DEVICE_ID_KEY, BRIDGE_DISPLAY_NAME_KEY } from '../extension/lib/read.js';
import { buildLogFile, TYPE_VALUE } from './helpers/leveldb-writer.js';
import { FakeFs, fakeResponse, listingHtml, stub, walWith, withFetch } from './helpers/fake-file-url.js';

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

test('빌드 스크립트는 심볼릭 링크를 지나는 절대 경로로 불러도 돈다 (그리고 --check 는 아무것도 쓰지 않는다)', async () => {
  // ESM 로더는 진입점을 realpath 로 풀어서 import.meta.url 을 만들지만
  // path.resolve() 는 링크를 풀지 않는다. 그래서 "직접 실행인가" 판정이 어긋나면
  // 스크립트가 아무 일도 하지 않고 exit 0 으로 끝난다 — "빌드는 성공했는데
  // 동기화 테스트만 계속 빨간" 상태가 조용히 생긴다. macOS 는 /tmp 자체가
  // /private/tmp 로의 링크라 특수한 설정도 필요 없다.
  //
  // **반드시 `--check` 로만 부른다.** 링크가 가리키는 것은 임시 디렉터리가 아니라
  // 진짜 저장소이고(REPO_ROOT 는 realpath 로 풀린다), 쓰기 모드로 부르면 이
  // 테스트가 작업 트리의 extension/lib 을 고쳐 쓴다. 그러면 바로 위 동기화
  // 검사가 첫 실행에서 실패한 뒤 같은 실행 안에서 스스로 고쳐져 두 번째부터
  // 초록이 되고(= 검사가 자기를 무력화한다), 복사본에 넣어 둔 디버그 한 줄이
  // 경고 없이 사라진다. 아래에서 실제로 안 썼는지까지 확인한다.
  const before = new Map(
    await Promise.all(COPIED_FILES.map(async (n) => [n, await readFile(path.join(LIB, n))])),
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), 'cici-link-'));
  const link = path.join(dir, 'repo');
  try {
    await symlink(REPO, link, 'dir');
    const run = promisify(execFile);
    const args = [path.join(link, 'scripts', 'build-extension.mjs'), '--check'];
    let stdout;
    try {
      ({ stdout } = await run(process.execPath, args, { cwd: os.tmpdir() }));
    } catch (err) {
      // 어긋나 있으면 --check 는 exit 1 로 끝난다. 그건 위 테스트가 이미 말해
      // 주므로 여기서는 출력만 본다.
      stdout = err.stdout ?? '';
    }
    for (const name of COPIED_FILES) {
      assert.match(stdout, new RegExp(name.replace('.', '\\.')), `${name} 을 처리했다는 출력이 없습니다`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  for (const [name, bytes] of before) {
    const now = await readFile(path.join(LIB, name));
    assert.ok(now.equals(bytes), `테스트가 extension/lib/${name} 을 고쳐 썼습니다. npm test 는 읽기 전용이어야 합니다.`);
  }
});

test('src/ 와 이름이 겹치는 extension/lib 파일은 COPIED_FILES 가 전부다', async () => {
  // 동기화 검사가 COPIED_FILES 목록만 본다면, 그 목록에 이름을 넣는 것을 잊은
  // 복사본은 검사 대상 자체가 아니다 — src/ 원본과 다른 코드로 남아도 아무도
  // 모르고, "CLI 와 확장이 같은 파서를 쓴다"는 이 구조의 전제가 조용히 깨진다.
  // 그래서 목록이 아니라 디렉터리를 진실로 삼아 대조한다.
  const inSrc = new Set((await readdir(path.join(REPO, 'src'))).filter((n) => n.endsWith('.js')));
  const inLib = (await readdir(LIB)).filter((n) => n.endsWith('.js'));
  const shared = inLib.filter((n) => inSrc.has(n)).sort();
  assert.deepEqual(
    shared,
    [...COPIED_FILES].sort(),
    'src/ 와 이름이 같은 extension/lib 파일은 전부 COPIED_FILES 에 있어야 합니다 (scripts/build-extension.mjs).',
  );
});

test('extension/lib 에 검사받지 않는 생성물이 남아 있지 않다', async () => {
  // COPIED_FILES 에서 이름을 빼거나 바꾸면 옛 복사본이 헤더를 단 채 남는다.
  // 그 파일은 갱신도 검사도 받지 않는데 확장은 계속 그것을 import 할 수 있다.
  const headered = [];
  for (const name of (await readdir(LIB)).filter((n) => n.endsWith('.js'))) {
    const text = await readFile(path.join(LIB, name), 'utf8');
    if (text.startsWith(generatedHeader(name))) headered.push(name);
  }
  assert.deepEqual(
    headered.sort(),
    [...COPIED_FILES].sort(),
    '자동 생성 헤더가 붙은 파일과 COPIED_FILES 가 어긋납니다. "npm run build:ext" 가 낡은 복사본을 지웁니다.',
  );
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

test('manifest.json 의 CSP 가 팝업의 외부 전송을 막는다', async () => {
  // 파일 접근 토글이 켜지면 이 확장은 디스크 전체를 읽을 수 있고, 팝업은 이
  // 머신 모든 프로필의 bridgeDeviceId·이메일·프로필 이름을 한 화면에 모은다.
  // MV3 기본 CSP 에는 connect-src 도 img-src 도 없어서 fetch/sendBeacon/이미지
  // 비콘이 전부 나간다(랩 실측: 다섯 채널 모두 와이어까지 도달). 팝업 각주가
  // 두 언어로 "아무 데도 보내지 않습니다"라고 선언하는 이상, 그 불변식은 코드
  // 규율이 아니라 매니페스트에 박혀 있어야 한다.
  const manifest = await readManifest();
  const csp = manifest.content_security_policy?.extension_pages;
  assert.equal(typeof csp, 'string', 'extension_pages CSP 가 필요합니다');

  const directives = new Map(
    csp
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name, values];
      }),
  );

  assert.deepEqual(directives.get('default-src'), ["'self'"], "default-src 는 'self' 여야 합니다");
  // file: 을 빼면 확장이 죽는다(실측: 첫 file:///Users/ fetch 가 connect-src 로 막힌다).
  assert.deepEqual(
    [...(directives.get('connect-src') ?? [])].sort(),
    ["'self'", 'file:'],
    "connect-src 는 'self' 와 file: 만 허용해야 합니다",
  );
  for (const name of ['object-src', 'form-action', 'frame-src', 'child-src']) {
    assert.deepEqual(directives.get(name), ["'none'"], `${name} 은 'none' 이어야 합니다`);
  }
  assert.deepEqual(directives.get('base-uri'), ["'none'"], "base-uri 는 'none' 이어야 합니다");
});

test('manifest.json 에는 사용자가 문제를 알릴 곳이 적혀 있다', async () => {
  // 오류 화면이 "알려 주세요"라고 말하는데 알릴 곳이 없으면 지시를 따를 수 없다.
  // popup.js 는 이 값을 chrome.runtime.getManifest() 로 읽는다(코드에 주소를
  // 박지 않는다).
  const manifest = await readManifest();
  assert.match(manifest.homepage_url ?? '', /^https:\/\/\S+$/, 'homepage_url 이 필요합니다');
});

// ---------------------------------------------------------------------------
// 3-2. 소스 레벨 잠금장치
//
// CSP 가 런타임 강제라면 이 두 검사는 소스 레벨 잠금이다. 둘 중 하나만 있으면
// 다른 하나가 뚫렸을 때 알아챌 방법이 없다.
// ---------------------------------------------------------------------------

test('extension/ 은 HTML 주입 싱크를 쓰지 않는다', async () => {
  // 팝업이 그리는 값(프로필 이름, bridgeDisplayName)은 사용자가 정한 임의
  // 문자열이다. 지금은 전부 textContent 로 들어가지만, 그 규칙을 지키는 것은
  // 규율뿐이다.
  const SINKS = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new\s+Function)\b/;
  const files = [...(await extensionScripts()), path.join(EXT, 'popup.html')];
  for (const file of files) {
    const source = stripComments(await readFile(file, 'utf8'));
    const hit = SINKS.exec(source);
    assert.equal(hit, null, `${path.relative(EXT, file)}: HTML 주입 싱크 ${hit?.[1]}`);
  }
});

test('extension/ 의 fetch 는 file:// 만 연다', async () => {
  // 팝업 각주의 "아무 데도 보내지 않습니다"를 지키는 것은 이 성질 하나다.
  // 유출 코드는 .catch(() => {}) 한 줄이면 다른 어떤 테스트도 건드리지 않고
  // 조용히 통과한다(뮤테이션으로 확인됨).
  const NETWORK = /\b(XMLHttpRequest|WebSocket|EventSource|sendBeacon|navigator\.connection)\b/;
  const HTTP_LITERAL = /['"`]https?:\/\//g;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  for (const file of await extensionScripts()) {
    const rel = path.relative(EXT, file);
    const source = stripComments(await readFile(file, 'utf8'));

    const network = NETWORK.exec(source);
    assert.equal(network, null, `${rel}: 네트워크 API ${network?.[1]}`);

    for (const m of source.replaceAll(SVG_NS, 'svg-namespace').matchAll(HTTP_LITERAL)) {
      assert.fail(`${rel}: http(s) 주소 리터럴이 있습니다 (${source.slice(m.index, m.index + 60)})`);
    }

    const fetches = [...source.matchAll(/\bfetch\s*\(/g)];
    if (rel !== path.join('lib', 'fileurl.js')) {
      assert.equal(fetches.length, 0, `${rel}: fetch 는 lib/fileurl.js 에만 있어야 합니다`);
      continue;
    }

    assert.equal(fetches.length, 1, 'lib/fileurl.js 의 fetch 는 fetchAs 한 곳뿐이어야 합니다');
    for (const fn of source.split(/^(?:export )?(?:async )?function /m)) {
      if (!/\bfetch\s*\(/.test(fn)) continue;
      const name = /^(\w+)/.exec(fn)?.[1] ?? '?';
      assert.equal(name, 'fetchAs', `lib/fileurl.js: ${name}() 이 fetch 를 부릅니다`);
      assert.match(fn, /fetch\(url,/, `lib/fileurl.js: ${name}() 이 url 말고 다른 것을 fetch 합니다`);
    }

    // fetchAs 는 URL 을 직접 만들지 않고 받는다(부르는 쪽이 에러 문구에도 같은
    // 값을 쓰기 때문이다). 그러니 "fetch 는 file:// 만 연다"는 성질은 두 곳에서
    // 지켜진다 — fetchAs 를 부를 때 넘기는 것이 url 변수인지, 그리고 이 파일의
    // url 변수가 전부 toFileUrl() 이 만든 것인지.
    const passed = [...source.matchAll(/\bfetchAs\(([^,]+),/g)].map((m) => m[1].trim());
    assert.ok(passed.length >= 2, `fetchAs 호출을 찾지 못했습니다: ${passed.length}개`);
    for (const arg of passed) {
      assert.equal(arg, 'url', `lib/fileurl.js: fetchAs 에 url 말고 ${arg} 를 넘깁니다`);
    }
    const urls = [...source.matchAll(/\bconst url = ([^;]+);/g)].map((m) => m[1].trim());
    assert.ok(urls.length >= 2, `url 선언을 찾지 못했습니다: ${urls.length}개`);
    for (const decl of urls) {
      assert.match(decl, /^toFileUrl\(/, `lib/fileurl.js: url 이 toFileUrl 을 거치지 않습니다 (${decl})`);
    }
  }
});

test('file:// fetch 에는 전부 타임아웃이 붙는다', async () => {
  // Chromium 은 FIFO 를 리스팅에 isdir=0, 크기 0 인 평범한 파일로 내놓는다.
  // 그런 이름이 000005.log 면 우리는 WAL 로 알고 여는데, FIFO 의 open(2) 은
  // 블록되므로 그 fetch 는 resolve 도 reject 도 하지 않는다(실측: 25초 뒤에도
  // pending). 타임아웃이 없으면 팝업이 스켈레톤에서 영원히 멈춘다.
  const fs = new FakeFs();
  fs.addFile('/Users/you/db/000005.log', 'x');
  /** @type {Array<RequestInit|undefined>} */
  const options = [];
  const restore = stub(globalThis, 'fetch', async (url, init) => {
    options.push(init);
    const u = new URL(String(url));
    const p = decodeURIComponent(u.pathname);
    const kids = fs.children(p.replace(/\/+$/, ''));
    if (kids) return fakeResponse(0, new TextEncoder().encode(listingHtml(p.replace(/\/+$/, ''), kids, fs)));
    return fakeResponse(200, fs.files.get(p) ?? new Uint8Array());
  });
  try {
    resetDirCache();
    await listDir('/Users/you/db');
    await fetchBytes('/Users/you/db/000005.log');
  } finally {
    restore();
    resetDirCache();
  }
  assert.equal(options.length, 2, '리스팅과 파일 읽기 둘 다 나갔어야 합니다');
  for (const init of options) {
    assert.ok(init && init.signal, 'fetch 에 AbortSignal 이 없습니다');
    assert.equal(typeof init.signal.aborted, 'boolean');
  }
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
  { name: '<script>tag.txt', isDir: false },
  { name: '000005.log', isDir: false },
  { name: '000007.ldb', isDir: false },
  { name: '한글 파일.txt', isDir: false },
  { name: 'amp&lt;name.txt', isDir: false },
  { name: "apostrophe'name.txt", isDir: false },
  { name: 'back\\slash.txt', isDir: false },
  { name: 'hash#tag.txt', isDir: false },
  { name: 'newline\ttab.txt', isDir: false },
  { name: 'percent%20literal.txt', isDir: false },
  { name: 'question?.txt', isDir: false },
  { name: 'quote"name.txt', isDir: false },
  { name: 'space name.txt', isDir: false },
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
    // 리스팅에는 크기와 시각도 있지만 DirEntry 는 이름과 isDir 만 담는다.
    assert.deepEqual(Object.keys(got).sort(), ['isDir', 'name'], `${want.name} 에 안 쓰는 필드가 붙었습니다`);
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
  assert.deepEqual(rows, [{ name: 'd', isDir: true }]);
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

test('BROWSERS·BROWSER_DIRS 는 src/browsers.js 의 표와 글자까지 같다', () => {
  // 이 표는 손으로 옮겨 적은 것이고 build:ext 의 복사 대상이 아니다. mac 경로만
  // 다른 테스트의 픽스처가 리터럴로 쓰고 있어서 우연히 지켜지고, win/linux 는
  // macOS 에서 개발하는 한 영원히 검증되지 않는다. src 와 직접 대조한다.
  assert.deepEqual([...BROWSERS], [...SRC_BROWSERS], 'BROWSERS 가 src/browsers.js 와 다릅니다');

  // 확장은 환경변수(LOCALAPPDATA / APPDATA / XDG_CONFIG_HOME)를 볼 수 없으므로
  // src 쪽에도 env:{} 를 줘서 같은 기본값으로 맞춰 놓고 비교한다.
  const cases = [
    ['mac', 'darwin', '/Users/you'],
    ['win', 'win32', 'C:/Users/you'],
    ['linux', 'linux', '/home/you'],
  ];
  for (const [plat, srcPlatform, home] of cases) {
    const want = candidateUserDataDirs({ platform: srcPlatform, home, env: {} })
      .map((c) => [c.browser, c.userDataDir.replace(/\\/g, '/'), c.browserName])
      .sort();
    const got = BROWSER_DIRS[plat].map((d) => [d.browser, `${home}/${d.path}`, d.browserName]).sort();
    assert.deepEqual(got, want, `${plat} 의 user-data-dir 표가 src/browsers.js 와 다릅니다`);
  }
});

test('BROWSER_DIRS 의 경로는 홈 기준 상대 경로다', () => {
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

test('확장의 Claude 확장 id 목록은 src/claude.js 와 같다', () => {
  // 이 목록은 양쪽에 따로 적혀 있고, 확장 쪽은 지금까지 아무도 값을 검사하지
  // 않았다 — 픽스처 경로를 CLAUDE_EXTENSION_IDS[0] 으로 만들기 때문에 값이
  // 무엇이든 테스트가 통과하는 동어반복이었다. id 하나가 틀어지면 웹스토어에
  // 올라간 확장이 모든 프로필에 "Claude 확장이 없습니다"만 띄운다.
  assert.deepEqual([...CLAUDE_EXTENSION_IDS], [...SRC_CLAUDE_EXTENSION_IDS]);
  assert.equal(BRIDGE_DEVICE_ID_KEY, SRC_DEVICE_ID_KEY);
  assert.equal(BRIDGE_DISPLAY_NAME_KEY, SRC_DISPLAY_NAME_KEY);
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

test('readBridge 는 Extensions/<id> 만 있어도 "설치는 됨" 으로 본다', async () => {
  // 크롬은 `Local Extension Settings/<id>/` 를 그 확장이 storage 에 처음 쓰는
  // 순간 만든다. 방금 설치했거나 계정 동기화로 설치만 되고 서비스워커가 한 번도
  // 돈 적 없는 프로필에는 `Extensions/<id>` 만 있다. 그 상태에서 "설치하세요"
  // 라고 말하면 거짓말이고, CLI(src/browsers.js findExtension) 는 정반대로
  // "설치됨, 페어링 전" 이라고 답한다.
  const fs = new FakeFs();
  const profile = '/Users/you/Library/Application Support/Google/Chrome/Default';
  fs.addFile(`${profile}/Preferences`, '{}');
  fs.addFile(`${profile}/Extensions/${CLAUDE_ID}/1.0.90_0/manifest.json`, '{}');
  await withFetch(fs, async () => {
    const info = await readBridge(profile);
    assert.equal(info.extensionId, CLAUDE_ID, '설치는 돼 있다');
    assert.equal(info.deviceId, null, '아직 페어링 전이라 값은 없다');
    assert.equal(info.unreadable, false);
  });
});

test('readBridge 는 프로필 폴더를 못 읽으면 "없음"이 아니라 "모름"이라고 한다', async () => {
  // listDirOrNull 은 모든 실패를 null 로 뭉갠다. 그 값을 "없음"으로 읽으면 권한
  // 문제로 못 읽은 프로필이 경고 한 줄 없이 "Claude 확장이 없는 프로필"로
  // 둔갑한다 — 사용자가 정정할 단서가 하나도 남지 않는다.
  const fs = new FakeFs();
  const profile = '/Users/you/Library/Application Support/Google/Chrome/Default';
  fs.addFile(`${profile}/Local Extension Settings/${CLAUDE_ID}/000005.log`, walWith([['bridgeDeviceId', JSON.stringify(FAKE_DEVICE_ID)]]));

  const blocked = `${profile}/`;
  const inner = new FakeFs();
  inner.files = fs.files;
  inner.dirs = fs.dirs;
  await withFetch(inner, async () => {
    const realFetch = globalThis.fetch;
    const restore = stub(globalThis, 'fetch', async (url, init) => {
      // 프로필 디렉터리 하나만 EACCES 처럼 만든다. 토글 OFF 와 구별 불가능한
      // 바로 그 TypeError 다.
      if (decodeURIComponent(new URL(String(url)).pathname) === blocked) {
        throw new TypeError('Failed to fetch');
      }
      return realFetch(url, init);
    });
    try {
      const info = await readBridge(profile);
      assert.equal(info.unreadable, true, '못 읽었다는 사실이 남아야 합니다');
      assert.equal(info.extensionId, null);
      assert.deepEqual(
        info.warnings.map((w) => w.code),
        ['warnProfileUnreadable'],
        '경고 없이 조용히 "없음"으로 답하면 안 됩니다',
      );
    } finally {
      restore();
    }
  });
});

/**
 * `fs` 를 그대로 쓰되 `deny` 에 든 경로의 fetch 만 TypeError 로 만든다.
 * 권한 없는 폴더/파일의 모습이고, 파일 접근 토글이 꺼졌을 때와 구별할 수 없는
 * 바로 그 에러다.
 *
 * @param {FakeFs} fs
 * @param {string[]} deny 디코드된 경로 (디렉터리는 끝에 /)
 * @param {() => Promise<void>} fn
 */
async function withFetchDenying(fs, deny, fn) {
  await withFetch(fs, async () => {
    const realFetch = globalThis.fetch;
    const restore = stub(globalThis, 'fetch', async (url, init) => {
      if (deny.includes(decodeURIComponent(new URL(String(url)).pathname))) {
        throw new TypeError('Failed to fetch');
      }
      return realFetch(url, init);
    });
    try {
      await fn();
    } finally {
      restore();
    }
  });
}

test('readBridge 는 확장 저장소를 못 읽으면 "페어링 안 됨"이라고 단정하지 않는다', async () => {
  // 확장 폴더는 목록에 보여서 extensionId 가 채워진 뒤, 그 안쪽을 못 읽는 경우다.
  // 여기서 deviceId === null 을 "아직 페어링 안 됨"으로 읽으면, 디스크에 UUID 가
  // 멀쩡히 있는 프로필에게 "페어링하세요"라고 말하게 된다.
  const profile = '/Users/you/Library/Application Support/Google/Chrome/Default';
  const storage = `${profile}/Local Extension Settings/${CLAUDE_ID}`;

  // (a) 저장소 디렉터리 리스팅만 실패
  const a = new FakeFs();
  a.addFile(`${storage}/000005.log`, walWith([['bridgeDeviceId', JSON.stringify(FAKE_DEVICE_ID)]]));
  await withFetchDenying(a, [`${storage}/`], async () => {
    const info = await readBridge(profile);
    assert.equal(info.deviceId, null);
    assert.equal(info.extensionId, CLAUDE_ID, '폴더는 보였으니 설치는 알고 있다');
    assert.equal(info.readFailed, true, '못 읽었다는 사실이 남아야 합니다');
    assert.deepEqual(info.warnings.map((w) => w.code), ['warnDirUnreadable']);
  });

  // (b) 목록은 읽히는데 WAL 파일 하나만 실패. readLevelDbFrom 은 이때 예외를
  //     던지지 않고 경고로 삼키므로, try/catch 만으로는 절대 못 잡는다.
  const b = new FakeFs();
  b.addFile(`${storage}/000005.log`, walWith([['bridgeDeviceId', JSON.stringify(FAKE_DEVICE_ID)]]));
  await withFetchDenying(b, [`${storage}/000005.log`], async () => {
    const info = await readBridge(profile);
    assert.equal(info.deviceId, null);
    assert.equal(info.readFailed, true, '파일 읽기 실패가 조용히 사라지면 안 됩니다');
  });
});

test('readBridge 는 저장소가 비어 있을 뿐인 경우와 못 읽은 경우를 구별한다', async () => {
  // 디렉터리는 읽혔고 LevelDB 파일이 없다. 이건 읽기 실패가 아니라 값이 없는
  // 상태다 — "아직 페어링 안 됨"이 맞는 답이므로 readFailed 를 세우면 안 된다.
  const fs = new FakeFs();
  const profile = '/Users/you/Library/Application Support/Google/Chrome/Default';
  fs.addDir(`${profile}/Local Extension Settings/${CLAUDE_ID}`);
  await withFetch(fs, async () => {
    const info = await readBridge(profile);
    assert.equal(info.extensionId, CLAUDE_ID);
    assert.equal(info.deviceId, null);
    assert.equal(info.readFailed, false, '비어 있는 것과 못 읽은 것은 다릅니다');
    assert.deepEqual(info.warnings.map((w) => w.code), ['warnNoLevelDbFiles']);
  });
});

test('locateSelf 는 우리 저장소를 못 읽으면 이유를 남긴다', async () => {
  // storageHasNonce 가 readLevelDbFrom 의 경고를 버리면, 자기 탐지가 실패했을 때
  // 화면에는 "현재 프로필을 찾지 못했습니다" 한 줄만 남고 왜인지는 어디에도 없다.
  const fs = new FakeFs();
  const profile = '/Users/you/Library/Application Support/Google/Chrome/Default';
  const storage = `${profile}/Local Extension Settings/${SELF_EXTENSION_ID}`;
  fs.addFile(`${storage}/000003.log`, walWith([[NONCE_KEY, JSON.stringify('the-nonce')]]));

  const restoreChrome = stub(globalThis, 'chrome', {
    runtime: { id: SELF_EXTENSION_ID },
    storage: { local: { async set() {} } },
  });
  try {
    await withFetchDenying(fs, [`${storage}/000003.log`], async () => {
      /** @type {Array<{code: string, params: string[]}>} */
      const warnings = [];
      assert.equal(await locateSelf([profile], 'the-nonce', warnings), null);
      const codes = warnings.map((w) => w.code);
      assert.ok(codes.includes('warnProfileUnreadable'), `못 읽었다는 경고가 없습니다: ${JSON.stringify(warnings)}`);
      assert.ok(codes.includes('warnParserNote'), `어느 파일이 왜 실패했는지가 없습니다: ${JSON.stringify(warnings)}`);
      assert.ok(
        warnings.some((w) => w.code === 'warnParserNote' && w.params.join(' ').includes('000003.log')),
        '실패한 파일 이름이 경고에 들어 있어야 합니다',
      );
    });
  } finally {
    restoreChrome();
  }
});

test('locateSelf 는 우리 확장이 없는 프로필을 "못 읽었다"고 하지 않는다', async () => {
  // 위 경고가 남발되면 안 된다. 우리 확장이 그냥 없는 프로필은 정상이다.
  const fs = new FakeFs();
  const profile = '/Users/you/Library/Application Support/Google/Chrome/Default';
  fs.addFile(`${profile}/Preferences`, '{}');
  const restoreChrome = stub(globalThis, 'chrome', {
    runtime: { id: SELF_EXTENSION_ID },
    storage: { local: { async set() {} } },
  });
  try {
    await withFetch(fs, async () => {
      const warnings = [];
      assert.equal(await locateSelf([profile], 'the-nonce', warnings), null);
      assert.deepEqual(warnings, []);
    });
  } finally {
    restoreChrome();
  }
});

test('listProfileDirs 는 못 읽은 프로필을 조용히 버리지 않는다', async () => {
  // 프로필 폴더 하나만 못 읽으면(언마운트된 볼륨, 리스팅 타임아웃) 그 프로필이
  // 목록에서 통째로 사라진다. 그게 하필 지금 창의 프로필이면 자기 탐지까지
  // 실패하는데 경고는 한 줄도 안 남는다.
  const fs = new FakeFs();
  const udd = '/Users/you/Library/Application Support/Google/Chrome';
  fs.addFile(`${udd}/Default/Preferences`, '{}');
  fs.addFile(`${udd}/Profile 1/Preferences`, '{}');
  fs.addFile(
    `${udd}/Local State`,
    JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } } } }),
  );
  await withFetchDenying(fs, [`${udd}/Profile 1/`], async () => {
    /** @type {Array<{code: string, params: string[]}>} */
    const warnings = [];
    const profiles = await listProfileDirs('mac', warnings);
    assert.deepEqual(
      profiles.map((p) => p.profileDirName).sort(),
      ['Default', 'Profile 1'],
      'Local State 가 프로필이라고 확인해 준 후보는 남아야 합니다',
    );
    assert.deepEqual(warnings.map((w) => w.code), ['warnProfileUnreadable']);
    assert.ok(warnings[0].params[0].endsWith('Profile 1'));
  });
});

test('listProfileDirs 는 못 읽은 잡동사니 디렉터리를 프로필로 둔갑시키지 않는다', async () => {
  // 경고는 남기되, Local State 가 확인해 주지 못하는 후보를 행으로 만들면
  // 프로필이 아닌 디렉터리가 유령 프로필로 뜬다.
  const fs = new FakeFs();
  const udd = '/Users/you/Library/Application Support/Google/Chrome';
  fs.addFile(`${udd}/Default/Preferences`, '{}');
  fs.addDir(`${udd}/SomethingElse`);
  fs.addFile(`${udd}/Local State`, JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' } } } }));
  await withFetchDenying(fs, [`${udd}/SomethingElse/`], async () => {
    const warnings = [];
    const profiles = await listProfileDirs('mac', warnings);
    assert.deepEqual(profiles.map((p) => p.profileDirName), ['Default']);
    assert.deepEqual(warnings.map((w) => w.code), ['warnProfileUnreadable'], '버리더라도 말은 해야 합니다');
  });
});

test('readBridge 의 경고는 문장이 아니라 _locales 키다', async () => {
  const fs = new FakeFs();
  const profile = '/Users/you/Library/Application Support/Google/Chrome/Default';
  fs.addFile(`${profile}/Local Extension Settings/${CLAUDE_ID}/000005.log`, walWith([['bridgeDeviceId', '{not json']]));
  await withFetch(fs, async () => {
    const info = await readBridge(profile);
    for (const w of info.warnings) {
      assert.equal(typeof w.code, 'string', `경고가 문자열입니다: ${JSON.stringify(w)}`);
      assert.ok(Array.isArray(w.params));
    }
    assert.ok(
      info.warnings.some((w) => w.code === 'warnBadJson'),
      `깨진 JSON 경고가 없습니다: ${JSON.stringify(info.warnings)}`,
    );
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
    await assert.rejects(() => listDir('/nope'), /cannot read file:\/\/\/nope\//);
  });
});

test('listDir 은 리스팅이 아닌 응답에서 던진다', async () => {
  // 본문은 왔지만 addRow 도, 리스팅 표식도 없다. 빈 디렉터리와 구별해야 한다.
  const restore = stub(globalThis, 'fetch', async () =>
    fakeResponse(200, new TextEncoder().encode('<html><body>hello</body></html>')),
  );
  try {
    await assert.rejects(() => listDir('/a.txt'), /is not a directory listing/);
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
    await assert.rejects(() => fetchBytes('/Users/you/없음.txt'), /cannot read file:/);
  });
});

test('토글이 꺼졌을 때의 에러는 그 사실을 알려 준다', async () => {
  // lib 의 에러 문구는 영어로 고정한다. 사람에게 보이는 문장은 popup.js 가
  // _locales 에서 만들고, 이 문자열은 그 안에 진단 정보로만 끼어들기 때문이다.
  // 로케일마다 언어가 섞이면 안 된다.
  const restore = stub(globalThis, 'fetch', () => Promise.reject(new TypeError('Failed to fetch')));
  try {
    await assert.rejects(() => fetchBytes('/Users/you/a.txt'), /Allow access to file URLs/);
  } finally {
    restore();
  }
});

test('lib/*.js 는 사람이 읽을 문장을 직접 만들지 않는다 (전부 _locales 로)', async () => {
  // 여기서 한국어 문장을 만들면 en 로케일 경고 상자에 한글이 그대로 박힌다.
  // 반대로 leveldb-core 의 영어 경고는 ko 화면에 영어로 나온다. 언어가 섞이지
  // 않게 하려면 lib 은 { code, params } 만 올려 보내야 한다.
  const HANGUL = /[가-힣]/;
  for (const file of ['fileurl.js', 'locate.js', 'read.js']) {
    const source = stripComments(await readFile(path.join(LIB, file), 'utf8'));
    for (const m of source.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      assert.equal(
        HANGUL.test(m[2]),
        false,
        `extension/lib/${file}: 한국어 문자열 리터럴이 있습니다 (${m[0].slice(0, 60)}). ` +
          '문장은 popup.js 가 _locales 에서 만듭니다.',
      );
    }
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

test('makeSource 의 has() 는 목록에 없으면 디렉터리를 한 번 다시 읽는다', async () => {
  // has() 가 불리는 유일한 경로는 "MANIFEST 는 아는데 목록에는 없는 테이블"이다.
  // 우리가 목록을 뜬 뒤 크롬이 flush/compaction 을 끝냈을 때 그렇게 된다.
  // 그 답을 **처음 뜬 목록으로** 하면 언제나 false 라, 코어의 복구 경로가 확장에
  // 서만 통째로 죽는다(페어링된 프로필이 "아직 페어링되지 않았습니다"로 보인다).
  // 그래서 미스일 때만 캐시를 우회해 다시 읽는다. 디렉터리 자체는 반드시
  // 존재하므로 콘솔에 net::ERR_FILE_NOT_FOUND 는 여전히 남지 않는다.
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
      assert.equal(log.filter((p) => p.endsWith('/db/')).length, 1, '히트는 다시 읽지 않아야 합니다');

      // 목록을 뜬 뒤 컴팩션이 끝나 새 테이블이 생겼다.
      fs.addFile(`${dir}/000007.ldb`, 'y');
      assert.equal(await source.has('000007.ldb'), true, '새로 생긴 테이블을 찾아야 합니다');
      assert.equal(log.filter((p) => p.endsWith('/db/')).length, 2, '미스는 한 번 다시 읽습니다');

      assert.equal(await source.has('000009.ldb'), false);
      assert.equal(log.filter((p) => p.endsWith('/db/')).length, 2, '재조회는 소스당 한 번뿐입니다');
    },
    log,
  );
  assert.deepEqual(missingFetches(log, fs), [], '없는 경로를 열어 보지는 않는다');
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

/** popup.html / popup.js / lib/*.js / manifest.json 이 실제로 쓰는 메시지 키. */
async function usedMessageKeys() {
  const html = await readFile(path.join(EXT, 'popup.html'), 'utf8');
  const js = await readFile(path.join(EXT, 'popup.js'), 'utf8');
  const manifest = await readFile(path.join(EXT, 'manifest.json'), 'utf8');
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-title|-aria)?="([^"]+)"/g)) keys.add(m[1]);
  for (const m of js.matchAll(/\bt\(\s*'([^']+)'/g)) keys.add(m[1]);
  for (const m of manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) keys.add(m[1]);
  // lib 은 문장을 만들지 않고 `{ code, params }` 만 올려 보낸다. popup.js 도
  // 경고를 만들 때는 같은 모양을 쓴다. 그 키는 t() 에 변수로 들어가므로
  // t('...') 정규식에 걸리지 않는다 — 여기서 모아야 한다.
  const warnSources = [js, ...(await Promise.all(
    ['fileurl.js', 'locate.js', 'read.js'].map((file) => readFile(path.join(LIB, file), 'utf8')),
  ))];
  for (const source of warnSources) {
    for (const m of source.matchAll(/'(warn[A-Za-z0-9_]+)'/g)) keys.add(m[1]);
  }
  // popup.js 의 bridgeState() 도 같은 이유로 문장 대신 키를 돌려준다. 카드와
  // 목록 행이 똑같은 네 갈래를 쓰기 때문에 판정을 한 곳에 모았고, 그 키는
  // `t(state.title)` 처럼 변수로 t() 에 들어가므로 위 정규식에 걸리지 않는다.
  for (const m of js.matchAll(/\b(?:title|hint):\s*'([^']+)'/g)) keys.add(m[1]);
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

test('_locales: 따옴표로 인용한 버튼 이름은 두 로케일에서 같은 버튼을 가리킨다', async () => {
  // en 의 warnScanTimeout 이 화면에 존재하지 않는 이름("Rescan")을 따옴표로
  // 지시한 적이 있다. 그 버튼의 실제 접근성 이름은 refresh 키의 값("Scan again")
  // 이고, 아이콘만 있는 버튼이라 사용자가 글자로 찾을 방법도 없었다.
  const { ko, en } = await locales();
  const html = await readFile(path.join(EXT, 'popup.html'), 'utf8');

  // popup.html 의 <button> 이 실제로 쓰는 i18n 키.
  const buttonKeys = new Set();
  for (const tag of html.match(/<button\b[\s\S]*?>/g) ?? []) {
    for (const m of tag.matchAll(/data-i18n(?:-title|-aria)?="([^"]+)"/g)) buttonKeys.add(m[1]);
  }
  assert.ok(buttonKeys.has('refresh'), 'popup.html 에서 버튼 키를 찾지 못했습니다');

  // 홑따옴표(ko 의 '다시 시도')와 겹따옴표를 모두 인정한다.
  const quoted = (text) => [...text.matchAll(/["'\u201c\u201d\u2018\u2019]([^"'\u201c\u201d\u2018\u2019]{2,40})["'\u201c\u201d\u2018\u2019]/g)].map((m) => m[1]);

  for (const [from, to, fromLang, toLang] of [[ko, en, 'ko', 'en'], [en, ko, 'en', 'ko']]) {
    for (const key of Object.keys(from)) {
      for (const q of quoted(from[key].message)) {
        const button = [...buttonKeys].find((b) => from[b]?.message === q);
        if (!button) continue; // 버튼 이름이 아니라 크롬 설정 이름이나 manifest 필드다
        const there = quoted(to[key].message);
        assert.ok(
          there.includes(to[button].message),
          `${toLang}/${key}: 버튼 ${button}("${to[button].message}") 를 인용해야 하는데 ` +
            `${JSON.stringify(there)} 를 인용합니다 (${fromLang} 는 "${q}" 를 인용).`,
        );
      }
    }
  }
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
 * 주석을 지운 소스. 소스 스캔 검사가 주석 속 예시 코드에 속지 않게 한다.
 * 문자열 리터럴 안의 `//` 는 주석이 아니다.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  let out = '';
  let quote = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote !== null) {
      out += c;
      if (c === '\\') {
        out += source[i + 1] ?? '';
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
      out += ' ';
      continue;
    }
    if (c === '<' && source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end < 0 ? source.length : end + 2;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

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


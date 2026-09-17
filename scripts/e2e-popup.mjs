/**
 * 릴리스 전 스모크 테스트: 진짜 Chromium 에 확장을 실제로 얹어 팝업을 연다.
 *
 * 단위 테스트(test/popup.test.js)는 chrome/fetch 를 전부 흉내 내므로, "크롬이
 * 정말 이 확장을 로드하고, 파일 접근 토글이 정말 감지되고, 진짜 디스크에서
 * 검사가 정말 끝나는가"는 증명하지 못한다. 이 스크립트가 그 구멍을 메운다.
 * 릴리스 zip 을 올리기 전에 한 번 돌린다 (docs/release.md).
 *
 * 두 장면을 본다.
 *   B. 콜드 스캔(세션 캐시 없음)  → 결과 화면 + 계측 로그 + 첫 화면 시간
 *   C. 같은 세션에서 팝업 재오픈  → 세션 캐시로 즉시 첫 화면
 *
 * "접근 꺼짐 → 안내 화면"(A)은 여기서 재현할 수 없다. --load-extension 으로
 * 얹은 언팩 확장에는 크롬이 파일 접근을 자동으로 켜 주기 때문이다(실측). 그
 * 경로는 test/popup.test.js 의 "파일 접근이 꺼져 있으면…" 이 흉내로 덮는다.
 *
 * 실행 환경에 관하여:
 *   - 이 머신의 **진짜** 크롬 프로필들을 읽기 전용으로 검사한다(그게 목적이다 —
 *     B 의 숫자가 사용자가 체감하는 바로 그 시간이다). 출력에는 개수와 시간만
 *     내보내고 UUID·이메일·프로필 이름은 절대 찍지 않는다.
 *   - 임시 --user-data-dir 로 뜨므로 실제 크롬이 켜져 있어도 충돌하지 않는다.
 *   - 브랜드판 Google Chrome 137+ 는 --load-extension 을 막았다. Chrome for
 *     Testing 또는 Chromium 이 필요하다(플레이라이트 캐시를 자동으로 찾는다).
 *   - Node 22+ (전역 WebSocket). 저장소의 engines(>=18.17)는 라이브러리 기준이고
 *     이 스크립트는 개발 머신 전용이다.
 *
 * 사용법:
 *   npm run e2e:ext
 *   node scripts/e2e-popup.mjs [--chrome=/path/to/chrome] [--profile-dir=DIR] [--keep]
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(REPO, 'extension');

// ---------------------------------------------------------------------------
// 인자
// ---------------------------------------------------------------------------

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

if (typeof globalThis.WebSocket !== 'function') {
  console.error('Node 22 이상이 필요합니다 (전역 WebSocket). 지금:', process.version);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 크롬 찾기
// ---------------------------------------------------------------------------

/** 플레이라이트/퍼피티어 캐시에서 Chrome for Testing 류의 실행 파일을 찾는다. */
async function findTestingChrome() {
  const home = os.homedir();
  const roots = [
    path.join(home, 'Library/Caches/ms-playwright'),
    path.join(home, '.cache/ms-playwright'),
    path.join(home, '.cache/puppeteer/chrome'),
  ];
  const suffixes = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-linux/chrome',
  ];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    // 버전 디렉터리가 여럿이면 이름 역순(대개 최신)으로 시도한다.
    for (const entry of entries.sort().reverse()) {
      for (const suffix of suffixes) {
        const candidate = path.join(root, entry, suffix);
        try {
          await readFile(candidate, { length: 0 });
          return candidate;
        } catch {
          // 다음 후보
        }
      }
    }
  }
  return null;
}

async function resolveChrome() {
  const given = args.get('chrome') ?? process.env.CICI_CHROME;
  if (typeof given === 'string' && given !== '') return given;
  const testing = await findTestingChrome();
  if (testing) return testing;
  // 마지막 수단. 브랜드판은 137+ 에서 --load-extension 을 무시하므로 대개 실패한다.
  console.error(
    'Chrome for Testing 을 찾지 못했습니다. 브랜드판 Chrome 은 --load-extension 을 막습니다.\n' +
      '  npx playwright install chromium  또는  npx @puppeteer/browsers install chrome@stable\n' +
      '을 실행하거나 --chrome=/path/to/chrome 으로 직접 지정하세요.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 확장 id — 언팩 확장의 id 는 절대 경로의 SHA-256 앞 16바이트를 a~p 로 옮긴 것
// ---------------------------------------------------------------------------

/** @param {string} absPath */
function extensionIdFromPath(absPath) {
  const hex = createHash('sha256').update(absPath, 'utf8').digest('hex').slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)]);
}

// ---------------------------------------------------------------------------
// 크롬 실행 + CDP
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} chrome
 * @param {string} userDataDir
 * @returns {Promise<{proc: import('node:child_process').ChildProcess, port: number, stop: () => Promise<void>}>}
 */
async function launchChrome(chrome, userDataDir) {
  // 이전 실행이 남긴 포트 파일을 지운다. 남아 있으면 죽은 포트로 접속한다.
  await rm(path.join(userDataDir, 'DevToolsActivePort'), { force: true });
  const proc = spawn(
    chrome,
    [
      `--user-data-dir=${userDataDir}`,
      `--load-extension=${EXT_DIR}`,
      `--disable-extensions-except=${EXT_DIR}`,
      // 브랜드판 137+ 의 --load-extension 차단을 되돌리는 스위치. CfT 에는 무해하다.
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--headless',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise((resolve) => proc.once('exit', resolve));

  // 포트 0 으로 띄우면 실제 포트가 이 파일에 적힌다.
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  let port = 0;
  while (Date.now() < deadline) {
    try {
      port = Number((await readFile(portFile, 'utf8')).split('\n')[0]);
      if (Number.isInteger(port) && port > 0) break;
    } catch {
      // 아직 안 떴다
    }
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
  if (!(Number.isInteger(port) && port > 0)) {
    proc.kill('SIGKILL');
    throw new Error(`크롬이 뜨지 않았습니다: ${chrome}\n${stderr.slice(-2000)}`);
  }
  return {
    proc,
    port,
    async stop() {
      proc.kill();
      await Promise.race([exited, sleep(5000).then(() => proc.kill('SIGKILL'))]);
    },
  };
}

/** 최소한의 CDP 클라이언트. 이벤트는 onEvent(method, params) 콜백 하나로 받는다. */
class Cdp {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    /** @type {(method: string, params: object) => void} */
    this.onEvent = () => {};
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
        return;
      }
      this.onEvent(msg.method, msg.params);
    });
  }

  /** @param {string} url */
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`WebSocket 연결 실패: ${url}`)), { once: true });
    });
  }

  /**
   * @param {string} method
   * @param {object} [params]
   */
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // 이미 닫혔다
    }
  }
}

// ---------------------------------------------------------------------------
// 팝업 열고 관찰하기
// ---------------------------------------------------------------------------

/** 팝업 DOM 에서 지금 보이는 패널과 (개인정보 없는) 통계를 꺼내는 식. */
const PROBE = `(() => {
  const panels = ['loading', 'access', 'result', 'error'];
  const panel = panels.find((n) => {
    const e = document.getElementById('panel-' + n);
    return e && !e.hidden;
  });
  return JSON.stringify({
    panel: panel ?? null,
    rows: document.querySelectorAll('#others-slot .row').length,
    selfUuid: Boolean(document.querySelector('.card-self .uuid-text')),
    busy: document.getElementById('btn-refresh')?.getAttribute('aria-busy') ?? null,
  });
})()`;

/**
 * 팝업을 새 탭으로 열고, 로딩을 벗어날 때까지 지켜본다.
 *
 * @param {number} port
 * @param {string} popupUrl
 * @param {{settleTimeoutMs?: number, waitScanLog?: boolean}} [options]
 * @returns {Promise<{state: object, firstPaintMs: number, scanLogs: string[]}>}
 */
/**
 * 시각 검증용 가짜 검사 결과. **전부 가짜 값이다** — 실제 UUID·이메일·프로필
 * 이름은 저장소에 절대 들어가지 않는다.
 *
 * 이것을 세션 캐시에 심으면 팝업이 그대로 그린다. 그래서 이 머신에 프로필이
 * 몇 개 있든, 목록이 넘치는 화면·현재 프로필 카드·페어링 안 된 프로필까지
 * 한 장에 담아 눈으로 확인할 수 있다.
 */
const DEMO_SCAN = (() => {
  const mk = (dirName, label, sublabel, deviceId, isSelf, extra = {}) => ({
    browserName: extra.browserName ?? 'Google Chrome',
    userDataDir: '/Users/you/Library/Application Support/Google/Chrome',
    profileDir: `/Users/you/Library/Application Support/Google/Chrome/${dirName}`,
    profileDirName: dirName,
    label,
    sublabel,
    bridge: {
      extensionId: extra.extensionId ?? (deviceId ? 'fcoeoabgfenejglbffodgkkbkcdhcgfn' : null),
      deviceId,
      displayName: extra.displayName ?? null,
      unreadable: false,
      readFailed: false,
      warnings: [],
    },
    isSelf,
  });
  const rows = [
    mk('Default', '개인', 'you@example.com · Default', '11111111-2222-4333-8444-555555555555', true, {
      displayName: '내 노트북',
    }),
    mk('Profile 1', '회사', 'work@example.com · Profile 1', '4f2a9c81-3b5d-4e77-9a10-2c6b8d0e1f34', false),
    mk('Profile 2', '테스트', 'test@example.com · Profile 2', '99999999-8888-4777-8666-555555555555', false),
    mk('Profile 3', '페어링 전', 'Profile 3', null, false),
    mk('Profile 4', '확장 없음', 'Profile 4', null, false, { extensionId: null }),
    mk('Default', 'Brave 프로필', 'Default', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', false, {
      browserName: 'Brave',
    }),
  ];
  return {
    v: 1,
    data: { rows, selfFound: true, warnings: [], truncated: false },
    selfProfileDir: rows[0].profileDir,
  };
})();

async function openPopup(port, popupUrl, options = {}) {
  const {
    settleTimeoutMs = 60000,
    waitScanLog = true,
    shotPath = null,
    lang = null,
    seedDemo = false,
    forceLoading = false,
  } = options;
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(popupUrl)}`, {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`탭을 열지 못했습니다: HTTP ${res.status}`);
  const target = await res.json();

  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  /** @type {string[]} 팝업의 [cici] 계측 로그 (개인정보 없음: 횟수·바이트·ms 뿐) */
  const scanLogs = [];
  cdp.onEvent = (method, params) => {
    if (method !== 'Runtime.consoleAPICalled') return;
    const first = params.args?.[0]?.value;
    if (typeof first === 'string' && first.startsWith('[cici]')) scanLogs.push(first);
  };
  await cdp.send('Runtime.enable');

  let state = null;
  let firstPaintMs = -1;
  const deadline = Date.now() + settleTimeoutMs;
  while (Date.now() < deadline) {
    const { result } = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    state = JSON.parse(result.value);
    if (state.panel !== null && state.panel !== 'loading') {
      firstPaintMs = Date.now() - started;
      break;
    }
    await sleep(25);
  }
  if (firstPaintMs < 0) {
    cdp.close();
    throw new Error(`팝업이 ${settleTimeoutMs}ms 안에 로딩을 벗어나지 못했습니다`);
  }

  // 결과 화면이라면 계측 로그(검사 완료 신호)까지 기다린다 — 캐시가 첫 화면을
  // 그린 경우 재검사는 이 로그가 찍혀야 끝난 것이다.
  if (waitScanLog && state.panel === 'result') {
    const logDeadline = Date.now() + settleTimeoutMs;
    while (scanLogs.length === 0 && Date.now() < logDeadline) await sleep(50);
    // 재검사가 끝난 뒤의 최종 화면을 다시 읽는다.
    const { result } = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    state = JSON.parse(result.value);
  }

  // 언어를 바꿔 보라는 주문이 있으면 바꾸고, 그 전환에 걸린 시간을 잰다.
  // 예전에는 언어를 고를 때마다 검사를 통째로 다시 돌려서 몇 초가 걸렸다.
  let langSwitchMs = -1;
  if (lang !== null) {
    const s = Date.now();
    await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const sel = document.getElementById('lang-select');
        sel.value = ${JSON.stringify(lang)};
        sel.dispatchEvent(new Event('change'));
        // 리스너가 async 다. 카탈로그 fetch 와 다시 그리기가 끝날 때까지 기다린다.
        for (let i = 0; i < 400; i++) {
          await new Promise((r) => setTimeout(r, 5));
          if (document.documentElement.getAttribute('lang') === ${JSON.stringify(lang.replace('_', '-'))}) break;
        }
      })()`,
      awaitPromise: true,
    });
    langSwitchMs = Date.now() - s;
  }

  // 로딩(스켈레톤) 화면은 평소 순식간에 지나가 눈으로 잡을 수가 없다. 검사가
  // 끝난 뒤 그 패널만 도로 띄워서 배치와 색을 본다(움직임은 아래 skeleton 값으로
  // 확인한다 — 정지 화면으로는 알 수 없다).
  let skeleton = null;
  if (forceLoading) {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        for (const n of document.querySelectorAll('.panel')) n.hidden = n.id !== 'panel-loading';
        const el = document.querySelector('.skeleton .sk');
        if (!el) return 'null';
        const s = getComputedStyle(el);
        return JSON.stringify({
          timing: s.animationTimingFunction,
          repeat: s.backgroundRepeat,
          duration: s.animationDuration,
          delays: [...document.querySelectorAll('.skeleton .sk')].map((n) => getComputedStyle(n).animationDelay),
        });
      })()`,
      returnByValue: true,
    });
    skeleton = JSON.parse(result.value ?? 'null');
  }

  // 눈으로 볼 수 있게 화면을 남긴다. 레이아웃이 어긋나는 것은 단언문이 아니라
  // 그림에서 먼저 보인다.
  if (shotPath) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(shotPath, Buffer.from(data, 'base64'));
  }

  // 헤더 배치를 실제 좌표로 확인한다 — "지구본이 한복판에 떠 있다" 같은 문제는
  // 이 숫자로만 잡힌다.
  const { result: geo } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const r = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return {l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width)}; };
      return JSON.stringify({ flag: r('lang-flag'), refresh: r('btn-refresh'), body: Math.round(document.body.getBoundingClientRect().width), flagText: document.getElementById('lang-flag')?.textContent ?? '' });
    })()`,
    returnByValue: true,
  });

  // 가짜 결과는 **맨 마지막에** 심는다. 이 팝업의 재검사가 캐시를 덮어쓴 뒤여야
  // 살아남기 때문이다(검사가 끝나면 그 결과로 캐시가 갱신된다). 다음에 여는
  // 팝업이 이것을 첫 화면으로 그린다.
  if (seedDemo) {
    await cdp.send('Runtime.evaluate', {
      expression: `chrome.storage.session.set(${JSON.stringify({ __cici_scan: DEMO_SCAN })})`,
      awaitPromise: true,
    });
  }

  // 세션 캐시에 무엇이 남았는지. 응답하지 않는 디렉터리를 기억하는 장치가
  // 실제로 동작하는지는 이 값으로만 확인된다.
  const { result: cached } = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const g = await chrome.storage.session.get('__cici_scan');
      const fu = await import('./lib/fileurl.js');
      const s = fu.snapshotFetchStats();
      return JSON.stringify({
        has: Boolean(g.__cici_scan),
        rows: g.__cici_scan?.data?.rows?.length ?? null,
        // 응답하지 않는 디렉터리 수. 경로 자체는 [cici] slow read 줄이 이미
        // (홈 아래 이름을 지운 채로) 보여 준다.
        stalled: (g.__cici_scan?.stalled ?? []).length,
        reads: s.count,
      });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  cdp.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
  return {
    state,
    firstPaintMs,
    scanLogs,
    langSwitchMs,
    geo: JSON.parse(geo.value),
    cache: JSON.parse(cached.value ?? 'null'),
    skeleton,
  };
}

// ---------------------------------------------------------------------------
// 본편
// ---------------------------------------------------------------------------

const chrome = await resolveChrome();
const extId = extensionIdFromPath(EXT_DIR);
const popupUrl = `chrome-extension://${extId}/popup.html`;

const givenProfileDir = args.get('profile-dir');
const profileDir =
  typeof givenProfileDir === 'string' && givenProfileDir !== ''
    ? givenProfileDir
    : await mkdtemp(path.join(os.tmpdir(), 'cici-e2e-'));

// 화면 갈무리를 둘 곳. 레이아웃 문제는 단언문보다 그림에서 먼저 보인다.
const shotDir = typeof args.get('shots') === 'string' ? args.get('shots') : path.join(os.tmpdir(), 'cici-shots');
await rm(shotDir, { recursive: true, force: true });
await mkdir(shotDir, { recursive: true });

console.log(`크롬:   ${chrome}`);
console.log(`확장 id: ${extId}`);
console.log(`프로필: ${profileDir}`);
console.log(`갈무리: ${shotDir}`);

let failed = false;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
};

// 파일 접근: --load-extension 으로 얹은 확장에는 크롬이 자동으로 켜 준다(실측).
// B 와 C 는 같은 브라우저 세션에서 돌아야 한다 — 세션 캐시(chrome.storage.session)
// 는 그 세션이 살아 있는 동안만 존재하기 때문이다.
//
// 이 스크립트는 이 머신의 **진짜** 크롬 프로필을 검사한다. 그래서 열거되는
// 프로필 수와 검사 시간은 실제 크롬의 실행 상태에 좌우된다(실행 중이면
// user-data-dir 리스팅이 매달릴 수 있다 — 그게 바로 이 도구가 진단하려는
// 현상이다). 따라서 PASS/FAIL 기준은 환경에 무관한 것("팝업이 결과 화면까지
// 도달하고 계측이 찍혔는가")뿐이고, 프로필 수·시간·캐시 효과는 정보로만 낸다.
{
  const { port, stop } = await launchChrome(chrome, profileDir);
  try {
    // --- B. 콜드 스캔 (세션 캐시 없음) -------------------------------------
    const cold = await openPopup(port, popupUrl, { shotPath: path.join(shotDir, 'popup.png') });
    check(cold.state.panel === 'result', 'B. 콜드 스캔 → 결과 화면 도달', `panel=${cold.state.panel}`);
    check(cold.scanLogs.length > 0, 'B. 검사 계측이 찍힌다');
    console.log(`      첫 화면까지 ${cold.firstPaintMs}ms · 프로필 ${cold.state.rows + (cold.state.selfUuid ? 1 : 0)}개`);
    for (const line of cold.scanLogs) console.log(`      ${line}`);
    console.log(`      캐시: ${JSON.stringify(cold.cache)}`);

    // --- B2. 헤더 배치 ------------------------------------------------------
    // 언어 단추와 새로고침은 오른쪽 끝에 **서로 붙어** 있어야 한다. 예전에는
    // `.hd` 의 space-between 이 셋을 흩어 놓아 언어 단추가 헤더 한복판에 떴다.
    const { flag, refresh, body, flagText } = cold.geo;
    if (flag && refresh) {
      const gap = refresh.l - flag.r;
      check(gap >= 0 && gap <= 14, 'B2. 언어 단추가 새로고침에 붙어 있다', `간격 ${gap}px`);
      check(body - refresh.r <= 20, 'B2. 조작부가 오른쪽 끝에 있다', `오른쪽 여백 ${body - refresh.r}px`);
      check(flagText.trim() !== '', 'B2. 현재 언어를 표시한다', `표시=${JSON.stringify(flagText)}`);
    } else {
      check(false, 'B2. 헤더 요소를 찾지 못했다');
    }

    // --- B3. 언어 전환 속도 -------------------------------------------------
    const switched = await openPopup(port, popupUrl, {
      lang: 'ja',
      shotPath: path.join(shotDir, 'popup-ja.png'),
      waitScanLog: false,
    });
    check(switched.langSwitchMs >= 0 && switched.langSwitchMs < 1000, 'B3. 언어 전환이 즉시다', `${switched.langSwitchMs}ms`);
    check(switched.geo.flagText.trim() !== '', 'B3. 바꾼 언어가 단추에 반영된다', `표시=${JSON.stringify(switched.geo.flagText)}`);

    // --- C. 같은 세션에서 팝업 재오픈 (세션 캐시) --------------------------
    const warm = await openPopup(port, popupUrl);
    check(warm.state.panel === 'result', 'C. 재오픈 → 결과 화면 도달', `panel=${warm.state.panel}`);
    // 두 번째 검사의 계측. 응답하지 않는 디렉터리를 기억해 두었다면 여기서
    // `skipped N` 이 붙고 enumerate 가 확 줄어 있어야 한다.
    for (const line of warm.scanLogs) console.log(`      ${line}`);
    // 응답하지 않는 디렉터리가 있었던 환경에서만 의미가 있는 확인이다. macOS 는
    // 크롬이 다른 브라우저의 데이터 폴더를 읽는 것을 TCC 로 막으면서 거부 대신
    // 침묵하고, 그때마다 상한(LIST_TIMEOUT_MS)을 통째로 버린다.
    if ((cold.cache?.stalled ?? 0) > 0) {
      check(
        warm.scanLogs.some((l) => l.includes('skipped')),
        'C. 응답하지 않는 디렉터리를 다시 묻지 않는다',
        `무응답 ${cold.cache.stalled}곳`,
      );
    }
    // 캐시 효과는 콜드가 프로필을 찾아 캐시를 남겼을 때만 유의미하다(빈 결과는
    // 캐시하지 않는다). 못 찾은 환경에서는 비교 자체를 건너뛴다.
    if (cold.state.rows > 0 || cold.state.selfUuid) {
      console.log(
        `      재오픈 첫 화면까지 ${warm.firstPaintMs}ms (콜드 ${cold.firstPaintMs}ms) — ` +
          `${warm.firstPaintMs < cold.firstPaintMs / 2 ? '캐시 효과 확인' : '캐시 효과 미미'}`,
      );
    } else {
      console.log('      (콜드가 프로필을 못 찾아 캐시 비교는 건너뜀 — 실제 크롬 실행 간섭)');
    }

    // --- D. 시각 검증 -------------------------------------------------------
    // 이 머신에 프로필이 몇 개 있든, 가짜 결과를 세션 캐시에 심어 **목록이 넘치는
    // 실제 화면**을 그린다. 레이아웃 문제는 단언문이 아니라 이 그림에서 보인다.
    // 재검사가 이 화면을 덮기 전에 찍어야 하므로 계측 로그를 기다리지 않는다.
    await openPopup(port, popupUrl, { seedDemo: true, waitScanLog: false, settleTimeoutMs: 20000 });
    // 앞 장면이 언어를 바꿔 두었고 그 선택은 저장된다(그게 정상 동작이다).
    // 그림은 언어별로 따로 남겨야 비교가 되므로 여기서 명시적으로 정한다.
    // `seedDemo` 를 다시 주는 이유: 이 팝업의 재검사도 캐시를 덮어쓰므로,
    // 다음 장면(일본어)이 쓸 것을 닫기 직전에 새로 심어 둔다.
    const demo = await openPopup(port, popupUrl, {
      waitScanLog: false,
      lang: 'ko',
      seedDemo: true,
      shotPath: path.join(shotDir, 'demo.png'),
      settleTimeoutMs: 20000,
    });
    check(demo.state.rows > 0, 'D. 시각 검증용 화면을 그렸다', `목록 ${demo.state.rows}줄`);
    const demoJa = await openPopup(port, popupUrl, {
      waitScanLog: false,
      lang: 'ja',
      shotPath: path.join(shotDir, 'demo-ja.png'),
      settleTimeoutMs: 20000,
    });
    check(demoJa.geo.flagText.includes('🇯🇵'), 'D. 언어를 바꾼 화면도 남겼다', `표시=${demoJa.geo.flagText}`);

    // --- E. 로딩(스켈레톤) 화면 --------------------------------------------
    // 반짝임이 이어져 보이려면: 가속·감속이 없어야 루프가 맞물리는 지점에서
    // 멈칫하지 않고, 배경이 타일링되지 않아야 경계가 튀지 않으며, 조각마다
    // 시작이 어긋나야 셋이 한 줄기로 흐른다.
    const loading = await openPopup(port, popupUrl, {
      waitScanLog: false,
      forceLoading: true,
      shotPath: path.join(shotDir, 'loading.png'),
      settleTimeoutMs: 20000,
    });
    if (loading.skeleton) {
      const { timing, repeat, delays } = loading.skeleton;
      check(timing === 'linear', 'E. 반짝임에 가속·감속이 없다', `timing=${timing}`);
      check(repeat === 'no-repeat', 'E. 배경이 타일링되지 않는다', `repeat=${repeat}`);
      check(new Set(delays).size === delays.length, 'E. 조각마다 시작이 어긋난다', `delays=${delays.join(' ')}`);
    } else {
      check(false, 'E. 스켈레톤을 찾지 못했다');
    }
    console.log(`      그림: ${shotDir}`);
  } finally {
    await stop();
  }
}

if (args.get('keep') !== true && typeof givenProfileDir !== 'string') {
  await rm(profileDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);

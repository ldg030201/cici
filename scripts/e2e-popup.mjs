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
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
async function openPopup(port, popupUrl, options = {}) {
  const { settleTimeoutMs = 60000, waitScanLog = true } = options;
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

  cdp.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
  return { state, firstPaintMs, scanLogs };
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

console.log(`크롬:   ${chrome}`);
console.log(`확장 id: ${extId}`);
console.log(`프로필: ${profileDir}`);

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
    const cold = await openPopup(port, popupUrl);
    check(cold.state.panel === 'result', 'B. 콜드 스캔 → 결과 화면 도달', `panel=${cold.state.panel}`);
    check(cold.scanLogs.length > 0, 'B. 검사 계측이 찍힌다');
    console.log(`      첫 화면까지 ${cold.firstPaintMs}ms · 프로필 ${cold.state.rows + (cold.state.selfUuid ? 1 : 0)}개`);
    for (const line of cold.scanLogs) console.log(`      ${line}`);

    // --- C. 같은 세션에서 팝업 재오픈 (세션 캐시) --------------------------
    const warm = await openPopup(port, popupUrl);
    check(warm.state.panel === 'result', 'C. 재오픈 → 결과 화면 도달', `panel=${warm.state.panel}`);
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
  } finally {
    await stop();
  }
}

if (args.get('keep') !== true && typeof givenProfileDir !== 'string') {
  await rm(profileDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);

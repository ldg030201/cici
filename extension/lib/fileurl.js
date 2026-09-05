/**
 * `file://` 바이트 소스.
 *
 * 확장이 크롬 프로필을 들여다볼 수 있는 유일한 통로는 `host_permissions`
 * `["file:///*"]` 와 사용자가 직접 켜는 "파일 URL에 대한 액세스 허용" 토글이다.
 * 그 상태에서 `fetch('file:///...')` 는 두 가지 일을 한다.
 *
 *   - 파일이면 `status 200`, `ok true`, 본문은 파일 바이트.
 *   - **디렉터리면 `status 0`, `ok false`** 인데 본문은 정상적으로 온다.
 *     Chromium 이 만들어 주는 디렉터리 리스팅 HTML 이고, 그 안에
 *     `<script>addRow("이름","url",isdir,size,"3 B",mtime,"...")</script>`
 *     호출이 항목마다 하나씩 들어 있다.
 *
 * 그래서 이 모듈은 **`res.ok` 도 `res.status` 도 믿지 않는다.** 본문이 왔는지,
 * 그 본문이 리스팅처럼 생겼는지로만 판정한다.
 *
 * 토글이 꺼져 있으면 fetch 는 `TypeError("Failed to fetch")` 로 reject 되는데,
 * 이는 "디렉터리가 없음"과 구별할 수 없다. 그러니 호출하는 쪽은 반드시 먼저
 * `chrome.extension.isAllowedFileSchemeAccess()` 로 확인해야 한다. 여기서는
 * 그 사실을 에러 메시지에 적어 두는 것까지만 한다.
 *
 * 경로는 전부 **슬래시(`/`) 구분자**를 쓴다. 윈도우 경로(`C:\Users\...`)도
 * 받지만, 이 모듈이 만들어 내는 경로는 언제나 `C:/Users/...` 꼴이다.
 *
 * @module fileurl
 */

/** 디렉터리 응답인지 알아보는 표식. Chromium 리스팅은 언제나 이 세 호출을 넣는다. */
const LISTING_MARKER = /<script>\s*(?:start|addRow|onHasParentDirectory)\s*\(/;

/** 짝이 맞지 않는 서러게이트. `encodeURIComponent` 가 URIError 로 죽는 유일한 입력이다. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `C:\...` / `c:/...` / `C:` 같은 윈도우 드라이브 경로. */
const WINDOWS_DRIVE = /^([A-Za-z]):(?:[\\/](.*))?$/s;

/** `\\server\share\...` UNC 경로. */
const WINDOWS_UNC = /^\\\\([^\\/]+)(?:[\\/](.*))?$/s;

const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// 경로 -> URL
// ---------------------------------------------------------------------------

/**
 * 경로 한 조각을 URL 에 안전하게 인코딩한다. `encodeURIComponent` 는 `/` 를
 * `%2F` 로 바꾸므로 조각 단위로만 부른다. 짝 없는 서러게이트가 들어오면
 * URIError 가 나므로 U+FFFD 로 갈아 끼운 뒤 다시 시도한다(파일 URL 로는 어차피
 * 표현할 수 없는 이름이다).
 *
 * @param {string} segment
 * @returns {string}
 */
function encodeSegment(segment) {
  try {
    return encodeURIComponent(segment);
  } catch {
    return encodeURIComponent(segment.replace(LONE_SURROGATE, '\uFFFD'));
  }
}

/**
 * 절대 경로를 `file://` URL 로 바꾼다.
 *
 * 각 경로 조각만 퍼센트 인코딩하므로 `/` 는 그대로 남고, 공백·한글·`#`·`?`·`%`
 * 가 든 이름도 깨지지 않는다. 끝의 `/` 는 보존한다(디렉터리 리스팅을 받으려면
 * 필요하다).
 *
 * 윈도우 경로는 드라이브 문자(`C:`)와 UNC 호스트를 인코딩하지 않고, 역슬래시를
 * 슬래시로 바꾼다. POSIX 경로에서는 역슬래시가 정당한 파일 이름 문자이므로
 * (`back\slash.txt`) 절대 건드리지 않는다.
 *
 * @param {string} absPath 절대 경로
 * @returns {string} `file:///...`
 */
export function toFileUrl(absPath) {
  if (typeof absPath !== 'string' || absPath === '') {
    throw new TypeError(`an absolute path is required: ${JSON.stringify(absPath)}`);
  }

  const drive = WINDOWS_DRIVE.exec(absPath);
  if (drive) {
    const rest = drive[2] ?? '';
    return `file:///${drive[1].toUpperCase()}:/${encodePathTail(rest, true)}`;
  }

  const unc = WINDOWS_UNC.exec(absPath);
  if (unc) {
    const rest = unc[2] ?? '';
    return `file://${encodeSegment(unc[1])}/${encodePathTail(rest, true)}`;
  }

  if (!absPath.startsWith('/')) {
    throw new TypeError(`not an absolute path: ${JSON.stringify(absPath)}`);
  }
  return `file://${encodePathTail(absPath, false)}`;
}

/**
 * 경로의 나머지 부분을 조각마다 인코딩해서 잇는다.
 *
 * @param {string} tail
 * @param {boolean} windows 역슬래시도 구분자로 볼지
 * @returns {string}
 */
function encodePathTail(tail, windows) {
  const parts = windows ? tail.split(/[\\/]/) : tail.split('/');
  return parts.map(encodeSegment).join('/');
}

/**
 * 디렉터리 경로 뒤에 `/` 를 붙인다. 리스팅 응답을 받으려면 필요하다.
 *
 * @param {string} absPath
 * @returns {string}
 */
function withTrailingSlash(absPath) {
  if (typeof absPath !== 'string' || absPath === '') return absPath;
  return /[\\/]$/.test(absPath) ? absPath : `${absPath}/`;
}

/**
 * 디렉터리 경로와 파일 이름을 잇는다. 구분자는 언제나 `/` 다.
 *
 * @param {string} dir
 * @param {string} name
 * @returns {string}
 */
export function joinPath(dir, name) {
  return `${String(dir).replace(/[\\/]+$/, '')}/${name}`;
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * fetch 가 reject 됐을 때 쓸 메시지. 토글이 꺼져 있는 경우와 경로가 없는 경우가
 * 완전히 같은 에러라서, 둘 다 짚어 준다.
 *
 * 이 모듈의 에러 문구는 **영어로 고정**한다. 사람에게 보이는 문장은 popup.js 가
 * `_locales` 에서 만들고, 여기서 나온 문자열은 그 안에 진단 정보로만 끼어든다.
 * (`leveldb-core.js` 의 파서 경고도 같은 이유로 영어다.) 로케일마다 언어가
 * 섞이지 않게 하려면 이 층에서 번역하면 안 된다.
 *
 * @param {string} url
 * @param {unknown} err
 * @returns {Error}
 */
function fetchFailure(url, err) {
  return new Error(
    `cannot read ${url} (${errorMessage(err)}); ` +
      'the path may not exist, or "Allow access to file URLs" may be off',
  );
}

/**
 * 디렉터리 리스팅 하나를 기다리는 상한. 리스팅은 작고 빠르다(실측 1ms 안팎).
 */
const LIST_TIMEOUT_MS = 5000;

/**
 * 파일 하나를 기다리는 상한. 실제 LevelDB 파일은 프로필당 최대 6.5MB 정도이고
 * 2.1MB 짜리 `.ldb` 가 1.1ms 에 온다. 넉넉히 잡아도 이 값이면 충분하다.
 */
const READ_TIMEOUT_MS = 20000;

/**
 * `fetch` 옵션. `file://` 읽기는 **영원히 끝나지 않을 수 있다.**
 *
 * Chromium 의 디렉터리 리스팅은 FIFO(이름 있는 파이프)를 `isdir=0`, 크기 0 인
 * 평범한 파일로 보고한다. 그런 이름이 `000005.log` 라면 우리는 그것을 WAL 로
 * 알고 여는데, FIFO 의 `open(2)` 는 쓰는 쪽이 나타날 때까지 블록되므로 그
 * `fetch` 는 resolve 도 reject 도 하지 않는다(Chrome for Testing 148 실측:
 * 25초 뒤에도 pending). 응답하지 않는 네트워크 마운트도 같다. 타임아웃이 없으면
 * 팝업은 스켈레톤 화면에서 영원히 멈춘다.
 *
 * `src/leveldb.js` 의 노드 어댑터는 같은 위험을 `dirent.isFile()` 로 막는데
 * (거기 주석: "readFile() on a FIFO never resolves"), 리스팅에는 그만한 정보가
 * 없으므로 여기서는 시간으로 끊는다.
 *
 * @param {number} ms
 * @returns {{signal: AbortSignal}|undefined} AbortSignal.timeout 이 없으면 undefined
 */
function timeoutOptions(ms) {
  try {
    const timeout = globalThis.AbortSignal?.timeout;
    if (typeof timeout === 'function') return { signal: timeout.call(globalThis.AbortSignal, ms) };
  } catch {
    // 아주 오래된 런타임: 타임아웃 없이 간다(그래도 popup 의 전체 예산이 있다).
  }
  return undefined;
}

/**
 * 이 모듈에서 `fetch` 를 부르는 **유일한** 곳.
 *
 * 바이트로 읽든 텍스트로 읽든 나머지는 똑같다: 타임아웃을 걸고, reject 를 우리
 * 문구로 바꾸고, 400 이상을 걸러내고, 본문을 읽고, 그 실패도 문구로 바꾼다.
 * 다른 점은 상한 시간과 본문을 꺼내는 방법 둘뿐이라 그 둘만 인자로 받는다.
 *
 * `file://` 응답의 `status` 는 믿을 수 없으므로(디렉터리는 0) 상태 코드로
 * 판정하지 않는다. 실제 실패는 fetch 자체가 reject 되는 것으로 드러난다.
 *
 * `url` 은 언제나 {@link toFileUrl} 이 만든 것이어야 한다. 여기서 직접 만들지
 * 않는 이유는 부르는 쪽이 같은 URL 을 에러 문구에도 쓰기 때문이다(두 번 만들면
 * 두 값이 갈라질 수 있다).
 *
 * @template T
 * @param {string} url {@link toFileUrl} 이 만든 `file://` URL
 * @param {number} timeoutMs
 * @param {(res: Response) => Promise<T>} readBody
 * @returns {Promise<T>}
 */
async function fetchAs(url, timeoutMs, readBody) {
  let res;
  try {
    res = await fetch(url, timeoutOptions(timeoutMs));
  } catch (err) {
    throw fetchFailure(url, err);
  }
  // status 0 은 file:// 의 정상값이다. 400 이상은 http(s) 로 쓰일 때만 의미가 있다.
  if (res.status >= 400) throw new Error(`${url} responded with ${res.status}`);
  try {
    return await readBody(res);
  } catch (err) {
    throw new Error(`cannot read the body of ${url} (${errorMessage(err)})`);
  }
}

/**
 * 파일 바이트를 읽는다.
 *
 * @param {string} absPath
 * @returns {Promise<Uint8Array>}
 */
export function fetchBytes(absPath) {
  const url = toFileUrl(absPath);
  return fetchAs(url, READ_TIMEOUT_MS, async (res) => new Uint8Array(await res.arrayBuffer()));
}

/**
 * 텍스트를 읽는다(디렉터리 리스팅 HTML 용).
 *
 * @param {string} url {@link toFileUrl} 이 만든 `file://` URL
 * @returns {Promise<string>}
 */
function fetchText(url) {
  return fetchAs(url, LIST_TIMEOUT_MS, (res) => res.text());
}

// ---------------------------------------------------------------------------
// 디렉터리 리스팅 파서
// ---------------------------------------------------------------------------

/**
 * 리스팅 한 줄. 리스팅에는 크기와 수정 시각도 들어 있지만 이 확장은 이름과
 * 디렉터리 여부만 쓰므로 나머지는 담지 않는다.
 *
 * @typedef {object} DirEntry
 * @property {string} name  파일/디렉터리 이름 (경로 아님)
 * @property {boolean} isDir
 */

/**
 * 공백을 건너뛴다.
 *
 * @param {string} src
 * @param {number} i
 * @returns {number}
 */
function skipSpace(src, i) {
  while (i < src.length && /\s/.test(src[i])) i += 1;
  return i;
}

/**
 * JS 문자열 리터럴 하나를 읽어 실제 문자열로 되돌린다.
 *
 * Chromium 은 이름을 `base::EscapeJSONString` 으로 넣으므로 `\"`, `\\`, `\t`,
 * `\u003C`(`<`) 같은 이스케이프가 섞여 나온다. 여기서 제대로 풀지 않으면
 * `back\slash.txt` 가 `backslash.txt` 로, `\u003Cscript>tag.txt` 가
 * `u003Cscript>tag.txt` 로 둔갑한다.
 *
 * @param {string} src
 * @param {number} start 여는 따옴표 위치
 * @returns {{ value: string, end: number }|null} 리터럴이 아니면 null
 */
function readStringLiteral(src, start) {
  const quote = src[start];
  if (quote !== '"' && quote !== "'") return null;
  let out = '';
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === quote) return { value: out, end: i + 1 };
    // 줄바꿈이 그대로 들어 있으면 문자열 리터럴이 아니다(끝나지 않은 문자열).
    if (c === '\n' || c === '\r') return null;
    if (c !== '\\') {
      out += c;
      i += 1;
      continue;
    }
    i += 1;
    const e = src[i];
    if (e === undefined) return null;
    switch (e) {
      case 'n': out += '\n'; i += 1; break;
      case 't': out += '\t'; i += 1; break;
      case 'r': out += '\r'; i += 1; break;
      case 'b': out += '\b'; i += 1; break;
      case 'f': out += '\f'; i += 1; break;
      case 'v': out += '\v'; i += 1; break;
      case '0':
        if (/[0-9]/.test(src[i + 1] ?? '')) return null; // 8진 이스케이프는 취급하지 않는다
        out += '\0';
        i += 1;
        break;
      case 'x': {
        const hex = src.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 3;
        break;
      }
      case 'u': {
        if (src[i + 1] === '{') {
          const close = src.indexOf('}', i + 2);
          if (close < 0) return null;
          const hex = src.slice(i + 2, close);
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return null;
          const cp = parseInt(hex, 16);
          if (cp > 0x10ffff) return null;
          out += String.fromCodePoint(cp);
          i = close + 1;
          break;
        }
        const hex = src.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        // 서러게이트 반쪽도 그대로 이어 붙인다. 짝이 맞으면 자동으로 합쳐진다.
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
        break;
      }
      // 줄 이어 쓰기
      case '\r': i += src[i + 1] === '\n' ? 2 : 1; break;
      case '\n': case '\u2028': case '\u2029': i += 1; break;
      // \\ \" \' \/ 등은 다음 글자 그대로
      default: out += e; i += 1; break;
    }
  }
  return null;
}

/**
 * `addRow(` 바로 뒤부터 인자 목록을 읽는다. 리터럴(문자열/숫자)만 받는다.
 *
 * 헤더에 들어 있는 **함수 선언** `function addRow(name, url, isdir, ...)` 은
 * 첫 인자가 식별자라서 여기서 null 로 걸러진다. 그게 이 함수의 존재 이유다.
 *
 * @param {string} src
 * @param {number} start `(` 바로 다음 위치
 * @returns {{ args: Array<{type: 'string'|'number', value: string|number}>, end: number }|null}
 */
function readCallArgs(src, start) {
  const args = [];
  let i = start;
  for (;;) {
    i = skipSpace(src, i);
    if (i >= src.length) return null;
    const c = src[i];
    if (c === ')') return { args, end: i + 1 };
    if (c === '"' || c === "'") {
      const lit = readStringLiteral(src, i);
      if (!lit) return null;
      args.push({ type: 'string', value: lit.value });
      i = lit.end;
    } else if (/[-+.0-9]/.test(c)) {
      const num = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(i, i + 40));
      if (!num) return null;
      args.push({ type: 'number', value: Number(num[0]) });
      i += num[0].length;
    } else {
      // 식별자·표현식·중첩 호출: 우리가 찾는 리터럴 호출이 아니다.
      return null;
    }
    i = skipSpace(src, i);
    if (src[i] === ',') {
      i += 1;
      continue;
    }
    if (src[i] === ')') return { args, end: i + 1 };
    return null;
  }
}

/**
 * Chromium 디렉터리 리스팅 HTML 에서 항목을 뽑는다.
 *
 * 응답 본문은 대략 이렇게 생겼다.
 *
 * ```
 * <script>
 * function addRow(name, url, isdir, size, size_string, ...) { ... }   <- 선언, 걸러야 한다
 * </script>
 * ...
 * <script>start("/Users/you/cici-lab/");</script>
 * <script>onHasParentDirectory();</script>
 * <script>addRow("back\\slash.txt","back%5Cslash.txt",0,4,"4 B",1788438416,"...");</script>
 * ```
 *
 * DOMParser 대신 직접 훑는다. 서비스워커에는 DOMParser 가 없고, 이 함수가
 * 순수해야 브라우저 없이도 테스트할 수 있기 때문이다.
 *
 * @param {string} html
 * @returns {DirEntry[]}
 */
export function parseDirectoryListing(html) {
  /** @type {DirEntry[]} */
  const rows = [];
  const re = /\baddRow\s*\(/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const call = readCallArgs(html, re.lastIndex);
    // 파싱에 실패하면 lastIndex 를 그대로 두고 다음 후보로 넘어간다.
    if (!call) continue;
    // 성공했으면 호출 끝으로 건너뛴다. 파일 이름 안에 들어 있는 가짜
    // `addRow(...)` 텍스트를 두 번 읽지 않기 위한 것이다.
    re.lastIndex = call.end;

    const args = call.args;
    if (args.length < 3 || args[0].type !== 'string') continue;
    let name = String(args[0].value);
    let isDir = args[2].type === 'number' ? args[2].value !== 0 : Boolean(args[2].value);
    if (name.endsWith('/')) {
      name = name.slice(0, -1);
      isDir = true;
    }
    if (name === '' || name === '.' || name === '..') continue;
    if (name.includes('/') || name.includes('\0')) continue; // 이름일 수 없다

    rows.push({ name, isDir });
  }
  return rows;
}

/**
 * 디렉터리 목록을 읽는다.
 *
 * @param {string} absPath
 * @returns {Promise<DirEntry[]>} 상위 디렉터리(`..`)는 빠진 목록
 */
export async function listDir(absPath) {
  // 읽을 때와 에러 문구에 쓸 URL 이 같아야 한다. 그러니 한 번만 만든다.
  const url = toFileUrl(withTrailingSlash(absPath));
  const html = await fetchText(url);
  const rows = parseDirectoryListing(html);
  // 빈 디렉터리는 항목이 0개인 정상적인 리스팅이다. 리스팅이 아예 아닌 응답
  // (파일을 디렉터리로 착각했다든가)과 구별하려면 표식을 봐야 한다.
  if (rows.length === 0 && !LISTING_MARKER.test(html)) {
    throw new Error(`${url} is not a directory listing`);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 없는 경로를 fetch 하지 않기 위한 캐시
//
// 없는 파일을 fetch 하면 크롬 **네트워크 스택**이 콘솔에
// `net::ERR_FILE_NOT_FOUND` 를 남긴다. 우리 코드가 그 예외를 잡아도 그 빨간 줄은
// 지워지지 않는다(팝업 DevTools 를 연 사용자에게 그대로 보인다). 그래서 "있는지
// 모르는 경로"는 절대 바로 열지 않고, **부모 디렉터리 목록에서 먼저 확인한다.**
// 목록은 캐시하므로 한 번의 검사에서 같은 디렉터리를 두 번 읽지도 않는다.
// ---------------------------------------------------------------------------

/** @type {Map<string, Promise<DirEntry[]|null>>} */
const dirCache = new Map();

/** @param {string} absPath */
function cacheKey(absPath) {
  return String(absPath).replace(/[\\/]+$/, '');
}

/**
 * 리스팅 캐시를 비운다. 검사를 다시 시작할 때(팝업의 "다시 검사") 부른다.
 * 디스크가 그 사이에 바뀌었을 수 있기 때문이다.
 */
export function resetDirCache() {
  dirCache.clear();
}

/**
 * {@link listDir} 과 같지만 실패를 `null` 로 돌려주고 결과를 캐시한다.
 *
 * @param {string} absPath
 * @returns {Promise<DirEntry[]|null>}
 */
export function listDirOrNull(absPath) {
  const key = cacheKey(absPath);
  let hit = dirCache.get(key);
  if (hit === undefined) {
    hit = listDir(key).then(
      (entries) => entries,
      () => null,
    );
    dirCache.set(key, hit);
  }
  return hit;
}

/**
 * @typedef {object} ChildLookup
 * @property {string|null} path       찾았으면 절대 경로.
 * @property {boolean} unreadable     부모 디렉터리 자체를 못 읽었으면 true.
 *   이때 `path` 는 null 이지만 그 뜻은 "없다" 가 아니라 **"모른다"** 다.
 */

/**
 * {@link findChildDir} 과 같지만 "없다"와 "못 읽었다"를 구별해서 돌려준다.
 *
 * `listDirOrNull` 은 모든 실패를 `null` 로 뭉갠다. 그 값을 그대로 "없음"으로
 * 읽으면, 읽지 못한 프로필이 조용히 "Claude 확장이 없는 프로필"로 둔갑한다
 * (경고 한 줄 없이). 호출하는 쪽이 그 둘을 갈라 볼 수 있어야 하는 자리에서는
 * 이쪽을 쓴다.
 *
 * @param {string} parentDir
 * @param {string} name
 * @returns {Promise<ChildLookup>}
 */
export async function findChildDirEx(parentDir, name) {
  const entries = await listDirOrNull(parentDir);
  if (!entries) return { path: null, unreadable: true };
  const hit = entries.some((e) => e.isDir && e.name === name);
  return { path: hit ? joinPath(cacheKey(parentDir), name) : null, unreadable: false };
}

/**
 * 부모 목록을 보고 하위 디렉터리가 **정말 있을 때만** 경로를 돌려준다.
 *
 * 실패와 부재를 구별해야 하는 자리에서는 {@link findChildDirEx} 를 쓴다.
 *
 * @param {string} parentDir
 * @param {string} name
 * @returns {Promise<string|null>}
 */
export async function findChildDir(parentDir, name) {
  return (await findChildDirEx(parentDir, name)).path;
}

/**
 * 상대 경로를 한 조각씩 확인하며 내려간다. 중간에 하나라도 없으면 `null`.
 * 조각마다 목록을 캐시하므로, 앞부분이 겹치는 후보들(같은
 * `Library/Application Support`)은 한 번만 읽는다.
 *
 * @param {string} baseDir
 * @param {string} relPath 슬래시로 구분된 상대 경로
 * @returns {Promise<string|null>}
 */
export async function resolveDirPath(baseDir, relPath) {
  let cur = cacheKey(baseDir);
  for (const seg of String(relPath).split('/')) {
    if (seg === '') continue;
    cur = await findChildDir(cur, seg);
    if (cur === null) return null;
  }
  return cur;
}

/**
 * 부모 목록을 보고 **파일**이 있을 때만 경로를 돌려준다.
 *
 * @param {string} parentDir
 * @param {string} name
 * @returns {Promise<string|null>}
 */
export async function findChildFile(parentDir, name) {
  const entries = await listDirOrNull(parentDir);
  if (!entries) return null;
  return entries.some((e) => !e.isDir && e.name === name) ? joinPath(cacheKey(parentDir), name) : null;
}

// ---------------------------------------------------------------------------
// ByteSource
// ---------------------------------------------------------------------------

/**
 * `leveldb-core.js` 의 `readLevelDbFrom()` 에 넣을 바이트 소스를 만든다.
 *
 * `has()` 는 디렉터리 목록으로 답한다. 목록은 코어가 어차피 맨 처음에 받아 가는
 * 것이라 추가 fetch 가 없고, 없는 파일을 확인하려고 열어 보는 일(그리고 콘솔에
 * 남는 `net::ERR_FILE_NOT_FOUND`)이 사라진다. MANIFEST 가 목록에 없는 테이블을
 * 가리키는 경우(우리가 읽는 사이에 컴팩션이 끝난 경우)에 실제로 그렇게 된다.
 *
 * 소스에는 `readErrors()` 가 하나 더 달려 있다. `readLevelDbFrom()` 은 파일 읽기
 * 실패에 예외를 던지지 않고 경고 문자열로 삼켜 버리기 때문에(설계상 그렇다),
 * 부르는 쪽에서 **"값이 없다"와 "못 읽었다"를 구별할 방법이 그것밖에 없다.**
 * 경고 문자열을 검사하는 방법도 있지만 그건 파서의 영어 문구에 의존하는 짓이라
 * 문구가 바뀌면 조용히 깨진다. 여기서 세어 두면 언어와 무관하게 정확하다.
 *
 * @param {string} dirPath LevelDB 디렉터리
 * @param {{ entries?: DirEntry[] }} [options] 이미 받아 둔 목록이 있으면 재사용한다
 * @returns {import('./leveldb-core.js').ByteSource & { readErrors: () => string[] }}
 */
export function makeSource(dirPath, options = {}) {
  const dir = String(dirPath).replace(/[\\/]+$/, '');
  const preListed = options.entries;
  /** @type {Promise<Set<string>>|null} */
  let fileNames = null;
  /** @type {Promise<Set<string>>|null} 컴팩션 복구용 재조회. 소스당 한 번만. */
  let refreshed = null;
  /** @type {string[]} 실제로 실패한 파일 읽기. `readErrors()` 가 돌려준다. */
  const readErrors = [];

  const names = () => {
    if (fileNames === null) {
      fileNames = Promise.resolve(preListed ?? listDir(dir)).then(
        (entries) => new Set(entries.filter((e) => !e.isDir).map((e) => e.name)),
      );
    }
    return fileNames;
  };

  return {
    root: toFileUrl(withTrailingSlash(dir)),
    path: (name) => toFileUrl(joinPath(dir, name)),

    async list() {
      return { names: [...(await names())], warnings: [] };
    },

    async has(name) {
      const known = await names();
      if (known.has(name)) return true;
      // 목록에 없다. 코어가 여기까지 온 이유는 MANIFEST 가 목록에 없는 테이블을
      // 가리켰기 때문이고(그 사이에 크롬이 flush/compaction 을 끝냈다), 그게
      // 바로 has() 가 존재하는 이유다. 처음 뜬 목록으로 답하면 그 복구 경로가
      // 언제나 "없음"이 되어 죽어 버린다 — 페어링된 프로필이 "아직 페어링되지
      // 않았습니다"로 보이는 결과가 된다.
      //
      // 그래서 캐시를 우회해 **한 번만** 다시 읽는다. 이 디렉터리는 반드시
      // 존재하므로(호출하는 쪽이 목록으로 확인한 뒤에만 소스를 만든다) 없는
      // 경로를 여는 것이 아니고, 콘솔에 `net::ERR_FILE_NOT_FOUND` 도 남지 않는다.
      if (refreshed === null) {
        refreshed = listDir(dir).then(
          (entries) => {
            for (const e of entries) if (!e.isDir) known.add(e.name);
            return known;
          },
          () => known,
        );
      }
      return (await refreshed).has(name);
    },

    async read(name) {
      try {
        return await fetchBytes(joinPath(dir, name));
      } catch (err) {
        readErrors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },

    /**
     * 이 소스에서 실패한 파일 읽기들. 비어 있지 않으면 결과가 불완전하다.
     *
     * `has()` 의 탐색 실패는 세지 않는다. 그건 `.ldb` 인지 `.sst` 인지 넘겨짚는
     * 정상 경로라 실패가 곧 이상은 아니다.
     *
     * @returns {string[]}
     */
    readErrors: () => readErrors.slice(),
  };
}

/**
 * 바이트를 UTF-8 문자열로.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeUtf8(bytes) {
  return decoder.decode(bytes);
}

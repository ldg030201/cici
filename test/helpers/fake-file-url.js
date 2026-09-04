/**
 * `file://` 을 쓰는 확장 코드를 브라우저 없이 돌리기 위한 가짜 파일 시스템.
 *
 * `test/extension.test.js` 와 `test/popup.test.js` 가 함께 쓴다. 진짜 Chromium 의
 * 동작을 그대로 흉내 내는 것이 핵심이다 — 특히 **디렉터리 응답은 status 0 / ok
 * false 인데 본문은 정상**이라는 점, 그리고 없는 경로는
 * `TypeError("Failed to fetch")` 로 reject 된다는 점(파일 접근 토글이 꺼졌을 때와
 * 구별할 수 없는 바로 그 에러다).
 */

import { decodeUtf8, resetDirCache } from '../../extension/lib/fileurl.js';
import { buildLogFile, TYPE_VALUE } from './leveldb-writer.js';

/**
 * 전역 속성을 잠깐 갈아 끼운다.
 *
 * @param {object} target
 * @param {string} key
 * @param {unknown} value
 * @returns {() => void} 되돌리는 함수
 */
export function stub(target, key, value) {
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
export function walWith(pairs, sequence = 1) {
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
export class FakeFs {
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
export function escapeJsonString(s) {
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
export function listingHtml(dirPath, children, fs) {
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
export async function withFetch(fs, fn, log) {
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
export function fakeResponse(status, bytes) {
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

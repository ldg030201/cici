#!/usr/bin/env node
/**
 * `src/` 의 플랫폼 독립 파서를 `extension/lib/` 로 복사한다.
 *
 * 확장은 번들러 없이 순수 ES 모듈로 그대로 로드되므로, 파서를 두 번 쓰는 대신
 * 원본을 그대로 복사해서 쓴다. 복사본 맨 위에는 "직접 수정하지 마세요" 주석이
 * 붙고, `test/extension.test.js` 가 그 주석을 뺀 나머지가 원본과 바이트 단위로
 * 같은지 검사한다. 그래서 `npm test` 전에 이 스크립트를 돌릴 필요는 없다.
 * 동기화가 깨지면 테스트가 빨개진다.
 *
 * 사용법: `npm run build:ext`, 쓰지 않고 확인만 하려면 `npm run check:ext`.
 *
 * **`--check` 가 필요한 이유.** 테스트가 이 스크립트를 진짜로 실행해 보는데
 * (심볼릭 링크를 지나도 도는지 확인하려고), 그때 쓰기까지 해 버리면 `npm test`
 * 가 작업 트리를 고쳐 쓴다. 그러면 동기화 검사가 첫 실행에서 실패한 뒤 **같은
 * 실행 안에서 스스로를 고쳐** 두 번째부터 초록이 되고(재시도가 있는 CI 는 아예
 * 못 잡는다), 디버깅하려고 복사본에 넣어 둔 한 줄이 경고 없이 지워진다.
 * 테스트는 `--check` 로만 부른다.
 */

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isMainEntry } from './lib/main-entry.mjs';
import { REPO_ROOT } from './lib/paths.mjs';

// 저장소 루트는 scripts/lib/paths.mjs 가 정한다. 여기서 다시 내보내는 것은
// test/extension.test.js 가 이 모듈에서 가져다 쓰기 때문이다.
export { REPO_ROOT };

/** 복사 대상. 이름은 `src/` 와 `extension/lib/` 양쪽에서 같아야 한다(상대 import 가 그대로 맞물린다). */
export const COPIED_FILES = Object.freeze(['leveldb-core.js', 'snappy.js']);

/** 복사본이 놓이는 곳. */
export const LIB_DIR = path.join(REPO_ROOT, 'extension', 'lib');

/**
 * 복사본 맨 위에 붙는 주석. 개행까지 포함한다.
 *
 * @param {string} name `src/` 안의 파일 이름
 * @returns {string}
 */
export function generatedHeader(name) {
  return `// 이 파일은 scripts/build-extension.mjs 가 자동 생성합니다. 직접 수정하지 마세요. 원본: src/${name}\n`;
}

/**
 * 복사본 한 개의 내용을 만든다.
 *
 * @param {string} name
 * @param {string} source `src/<name>` 의 내용
 * @returns {string}
 */
export function generatedContent(name, source) {
  return generatedHeader(name) + source;
}

/**
 * `extension/lib/` 에 남아 있는, 더 이상 복사 대상이 아닌 생성물.
 *
 * `COPIED_FILES` 에서 이름을 빼거나 바꾸면 옛 복사본이 헤더를 단 채 그대로
 * 남는다. 그 파일은 검사도 갱신도 받지 않는 유령이 되고, 확장이 계속 그것을
 * import 하고 있어도 아무도 모른다.
 *
 * @returns {Promise<string[]>} 파일 이름
 */
export async function staleCopies() {
  let names;
  try {
    names = await readdir(LIB_DIR);
  } catch {
    return [];
  }
  const stale = [];
  for (const name of names) {
    if (!name.endsWith('.js') || COPIED_FILES.includes(name)) continue;
    let head;
    try {
      head = await readFile(path.join(LIB_DIR, name), 'utf8');
    } catch {
      continue;
    }
    if (head.startsWith(generatedHeader(name))) stale.push(name);
  }
  return stale;
}

/**
 * `src/` 원본을 `extension/lib/` 로 복사한다.
 *
 * @param {{ check?: boolean }} [options] `check` 면 아무것도 쓰지 않고 결과만 돌려준다
 * @returns {Promise<Array<{ name: string, from: string, to: string, changed: boolean, removed?: boolean }>>}
 */
export async function buildExtensionLib(options = {}) {
  const check = options.check === true;
  if (!check) await mkdir(LIB_DIR, { recursive: true });
  const results = [];
  for (const name of COPIED_FILES) {
    const from = path.join(REPO_ROOT, 'src', name);
    const to = path.join(LIB_DIR, name);
    const source = await readFile(from, 'utf8');
    const next = generatedContent(name, source);
    let prev = null;
    try {
      prev = await readFile(to, 'utf8');
    } catch {
      // 아직 없으면 새로 만든다.
    }
    const changed = prev !== next;
    if (changed && !check) await writeFile(to, next);
    results.push({ name, from, to, changed });
  }
  for (const name of await staleCopies()) {
    const to = path.join(LIB_DIR, name);
    if (!check) await unlink(to);
    results.push({ name, from: path.join(REPO_ROOT, 'src', name), to, changed: true, removed: true });
  }
  return results;
}

if (isMainEntry(import.meta.url)) {
  const check = process.argv.includes('--check');
  const results = await buildExtensionLib({ check });
  for (const r of results) {
    const rel = path.relative(REPO_ROOT, r.to);
    const state = r.removed ? (check ? '남음' : '삭제') : r.changed ? (check ? '어긋남' : '갱신') : '동일';
    console.log(`${state}  ${rel}`);
  }
  if (check && results.some((r) => r.changed)) {
    console.error('extension/lib 이 src/ 와 어긋났습니다. "npm run build:ext" 를 돌리세요.');
    process.exitCode = 1;
  }
}

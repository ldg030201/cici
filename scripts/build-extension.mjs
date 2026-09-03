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
 * 사용법: `npm run build:ext`
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 이 파일 기준의 저장소 루트. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
 * `src/` 원본을 `extension/lib/` 로 복사한다.
 *
 * @returns {Promise<Array<{ name: string, from: string, to: string, changed: boolean }>>}
 */
export async function buildExtensionLib() {
  await mkdir(LIB_DIR, { recursive: true });
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
    if (changed) await writeFile(to, next);
    results.push({ name, from, to, changed });
  }
  return results;
}

// `node scripts/build-extension.mjs` 로 직접 실행했을 때만 돈다.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const results = await buildExtensionLib();
  for (const r of results) {
    const rel = path.relative(REPO_ROOT, r.to);
    console.log(`${r.changed ? '갱신' : '동일'}  ${rel}`);
  }
}

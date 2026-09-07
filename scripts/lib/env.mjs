/**
 * 저장소 루트의 `.env` 를 읽어 `process.env` 에 채운다.
 *
 * 의존성을 쓰지 않는다. Node 20.6 의 `--env-file` 은 파일이 없으면 죽고,
 * 있으면 무시하는 `--env-file-if-exists` 는 22 부터라 engines(>=18.17)와 맞지 않는다.
 * 필요한 기능이 20줄이라 직접 읽는다.
 *
 * **이미 설정된 값은 덮어쓰지 않는다.** GitHub Actions 는 시크릿을 환경 변수로
 * 넘기는데, 거기에 실수로 커밋된 `.env` 가 있더라도 CI 의 값이 이겨야 한다.
 *
 * `.env` 는 `.gitignore` 에 있다. 리프레시 토큰이 들어가는 파일이므로
 * 커밋되면 그 순간 공개 저장소에 자격 증명이 나간다.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './paths.mjs';

/**
 * @param {string} [file] 읽을 파일. 기본값은 저장소 루트의 `.env`
 * @returns {string[]} 이 호출로 새로 채워진 키 이름들
 */
export function loadEnv(file = path.join(REPO_ROOT, '.env')) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return []; // 없는 것은 정상이다. CI 에서는 시크릿이 이미 환경에 있다.
  }

  /** @type {string[]} */
  const filled = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // 이미 있는 값이 이긴다

    let value = line.slice(eq + 1).trim();
    // 따옴표로 감싼 값은 벗긴다. 안에 `#` 이 있어도 주석으로 보지 않는다.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
    filled.push(key);
  }
  return filled;
}

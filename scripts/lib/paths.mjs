import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 이 파일(scripts/lib/) 기준의 저장소 루트. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 웹스토어에 그대로 올라가는 확장 소스. */
export const EXTENSION_DIR = path.join(REPO_ROOT, 'extension');

/** @returns {Promise<string>} extension/manifest.json 의 version */
export async function extensionVersion() {
  const manifest = JSON.parse(await readFile(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  return manifest.version;
}

/**
 * 릴리스 zip 의 표준 경로.
 *
 * `pack-extension.mjs` 가 여기에 쓰고 `publish-extension.mjs` 가 여기서 읽는다.
 * 둘이 각자 이름을 조립하면 한쪽만 고쳤을 때 릴리스 워크플로가 조용히 아무것도
 * 올리지 않는다(파일이 없으면 publish 가 실패하지만, 이름만 다른 옛 zip 이 남아
 * 있으면 옛 버전을 올린다). 그래서 이름은 여기서만 정한다.
 *
 * @param {string} [version] 없으면 manifest 에서 읽는다
 * @returns {Promise<string>}
 */
export async function defaultZipPath(version) {
  const v = version ?? (await extensionVersion());
  return path.join(REPO_ROOT, 'dist', `cici-${v}.zip`);
}

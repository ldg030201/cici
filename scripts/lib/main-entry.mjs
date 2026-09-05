import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 그 모듈이 `node <파일>` 로 **직접 실행**된 진입점인지.
 *
 * `import.meta.url` 은 ESM 로더가 진입점을 realpath 로 풀어서 만든다. 반면
 * `path.resolve()` 는 심볼릭 링크를 풀지 않는다. 그래서 링크를 지나는 절대
 * 경로로 부르면 두 값이 어긋나 스크립트가 **아무 일도 하지 않고 exit 0** 으로
 * 끝난다. macOS 는 `/tmp` 자체가 `/private/tmp` 로의 링크라 특수한 설정도 필요
 * 없다. 그래서 비교하기 전에 argv 쪽을 realpath 로 맞춘다.
 *
 * @param {string} moduleUrl 호출하는 쪽의 `import.meta.url`
 * @returns {boolean}
 */
export function isMainEntry(moduleUrl) {
  if (process.argv[1] === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href;
  } catch {
    return false;
  }
}

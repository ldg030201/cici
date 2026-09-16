/**
 * test/*.test.js 를 직접 찾아 `node --test` 에 명시적인 경로로 넘긴다.
 *
 * package.json 에 글롭(test/*.test.js)을 그대로 쓰면 누가 펼치느냐가 셸에
 * 달린다: bash 는 펼쳐 주지만 Windows 러너의 PowerShell 은 리터럴로 넘기고,
 * Node 가 --test 인자의 글롭을 스스로 푸는 것은 22부터다. 그래서 Windows 의
 * Node 18/20 CI 만 "Could not find 'test\*.test.js'" 로 죽었다. 여기서
 * 디렉터리를 읽어 나열하면 셸도 Node 버전도 상관없고, 파일 목록을 손으로
 * 관리하다 새 테스트 파일을 빠뜨리는 일도 없다.
 *
 * `npm test -- <추가 인자>` 는 그대로 node 에 전달된다
 * (예: npm test -- --test-name-pattern=locateSelf).
 */
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(repo, 'test');
const files = (await readdir(testDir))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(testDir, name));

if (files.length === 0) {
  console.error('test/*.test.js 가 하나도 없습니다 — 테스트가 통째로 사라졌다면 그것부터 의심하세요.');
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(signal !== null ? 1 : code ?? 1));

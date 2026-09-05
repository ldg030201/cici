/**
 * extension/ 을 크롬 웹스토어에 올릴 zip 으로 묶는다.
 *
 * 의존성을 쓰지 않으려고 ZIP 을 직접 쓴다. `zip` CLI 는 윈도우에 없고,
 * Node 에는 zip 라이터가 없다. 포맷 자체는 단순해서 직접 쓰는 편이
 * 플랫폼 분기보다 짧다(deflate 는 zlib 에 있다).
 *
 * 산출물은 **재현 가능**하다 — 타임스탬프를 고정했으므로 같은 입력이면
 * 같은 바이트가 나온다. 그래야 "올린 zip 이 내 소스와 같은가"를 해시로 확인할 수 있다.
 *
 *   node scripts/pack-extension.mjs
 *   node scripts/pack-extension.mjs --out dist/cici.zip
 */

import { deflateRawSync } from 'node:zlib';
import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { arg } from './lib/args.mjs';
import { crc32 } from './lib/crc32.mjs';
import { defaultZipPath, EXTENSION_DIR, extensionVersion, REPO_ROOT } from './lib/paths.mjs';

/**
 * 웹스토어에 올라가면 안 되는 것들.
 *
 * `.DS_Store` 나 `.gitkeep` 은 여기 없어도 된다 — 아래 수집 루프가 점으로
 * 시작하는 이름을 전부 건너뛴다(에디터 백업이나 `.eslintrc` 까지 덤으로 걸린다).
 * 점이 없는 이름만 여기 적는다.
 */
const SKIP = new Set(['Thumbs.db']);

// ---------------------------------------------------------------------------
// ZIP

/**
 * MS-DOS 시각. 재현성을 위해 1980-01-01 00:00 으로 고정한다.
 * (DOS 포맷이 표현할 수 있는 가장 이른 시각이다.)
 */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 1980년 1월 1일

/**
 * @param {Array<{name: string, data: Uint8Array}>} entries
 * @returns {Buffer}
 */
function makeZip(entries) {
  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data);
    const deflated = deflateRawSync(raw, { level: 9 });
    // 압축이 되레 커지는 작은 파일은 그대로 저장한다(method 0).
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 필요 버전
    local.writeUInt16LE(0, 6); // 플래그
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra 없음
    chunks.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // 만든 버전
    dir.writeUInt16LE(20, 6); // 필요 버전
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // 디스크 번호
    dir.writeUInt16LE(0, 36); // 내부 속성
    dir.writeUInt32LE(0o644 << 16, 38); // 외부 속성(유닉스 권한)
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // 주석 없음

  return Buffer.concat([...chunks, centralBuf, end]);
}

// ---------------------------------------------------------------------------

/**
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {Promise<Array<{name: string, data: Uint8Array}>>}
 */
async function collect(dir, prefix = '') {
  /** @type {Array<{name: string, data: Uint8Array}>} */
  const out = [];
  const names = (await readdir(dir)).sort(); // 정렬해야 zip 이 재현 가능하다
  for (const name of names) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const info = await stat(full);
    if (info.isDirectory()) out.push(...(await collect(full, `${prefix}${name}/`)));
    else out.push({ name: `${prefix}${name}`, data: await readFile(full) });
  }
  return out;
}

async function main() {
  const version = await extensionVersion();

  const outArg = arg(process.argv.slice(2), '--out');
  const out = outArg ? path.resolve(outArg) : await defaultZipPath(version);

  const entries = await collect(EXTENSION_DIR);
  if (!entries.some((e) => e.name === 'manifest.json')) {
    throw new Error('manifest.json 이 zip 루트에 없습니다');
  }

  const zip = makeZip(entries);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, zip);

  const kb = (zip.length / 1024).toFixed(1);
  console.log(`${path.relative(REPO_ROOT, out)}  (버전 ${version}, 파일 ${entries.length}개, ${kb} KB)`);
  for (const e of entries) console.log(`  ${e.name}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

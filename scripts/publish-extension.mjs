/**
 * 크롬 웹스토어에 새 버전을 올리고 게시한다.
 *
 * 로컬에서도 쓸 수 있고 GitHub Actions 에서도 같은 스크립트를 쓴다.
 * 필요한 환경 변수(전부 비밀):
 *
 *   CWS_CLIENT_ID       Google Cloud OAuth 클라이언트 ID
 *   CWS_CLIENT_SECRET   같은 클라이언트의 시크릿
 *   CWS_REFRESH_TOKEN   chromewebstore 범위로 발급받은 리프레시 토큰
 *   CWS_PUBLISHER_ID    개발자 대시보드 주소에 들어 있는 게시자 ID
 *   CWS_ITEM_ID         확장의 웹스토어 ID(32자)
 *
 * 사용:
 *   node scripts/publish-extension.mjs                    # 업로드 + 게시
 *   node scripts/publish-extension.mjs --skip-publish     # 업로드만(초안으로 둠)
 *   node scripts/publish-extension.mjs --target trustedTesters
 *   node scripts/publish-extension.mjs --zip dist/cici-0.1.0.zip
 *
 * 설정 방법은 docs/release.md 를 보라.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { arg } from './lib/args.mjs';
import { defaultZipPath, extensionVersion, REPO_ROOT } from './lib/paths.mjs';

const API = 'https://chromewebstore.googleapis.com';

/** @param {string} name @returns {string} */
function need(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `환경 변수 ${name} 가 없습니다. 설정 방법은 docs/release.md 를 보세요.`,
    );
  }
  return value;
}

/**
 * 리프레시 토큰으로 액세스 토큰을 받는다.
 * @returns {Promise<string>}
 */
async function accessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: need('CWS_CLIENT_ID'),
      client_secret: need('CWS_CLIENT_SECRET'),
      refresh_token: need('CWS_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    // invalid_grant 은 리프레시 토큰이 만료됐거나 취소됐다는 뜻이다.
    // 테스트 모드 OAuth 동의 화면의 토큰은 7일 뒤 죽는다 — 흔한 함정이라 짚어 준다.
    const hint = body.includes('invalid_grant')
      ? '\n힌트: OAuth 동의 화면이 "테스트" 상태면 리프레시 토큰이 7일 만에 만료됩니다. ' +
        '동의 화면을 "프로덕션"으로 게시하고 토큰을 다시 발급받으세요.'
      : '';
    throw new Error(`액세스 토큰 발급 실패 (${res.status}): ${body}${hint}`);
  }
  const json = JSON.parse(body);
  if (!json.access_token) throw new Error(`응답에 access_token 이 없습니다: ${body}`);
  return json.access_token;
}

/**
 * @param {string} token
 * @param {string} publisher
 * @param {string} item
 * @param {Uint8Array} zip
 * @returns {Promise<void>} 실패는 throw 로만 알린다
 */
async function upload(token, publisher, item, zip) {
  const url = `${API}/upload/v2/publishers/${publisher}/items/${item}:upload`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' },
    body: zip,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`업로드 실패 (${res.status}): ${body}`);

  /** @type {Record<string, any>} */
  let json = {};
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`업로드 응답을 읽지 못했습니다: ${body}`);
  }

  // 스네이크 케이스 대안을 남겨 둔다. 구 웹스토어 API(v1.1) 는 `itemError` 안을
  // `error_code`/`error_detail` 로 돌려줬고, 이 v2 엔드포인트가 그 표기를 절대
  // 쓰지 않는다고 확인할 방법이 없다. 잘못 맞히면 실패 사유가 `undefined:
  // undefined` 로 나와 릴리스가 막힌 이유를 알 수 없게 된다 — 값이 싸다.
  const state = json.uploadState ?? json.upload_state;
  if (state && state !== 'SUCCESS') {
    const errors = (json.itemError ?? json.item_error ?? [])
      .map((e) => `${e.error_code ?? e.errorCode}: ${e.error_detail ?? e.errorDetail}`)
      .join('\n  ');
    throw new Error(`업로드가 거부됐습니다 (${state})\n  ${errors || body}`);
  }
}

/**
 * @param {string} token
 * @param {string} publisher
 * @param {string} item
 * @param {string} target
 * @returns {Promise<void>} 실패는 throw 로만 알린다
 */
async function publish(token, publisher, item, target) {
  const url = `${API}/v2/publishers/${publisher}/items/${item}:publish`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(target === 'default' ? {} : { target }),
  });
  if (!res.ok) throw new Error(`게시 실패 (${res.status}): ${await res.text()}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const target = arg(argv, '--target') ?? 'default';
  const skipPublish = argv.includes('--skip-publish');

  const version = await extensionVersion();
  const zipPath = arg(argv, '--zip') ?? (await defaultZipPath(version));
  const zip = await readFile(zipPath);

  const publisher = need('CWS_PUBLISHER_ID');
  const item = need('CWS_ITEM_ID');

  console.log(`버전 ${version} · ${path.relative(REPO_ROOT, zipPath)} (${(zip.length / 1024).toFixed(1)} KB)`);

  const token = await accessToken();
  console.log('액세스 토큰 발급 완료');

  await upload(token, publisher, item, zip);
  console.log('업로드 완료');

  if (skipPublish) {
    console.log('--skip-publish 이므로 게시하지 않았습니다. 대시보드에 초안으로 남아 있습니다.');
    return;
  }

  await publish(token, publisher, item, target);
  console.log(`게시 요청 완료 (대상: ${target}). 심사를 거쳐 반영됩니다.`);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});

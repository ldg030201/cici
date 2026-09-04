# 릴리스 자동화

태그 하나 밀면 확장이 크롬 웹스토어에 올라가고 게시까지 되게 해 두었다.
설정은 **한 번만** 하면 되고, 그 뒤로는 명령 두 줄이다.

```sh
npm version patch --no-git-tag-version   # manifest 도 같이 올려야 한다 (아래 참고)
git tag v0.1.1 && git push origin v0.1.1
```

---

## 준비 (최초 1회)

### 1. 확장을 손으로 한 번 올린다

API 는 **이미 존재하는 항목**을 갱신하는 용도다. 첫 등록은 대시보드에서 직접 해야
한다. 스토어 등록 정보(설명, 스크린샷, 개인정보 처리방침)도 그때 채운다.

```sh
npm run pack:ext          # dist/cici-<버전>.zip 이 생긴다
```

[개발자 대시보드](https://chrome.google.com/webstore/devconsole) → **새 항목** →
그 zip 업로드.

등록 후 두 값을 받아 둔다.

| 값 | 어디서 |
| --- | --- |
| `CWS_ITEM_ID` | 확장 상세 페이지 주소의 32자 문자열 |
| `CWS_PUBLISHER_ID` | 대시보드 주소에 들어 있는 게시자 식별자 |

> 대시보드 주소 형태가 계정에 따라 다르다. `CWS_PUBLISHER_ID` 를 못 찾겠으면
> 일단 아무 값이나 넣고 `npm run publish:ext` 를 돌려 보라. 틀리면 403/404 응답
> 본문에 올바른 형식이 그대로 찍힌다.

### 2. Google Cloud 에서 OAuth 자격 증명 만들기

1. [Google Cloud Console](https://console.cloud.google.com) 에서 프로젝트를 만든다.
2. **API 및 서비스 → 라이브러리** 에서 `Chrome Web Store API` 를 사용 설정한다.
3. **OAuth 동의 화면** 을 구성한다. 사용자 유형은 외부.
   **반드시 "프로덕션" 으로 게시하라.** "테스트" 상태로 두면 리프레시 토큰이
   **7일 뒤 만료**되어 배포가 조용히 깨진다. 이게 가장 흔한 함정이다.
4. **사용자 인증 정보 → OAuth 클라이언트 ID** 를 만든다.
   - 애플리케이션 유형: **웹 애플리케이션**
   - 승인된 리디렉션 URI: `https://developers.google.com/oauthplayground`
   - 나온 **클라이언트 ID** 와 **클라이언트 보안 비밀번호** 를 적어 둔다.

### 3. 리프레시 토큰 받기

[OAuth 2.0 Playground](https://developers.google.com/oauthplayground) 에서:

1. 오른쪽 위 톱니바퀴 → **Use your own OAuth credentials** 체크 → 위 클라이언트 ID/시크릿 입력
2. 왼쪽 입력란에 범위를 직접 넣는다: `https://www.googleapis.com/auth/chromewebstore`
3. **Authorize APIs** → 확장을 소유한 구글 계정으로 로그인
4. **Exchange authorization code for tokens** → 나온 **Refresh token** 을 적어 둔다

### 4. GitHub 시크릿 등록

저장소 → Settings → Secrets and variables → Actions → **New repository secret** 로 5개.

```
CWS_CLIENT_ID
CWS_CLIENT_SECRET
CWS_REFRESH_TOKEN
CWS_PUBLISHER_ID
CWS_ITEM_ID
```

명령으로 넣어도 된다.

```sh
gh secret set CWS_CLIENT_ID
gh secret set CWS_CLIENT_SECRET
gh secret set CWS_REFRESH_TOKEN
gh secret set CWS_PUBLISHER_ID
gh secret set CWS_ITEM_ID
```

---

## 배포하기

### 버전 올리기

`package.json` 과 `extension/manifest.json` 의 버전이 **같아야 한다**.
태그와 manifest 가 어긋나면 CI 가 막는다.

```sh
npm version patch --no-git-tag-version
node -e "const f='extension/manifest.json',fs=require('fs'),m=JSON.parse(fs.readFileSync(f));m.version=require('./package.json').version;fs.writeFileSync(f,JSON.stringify(m,null,2)+'\n')"
git commit -am "🔖 v$(node -p "require('./package.json').version")"
```

> 웹스토어는 **버전을 되돌릴 수 없다.** 한 번 올린 번호는 다시 못 쓴다.

### 태그를 밀면 끝

```sh
git tag v0.1.1 && git push origin v0.1.1
```

`.github/workflows/release.yml` 이 순서대로 한다.

1. 테스트 (실패하면 여기서 멈춘다)
2. 태그와 `manifest.json` 버전 대조
3. `extension/lib` 이 `src` 와 동기화됐는지 확인
4. zip 생성 → 아티팩트로 보관
5. 웹스토어 업로드 → 게시
6. GitHub 릴리스 생성 (zip 첨부)

### 게시 없이 올리기만

Actions 탭 → **릴리스** → **Run workflow** → `publish` 를 끈 채 실행.
초안으로만 올라가서 대시보드에서 눈으로 확인한 뒤 직접 게시할 수 있다.

로컬에서도 같다.

```sh
npm run pack:ext
npm run publish:ext -- --skip-publish
```

### 신뢰할 수 있는 테스터에게만

```sh
npm run publish:ext -- --target trustedTesters
```

---

## 알아 둘 것

**매 업데이트마다 심사를 거친다.** 자동 배포는 "제출"까지를 자동화하는 것이고,
실제 반영은 구글 심사 후다. 보통 수 시간에서 며칠 걸리며,
`file:///*` 권한 때문에 수동 검토로 넘어갈 가능성이 있다.

**zip 은 재현 가능하다.** `pack-extension.mjs` 가 타임스탬프를 1980-01-01 로
고정하므로, 같은 소스면 항상 같은 바이트가 나온다. 올린 zip 이 저장소의 그
커밋과 같은지 해시로 확인할 수 있다.

```sh
npm run pack:ext && shasum -a 256 dist/*.zip
```

**리프레시 토큰이 죽으면** `invalid_grant` 이 뜬다. 대부분 OAuth 동의 화면이
"테스트" 상태로 남아 있어서다. 프로덕션으로 게시하고 토큰을 다시 발급받으면 된다.

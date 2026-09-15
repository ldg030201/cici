# 새 버전 배포하기

크롬 웹스토어에 zip 을 올려 갱신한다. 대시보드에서 손으로 하며, 5분쯤 걸린다.

> **왜 자동화하지 않았나.** Chrome Web Store API 로 태그 푸시 한 번에 배포하는
> 구성을 만들어 봤지만 접었다. OAuth 동의 화면을 프로덕션으로 게시하는 단계에서
> 구글이 앱 인증을 요구했고, 인증은 **자기 소유 도메인**의 홈페이지 URL 을
> 요구한다. `github.com` 은 우리 도메인이 아니라 소유권을 증명할 수 없다.
> 아낄 수 있는 시간이 배포당 5분인데 그 대가가 도메인 구입과 몇 주짜리 심사라
> 수지가 맞지 않는다. 배포가 잦아지거나 도메인이 생기면 다시 볼 일이다.

---

## 1. 버전 올리기

`package.json` 과 `extension/manifest.json` 의 버전이 **같아야 한다**.

```sh
node -e "const fs=require('fs');for(const f of ['package.json','extension/manifest.json']){const j=JSON.parse(fs.readFileSync(f,'utf8'));j.version='1.0.1';fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n')}"
```

`1.0.1` 자리에 새 번호를 넣는다.

> 웹스토어는 **버전을 되돌릴 수 없다.** 한 번 올린 번호는 영영 다시 못 쓴다.
> 올리기 전에 번호를 확인할 것.

## 2. 확인

```sh
npm run check:ext && npm test
```

`check:ext` 는 `extension/lib` 의 복사본이 `src` 와 같은지 본다. 이게 어긋나면
스토어에 옛 파서가 올라간다.

## 3. zip 만들기

```sh
npm run pack:ext
```

`dist/cici-<버전>.zip` 이 생긴다. 출력에 들어간 파일 목록이 찍히므로 눈으로
확인할 수 있다.

zip 은 **재현 가능**하다 — 타임스탬프를 1980-01-01 로 고정했으므로 같은 소스면
항상 같은 바이트가 나온다. 올린 zip 이 저장소의 그 커밋과 같은지 해시로 확인할
수 있다.

```sh
shasum -a 256 dist/*.zip
```

## 4. 커밋하고 태그

```sh
git commit -am "🔖 v1.0.1"
git tag v1.0.1
git push origin main --tags
```

태그는 "스토어의 이 버전이 저장소의 이 커밋"을 기록해 둔다. 나중에 특정 버전의
소스를 찾을 때 쓴다.

## 5. 대시보드에 올리기

<https://chrome.google.com/webstore/devconsole>

cici 선택 → **패키지** → **새 버전 업로드** → zip 선택 → **검토를 위해 제출**

## 6. 기다린다

**매 업데이트마다 심사를 거친다.** 보통 며칠, 길면 몇 주. `file:///*` 권한 때문에
수동 검토로 넘어갈 가능성이 있다.

심사 중에도 **이미 게시된 버전은 계속 살아 있다.** 사용자는 기존 버전을 그대로
쓰고, 새 버전만 대기한다.

통과하면 **사용자는 아무것도 안 해도 된다.** 크롬이 몇 시간 안에 알아서
갈아끼운다.

---

## 스토어 등록 정보만 고칠 때

설명·스크린샷·아이콘만 바꾸는 경우에는 zip 을 다시 올릴 필요가 없다. 대시보드의
**스토어 등록 정보** 탭에서 고치고 제출하면 된다. 코드가 없으니 심사도 대체로
빠르다.

문구 원본은 [`store-listing.md`](store-listing.md) 에 있다. 대시보드에서 고쳤으면
그 파일도 같이 고쳐야 둘이 갈라지지 않는다.

## 이미지 다시 만들기

```sh
node scripts/make-icons.mjs                 # extension/icons/*.png
node scripts/make-icons.mjs --store <dir>   # 프로모 타일, 스크린샷 틀
```

스크린샷은 실제 팝업을 찍은 것이라 자동 생성되지 않는다. 다시 찍을 때는 **반드시
가짜 데이터로** — 실제 프로필 이름·이메일·기기 ID 가 스토어에 공개된다.

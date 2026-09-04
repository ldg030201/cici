# cici — Claude In Chrome Id

> **비공식 도구다.** cici 는 Anthropic 이 만들지 않았고 Anthropic 과 아무 관계가 없다.

Claude Code 가 브라우저 선택창에 띄우는 UUID(`bridgeDeviceId`)가 **어느 크롬 프로필의 것인지** 알려 준다.

브라우저를 두 개 이상 연결해 두면 Claude Code 는 이런 목록을 보여 준다.

```
Which browser?
  1. 11111111-2222-4333-8444-555555555555
  2. 66666666-7777-4888-8999-aaaaaaaaaaaa
  3. bbbbbbbb-cccc-4ddd-8eee-ffffffffffff
```

UUID 말고는 아무 단서가 없다. 어느 것이 회사 프로필이고 어느 것이 개인 프로필인지 알아내려면,
프로필마다 Claude in Chrome 확장의 서비스워커 DevTools 를 열고
`chrome.storage.local.get('bridgeDeviceId', console.log)` 을 손으로 쳐야 한다.

cici 는 그 한 가지 질문에만 답한다. **어느 UUID 가 어느 프로필인가.**

읽기만 한다. 쓰지 않고, LevelDB `LOCK` 도 잡지 않으며, 네트워크 요청은 한 건도 하지 않는다.
브라우저가 켜져 있어도 안전하다.

---

## 두 가지 사용법

|  | **확장(MV3)** | **CLI** |
| --- | --- | --- |
| 답하는 질문 | **지금 이 프로필**의 ID + 다른 프로필 목록 | 이 머신의 모든 프로필 |
| 필요한 것 | 크롬 116+ / 파일 URL 접근 토글 1회 | Node 18.17+ |
| 설치 | 확장 설치 → 토글 | `npx cici` |
| 프로필마다 반복 | 필요 (설치·토글 모두 프로필 단위) | 불필요 (한 번에 전부) |

둘 다 같은 파서를 쓴다. 어느 쪽을 쓰든 나오는 값은 같다.

---

## A. 확장으로 쓰기

### 설치

> 크롬 웹스토어 등록은 아직 진행 전이다. 등록용 자료는 [`docs/store-listing.md`](docs/store-listing.md) 에 정리해 두었다.
> 지금은 저장소를 받아 **압축해제된 확장 프로그램**으로 불러오면 된다.

```sh
git clone https://github.com/ldg030201/cici.git
```

1. `chrome://extensions` 를 연다.
2. 오른쪽 위 **개발자 모드**를 켠다.
3. **압축해제된 확장 프로그램을 로드**를 누르고 받은 저장소의 `extension/` 폴더를 고른다.
4. 그 확장의 **세부정보**로 들어가 **"파일 URL에 대한 액세스 허용"** 을 켠다.
5. 확장 아이콘을 눌러 팝업을 연다.

웹스토어에서 설치했을 때도 4·5 단계는 똑같이 필요하다. (웹스토어 설치 시 이 토글의 기본값은 **꺼짐**이고,
확장이 스스로 켤 수 없다.)

### 4단계를 빼먹으면

파일 URL 접근이 꺼져 있으면 팝업이 결과 대신 안내 화면을 띄운다. 버튼 하나로 세부정보 페이지까지 데려다준다.

```
┌──────────────────────────────────────────────┐
│ cici                                         │
│ Claude in Chrome 브리지 ID                    │
├──────────────────────────────────────────────┤
│  파일 URL 접근 권한이 필요합니다               │
│  bridgeDeviceId는 크롬 프로필 폴더 안에        │
│  저장돼 있습니다. 그 파일을 읽으려면           │
│  '파일 URL에 대한 액세스 허용'을 켜야 합니다.   │
│                                              │
│  켜는 방법                                    │
│   1. 아래 버튼으로 세부정보 페이지를 엽니다.    │
│   2. '파일 URL에 대한 액세스 허용'을 켭니다.    │
│   3. 이 팝업을 다시 엽니다.                    │
│                                              │
│  [ 확장 세부정보 열기 ]  [ 주소 복사 ]         │
└──────────────────────────────────────────────┘
```

**토글을 켜면 크롬이 확장을 리로드한다.** 그 순간 열려 있던 팝업은 닫힌다. 정상이다.
브라우저를 다시 시작할 필요는 없고, 팝업만 다시 열면 바로 동작한다.

### 팝업 화면

```
┌──────────────────────────────────────────────┐
│ cici                                    ⟳    │
│ Claude in Chrome 브리지 ID                    │
├──────────────────────────────────────────────┤
│ 현재 프로필                                   │
│ ┌──────────────────────────────────────────┐ │
│ │ Google Chrome                     [현재] │ │
│ │ Personal                                 │ │
│ │ you@example.com                          │ │
│ │                                          │ │
│ │ bridgeDeviceId                  [ 복사 ] │ │
│ │ ┌──────────────────────────────────────┐ │ │
│ │ │ 11111111-2222-4333-8444-555555555555 │ │ │
│ │ └──────────────────────────────────────┘ │ │
│ │ 페어링 이름   MacBook                     │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ 이 컴퓨터의 다른 프로필                        │
│ ┌──────────────────────────────────────────┐ │
│ │ Google Chrome · Work            [ 복사 ] │ │
│ │ work@example.com                         │ │
│ │ 66666666-7777-4888-8999-aaaaaaaaaaaa     │ │
│ ├──────────────────────────────────────────┤ │
│ │ Brave · Default                          │ │
│ │ 아직 페어링되지 않았습니다                  │ │
│ ├──────────────────────────────────────────┤ │
│ │ Google Chrome · Test                     │ │
│ │ 이 프로필에는 Claude 확장이 없습니다        │ │
│ └──────────────────────────────────────────┘ │
├──────────────────────────────────────────────┤
│ cici는 이 컴퓨터의 파일을 읽기만 하고,          │
│ 아무 데도 보내지 않습니다.                     │
└──────────────────────────────────────────────┘
```

UUID 상자를 클릭하거나 **복사** 버튼을 누르면 클립보드로 들어간다.

### 확장이 구분하는 상태

"ID 가 없다"는 한 가지 답이 아니다. 팝업은 다섯 가지를 서로 다르게 말한다.

| 화면 문구 | 뜻 |
| --- | --- |
| UUID 표시 | 페어링됨 |
| 아직 페어링되지 않았습니다 | 확장은 있지만 Claude Code 와 한 번도 연결한 적 없음 |
| 이 프로필에는 Claude 확장이 없습니다 | 확장 자체가 설치돼 있지 않음 |
| 페어링 여부를 알 수 없습니다 | 확장 저장소를 읽지 못함 — 이미 페어링돼 있을 수도 있음 |
| 이 프로필 폴더를 읽지 못했습니다 | 프로필 폴더 자체를 못 읽음 — 확장 유무조차 모름 |

마지막 두 개를 "없음"이라고 말하면 거짓말이 된다. 그래서 나누어 둔다.

### 확장의 권한

`extension/manifest.json` 이 요구하는 것은 두 개뿐이다.

| 권한 | 쓰는 곳 |
| --- | --- |
| `host_permissions: ["file:///*"]` | 프로필 폴더 목록과 LevelDB 파일을 `fetch('file:///…')` 로 읽는다. 사용자가 토글을 켜기 전에는 아무 효과가 없다. |
| `permissions: ["storage"]` | 자기 `chrome.storage.local` 에 난수 하나(`__cici_nonce`)를 써서 **현재 프로필이 어느 폴더인지** 알아낸다. 아래 "동작 원리" 참고. |

`tabs`, `scripting`, `nativeMessaging`, `<all_urls>`, 원격 코드 — 전부 없다.
백그라운드 서비스워커도 없다. 팝업을 열 때만 동작한다.

---

## B. CLI 로 쓰기

```sh
npx cici
```

또는 저장소를 받아서

```sh
git clone https://github.com/ldg030201/cici.git
cd cici
npm link      # 전역에 cici 명령을 만든다
cici
```

`npm link` 없이 `node bin/cici.js` 또는 `npm start` 로 바로 돌려도 된다. 런타임 의존성은 0개다.

### 출력

```
$ cici
Browser        Profile    Name      Email             Paired name  bridgeDeviceId                        Ext
-------------  ---------  --------  ----------------  -----------  ------------------------------------  -----
Google Chrome  Default    Personal  you@example.com   MacBook      11111111-2222-4333-8444-555555555555  1.4.2
Google Chrome  Profile 1  Work      work@example.com  -            66666666-7777-4888-8999-aaaaaaaaaaaa  1.4.2
Brave          Default    Brave     -                 -            not paired                            1.4.2
Google Chrome  Profile 2  Test      -                 -            not installed                         -

bridgeDeviceId is the id Claude Code shows in its browser picker when more than one browser is connected.
```

* `not paired` — 확장은 있지만 아직 Claude Code 와 연결한 적 없음
* `not installed` — 그 프로필에 Claude in Chrome 이 없음 (`--all` 을 줘야 나온다)
* 표가 터미널보다 넓으면 이름·이메일·페어링 이름 칸부터 줄인다. **프로필 칸과 UUID 칸은 절대 줄이지 않는다** —
  줄바꿈된 UUID 는 더블클릭으로 복사할 수 없기 때문이다.

### 플래그

| 플래그 | 하는 일 |
| --- | --- |
| `--json` | 표 대신 JSON 배열로 출력 |
| `--all` | 확장이 설치되지 않은 프로필도 함께 표시 |
| `--user-data-dir <dir>` | 이 user-data 디렉터리만 검사한다. 여러 번 줄 수 있고, 주면 자동 탐색은 꺼진다. `-` 로 시작하는 경로는 `--user-data-dir=<dir>` 형태로 |
| `--ext-id <id>` | 찾을 확장 id (32자, a–p). 여러 번 줄 수 있다. 기본값은 알려진 Claude in Chrome id 들 |
| `--no-color` | ANSI 색 끄기. `NO_COLOR`, `FORCE_COLOR=0`, `TERM=dumb` 도 함께 존중한다 |
| `-q`, `--quiet` | stderr 경고 숨김 |
| `-h`, `--help` | 도움말 |
| `-v`, `--version` | 버전 |

### 종료 코드

| 코드 | 뜻 |
| --- | --- |
| `0` | `bridgeDeviceId` 를 하나 이상 찾음 |
| `1` | 하나도 못 찾음 (어디를 뒤졌는지 stderr 에 적는다) |
| `2` | 인자 오류 |

### 예시

```sh
cici
cici --all
cici --json | jq '.[] | select(.deviceId) | {profileName, deviceId}'
cici --user-data-dir "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
cici --ext-id fcoeoabgfenejglbffodgkkbkcdhcgfn --json
```

---

## 프로그래밍 API

```js
import { scan, scanReport } from 'cici';

const rows = await scan();
for (const row of rows) {
  if (row.deviceId) console.log(row.profileName, row.deviceId);
}

// 어디를 뒤졌는지, 프로필에 매이지 않은 경고까지 함께
const { rows: all, searched, warnings } = await scanReport({ includeUninstalled: true });
```

`scan(options)` 이 돌려주는 행 하나:

```json
{
  "browser": "chrome",
  "browserName": "Google Chrome",
  "userDataDir": "/Users/you/Library/Application Support/Google/Chrome",
  "profileDir": "/Users/you/Library/Application Support/Google/Chrome/Default",
  "profileDirName": "Default",
  "profileName": "Personal",
  "email": "you@example.com",
  "gaiaName": "You",
  "extensionId": "fcoeoabgfenejglbffodgkkbkcdhcgfn",
  "extensionVersion": "1.4.2",
  "deviceId": "11111111-2222-4333-8444-555555555555",
  "displayName": "MacBook",
  "warnings": []
}
```

`ScanOptions` 는 `userDataDirs`, `extensionIds`, `includeUninstalled`, 그리고 테스트용
`platform` / `home` / `env` 를 받는다. `scan()` 은 프로필 하나가 깨져 있다고 던지지 않는다.
문제는 그 행의 `warnings` 로 들어온다.

---

## 동작 원리

### 값이 어디 있나

크롬은 확장의 `chrome.storage.local` 을 프로필 안 LevelDB 에 담는다.

```
<user-data-dir>/<profile>/Local Extension Settings/fcoeoabgfenejglbffodgkkbkcdhcgfn/
├─ CURRENT            → 현재 MANIFEST 파일 이름
├─ MANIFEST-000001    → VersionEdit 로그. 어느 .ldb 가 살아 있는지
├─ 000005.ldb         → SSTable. 데이터 블록은 snappy 압축
└─ 000007.log         → WAL. 32KiB 블록에 담긴 레코드, CRC32C
```

`bridgeDeviceId` 와 `bridgeDisplayName` 이 그 안에 **JSON 문자열**로 들어 있다
(따옴표까지 포함해 저장되므로 `JSON.parse` 가 필요하다).

cici 는 `CURRENT` → `MANIFEST` 재생 → 살아 있는 `.ldb` + `.log` 순으로 진짜 LevelDB 를 읽는다.
`.ldb` 데이터 블록은 자체 구현한 raw snappy 디코더로 풀고, WAL 은 `FULL`/`FIRST`/`MIDDLE`/`LAST`
레코드로 파싱하며 CRC32C 를 검증한다.

**부분문자열 검색은 쓰지 않는다.** `includes('bridgeDeviceId')` 로 WAL 바이트를 뒤지면,
레코드가 32 KiB 블록 경계를 넘는 순간 7바이트 레코드 헤더가 값 한복판에 박혀서 **조용히 값을 놓친다**.
실측으로 10회 중 5회 실패를 재현했다. 기다리거나 다시 시도해도 복구되지 않는다. 진짜 파서만이 찾아낸다.

### 확장은 자기 프로필을 어떻게 아나

확장에는 "내가 어느 프로필 폴더에서 돌고 있는가"를 묻는 API 가 없다.
`chrome.identity.getProfileUserInfo()` 는 로그아웃 프로필에서 빈 값을 주고,
`Default` / `Profile 3` 같은 디렉터리 이름은 신원이 아니다(`--profile-directory=Work` 로 무엇이든 될 수 있다).

그래서 **nonce 왕복**을 쓴다.

1. 팝업이 난수 UUID 를 만들어 **자기** `chrome.storage.local` 에 쓴다.
2. 크롬은 그 쓰기를 곧바로 `<어떤 프로필>/Local Extension Settings/<cici 자신의 id>/*.log` 에 흘려보낸다.
   (실측: `set()` 프로미스가 resolve 되기도 전에 이미 디스크에 있었다.)
3. 팝업이 후보 프로필 폴더들을 `file://` 로 훑으면서, 각 폴더의 **cici 자기 저장소**를 읽는다.
   Claude 쪽 수 MB 짜리가 아니라 수백 바이트짜리다.
4. 그 난수가 들어 있는 폴더가 정확히 하나 있다. 그게 지금 이 프로필이다.
5. 이제 그 프로필의 `Local Extension Settings/fcoeoabg…/` 를 읽어 `bridgeDeviceId` 를 보여 준다.

여기서도 WAL 은 진짜 파서로 읽는다. 같은 32 KiB 문제가 nonce 에도 그대로 적용된다.

### 왜 `file://` 인가

다른 확장의 `chrome.storage` 를 읽는 확장 API 경로는 전부 막혀 있다.
`sendMessage`/`connect`, `chrome.debugger`, `chrome.scripting`, `storage.sync`,
`web_accessible_resources`, `webRequest`, File System Access API, 엔터프라이즈 정책, 제3자 네이티브 호스트 —
하나씩 다 두드려 봤고 전부 잠겨 있다.

열려 있는 문은 하나뿐이다. `host_permissions: ["file:///*"]` + 사용자가 직접 켜는 파일 URL 접근 토글.
그래서 확장이 이렇게 생겼다. 어느 문을 어떻게 두드렸고 무엇으로 확인했는지는
[`docs/why.ko.md`](docs/why.ko.md) 에 근거와 함께 적어 두었다. ([English](docs/why.md))

---

## 지원 범위

### 브라우저

Google Chrome · Chrome Beta · Chrome Dev · Chrome Canary · Chromium · Brave · Microsoft Edge ·
Arc(macOS) · Vivaldi · Opera

### user-data 디렉터리

| OS | 경로 (Chrome 기준) |
| --- | --- |
| macOS | `~/Library/Application Support/Google/Chrome` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data` |
| Linux | `~/.config/google-chrome` |

다른 브라우저는 같은 자리에서 벤더 폴더만 바뀐다
(Brave → `BraveSoftware/Brave-Browser`, Edge → `Microsoft Edge`, Opera → Windows 에서는 `%APPDATA%`).
기본 위치가 아닌 곳에 있다면 CLI 에 `--user-data-dir` 로 알려 주면 된다.

프로필 이름과 이메일은 디렉터리 이름이 아니라 `<user-data-dir>/Local State` 의 `profile.info_cache`
에서 읽는다.

---

## 개인정보

* **네트워크 요청 0건.** CLI 도 확장도 아무 데도 접속하지 않는다. 확장의 CSP 는
  `connect-src 'self' file:` 로 묶여 있어 원격 연결 자체가 불가능하다.
* **읽기 전용.** `readFile` / `readdir` / `stat`(CLI), `fetch('file://…')`(확장)만 쓴다.
  LevelDB `LOCK` 을 잡지 않으므로 브라우저가 켜져 있어도 안전하다.
* **수집·전송·저장 없음.** 읽은 값은 화면에 뿌리고 끝난다. 어디에도 쌓아 두지 않는다.
* 확장이 `chrome.storage.local` 에 쓰는 것은 **자기 자신의** 난수(`__cici_nonce`) 하나뿐이고,
  실행할 때마다 새 값으로 덮어쓴다. 다른 확장의 저장소에는 한 바이트도 쓰지 않는다.

자세한 내용은 [`docs/privacy-policy.md`](docs/privacy-policy.md).

---

## 한계

* **파일 URL 접근 토글은 프로필마다 직접 켜야 한다.** 어떤 API 로도 요청할 수 없고, 확장이 스스로 켤 수 없다.
  웹스토어 설치 시 기본값은 꺼짐이다.
* **확장 설치도 프로필 단위다.** 프로필 5개면 5번 설치하고 5번 켜야 한다.
  전부 한 번에 보고 싶다면 CLI 쪽이 낫다.
* **커스텀 `--user-data-dir` 로 띄운 브라우저는 확장이 찾지 못한다.** 확장은 표준 위치만 훑는다.
  CLI 는 `--user-data-dir` 로 지정할 수 있다.
* **Windows / Linux 의 `file://` 탐색은 macOS 만큼 실측되지 않았다.** 디렉터리 리스팅 형식 자체는
  플랫폼 독립이라 파서는 그대로 통하지만, 경로 탐색은 다르다. snap/flatpak Chromium 은 프로필이
  `~/snap/...`, `~/.var/app/...` 에 있고 브라우저가 추가로 샌드박스돼 있다.
* **크롬이 `file://` 을 조이면 확장 쪽 설계는 한 번에 죽는다.** File System Access API 는 이미
  user-data 디렉터리를 하드 차단하고 있다. CLI 는 브라우저 밖이라 영향받지 않는다.
* **엔터프라이즈 정책** (`URLBlocklist: ["file://*"]` 등)이 확장 경로를 조용히 막을 수 있다.
* **`bridgeDeviceId` 는 페어링 후에만 생긴다.** Claude Code 에서 `/chrome` 을 한 번 돌려
  브라우저를 연결한 적이 없으면 값 자체가 없다.

---

## 개발

```sh
npm test           # node --test test/*.test.js — 334개 테스트, 의존성 0
npm start          # node bin/cici.js
npm run build:ext  # src/ 의 공유 파서를 extension/lib/ 로 복사
npm run check:ext  # 복사본이 원본과 같은지 쓰기 없이 확인
npm run icons      # extension/icons/*.png 재생성
```

빌드 도구는 없다. 확장은 순수 ES 모듈로 그대로 로드된다.

```
src/                     Node ≥18.17, 의존성 0
├─ leveldb-core.js       파서 본체. node: import 이 하나도 없다 — 확장이 이 파일을 그대로 쓴다
├─ snappy.js             .ldb 데이터 블록용 raw snappy 디코더. 역시 공유
├─ leveldb.js            node:fs 어댑터 — readLevelDb(dir)
├─ browsers.js           OS·브라우저별 user-data 위치 → 프로필 목록
├─ claude.js             <profile>/Local Extension Settings/<claude ext id>/
├─ index.js              프로필 하나당 한 행
└─ cli.js                인자 파싱 · 표/JSON 출력

extension/               MV3, 빌드 단계 없음
├─ manifest.json         permissions: storage / host_permissions: file:///*
├─ popup.html/.css/.js   UI. 사람이 읽는 문장은 전부 popup.js 에서 만든다
├─ _locales/{ko,en}/     ko 가 기본
└─ lib/
   ├─ leveldb-core.js  ┐ src/ 의 자동 생성 복사본. 직접 고치지 말 것
   ├─ snappy.js        ┘ build:ext 가 만들고, 테스트가 바이트 단위로 비교한다
   ├─ fileurl.js        file:// 바이트 소스 + Chromium 디렉터리 리스팅 파서
   ├─ locate.js         프로필 열거 + nonce 왕복
   └─ read.js           프로필 → bridgeDeviceId / bridgeDisplayName
```

`extension/lib/leveldb-core.js` 와 `extension/lib/snappy.js` 는 자동 생성물이다.
`src/` 쪽을 고친 뒤 `npm run build:ext` 를 돌린다. 동기화가 깨지면 `npm test` 가 빨개진다.

---

## 문서

| 문서 | 내용 |
| --- | --- |
| [`docs/why.ko.md`](docs/why.ko.md) | 왜 이 구조인가 — 시도한 경로, 막힌 이유, 근거와 검증 방법 |
| [`docs/why.md`](docs/why.md) | 위 문서의 영어판 |
| [`docs/store-listing.md`](docs/store-listing.md) | 크롬 웹스토어 등록용 자료 |
| [`docs/privacy-policy.md`](docs/privacy-policy.md) | 개인정보 처리방침 |
| [`README.en.md`](README.en.md) | 이 문서의 영어판 |

---

## 라이선스

MIT. 자세한 내용은 [`LICENSE`](LICENSE).

cici 는 Anthropic 이 만들지 않은 비공식 도구이며, Anthropic 과 제휴 관계가 없고
Anthropic 의 보증이나 후원을 받지 않았다.
Claude, Claude Code, Claude in Chrome 은 Anthropic 의 상표다.

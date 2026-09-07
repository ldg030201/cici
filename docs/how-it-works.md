# 동작 원리와 한계

값이 어디에 있고, 확장이 자기 프로필을 어떻게 알아내고, 무엇을 못 하는지.

[← README 로 돌아가기](../README.md)

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

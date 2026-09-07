# CLI 자세히

터미널에서 모든 프로필의 `bridgeDeviceId` 를 한 번에 보는 방법.

[← README 로 돌아가기](../README.md)

---

## 설치

npm 에 게시하지 않았다. `cici` 라는 이름은 npm 에 이미 무관한 다른 패키지가 있으므로
**`npx cici` 를 쓰면 안 된다** — 남의 코드가 실행된다.

```sh
git clone https://github.com/ldg030201/cici.git
cd cici
node bin/cici.js
```

`npm link` 를 하면 어디서나 `cici` 로 부를 수 있다. 런타임 의존성은 0개라
설치할 것이 없다.

## 출력

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
* `unreadable` — 파일을 읽지 못해 **모름**. "페어링 안 됨"과 절대 섞지 않는다 —
  디스크에 UUID 가 멀쩡히 있는데 없다고 말하면 이 도구의 존재 이유가 무너진다.
  `--json` 에도 `readFailed` 로 실린다
* 표가 터미널보다 넓으면 이름·이메일·페어링 이름 칸부터 줄인다. **프로필 칸과 UUID 칸은 절대 줄이지 않는다** —
  줄바꿈된 UUID 는 더블클릭으로 복사할 수 없기 때문이다.

## 플래그

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

## 종료 코드

| 코드 | 뜻 |
| --- | --- |
| `0` | `bridgeDeviceId` 를 하나 이상 찾음 |
| `1` | 하나도 못 찾음 (어디를 뒤졌는지 stderr 에 적는다) |
| `2` | 인자 오류 |

## 예시

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

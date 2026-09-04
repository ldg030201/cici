# cici 가 이렇게 생긴 이유

> 결정 기록. 마지막 갱신: 2026-09-04. ([English](why.md))
>
> 아래 내용은 전부 Chromium 소스나 이 머신에 설치된 바이너리에서 읽었거나, 공식 문서에서 인용했거나,
> 일회용 랩에서 재현한 것이다. 측정이 아니라 추론인 부분은 그렇다고 적어 두었다.

---

## 1. 목표, 그리고 선택창 문제

Claude Code 에 브라우저가 두 개 이상 연결돼 있으면 Claude Code 는 하나를 고르라고 하고,
후보를 **`bridgeDeviceId`** 라는 맨 UUID 하나로만 표시한다. 크롬 프로필을 서너 개
(개인, 회사, 고객사, 일회용) 쓰고 있다면 선택창에는 UUID 서너 개가 뜨고, 어느 UUID 가 어느 프로필인지
알려 주는 것은 아무것도 없다. 공식적으로 이 값을 알아내는 유일한 방법은 그 프로필을 열고,
Claude in Chrome 확장의 서비스워커 DevTools 를 열고,
`chrome.storage.local.get('bridgeDeviceId', console.log)` 을 손으로 치는 것이다 — 프로필마다, 매번.

**cici 는 질문 하나에 답하려고 존재한다. 어느 프로필이 어느 `bridgeDeviceId` 를 갖고 있는가?**

값은 Claude in Chrome 확장 자신의 `chrome.storage.local` 에 `bridgeDeviceId` 와
`bridgeDisplayName` 키로 들어 있다. 디스크에서는 다음 경로의 LevelDB 다.

```
<user-data-dir>/<profile>/Local Extension Settings/fcoeoabgfenejglbffodgkkbkcdhcgfn/
```

값은 JSON 으로 저장되므로 날바이트에는 따옴표가 붙어 있고 `JSON.parse` 를 거쳐야 한다.
`.ldb` 데이터 블록은 snappy 로 압축돼 있고, `.log` 로 끝나는 WAL 은 압축돼 있지 않다.

당연히 떠오르는 형태는 브라우저 확장이다. 설치하고, 어떤 프로필에서 열면, 그 프로필의 ID 가 보인다.
거기까지 가는 데 크롬이 가진 거의 모든 문을 두드려 봐야 했다. 이 문서는 어떤 문을 두드렸고,
어느 문이 잠겨 있으며, 왜 cici 가 결국 이런 모양이 되었는지를 기록한 것이다.

---

## 2. 시도한 것들

**검증 방법** 표기:
**[src]** Chromium 소스 또는 이 머신에 설치된 바이너리 · **[doc]** 공식 문서 ·
**[lab]** 일회용 랩에서 재현 (별도 표기가 없으면 Chrome for Testing **148.0.7778.96**) ·
**[static]** 배포된 확장 번들의 정적 분석 · **[reason]** 앞의 두 범주에서 추론한 것, 측정하지 않음.

| 시도한 경로 | 결과 | 근거 | 검증 방법 |
| --- | --- | --- | --- |
| **다른 확장의 `chrome.storage` 직접 읽기** | **막힘 — 설계상.** 확장 간 저장소 표면 자체가 없다. `chrome.storage.*` 는 호출한 확장 범위로 한정되며, 확장 id 를 받는 API 가 하나도 없다. | `storage` API 네임스페이스 어디에도 남의 확장 id 를 받는 인자가 없다. 확장마다 `Local Extension Settings/<id>/` 아래 자기 LevelDB 디렉터리를 갖고, 다른 모든 것과 같은 오리진 경계로 격리된다. | **[doc]** `developer.chrome.com/docs/extensions/reference/api/storage` — API 전체가 확장 단위로 정의돼 있다. **[lab]** 대신 아래의 모든 우회로를 시도했다. |
| **`fcoeoabg…` 로 `runtime.sendMessage` / `runtime.connect`** | **막힘.** 즉시 *"Could not establish connection. Receiving end does not exist."* 로 실패한다. | 대상 확장의 `manifest.json` 은 `"externally_connectable": {"matches": ["https://claude.ai/*", "https://*.claude.ai/*"]}` 를 선언한다 — **`matches` 만 있고 `ids` 키가 없다.** `ids` 가 없으면 어떤 확장도 영원히 메시지를 보낼 수 없다. | **[src]** 이 머신에 설치된 번들 `…/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/<version>/manifest.json` 에서 직접 읽음. **[doc]** `developer.chrome.com/docs/extensions/reference/manifest/externally-connectable` — 확장 간 메시징을 여는 것이 `ids` 이고, 없으면 아무도 못 보낸다. **[lab]** 실제로 시도해 "Could not establish connection" 을 받음. |
| **`chrome.debugger` 로 그 확장의 페이지 / 서비스워커에 attach** | **막힘.** `chrome.debugger.attach` → *"Cannot access a chrome-extension:// URL of different extension."* 크롬을 `--silent-debugger-extension-api` 로 띄워도 그대로다 (그 플래그는 "이 브라우저를 디버깅 중" 배너를 감출 뿐, 대상 집합을 넓히지 않는다). | debugger API 는 플래그와 무관하게 다른 확장 타깃을 거부한다. | **[lab]** attach 해서 에러를 받았고, `--silent-debugger-extension-api` 로 다시 돌려도 같은 에러. **[doc]** `developer.chrome.com/docs/extensions/reference/api/debugger` — "extensions cannot attach to … another extension". |
| **`chrome.scripting.executeScript` 로 그 확장 페이지에 주입** | **막힘.** `chrome.debugger` 와 완전히 같은 에러 문자열: *"Cannot access a chrome-extension:// URL of different extension."* `<all_urls>` 는 다른 확장의 오리진을 포함하지 않는다. | 호스트 권한은 `chrome-extension://<다른 id>/` 접근을 절대 주지 않는다. | **[lab]** `<all_urls>` 를 받은 상태로 시도, 동일하게 거부. **[doc]** `developer.chrome.com/docs/extensions/develop/concepts/match-patterns` — `chrome-extension://` 은 `<all_urls>` 로 매칭되지 않는다. |
| **`chrome.storage.sync` (기대: id 가 동기화되면서 어딘가로 새지 않을까)** | **헛다리.** 그 확장은 브리지 id 를 `sync` 에 넣지 않는다. 넣었더라도 `sync` 는 `local` 과 똑같이 확장 단위로 격리돼 있다. | `bridgeDeviceId` 는 오직 `chrome.storage.local` 에만 쓰인다 (§2.1 에 인용한 getter 참고). | **[static]** 서비스워커의 id getter 는 `chrome.storage.local` 만 읽고 쓴다. |
| **`web_accessible_resources` (기대: 어떤 리소스가 id 를 흘리지 않을까)** | **헛다리.** 그 확장이 노출하는 것은 JS 에셋 파일 정확히 네 개이고, `claude.ai` 와 `<all_urls>` 에 열려 있으며, 그중 어느 것도 id 를 담거나 계산하지 않는다. | 온보딩/콘텐트 스크립트 에셋 두 개(`claude.ai` 매칭)와 페이지 계측 에셋 두 개(`accessibility-tree.js`, `agent-visual-indicator.js`, `<all_urls>` 매칭)가 전부다. 정적 빌드 산출물이지 데이터 채널이 아니다. | **[src]** 설치된 `manifest.json` 에서 읽음. **[static]** 네 파일 어디에도 `bridgeDeviceId` 언급이 없다. |
| **브리지 WebSocket 에 `webRequest` / DNR** | **두 겹으로 막힘.** 그 확장은 실제로 `wss://bridge.claudeusercontent.com/chrome/<accountUuid>` 를 열고, 첫 프레임이 `device_id` 를 담은 `connect` 메시지다. 그런데 (a) `webRequest` 는 WebSocket **메시지 페이로드**를 절대 노출하지 않는다 — 프레임 이벤트가 없고 핸드셰이크 요청만 있다. id 는 프레임 안에 있고, URL 경로에 있는 것은 계정 uuid 이지 device id 가 아니다. (b) 다른 확장이 시작한 요청은 `webRequest` 리스너에게 아예 숨겨진다. 덧붙여, 소켓은 로그인한 프로필에서만 열리므로 흔한 "설치는 했지만 로그인 안 함" 프로필에는 트래픽이 아예 없다. | 소켓 생성부, 그대로 (minified): `` const c=new WebSocket(s) `` 이고 `` s=`${t}/chrome/${r}` ``, 이어서 `` c.onopen=()=>{ … const t={type:"connect",client_type:"chrome-extension",device_id:o, …}; c.send(JSON.stringify(t))} ``, 여기서 `o = await yt()` 이고 `yt()` 가 `bridgeDeviceId` getter 다. 엔드포인트는 `e.localBridge?"ws://localhost:8765":…"wss://bridge.claudeusercontent.com"` 으로 갈린다. | **[static]** 설치된 서비스워커 번들에서 추출. **[doc]** `developer.chrome.com/docs/extensions/reference/api/webRequest` — 이벤트 집합이 핸드셰이크에서 끝나고 프레임 이벤트가 없다. **[src]** `extensions/browser/api/web_request/web_request_permissions.cc` (`WebRequestPermissions::HideRequest`) 가 다른 확장의 요청을 숨긴다. **[reason]** 이 둘의 결합은 논증이지 랩 측정이 아니다. |
| **`localBridge` 개발 경로 (`ws://localhost:8765`)** | **기각.** 로컬 리스너에 `device_id` 를 넘겨 주기는 하는데, 그 플래그는 확장 자신의 설정 안에 있다 — 우리가 쓸 수 없는 바로 그것이다. 순환이다. | 위와 같은 코드. `ws://localhost:8765` 분기는 `le().localBridge` 로 게이팅된다. | **[static]** 번들에서 읽음. 더 파고들지 않음. |
| **user-data 디렉터리에 File System Access API (`showDirectoryPicker`)** | **막힘.** user-data 디렉터리는 크롬의 하드 차단 목록에 있고, 사용자가 직접 골라도 피커가 거부한다. macOS 에서는 `~/Library` 전체가 통째로 막혀 있다. | `kBlockPaths` 에 `BlockPath::CreateRelative(chrome::DIR_USER_DATA, kBlockAllChildren)` 이 있고, macOS 에는 `base::DIR_HOME` + `"Library"` 가 `kBlockAllChildren` 로 들어 있다. | **[src]** `chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc` 의 `kBlockPaths` 테이블 — <https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc>. 로컬 파일 접근에 대한 크롬의 **진행 방향**을 가장 분명하게 보여 주는 신호이기도 하다(§6 위험 참고). |
| **그 확장의 UI** | **헛다리.** 팝업이든 사이드패널이든 `bridgeDeviceId` 를 렌더링하지 않으므로, 설령 접근할 수 있어도 긁을 것이 없다(접근도 못 한다 — `chrome.scripting` 항목 참고). | 번들 안에 그 id 를 포맷하는 UI 문자열이 없다. | **[static]** 번들 전수 검색. |
| **`chrome.management`** | **id 에는 헛다리.** `management` 는 id, 이름, 버전, 활성 상태, 권한 경고, 설치 유형을 알려 준다. 저장소도 프로필 경로도 노출하지 않는다. | `management.getAll()` / `getSelf()` 가 돌려주는 `ExtensionInfo` 에는 저장소 필드도 경로 필드도 없다. 다만 랩 계측 도구로는 쓸모가 있었다 — 설치 경고를 잰 것이 `management.getPermissionWarningsByManifest()` 다(§2.2). | **[doc]** `developer.chrome.com/docs/extensions/reference/api/management` — `ExtensionInfo` 타입. **[lab]** 경고 매트릭스에 사용. |
| **네이티브 메시징 → `get_bridge_identity`** | **존재하지만 제3자는 닿을 수 없다.** 그 확장은 실제로 `get_bridge_identity` 툴 요청에 `{bridge_device_id}` 로 답한다. 그런데 `connectNative()` 를 **하드코딩된 Anthropic 호스트 이름 두 개**로만 부르고, 답도 그 포트로만 보낸다. 제3자 호스트가 끼어들려면 그 두 이름 중 하나를 빼앗아 진짜 Claude Code / Claude Desktop 호스트를 밀어내야 한다. 적대적이고 부서지기 쉽다 — 설계 선택지가 아니다. §2.1 참고. | 호스트 목록이 항목 두 개짜리 리터럴 배열이다. 번들 전체에서 `connectNative` 는 두 번(하나는 `typeof` 가드, 하나는 호출부) 나오고, `com.anthropic` 은 정확히 두 번, 모두 그 리터럴 안에 있다. | **[static]** 설치된 번들에서 출현 횟수를 세어 확인: `connectNative` ×2, `com.anthropic.*` ×2, `get_bridge_identity` ×1. |
| **엔터프라이즈 / 관리형 정책** | **막힘, 그리고 정책은 조이기만 한다.** `chrome.storage.managed` 는 단방향이다. 정책이 값을 *쓰면* 확장이 읽을 수 있을 뿐, 확장의 `local`/`sync` 저장소를 읽는 정책은 없다. 그 확장의 관리형 스키마에는 키가 정확히 세 개 있고 저장소나 호스트 이름과 무관하다. 그중 하나(`thirdPartyDesktopMode`)는 오히려 `get_bridge_identity` 응답을 **억제**한다. | `managed_schema.json` 의 properties: `blockedUrlPatterns`, `thirdPartyDesktopMode`, `forceLoginOrgUUID` — 그게 전부다. 스키마에 없는 정책 키는 확장에 닿기 전에 크롬이 버린다. 응답 경로는 `` async function jr(e){const t=Cr;return!(await p.isDesktopManaged())&&Gr(t,e)} `` 이다 — 관리형이면 응답 없음. 서비스워커의 `chrome.storage.managed` 출현 횟수: **0**. | **[src]** 이 머신에 설치된 번들의 `managed_schema.json`. **[static]** 응답 경로 가드를 번들에서 추출. **[reason]** "확장 저장소를 읽는 정책은 없다"는 정책 표면에서 논증한 부정 명제이지, 전수 증명은 아니다. |
| **`NativeMessagingAllowlist` / `Blocklist` / `UserLevelHosts`, `ExtensionSettings`** | **게이팅 전용 — 그리고 우리를 깨뜨릴 수 있다.** 이들은 *어떤* 호스트와 말할 수 있는지를 정할 뿐, 저장소를 읽거나 호스트 이름을 대체하지 않는다. 부정적인 쪽이 중요하다: `NativeMessagingUserLevelHosts=false` 면 사용자 수준 호스트 매니페스트가 통째로 무시되므로, 네이티브 호스트 설계는 그런 환경에서 아예 돌지 않는다. | Chrome Enterprise 정책 목록의 각 정책 의미. | **[doc]** `chromeenterprise.google/policies/` — 위 네 정책. **[reason]** 능력만 검토했고 랩 테스트는 하지 않았다. |
| **사용자가 "파일 URL에 대한 액세스 허용" 을 켠 뒤, 우리 확장에서 `file://` 읽기** | **열리는 유일한 문.** 토글이 켜져 있으면 `host_permissions: ["file:///*"]` 을 가진 확장이 팝업과 MV3 서비스워커 **양쪽에서** OS 가 허락하는 곳이면 어디든 디렉터리 목록과 파일을 읽을 수 있다 — 실행 중인 크롬의 LevelDB 포함. 토글이 **꺼져** 있으면 — 웹스토어 설치의 기본값이다 — 모든 `file://` fetch 가 `TypeError: Failed to fetch` 로 reject 되고, 확장은 그 사실을 감지할 수는 있어도 고칠 수는 없다. 자세한 내용은 §2.3. | §2.3 참고. | **[lab]** + **[src]** + **[doc]**, §2.3 참고. |

### 2.1 네이티브 메시징 비상구가 왜 닫혀 있나

그 확장의 서비스워커에는 다음이 그대로(minified) 들어 있다.

```js
const t=[{name:"com.anthropic.claude_browser_extension",label:"Desktop"},
         {name:"com.anthropic.claude_code_browser_extension",label:"Claude Code"}];
for(const n of t)try{const e=chrome.runtime.connectNative(n.name); …
```

그리고 답을 줄 핸들러는 이것이다.

```js
if("get_bridge_identity"===n)
  return void(await jr(ir(void 0,{result:{bridge_device_id:await gt(),echo:r?.echo}})));
```

여기에는 인증이 없다. 핸드셰이크는 10초 타임아웃이 붙은 평범한 `{type:"ping"}` / `{type:"pong"}` 교환이다.
자물쇠는 자격증명이 아니라 **채널** 그 자체다. 메시지 디스패처는 `connectNative` 가 돌려준 포트에 정확히 한 번
등록되고, 응답은 저장해 둔 그 포트로만 나간다. 확장은 다른 어떤 호스트에도 연결하지 않으므로 제3자 호스트가
디스패처에 메시지를 밀어 넣을 방법이 없다. 들어가는 유일한 길은 그 두 이름 중 하나를 차지하는 것인데,
"Desktop" 쪽이 먼저 시도되므로 Claude Code 이름만 빼앗으면 Claude Desktop 이 깔린 머신에서는 진다.
이 머신에서는 두 매니페스트 모두 사용자 소유(`rw-r--r--`)라 덮어쓰는 것이 *기술적으로는* 가능하고,
그러면 사용자의 진짜 Claude Code 와 Claude Desktop 브리지가 망가진다. 우리는 그러지 않으며, 다른 무엇도 그래서는 안 된다.

### 2.2 설치 경고의 반전: `file:///*` 은 경고를 하나도 만들지 않는다

`chrome.management.getPermissionWarningsByManifest()` 로 측정 **[lab]**.

| 매니페스트 조각 | 생성되는 권한 경고 |
| --- | --- |
| `host_permissions: ["file:///*"]` | `[]` — **없음** |
| `host_permissions: ["file://*/*"]` | `[]` |
| `content_scripts.matches: ["file:///*"]` | `[]` |
| `optional_host_permissions: ["file:///*"]` | `[]` |
| `host_permissions: ["<all_urls>"]` | "모든 웹사이트의 내 데이터 읽기 및 변경" |
| `host_permissions: ["https://example.com/*"]` | "example.com의 내 데이터 읽기 및 변경" |
| `permissions: ["nativeMessaging"]` | "협력 네이티브 애플리케이션과 통신" |

우리가 테스트한 빌드의 특이사항이 아니라 구조적인 것이다.
`ChromePermissionMessageProvider::AddHostPermissions()` 는
`GetDistinctHosts(…, /*exclude_file_scheme=*/true)` 를 호출하고,
`permission_message_util.cc` 에는
`if (exclude_file_scheme && pattern.scheme() == url::kFileScheme) continue;` 가 있다 **[src]** —
<https://source.chromium.org/chromium/chromium/src/+/main:extensions/common/permissions/permission_message_util.cc>.
파일 스킴 호스트는 경고 생성에서 제외되는데, *바로 그 대신* 별도 토글로 접근을 막아 두었기 때문이다.

여기서 새겨 둘 것이 둘 있다.

* `file:///*` 만 요구하는 확장의 설치 프롬프트는 **"이 확장 프로그램에는 특별한 권한이 필요하지 않습니다."**
  라고 말한다. 조용하지만, 우리가 찾아낸 구멍이 아니라 크롬 자신의 설계다.
* 매니페스트가 *그 밖에* 무엇을 요구하느냐가 사용자에게 보이는 전부다. `file:///*` + `tabs` + `scripting` 을
  가진 프로브 확장은 *"내 방문 기록 읽기"* 를 띄웠다. 그러니 매니페스트를 `file:///*` + `storage` 로만 묶어 둘 것.
  cici 가 실제로 그렇게 배포된다.

### 2.3 `file://` 문, 자세히

**웹스토어 설치의 기본값은 꺼짐이고, 이 머신에서 그것을 증명할 수 있다.**
사용자의 진짜 크롬에서 웹스토어로 설치된 확장(`location: 1` = `INTERNAL`, `from_webstore: true`)은 전부
`creation_flags: 9` = `REQUIRE_KEY|FROM_WEBSTORE` 를 기록하고 있다 — `ALLOW_FILE_ACCESS` 비트(값 4)가
**설정돼 있지 않다** — 그리고 **`newAllowFileAccess` 키 자체가 없다**
**[src, `Secure Preferences` 읽기 전용 조사]**. 모든 프로필에서 발견된 서로 다른
`(creation_flags, location)` 쌍: `(1,5)` 컴포넌트, `(9,1)` 웹스토어, `(137,6)` 과 `(137,10)` 선설치 —
비트 2 는 어디에서도 켜져 있지 않았다.

메커니즘은 Chromium 쪽에 있다. `ExtensionRegistrar::FinishInstallation()` 은
`Manifest::ShouldAlwaysAllowFileAccess(location)` 이 참일 때만 파일 접근을 자동 부여하고,
그 조건은 `IsUnpackedLocation(location)` — 즉 `kUnpacked` **또는** `kCommandLine` 뿐이다.
웹스토어 설치는 `kInternal` 이라 절대 자동 부여되지 않으며, pref 가 없으면
`ExtensionPrefs::AllowFileAccess()`(pref 키 `"newAllowFileAccess"`)는 false 를 돌려준다 **[src]**:
<https://source.chromium.org/chromium/chromium/src/+/main:extensions/browser/extension_registrar.cc>,
<https://source.chromium.org/chromium/chromium/src/+/main:extensions/browser/extension_prefs.cc>.
`newAllowFileAccess` 라는 문자열은 배포된 148 프레임워크 바이너리 안에 실제로 들어 있다 **[src]**.
문서도 같은 말을 한다 — 매치 패턴: 파일 URL 은 *"사용자가 직접 접근을 허용해야 한다"*,
권한 선언: *"확장이 `file://` URL 에서 실행돼야 한다면 … 사용자가 세부정보 페이지에서 접근을 허용해야 한다."* **[doc]**

**이것은 우리 자신의 초기 랩 작업에 대한 가장 큰 정정이기도 하다.** 초기의 `file://` 성공은 전부
`--load-extension` 아래에서 측정한 것인데, 이 방식은 `creation_flags: 38`(`= 2|4|32`, `ALLOW_FILE_ACCESS` 포함),
`location: 8`(`COMMAND_LINE`) 을 만들고 첫 설치 때 `"newAllowFileAccess": true` 를 써 넣는다 **[lab]**.
랩은 조용히 *부여된* 상태를 테스트하면서 그것을 기본값이라고 부르고 있었다.
아래는 전부 토글을 명시적으로 끈 상태로 다시 측정한 것이다.

| 질문 | 답 |
| --- | --- |
| 접근이 꺼져 있으면 어떻게 보이나? | 모든 `file://` `fetch()` 가 `TypeError: Failed to fetch` 로 reject 된다 — 팝업 문서와 MV3 서비스워커에서, 파일이든 디렉터리든 없는 경로든 똑같다. 비동기 `XMLHttpRequest` 는 `status === 0` 인 `onerror` 를 준다. 서비스워커에는 `XMLHttpRequest` 자체가 없다. 페이지에서의 *동기* XHR 만 `DOMException`(`NetworkError`)을 던진다 — 유일한 비대칭이다. **[lab]** |
| 확장이 그것을 감지할 수 있나? | 그렇다. 추가 권한 없이 확실하게: **`chrome.extension.isAllowedFileSchemeAccess()`** — MV3 에서, 팝업과 서비스워커 양쪽에서, 콜백형과 프로미스형 모두 동작한다. `chrome.permissions.contains({origins:['file:///*']})` 도 상태를 따라간다. **`chrome.permissions.getAll()` 은 쓰면 안 된다** — 접근이 꺼져 있어도 `file:///*` 을 계속 나열한다. 최악의 거짓 양성이다. **[lab]** |
| 확장이 스스로 켤 수 있나? | **없다.** 진짜 사용자 제스처와 함께 `chrome.permissions.request({origins:['file:///*']})` 를 불러도 *"Extension must have file access enabled to request 'file:///*'."* 로 실패한다. 그 포맷 문자열이 배포 프레임워크 바이너리 안에 그대로 있다 **[src]**. `chrome.developerPrivate` 는 `chrome://extensions` 밖에서는 undefined 다. `chrome.tabs.create({url:'file://…'})` 조차 거부된다: *"Cannot navigate to a file URL without local file access."* **[lab]** |
| 그럼 무엇을 할 수 있나? | 토글까지 딥링크로 데려다주는 것: `chrome.tabs.create({url:'chrome://extensions/?id=<자기 id>'})` 는 **`tabs` 권한 없이도** 성공하고 실제로 세부정보 페이지에 도착한다. 개발자 모드가 꺼져 있어도 토글 행은 그려진다. **[lab]** |
| 켜면 재시작이 필요한가? | 기능적으로는 **아니다** — 같은 브라우저 프로세스의 새 페이지가 곧바로 파일을 읽는다. 다만 크롬 자신의 UI 에는 *"이 설정 변경사항은 Chromium을 다시 시작하면 적용됩니다."* 라는 문자열이 있고(`en.lproj/locale.pak`, 오프셋 105280, *"Allow access to file URLs"* 라벨은 오프셋 233581), `fileAccessPendingChange` 필드로 게이팅되는 `#allow-on-file-urls-warning` 요소도 있다. 그 상태를 유발한 적은 없지만 존재하기는 하므로, 안내 문구는 그냥 재시작해 버리는 사용자에게도 맞아야 한다. **[lab + src]** |
| UX 함정은? | 토글을 뒤집으면 크롬이 **확장을 리로드한다** — 열려 있던 팝업 문서가 파괴된다. 그래서 "뒤집힌 것을 감지해 그 자리에서 복구"는 불가능하고, 사용자가 팝업을 다시 열어야 한다. 다시 열면 곧바로 동작한다. **[lab]** |
| 켜진 뒤 읽기는 얼마나 빠른가? | 신경 쓸 필요 없을 만큼. 이 머신의 실제 Claude LevelDB 디렉터리는 프로필당 약 0.8 MB ~ 6.5 MB 였고, 브라우저에 이식한 파서로 프로필 하나를 처리하는 데 **5.6 ~ 50.6 ms** 가 걸렸다(2.1 MB 짜리 `.ldb` 하나를 fetch 하는 데 1.1 ms). 자기 프로필 탐지까지 포함한 전체 탐색 — 난수 기록 + 모든 홈 + 브라우저 계열 10개 + 프로필 디렉터리 9개 순회 — 은 **13 ~ 22 ms**, fetch 25회, 약 141 KB 였다. **[lab]** |
| `file://` 응답에 이상한 점은? | 있다. 그리고 순진한 구현을 물어뜯는다. **파일**은 `status 200, ok true` 를 주는데, **디렉터리**는 `status 0, ok false, redirected true, 빈 헤더` 를 주면서 — *본문은 멀쩡하게 온다*(Chromium 이 생성한 리스팅 HTML). `if (!res.ok) throw` 를 쓰면 디렉터리 목록 기능이 통째로 죽는다. 원인은 `content/browser/loader/file_url_loader_factory.cc` 에 있다: `FileURLLoader` 는 `"HTTP/1.1 200 OK"` 헤더를 합성하는데 `FileURLDirectoryLoader` 는 `head->headers` 를 아예 설정하지 않는다 **[src]** — <https://source.chromium.org/chromium/chromium/src/+/main:content/browser/loader/file_url_loader_factory.cc>. 올바른 규칙: **프로미스가 resolve 되면 성공한 것이다.** `status` 는 "파일"과 "디렉터리 리스팅"을 구별하는 데에만 쓴다. |
| 더 나쁜 함정 | 존재하지만 열거할 수 없는 디렉터리(권한 거부)는 reject 되지 **않는다.** 멀쩡해 보이는 빈 리스팅으로 resolve 되거나, 아니면 본문이 **영영 오지 않고 fetch 가 무한정 매달린다.** 다중 사용자 macOS 에서 이건 가상의 이야기가 아니다 — 다른 사용자의 홈은 `drwxr-x---` 이고 `~/Library` 는 `drwx------` 다. **모든 `file://` fetch 에 `AbortController` 타임아웃이 필요하다.** **[lab]** |
| 디렉터리 리스팅 파싱 | Chromium 은 항목마다 `<script>addRow("이름","url",isdir,size,"크기문자열",epoch,"날짜문자열");</script>` 를 하나씩 뱉는다. 함정들: `isdir` 은 `true`/`false` 가 **아니라** `0`/`1` 이다. 크기·날짜 문자열은 로케일에 맞춰 포맷돼 있다(절대 파싱하지 말 것). 이름은 JS 문자열 리터럴이다(`JSON.parse` 로 언이스케이프). `<head>` 에는 `addRow` 의 *정의*도 들어 있으므로 `addRow("` 에 앵커를 걸어야 한다. `DOMParser` 는 스크립트를 실행하지 않아 쓸모가 없고, 서비스워커에는 `DOMParser` 자체가 없다. "리스팅이 0행을 냈다"는 **치명적 오류로 다뤄야 한다** — 그러지 않으면 리스팅 형식 변경과 "확장이 설치돼 있지 않음"을 구별할 수 없다. **[lab]** |

---

## 3. 그래서 cici 는 이렇게 동작한다

### 3.1 배포되는 설계: 파서 하나, 프런트엔드 둘

두 프런트엔드 모두 이 저장소에서 나온다. 파서는 **플랫폼 import 가 하나도 없이** 한 번만 작성돼 있고,
바이트를 공급하는 쪽이 둘이다. CLI 는 `node:fs`, 확장은 `fetch('file://…')`.

```
src/  (Node ≥18.17, 의존성 0)
 ├─ leveldb-core.js  파서. CURRENT → MANIFEST(VersionEdit 재생) → 살아 있는 *.ldb + *.log(WAL).
 │                  node: import 이 없다 — 확장이 이 파일을 그대로 실행한다.
 ├─ snappy.js        .ldb 데이터 블록용 raw snappy 압축 해제. 역시 공유.
 ├─ leveldb.js       node:fs 어댑터: directorySource() → readLevelDbFrom()
 ├─ browsers.js      브라우저 계열·플랫폼별 알려진 user-data 위치 → 프로필 디렉터리
 ├─ claude.js        <profile>/Local Extension Settings/<claude ext id>/
 └─ index.js         프로필당 한 행: 브라우저, 프로필 디렉터리, 프로필 이름, deviceId

extension/  (MV3, 빌드 단계 없음 — 순수 ES 모듈로 로드된다)
 ├─ manifest.json    permissions: ["storage"], host_permissions: ["file:///*"] — 그게 전부
 ├─ popup.js         UI: 현재 프로필 카드가 먼저, 그다음 다른 프로필들
 ├─ _locales/{ko,en} 사람이 읽는 모든 문장. 기본 로케일은 ko
 └─ lib/
    ├─ leveldb-core.js  ┐ src/ 의 자동 생성 복사본. 직접 고치지 말 것.
    ├─ snappy.js        ┘ `npm run build:ext` 가 만들고, `npm run check:ext` 와
    │                     test/extension.test.js 가 원본과 바이트 단위로 같은지 검사한다.
    ├─ fileurl.js       file:// 바이트 소스 + Chromium 디렉터리 리스팅 파서
    ├─ locate.js        프로필 열거 + nonce 왕복 (§3.2)
    └─ read.js          프로필 → bridgeDeviceId / bridgeDisplayName
```

`extension/lib/*.js` 에 쓸 수 있는 것은 `scripts/build-extension.mjs` 하나뿐이다.
import 가 아니라 복사인 것은 의도적이다. 확장은 자기 패키지 바깥에서 import 할 수 없고,
번들러를 들이면 이 프로젝트가 거부해 온 첫 번째 빌드 의존성이 되며, 심볼릭 링크는 `.crx` 로 묶을 때 살아남지 못한다.

배포 확장에는 **백그라운드 서비스워커가 없다.** 랩에서는 서비스워커에서도 `file://` 읽기가 되는 것을 확인했지만,
배포판에 넣을 이유가 없다. 팝업을 열 때만 동작하는 편이 공격 표면도 심사 표면도 작다.

중요한 성질들:

* **엄격히 읽기 전용.** `readFile` / `readdir` / `stat` 뿐이다. LevelDB `LOCK` 을 절대 잡지 않으므로
  브라우저가 열려 있는 상태에서 돌려도 안전하다. Chromium 의 `env_chromium.cc` 는 이 파일들을
  `FILE_SHARE_READ` 계열 공유로 열기 때문에, 살아 있는 WAL 과 MANIFEST 를 Windows 와 Linux 에서도 읽을 수 있다
  **[src]** — <https://source.chromium.org/chromium/chromium/src/+/main:third_party/leveldatabase/env_chromium.cc>.
* **부분문자열 검색이 아니라 진짜 LevelDB.** WAL 을 레코드(`FULL`/`FIRST`/`MIDDLE`/`LAST`)로 파싱하며
  CRC32C 를 검증하고, MANIFEST 를 재생해 어느 테이블이 살아 있는지 판단한다. 이것은 결벽이 아니다.
  날 WAL 바이트에 대한 순진한 `includes('bridgeDeviceId')` 는 레코드가 32 KiB 블록 경계를 넘어
  7바이트 레코드 헤더가 문자열 안에 떨어지는 순간 **값을 조용히 놓친다.**
  오프셋을 의도적으로 조절한 약 2 MB WAL 에서 10회 중 5회 실패를 재현했다 **[lab]**.
  기다리거나 재시도해서 복구되지 않는다. 진짜 파서만이 찾아낸다.
* **자기 프로필 탐지는 실측으로 확실하다.** nonce 왕복(§3.2)은 21회 시행 21회 성공했고,
  같은 확장을 깐 프로필 3개로 교차 검증했을 때 오탐이 0이었다 **[lab]**.
  브라우저에 이식한 파서로 실제 프로필 4개를 모두 정확히 파싱했다.
* **CLI 쪽은 권한 프롬프트도, 토글도, 심사도 없다.** 사용자가 이미 소유한 파일을 읽을 뿐이다.
* `npm test` 가 끝에서 끝까지 덮는다(`node --test`, 테스트 프레임워크 없음): 실제 LevelDB 가 만든 픽스처에
  대한 파서, CLI, 가짜 `file://` 파일시스템에 대한 확장 라이브러리, DOM 심에 대한 팝업.
  현재 22개 스위트 **334개 테스트**가 통과한다(`npm test` 로 확인할 수 있다).

### 3.2 확장, 그리고 자기 위치 찾기

*"이 프로필의 id"* 를 보여 주려는 확장에는 문제가 하나가 아니라 둘이다.
Claude 확장의 LevelDB 를 읽는 것이 문제 1이고(`file://` + 사용자가 켠 토글로 해결),
더 미묘한 문제 2가 있다. **확장은 자기가 어느 프로필 디렉터리에서 돌고 있는지 전혀 모른다.**
물어볼 API 가 없다 — `chrome.runtime.getPackageDirectoryEntry()` 는 가상의 `/crxfs` 루트를 돌려주고,
`chrome.management.getSelf()` 에는 경로가 없으며, 이 용도의 `chrome.system.*` 은 존재하지 않고,
`chrome.identity.getProfileUserInfo()` 는 로그아웃 프로필에서 빈 문자열을 돌려준다
(게다가 무엇이든 돌려받으려면 `identity.email` 권한이 필요하다).

동작하는 기법 — **nonce 왕복**이라고 부르자.

1. 팝업이 난수 UUID 를 만들어 **자기** `chrome.storage.local` 에 쓴다.
2. 크롬은 그 쓰기를 `<어떤 프로필>/Local Extension Settings/<cici 자신의 id>/*.log` 로 곧바로 흘려보낸다.
   확인됨: 작은 `set()` 하나가 WAL 을 정확히 51바이트 늘린다. Chromium 의 `env_chromium.cc` 안
   `WritableFile` 이 write-through 라서 64 KiB 사용자 버퍼가 없기 때문이다. 별도의 `fs` 폴러가
   `set()` 프로미스가 resolve 되기 **전에** 이미 디스크에서 nonce 를 보았다 **[lab]**.
3. 팝업이 `file://` 로 후보 프로필 디렉터리를 열거하며 각 프로필에서 **자기** 저장소 디렉터리를 읽는다 —
   수 MB 짜리 Claude 쪽이 아니라 수백 바이트짜리다.
4. 정확히 하나에 그 nonce 가 들어 있다. 그게 지금 돌고 있는 프로필이다.
   (새로 만든 UUID 는 충돌할 수 없으므로 논리적으로 빈틈이 없고, 확장이 설치된 프로필 3개로
   측정했을 때 실제로도 정확했다 **[lab]**.)
5. *이제* 그 프로필의 `Local Extension Settings/fcoeoabg…/` 를 읽어 `bridgeDeviceId` 를 보고한다.

이 설계가 지켜야 하는 규칙 셋. 전부 대가를 치르고 배웠다.

* **WAL 은 `String.includes` 가 아니라 진짜 파서로 뒤진다** — 위와 같은 32 KiB 파편화 버그다.
  데이터가 디스크에 있는데도 증명 가능하게 찾을 수 없는 실패 유형이다. nonce 를 찾을 때도 마찬가지다.
* **디렉터리 이름으로 신원을 추정하지 않는다.** `Default` / `Profile N` 은 관습이지 규칙이 아니다.
  프로필 디렉터리는 무엇으로든 이름 붙을 수 있고(`--profile-directory=Work`),
  `/^Profile \d+$/` 로 매칭하는 열거는 아무것도 못 찾고 조용히 끝난다.
  프로필 이름과 이메일은 `<user-data-dir>/Local State` 의 `profile.info_cache` 에서 읽어야 한다.
  이 파일도 `file://` 로 읽힌다 **[lab]**.
* **`Local Extension Settings/<id>/` 가 없다고 "설치 안 됨"이 아니다.** 크롬은 첫 `chrome.storage.local`
  접촉 때 그 디렉터리를 지연 생성한다. 설치했지만 한 번도 실행하지 않은 확장에는 디렉터리가 없고,
  저장소를 읽기만 한 확장은 0바이트 WAL 을 갖고 경고 없이 키 0개로 파싱된다. UI 는 구별해야 한다:
  *파일 접근 없음* / *그런 프로필 없음* / *확장은 있지만 쓴 적 없음* / *썼지만 페어링 안 됨* / *페어링됨*.
  다섯 중 둘은 순진한 구현에서 똑같아 보인다 **[lab]**.
  배포되는 팝업은 이 다섯 가지를 서로 다른 문구로 말한다.

`chrome.identity.getProfileUserInfo` 는 로그아웃 프로필에서 `{email:'', id:''}` 를 돌려주므로
자기 탐지의 주 수단이 될 수 없다 **[lab]**. 보조 신호로만 가치가 있다.

---

## 4. 대안 비교, 정직하게

| | **A. CLI 만** | **B. 순수 확장, `file://`** | **C. 확장 + 네이티브 호스트** |
| --- | --- | --- | --- |
| **"어느 프로필이 어느 id?" 에 답하나** | 그렇다, 모든 프로필을 한 번에 | 그렇다 | 그렇다 |
| **"*이* 프로필의 id" 를 그 자리에서 답하나** | 아니다(전부 나열하면 프로필 이름으로 맞춰야 한다) | 그렇다 | 그렇다 |
| **비개발자도 쓸 수 있나** | 아니다 — Node/npx 필요 | 대체로 — 토글 하나 | 아니다 |
| **런타임 설치 필요** | Node ≥18.17 | 없음 | Node(또는 서명된 바이너리) |
| **무서워 보이는 권한** | 없음 | `file:///*` — 다만 설치 프롬프트에는 **경고가 뜨지 않는다**(§2.2). 눈에 보이는 비용은 *토글* 쪽이다 | "협력 네이티브 애플리케이션과 통신" |
| **어떤 API 로도 요청 못 하는 사용자 게이트** | 없음 | **있다 — 파일 URL 토글, 프로필마다** | 없음(설치 단계는 별도) |
| **크롬이 `file://` 을 조여도 살아남나** | 그렇다(브라우저 밖이다) | **아니다** | 그렇다 |
| **웹스토어 심사 위험** | 해당 없음 | **실재한다** — 브라우저 자신의 user-data 디렉터리를 읽는 것이 목적인 확장 | 더 낮다 |
| **크로스플랫폼 확신** | 높음(CLI 는 이미 레이아웃을 다룬다) | **낮음** — `file://` 탐색은 macOS 에서만 측정했다 | 중간 |
| **순환성** | — | 없음 | **치명적**: 호스트를 설치하려면 그 확장이 대체하려는 바로 그 CLI 가 필요하다 |

### 정확한 설치 단계

**A. CLI 만**

```
npx cici              # 또는: npm i -g cici && cici
```

명령 하나. Node ≥18.17 필요. 아무것도 쓰지 않고 아무것도 실행하지 않는다.

**B. 순수 확장 (채택안)** — macOS 와 Windows 가 동일하다:

1. 크롬 웹스토어에서 설치(클릭 2번). 설치 프롬프트는 *"이 확장 프로그램에는 특별한 권한이 필요하지 않습니다."* 라고 말한다.
2. `chrome://extensions/` 를 연다(확장의 "파일 접근 허용" 안내 화면이 여기로 딥링크한다 —
   `tabs` 권한 없이 동작한다).
3. cici 의 **세부정보**를 연다.
4. **"파일 URL에 대한 액세스 허용"** 을 켠다. 크롬이 재시작 후 적용된다고 말할 수 있는데, 실제로는 필요 없다.
   재시작해도 해는 없다.
5. cici 아이콘을 다시 클릭한다(토글이 확장을 리로드했으므로 열려 있던 팝업은 사라졌다).
6. **프로필마다 반복.** 확장 설치가 프로필 단위이므로 설치도 토글도 프로필 단위다.

관리자 권한도, 런타임도, 다운로드도, 재시작도 없다. 진짜 이탈 위험은 4단계 하나뿐이다.

**C. 확장 + 네이티브 호스트** — 기록을 위해, 왜 기각했는가:

*macOS*: 확장 설치 → 터미널 열기 → Node 없으면 설치 → `npx cici install-host`(호스트 스크립트를 쓰고
`chmod 0755`, 브라우저마다 `NativeMessagingHosts/*.json`) → 아이콘 클릭. 재시작은 필요 없다(확인함).
Node 대신 패키징된 바이너리를 배포하면 2–3단계가 다운로드로 바뀌지만, 그러면 macOS 격리 속성 때문에
*"개발자를 확인할 수 없기 때문에 열 수 없습니다"* 가 뜬다 — Apple 공증을 돈 주고 받지 않는 한.
npm 으로 설치된 스크립트에는 격리 속성이 붙지 않으므로, 역설적으로 Node 를 요구하는 쪽이 *더 나은* UX 다.

*Windows*: 위와 같고, 거기에 `.bat` 래퍼(크롬은 `.js` 를 직접 실행할 수 없다)와 `HKCU` 레지스트리 값이 붙는다
(관리자 권한은 필요 없다). 서명 없는 `.exe` 는 SmartScreen 에 걸린다.

그리고 랩에서 찾은 결정타: Dock/Finder/시작 메뉴에서 띄운 브라우저에 대해 `#!/usr/bin/env node` 는
**동작하지 않는다.** 그런 브라우저는 launchd/데스크톱 세션 환경을 상속하는데
(이 머신에서는 `PATH=/usr/bin:/bin:/usr/sbin:/sbin` — `launchctl getenv PATH` 는 비어 있다),
거기에는 nvm 이나 Homebrew 의 `node` 가 없다. 호스트가 아예 시작되지 않고 확장은
*"Native host has exited."* 를 보고한다 — 인터프리터가 없다는 뜻인데 크래시처럼 읽히는 메시지다.
`env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin` 로 랩 브라우저를 띄워 재현했고, 절대 경로 셔뱅으로 고쳐졌다 **[lab]**.
어떤 네이티브 호스트 설치기도 인터프리터 절대 경로를 하드코딩해야 한다.
여기에 순환성 — *`npx cici install-host` 를 돌릴 수 있는 사람은 그냥 `npx cici` 를 돌리면 된다* — 까지 더하면,
이 설계는 필요로 하지 않는 사용자층을 위해 큰 비용을 치르는 셈이다.

---

## 5. 우리 테스트 재현하기

랩에서 나온 것은 이 저장소에 하나도 들어 있지 않다. 의도적이다 — 일회용 브라우저 프로필과 프로브 확장이기 때문이다.
다시 세우는 방법은 다음과 같다.

**우리가 지킨 규칙, 그리고 당신도 지켜야 할 규칙**

* 사용자의 진짜 브랜디드 크롬을 절대 실행하지 말 것. 그 user-data 디렉터리에 아무것도 쓰지 말 것.
  위의 모든 읽기 전용 조사는 브라우저가 아니라 `cat`/`python3` 로 파일을 읽어서 했다.
* 모든 작업은 저장소 바깥의 스크래치 디렉터리에서.
* 브라우저 실행은 전부 타임아웃으로 감싸고 끝나면 죽일 것. 끝내기 전에 남은 프로세스가 없는지 확인할 것.
  (그리고 이 머신에서 다른 에이전트/스크립트가 이름으로 `pkill` 할 수 있다면 앱 번들 복사본에 고유한 이름을 붙일 것.
  이웃의 정리 작업이 측정 도중 브라우저를 죽여 그럴듯한 거짓 신호를 만들어 내는 바람에 한 시간을 잃었다.)

**브라우저.** Chrome for Testing (Playwright 캐시가 편한 공급원이다):

```
"$HOME/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" --version
# Google Chrome for Testing 148.0.7778.96  ← 이 문서의 모든 [lab] 결과가 나온 버전
```

**드라이버.** Node 24 에는 전역 `fetch` 와 `WebSocket` 이 있어 의존성이 필요 없다.
`--remote-debugging-port=<port> --user-data-dir=<scratch>/udd --no-first-run --no-default-browser-check`
로 띄우고, `http://127.0.0.1:<port>/json` 을 폴링해 타깃을 찾고, 타깃의 `webSocketDebuggerUrl` 에 연결한 뒤
팝업 문서·탭으로 연 확장 페이지·MV3 서비스워커 타깃에 대해 `Runtime.evaluate`(`awaitPromise: true`)를 돌린다.
`chrome.developerPrivate` 가 필요하면 `chrome://extensions` 에도 같은 식으로 붙는다.

**프로브 확장.** 최소한의 MV3 확장이면 충분하다.

```json
{ "manifest_version": 3, "name": "probe", "version": "1.0",
  "permissions": ["storage"], "host_permissions": ["file:///*"],
  "background": { "service_worker": "sw.js" },
  "action": { "default_popup": "popup.html" } }
```

재빌드해도 확장 id 를 고정하고 싶다면 `"key"` 를 넣는다. 결과 보고는 로컬 Node HTTP 서버에 JSON 을
POST 하게 하는 것이 좋다(`http://127.0.0.1/*` 는 파일 접근이 꺼져 있어도 계속 동작하는데, 보고가 가장 필요한 순간이 바로 그때다).

**중요한 두 상태를 재현하기**

* *접근 켜짐(오해를 부르는 기본값):* `--load-extension=<dir>` 로 띄운다. 가정하지 말고 산출물을 확인할 것 —
  종료 후 `<udd>/Default/Secure Preferences` 의 `extensions.settings.<id>` 를 읽어
  `location: 8`, `creation_flags: 38`, `"newAllowFileAccess": true` 를 기대하면 된다.
  확장 항목은 평범한 `Preferences` 가 아니라 **Secure Preferences**(MAC 보호)에 있고,
  손으로 고쳐 봐야 소용없다. 변조된 항목은 `prefs.tracked_preferences_reset` 으로 초기화된다.
* *접근 꺼짐(진짜 웹스토어 기본값):* 두 가지 방법.
  (i) `chrome://extensions` 에 붙어
  `chrome.developerPrivate.updateExtensionConfiguration({extensionId, fileAccess:false})` 를 호출한다.
  즉시 적용되고 재시작해도 유지되며, `--load-extension` 을 다시 줘도 재부여되지 **않는다**.
  (ii) 실제에 더 가까운 방법: 프로브를 `--pack-extension` 으로 CRX 로 묶고
  `<udd>/External Extensions/<id>.json` 의 `external_crx` 로 사이드로드한다. 그러면 `location: 2`,
  `creation_flags: 1`, 그리고 **`newAllowFileAccess` 키가 아예 없는** — 웹스토어 설치와 같은 "설정된 적 없음" 상태가 된다.
  (i) 을 개발자 모드가 꺼진 상태의 *압축해제* 확장에 쓸 때는 주의할 것. 토글을 건드리면 `UNPACKED` 로 재설치되고
  크롬이 그것을 비활성화한다(*"이 확장 프로그램을 사용하려면 개발자 모드를 사용 설정하세요…"*).
  압축해제 확장에서만 나오는 현상이고 패키지 설치는 영향받지 않는다.
* *상태의 근거:* `chrome.extension.isAllowedFileSchemeAccess()`.
  `chrome.permissions.getAll()` 을 믿지 말 것. `developerPrivate.getExtensionInfo().fileAccess.isActive` 도 믿지 말 것 —
  접근이 실제로 부여된 상태에서 `false` 로 읽히는 것을 보았다.

**개별 발견 재현하기**

| 발견 | 방법 |
| --- | --- |
| 설치 경고 매트릭스 (§2.2) | 아무 확장 페이지에서 `chrome.management.getPermissionWarningsByManifest(JSON.stringify(manifest))` 를 매니페스트 변형마다 한 번씩. |
| `file://` 파일 vs 디렉터리 비대칭 | 파일 하나와 그 부모 디렉터리를 fetch 해 `status`, `ok`, `redirected`, `[...headers]`, `byteLength` 를 찍는다. |
| 권한 거부 시 무한 대기 | 디렉터리를 만들고 `chmod 000` 한 뒤, `AbortController` 를 붙여서 **그리고** 붙이지 않고 fetch 한다. 그럴듯한 빈 리스팅이거나, 어떤 타임아웃도 넘겨 버리는 대기를 보게 된다. |
| WAL 32 KiB 파편화 누락 | 어떤 확장의 `chrome.storage.local` 을 WAL 이 약 2 MB 가 될 때까지 채운 뒤 반복문으로 nonce 를 쓰고, 매번 날 `includes()` 와 이 저장소의 `src/leveldb.js` 양쪽으로 확인한다. 레코드가 32768 의 배수에 걸릴 때 `includes()` 가 놓친다. |
| 자기 위치 nonce 왕복 | `chrome.storage.local.set` 으로 UUID 를 쓰고, 후보 프로필마다 `<프로필>/Local Extension Settings/<자기 id>/` 를 `file://` 로 읽어 진짜 WAL 파서로 찾는다. |
| 네이티브 호스트 `PATH` 실패 | `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin` 로 브라우저를 띄운다. `#!/usr/bin/env node` 호스트는 *"Native host has exited."* 로 실패하고, 절대 경로 셔뱅은 성공한다. |

**대상 확장의 정적 분석**(읽기 전용, 브라우저 불필요):
번들은 `<user-data-dir>/<profile>/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/<version>/` 에 있다.
`manifest.json` 이 `externally_connectable` 과 `web_accessible_resources` 를,
`managed_schema.json` 이 정책 표면 전체를 알려 준다. `assets/service-worker*.js` 는 minified 한 줄이라
`grep -o` 로 세는 편이(`connectNative`, `com.anthropic`, `get_bridge_identity`, `chrome.storage.managed`)
읽는 것보다 정보가 많다.

---

## 6. 결정, 그리고 무엇이 이 결정을 바꾸는가

**결정.** CLI 가 마찰 없는 주력 도구로 남는다. 웹스토어 확장은 자기 위치 찾기에 nonce 왕복을 쓰는
**순수 `file://` 확장**으로 만들고, **네이티브 메시징 호스트는 넣지 않는다.**
네이티브 메시징은 폴백으로도 남기지 않는다. 순환적이고(설치기가 *바로 그 CLI* 다),
확장이 제공할 수 없는 Node 런타임에 의존하며, 데스크톱에서 띄운 브라우저에서의 가장 흔한 실패 형태가
오해를 부르는 *"Native host has exited."* 이기 때문이다.

**알려진 위험, 아플 것 같은 순서대로.**

1. **웹스토어 심사.** 브라우저 자신의 프로필 디렉터리를 읽는 확장에 붙은 `file:///*` 은 정확히 악성 확장의
   모양이고, 설치 프롬프트가 *"특별한 권한이 필요하지 않습니다"* 라고 말하는 것 자체가 심사자에게는
   회피처럼 읽힐 수 있다. 우리가 통제할 수 없는 정책 판단이다. 완화책: 매니페스트를 `file:///*` + `storage`
   로만 묶고, 소스를 공개하고, 등록 문구에 크롬 자신의 `Local Extension Settings` LevelDB 만 읽으며
   아무 데도 아무것도 보내지 않는다고 분명히 적는다([`store-listing.md`](store-listing.md) 참고).
2. **토글 마찰.** 어떤 API 로도 요청할 수 없는 수동 단계 하나가, 대부분의 사용자가 열어 본 적 없는 설정 페이지에서,
   프로필마다 필요하다 — 게다가 크롬 자신의 UI 는 실제로는 필요 없는 재시작을 권한다.
   완화책: `isAllowedFileSchemeAccess()` 로 감지하고, 스크린샷 수준으로 구체적인 설명을 보여 주고,
   `chrome://extensions/?id=<자기 id>` 로 딥링크한다. 토글이 열린 팝업을 파괴한다는 사실을 잊지 말 것.
3. **Windows / Linux.** 여기의 모든 `file://` 탐색 측정은 macOS 전용이다. Windows 는
   `file:///C:/Users/<you>/AppData/Local/Google/Chrome/User Data` 가 필요한데 드라이브 루트를 열거할 수 없고,
   `C:` 를 호스트 이름으로 만들지 않는 URL 빌더가 필요하다. Linux 는 `~/.config/google-chrome` 이고,
   snap/flatpak Chromium 은 프로필을 `~/snap/chromium/common/chromium` 이나 `~/.var/app/…` 에 두며
   브라우저가 다른 경로로부터 추가로 샌드박스돼 있다. 리스팅 *형식* 자체는 플랫폼 독립 C++ 라 파서는 그대로 옮겨가지만,
   경로 탐색은 그렇지 않다.
4. **크롬의 동작 변경.** File System Access 는 이미 user-data 디렉터리를 하드 차단하고 있다(§2).
   `file://` 읽기가 그 뒤를 따르면 확장 설계 전체가 한 번에 죽는다. CLI 는 상관없다.
5. **엔터프라이즈 환경.** `URLBlocklist: ["file://*"]` 이나 제한적인 `ExtensionSettings` 정책이
   확장 경로를 조용히 무력화한다.
6. **버전과 설치 유형의 공백.** 모든 랩 작업은 Chrome for Testing 148.0.7778.96 에서, 사이드로드 또는
   압축해제 확장으로 했다. 진짜 웹스토어 설치(`location: kInternal`)는 로컬에서 위조할 수 없었다 —
   크롬의 tracked-preference 보호가 항목을 초기화한다. 그 공백은 Chromium 소스와 실제 웹스토어 설치의
   prefs 를 읽기 전용으로 조사해서 메웠지, 측정으로 메운 것이 아니다.

**무엇이 이 결정을 바꾸는가:** 웹스토어가 이 용도의 `file:///*` 을 거부하거나,
크롬이 user-data 디렉터리 차단을 File System Access 에서 `file://` URL 까지 확장하는 경우다.
둘 중 어느 쪽이든 답은 네이티브 호스트가 아니다. CLI 가 유일하게 정직한 답으로 남고, 확장은 은퇴한다.

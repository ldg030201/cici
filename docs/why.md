# Why cici works the way it does

> Decision record. Last updated: 2026-09-04. ([한국어](why.ko.md) — the Korean version is the
> one kept in sync first; this is its English translation.)
>
> Everything below was either read out of Chromium's source / shipping binary, quoted from
> official documentation, or reproduced in a throwaway lab. Where a claim is reasoning rather
> than measurement, it says so.

---

## 1. The goal, and the picker problem

When more than one browser is paired with Claude Code, Claude Code asks you to choose one, and it
identifies each candidate by a bare UUID — the **`bridgeDeviceId`**. If you run three or four Chrome
profiles (personal, work, a client's, a throwaway), the picker shows three or four UUIDs and nothing
that tells you which UUID belongs to which profile. The only official way to resolve one is to open
that profile, open the Claude in Chrome extension's service-worker DevTools, and run
`chrome.storage.local.get('bridgeDeviceId', console.log)` by hand — per profile, every time.
**cici exists to answer one question: which profile owns which `bridgeDeviceId`?**

The value lives in the Claude in Chrome extension's own `chrome.storage.local`, under the keys
`bridgeDeviceId` and `bridgeDisplayName`. On disk that is a LevelDB at:

```
<user-data-dir>/<profile>/Local Extension Settings/fcoeoabgfenejglbffodgkkbkcdhcgfn/
```

Values are stored as JSON, so the raw bytes include the surrounding quotes and must be `JSON.parse`d.
`.ldb` data blocks are snappy-compressed; the `.log` write-ahead log is not.

The obvious product is a browser extension: install it, open it in a profile, see that profile's id.
Getting there turned out to require knocking on almost every door Chrome has. This document records
which doors were tried, which are locked, and why cici ended up shaped the way it is.

---

## 2. What we tried

Legend for **How verified**:
**[src]** Chromium source or the shipping binary on this machine · **[doc]** official documentation ·
**[lab]** reproduced in a throwaway lab (Chrome for Testing **148.0.7778.96**, unless noted) ·
**[static]** static analysis of the shipped extension bundle · **[reason]** argued from the two
previous categories, not measured.

| Avenue | Result | Evidence | How verified |
| --- | --- | --- | --- |
| **Read another extension's `chrome.storage` directly** | **Blocked — by design.** There is no cross-extension storage surface at all. `chrome.storage.*` is scoped to the calling extension; no API takes an extension id. | The `storage` API namespace has no parameter anywhere for a foreign extension id. Each extension gets its own LevelDB directory under `Local Extension Settings/<id>/`, isolated by the same origin boundary as everything else. | **[doc]** `developer.chrome.com/docs/extensions/reference/api/storage` — the whole API is defined per-extension. **[lab]** every indirect route below was tried instead. |
| **`runtime.sendMessage` / `runtime.connect` to `fcoeoabg…`** | **Blocked.** Fails immediately with *"Could not establish connection. Receiving end does not exist."* | The target's `manifest.json` declares `"externally_connectable": {"matches": ["https://claude.ai/*", "https://*.claude.ai/*"]}` — **`matches` only, no `ids` key**. Without `ids`, no extension can message it, ever. | **[src]** read out of the installed bundle `…/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/<version>/manifest.json` on this machine. **[doc]** `developer.chrome.com/docs/extensions/reference/manifest/externally-connectable` — `ids` is what allows extension-to-extension messaging; omitted means none. **[lab]** attempted, got the "Could not establish connection" error. |
| **`chrome.debugger` attach to its pages / service worker** | **Blocked.** `chrome.debugger.attach` → *"Cannot access a chrome-extension:// URL of different extension."* Unchanged when Chrome is launched with `--silent-debugger-extension-api` (that flag only suppresses the "is debugging this browser" banner; it does not widen the target set). | The debugger API refuses cross-extension targets regardless of flags. | **[lab]** attached and got the error; re-ran with `--silent-debugger-extension-api` and got the identical error. **[doc]** `developer.chrome.com/docs/extensions/reference/api/debugger` — "extensions cannot attach to … another extension". |
| **`chrome.scripting.executeScript` into its pages** | **Blocked.** Same error string as `chrome.debugger`: *"Cannot access a chrome-extension:// URL of different extension."* `<all_urls>` does not include another extension's origin. | Host permissions never grant access to `chrome-extension://<other id>/`. | **[lab]** attempted with `<all_urls>` granted; same refusal. **[doc]** `developer.chrome.com/docs/extensions/develop/concepts/match-patterns` — `chrome-extension://` is not matchable by `<all_urls>`. |
| **`chrome.storage.sync` (hope: the id syncs and leaks somewhere)** | **Dead end.** The extension does not put the bridge id in `sync`; and even if it did, `sync` is just as per-extension-isolated as `local`. | `bridgeDeviceId` is written to `chrome.storage.local` only (see the getter quoted in §2.1). | **[static]** the service worker's id getter reads/writes `chrome.storage.local` exclusively. |
| **`web_accessible_resources` (hope: some resource echoes the id)** | **Dead end.** The extension exposes exactly four JS asset files, to `claude.ai` and to `<all_urls>`; none of them carries or computes the id. | Its `web_accessible_resources` are two onboarding/content-script assets (matched to `claude.ai`) and two page-instrumentation assets (`accessibility-tree.js`, `agent-visual-indicator.js`, matched to `<all_urls>`). They are static build artifacts, not a data channel. | **[src]** read out of the installed `manifest.json`. **[static]** the four files contain no reference to `bridgeDeviceId`. |
| **`webRequest` / DNR on the bridge WebSocket** | **Blocked twice over.** The extension does open `wss://bridge.claudeusercontent.com/chrome/<accountUuid>` and its first frame is a `connect` message containing `device_id`. But (a) `webRequest` never exposes WebSocket **message payloads** — there is no event for frames, only the handshake request; the id is in a frame, and the URL path holds the account uuid, not the device id. (b) Requests initiated by another extension are hidden from `webRequest` listeners. Also: the socket only opens for a signed-in profile, so the common "installed but not signed in" profile has no traffic at all. | Socket construction, verbatim (minified): `` const c=new WebSocket(s) `` where `` s=`${t}/chrome/${r}` ``, then `` c.onopen=()=>{ … const t={type:"connect",client_type:"chrome-extension",device_id:o, …}; c.send(JSON.stringify(t))} ``, with `o = await yt()` — `yt()` being the `bridgeDeviceId` getter. The endpoint is chosen by `e.localBridge?"ws://localhost:8765":…"wss://bridge.claudeusercontent.com"`. | **[static]** extracted from the installed service worker bundle. **[doc]** `developer.chrome.com/docs/extensions/reference/api/webRequest` — the event set stops at the handshake; there is no frame event. **[src]** `extensions/browser/api/web_request/web_request_permissions.cc` (`WebRequestPermissions::HideRequest`) hides other extensions' requests. **[reason]** the combination was argued, not lab-measured. |
| **The `localBridge` dev path (`ws://localhost:8765`)** | **Rejected.** It would deliver `device_id` to a local listener, but the flag lives inside the extension's own configuration — which is exactly the thing we cannot write. Circular. | Same code as above: the `ws://localhost:8765` branch is gated on `le().localBridge`. | **[static]** read from the bundle; not pursued further. |
| **File System Access API (`showDirectoryPicker`) on the user-data dir** | **Blocked.** The user-data directory is on Chrome's hard blocklist; the picker refuses even if the user selects it. On macOS `~/Library` is blocked wholesale as well. | `kBlockPaths` contains `BlockPath::CreateRelative(chrome::DIR_USER_DATA, kBlockAllChildren)`, and on macOS `base::DIR_HOME` + `"Library"` with `kBlockAllChildren`. | **[src]** `chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc`, the `kBlockPaths` table — <https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc>. This is also the clearest signal of Chrome's *direction of travel* on local-file access (see §6, risks). |
| **The extension's own UI** | **Dead end.** Its popup / side panel never renders the `bridgeDeviceId`, so there is nothing to scrape even if we could reach it (we can't — see `chrome.scripting`). | No UI string in the bundle formats the id. | **[static]** searched the bundle. |
| **`chrome.management`** | **Dead end for the id; useful for nothing here.** `management` reports id, name, version, enabled state, permission warnings and install type. It exposes no storage and no profile path. | `management.getAll()` / `getSelf()` return `ExtensionInfo`, which has no storage or path field. It *was* useful as a lab instrument: `management.getPermissionWarningsByManifest()` is how we measured install warnings (see §2.2). | **[doc]** `developer.chrome.com/docs/extensions/reference/api/management` — the `ExtensionInfo` type. **[lab]** used for the warning matrix. |
| **Native messaging → `get_bridge_identity`** | **Exists, but unreachable by a third party.** The extension really does answer a `get_bridge_identity` tool request with `{bridge_device_id}`. But it only ever calls `connectNative()` with one of **two hard-coded Anthropic host names**, and it replies only on that one port. A third-party host would have to squat one of those two names and displace the real Claude Code / Claude Desktop hosts. Hostile and brittle — not a design option. See §2.1. | The host list is a literal array of two entries; `connectNative` appears twice in the whole bundle (one `typeof` guard, one call site); `com.anthropic` appears exactly twice, both inside that literal. | **[static]** verified by counting occurrences in the installed bundle: `connectNative` ×2, `com.anthropic.*` ×2, `get_bridge_identity` ×1. |
| **Enterprise / managed policy** | **Blocked, and policy only ever tightens.** `chrome.storage.managed` is one-way: policy can *write* values an extension may read; there is no policy that reads an extension's `local`/`sync` storage. The extension's managed schema has exactly three keys, none of them storage- or host-name-related. One of them (`thirdPartyDesktopMode`) actively *suppresses* the `get_bridge_identity` reply. | `managed_schema.json` properties: `blockedUrlPatterns`, `thirdPartyDesktopMode`, `forceLoginOrgUUID` — nothing else. Chrome drops policy keys not in the schema before they reach the extension. The reply path is `` async function jr(e){const t=Cr;return!(await p.isDesktopManaged())&&Gr(t,e)} `` — managed ⇒ no reply. `chrome.storage.managed` occurrences in the service worker: **0**. | **[src]** `managed_schema.json` read from the installed bundle on this machine. **[static]** reply-path guard extracted from the bundle. **[reason]** "no policy can read extension storage" is a negative claim argued from the policy surface, not proven exhaustively. |
| **`NativeMessagingAllowlist` / `Blocklist` / `UserLevelHosts`, `ExtensionSettings`** | **Gating only — and they can break us.** These decide *which* hosts may be talked to; none reads storage or substitutes a host name. Note the negative: with `NativeMessagingUserLevelHosts=false`, user-level host manifests are ignored entirely, so any native-host design simply does not run in that environment. | Policy semantics per Chrome Enterprise policy list. | **[doc]** `chromeenterprise.google/policies/` — the four policies above. **[reason]** reviewed for capability, not lab-tested. |
| **`file://` reads from our own extension, after the user flips "Allow access to file URLs"** | **This is the only door that opens.** With the toggle on, an extension holding `host_permissions: ["file:///*"]` can list directories and read files anywhere the OS lets it, from both the popup and the MV3 service worker — including a running Chrome's LevelDB. With the toggle **off** — which is the Web Store default — every single `file://` fetch rejects with `TypeError: Failed to fetch`, and the extension can detect that but cannot fix it. Full detail in §2.3. | See §2.3. | **[lab]** + **[src]** + **[doc]**, see §2.3. |

### 2.1 Why the native-messaging escape hatch is closed

The extension's service worker contains, verbatim (minified):

```js
const t=[{name:"com.anthropic.claude_browser_extension",label:"Desktop"},
         {name:"com.anthropic.claude_code_browser_extension",label:"Claude Code"}];
for(const n of t)try{const e=chrome.runtime.connectNative(n.name); …
```

and the handler that would give us the answer:

```js
if("get_bridge_identity"===n)
  return void(await jr(ir(void 0,{result:{bridge_device_id:await gt(),echo:r?.echo}})));
```

There is no authentication on this — the handshake is a plain `{type:"ping"}` / `{type:"pong"}`
exchange with a 10 s timeout. The lock is not a credential, it is the **channel**: the message
dispatcher is registered exactly once, on the port returned by `connectNative`, and replies go only
to that stored port. The extension never connects to any other host, so a third-party host has no
way to put a message into the dispatcher. The only way in is to occupy one of those two names — and
the "Desktop" name is tried first, so squatting only the Claude Code name loses on any machine that
has Claude Desktop installed. On this machine both manifests are user-owned (`rw-r--r--`), so
overwriting them is *technically* possible and would break the user's real Claude Code and Claude
Desktop bridges. We are not doing that, and neither should anything else.

### 2.2 The install-warning surprise: `file:///*` produces no warning at all

Measured with `chrome.management.getPermissionWarningsByManifest()` **[lab]**:

| manifest fragment | permission warnings produced |
| --- | --- |
| `host_permissions: ["file:///*"]` | `[]` — **none** |
| `host_permissions: ["file://*/*"]` | `[]` |
| `content_scripts.matches: ["file:///*"]` | `[]` |
| `optional_host_permissions: ["file:///*"]` | `[]` |
| `host_permissions: ["<all_urls>"]` | "Read and change all your data on all websites" |
| `host_permissions: ["https://example.com/*"]` | "Read and change your data on example.com" |
| `permissions: ["nativeMessaging"]` | "Communicate with cooperating native applications" |

This is structural, not a quirk of the build we tested:
`ChromePermissionMessageProvider::AddHostPermissions()` calls `GetDistinctHosts(…, /*exclude_file_scheme=*/true)`,
and `permission_message_util.cc` contains
`if (exclude_file_scheme && pattern.scheme() == url::kFileScheme) continue;` **[src]** —
<https://source.chromium.org/chromium/chromium/src/+/main:extensions/common/permissions/permission_message_util.cc>.
File-scheme hosts are excluded from warning generation *because* access is gated behind the separate
toggle instead.

Two consequences worth internalising:

* The install prompt for a `file:///*`-only extension says **"This extension requires no special
  permissions."** That is quiet, but it is Chrome's own design, not a loophole we found.
* Whatever *else* the manifest asks for is what the user sees. A probe extension with
  `file:///*` + `tabs` + `scripting` produced *"Read your browsing history"*. So keep the manifest
  down to `file:///*` + `storage` and nothing more — which is exactly what cici ships.

### 2.3 The `file://` door, in detail

**Default state is OFF for a Web Store install, and we can prove it on this machine.**
Every extension in the user's real Chrome that came from the Web Store (`location: 1` = `INTERNAL`,
`from_webstore: true`) records `creation_flags: 9` = `REQUIRE_KEY|FROM_WEBSTORE` — the
`ALLOW_FILE_ACCESS` bit (value 4) is **not** set — and has **no `newAllowFileAccess` key at all**
**[src, read-only inspection of `Secure Preferences`]**. Distinct `(creation_flags, location)` pairs
found across all profiles: `(1,5)` components, `(9,1)` Web Store, `(137,6)` and `(137,10)`
pre-installed — bit 2 never set anywhere.

The mechanism, from Chromium: `ExtensionRegistrar::FinishInstallation()` auto-grants file access only
when `Manifest::ShouldAlwaysAllowFileAccess(location)` is true, and that is
`IsUnpackedLocation(location)` — i.e. `kUnpacked` **or** `kCommandLine` only. A Web Store install is
`kInternal`, so it is never auto-granted, and with the pref unset `ExtensionPrefs::AllowFileAccess()`
(pref key `"newAllowFileAccess"`) returns false **[src]**:
<https://source.chromium.org/chromium/chromium/src/+/main:extensions/browser/extension_registrar.cc>,
<https://source.chromium.org/chromium/chromium/src/+/main:extensions/browser/extension_prefs.cc>.
The literal string `newAllowFileAccess` is present in the shipping 148 framework binary **[src]**.
And the docs agree — match patterns: file URLs *"require the user to manually grant access"*, and
declare_permissions: *"If your extension needs to run on `file://` URLs … users must give the
extension access on its details page."* **[doc]**

**This is also the single biggest correction to our own earlier lab work.** Every early `file://`
success was measured under `--load-extension`, which sets `creation_flags: 38`
(`= 2|4|32`, including `ALLOW_FILE_ACCESS`), `location: 8` (`COMMAND_LINE`) and writes
`"newAllowFileAccess": true` on first install **[lab]**. The lab was silently testing the *granted*
state and calling it the default. Everything below was re-measured with the toggle explicitly off.

| Question | Answer |
| --- | --- |
| What does it look like when access is OFF? | Every `file://` `fetch()` rejects with `TypeError: Failed to fetch` — identical in the popup document and the MV3 service worker, for files, directories, and non-existent paths alike. Async `XMLHttpRequest` gives `onerror` with `status === 0`; the service worker has no `XMLHttpRequest` at all. A *synchronous* XHR in a page throws a `DOMException` (`NetworkError`) instead — the only asymmetry. **[lab]** |
| Can the extension detect it? | Yes, reliably, with no extra permission: **`chrome.extension.isAllowedFileSchemeAccess()`** — works in MV3, in both the popup and the service worker, callback and promise forms. `chrome.permissions.contains({origins:['file:///*']})` tracks it too. **Do not use `chrome.permissions.getAll()`** — it keeps listing `file:///*` even when access is off, which is the worst possible false positive. **[lab]** |
| Can the extension turn it on itself? | **No.** `chrome.permissions.request({origins:['file:///*']})` with a real user gesture fails with *"Extension must have file access enabled to request 'file:///*'."* — that exact format string is in the shipping framework binary **[src]**. `chrome.developerPrivate` is undefined outside `chrome://extensions`. Even `chrome.tabs.create({url:'file://…'})` is refused: *"Cannot navigate to a file URL without local file access."* **[lab]** |
| What can it do? | Deep-link the user to the toggle: `chrome.tabs.create({url:'chrome://extensions/?id=<own id>'})` succeeds **with no `tabs` permission** and genuinely lands on the details page. The toggle row renders even with developer mode off. **[lab]** |
| Does turning it on need a restart? | Functionally **no** — a fresh page in the same browser process reads files immediately. But Chrome's own UI carries the string *"Changes to this setting will be applied once Chromium restarts."* (found in `en.lproj/locale.pak`, offset 105280, alongside the toggle label *"Allow access to file URLs"* at offset 233581) and there is an `#allow-on-file-urls-warning` element gated on a `fileAccessPendingChange` field. We never triggered that state, but it exists, so the onboarding copy must survive a user who restarts anyway. **[lab + src]** |
| Any UX trap? | Flipping the toggle **reloads the extension** — the open popup document is destroyed. So "detect the flip and recover in place" is impossible; the user must reopen the popup. It works immediately when they do. **[lab]** |
| How fast is the read once it's on? | Irrelevant-fast. Real Claude LevelDB directories on this machine ranged ~0.8 MB to ~6.5 MB, and the browser port of cici's parser handled one profile in **5.6–50.6 ms** (fetching a 2.1 MB `.ldb` took 1.1 ms). A whole scan — mint the nonce, walk every home, 10 browser families, 9 profile directories — took **13–22 ms**, 25 fetches, about 141 KB. **[lab]** |
| Anything odd about `file://` responses? | Yes, and it will bite a naive implementation: a **file** gives `status 200, ok true`; a **directory** gives `status 0, ok false, redirected true, empty headers` — *and a perfectly good body* (Chromium's generated listing HTML). `if (!res.ok) throw` breaks directory listing entirely. The cause is in `content/browser/loader/file_url_loader_factory.cc`: `FileURLLoader` synthesizes `"HTTP/1.1 200 OK"` headers, while `FileURLDirectoryLoader` never sets `head->headers` at all **[src]** — <https://source.chromium.org/chromium/chromium/src/+/main:content/browser/loader/file_url_loader_factory.cc>. Correct rule: **if the promise resolves, it succeeded**; use `status` only to tell "file" from "directory listing". |
| Worse trap | A directory that exists but cannot be enumerated (permission denied) does **not** reject. It either resolves as a normal-looking empty listing, or the body **never arrives and the fetch hangs forever**. On multi-user macOS this is not hypothetical: other users' home directories are `drwxr-x---` and `~/Library` is `drwx------`. **Every `file://` fetch needs an `AbortController` timeout.** **[lab]** |
| Parsing the directory listing | Chromium emits one `<script>addRow("name","url",isdir,size,"size_string",epoch,"date_string");</script>` per entry. Gotchas: `isdir` is `0`/`1`, **not** `true`/`false`; the size and date strings are locale-formatted (never parse them); names are JS string literals (unescape with `JSON.parse`); the `<head>` also contains the `addRow` *definition*, so anchor on `addRow("`; `DOMParser` is useless here because it does not execute scripts (and the service worker has no `DOMParser` anyway). Treat "listing produced zero rows" as a **hard error** — otherwise a listing-format change is indistinguishable from "extension not installed". **[lab]** |

---

## 3. How cici therefore works

### 3.1 The shipping design: one read-only parser, two front ends

Both front ends ship from this repository. The parser is written once, with **no platform imports at
all**, and the two front ends supply the bytes: `node:fs` for the CLI, `fetch('file://…')` for the
extension.

```
src/  (Node ≥18.17, no dependencies)
 ├─ leveldb-core.js  the parser. CURRENT → MANIFEST (VersionEdit replay) → live *.ldb + *.log (WAL).
 │                  No node: imports — the extension runs this exact file.
 ├─ snappy.js        raw-snappy decompression for .ldb data blocks. Also shared.
 ├─ leveldb.js       node:fs adapter: directorySource() → readLevelDbFrom()
 ├─ browsers.js      known user-data dirs per browser family & platform → profile dirs
 ├─ claude.js        <profile>/Local Extension Settings/<claude ext id>/
 └─ index.js         one row per profile: browser, profile dir, profile name, deviceId

extension/  (MV3, no build step — loaded as plain ES modules)
 ├─ manifest.json    permissions: ["storage"], host_permissions: ["file:///*"] — that is all
 ├─ popup.js         UI: this profile's card first, then the other profiles
 ├─ _locales/{ko,en} every human-readable string; ko is the default locale
 └─ lib/
    ├─ leveldb-core.js  ┐ generated copies of src/. Do not edit them.
    ├─ snappy.js        ┘ `npm run build:ext` writes them; `npm run check:ext` and
    │                     test/extension.test.js verify they match src/ byte for byte.
    ├─ fileurl.js       file:// byte source + Chromium directory-listing parser
    ├─ locate.js        profile enumeration + the nonce round-trip (§3.2)
    └─ read.js          profile → bridgeDeviceId / bridgeDisplayName
```

`scripts/build-extension.mjs` is the only thing allowed to write `extension/lib/*.js`. Copying rather
than importing is deliberate: an extension cannot import from outside its own package, a bundler
would be the first build dependency this project refuses to have, and a symlink does not survive
packing a `.crx`.

**The shipping extension has no background service worker.** The lab confirmed `file://` reads work
from one, but there is no reason to ship it: a popup-only extension has a smaller attack surface and
a smaller review surface, and it only runs when the user asks a question.

Properties that matter:

* **Strictly read-only.** Only `readFile` / `readdir` / `stat`. The LevelDB `LOCK` is never taken, so
  it is safe to run while the browser is open. Chromium's `env_chromium.cc` opens these files with
  `FILE_SHARE_READ`-style sharing, so a live WAL and MANIFEST are readable on Windows and Linux too
  **[src]** — <https://source.chromium.org/chromium/chromium/src/+/main:third_party/leveldatabase/env_chromium.cc>.
* **Real LevelDB, not a substring search.** The WAL is parsed as records
  (`FULL`/`FIRST`/`MIDDLE`/`LAST`) with CRC32C verification, and the MANIFEST is replayed to know
  which tables are live. This is not pedantry: a naive `includes('bridgeDeviceId')` over the raw WAL
  bytes **silently misses the value** whenever a record straddles a 32 KiB block boundary and the
  7-byte record header lands inside the string. We reproduced that failure — 5 misses in 10 trials on
  a ~2 MB WAL with the offset deliberately controlled **[lab]**. It is unrecoverable by waiting or
  retrying; only a real parser finds it.
* **Self-location is measured, not hoped for.** The nonce round-trip (§3.2) succeeded 21 times out
  of 21, and cross-checking across three profiles that all had the extension installed produced zero
  false positives **[lab]**. The browser port of the parser read all four real profiles correctly.
* **The CLI needs no permission prompt, no toggle, no review.** It reads files the user already owns.
* Covered end to end by `npm test` (`node --test`, no test framework): the parser against
  fixtures written by a real LevelDB, the CLI, the extension libraries against a faked
  `file://` filesystem, and the popup against a DOM shim. **334 tests in 22 suites** pass today;
  `npm test` is the authority, not this line.

### 3.2 The extension, and the self-location trick

An extension that wants to show *"this profile's id"* has two problems, not one. Reading the Claude
extension's LevelDB is problem one (solved by `file://` + the user-flipped toggle). Problem two is
subtler: **an extension has no idea which profile directory it is running in.** There is no API for
it — `chrome.runtime.getPackageDirectoryEntry()` returns a virtual `/crxfs` root,
`chrome.management.getSelf()` has no path, `chrome.system.*` does not exist for this, and
`chrome.identity.getProfileUserInfo()` returns empty strings for a signed-out profile (and needs the
`identity.email` permission to return anything at all).

The technique that works — call it the **nonce round-trip**:

1. The popup mints a random UUID and writes it to **its own** `chrome.storage.local`.
2. Chrome flushes that write straight through to
   `<some profile>/Local Extension Settings/<cici's own id>/*.log`. Verified: a single small `set()`
   grows the WAL by exactly 51 bytes, because Chromium's `WritableFile` in `env_chromium.cc` is
   write-through — it has no 64 KiB user buffer. An independent `fs` poller saw the nonce on disk
   **before** the `set()` promise even resolved **[lab]**.
3. The popup enumerates candidate profile directories over `file://` and reads **its own** storage
   directory in each — a few hundred bytes each, not the multi-MB Claude one.
4. Exactly one of them contains the nonce. That is the profile we are running in. (A fresh UUID
   cannot collide; the disambiguation is logically airtight, and was measured correct across three
   profiles that all had the extension installed **[lab]**.)
5. *Now* read that one profile's `Local Extension Settings/fcoeoabg…/` and report the
   `bridgeDeviceId`.

Three rules this design must respect, all learned the hard way:

* **Search the WAL with the real parser, not `String.includes`** — same 32 KiB fragmentation bug as
  above. This is the failure mode where the data is on disk and provably unfindable.
* **Never infer identity from directory names.** `Default` / `Profile N` is a convention, not a rule:
  a profile directory can be named anything (`--profile-directory=Work`), and enumeration that
  matches `/^Profile \d+$/` silently finds nothing. Profile names and emails come from
  `profile.info_cache` in `<user-data-dir>/Local State`, which reads fine over `file://` **[lab]**.
* **Absence of `Local Extension Settings/<id>/` does not mean "not installed."** Chrome creates that
  directory lazily, on the first `chrome.storage.local` touch. An installed-but-never-run extension
  has no directory, and an extension that only ever *read* storage has a 0-byte WAL and parses to
  zero keys with zero warnings. The UI must distinguish: *no file access* / *no such profile* /
  *extension present but never wrote* / *wrote but never paired* / *paired*. Two of those five states
  look identical to a naive implementation **[lab]**. The shipping popup says all five differently.

`chrome.identity.getProfileUserInfo` returns `{email:'', id:''}` for a signed-out profile **[lab]**,
so it cannot be the primary self-detection signal. It has value only as a corroborating one.

---

## 4. The alternatives, honestly compared

| | **A. CLI only** | **B. Pure extension, `file://`** | **C. Extension + native host** |
| --- | --- | --- | --- |
| **Answers "which profile owns which id?"** | Yes, all profiles at once | Yes | Yes |
| **Answers "*this* profile's id" in-place** | No (it lists all, you match by profile name) | Yes | Yes |
| **Works for a non-developer** | No — needs Node/npx | Mostly — one toggle | No |
| **Needs a runtime installed** | Node ≥18.17 | none | Node (or a signed binary) |
| **Scary-looking permission** | none | `file:///*` — but the install prompt shows **no warning** (§2.2); the *toggle* is the visible cost | "Communicate with cooperating native applications" |
| **User-gated step that no API can request** | none | **Yes — the file-URL toggle, per profile** | none (but see install steps) |
| **Survives Chrome tightening `file://`** | Yes (outside the browser) | **No** | Yes |
| **Web Store review risk** | n/a | **Real** — an extension whose purpose is reading the browser's own user-data dir | Lower |
| **Cross-platform confidence** | High (the CLI already handles the layouts) | **Low** — all `file://` discovery was measured on macOS only | Medium |
| **Circularity** | — | none | **Fatal**: installing the host requires the very CLI the extension replaces |

### Exact install steps

**A. CLI only**

```
npx cici              # or: npm i -g cici && cici
```

One command. Requires Node ≥18.17. Nothing is written, nothing is launched.

**B. Pure extension (the recommendation)** — identical on macOS and Windows:

1. Install from the Chrome Web Store (2 clicks). The install prompt says *"This extension requires
   no special permissions."*
2. Open `chrome://extensions/` (the extension's own "grant file access" screen deep-links here — the
   button works with no `tabs` permission).
3. Open **Details** for cici.
4. Turn on **"Allow access to file URLs"**. Chrome may say the change applies after a restart; it
   does not need one, but restarting is harmless.
5. Click the cici icon again (the toggle reloaded the extension, so the popup you had open is gone).
6. **Repeat per profile.** Extension installs are per-profile, so both the install and the toggle are
   per-profile.

No admin rights, no runtime, no download, no restart. Exactly one step (4) is a real drop-off risk.

**C. Extension + native host** — for the record, why this was rejected:

*macOS*: install extension → open Terminal → install Node if absent → `npx cici install-host` (writes
the host script, `chmod 0755`, and a `NativeMessagingHosts/*.json` per browser) → click the icon. No
restart needed (verified). Shipping a packaged binary instead of requiring Node replaces steps 2–3
with a download, but macOS quarantine then shows *"cannot be opened because the developer cannot be
verified"* unless you pay for Apple notarization; npm-installed scripts carry no quarantine
attribute, so requiring Node is paradoxically the *better* UX.

*Windows*: same, plus a `.bat` wrapper (Chrome cannot execute a `.js` directly) and `HKCU` registry
values (no admin rights needed). An unsigned `.exe` trips SmartScreen.

And the killer, found in the lab: `#!/usr/bin/env node` **does not work** for a browser launched from
the Dock/Finder/Start menu. Those inherit the launchd/desktop-session environment
(`PATH=/usr/bin:/bin:/usr/sbin:/sbin` on this machine — `launchctl getenv PATH` is empty), which does
not contain nvm's or Homebrew's `node`. The host then never starts and the extension reports
*"Native host has exited."* — a message that reads like a crash, not a missing interpreter.
Reproduced by launching the lab browser under `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin`; an
absolute-path shebang fixed it **[lab]**. Any native-host installer must hard-code an absolute
interpreter path. Combined with the circularity — *anyone who can run `npx cici install-host` can
just run `npx cici`* — this design pays a large cost to serve an audience that does not need it.

---

## 5. Reproduce our tests

Nothing from the lab is checked into this repo, on purpose: it is throwaway browser profiles and
probe extensions. Here is how to rebuild it.

**Ground rules we followed, and you should too**

* Never launch the user's real branded Chrome, and never write anything under its user-data dir. All
  read-only inspection above used `cat`/`python3` on files, never a browser.
* Do all work in a scratch directory outside the repo.
* Wrap every browser launch in a timeout and kill it afterwards — check for leftovers before you
  finish. (Also: name your app bundle copy something unique if other agents/scripts on the machine
  might `pkill` by name; we lost an hour to a neighbour's cleanup killing our browser mid-measurement
  and producing a convincing false signal.)

**Browser.** Chrome for Testing (Playwright's cache is a convenient source):

```
"$HOME/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" --version
# Google Chrome for Testing 148.0.7778.96  ← the version behind every [lab] result here
```

**Driver.** Node 24 has global `fetch` and `WebSocket`, so no dependencies are needed: launch with
`--remote-debugging-port=<port> --user-data-dir=<scratch>/udd --no-first-run --no-default-browser-check`,
poll `http://127.0.0.1:<port>/json` for targets, connect to a target's `webSocketDebuggerUrl`, and
drive `Runtime.evaluate` (`awaitPromise: true`) against the popup document, an extension page opened
in a tab, and the MV3 service-worker target. Attach to `chrome://extensions` the same way when you
need `chrome.developerPrivate`.

**Probe extension.** A minimal MV3 extension is enough:

```json
{ "manifest_version": 3, "name": "probe", "version": "1.0",
  "permissions": ["storage"], "host_permissions": ["file:///*"],
  "background": { "service_worker": "sw.js" },
  "action": { "default_popup": "popup.html" } }
```

Add a fixed `"key"` if you need a stable extension id across rebuilds. Have the probe report results
by POSTing JSON to a local Node HTTP server (`http://127.0.0.1/*` keeps working even when file access
is off, which is exactly when you need the reports most).

**Reproducing the two states that matter**

* *Access ON (the misleading default):* launch with `--load-extension=<dir>`. Confirm the artifact
  rather than assuming it: after exit, read `<udd>/Default/Secure Preferences` →
  `extensions.settings.<id>` and expect `location: 8`, `creation_flags: 38`,
  `"newAllowFileAccess": true`. Extension entries live in **Secure Preferences** (MAC-protected), not
  plain `Preferences` — and hand-editing them is futile, Chrome resets tampered entries via
  `prefs.tracked_preferences_reset`.
* *Access OFF (the real Web Store default):* two ways.
  (i) Attach to `chrome://extensions` and call
  `chrome.developerPrivate.updateExtensionConfiguration({extensionId, fileAccess:false})`. Effective
  immediately; survives restart; re-passing `--load-extension` does **not** re-grant it.
  (ii) Closer to the real thing: `--pack-extension` the probe into a CRX and side-load it via
  `<udd>/External Extensions/<id>.json` with `external_crx`. That yields `location: 2`,
  `creation_flags: 1`, and **no `newAllowFileAccess` key at all** — the same "never set" state a Web
  Store install has.
  Caution with (i) on an *unpacked* extension while developer mode is off: touching the toggle
  reinstalls it as `UNPACKED` and Chrome then disables it
  (*"Turn on developer mode to use this extension…"*). That is an unpacked-only artifact; packed
  installs are unaffected.
* *Ground truth for the state:* `chrome.extension.isAllowedFileSchemeAccess()`. Do **not** trust
  `chrome.permissions.getAll()`, and do not trust `developerPrivate.getExtensionInfo().fileAccess.isActive`
  either — we saw it read `false` while access was actually granted.

**Reproducing the specific findings**

| Finding | How |
| --- | --- |
| Install-warning matrix (§2.2) | `chrome.management.getPermissionWarningsByManifest(JSON.stringify(manifest))` from any extension page, one call per manifest variant. |
| `file://` file-vs-directory asymmetry | Fetch a file and its parent directory; log `status`, `ok`, `redirected`, `[...headers]`, `byteLength`. |
| Permission-denied hang | `mkdir` a directory, `chmod 000`, fetch it with **and** without an `AbortController`. Expect either a plausible empty listing or a hang past any timeout you set. |
| WAL 32 KiB fragmentation miss | Pad an extension's `chrome.storage.local` until its WAL is ~2 MB, then write nonces in a loop and check each against both a raw `includes()` and this repo's `src/leveldb.js`. Expect `includes()` to miss when the record lands on a multiple of 32768. |
| Self-location nonce round-trip | Write a UUID via `chrome.storage.local.set`, then read `<candidate profile>/Local Extension Settings/<own id>/` over `file://` in each candidate and look for it with the real WAL parser. |
| Native-host `PATH` failure | Launch the browser under `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin`; a `#!/usr/bin/env node` host fails with *"Native host has exited."*, an absolute-path shebang succeeds. |

**Static analysis of the target extension** (read-only, no browser):
the bundle lives at `<user-data-dir>/<profile>/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/<version>/`.
`manifest.json` gives `externally_connectable` and `web_accessible_resources`;
`managed_schema.json` gives the full policy surface; `assets/service-worker*.js` is a single minified
line — `grep -o` counts (`connectNative`, `com.anthropic`, `get_bridge_identity`,
`chrome.storage.managed`) are more informative than reading it.

---

## 6. Decision, and what would change it

**Decision.** The CLI stays the primary, no-friction tool. The Web Store extension is built as a
**pure `file://` extension with the nonce round-trip** for self-location, and **no native messaging
host**. Native messaging is not kept as a fallback: it is circular (its installer *is* the CLI), it
depends on a Node runtime an extension cannot provide, and its most likely failure mode on a
desktop-launched browser is a misleading *"Native host has exited."*

**Known risks, in the order we expect them to hurt.**

1. **Web Store review.** `file:///*` on an extension that reads the browser's own profile directory
   is exactly the shape of a malicious extension, and the install prompt showing *"no special
   permissions"* may itself read as evasive to a reviewer. This is a policy judgment we do not
   control. Mitigation: keep the manifest to `file:///*` + `storage`, publish the source, and say
   plainly in the listing that the extension reads only Chrome's own `Local Extension Settings`
   LevelDB and sends nothing anywhere (see [`store-listing.md`](store-listing.md), Korean).
2. **Toggle friction.** One manual step, per profile, that no API can request, on a settings page
   most users have never opened — and Chrome's own UI suggests a restart that is not actually needed.
   Mitigation: detect with `isAllowedFileSchemeAccess()`, show a screenshot-grade explanation, and
   deep-link to `chrome://extensions/?id=<own id>`. Remember the toggle destroys the open popup.
3. **Windows / Linux.** Every `file://` discovery measurement here is macOS-only. Windows needs
   `file:///C:/Users/<you>/AppData/Local/Google/Chrome/User Data` with no drive-root listing to
   enumerate, and a URL builder that does not turn `C:` into a hostname. Linux needs
   `~/.config/google-chrome` — and snap/flatpak Chromium keep their profiles under
   `~/snap/chromium/common/chromium` or `~/.var/app/…`, where the browser is additionally sandboxed
   away from other paths. The listing *format* is platform-independent C++, so the parser transfers;
   the path discovery does not.
4. **Chrome changing behaviour.** File System Access is already hard-blocked from the user-data
   directory (§2). If `file://` reads follow, the whole extension design dies at once. The CLI does
   not care.
5. **Enterprise environments.** `URLBlocklist: ["file://*"]` or a restrictive `ExtensionSettings`
   policy disables the extension path silently.
6. **Version and install-type gaps.** All lab work is Chrome for Testing 148.0.7778.96 with a
   side-loaded or unpacked extension. A true Web Store install (`location: kInternal`) could not be
   forged locally — Chrome's tracked-preference protection resets the entry. We closed that gap from
   Chromium source plus read-only inspection of a real Web Store install's prefs, not by measurement.

**What would change the decision:** the Web Store rejecting `file:///*` for this use, or Chrome
extending the user-data-dir block from File System Access to `file://` URLs. In either case the
answer is not the native host — it is that the CLI remains the only honest answer, and the extension
is retired.

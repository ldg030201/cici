# cici — Claude In Chrome Id

> **Unofficial.** cici is not made by Anthropic and is not affiliated with Anthropic.

> [한국어 README](README.md) is the primary document; this is its English translation.

Tells you which Chrome profile owns the UUID (`bridgeDeviceId`) that Claude Code shows in its
browser picker.

With more than one browser paired, Claude Code shows you this:

```
Which browser?
  1. 11111111-2222-4333-8444-555555555555
  2. 66666666-7777-4888-8999-aaaaaaaaaaaa
  3. bbbbbbbb-cccc-4ddd-8eee-ffffffffffff
```

Nothing but UUIDs. To work out which one is your work profile, you have to open each profile, open
the Claude in Chrome extension's service-worker DevTools, and type
`chrome.storage.local.get('bridgeDeviceId', console.log)` by hand.

cici answers exactly one question: **which UUID belongs to which profile?**

It only reads. It never writes, never takes the LevelDB `LOCK`, and makes zero network requests, so
it is safe to use while the browser is running.

---

## Two front ends

|  | **Extension (MV3)** | **CLI** |
| --- | --- | --- |
| Answers | **this profile's** ID, plus the other profiles | every profile on this machine |
| Needs | Chrome 116+, one file-URL toggle | Node 18.17+ |
| Install | install the extension, flip the toggle | `npx cici` |
| Per profile | yes (install and toggle are both per-profile) | no (all at once) |

Both run the same parser, so both report the same value.

---

## A. The extension

### Install

> It is not on the Chrome Web Store yet. The listing material is prepared in
> [`docs/store-listing.md`](docs/store-listing.md) (Korean).
> For now, clone the repo and load it unpacked.

```sh
git clone https://github.com/ldg030201/cici.git
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension/` folder.
4. Open the extension's **Details** and turn on **"Allow access to file URLs"**.
5. Click the icon to open the popup.

Steps 4 and 5 are needed for a Web Store install too — the toggle defaults to **off** there, and no
API lets the extension turn it on itself.

**Flipping that toggle reloads the extension**, which destroys the popup you had open. That is
expected. You do not need to restart the browser; just open the popup again.

If you skip step 4, the popup shows an explanation and a button that deep-links to the details page.

### The popup

```
┌──────────────────────────────────────────────┐
│ cici                                    ⟳    │
│ Claude in Chrome bridge ID                   │
├──────────────────────────────────────────────┤
│ Current profile                              │
│ ┌──────────────────────────────────────────┐ │
│ │ Google Chrome                  [current] │ │
│ │ Personal                                 │ │
│ │ you@example.com                          │ │
│ │                                          │ │
│ │ bridgeDeviceId                    [Copy] │ │
│ │ ┌──────────────────────────────────────┐ │ │
│ │ │ 11111111-2222-4333-8444-555555555555 │ │ │
│ │ └──────────────────────────────────────┘ │ │
│ │ Pairing name   MacBook                   │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ Other profiles on this computer              │
│ ┌──────────────────────────────────────────┐ │
│ │ Google Chrome · Work              [Copy] │ │
│ │ work@example.com                         │ │
│ │ 66666666-7777-4888-8999-aaaaaaaaaaaa     │ │
│ ├──────────────────────────────────────────┤ │
│ │ Brave · Default                          │ │
│ │ Not paired yet                           │ │
│ └──────────────────────────────────────────┘ │
├──────────────────────────────────────────────┤
│ cici only reads files on this computer.      │
│ Nothing is ever sent anywhere.               │
└──────────────────────────────────────────────┘
```

"No ID" is not one answer, so the popup says five different things:

| Message | Meaning |
| --- | --- |
| a UUID | paired |
| Not paired yet | the extension is there but has never been connected to Claude Code |
| The Claude extension is not in this profile | not installed |
| Cannot tell whether this profile is paired | the extension's storage could not be read — it may already be paired |
| Could not read this profile folder | the profile folder itself was unreadable — installed or not is unknown |

Calling either of the last two "not found" would be a lie, so they are kept apart.

### Permissions

`extension/manifest.json` asks for two things and nothing else.

| Permission | Used for |
| --- | --- |
| `host_permissions: ["file:///*"]` | reading profile directory listings and LevelDB files with `fetch('file:///…')`. It does nothing at all until the user flips the toggle. |
| `permissions: ["storage"]` | writing one random value (`__cici_nonce`) into its *own* `chrome.storage.local` to work out which profile it is running in — see "How it works" below. |

No `tabs`, no `scripting`, no `nativeMessaging`, no `<all_urls>`, no remote code, no content
scripts, and no background service worker. It runs only while the popup is open.

---

## B. The CLI

```sh
npx cici
```

or from a clone:

```sh
git clone https://github.com/ldg030201/cici.git
cd cici
npm link      # puts a `cici` command on your PATH
cici
```

`node bin/cici.js` or `npm start` works too. Zero runtime dependencies.

### Output

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

`not paired` means the extension is installed but has never been connected; `not installed` rows
only appear with `--all`. When the table is wider than the terminal, the name / email / paired-name
columns shrink first — the profile and the UUID never do, because a UUID broken across a wrapped
line cannot be double-clicked.

### Flags

| Flag | What it does |
| --- | --- |
| `--json` | print a JSON array instead of the table |
| `--all` | include profiles where the extension is not installed |
| `--user-data-dir <dir>` | scan only this user-data directory (repeatable; disables auto-discovery). Use `--user-data-dir=<dir>` for a path starting with `-` |
| `--ext-id <id>` | extension id to look for (32 letters a–p, repeatable). Defaults to the known Claude in Chrome ids |
| `--no-color` | disable ANSI colors. `NO_COLOR`, `FORCE_COLOR=0` and `TERM=dumb` are honored too |
| `-q`, `--quiet` | suppress warnings on stderr |
| `-h`, `--help` | show help |
| `-v`, `--version` | print the version |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | at least one `bridgeDeviceId` was found |
| `1` | nothing found (stderr says where it looked) |
| `2` | usage error |

### Examples

```sh
cici
cici --all
cici --json | jq '.[] | select(.deviceId) | {profileName, deviceId}'
cici --user-data-dir "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
```

---

## Programmatic API

```js
import { scan, scanReport } from 'cici';

const rows = await scan();
for (const row of rows) {
  if (row.deviceId) console.log(row.profileName, row.deviceId);
}

// also reports which directories were searched, plus warnings not tied to a profile
const { rows: all, searched, warnings } = await scanReport({ includeUninstalled: true });
```

One row:

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

`ScanOptions` takes `userDataDirs`, `extensionIds`, `includeUninstalled`, and `platform` / `home` /
`env` for tests. `scan()` never throws because one profile is broken — problems arrive in that row's
`warnings`.

---

## How it works

Chrome stores an extension's `chrome.storage.local` as a LevelDB inside the profile:

```
<user-data-dir>/<profile>/Local Extension Settings/fcoeoabgfenejglbffodgkkbkcdhcgfn/
├─ CURRENT            → names the live MANIFEST
├─ MANIFEST-000001    → VersionEdit log: which .ldb files are live
├─ 000005.ldb         → SSTable; data blocks are snappy-compressed
└─ 000007.log         → WAL: records inside 32 KiB blocks, CRC32C
```

`bridgeDeviceId` and `bridgeDisplayName` live in there as JSON strings (quotes included, so they
need `JSON.parse`). cici reads it as real LevelDB: `CURRENT` → MANIFEST replay → live `.ldb` + `.log`.

**It never does a substring search.** `includes('bridgeDeviceId')` over raw WAL bytes **silently
misses the value** whenever a record straddles a 32 KiB block boundary and the 7-byte record header
lands inside the string — 5 misses in 10 trials, measured. Waiting or retrying does not fix it. Only
a real parser finds it.

### How the extension knows which profile it is in

There is no API for it. `chrome.identity.getProfileUserInfo()` returns empty strings for a
signed-out profile, and `Default` / `Profile 3` is a convention, not an identity
(`--profile-directory=Work` can name it anything).

So it uses a **nonce round-trip**: the popup writes a fresh random UUID to its *own*
`chrome.storage.local`; Chrome flushes it straight to
`<some profile>/Local Extension Settings/<cici's own id>/*.log`; the popup then reads its own
storage in every candidate profile over `file://` and finds the one that contains the nonce. That is
the profile it is running in. (Measured: the nonce was on disk before `set()` even resolved.)

### Why `file://`

Every extension API route to another extension's `chrome.storage` is closed — `sendMessage`/`connect`,
`chrome.debugger`, `chrome.scripting`, `storage.sync`, `web_accessible_resources`, `webRequest`, the
File System Access API, enterprise policy, third-party native hosts. All of them were tried.

Exactly one door opens: `host_permissions: ["file:///*"]` plus the toggle the user flips themselves.
Which door was knocked on, what came back, and how each answer was verified is written up in
[`docs/why.md`](docs/why.md) ([한국어](docs/why.ko.md)).

---

## Supported browsers and paths

Google Chrome · Chrome Beta · Chrome Dev · Chrome Canary · Chromium · Brave · Microsoft Edge ·
Arc (macOS) · Vivaldi · Opera

| OS | user-data dir (Chrome) |
| --- | --- |
| macOS | `~/Library/Application Support/Google/Chrome` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data` |
| Linux | `~/.config/google-chrome` |

Profile names and emails come from `profile.info_cache` in `<user-data-dir>/Local State`, never from
directory names.

---

## Privacy

* **Zero network requests.** Neither front end contacts anything. The extension's CSP is
  `connect-src 'self' file:`, so a remote connection is impossible by construction.
* **Read-only.** `readFile` / `readdir` / `stat` (CLI) and `fetch('file://…')` (extension). The
  LevelDB `LOCK` is never taken.
* **Nothing collected, sent, or stored.** Values are rendered and forgotten.
* The only thing the extension writes is one random value (`__cici_nonce`) into **its own**
  storage, overwritten on every run. It writes nothing to any other extension's storage.

Full text: [`docs/privacy-policy.md`](docs/privacy-policy.md) (Korean).

---

## Limitations

* **The file-URL toggle is manual and per profile.** No API can request it, and the extension cannot
  flip it. A Web Store install has it off by default.
* **Extension installs are per profile too.** Five profiles means five installs and five toggles.
  Use the CLI if you want everything at once.
* **A browser started with a custom `--user-data-dir` is invisible to the extension** — it only
  walks the standard locations. The CLI takes `--user-data-dir`.
* **`file://` discovery is measured on macOS only.** The listing format is platform-independent so
  the parser carries over; path discovery does not. snap/flatpak Chromium keeps profiles under
  `~/snap/...` or `~/.var/app/...` and is additionally sandboxed.
* **If Chrome tightens `file://`, the extension design dies at once.** The File System Access API
  already hard-blocks the user-data directory. The CLI is outside the browser and unaffected.
* **`bridgeDeviceId` only exists after pairing.** Run `/chrome` in Claude Code once first.

---

## Development

```sh
npm test           # node --test test/*.test.js — 334 tests, zero dependencies
npm start          # node bin/cici.js
npm run build:ext  # copy the shared parser from src/ into extension/lib/
npm run check:ext  # verify the copies match, without writing anything
npm run icons      # regenerate extension/icons/*.png
```

There is no build step. The extension loads as plain ES modules.

`extension/lib/leveldb-core.js` and `extension/lib/snappy.js` are generated copies of `src/`. Edit
`src/` and run `npm run build:ext`; `npm test` goes red if they drift.

---

## Docs

| Document | Contents |
| --- | --- |
| [`docs/why.md`](docs/why.md) | why the design is what it is — every avenue tried, why it is closed, evidence and verification |
| [`docs/why.ko.md`](docs/why.ko.md) | the Korean original of the above |
| [`docs/store-listing.md`](docs/store-listing.md) | Chrome Web Store listing material (Korean) |
| [`docs/privacy-policy.md`](docs/privacy-policy.md) | privacy policy (Korean) |

---

## License

MIT — see [`LICENSE`](LICENSE).

cici is an unofficial tool. It is not made by Anthropic, and it is neither affiliated with nor
endorsed by Anthropic. Claude, Claude Code, and Claude in Chrome are trademarks of Anthropic.

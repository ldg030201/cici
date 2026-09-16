# cici Privacy Policy

**Applies to:** the Chrome extension "cici - Claude in Chrome ID" and the `cici` command-line tool
**Effective:** 2026-09-16
**Source code:** <https://github.com/ldg030201/cici> (MIT)

> This is an English translation of the [Korean original](privacy-policy.md), provided for
> convenience. If the two ever disagree, the Korean text governs.

---

## One-line summary

**cici collects no personal data. Stores none. Transmits none. Sells none.**
It makes zero network requests.

---

## 1. Data we collect

None.

cici collects no user data. There is no server, no account, no sign-in,
no analytics, no advertising, no error reporting, and no remote code.

## 2. Data we transmit

None.

cici never connects to any server. The extension's Content Security Policy is set to
`default-src 'self'; connect-src 'self' file:; object-src 'none'` (among other, stricter
directives — the full string is in `extension/manifest.json`), so remote connections are
blocked **at the browser level**, not merely by the code.
All code ships inside the installed package; nothing is downloaded.

## 3. Data we store

The extension stores **two values** in its own `chrome.storage.local`.

| Key | Value | Purpose |
| --- | --- | --- |
| `__cici_nonce` | A randomly generated UUID (e.g. `3f2a…`) | Determining **which Chrome profile** the extension is running in |
| `__cici_lang` | The display language the user picked (e.g. `en`) | Keeping the popup's language choice for the next popup |

There is no API that tells an extension which profile it lives in. So every time the popup
opens, it generates a fresh nonce, writes it to its own storage, and scans the profiles for
the profile whose disk contains that nonce. That profile is the current one.

The nonce is not user data; it is regenerated on every run, overwriting the previous one.
The display language is stored only when the user operates the language menu in the popup
header. Neither value is transmitted anywhere or ever leaves the user's browser.

cici writes nothing else to disk. The command-line tool stores nothing at all.

## 4. Data we read

cici reads the following local files, **read-only**.

| What | Why |
| --- | --- |
| Directory listings of `<user-data-dir>/` and below | To find the browser profiles on this computer |
| `<user-data-dir>/Local State` | To display profile names and account emails on screen |
| `<profile>/Local Extension Settings/fcoeoabgfenejglbffodgkkbkcdhcgfn/` | To read the `bridgeDeviceId` and `bridgeDisplayName` stored by the Claude in Chrome extension |
| `<profile>/Local Extension Settings/<cici's own id>/` | To find the nonce from §3 and identify the current profile |
| `<profile>/Extensions/<extension id>/` | To check whether the Claude extension is installed (extension and CLI) and to read its version (CLI) |

Values that are read are used only to render the screen and are gone when it closes.
Nothing is accumulated or recorded anywhere.

### What we do not read

cici does **not read, and cannot read**, any of the following (it does not request the
permissions that would be required):

* Browsing history, bookmarks, download history
* Cookies, sessions, login state, saved passwords
* The addresses or contents of open tabs
* Keystrokes, clicks, mouse movement
* Other extensions' storage — beyond reading the Claude in Chrome files listed above

The extension requests exactly two permissions: `storage` and `host_permissions: ["file:///*"]`.
It requests none of `tabs`, `scripting`, `webRequest`, `cookies`, `history`, `nativeMessaging`,
`<all_urls>`, has no content scripts, and no background service worker.

## 5. Writing and modification

cici writes nothing into Chrome's profile directories.
It never creates, modifies, or deletes files, and never takes LevelDB's `LOCK` file,
so it is safe to use while the browser is running.

It never modifies any other extension's data, including the Claude in Chrome extension's.

## 6. About the file access permission

For the extension to read the files in §4, the user must manually enable
**"Allow access to file URLs"** on the extension's details page at `chrome://extensions`.

* This setting is **off by default** when installed from the Chrome Web Store.
* The extension cannot enable it by itself. There is no API to even request it.
* The user can turn it off again at any time, in the same place. With it off, the extension can read no files at all.
* The setting applies per Chrome profile.

## 7. Third parties

None. There is no data to share.
cici exchanges data with no third party — no analytics vendors, no ad networks, no cloud services.

## 8. Children's privacy

cici collects personal data from no one, which includes children.

## 9. Retention and deletion

Since no personal data is collected or stored, there is no retention period and no deletion
procedure. The values in §3 are removed by Chrome together with the extension's storage
when the extension is uninstalled.

## 10. Your rights

cici holds no user data, so there is nothing to request access to, correct, or delete.
Uninstalling the extension removes every trace it left (the values in §3).

## 11. How to verify

Every claim in this policy can be checked against the source code. The full source is public,
and the extension ships **human-readable**, with no bundling or minification.

| Claim | How to check |
| --- | --- |
| No network requests | Search `extension/` for `fetch(` — only `file:` URLs and the extension's own packaged language catalogs (via `chrome.runtime.getURL`) appear. There is no `XMLHttpRequest`, `WebSocket`, or `sendBeacon` |
| No remote code | See `content_security_policy` in `manifest.json`. There is no external `<script src>` |
| No writes | The only writing API used is `chrome.storage.local.set`, and only for `__cici_nonce` and `__cici_lang`. The CLI uses only `readFile`/`readdir`/`stat` |
| Only two permissions | `permissions` and `host_permissions` in `extension/manifest.json` |

You can also open your browser's DevTools network tab while using the popup: no request appears.

## 12. Changes

If this policy changes, this file is updated and the effective date revised.
The full change history is available in the repository's git log.

## 13. Contact

Via the developer contact shown on the Chrome Web Store listing, or the repository:
<https://github.com/ldg030201/cici>

---

cici is an unofficial tool not made by Anthropic; it is not affiliated with,
endorsed by, or sponsored by Anthropic.
Claude, Claude Code, and Claude in Chrome are trademarks of Anthropic.

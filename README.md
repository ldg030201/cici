<div align="center">

<img src="docs/images/icon.png" width="88" alt="">

# cici

**Tells you which Chrome profile owns each UUID in Claude Code's browser picker**

<sub>🇰🇷 <a href="README.ko.md">한국어</a> · 🇺🇸 <b>English</b> · 🇨🇳 <a href="README.zh-CN.md">简体中文</a> · 🇧🇷 <a href="README.pt.md">Português</a> · 🇯🇵 <a href="README.ja.md">日本語</a> · 🇪🇸 <a href="README.es.md">Español</a> · 🇩🇪 <a href="README.de.md">Deutsch</a> · 🇫🇷 <a href="README.fr.md">Français</a></sub>

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install-D97757?style=flat-square&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/gfffgnkeglhkdnkoindcikdblebcmgea)
[![license MIT](https://img.shields.io/badge/license-MIT-555?style=flat-square)](LICENSE)
[![dependencies 0](https://img.shields.io/badge/dependencies-0-555?style=flat-square)](package.json)
[![tests 347](https://img.shields.io/badge/tests-347-3F8F72?style=flat-square)](test)

<img src="docs/images/hero.png" width="820" alt="The picker shows nothing but UUIDs; cici tells you which profile each one is">

<sub>An unofficial tool. Not made by Anthropic, not affiliated with Anthropic.<br>
Claude, Claude Code, and Claude in Chrome are trademarks of Anthropic.</sub>


</div>

---

## The problem

If you use more than one Chrome profile — work, personal, a side project — Claude Code asks
which browser to use and gives you **nothing but a UUID to go on.**

```
Which browser?
  1. 8c71d0e4-2f96-4a83-b7d5-16ea93c4f082
  2. 4f2a9c81-7b3e-4d15-9a62-c08e5d1f7b40
  3. b93e5a27-c418-4f6d-8e10-7d24af95c3b1
```

Pick the wrong one and **a browser signed into the wrong account opens.** You meant to work in
your company account and your personal browser pops up — or the other way around.

cici answers exactly that one question: **which UUID belongs to which profile.**

<div align="center">
<img src="docs/images/popup.png" width="360" alt="The cici popup — the current profile's ID on top, other profiles below">
</div>

### Learn it once and stop picking

```
Open the work browser (4f2a9c81-7b3e-4d15-9a62-c08e5d1f7b40)
```

Pinning it via `/chrome` → **Select browser…** works too. Both need you to know the UUID.

---

## Install

### 1. [Install from the Chrome Web Store](https://chromewebstore.google.com/detail/gfffgnkeglhkdnkoindcikdblebcmgea)

No need to clone the repository and build anything. Install it from the store and Chrome
keeps it up to date for you.

The popup comes in **eight languages** — English, Korean, Simplified Chinese, Portuguese,
Japanese, Spanish, German, and French. By default it follows Chrome's UI language (anything
else falls back to English), and the globe icon at the top right of the popup switches it
directly.

### 2. Turn on file URL access

This one step is **required**. Without it the popup shows instructions instead of results.

1. Open `chrome://extensions`
2. cici → **Details**
3. Turn on **Allow access to file URLs**
4. Click the toolbar icon

> Flipping the toggle makes Chrome reload the extension, which closes the popup. That is not a
> bug. No browser restart needed — **just open the popup again.**

**Why this permission is needed.** The `bridgeDeviceId` is a value the Claude in Chrome
extension keeps in its own `chrome.storage.local`, and one extension cannot read another
extension's storage. Reading the file on disk is the only way. Every other route we tried, and
why each one is closed, is documented with evidence in [`docs/why.md`](docs/why.md).

### 3. Repeat per profile

Extensions install per profile. The popup still lists **every profile on this computer**, so
one install shows you the whole picture — only the "current profile" card is specific to the
profile you opened it in.

---

## Privacy

* **Zero network requests.** The CSP is locked to `connect-src 'self' file:`, so remote
  connections are structurally impossible.
* **Read-only.** It never takes the LevelDB `LOCK`, so it is safe while the browser is running.
* **Nothing collected, sent, or stored.** Values are rendered on screen and that is all.
* The only things it ever writes are one random nonce (`__cici_nonce`) and your display
  language choice, both into **its own** storage. It writes not a single byte into any other
  extension's storage.

Full text: [`docs/privacy-policy.md`](docs/privacy-policy.md).

---

## Documentation

Most documents are in Korean (the project's primary language); the architecture rationale has
a dedicated English edition.

| Document | Contents |
| --- | --- |
| [Why this architecture](docs/why.md) | Every route we tried and why each is closed — with evidence (English) |
| [Extension in detail](docs/extension.md) | Popup screens, the five states it distinguishes, permissions (Korean) |
| [How it works and limits](docs/how-it-works.md) | Where the value lives, how it finds its own profile (Korean) |
| [CLI](docs/cli.md) | A companion tool that lists every profile from the terminal (Korean) |
| [Development](docs/development.md) | Clone the repository and hack on it (Korean) |
| [Release](docs/release.md) | How a new version reaches the store (maintainers, Korean) |
| [Privacy policy](docs/privacy-policy.md) | Full text (Korean) |

---

## License

MIT — [`LICENSE`](LICENSE)

cici is an unofficial tool not made by Anthropic; it is not affiliated with, endorsed by, or
sponsored by Anthropic. Claude, Claude Code, and Claude in Chrome are trademarks of Anthropic.

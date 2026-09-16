<div align="center">

<img src="docs/images/icon.png" width="88" alt="">

# cici

**Claude Code のブラウザ選択リストに並ぶ UUID がどの Chrome プロフィールのものかを教えてくれる拡張機能**

<sub>🇰🇷 <a href="README.ko.md">한국어</a> · 🇺🇸 <a href="README.md">English</a> · 🇨🇳 <a href="README.zh-CN.md">简体中文</a> · 🇧🇷 <a href="README.pt.md">Português</a> · 🇯🇵 <b>日本語</b> · 🇪🇸 <a href="README.es.md">Español</a> · 🇩🇪 <a href="README.de.md">Deutsch</a> · 🇫🇷 <a href="README.fr.md">Français</a></sub>

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20ウェブストア-インストール-D97757?style=flat-square&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/gfffgnkeglhkdnkoindcikdblebcmgea)
[![license MIT](https://img.shields.io/badge/license-MIT-555?style=flat-square)](LICENSE)
[![dependencies 0](https://img.shields.io/badge/dependencies-0-555?style=flat-square)](package.json)
[![tests 347](https://img.shields.io/badge/tests-347-3F8F72?style=flat-square)](test)

<img src="docs/images/hero.png" width="820" alt="選択リストに表示されるのは UUID だけですが、cici はそれぞれがどのプロフィールなのかを教えてくれます">

<sub>非公式ツールです。Anthropic が開発したものではなく、Anthropic とは無関係です。<br>
Claude、Claude Code、Claude in Chrome は Anthropic の商標です。</sub>


</div>

---

## 何を解決するのか

Chrome で複数のアカウント — 仕事用、個人用、サイドプロジェクト用 — を使っていると、
Claude Code はどのブラウザを使うか尋ねてきますが、**手がかりは UUID しかありません。**

```
どのブラウザを使いますか？
  1. 8c71d0e4-2f96-4a83-b7d5-16ea93c4f082
  2. 4f2a9c81-7b3e-4d15-9a62-c08e5d1f7b40
  3. b93e5a27-c418-4f6d-8e10-7d24af95c3b1
```

選び間違えると、**別のアカウントでログインしたブラウザが開いてしまいます。** 会社のアカウントで
作業するつもりだったのに個人用のブラウザが立ち上がったり、その逆が起きたりします。

cici が答えるのは、この一つの質問だけです。**どの UUID がどのプロフィールのものか。**

<div align="center">
<img src="docs/images/popup.png" width="360" alt="cici のポップアップ — 現在のプロフィールの ID が一番上に、その下にほかのプロフィール">
</div>

### 一度覚えれば、毎回選ばずにすみます

```
仕事用のブラウザ（4f2a9c81-7b3e-4d15-9a62-c08e5d1f7b40）で開いて
```

`/chrome` → **Select browser…** で固定しておく方法もあります。どちらも、UUID を知っていることが
前提です。

---

## インストール

### 1. [Chrome ウェブストアからインストール](https://chromewebstore.google.com/detail/gfffgnkeglhkdnkoindcikdblebcmgea)

リポジトリをクローンして自分でビルドする必要はありません。ストアからインストールすれば、
更新も Chrome が自動で行ってくれます。

ポップアップは **8 つの言語**（日本語・英語・韓国語・簡体字中国語・ポルトガル語・スペイン語・
ドイツ語・フランス語）に対応しています。既定では Chrome の UI 言語に従い（それ以外の言語は
英語になります）、ポップアップ右上の地球儀アイコンから直接切り替えることもできます。

### 2. ファイルの URL へのアクセスをオンにする

このステップは**必須**です。オンになっていないと、ポップアップは結果の代わりに
案内画面を表示します。

1. `chrome://extensions` を開く
2. cici の**詳細**を開く
3. **ファイルの URL へのアクセスを許可する**をオンにする
4. ツールバーのアイコンをクリックする

> トグルをオンにすると Chrome が拡張機能を再読み込みするため、ポップアップは閉じます。
> 不具合ではありません。ブラウザを再起動する必要はなく、**ポップアップを開き直す**だけで動きます。

**なぜこの権限が必要なのか。** `bridgeDeviceId` は Claude in Chrome 拡張機能が自分の
`chrome.storage.local` に保存している値で、拡張機能はほかの拡張機能のストレージを読めません。
そのため、ディスク上のファイルを直接読む以外に方法がないのです。試したほかの経路と、
それぞれが塞がれている理由は、根拠とあわせて [`docs/why.md`](docs/why.md)（英語）に
まとめてあります。

### 3. プロフィールごとに繰り返す

拡張機能のインストールはプロフィール単位です。ただしポップアップは**このパソコンのすべての
プロフィール**を表示するので、1 つのプロフィールにインストールするだけでも全体の一覧は
見られます。「現在のプロフィール」の表示だけは、ポップアップを開いたプロフィールが基準になります。

---

## プライバシー

* **ネットワークリクエストは 0 件。** CSP が `connect-src 'self' file:` に固定されているため、
  リモート接続は構造的に不可能です。
* **読み取り専用。** LevelDB の `LOCK` を取らないため、ブラウザが起動中でも安全です。
* **収集・送信・保存は一切ありません。** 読み取った値は画面に表示するだけです。
* 拡張機能が**自分自身の**ストレージに書き込むのは、乱数（`__cici_nonce`）と表示言語の設定の
  2 つだけです。ほかの拡張機能のストレージには 1 バイトも書き込みません。

全文は [`docs/privacy-policy.md`](docs/privacy-policy.md) をご覧ください。

---

## ドキュメント

ほとんどのドキュメントは韓国語（このプロジェクトの主要言語）で書かれています。
アーキテクチャの背景説明には専用の英語版があります。

| ドキュメント | 内容 |
| --- | --- |
| [なぜこの構造なのか](docs/why.md) | 試したすべての経路と、それぞれが塞がれている理由 — 根拠つき（英語） |
| [拡張機能の詳細](docs/extension.md) | ポップアップの画面、区別する 5 つの状態、必要な権限（韓国語） |
| [動作の仕組みと限界](docs/how-it-works.md) | 値がどこにあるか、自分のプロフィールをどう見つけるか（韓国語） |
| [CLI](docs/cli.md) | ターミナルからすべてのプロフィールを一度に一覧できる補助ツール（韓国語） |
| [開発](docs/development.md) | リポジトリをクローンして手を入れる（韓国語） |
| [リリース](docs/release.md) | 新しいバージョンをストアに公開する手順（メンテナー向け・韓国語） |
| [プライバシーポリシー](docs/privacy-policy.md) | 全文（韓国語） |

---

## ライセンス

MIT — [`LICENSE`](LICENSE)

cici は Anthropic が開発したものではない非公式ツールであり、Anthropic との提携関係はなく、
Anthropic の承認や後援も受けていません。
Claude、Claude Code、Claude in Chrome は Anthropic の商標です。

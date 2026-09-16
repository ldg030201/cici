<div align="center">

<img src="docs/images/icon.png" width="88" alt="">

# cici

**一款告诉你 Claude Code 浏览器选择列表中的 UUID 对应哪个 Chrome 个人资料的扩展程序**

<sub>🇰🇷 <a href="README.ko.md">한국어</a> · 🇺🇸 <a href="README.md">English</a> · 🇨🇳 <b>简体中文</b> · 🇧🇷 <a href="README.pt.md">Português</a> · 🇯🇵 <a href="README.ja.md">日本語</a> · 🇪🇸 <a href="README.es.md">Español</a> · 🇩🇪 <a href="README.de.md">Deutsch</a> · 🇫🇷 <a href="README.fr.md">Français</a></sub>

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20网上应用店-立即安装-D97757?style=flat-square&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/gfffgnkeglhkdnkoindcikdblebcmgea)
[![license MIT](https://img.shields.io/badge/license-MIT-555?style=flat-square)](LICENSE)
[![dependencies 0](https://img.shields.io/badge/dependencies-0-555?style=flat-square)](package.json)
[![tests 347](https://img.shields.io/badge/tests-347-3F8F72?style=flat-square)](test)

<img src="docs/images/hero.png" width="820" alt="选择列表里只显示 UUID，cici 会告诉你每个 UUID 对应哪个个人资料">

<sub>这是一个非官方工具，并非由 Anthropic 开发，与 Anthropic 没有任何关系。<br>
Claude、Claude Code 和 Claude in Chrome 是 Anthropic 的商标。</sub>


</div>

---

## 解决什么问题

如果你在 Chrome 里使用多个账号——公司、个人、副业项目——Claude Code 在询问要用哪个浏览器时，
**除了 UUID 之外什么线索都不给。**

```
要使用哪个浏览器？
  1. 8c71d0e4-2f96-4a83-b7d5-16ea93c4f082
  2. 4f2a9c81-7b3e-4d15-9a62-c08e5d1f7b40
  3. b93e5a27-c418-4f6d-8e10-7d24af95c3b1
```

一旦选错，**打开的就是登录着另一个账号的浏览器。**本想在公司账号里干活，弹出来的却是个人浏览器——
或者正好相反。

cici 只回答这一个问题：**哪个 UUID 对应哪个个人资料。**

<div align="center">
<img src="docs/images/popup.png" width="360" alt="cici 弹窗——当前个人资料的 ID 在最上方，其他个人资料在下方">
</div>

### 记住一次，就不用每次都选

```
用公司浏览器（4f2a9c81-7b3e-4d15-9a62-c08e5d1f7b40）打开
```

通过 `/chrome` → **Select browser…** 固定下来也可以。两种办法都要求你先知道 UUID。

---

## 安装

### 1. [从 Chrome 网上应用店安装](https://chromewebstore.google.com/detail/gfffgnkeglhkdnkoindcikdblebcmgea)

不需要克隆仓库自己构建。从应用商店安装后，Chrome 还会自动保持更新。

弹窗提供**八种语言**界面：韩语、英语、简体中文、葡萄牙语、日语、西班牙语、
德语、法语。默认跟随 Chrome 的界面语言（其他语言回退到英语），
也可以点击弹窗右上角的地球图标直接切换。

### 2. 开启文件网址访问权限

这一步**必不可少**。不开启的话，弹窗显示的不是结果，而是一屏操作指引。

1. 打开 `chrome://extensions`
2. 进入 cici 的**详情**
3. 开启**允许访问文件网址**
4. 点击工具栏图标

> 开启该开关后，Chrome 会重新加载扩展程序，弹窗会随即关闭。这不是故障。
> 无需重启浏览器，**重新打开弹窗**即可。

**为什么需要这个权限。**`bridgeDeviceId` 是 Claude in Chrome 扩展程序保存在自己
`chrome.storage.local` 里的值，而一个扩展程序无法读取另一个扩展程序的存储。
因此除了直接读取磁盘上的文件之外别无他法。我们尝试过的其他路径，以及每条路径被堵死的原因，
都连同证据整理在 [`docs/why.md`](docs/why.md)（英文）中。

### 3. 每个个人资料都要重复一遍

扩展程序是按个人资料安装的。不过弹窗会列出**这台电脑上的所有个人资料**，
所以只装在一个个人资料里也能看到完整列表——只有“当前个人资料”的标记
以打开弹窗的那个个人资料为准。

---

## 隐私

* **零网络请求。**CSP 被锁定为 `connect-src 'self' file:`，从结构上就不可能发起远程连接。
* **只读。**不会占用 LevelDB 的 `LOCK`，因此浏览器开着的时候也安全。
* **不收集、不发送、不存储。**读到的值显示在屏幕上，仅此而已。
* 它写入**自己**存储的只有两样：一个随机数（`__cici_nonce`）和你选择的显示语言。
  对其他扩展程序的存储，一个字节也不会写。

全文见 [`docs/privacy-policy.md`](docs/privacy-policy.md)。

---

## 文档

大部分文档为韩文（项目的主要语言）；架构缘由另有专门的英文版。

| 文档 | 内容 |
| --- | --- |
| [为什么是这个架构](docs/why.md) | 尝试过的每条路径以及被堵死的原因——附证据（英文） |
| [扩展程序详解](docs/extension.md) | 弹窗界面、区分的五种状态、所需权限（韩文） |
| [工作原理与局限](docs/how-it-works.md) | 值存放在哪里、如何识别自己的个人资料（韩文） |
| [CLI](docs/cli.md) | 在终端一次列出所有个人资料的配套工具（韩文） |
| [开发](docs/development.md) | 克隆仓库动手修改（韩文） |
| [发布](docs/release.md) | 新版本上架应用商店的流程（维护者用，韩文） |
| [隐私政策](docs/privacy-policy.md) | 全文（韩文） |

---

## 许可证

MIT — [`LICENSE`](LICENSE)

cici 是非官方工具，并非由 Anthropic 开发，与 Anthropic 没有任何隶属或关联关系，
也未获得 Anthropic 的认可或赞助。
Claude、Claude Code 和 Claude in Chrome 是 Anthropic 的商标。

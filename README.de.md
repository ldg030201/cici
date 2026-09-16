<div align="center">

<img src="docs/images/icon.png" width="88" alt="">

# cici

**Zeigt, zu welchem Chrome-Profil jede UUID in der Browserauswahl von Claude Code gehört**

<sub>🇰🇷 <a href="README.ko.md">한국어</a> · 🇺🇸 <a href="README.md">English</a> · 🇨🇳 <a href="README.zh-CN.md">简体中文</a> · 🇧🇷 <a href="README.pt.md">Português</a> · 🇯🇵 <a href="README.ja.md">日本語</a> · 🇪🇸 <a href="README.es.md">Español</a> · 🇩🇪 <b>Deutsch</b> · 🇫🇷 <a href="README.fr.md">Français</a></sub>

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Installieren-D97757?style=flat-square&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/gfffgnkeglhkdnkoindcikdblebcmgea)
[![license MIT](https://img.shields.io/badge/license-MIT-555?style=flat-square)](LICENSE)
[![dependencies 0](https://img.shields.io/badge/dependencies-0-555?style=flat-square)](package.json)
[![tests 347](https://img.shields.io/badge/tests-347-3F8F72?style=flat-square)](test)

<img src="docs/images/hero.png" width="820" alt="Die Auswahl zeigt nur UUIDs – cici zeigt, welches Profil dahintersteckt">

<sub>Ein inoffizielles Tool. Nicht von Anthropic entwickelt, in keiner Verbindung zu Anthropic.<br>
Claude, Claude Code und Claude in Chrome sind Marken von Anthropic.</sub>


</div>

---

## Das Problem

Wer in Chrome mehrere Profile nutzt – Arbeit, privat, ein Nebenprojekt – bekommt von Claude Code
die Frage gestellt, welcher Browser verwendet werden soll, und **als einzigen Anhaltspunkt eine
UUID.**

```
Welcher Browser?
  1. 8c71d0e4-2f96-4a83-b7d5-16ea93c4f082
  2. 4f2a9c81-7b3e-4d15-9a62-c08e5d1f7b40
  3. b93e5a27-c418-4f6d-8e10-7d24af95c3b1
```

Ein falscher Griff, und **es öffnet sich ein Browser, der im falschen Konto angemeldet ist.**
Eigentlich sollte es das Firmenkonto sein, doch der private Browser geht auf – oder umgekehrt.

cici beantwortet genau diese eine Frage: **welche UUID zu welchem Profil gehört.**

<div align="center">
<img src="docs/images/popup.png" width="360" alt="Das cici-Pop-up – die ID des aktuellen Profils oben, darunter die übrigen Profile">
</div>

### Einmal nachschlagen, nie wieder auswählen

```
Öffne den Firmenbrowser (4f2a9c81-7b3e-4d15-9a62-c08e5d1f7b40)
```

Auch das Festlegen über `/chrome` → **Select browser…** funktioniert. Beides setzt voraus, dass
die UUID bekannt ist.

---

## Installation

### 1. [Aus dem Chrome Web Store installieren](https://chromewebstore.google.com/detail/gfffgnkeglhkdnkoindcikdblebcmgea)

Das Repository klonen und selbst bauen ist nicht nötig. Bei einer Installation aus dem Store
hält Chrome die Erweiterung automatisch aktuell.

Das Pop-up gibt es in **acht Sprachen**: Deutsch, Englisch, Koreanisch, vereinfachtes
Chinesisch, Portugiesisch, Japanisch, Spanisch und Französisch. Standardmäßig folgt es der
UI-Sprache von Chrome (alle übrigen Sprachen fallen auf Englisch zurück); über das
Globus-Symbol oben rechts im Pop-up lässt sich die Sprache auch direkt umstellen.

### 2. Zugriff auf Datei-URLs aktivieren

Dieser eine Schritt ist **zwingend erforderlich**. Ohne ihn zeigt das Pop-up statt Ergebnissen
eine Anleitung.

1. `chrome://extensions` öffnen
2. cici → **Details**
3. **Zugriff auf Datei-URLs zulassen** aktivieren
4. Auf das Symbol in der Symbolleiste klicken

> Beim Umlegen des Schalters lädt Chrome die Erweiterung neu, wodurch sich das Pop-up
> schließt. Das ist kein Fehler. Ein Neustart des Browsers ist nicht nötig – **einfach das
> Pop-up wieder öffnen.**

**Warum diese Berechtigung nötig ist.** Die `bridgeDeviceId` ist ein Wert, den die Erweiterung
Claude in Chrome in ihrem eigenen `chrome.storage.local` ablegt – und eine Erweiterung kann den
Speicher einer anderen nicht lesen. Der einzige Weg ist, die Datei direkt von der Festplatte zu
lesen. Alle anderen Wege, die ausprobiert wurden, und warum jeder davon verschlossen ist, sind
mit Belegen in [`docs/why.md`](docs/why.md) dokumentiert (Englisch).

### 3. Pro Profil wiederholen

Erweiterungen werden pro Profil installiert. Das Pop-up listet trotzdem **alle Profile auf
diesem Computer** auf – eine einzige Installation zeigt also bereits das Gesamtbild. Nur die
Karte „Aktuelles Profil“ bezieht sich auf das Profil, in dem das Pop-up geöffnet wurde.

---

## Datenschutz

* **Null Netzwerkanfragen.** Die CSP ist auf `connect-src 'self' file:` festgelegt, Verbindungen
  nach außen sind damit strukturell unmöglich.
* **Nur lesend.** Das LevelDB-`LOCK` wird nie gesetzt; auch bei laufendem Browser ist das Lesen
  daher sicher.
* **Nichts wird gesammelt, gesendet oder gespeichert.** Gelesene Werte werden angezeigt – das
  ist alles.
* In den **eigenen** Speicher schreibt die Erweiterung genau zwei Dinge: einen Zufallswert
  (`__cici_nonce`) und die eingestellte Anzeigesprache. In den Speicher anderer Erweiterungen
  schreibt sie kein einziges Byte.

Der vollständige Text: [`docs/privacy-policy.md`](docs/privacy-policy.md).

---

## Dokumentation

Die meisten Dokumente sind auf Koreanisch (der Hauptsprache des Projekts); die Begründung der
Architektur gibt es zusätzlich in einer eigenen englischen Ausgabe.

| Dokument | Inhalt |
| --- | --- |
| [Warum diese Architektur](docs/why.md) | Alle ausprobierten Wege und warum jeder verschlossen ist – mit Belegen (Englisch) |
| [Die Erweiterung im Detail](docs/extension.md) | Pop-up-Ansichten, die fünf unterschiedenen Zustände, Berechtigungen (Koreanisch) |
| [Funktionsweise und Grenzen](docs/how-it-works.md) | Wo der Wert liegt, wie das eigene Profil erkannt wird (Koreanisch) |
| [CLI](docs/cli.md) | Ein Begleitwerkzeug, das alle Profile im Terminal auflistet (Koreanisch) |
| [Entwicklung](docs/development.md) | Das Repository klonen und daran arbeiten (Koreanisch) |
| [Release](docs/release.md) | Wie eine neue Version in den Store kommt (für Maintainer, Koreanisch) |
| [Datenschutzerklärung](docs/privacy-policy.md) | Vollständiger Text (Koreanisch) |

---

## Lizenz

MIT – [`LICENSE`](LICENSE)

cici ist ein inoffizielles Tool, das nicht von Anthropic entwickelt wurde; es ist mit Anthropic
weder verbunden noch von Anthropic unterstützt oder gesponsert.
Claude, Claude Code und Claude in Chrome sind Marken von Anthropic.

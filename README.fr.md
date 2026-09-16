<div align="center">

<img src="docs/images/icon.png" width="88" alt="">

# cici

**Indique quel profil Chrome correspond à chaque UUID du sélecteur de navigateur de Claude Code**

<sub>🇰🇷 <a href="README.ko.md">한국어</a> · 🇺🇸 <a href="README.md">English</a> · 🇨🇳 <a href="README.zh-CN.md">简体中文</a> · 🇧🇷 <a href="README.pt.md">Português</a> · 🇯🇵 <a href="README.ja.md">日本語</a> · 🇪🇸 <a href="README.es.md">Español</a> · 🇩🇪 <a href="README.de.md">Deutsch</a> · 🇫🇷 <b>Français</b></sub>

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Installer-D97757?style=flat-square&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/gfffgnkeglhkdnkoindcikdblebcmgea)
[![license MIT](https://img.shields.io/badge/license-MIT-555?style=flat-square)](LICENSE)
[![dependencies 0](https://img.shields.io/badge/dependencies-0-555?style=flat-square)](package.json)
[![tests 347](https://img.shields.io/badge/tests-347-3F8F72?style=flat-square)](test)

<img src="docs/images/hero.png" width="820" alt="Le sélecteur n’affiche que des UUID ; cici indique à quel profil correspond chacun">

<sub>Outil non officiel. Il n’a pas été créé par Anthropic et n’a aucun lien avec Anthropic.<br>
Claude, Claude Code et Claude in Chrome sont des marques d’Anthropic.</sub>


</div>

---

## Le problème

Si vous utilisez plusieurs profils Chrome — travail, personnel, projet annexe — Claude Code
demande quel navigateur utiliser **sans donner d’autre indice qu’un UUID.**

```
Quel navigateur ?
  1. 8c71d0e4-2f96-4a83-b7d5-16ea93c4f082
  2. 4f2a9c81-7b3e-4d15-9a62-c08e5d1f7b40
  3. b93e5a27-c418-4f6d-8e10-7d24af95c3b1
```

Choisissez le mauvais et **c’est un navigateur connecté au mauvais compte qui s’ouvre.** Vous
vouliez travailler sur le compte de l’entreprise et c’est le navigateur personnel qui surgit —
ou l’inverse.

cici répond exactement à cette seule question : **quel UUID appartient à quel profil.**

<div align="center">
<img src="docs/images/popup.png" width="360" alt="Le pop-up de cici — l’ID du profil actuel en haut, les autres profils en dessous">
</div>

### Une fois l’UUID connu, plus besoin de choisir

```
Ouvre le navigateur du travail (4f2a9c81-7b3e-4d15-9a62-c08e5d1f7b40)
```

Le fixer via `/chrome` → **Select browser…** fonctionne aussi. Dans les deux cas, il faut
connaître l’UUID.

---

## Installation

### 1. [Installer depuis le Chrome Web Store](https://chromewebstore.google.com/detail/gfffgnkeglhkdnkoindcikdblebcmgea)

Pas besoin de cloner le dépôt ni de rien compiler. Installée depuis le Store, l’extension est
mise à jour automatiquement par Chrome.

Le pop-up existe en **huit langues** : français, anglais, coréen, chinois simplifié, portugais,
japonais, espagnol et allemand. Par défaut, il suit la langue de l’interface de Chrome (toute
autre langue retombe sur l’anglais), et l’icône de globe en haut à droite du pop-up permet de
changer de langue directement.

### 2. Activer l’accès aux URL de fichier

Cette étape est **indispensable**. Sans elle, le pop-up affiche des instructions au lieu des
résultats.

1. Ouvrez `chrome://extensions`
2. cici → **Détails**
3. Activez **« Autoriser l'accès aux URL de fichier »**
4. Cliquez sur l’icône de la barre d’outils

> Activer ce réglage fait recharger l’extension par Chrome, ce qui ferme le pop-up. Ce n’est
> pas un bug. Inutile de redémarrer le navigateur : **rouvrez simplement le pop-up.**

**Pourquoi cette permission est nécessaire.** Le `bridgeDeviceId` est une valeur que l’extension
Claude in Chrome garde dans son propre `chrome.storage.local`, et une extension ne peut pas lire
le stockage d’une autre extension. Lire le fichier sur le disque est donc la seule voie
possible. Toutes les autres pistes essayées, et pourquoi chacune est fermée, sont documentées
avec preuves dans [`docs/why.md`](docs/why.md).

### 3. Répéter pour chaque profil

Une extension s’installe profil par profil. Le pop-up liste pourtant **tous les profils de cet
ordinateur** : une seule installation suffit pour voir la liste complète — seule la carte
« Profil actuel » dépend du profil depuis lequel vous l’ouvrez.

---

## Confidentialité

* **Zéro requête réseau.** La CSP est verrouillée sur `connect-src 'self' file:` : toute
  connexion distante est structurellement impossible.
* **Lecture seule.** L’extension ne prend jamais le `LOCK` de LevelDB : aucun risque, même
  quand le navigateur tourne.
* **Rien n’est collecté, envoyé ni conservé.** Les valeurs sont affichées à l’écran, un point
  c’est tout.
* Les seules choses qu’elle écrit — et uniquement dans **son propre** stockage — sont un nonce
  aléatoire (`__cici_nonce`) et votre choix de langue d’affichage. Elle n’écrit pas un seul
  octet dans le stockage d’une autre extension.

Texte intégral : [`docs/privacy-policy.md`](docs/privacy-policy.md).

---

## Documentation

La plupart des documents sont en coréen (la langue principale du projet) ; la justification de
l’architecture dispose d’une édition anglaise dédiée.

| Document | Contenu |
| --- | --- |
| [Pourquoi cette architecture](docs/why.md) | Chaque piste essayée et pourquoi elle est fermée — avec preuves (anglais) |
| [L’extension en détail](docs/extension.md) | Les écrans du pop-up, les cinq états qu’elle distingue, les permissions (coréen) |
| [Fonctionnement et limites](docs/how-it-works.md) | Où vit la valeur, comment elle trouve son propre profil (coréen) |
| [CLI](docs/cli.md) | Outil compagnon qui liste tous les profils depuis le terminal (coréen) |
| [Développement](docs/development.md) | Cloner le dépôt et le modifier (coréen) |
| [Publication](docs/release.md) | Comment une nouvelle version arrive sur le Store (pour les mainteneurs, coréen) |
| [Politique de confidentialité](docs/privacy-policy.md) | Texte intégral (coréen) |

---

## Licence

MIT — [`LICENSE`](LICENSE)

cici est un outil non officiel qui n’a pas été créé par Anthropic ; il n’est ni affilié à
Anthropic, ni approuvé ni parrainé par Anthropic.
Claude, Claude Code et Claude in Chrome sont des marques d’Anthropic.

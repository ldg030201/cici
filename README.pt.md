<div align="center">

<img src="docs/images/icon.png" width="88" alt="">

# cici

**Mostra qual perfil do Chrome está por trás de cada UUID no seletor de navegador do Claude Code**

<sub>🇰🇷 <a href="README.ko.md">한국어</a> · 🇺🇸 <a href="README.md">English</a> · 🇨🇳 <a href="README.zh-CN.md">简体中文</a> · 🇧🇷 <b>Português</b> · 🇯🇵 <a href="README.ja.md">日本語</a> · 🇪🇸 <a href="README.es.md">Español</a> · 🇩🇪 <a href="README.de.md">Deutsch</a> · 🇫🇷 <a href="README.fr.md">Français</a></sub>

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Instalar-D97757?style=flat-square&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/gfffgnkeglhkdnkoindcikdblebcmgea)
[![license MIT](https://img.shields.io/badge/license-MIT-555?style=flat-square)](LICENSE)
[![dependencies 0](https://img.shields.io/badge/dependencies-0-555?style=flat-square)](package.json)
[![tests 347](https://img.shields.io/badge/tests-347-3F8F72?style=flat-square)](test)

<img src="docs/images/hero.png" width="820" alt="O seletor mostra apenas UUIDs; o cici diz qual perfil é cada um">

<sub>Ferramenta não oficial. Não foi feita pela Anthropic e não tem vínculo com a Anthropic.<br>
Claude, Claude Code e Claude in Chrome são marcas comerciais da Anthropic.</sub>


</div>

---

## O problema

Se você usa mais de um perfil do Chrome — trabalho, pessoal, um projeto paralelo — o Claude Code
pergunta qual navegador usar e **não dá nenhuma pista além de um UUID.**

```
Qual navegador?
  1. 8c71d0e4-2f96-4a83-b7d5-16ea93c4f082
  2. 4f2a9c81-7b3e-4d15-9a62-c08e5d1f7b40
  3. b93e5a27-c418-4f6d-8e10-7d24af95c3b1
```

Escolha o errado e **abre um navegador conectado à conta errada.** Você queria trabalhar na
conta da empresa e o navegador pessoal aparece — ou o contrário.

O cici responde exatamente a essa única pergunta: **qual UUID pertence a qual perfil.**

<div align="center">
<img src="docs/images/popup.png" width="360" alt="O popup do cici — o ID do perfil atual no topo, os demais perfis abaixo">
</div>

### Descubra uma vez e pare de escolher

```
Abra o navegador do trabalho (4f2a9c81-7b3e-4d15-9a62-c08e5d1f7b40)
```

Fixar pelo `/chrome` → **Select browser…** também funciona. Nos dois casos você precisa saber
o UUID.

---

## Instalação

### 1. [Instale pela Chrome Web Store](https://chromewebstore.google.com/detail/gfffgnkeglhkdnkoindcikdblebcmgea)

Não é preciso clonar o repositório nem compilar nada. Instalando pela loja, o próprio Chrome
cuida das atualizações.

O popup está disponível em **oito idiomas** — português, inglês, coreano, chinês simplificado,
japonês, espanhol, alemão e francês. Por padrão ele segue o idioma da interface do Chrome
(qualquer outro idioma cai para o inglês), e o ícone de globo no canto superior direito do
popup permite trocar diretamente.

### 2. Ative o acesso a URLs de arquivo

Este passo é **obrigatório**. Sem ele, o popup mostra instruções em vez de resultados.

1. Abra `chrome://extensions`
2. cici → **Detalhes**
3. Ative **Permitir acesso a URLs de arquivo**
4. Clique no ícone na barra de ferramentas

> Ao ativar a opção, o Chrome recarrega a extensão e o popup fecha. Não é um defeito.
> Não é preciso reiniciar o navegador — **basta abrir o popup de novo.**

**Por que essa permissão é necessária.** O `bridgeDeviceId` é um valor que a extensão Claude in
Chrome guarda no próprio `chrome.storage.local`, e uma extensão não consegue ler o armazenamento
de outra. Ler o arquivo direto do disco é o único caminho. Todas as outras rotas que tentamos, e
por que cada uma está fechada, estão documentadas com evidências em [`docs/why.md`](docs/why.md).

### 3. Repita em cada perfil

Extensões são instaladas por perfil. Ainda assim, o popup lista **todos os perfis deste
computador**, então uma única instalação já mostra o quadro completo — apenas o cartão
"perfil atual" se refere ao perfil em que você o abriu.

---

## Privacidade

* **Zero requisições de rede.** O CSP está travado em `connect-src 'self' file:`, então conexões
  remotas são estruturalmente impossíveis.
* **Somente leitura.** Nunca toma o `LOCK` do LevelDB, então é seguro mesmo com o navegador
  aberto.
* **Nada é coletado, enviado ou armazenado.** Os valores são exibidos na tela e nada mais.
* As únicas coisas que a extensão grava — e apenas no **próprio** armazenamento — são um nonce
  aleatório (`__cici_nonce`) e a sua escolha de idioma de exibição. Ela não escreve um único
  byte no armazenamento de nenhuma outra extensão.

Texto completo: [`docs/privacy-policy.md`](docs/privacy-policy.md).

---

## Documentação

A maior parte dos documentos está em coreano (o idioma principal do projeto); a justificativa da
arquitetura tem uma edição dedicada em inglês.

| Documento | Conteúdo |
| --- | --- |
| [Por que esta arquitetura](docs/why.md) | Cada rota que tentamos e por que está fechada — com evidências (inglês) |
| [A extensão em detalhes](docs/extension.md) | Telas do popup, os cinco estados que ela distingue, permissões (coreano) |
| [Como funciona e seus limites](docs/how-it-works.md) | Onde o valor fica, como ela encontra o próprio perfil (coreano) |
| [CLI](docs/cli.md) | Ferramenta complementar que lista todos os perfis pelo terminal (coreano) |
| [Desenvolvimento](docs/development.md) | Clone o repositório e mexa no código (coreano) |
| [Publicação](docs/release.md) | Como uma nova versão chega à loja (para mantenedores, coreano) |
| [Política de privacidade](docs/privacy-policy.md) | Texto completo (coreano) |

---

## Licença

MIT — [`LICENSE`](LICENSE)

O cici é uma ferramenta não oficial que não foi feita pela Anthropic; não tem vínculo com a
Anthropic e não conta com endosso nem patrocínio da Anthropic.
Claude, Claude Code e Claude in Chrome são marcas comerciais da Anthropic.

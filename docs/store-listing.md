# 크롬 웹스토어 등록 자료

cici 확장을 크롬 웹스토어에 올릴 때 그대로 붙여 넣을 문구와, 등록 전에 확인해야 할 것들.

> **게시 완료** — 2026-09-07, 버전 0.1.0.
> <https://chromewebstore.google.com/detail/gfffgnkeglhkdnkoindcikdblebcmgea>
> 이후 업데이트 절차는 `docs/release.md` 를 보라.

> 규격·수수료·심사 기간 같은 수치는 웹스토어 정책이 바뀌면 함께 바뀐다.
> 여기 적힌 값은 작성 시점의 참고값이므로, 제출 직전에 개발자 대시보드와
> [Chrome Web Store 문서](https://developer.chrome.com/docs/webstore/)에서 다시 확인할 것.

---

## 1. 이름

매니페스트가 `__MSG_extName__` 을 쓰므로, 스토어에 뜨는 이름은 `extension/_locales/<locale>/messages.json`
의 `extName` 값이다. 대시보드에서 따로 입력하지 않는다.

| 후보 | 길이 | 메모 |
| --- | --- | --- |
| **cici - Claude in Chrome ID** (모든 로케일 공통) | 26자 | 채택. 제품명 + 무엇을 주는지가 한 줄에 들어간다 |
| cici — Claude in Chrome 기기 ID | 29자 | "기기" 가 군더더기다. 긴 대시(—)도 하이픈으로 통일했다 |
| cici | 4자 | 검색으로 발견될 가능성이 없다 |
| Claude 브리지 ID 뷰어 | 14자 | "Claude" 를 앞에 두면 Anthropic 공식 확장으로 오인될 수 있다. 피한다 |

**주의.** 이름에 `Claude` 가 들어가지만 제품명이 앞에 오고 설명 어디에도 공식/제휴를 시사하는 문구가 없어야 한다.
무관계 고지는 세 곳에 있다. **짧은 설명 끝**(§2 — `extDesc`, chrome://extensions 에도 뜬다),
**자세한 설명 끝**(§3), 그리고 **팝업 헤더 제목 바로 아래**(`unofficialNote`). 아이콘이 Claude 의
터라코타를 쓰고 팝업 제목이 "Claude in Chrome ID" 라, 오해가 생기는 자리마다 부인해 둔다.

이름 길이 제한은 대시보드 기준으로 45자 안팎이다. 두 후보 모두 여유가 있다.

---

## 2. 짧은 설명 (132자 이내)

매니페스트의 `__MSG_extDesc__` → `messages.json` 의 `extDesc` 가 그대로 쓰인다.

**한국어 (115자)**

```
Claude Code 브라우저 선택 목록의 UUID 가 어느 크롬 프로필인지 알려줍니다. 현재 프로필의 bridgeDeviceId 를 바로 보여줍니다. 비공식 도구이며 Anthropic 과 관계가 없습니다.
```

**English (127자)**

```
Shows which Chrome profile owns each bridgeDeviceId in Claude Code's browser picker. Unofficial, not affiliated with Anthropic.
```

**中文（简体） (96자)**

```
显示 Claude Code 浏览器选择列表中的 UUID 对应哪个 Chrome 个人资料，并直接展示当前个人资料的 bridgeDeviceId。非官方工具，与 Anthropic 无关。
```

**Português (Brasil) (130자)**

```
Mostra o perfil do Chrome de cada bridgeDeviceId no seletor de navegador do Claude Code. Não oficial, sem vínculo com a Anthropic.
```

**日本語 (122자)**

```
Claude Code のブラウザ選択リストの UUID がどの Chrome プロフィールのものかを表示します。現在のプロフィールの bridgeDeviceId をすぐに確認できます。非公式ツールであり、Anthropic とは無関係です。
```

**Español (129자)**

```
Muestra a qué perfil de Chrome pertenece cada bridgeDeviceId del selector de Claude Code. No oficial, sin relación con Anthropic.
```

**Deutsch (126자)**

```
Zeigt, zu welchem Chrome-Profil jede UUID in der Browserauswahl von Claude Code gehört. Inoffiziell, unabhängig von Anthropic.
```

**Français (132자)**

```
Indique le profil Chrome de chaque bridgeDeviceId du sélecteur de navigateur de Claude Code. Non officiel, sans lien avec Anthropic.
```

**순서에 이유가 있다.** 스토어 목록의 카드에서는 이 문장의 뒤가 잘린다. 그래서
기능 설명을 앞에 두고 무관계 고지를 뒤에 붙였다 — 잘리면 기능 설명만 남고, 남은 글자가
거짓이 되지는 않는다. 고지 자체도 각 언어에서 "비공식(Unofficial/非官方/Não oficial/非公式/No oficial/Inoffiziell/Non officiel)" 에 해당하는 말로 시작한다.
`Anthropic` 을 앞에 두면 하필 그 자리에서 잘렸을 때 `… Anthropic` 만 남아 제휴처럼
읽힐 수 있다.

대부분 한도(132자)에 여유가 얼마 없고, 프랑스어는 정확히 132자다. `messages.json` 의 `extDesc` 를 고치면
길이를 다시 재고 이 표도 함께 고쳐야 한다.

**번역 용어는 크롬을 따른다.** 사용자가 크롬 화면과 대조할 수 있어야 하므로,
profile 의 역어와 파일 URL 토글 문구는 크롬 언어팩(152.0.7977.83 실측)을 그대로 쓴다.

| 로케일 | profile | 파일 URL 토글(크롬 실제 문구) |
| --- | --- | --- |
| zh-CN | 个人资料 (配置文件 0회) | 允许访问文件网址 |
| pt-BR | perfil | Permitir acesso a URLs de arquivo |
| ja | プロフィール (크롬 자체가 プロファイル와 혼용 — 다수 쪽) | ファイルの URL へのアクセスを許可する |
| es | perfil | Permitir el acceso a las URL del archivo |
| de | Profil | Zugriff auf Datei-URLs zulassen |
| fr | profil | Autoriser l'accès aux URL de fichier |

---

## 3. 자세한 설명

대시보드의 "자세한 설명" 칸에 넣는다. 매니페스트가 아니라 스토어에만 있는 텍스트다.
대시보드는 **언어마다 등록 정보가 따로** 있으므로, 언어를 바꿔 가며 아래 세 판을
각각 붙여 넣는다.

**한국어**

```
Claude Code 에 브라우저를 두 개 이상 연결해 두면, Claude Code 는 어느 브라우저를 쓸지
물어보면서 후보를 UUID 하나로만 표시합니다.

  1. 11111111-2222-4333-8444-555555555555
  2. 66666666-7777-4888-8999-aaaaaaaaaaaa

어느 쪽이 회사 프로필이고 어느 쪽이 개인 프로필인지 알 방법이 없습니다.
지금까지는 프로필마다 확장 프로그램의 서비스 워커 개발자 도구를 열고
chrome.storage.local.get('bridgeDeviceId') 를 직접 입력해야 했습니다.

cici 는 그 한 가지 질문에만 답합니다. 어느 UUID 가 어느 프로필의 것인가.

■ 무엇을 보여 주나요
  · 지금 이 프로필의 bridgeDeviceId — 팝업을 열면 맨 위에 크게. 클릭 한 번으로 복사됩니다.
  · 페어링할 때 입력한 이름(있는 경우)
  · 같은 컴퓨터의 다른 브라우저 프로필 목록과 각각의 ID
  · 아직 페어링되지 않은 프로필, Claude 확장이 없는 프로필도 그대로 구분해서 표시

■ 설치 후 한 단계가 더 필요합니다
  이 확장은 크롬 프로필 폴더 안의 파일을 읽습니다. 그러려면
  chrome://extensions → cici 세부정보 → "파일 URL에 대한 액세스 허용" 을 직접 켜야 합니다.
  확장이 스스로 켤 수 없는 설정이라, 팝업이 그 페이지까지 안내해 드립니다.
  토글을 켜면 크롬이 확장을 다시 불러오기 때문에 열려 있던 팝업이 닫힙니다.
  브라우저를 재시작할 필요는 없고, 팝업만 다시 열면 바로 동작합니다.

■ 개인정보
  · 네트워크 요청을 한 건도 하지 않습니다. 수집·전송하는 데이터가 없습니다.
  · 이 컴퓨터의 파일을 읽기만 합니다. 다른 확장의 저장소에는 아무것도 쓰지 않으며,
    확장 자신의 저장소에 남기는 값은 현재 프로필 확인용 난수와 표시 언어 설정 둘뿐입니다.
  · 읽는 대상은 크롬 자신의 프로필 폴더에 있는 확장 저장소(Local Extension Settings)와
    프로필 이름 목록(Local State)뿐입니다. 방문 기록, 쿠키, 비밀번호, 페이지 내용은
    읽지 않고 읽을 수도 없습니다.
  · 광고, 애널리틱스, 원격 코드가 없습니다.

■ 오픈소스
  전체 소스: https://github.com/ldg030201/cici (MIT)
  같은 일을 하는 명령줄 도구도 같은 저장소에 있습니다.

■ 필요 환경
  Chrome 116 이상. 다른 크로미움 기반 브라우저에서도 동작합니다.

■ 이 확장과 Anthropic 의 관계
  cici 는 Anthropic 이 만들지 않은 비공식 도구입니다. Anthropic 과 제휴 관계가 없고,
  Anthropic 의 보증이나 후원을 받지 않았습니다. 개인이 만들어 공개한 오픈소스입니다.
  Claude, Claude Code, Claude in Chrome 은 Anthropic 의 상표입니다. 이 확장은
  Claude in Chrome 확장이 이미 저장해 둔 값을 사용자에게 읽어 보여 줄 뿐이며,
  Anthropic 의 서비스에 접속하지 않습니다.
```

**English**

```
When you have more than one browser connected to Claude Code, Claude Code asks
which browser to use and shows each candidate as nothing but a UUID.

  1. 11111111-2222-4333-8444-555555555555
  2. 66666666-7777-4888-8999-aaaaaaaaaaaa

There is no way to tell which one is your work profile and which one is your
personal profile. Until now, that meant opening the extension's service worker
DevTools in each profile and typing chrome.storage.local.get('bridgeDeviceId')
by hand.

cici answers that one question only: which UUID belongs to which profile.

■ What it shows
  · This profile's bridgeDeviceId — large at the top the moment you open the popup. One click copies it.
  · The name you entered when pairing (if any)
  · The other browser profiles on the same computer, each with its own ID
  · Profiles that are not paired yet, and profiles without the Claude extension, are shown too, clearly distinguished

■ One more step after installing
  This extension reads files inside your Chrome profile folder. For that to work,
  you have to turn on chrome://extensions → cici details → "Allow access to file URLs"
  yourself. An extension cannot enable this setting on its own, so the popup guides
  you to that page. Turning the toggle on makes Chrome reload the extension, so an
  open popup will close. No browser restart is needed — just open the popup again
  and it works.

■ Privacy
  · It makes no network requests at all. It collects and transmits no data.
  · It only reads files on this computer. It writes nothing into any other extension's
    storage; the only values it keeps in its own storage are a random nonce used to find
    the current profile and your display-language choice.
  · The only things it reads are the extension storage (Local Extension Settings)
    inside Chrome's own profile folder and the list of profile names (Local State).
    It does not — and cannot — read your browsing history, cookies, passwords,
    or page contents.
  · No ads, no analytics, no remote code.

■ Open source
  Full source: https://github.com/ldg030201/cici (MIT)
  A command-line tool that does the same job lives in the same repository.

■ Requirements
  Chrome 116 or later. Also works in other Chromium-based browsers.

■ This extension and Anthropic
  cici is an unofficial tool that was not made by Anthropic. It is not affiliated
  with Anthropic and has not been endorsed or sponsored by Anthropic. It is open
  source, made and published by an individual. Claude, Claude Code, and Claude in
  Chrome are trademarks of Anthropic. This extension only reads and shows you a
  value that the Claude in Chrome extension has already stored; it does not connect
  to any Anthropic service.
```

**中文（简体）**

```
当你把两个以上的浏览器连接到 Claude Code 时，Claude Code 会询问要使用哪个浏览器，
而每个候选项只显示为一个 UUID。

  1. 11111111-2222-4333-8444-555555555555
  2. 66666666-7777-4888-8999-aaaaaaaaaaaa

你无从知道哪个是工作用的个人资料，哪个是私人用的个人资料。
到目前为止，只能在每个个人资料里打开扩展程序的 Service Worker 开发者工具，
手动输入 chrome.storage.local.get('bridgeDeviceId')。

cici 只回答这一个问题：哪个 UUID 属于哪个个人资料。

■ 它显示什么
  · 当前个人资料的 bridgeDeviceId — 打开弹窗即在最上方大字显示，点击一次即可复制。
  · 配对时输入的名称（如果有）
  · 同一台电脑上其他浏览器个人资料的列表，以及各自的 ID
  · 尚未配对的个人资料、没有安装 Claude 扩展程序的个人资料，也会照样区分开来显示

■ 安装后还需要一个步骤
  本扩展程序会读取 Chrome 个人资料文件夹里的文件。为此，你需要自行开启
  chrome://extensions → cici 详情 → “允许访问文件网址”。
  这是扩展程序无法自行开启的设置，所以弹窗会把你引导到那个页面。
  开启该开关后 Chrome 会重新加载扩展程序，因此已打开的弹窗会关闭。
  无需重启浏览器，只要重新打开弹窗就能立即使用。

■ 隐私
  · 不发出任何网络请求。不收集、不传输任何数据。
  · 只读取这台电脑上的文件。不向任何其他扩展程序的存储写入内容；它自己的存储中
    只保存两个值：用于识别当前个人资料的随机数和你选择的显示语言。
  · 读取的对象仅限 Chrome 自己的个人资料文件夹中的扩展存储
    （Local Extension Settings）和个人资料名称列表（Local State）。
    浏览记录、Cookie、密码、页面内容一概不读取，也无法读取。
  · 没有广告、没有分析工具、没有远程代码。

■ 开源
  完整源代码：https://github.com/ldg030201/cici（MIT）
  做同样事情的命令行工具也在同一个仓库里。

■ 运行环境
  Chrome 116 及以上。在其他基于 Chromium 的浏览器上也能运行。

■ 本扩展程序与 Anthropic 的关系
  cici 是非官方工具，并非由 Anthropic 开发。它与 Anthropic 没有任何隶属关系，
  也未获得 Anthropic 的认可或赞助。它是由个人制作并公开的开源软件。
  Claude、Claude Code 和 Claude in Chrome 是 Anthropic 的商标。本扩展程序只是把
  Claude in Chrome 扩展程序已经存储的值读出来展示给用户，不会连接 Anthropic 的任何服务。
```

**Português (Brasil)**

```
Quando você tem mais de um navegador conectado ao Claude Code, o Claude Code
pergunta qual navegador usar e mostra cada candidato apenas como um UUID.

  1. 11111111-2222-4333-8444-555555555555
  2. 66666666-7777-4888-8999-aaaaaaaaaaaa

Não há como saber qual deles é o perfil do trabalho e qual é o perfil pessoal.
Até agora, era preciso abrir as ferramentas do desenvolvedor do service worker
da extensão em cada perfil e digitar chrome.storage.local.get('bridgeDeviceId')
manualmente.

O cici responde apenas a essa pergunta: qual UUID pertence a qual perfil.

■ O que ele mostra
  · O bridgeDeviceId deste perfil — em letras grandes no topo, assim que você abre o popup. Um clique copia o valor.
  · O nome digitado no pareamento (se houver)
  · A lista dos outros perfis de navegador do mesmo computador, cada um com o próprio ID
  · Perfis ainda não pareados e perfis sem a extensão do Claude também aparecem, devidamente diferenciados

■ Um passo a mais depois da instalação
  Esta extensão lê arquivos dentro da pasta de perfil do Chrome. Para isso,
  você mesmo precisa ativar chrome://extensions → detalhes do cici →
  "Permitir acesso a URLs de arquivo". Como é uma configuração que a extensão
  não consegue ativar sozinha, o popup guia você até essa página.
  Ao ativar a opção, o Chrome recarrega a extensão, então o popup que estava
  aberto se fecha. Não é preciso reiniciar o navegador — basta abrir o popup
  de novo e já funciona.

■ Privacidade
  · Não faz nenhuma solicitação de rede. Não coleta nem transmite nenhum dado.
  · Apenas lê arquivos deste computador. Não grava nada no armazenamento de nenhuma outra
    extensão; os únicos valores que guarda no próprio armazenamento são um número aleatório
    usado para identificar o perfil atual e o idioma de exibição que você escolheu.
  · Lê somente o armazenamento de extensões (Local Extension Settings) dentro da
    própria pasta de perfil do Chrome e a lista de nomes de perfil (Local State).
    Histórico de navegação, cookies, senhas e conteúdo de páginas não são lidos —
    nem poderiam ser.
  · Sem anúncios, sem ferramentas de análise, sem código remoto.

■ Código aberto
  Código-fonte completo: https://github.com/ldg030201/cici (MIT)
  Uma ferramenta de linha de comando que faz o mesmo trabalho está no mesmo repositório.

■ Requisitos
  Chrome 116 ou superior. Também funciona em outros navegadores baseados em Chromium.

■ Esta extensão e a Anthropic
  O cici é uma ferramenta não oficial que não foi criada pela Anthropic. Não tem
  afiliação com a Anthropic e não recebeu endosso nem patrocínio da Anthropic.
  É um software de código aberto, criado e publicado por uma única pessoa.
  Claude, Claude Code e Claude in Chrome são marcas comerciais da Anthropic.
  Esta extensão apenas lê e mostra ao usuário um valor que a extensão
  Claude in Chrome já armazenou; ela não se conecta a nenhum serviço da Anthropic.
```

**日本語**

```
Claude Code にブラウザを 2 つ以上接続していると、Claude Code はどのブラウザを
使うかを尋ねる際、候補を UUID ひとつだけで表示します。

  1. 11111111-2222-4333-8444-555555555555
  2. 66666666-7777-4888-8999-aaaaaaaaaaaa

どちらが仕事用のプロフィールで、どちらが個人用のプロフィールなのか、知る方法がありません。
これまでは、プロフィールごとに拡張機能のサービスワーカーのデベロッパーツールを開き、
chrome.storage.local.get('bridgeDeviceId') を手で入力するしかありませんでした。

cici はそのひとつの質問だけに答えます。どの UUID がどのプロフィールのものか。

■ 表示される内容
  · 現在のプロフィールの bridgeDeviceId — ポップアップを開くと一番上に大きく表示されます。クリック 1 回でコピーできます。
  · ペアリングのときに入力した名前（ある場合）
  · 同じパソコンのほかのブラウザプロフィールの一覧と、それぞれの ID
  · まだペアリングされていないプロフィールも、Claude 拡張機能のないプロフィールも、そのまま区別して表示します

■ インストール後にもう 1 ステップ必要です
  この拡張機能は Chrome のプロフィールフォルダの中のファイルを読みます。そのためには、
  chrome://extensions → cici の詳細 → 「ファイルの URL へのアクセスを許可する」を
  自分でオンにする必要があります。拡張機能が自分ではオンにできない設定のため、
  ポップアップがそのページまでご案内します。
  トグルをオンにすると Chrome が拡張機能を再読み込みするため、開いていたポップアップは閉じます。
  ブラウザを再起動する必要はなく、ポップアップを開き直せばすぐに動きます。

■ プライバシー
  · ネットワークリクエストは 1 件も行いません。収集・送信するデータはありません。
  · このパソコンのファイルを読むだけです。ほかの拡張機能のストレージには何も書き込みません。
    自分のストレージに保存するのは、現在のプロフィール判定用の乱数と表示言語の設定の 2 つだけです。
  · 読み取る対象は、Chrome 自身のプロフィールフォルダにある拡張機能のストレージ
    (Local Extension Settings) と、プロフィール名の一覧 (Local State) だけです。
    閲覧履歴、Cookie、パスワード、ページの内容は読みませんし、読むこともできません。
  · 広告もアナリティクスもリモートコードもありません。

■ オープンソース
  全ソース: https://github.com/ldg030201/cici (MIT)
  同じことをするコマンドラインツールも同じリポジトリにあります。

■ 動作環境
  Chrome 116 以上。ほかの Chromium ベースのブラウザでも動作します。

■ この拡張機能と Anthropic の関係
  cici は Anthropic が作ったものではない非公式ツールです。Anthropic との提携関係はなく、
  Anthropic の承認や後援も受けていません。個人が作って公開したオープンソースです。
  Claude、Claude Code、Claude in Chrome は Anthropic の商標です。この拡張機能は、
  Claude in Chrome 拡張機能がすでに保存している値を読み取ってユーザーに表示するだけで、
  Anthropic のサービスには接続しません。
```

**Español**

```
Cuando tienes más de un navegador conectado a Claude Code, Claude Code pregunta
qué navegador usar y muestra cada candidato únicamente como un UUID.

  1. 11111111-2222-4333-8444-555555555555
  2. 66666666-7777-4888-8999-aaaaaaaaaaaa

No hay forma de saber cuál es el perfil de trabajo y cuál es el perfil personal.
Hasta ahora, había que abrir las herramientas de desarrollo del service worker
de la extensión en cada perfil y escribir chrome.storage.local.get('bridgeDeviceId')
a mano.

cici responde solo a esa pregunta: qué UUID pertenece a qué perfil.

■ Qué muestra
  · El bridgeDeviceId de este perfil — en grande, arriba del todo, en cuanto abres la ventana emergente. Un clic lo copia.
  · El nombre que introdujiste al emparejar (si lo hay)
  · La lista de los demás perfiles de navegador del mismo equipo, cada uno con su propio ID
  · Los perfiles aún no emparejados y los perfiles sin la extensión de Claude también aparecen, claramente diferenciados

■ Hace falta un paso más después de la instalación
  Esta extensión lee archivos dentro de la carpeta de perfil de Chrome. Para que
  funcione, tienes que activar tú mismo chrome://extensions → detalles de cici →
  "Permitir el acceso a las URL del archivo". Es un ajuste que la extensión no
  puede activar por sí sola, así que la ventana emergente te guía hasta esa página.
  Al activar la opción, Chrome vuelve a cargar la extensión, por lo que la ventana
  emergente que estuviera abierta se cierra. No hace falta reiniciar el navegador:
  basta con volver a abrir la ventana emergente y ya funciona.

■ Privacidad
  · No hace ninguna solicitud de red. No recopila ni transmite ningún dato.
  · Solo lee archivos de este equipo. No escribe nada en el almacenamiento de ninguna otra
    extensión; los únicos valores que guarda en su propio almacenamiento son un número
    aleatorio para identificar el perfil actual y el idioma de visualización que elegiste.
  · Lo único que lee es el almacenamiento de extensiones (Local Extension Settings)
    dentro de la propia carpeta de perfil de Chrome y la lista de nombres de perfil
    (Local State). El historial de navegación, las cookies, las contraseñas y el
    contenido de las páginas no se leen, y tampoco podrían leerse.
  · Sin anuncios, sin herramientas de análisis, sin código remoto.

■ Código abierto
  Código fuente completo: https://github.com/ldg030201/cici (MIT)
  En el mismo repositorio hay también una herramienta de línea de comandos que hace el mismo trabajo.

■ Requisitos
  Chrome 116 o superior. También funciona en otros navegadores basados en Chromium.

■ Esta extensión y Anthropic
  cici es una herramienta no oficial que no fue creada por Anthropic. No está
  afiliada a Anthropic y no ha recibido el respaldo ni el patrocinio de Anthropic.
  Es software de código abierto, creado y publicado por un particular.
  Claude, Claude Code y Claude in Chrome son marcas comerciales de Anthropic.
  Esta extensión solo lee y muestra al usuario un valor que la extensión
  Claude in Chrome ya ha almacenado; no se conecta a ningún servicio de Anthropic.
```

**Deutsch**

```
Wenn mehr als ein Browser mit Claude Code verbunden ist, fragt Claude Code,
welcher Browser verwendet werden soll – und zeigt jeden Kandidaten nur als
eine UUID an.

  1. 11111111-2222-4333-8444-555555555555
  2. 66666666-7777-4888-8999-aaaaaaaaaaaa

Es gibt keine Möglichkeit zu erkennen, welches davon das Arbeitsprofil und
welches das private Profil ist. Bisher musste man dafür in jedem Profil die
Entwicklertools des Service Workers der Erweiterung öffnen und
chrome.storage.local.get('bridgeDeviceId') von Hand eingeben.

cici beantwortet nur diese eine Frage: Welche UUID gehört zu welchem Profil?

■ Was angezeigt wird
  · Die bridgeDeviceId dieses Profils – groß ganz oben, sobald das Pop-up geöffnet wird. Ein Klick kopiert sie.
  · Der beim Koppeln eingegebene Name (falls vorhanden)
  · Die Liste der anderen Browserprofile auf demselben Computer, jeweils mit eigener ID
  · Auch noch nicht gekoppelte Profile und Profile ohne die Claude-Erweiterung werden angezeigt, klar voneinander unterschieden

■ Nach der Installation ist ein weiterer Schritt nötig
  Diese Erweiterung liest Dateien im Chrome-Profilordner. Dafür unter
  chrome://extensions → Details zu cici den Schalter
  „Zugriff auf Datei-URLs zulassen“ selbst aktivieren. Eine Erweiterung kann
  diese Einstellung nicht selbst aktivieren, deshalb führt das Pop-up bis zu
  dieser Seite. Beim Aktivieren des Schalters lädt Chrome die Erweiterung
  neu, daher schließt sich ein geöffnetes Pop-up. Ein Neustart des Browsers
  ist nicht nötig – einfach das Pop-up erneut öffnen, dann funktioniert es
  sofort.

■ Datenschutz
  · Es werden keinerlei Netzwerkanfragen gestellt. Es werden keine Daten erhoben oder übertragen.
  · Es werden nur Dateien auf diesem Computer gelesen. In den Speicher anderer Erweiterungen
    wird nichts geschrieben; im eigenen Speicher liegen nur zwei Werte – eine Zufallszahl zum
    Erkennen des aktuellen Profils und die gewählte Anzeigesprache.
  · Gelesen werden ausschließlich der Erweiterungsspeicher (Local Extension
    Settings) im Chrome-eigenen Profilordner und die Liste der Profilnamen
    (Local State). Browserverlauf, Cookies, Passwörter und Seiteninhalte
    werden nicht gelesen – und können auch nicht gelesen werden.
  · Keine Werbung, keine Analysetools, kein Remote-Code.

■ Open Source
  Vollständiger Quellcode: https://github.com/ldg030201/cici (MIT)
  Ein Befehlszeilen-Tool, das dieselbe Aufgabe erledigt, liegt im selben Repository.

■ Voraussetzungen
  Chrome 116 oder höher. Funktioniert auch in anderen Chromium-basierten Browsern.

■ Diese Erweiterung und Anthropic
  cici ist ein inoffizielles Tool, das nicht von Anthropic entwickelt wurde.
  Es steht in keiner Verbindung zu Anthropic und wird von Anthropic weder
  unterstützt noch gesponsert. Es ist Open-Source-Software, von einer
  Privatperson erstellt und veröffentlicht. Claude, Claude Code und
  Claude in Chrome sind Marken von Anthropic. Diese Erweiterung liest
  lediglich einen Wert aus, den die Erweiterung Claude in Chrome bereits
  gespeichert hat, und zeigt ihn an; sie stellt keine Verbindung zu einem
  Dienst von Anthropic her.
```

**Français**

```
Quand vous avez plus d’un navigateur connecté à Claude Code, Claude Code
demande quel navigateur utiliser et n’affiche chaque candidat que sous la
forme d’un UUID.

  1. 11111111-2222-4333-8444-555555555555
  2. 66666666-7777-4888-8999-aaaaaaaaaaaa

Impossible de savoir lequel est le profil professionnel et lequel est le
profil personnel. Jusqu’ici, il fallait ouvrir dans chaque profil les outils
de développement du service worker de l’extension et taper
chrome.storage.local.get('bridgeDeviceId') à la main.

cici ne répond qu’à cette seule question : quel UUID appartient à quel profil.

■ Ce que cici affiche
  · Le bridgeDeviceId de ce profil — en grand tout en haut dès que vous ouvrez le pop-up. Un clic suffit pour le copier.
  · Le nom saisi lors de l’association (le cas échéant)
  · La liste des autres profils de navigateur du même ordinateur, chacun avec son propre ID
  · Les profils pas encore associés et les profils sans l’extension Claude apparaissent aussi, clairement distingués

■ Une étape de plus après l’installation
  Cette extension lit des fichiers dans le dossier de profil de Chrome. Pour cela,
  vous devez activer vous-même chrome://extensions → détails de cici →
  « Autoriser l'accès aux URL de fichier ». Comme c’est un réglage qu’une
  extension ne peut pas activer seule, le pop-up vous guide jusqu’à cette page.
  Quand vous activez ce réglage, Chrome recharge l’extension, et le pop-up qui
  était ouvert se ferme. Inutile de redémarrer le navigateur — rouvrez
  simplement le pop-up et tout fonctionne.

■ Confidentialité
  · Elle n’effectue aucune requête réseau. Elle ne collecte ni ne transmet aucune donnée.
  · Elle ne fait que lire des fichiers de cet ordinateur. Elle n’écrit rien dans le stockage
    d’aucune autre extension ; les seules valeurs conservées dans son propre stockage sont
    un nombre aléatoire servant à identifier le profil actuel et la langue d’affichage choisie.
  · Elle ne lit que le stockage des extensions (Local Extension Settings) situé
    dans le propre dossier de profil de Chrome et la liste des noms de profil
    (Local State). L’historique de navigation, les cookies, les mots de passe
    et le contenu des pages ne sont pas lus — et ne peuvent pas l’être.
  · Pas de publicité, pas d’outils d’analyse, pas de code distant.

■ Open source
  Code source complet : https://github.com/ldg030201/cici (MIT)
  Un outil en ligne de commande qui fait le même travail se trouve dans le même dépôt.

■ Configuration requise
  Chrome 116 ou version ultérieure. Fonctionne aussi sur les autres navigateurs basés sur Chromium.

■ Cette extension et Anthropic
  cici est un outil non officiel qui n’a pas été créé par Anthropic. Il n’est
  pas affilié à Anthropic et n’a reçu ni approbation ni parrainage d’Anthropic.
  C’est un logiciel open source, créé et publié par un particulier.
  Claude, Claude Code et Claude in Chrome sont des marques d’Anthropic.
  Cette extension ne fait que lire et montrer à l’utilisateur une valeur que
  l’extension Claude in Chrome a déjà enregistrée ; elle ne se connecte à
  aucun service d’Anthropic.
```

> **브라우저 이름을 나열하지 말 것.** 2026-09-04 첫 제출이 이 줄 하나로 거부됐다
> (키워드 스팸, 위반 참조 ID `Yellow Argon`). 지적된 원문은
> `Chrome, Chromium, Brave, Microsoft Edge, Vivaldi, Opera, Arc` 였다.
> 구글은 다른 브라우저 브랜드명을 늘어놓는 것을 검색 노출을 노린 키워드 채우기로 본다.
> 실제 호환 범위는 README 에 적고, 스토어 설명에는 브랜드명을 나열하지 않는다.

> **명령줄 도구의 실행 방법을 여기 적지 말 것.** 초판에는 `npx cici` 라고 적혀
> 있었는데, 우리는 npm 에 게시한 적이 없고 npm 의 `cici` 는 무관한 다른 패키지다.
> 그대로 따라 한 사람은 남의 코드를 실행하게 된다. 저장소 주소만 주고 실행 방법은
> `docs/cli.md` 에서 읽게 한다.

---

## 4. 카테고리 · 언어

| 항목 | 값 |
| --- | --- |
| 카테고리 | **개발자 도구 (Developer Tools)** |
| 언어 | 한국어, 영어, 중국어(간체), 포르투갈어(브라질), 일본어, 스페인어, 독일어, 프랑스어 |
| 대상 연령 | 전체 |

`_locales` 에 `ko`·`en`·`zh_CN`·`pt`·`ja`·`es`·`de`·`fr` 가 있고 `default_locale` 은 `en` 이다 — 폴백이 `ko` 면
지원하지 않는 언어(프랑스어, 일본어…)의 크롬 사용자가 전부 한국어 화면을 보게 된다.
대시보드에서는 언어마다 스토어 등록 정보를 따로 만든다(§3 의 각 언어판을 붙여 넣는다).

---

## 5. 단일 목적 진술문

대시보드 "개인정보 보호 관행" 탭의 **단일 목적** 칸.

```
이 확장의 단일 목적은, 사용자의 크롬 프로필에 설치된 Claude in Chrome 확장이
저장해 둔 bridgeDeviceId 를 찾아 사용자에게 보여 주는 것입니다.
Claude Code 가 브라우저 선택 화면에 표시하는 UUID 가 어느 프로필의 것인지
사용자가 알 수 있게 하는 것이 유일한 기능이며, 다른 기능은 없습니다.
```

---

## 6. 권한 정당화

대시보드는 매니페스트가 요구하는 권한마다 정당화 문구를 요구한다. 심사자가 직접 읽는 칸이므로
"무엇을, 왜, 그 결과 무엇을 할 수 있게 되는지" 를 구체적으로 쓴다.

### `host_permissions: ["file:///*"]`

```
사용자가 찾으려는 bridgeDeviceId 는 Claude in Chrome 확장이 자신의
chrome.storage.local 에 저장한 값이고, 디스크에서는 다음 경로의 LevelDB 파일입니다.

  <크롬 user-data 디렉터리>/<프로필>/Local Extension Settings/
  fcoeoabgfenejglbffodgkkbkcdhcgfn/

확장 API 로는 다른 확장의 chrome.storage 를 읽을 수 없습니다. 이 값을
사용자에게 보여 주려면 그 파일을 직접 읽는 방법밖에 없고, 확장에서 로컬 파일을
읽는 유일한 경로가 file:// 스킴에 대한 host_permissions 입니다.

읽는 대상은 다음 세 가지뿐입니다.
  1. 프로필 디렉터리를 찾기 위한 디렉터리 목록
     (예: /Users/<user>/Library/Application Support/Google/Chrome/)
  2. <user-data-dir>/Local State — 프로필 이름과 계정 이메일을 표시하기 위해
  3. Local Extension Settings/<확장 id>/ 아래의 LevelDB 파일
     (Claude in Chrome 확장의 것, 그리고 현재 프로필을 판별하기 위한 이 확장 자신의 것)

읽기 전용입니다. 파일을 쓰거나 지우거나 잠그지 않으며, LevelDB LOCK 파일도 잡지
않으므로 브라우저가 실행 중이어도 안전합니다. 읽은 값은 팝업 화면에 표시할 뿐,
어디에도 전송하거나 저장하지 않습니다. 네트워크 요청은 한 건도 없습니다.

이 권한은 사용자가 확장 세부정보 페이지에서 "파일 URL에 대한 액세스 허용" 을
직접 켜기 전까지는 아무 효과가 없습니다.
```

### `permissions: ["storage"]`

```
확장에는 자신이 어느 크롬 프로필에서 실행 중인지 알아낼 수 있는 API 가 없습니다.
그래서 이 확장은 팝업을 열 때마다 난수 UUID 하나를 만들어 자기 자신의
chrome.storage.local 에 "__cici_nonce" 키로 씁니다. 크롬은 그 값을 현재 프로필의
디스크에 곧바로 기록하므로, 프로필들을 훑어 그 난수가 들어 있는 프로필을 찾으면
그곳이 현재 프로필입니다.

storage 권한이 저장하는 값은 두 개뿐입니다. 위의 난수("__cici_nonce")와, 사용자가
팝업의 언어 메뉴에서 고른 표시 언어("__cici_lang")입니다. 두 값 모두 사용자 데이터가
아니고 전송되지 않습니다. 다른 확장의 저장소에는 접근하지 않습니다(그럴 수 있는
API 도 없습니다).
```

### 요구하지 않는 것

심사 대응용으로 함께 적어 두면 좋다.

* `tabs`, `activeTab`, `scripting`, `webRequest`, `cookies`, `history`, `bookmarks`, `downloads` — 없음
* `nativeMessaging` — 없음
* `<all_urls>` / `http://*/*` / `https://*/*` — 없음
* 콘텐트 스크립트 — 없음
* 백그라운드 서비스 워커 — 없음 (팝업을 열 때만 실행된다)
* 원격 코드 — 없음. 모든 코드가 패키지 안에 있고, CSP 가
  `default-src 'self'; connect-src 'self' file:; object-src 'none'` 로 묶여 있어
  원격 연결이 구조적으로 불가능하다.

---

## 7. 개인정보 처리방침

대시보드는 개인정보 처리방침 **URL** 을 요구한다. 전문은 [`privacy-policy.md`](privacy-policy.md) 에 있고,
GitHub 에 올라간 그 파일의 주소를 그대로 넣으면 된다.

```
https://github.com/ldg030201/cici/blob/main/docs/privacy-policy.md
```

### 데이터 사용 공개 체크리스트

대시보드 "개인정보 보호 관행" 탭에서 수집 항목을 체크하게 되어 있다. **전부 "수집하지 않음"** 이다.

| 항목 | 수집 여부 |
| --- | --- |
| 개인 식별 정보 (이름, 주소, 이메일, 연령 등) | 아니오 |
| 건강 정보 | 아니오 |
| 금융 및 결제 정보 | 아니오 |
| 인증 정보 (비밀번호, 자격 증명) | 아니오 |
| 개인 통신 내용 | 아니오 |
| 위치 정보 | 아니오 |
| 웹 방문 기록 | 아니오 |
| 사용자 활동 (클릭, 마우스 위치, 키 입력 등) | 아니오 |
| 웹사이트 콘텐츠 | 아니오 |

> 프로필 이름과 계정 이메일은 화면에 **표시**되지만, 사용자 자신의 화면에만 보이고
> 수집·전송·저장되지 않는다. 웹스토어의 "수집(collect)" 정의는 확장 밖으로 내보내는 것을 말하므로
> 모두 "아니오" 가 맞다. 심사자가 이 부분을 물을 수 있으니, §6 의 정당화 문구에 이미 명시해 두었다.

### 함께 체크해야 하는 인증문 3종

* 승인된 용도 외로 데이터를 사용하거나 이전하지 않습니다 — **예**
* 데이터를 신용도 판단이나 대출 목적으로 사용하거나 이전하지 않습니다 — **예**
* 제3자에게 데이터를 판매하지 않습니다 — **예**

---

## 8. 이미지 자산

| 자산 | 규격 | 필수 | 준비 상태 |
| --- | --- | --- | --- |
| 확장 아이콘 | 128×128 PNG | 필수 | `extension/icons/icon128.png` 있음 |
| 스크린샷 | 1280×800 또는 640×400 PNG/JPEG, 최소 1장, 최대 5장 | 필수 | 제출 완료 |
| 작은 프로모 타일 | 440×280 PNG/JPEG | 선택(권장) | 제출 완료. `node scripts/make-icons.mjs --store <dir>` 로 재생성 |
| 마키 프로모 타일 | 1400×560 PNG/JPEG | 선택 | 넣지 않음(구글 큐레이션용) |

### 스크린샷 구성안 (1280×800, 5장)

팝업 자체는 좁으므로, 팝업을 실제 크롬 창 위에 얹은 합성 이미지로 만든다.
**모든 스크린샷은 가짜 데이터로 만든다.** 실제 UUID·이메일·프로필 이름을 절대 넣지 않는다.

| # | 화면 | 담을 것 | 캡션 |
| --- | --- | --- | --- |
| 1 | **문제** | Claude Code 터미널에 UUID 세 개가 뜬 브라우저 선택 화면. UUID 를 노란 밑줄로 강조 | "어느 UUID 가 어느 프로필일까요?" |
| 2 | **답** | 팝업의 결과 화면. 현재 프로필 카드에 `11111111-2222-4333-8444-555555555555`, 프로필 이름 "Personal", 이메일 `you@example.com` | "팝업을 열면 이 프로필의 ID 가 바로 보입니다" |
| 3 | **다른 프로필** | 결과 화면 아래쪽. "Work" / "Personal" / Brave 행, `not paired` 상태 한 줄 포함 | "같은 컴퓨터의 다른 프로필도 한눈에" |
| 4 | **설정 안내** | 파일 URL 접근이 꺼져 있을 때의 안내 화면 + `chrome://extensions` 세부정보의 토글에 화살표 | "설치 후 '파일 URL에 대한 액세스 허용' 한 번만 켜 주세요" |
| 5 | **개인정보** | 팝업 하단 문구를 확대. 필요하면 "네트워크 요청 0건 · 읽기 전용 · 오픈소스" 를 텍스트로 얹는다 | "읽기만 합니다. 아무 데도 보내지 않습니다" |

스크린샷 안의 텍스트는 대시보드에 등록한 언어마다 따로 만드는 것이 이상적이다
(크롬 UI 언어를 바꾸면 팝업 언어가 따라 바뀐다). 다만 대시보드는 언어별 이미지를
따로 받지 않은 언어에 기본 이미지를 보여 주므로, 일단 공용 스크린샷으로 게시하고
언어별 판은 나중에 추가해도 된다.

---

## 9. 제출 전 체크리스트

### 코드

- [ ] `npm test` 통과 (342개)
- [ ] `npm run check:ext` 통과 — `extension/lib/*.js` 가 `src/` 와 일치
- [ ] `extension/manifest.json` 의 `version` 을 올림 (스토어는 같은 버전 재업로드를 거부한다)
- [ ] `manifest.json` 의 권한이 `storage` + `file:///*` 뿐인지 재확인
- [ ] `homepage_url` 이 올바른 저장소를 가리키는지 확인
- [ ] `_locales` 의 **모든 로케일**에서 `extName`·`extDesc` 길이 확인 (이름 45자, 설명 132자)
- [ ] 무관계 고지가 세 곳에 다 있는지 확인 — `extDesc` 끝(§2), 자세한 설명 끝(§3),
      팝업 헤더의 `unofficialNote`
- [ ] 저장소·스크린샷·문서 어디에도 실제 UUID·이메일·프로필 이름이 없는지 확인

### 패키징

- [ ] `extension/` 디렉터리 **내용물**을 zip 으로 압축 (`extension/` 폴더 자체를 넣으면 안 된다 —
      zip 루트에 `manifest.json` 이 있어야 한다)
- [ ] zip 에 `.DS_Store`, `__MACOSX`, 에디터 임시 파일이 섞이지 않았는지 확인

```sh
cd extension && zip -r -X ../cici-extension-<version>.zip . -x '.*' -x '__MACOSX/*'
```

- [ ] 만든 zip 을 다른 프로필에 압축해제해 로드하고 팝업이 정상 동작하는지 확인

### 대시보드

- [ ] 개발자 계정 등록 — **일회성 등록비**(현재 US$5)를 낸 계정이 필요하다. 계정당 한 번이다
- [ ] 계정에 게시자 정보(연락 이메일) 등록 및 이메일 인증. 인증이 안 되어 있으면 제출이 막힌다
- [ ] 스토어 등록정보: 이름·설명(§1–3), 카테고리(§4), 언어, 아이콘, 스크린샷(§8)
- [ ] 개인정보 보호 관행: 단일 목적(§5), 권한 정당화(§6), 데이터 사용 공개(§7), 인증문 3종
- [ ] 개인정보 처리방침 URL 입력(§7)
- [ ] 배포 범위 선택 (공개 / 링크가 있는 사용자 / 비공개). 처음에는 **비공개 또는 링크 공개**로
      올려 심사를 통과시키고 실제 설치로 검증한 뒤 공개로 돌리는 편이 안전하다
- [ ] 제출

### 심사

- 심사 기간은 확장의 권한 구성에 따라 크게 달라진다. `file:///*` 는 민감한 권한으로 분류될 수 있어
  기본 심사보다 오래 걸릴 가능성을 염두에 둔다. 며칠 안에 끝나기도 하고 그보다 길어지기도 한다 —
  기간을 확정적으로 잡아 두지 말 것.
- 거절되면 사유가 메일로 온다. `file:///*` 관련이라면 §6 의 정당화 문구와
  [`why.ko.md`](why.ko.md) §2 (다른 모든 확장 API 경로가 막혀 있다는 근거)를 근거로 회신한다.
- 웹스토어가 이 용도의 `file:///*` 을 끝내 거부하면, 확장은 접고 CLI 만 남긴다.
  그것이 [`why.ko.md`](why.ko.md) §6 에 적어 둔 결정이다.

---

## 10. 등록 후

- [ ] 웹스토어 링크를 언어별 README 전부(`README.md`=영어 메인, `README.ko.md`, `README.zh-CN.md`, `README.pt.md`)의 설치 절차에 반영
- [ ] 웹스토어 설치본에서 파일 URL 토글이 실제로 꺼져 있는지, 팝업 안내 화면이 제대로 뜨는지 확인
      (지금까지 이 상태는 사이드로드로만 재현했다 — [`why.ko.md`](why.ko.md) §6-6 참고)
- [ ] Windows / Linux 에서 실제로 프로필을 찾는지 확인. 아직 macOS 에서만 실측했다

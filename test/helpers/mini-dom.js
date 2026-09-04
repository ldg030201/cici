/**
 * 아주 작은 DOM.
 *
 * `extension/popup.js` 를 **진짜로 실행해서** 검사하기 위한 것이다. popup.js 는
 * 조각들을 이어 붙이는 유일한 파일인데(라이브러리 세 개 + popup.html 의 id +
 * `_locales` 의 키), 정적 검사로는 "import 한 이름이 실제로 export 돼 있는가",
 * "`byId('...')` 가 가리키는 노드가 정말 있는가", "렌더 결과가 어떤 모양인가"를
 * 확인할 수 없다. 그래서 브라우저 없이 돌릴 수 있는 최소한의 DOM 을 둔다.
 *
 * 목표는 DOM 명세 구현이 아니라 **popup.js 가 실제로 쓰는 표면만** 정확히
 * 흉내 내는 것이다. 쓰지 않는 기능은 일부러 없고, 지원하지 않는 셀렉터를 주면
 * 조용히 빈 배열을 주는 대신 던진다 — 조용히 틀리는 것보다 시끄럽게 죽는 편이
 * 테스트에 낫다.
 *
 * 런타임 의존성 0개 원칙에 따라 jsdom 같은 것을 쓰지 않고 직접 만든다.
 */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** `data-i18n-aria` -> `i18nAria` */
function toCamel(name) {
  return name.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
}

/** `i18nAria` -> `data-i18n-aria` */
function toDashed(name) {
  return `data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

export class MiniText {
  /** @param {string} data */
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

export class MiniElement {
  /**
   * @param {string} tagName
   * @param {MiniDocument} ownerDocument
   * @param {string|null} [namespaceURI]
   */
  constructor(tagName, ownerDocument, namespaceURI = null) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.localName = String(tagName).toLowerCase();
    this.namespaceURI = namespaceURI;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    /** @type {Array<MiniElement|MiniText>} */
    this.childNodes = [];
    /** @type {Map<string, string>} */
    this.attrs = new Map();
    /** @type {Map<string, Function[]>} */
    this.listeners = new Map();
    /** 실제 브라우저의 `style` 은 훨씬 크지만 popup.js 는 대입만 한다. */
    this.style = {};
    /** `<textarea>` 의 값. 클립보드 대체 경로가 쓴다. */
    this.value = '';
    /** `select()` 가 불렸는지 — 대체 복사 경로 검증용. */
    this.selected = false;
  }

  // -- 속성 ---------------------------------------------------------------

  getAttribute(name) {
    const v = this.attrs.get(String(name).toLowerCase());
    return v === undefined ? null : v;
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    this.attrs.set(key, String(value));
    if (key === 'id') this.ownerDocument?.index(this);
  }

  removeAttribute(name) {
    this.attrs.delete(String(name).toLowerCase());
  }

  hasAttribute(name) {
    return this.attrs.has(String(name).toLowerCase());
  }

  get id() {
    return this.getAttribute('id') ?? '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return this.getAttribute('class') ?? '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get title() {
    return this.getAttribute('title') ?? '';
  }

  set title(value) {
    this.setAttribute('title', value);
  }

  /** `hidden` 은 속성의 유무로 표현된다. popup.js 는 이걸 불리언처럼 쓴다. */
  get hidden() {
    return this.hasAttribute('hidden');
  }

  set hidden(value) {
    if (value) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }

  get classList() {
    const self = this;
    const parts = () => (self.className.trim() === '' ? [] : self.className.trim().split(/\s+/));
    return {
      add(...names) {
        const set = new Set(parts());
        for (const n of names) set.add(n);
        self.className = [...set].join(' ');
      },
      remove(...names) {
        const set = new Set(parts());
        for (const n of names) set.delete(n);
        self.className = [...set].join(' ');
      },
      contains: (name) => parts().includes(name),
      get length() {
        return parts().length;
      },
    };
  }

  /** `data-*` 속성을 camelCase 로 읽고 쓴다. */
  get dataset() {
    const self = this;
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== 'string') return undefined;
          return self.getAttribute(toDashed(prop)) ?? undefined;
        },
        set(_t, prop, value) {
          if (typeof prop === 'string') self.setAttribute(toDashed(prop), value);
          return true;
        },
        has(_t, prop) {
          return typeof prop === 'string' && self.hasAttribute(toDashed(prop));
        },
        ownKeys() {
          return [...self.attrs.keys()].filter((k) => k.startsWith('data-')).map((k) => toCamel(k.slice(5)));
        },
        getOwnPropertyDescriptor() {
          return { enumerable: true, configurable: true };
        },
      },
    );
  }

  // -- 트리 ---------------------------------------------------------------

  /** @param {...(MiniElement|MiniText|string)} kids */
  append(...kids) {
    for (const kid of kids) {
      const node = typeof kid === 'string' ? new MiniText(kid) : kid;
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.childNodes.push(node);
      if (node instanceof MiniElement) this.ownerDocument?.indexTree(node);
    }
  }

  /** @param {...(MiniElement|MiniText|string)} kids */
  replaceChildren(...kids) {
    for (const kid of this.childNodes) kid.parentNode = null;
    this.childNodes = [];
    this.append(...kids);
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) {
      this.childNodes.splice(i, 1);
      node.parentNode = null;
    }
    return node;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  get children() {
    return this.childNodes.filter((n) => n instanceof MiniElement);
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  set textContent(value) {
    for (const kid of this.childNodes) kid.parentNode = null;
    this.childNodes = [];
    const text = String(value);
    if (text !== '') this.append(new MiniText(text));
  }

  // -- 이벤트 -------------------------------------------------------------

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  /**
   * 테스트가 직접 부른다. 진짜 이벤트 전파는 흉내 내지 않는다 — popup.js 는
   * 버블링에 기대지 않고 노드마다 직접 듣는다.
   *
   * @param {string} type
   * @returns {Promise<void>} 리스너가 async 여도 끝날 때까지 기다린다
   */
  async dispatch(type) {
    for (const fn of this.listeners.get(type) ?? []) await fn({ type, target: this });
  }

  // -- 셀렉터 -------------------------------------------------------------

  /**
   * `tag`, `.class`, `#id`, `[attr]` 와 그 조합, 공백으로 이은 자손 선택자만
   * 지원한다. 그 밖의 셀렉터는 던진다.
   *
   * @param {string} selector
   * @returns {MiniElement[]}
   */
  querySelectorAll(selector) {
    const steps = String(selector).trim().split(/\s+/).filter(Boolean);
    if (steps.length === 0) return [];
    let current = [this];
    for (const step of steps) {
      const match = compileSimpleSelector(step);
      const next = [];
      for (const node of current) for (const d of descendants(node)) if (match(d)) next.push(d);
      current = [...new Set(next)];
    }
    return current;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** `<textarea>` 대체 복사 경로가 부른다. */
  select() {
    this.selected = true;
  }

  /** 디버깅용. 태그와 class 만 보여 준다. */
  get outline() {
    const cls = this.className ? `.${this.className.split(/\s+/).join('.')}` : '';
    return `${this.localName}${this.id ? `#${this.id}` : ''}${cls}`;
  }
}

function* descendants(node) {
  for (const kid of node.childNodes) {
    if (kid instanceof MiniElement) {
      yield kid;
      yield* descendants(kid);
    }
  }
}

/**
 * `div.a#b[hidden]` 같은 한 조각을 검사 함수로 바꾼다.
 * @param {string} step
 * @returns {(el: MiniElement) => boolean}
 */
function compileSimpleSelector(step) {
  const tests = [];
  let rest = step;
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag) {
    const want = tag[0].toLowerCase();
    tests.push((el) => el.localName === want);
    rest = rest.slice(tag[0].length);
  }
  while (rest !== '') {
    let m;
    if ((m = /^\.([\w-]+)/.exec(rest))) {
      const want = m[1];
      tests.push((el) => el.classList.contains(want));
    } else if ((m = /^#([\w-]+)/.exec(rest))) {
      const want = m[1];
      tests.push((el) => el.id === want);
    } else if ((m = /^\[([\w-]+)(?:=("?)([^\]"]*)\2)?\]/.exec(rest))) {
      const name = m[1];
      const value = m[3];
      tests.push((el) => (value === undefined ? el.hasAttribute(name) : el.getAttribute(name) === value));
    } else {
      throw new Error(`mini-dom: 지원하지 않는 셀렉터 조각입니다: ${step}`);
    }
    rest = rest.slice(m[0].length);
  }
  return (el) => tests.every((fn) => fn(el));
}

export class MiniDocument {
  constructor() {
    /** @type {Map<string, MiniElement>} */
    this.ids = new Map();
    this.documentElement = new MiniElement('html', this);
    this.head = new MiniElement('head', this);
    this.body = new MiniElement('body', this);
    this.documentElement.append(this.head, this.body);
    /** `execCommand('copy')` 가 몇 번 불렸는지. */
    this.execCommandCalls = [];
    this.execCommandResult = true;
  }

  createElement(tag) {
    return new MiniElement(tag, this);
  }

  createElementNS(ns, tag) {
    return new MiniElement(tag, this, ns);
  }

  createTextNode(text) {
    return new MiniText(text);
  }

  getElementById(id) {
    return this.ids.get(String(id)) ?? null;
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  execCommand(name) {
    this.execCommandCalls.push(name);
    return this.execCommandResult;
  }

  /** @param {MiniElement} el */
  index(el) {
    if (el.id) this.ids.set(el.id, el);
  }

  /** @param {MiniElement} el */
  indexTree(el) {
    this.index(el);
    for (const d of descendants(el)) this.index(d);
  }

  get lang() {
    return this.documentElement.getAttribute('lang') ?? '';
  }
}

/**
 * popup.html 정도의 얌전한 HTML 을 트리로 만든다.
 *
 * 우리 저장소의 파일만 먹이므로 태그 수프까지 감당하지 않는다. 다만 popup.html
 * 에 실제로 있는 것들(doctype, 주석, self-closing `<path />`, 값 없는 `hidden`
 * 속성, `<svg>` 안의 camelCase 속성)은 정확히 처리한다.
 *
 * `<script>` 는 **실행하지 않는다.** 요소만 만든다 — popup.js 는 테스트가
 * 직접 import 한다.
 *
 * @param {string} html
 * @returns {MiniDocument}
 */
export function parseHtml(html) {
  const doc = new MiniDocument();
  const stack = [doc.documentElement];
  let i = 0;
  const src = String(html);
  /** 진짜 브라우저처럼 <head>/<body> 를 열어 준 상태로 시작한다. */
  let sawHtml = false;

  const top = () => stack[stack.length - 1];

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      addText(top(), src.slice(i));
      break;
    }
    if (lt > i) addText(top(), src.slice(i, lt));

    // 주석
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    // doctype 등
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    // 닫는 태그
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt);
      const name = src.slice(lt + 2, end < 0 ? src.length : end).trim().toLowerCase();
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].localName === name) {
          stack.length = k;
          break;
        }
      }
      i = end < 0 ? src.length : end + 1;
      continue;
    }

    // 여는 태그
    const end = findTagEnd(src, lt);
    const raw = src.slice(lt + 1, end);
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^[a-zA-Z][\w:-]*/.exec(body);
    if (!nameMatch) {
      i = end + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    i = end + 1;

    if (name === 'html') {
      sawHtml = true;
      for (const [k, v] of parseAttrs(body.slice(nameMatch[0].length))) doc.documentElement.setAttribute(k, v);
      continue;
    }
    if (name === 'head') {
      stack.push(doc.head);
      continue;
    }
    if (name === 'body') {
      stack.push(doc.body);
      continue;
    }

    const el = new MiniElement(name, doc, name === 'svg' || top().namespaceURI ? 'http://www.w3.org/2000/svg' : null);
    for (const [k, v] of parseAttrs(body.slice(nameMatch[0].length))) el.setAttribute(k, v);
    top().append(el);

    if (name === 'script' || name === 'style' || name === 'textarea' || name === 'title') {
      // 원시 텍스트 요소: 닫는 태그까지 통째로 텍스트다. 특히 <script> 안의
      // `<` 를 태그로 잘못 읽으면 안 된다.
      const close = src.toLowerCase().indexOf(`</${name}`, i);
      const text = src.slice(i, close < 0 ? src.length : close);
      if (text !== '') el.append(new MiniText(text));
      if (close >= 0) {
        const gt = src.indexOf('>', close);
        i = gt < 0 ? src.length : gt + 1;
      } else {
        i = src.length;
      }
      continue;
    }

    if (!selfClosing && !VOID_TAGS.has(name)) stack.push(el);
  }

  void sawHtml;
  return doc;
}

/** 따옴표 안의 `>` 를 태그 끝으로 오해하지 않는다. */
function findTagEnd(src, start) {
  let quote = '';
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return src.length;
}

/**
 * `a="1" b='2' c` 를 [key, value] 목록으로.
 * @param {string} text
 * @returns {Array<[string, string]>}
 */
function parseAttrs(text) {
  /** @type {Array<[string, string]>} */
  const out = [];
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = m[1].toLowerCase();
    if (key === '' || key === '/') continue;
    out.push([key, decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')]);
  }
  return out;
}

function addText(parent, text) {
  if (text === '') return;
  parent.append(new MiniText(decodeEntities(text)));
}

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

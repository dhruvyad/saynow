/**
 * The smallest DOM that can run ui/bubble.html.
 *
 * The page has been the least-tested part of saynow and the most broken: a
 * const referenced from above its declaration killed the script twice, once
 * leaving a bubble that ignored its own close button. Every one of those was
 * found by a person looking at a screen, because nothing here executes the
 * page.
 *
 * A real browser would be a heavier dependency than this project takes, so
 * this implements just enough — elements, classes, events, a tree walker —
 * to load the script and see whether it survives and wires itself up.
 */

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link']);

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) {
    for (const n of names) this.set.add(n);
  }
  remove(...names) {
    for (const n of names) this.set.delete(n);
  }
  toggle(name, force) {
    const on = force ?? !this.set.has(name);
    on ? this.set.add(name) : this.set.delete(name);
    return on;
  }
  contains(name) {
    return this.set.has(name);
  }
  toString() {
    return [...this.set].join(' ');
  }
}

class TextNode {
  constructor(data) {
    this.data = data;
    this.nodeType = 3;
    this.parentElement = null;
  }
  replaceWith(...nodes) {
    const parent = this.parentElement;
    if (!parent) return;
    const at = parent.children.indexOf(this);
    const flat = nodes.flatMap((n) => (n instanceof Fragment ? n.children : [n]));
    for (const n of flat) n.parentElement = parent;
    parent.children.splice(at, 1, ...flat);
  }
  get textContent() {
    return this.data;
  }
}

class Fragment {
  constructor() {
    this.children = [];
  }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new TextNode(n) : n;
      this.children.push(node);
    }
  }
}

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentElement = null;
    this.classList = new ClassList();
    this.style = {};
    this.attributes = {};
    this.listeners = new Map();
    this.value = '';
    this.offsetWidth = 400;
    this.offsetHeight = 120;
  }

  set className(value) {
    this.classList = new ClassList();
    for (const n of String(value).split(/\s+/).filter(Boolean)) this.classList.add(n);
  }
  get className() {
    return this.classList.toString();
  }

  append(...nodes) {
    for (const n of nodes) {
      if (n === '' || n === null || n === undefined) continue;
      const node = typeof n === 'string' ? new TextNode(n) : n;
      if (node instanceof Fragment) {
        for (const child of node.children) {
          child.parentElement = this;
          this.children.push(child);
        }
        continue;
      }
      node.parentElement = this;
      this.children.push(node);
    }
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  setPointerCapture(id) {
    this.captured = id;
  }

  releasePointerCapture() {
    this.captured = null;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  /** Fire a listener the way a user would, for assertions about wiring. */
  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  hasListener(type) {
    return (this.listeners.get(type) ?? []).length > 0;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  closest(selector) {
    const want = selector.toUpperCase();
    let node = this;
    while (node) {
      if (node.tagName === want) return node;
      node = node.parentElement;
    }
    return null;
  }

  scrollIntoView() {}

  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }

  get textContent() {
    return this.children.map((c) => c.textContent ?? '').join('');
  }
  set textContent(value) {
    this.children = [];
    if (value !== '') this.append(String(value));
  }

  set innerHTML(html) {
    this.children = [];
    for (const node of parseHtml(String(html), this.ownerDocument)) {
      node.parentElement = this;
      this.children.push(node);
    }
  }
}

/**
 * A parser for the markup this project generates, not for the web at large.
 * The renderer emits a known, well-formed set of tags, so this only has to
 * handle those — it exists to let the page's tree walking be exercised.
 */
function parseHtml(html, ownerDocument) {
  const tokens = html.split(/(<[^>]+>)/).filter((t) => t !== '');
  const root = { children: [] };
  const stack = [root];

  for (const token of tokens) {
    const top = stack[stack.length - 1];

    if (!token.startsWith('<')) {
      const text = new TextNode(token);
      top.children.push(text);
      continue;
    }

    if (token.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const name = /^<([a-zA-Z][\w-]*)/.exec(token)?.[1];
    if (!name) continue;

    const element = new Element(name);
    element.ownerDocument = ownerDocument;
    top.children.push(element);
    if (!VOID_TAGS.has(name.toLowerCase()) && !token.endsWith('/>')) stack.push(element);
  }

  const link = (parent) => {
    for (const child of parent.children ?? []) {
      child.parentElement = parent === root ? null : parent;
      if (child.children) link(child);
    }
  };
  link(root);
  return root.children;
}

/** Build a document with the elements bubble.html expects to find by id. */
/**
 * Initial classes come from bubble.html itself, so the stub starts where the
 * real page starts. Seeding blank elements made the reply box look visible
 * before the script had touched it.
 */
function initialClasses(markup) {
  const classes = new Map();
  for (const m of markup.matchAll(/<[a-z]+[^>]*class="([^"]+)"[^>]*id="([^"]+)"/g)) {
    classes.set(m[2], m[1]);
  }
  for (const m of markup.matchAll(/<[a-z]+[^>]*id="([^"]+)"[^>]*class="([^"]+)"/g)) {
    classes.set(m[1], m[2]);
  }
  return classes;
}

export function createDom({ search = '?t=testtoken', markup = '' } = {}) {
  const seeded = initialClasses(markup);
  const byId = new Map();
  const document = {
    activeElement: null,
    listeners: new Map(),
    getElementById: (id) => byId.get(id) ?? null,
    createElement(tag) {
      const el = new Element(tag);
      el.ownerDocument = document;
      return el;
    },
    createDocumentFragment: () => new Fragment(),
    createTreeWalker(root, _whatToShow, filter) {
      const found = [];
      const visit = (node) => {
        for (const child of node.children ?? []) {
          if (child.nodeType === 3) {
            const verdict = filter?.acceptNode?.(child) ?? 1;
            if (verdict === 1) found.push(child);
          } else {
            const verdict = filter?.acceptNode?.(child) ?? 1;
            if (verdict !== 2) visit(child); // 2 = FILTER_REJECT
          }
        }
      };
      visit(root);

      let index = -1;
      return {
        get currentNode() {
          return found[index];
        },
        nextNode() {
          index += 1;
          return index < found.length ? found[index] : null;
        },
      };
    },
    addEventListener(type, handler) {
      if (!document.listeners.has(type)) document.listeners.set(type, []);
      document.listeners.get(type).push(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of document.listeners.get(type) ?? []) handler(event);
    },
    hasListener: (type) => (document.listeners.get(type) ?? []).length > 0,
    body: null,
  };

  const body = document.createElement('body');
  document.body = body;

  for (const id of ['bubble', 'transcript', 'reply', 'attachments', 'field', 'send', 'play', 'close', 'grip', 'timer', 'sentNote', 'label']) {
    const el = document.createElement('div');
    el.ownerDocument = document;
    if (seeded.has(id)) el.className = seeded.get(id);
    byId.set(id, el);
    body.append(el);
  }

  return { document, byId, search };
}

export { Element, TextNode, Fragment };

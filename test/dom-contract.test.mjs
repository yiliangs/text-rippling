import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

function makeStyle() {
  return new Proxy({}, {
    get(target, property) {
      return Object.hasOwn(target, property) ? target[property] : '';
    },
  });
}

function decodeHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, '\u00a0')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
  }
}

class FakeText extends FakeNode {
  constructor(value) {
    super(3);
    this.data = String(value);
  }

  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
  get outerHTML() { return escapeHtml(this.data); }
}

class FakeContainer extends FakeNode {
  constructor(nodeType) {
    super(nodeType);
    this.childNodes = [];
  }

  appendChild(node) {
    if (node.nodeType === 11) {
      while (node.childNodes.length > 0) this.appendChild(node.childNodes.shift());
      return node;
    }
    if (node.parentNode) {
      const index = node.parentNode.childNodes.indexOf(node);
      if (index >= 0) node.parentNode.childNodes.splice(index, 1);
    }
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(''); }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (value !== '') this.appendChild(new FakeText(value));
  }
}

class FakeFragment extends FakeContainer {
  constructor() { super(11); }
}

class FakeElement extends FakeContainer {
  constructor(tagName) {
    super(1);
    this.tagName = tagName.toUpperCase();
    this.className = '';
    this.id = '';
    this.dataset = {};
    this.style = makeStyle();
    this._rawInnerHTML = null;
    this._rawText = null;
    this._rect = { left: 0, top: 0, width: 10, height: 20 };
  }

  setFixtureHtml(html, text = decodeHtml(html)) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this._rawInnerHTML = String(html);
    this._rawText = String(text);
  }

  appendChild(node) {
    this._rawInnerHTML = null;
    this._rawText = null;
    return super.appendChild(node);
  }

  get textContent() {
    return this._rawInnerHTML === null ? super.textContent : this._rawText;
  }

  set textContent(value) {
    this._rawInnerHTML = null;
    this._rawText = null;
    super.textContent = String(value);
  }

  get innerHTML() {
    if (this._rawInnerHTML !== null) return this._rawInnerHTML;
    return this.childNodes.map((node) => node.outerHTML).join('');
  }

  set innerHTML(value) { this.setFixtureHtml(String(value)); }

  get outerHTML() {
    const classAttribute = this.className ? ` class="${this.className}"` : '';
    return `<${this.tagName.toLowerCase()}${classAttribute}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }

  getBoundingClientRect() { return { ...this._rect }; }

  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
}

class FakeDocument {
  constructor() {
    this.fonts = null;
    this.reset();
  }

  reset() { this.roots = []; }
  createElement(tagName) { return new FakeElement(tagName); }
  createTextNode(value) { return new FakeText(value); }
  createDocumentFragment() { return new FakeFragment(); }
  register(...elements) { this.roots.push(...elements); }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      if (node.nodeType === 1 && node.matches(selector)) matches.push(node);
      if (node.childNodes) node.childNodes.forEach(visit);
    };
    this.roots.forEach(visit);
    return matches;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeResizeObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnected = false;
    FakeResizeObserver.instances.push(this);
  }

  observe(element) { this.observed.push(element); }
  disconnect() { this.disconnected = true; }
}

const document = new FakeDocument();
const animationFrames = new Map();
const window = {
  document,
  pageXOffset: 0,
  pageYOffset: 0,
  scrollX: 0,
  scrollY: 0,
  addEventListener() {},
};
let nextAnimationFrame = 1;

globalThis.document = document;
globalThis.window = window;
globalThis.ResizeObserver = FakeResizeObserver;
globalThis.getComputedStyle = () => ({ color: 'rgb(10, 20, 30)' });
globalThis.requestAnimationFrame = (callback) => {
  const id = nextAnimationFrame++;
  animationFrames.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => animationFrames.delete(id);

const require = createRequire(import.meta.url);
const TextRippling = require('../src/text-rippling.js');

function host(html, text) {
  const element = document.createElement('div');
  element.setFixtureHtml(html, text);
  document.register(element);
  return element;
}

function resetFixture() {
  document.reset();
  TextRippling.cursor.state.x = -1e6;
  TextRippling.cursor.state.y = -1e6;
  TextRippling.cursor.state.vx = 0;
  TextRippling.cursor.state.vy = 0;
  TextRippling.cursor.state.stamps.length = 0;
}

test.beforeEach(resetFixture);

test('splits collapsed whitespace and Unicode code points into the nested slot contract', () => {
  const element = host('ignored fixture markup', '\n  A\t𝌆  e\u0301 😀\r\nB  ');
  const rippling = new TextRippling(element, { effect: 'none', revealMode: 'none' });

  try {
    assert.equal(element.textContent, 'A 𝌆 e\u0301 😀 B');
    assert.deepEqual(rippling._chars.map((char) => char.originalChar), [
      'A', '𝌆', 'e', '\u0301', '😀', 'B',
    ]);
    assert.equal(element.childNodes.length, 9);
    assert.deepEqual(
      element.childNodes.filter((node) => node.nodeType === 3).map((node) => node.textContent),
      [' ', ' ', ' ', ' '],
    );

    const accentedWord = element.children[2];
    assert.equal(accentedWord.children.length, 2);
    assert.equal(rippling._chars[2].wordState, rippling._chars[3].wordState);
    assert.deepEqual([rippling._chars[2].indexInWord, rippling._chars[3].indexInWord], [0, 1]);

    const slot = rippling._chars[0];
    assert.equal(slot.el.parentNode.className, 'tr-char-word');
    assert.deepEqual(
      [slot.el.parentNode.style.display, slot.el.parentNode.style.whiteSpace],
      ['inline-block', 'nowrap'],
    );
    assert.equal(slot.el.className, 'tr-char');
    assert.deepEqual(
      [slot.el.style.display, slot.el.style.position, slot.el.style.willChange],
      ['inline-block', 'relative', 'transform'],
    );
    assert.equal(slot.el.children.length, 2);
    assert.equal(slot.textEl.className, 'tr-char-text');
    assert.equal(slot.textEl.textContent, 'A');
    assert.equal(slot.coverEl.className, 'tr-char-cover');
    assert.deepEqual(
      [
        slot.coverEl.style.position,
        slot.coverEl.style.left,
        slot.coverEl.style.top,
        slot.coverEl.style.right,
        slot.coverEl.style.bottom,
        slot.coverEl.style.background,
        slot.coverEl.style.display,
        slot.coverEl.style.pointerEvents,
      ],
      ['absolute', '0', '0', '0', '0', 'currentColor', 'none', 'none'],
    );
  } finally {
    rippling.destroy();
  }
});

test('custom className and splitWords:false keep one wrapper and make spaces char slots', () => {
  const element = host(' alpha \n beta ');
  const rippling = new TextRippling(element, {
    className: 'fx',
    effect: 'none',
    revealMode: 'none',
    splitWords: false,
  });

  try {
    assert.equal(element.children.length, 1);
    assert.equal(element.children[0].className, 'fx-word');
    assert.equal(rippling._chars.length, 10);
    assert.equal(rippling._chars[5].originalChar, ' ');
    assert.equal(rippling._chars[5].textEl.textContent, ' ');
    assert.equal(rippling._chars[5].el.className, 'fx');
    assert.equal(rippling._chars[5].textEl.className, 'fx-text');
    assert.equal(rippling._chars[5].coverEl.className, 'fx-cover');
    assert.ok(rippling._chars.every((char) => char.wordState === rippling._chars[0].wordState));
  } finally {
    rippling.destroy();
  }
});

test('destroy restores the exact original innerHTML and disconnects observation', () => {
  const original = '  <strong data-x="1">A&nbsp;𝌆</strong><!--keep-->\n';
  const element = host(original, '  A\u00a0𝌆\n');
  const rippling = new TextRippling(element, { effect: 'none', revealMode: 'none' });
  const observer = rippling._ro;

  assert.notEqual(element.innerHTML, original);
  assert.deepEqual(observer.observed, [element]);

  rippling.destroy();

  assert.equal(element.innerHTML, original);
  assert.deepEqual(rippling._chars, []);
  assert.equal(observer.disconnected, true);
  assert.equal(rippling._ro, null);
});

test('rippleAll preserves query order and returns one instance per match', () => {
  const first = host('one');
  const skipped = host('skip');
  const second = host('two');
  const third = host('three');
  first.className = 'ripple';
  skipped.className = 'other';
  second.className = 'ripple extra';
  third.className = 'ripple';

  const instances = TextRippling.rippleAll('.ripple', {
    effect: 'none',
    revealMode: 'none',
  });

  try {
    assert.equal(instances.length, 3);
    assert.deepEqual(instances.map((instance) => instance.element), [first, second, third]);
    assert.ok(instances.every((instance) => instance instanceof TextRippling));
  } finally {
    instances.forEach((instance) => instance.destroy());
  }
});

test('update masks immediately on burn entry and restores natural glyphs on the first exit tick', () => {
  const element = host('AB');
  const rippling = new TextRippling(element, {
    effect: 'none',
    glyphPool: 'X',
    revealMode: 'none',
    remeasureOn: 'manual',
  });

  try {
    rippling.update({ revealMode: 'burn' });
    assert.deepEqual(rippling._chars.map((char) => char.textEl.textContent), ['X', 'X']);
    assert.ok(rippling._chars.every((char) => char.maskGlyph === 'X' && char.revealed === false));

    rippling._chars[0].burnHeat = 0.7;
    rippling._chars[0].burnedAt = 25;
    rippling.update({ revealMode: 'none' });
    assert.deepEqual(rippling._chars.map((char) => char.textEl.textContent), ['X', 'X']);
    assert.ok(rippling._chars.every((char) => (
      char.burnHeat === 0 && char.burnedAt === 0 && char.revealed === false
    )));

    rippling._tick(30, 0);
    assert.deepEqual(rippling._chars.map((char) => char.textEl.textContent), ['A', 'B']);
  } finally {
    rippling.destroy();
  }
});

test('redact color updates immediately and effect-exit cleanup renders on the next tick', () => {
  const element = host('AB');
  const rippling = new TextRippling(element, {
    effect: 'redact',
    redactColor: '#112233',
    redactRadius: 100,
    revealMode: 'none',
    remeasureOn: 'manual',
  });

  try {
    assert.ok(rippling._chars.every((char) => char.coverEl.style.background === '#112233'));
    TextRippling.cursor.state.x = rippling._chars[0].hx;
    TextRippling.cursor.state.y = rippling._chars[0].hy;
    rippling._tick(10, 0);
    assert.ok(rippling._chars.every((char) => char.redacted));
    assert.ok(rippling._chars.every((char) => char.coverEl.style.display === 'block'));

    rippling.update({ redactColor: '#abcdef' });
    assert.ok(rippling._chars.every((char) => char.coverEl.style.background === '#abcdef'));
    rippling.update({ redactColor: '' });
    assert.ok(rippling._chars.every((char) => char.coverEl.style.background === 'currentColor'));

    rippling.update({ effect: 'none' });
    assert.ok(rippling._chars.every((char) => !char.redacted && char.redactZone === 0));
    assert.ok(rippling._chars.every((char) => char.coverEl.style.display === 'block'));

    rippling._tick(20, 0);
    assert.ok(rippling._chars.every((char) => char.coverEl.style.display === 'none'));
    assert.ok(rippling._chars.every((char) => char.coverShown === false));
  } finally {
    rippling.destroy();
  }
});

test('manual _tick crosses the effect, spring, transform, and color render seam', () => {
  const effect = () => ({
    tx: 10,
    ty: -4,
    rot: 0.25,
    scale: 1.5,
    brightness: 1,
  });
  effect.global = true;

  const element = host('Q');
  const rippling = new TextRippling(element, {
    damping: 1,
    effect,
    revealMode: 'none',
    remeasureOn: 'manual',
    spring: 1,
    wakeAttack: 1,
    wakeColor: '#abcdef',
  });

  try {
    rippling._tick(100, 16.67);
    const char = rippling._chars[0];
    assert.equal(
      char.el.style.transform,
      'translate(10.00px,-4.00px) rotate(0.2500rad) scale(1.500)',
    );
    assert.equal(char.el.style.color, 'rgb(171,205,239)');
    assert.equal(char.el.style.textShadow, '0 0 14.00px rgba(171,205,239,0.850)');
    assert.equal(char.textEl.textContent, 'Q');
    assert.deepEqual([char.tx, char.ty, char.rot, char.scale, char.bright], [10, -4, 0.25, 1.5, 1]);
  } finally {
    rippling.destroy();
  }
});

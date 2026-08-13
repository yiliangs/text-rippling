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
    const seedIndex = Object.keys(slot).indexOf('seed');
    assert.deepEqual(Object.keys(slot).slice(seedIndex, seedIndex + 4), [
      'seed', '_rippleStash', '_rippleStashFrame', 'revealChar',
    ]);
    assert.deepEqual([slot._rippleStash, slot._rippleStashFrame], [null, -1]);
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

test('burn mode round-trip preserves stale word reveal activation', () => {
  const rippling = new TextRippling(host('AB'), {
    effect: 'none',
    glyphPool: 'X',
    revealMode: 'cursor',
    revealRadius: 100,
    revealText: 'YZ',
    revealWordStepMs: 10,
    remeasureOn: 'manual',
  });

  try {
    const word = rippling._chars[0].wordState;
    TextRippling.cursor.state.x = rippling._chars[0].hx;
    TextRippling.cursor.state.y = rippling._chars[0].hy;
    rippling._tick(100, 0);
    rippling._tick(120, 0);
    assert.ok(rippling._chars.every((char) => char.revealed));
    assert.equal(word.active, true);
    const activatedAt = word.activatedAt;

    rippling.update({ revealMode: 'burn' });
    assert.ok(rippling._chars.every((char) => !char.revealed));
    assert.deepEqual([word.active, word.activatedAt], [true, activatedAt]);

    rippling.update({ revealMode: 'cursor' });
    assert.ok(rippling._chars.every((char) => !char.revealed));
    assert.deepEqual([word.active, word.activatedAt], [true, activatedAt]);

    TextRippling.cursor.state.x = -1e6;
    TextRippling.cursor.state.y = -1e6;
    rippling._tick(121, 0);
    assert.ok(rippling._chars.every((char) => char.revealed));
  } finally {
    rippling.destroy();
  }
});

test('revealText update during burn resets reveal state but retains heat', () => {
  const rippling = new TextRippling(host('AB'), {
    effect: 'none',
    glyphPool: 'X',
    revealMode: 'burn',
    remeasureOn: 'manual',
  });

  try {
    const char = rippling._chars[0];
    const word = char.wordState;
    TextRippling.wordReveal.resetScratch(word);
    TextRippling.wordReveal.touch(char, 0);
    TextRippling.wordReveal.tickWord(word, 40, Infinity, true);
    char.burnHeat = 0.65;
    char.burnedAt = 30;
    char.revealed = true;

    rippling.update({ revealText: 'YZ' });

    assert.deepEqual(
      [char.revealChar, char.revealed, char.burnHeat, char.burnedAt, char.textEl.textContent],
      ['Y', false, 0.65, 30, 'X'],
    );
    assert.deepEqual(
      [word.active, word.activatedAt, word.anchorIdx, word.lastTouchedAt],
      [false, 0, 0, 0],
    );
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

test('the facade keeps its surface and delegates _tick with the current options object', () => {
  const element = host('A');
  const rippling = new TextRippling(element, {
    effect: 'none',
    revealMode: 'none',
    remeasureOn: 'manual',
  });
  const calls = [];
  rippling._engine.tick = (...args) => calls.push(args);

  try {
    rippling._tick(123, 4.5);

    assert.equal(rippling.element, element);
    assert.ok(Array.isArray(rippling._chars));
    assert.equal(typeof rippling.update, 'function');
    assert.equal(typeof rippling.remeasure, 'function');
    assert.equal(typeof rippling.destroy, 'function');
    assert.deepEqual(rippling._engine._baseColorRgb, [10, 20, 30]);
    assert.deepEqual(calls, [[123, 4.5, rippling.options]]);
  } finally {
    rippling.destroy();
  }
});

test('update preserves accumulated spring time and monotonic frame epochs', () => {
  const frameIds = [];
  const effect = (dx, dy, dist, falloff, options, context) => {
    frameIds.push(context.frameId);
    return { tx: 5 };
  };
  effect.global = true;

  const rippling = new TextRippling(host('A'), {
    damping: 1,
    effect,
    revealMode: 'none',
    remeasureOn: 'manual',
    spring: 1,
  });

  try {
    rippling._tick(10, 10);
    assert.equal(rippling._chars[0].tx, 0);
    assert.equal(rippling._engine._springAccum, 10);
    assert.equal(rippling._engine._frameId, 1);

    rippling.update({ radius: 111 });
    assert.equal(rippling._engine._springAccum, 10);
    assert.equal(rippling._engine._frameId, 1);

    rippling._tick(20, 7);
    assert.equal(rippling._chars[0].tx, 5);
    assert.ok(Math.abs(rippling._engine._springAccum - 0.33) < 1e-12);
    assert.equal(rippling._engine._frameId, 2);
    assert.deepEqual(frameIds, [1, 2]);
  } finally {
    rippling.destroy();
  }
});

test('update invalidates every parsed color cache before the next frame', () => {
  const effect = () => ({ brightness: 1 });
  effect.global = true;
  const rippling = new TextRippling(host('A'), {
    burnEmberColor: '#010203',
    effect,
    revealColor: '#040506',
    revealMode: 'none',
    remeasureOn: 'manual',
    wakeAttack: 1,
    wakeColor: '#070809',
  });

  try {
    rippling._tick(10, 16.67);
    assert.deepEqual(rippling._engine._wakeCache.rgb, [7, 8, 9]);
    assert.deepEqual(rippling._engine._revealCache.rgb, [4, 5, 6]);
    assert.deepEqual(rippling._engine._emberCache.rgb, [1, 2, 3]);

    rippling.update({
      burnEmberColor: '#111213',
      revealColor: '#141516',
      wakeColor: '#171819',
    });
    assert.equal(rippling._engine._wakeCache, null);
    assert.equal(rippling._engine._revealCache, null);
    assert.equal(rippling._engine._emberCache, null);

    rippling._tick(20, 0);
    assert.deepEqual(rippling._engine._wakeCache.rgb, [23, 24, 25]);
    assert.deepEqual(rippling._engine._revealCache.rgb, [20, 21, 22]);
    assert.deepEqual(rippling._engine._emberCache.rgb, [17, 18, 19]);
    assert.equal(rippling._chars[0].el.style.color, 'rgb(23,24,25)');
  } finally {
    rippling.destroy();
  }
});

test('effect, falloff, and glyph registries are resolved again on every tick', () => {
  const registryKey = '__frame_engine_mutable_registry_test__';
  const calls = [];
  const installStrategies = (label, glyph) => {
    TextRippling.effects[registryKey] = () => {
      calls.push(`effect:${label}`);
      return { scramble: 1 };
    };
    TextRippling.falloffs[registryKey] = () => {
      calls.push(`falloff:${label}`);
      return 1;
    };
    TextRippling.glyphPickers[registryKey] = () => {
      calls.push(`picker:${label}`);
      return glyph;
    };
  };

  installStrategies('first', 'X');
  const rippling = new TextRippling(host('A'), {
    effect: registryKey,
    falloff: registryKey,
    radius: 100,
    revealMode: 'none',
    remeasureOn: 'manual',
    swapInterval: 0,
    swapMode: registryKey,
  });
  TextRippling.cursor.state.x = rippling._chars[0].hx;
  TextRippling.cursor.state.y = rippling._chars[0].hy;

  try {
    rippling._tick(10, 0);
    installStrategies('second', 'Y');
    rippling._tick(20, 0);

    assert.deepEqual(calls, [
      'falloff:first', 'effect:first', 'picker:first',
      'falloff:second', 'effect:second', 'picker:second',
    ]);
    assert.equal(rippling._chars[0].textEl.textContent, 'Y');
  } finally {
    delete TextRippling.effects[registryKey];
    delete TextRippling.falloffs[registryKey];
    delete TextRippling.glyphPickers[registryKey];
    rippling.destroy();
  }
});

test('reassigning options remains compatible with update and frame execution', () => {
  const seenOptions = [];
  const effect = (dx, dy, dist, falloff, options) => {
    seenOptions.push(options);
    return {};
  };
  effect.global = true;
  const rippling = new TextRippling(host('A'), {
    effect: 'none',
    revealMode: 'none',
    remeasureOn: 'manual',
  });
  const initialOptions = rippling.options;
  const replacement = { ...initialOptions, effect, radius: 50 };

  try {
    rippling.options = replacement;
    rippling.update({ radius: 75, wakeColor: '#abcdef' });
    rippling._tick(10, 0);

    assert.equal(rippling.options, replacement);
    assert.equal(replacement.radius, 75);
    assert.equal(replacement.wakeColor, '#abcdef');
    assert.equal(initialOptions.radius, 160);
    assert.deepEqual(seenOptions, [replacement]);
  } finally {
    rippling.destroy();
  }
});

test('feature lifecycle calls replaceable public hooks in exact order', () => {
  const hookSpecs = [
    ['reveal', TextRippling.revealLayer, ['initChar', 'attach', 'onUpdate']],
    ['burn', TextRippling.burnReveal, ['initChar', 'attach', 'onUpdate']],
    ['redact', TextRippling.redact, ['initChar', 'onUpdate']],
  ];
  const originals = [];
  const calls = [];
  let burnRippling = null;
  let plainRippling = null;

  try {
    for (const [name, module, hooks] of hookSpecs) {
      for (const hook of hooks) {
        const original = module[hook];
        originals.push([module, hook, original]);
        module[hook] = (...args) => {
          calls.push({ label: `${name}.${hook}`, args });
          if (name === 'reveal' && hook === 'onUpdate') {
            assert.ok(args[2].every((char) => !char.colorPinned && !char.wasLit));
          }
          return original(...args);
        };
      }
    }

    const burnElement = host('A');
    burnRippling = new TextRippling(burnElement, {
      effect: 'none',
      glyphPool: 'X',
      revealMode: 'burn',
      remeasureOn: 'manual',
    });
    assert.deepEqual(calls.map((call) => call.label), [
      'reveal.initChar', 'burn.initChar', 'redact.initChar',
      'reveal.attach', 'burn.attach',
    ]);
    assert.ok(calls.slice(0, 3).every((call) => (
      call.args.length === 1 && call.args[0] === burnRippling._chars[0]
    )));
    assert.deepEqual(calls[3].args, [burnRippling._chars, burnRippling.options, burnElement]);
    assert.deepEqual(calls[4].args, [burnRippling._chars, burnRippling.options]);

    calls.length = 0;
    burnRippling._chars[0].colorPinned = true;
    burnRippling._chars[0].wasLit = true;
    burnRippling.update({ revealMode: 'cursor' });
    assert.deepEqual(calls.map((call) => call.label), [
      'reveal.onUpdate', 'burn.onUpdate', 'redact.onUpdate',
    ]);
    assert.equal(calls[0].args.length, 4);
    assert.deepEqual(calls[0].args.slice(1), [
      burnRippling.options, burnRippling._chars, burnElement,
    ]);
    assert.deepEqual(calls[1].args.slice(1), [burnRippling.options, burnRippling._chars]);
    assert.deepEqual(calls[2].args.slice(1), [burnRippling.options, burnRippling._chars]);
    assert.equal(calls[0].args[0].revealMode, 'burn');

    calls.length = 0;
    const plainElement = host('B');
    plainRippling = new TextRippling(plainElement, {
      effect: 'none',
      revealMode: 'none',
      remeasureOn: 'manual',
    });
    assert.deepEqual(calls.map((call) => call.label), [
      'reveal.initChar', 'burn.initChar', 'redact.initChar', 'reveal.attach',
    ]);

    const engine = plainRippling._engine;
    const originalChars = plainRippling._chars;
    plainRippling.destroy();
    assert.deepEqual(plainRippling._chars, []);
    assert.deepEqual(engine._chars, []);
    assert.notEqual(engine._chars, originalChars);
    assert.equal(engine._element, null);
    assert.doesNotThrow(() => plainRippling._tick(20, 0));
  } finally {
    for (const [module, hook, original] of originals) module[hook] = original;
    if (burnRippling && !burnRippling._destroyed) burnRippling.destroy();
    if (plainRippling && !plainRippling._destroyed) plainRippling.destroy();
  }
});

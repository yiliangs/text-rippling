import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const demoSource = await readFile(new URL('../demo.js', import.meta.url), 'utf8');
const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');

const CONTROL_IDS = ['effect', 'falloff', 'radius', 'strength', 'spring', 'damping'];

class FakeOutput {
  #textContent = '';

  get textContent() { return this.#textContent; }
  set textContent(value) { this.#textContent = String(value); }
}

function runDemo() {
  const playground = {
    dataset: {
      effect: 'wave',
      radius: '12.5',
      strength: '9',
      falloff: 'linear',
      revealMode: 'bloom-ripple',
      revealColor: '#abcdef',
      revealRadius: '41.5',
      revealFringe: '0',
      revealHoldMs: '250',
      redactRadius: '81',
      redactFringe: '121',
      redactTurnoverMs: '90',
      redactTurnoverFrac: '0.25',
      redactColor: '#123456',
      burnRadius: '52',
      burnRate: '0.01',
      burnSmolderRate: '0.002',
      burnSmolderReach: '3.5',
      burnCoolMs: '400',
      burnEmberColor: '#fedcba',
      burnTwinkleMs: '75',
    },
  };
  const fallbackElement = {
    dataset: {
      effect: '',
      radius: '0',
      strength: '',
      falloff: '',
      revealMode: '',
      revealRadius: '',
    },
  };
  const elements = [playground, fallbackElement];
  const selectors = [];
  const lookups = [];
  const listenerRegistrations = [];
  const controls = new Map(CONTROL_IDS.map((id) => [id, {
    value: '',
    listeners: new Map(),
    addEventListener(type, listener) {
      listenerRegistrations.push(['ctrl-' + id, type]);
      this.listeners.set(type, listener);
    },
  }]));
  const outputs = new Map(CONTROL_IDS.map((id) => [id, new FakeOutput()]));
  const constructions = [];

  class TextRipplingSpy {
    constructor(element, options) {
      this.element = element;
      this.options = { ...options };
      this.updates = [];
      constructions.push(this);
    }

    update(options) {
      this.updates.push({ ...options });
    }
  }

  const document = {
    querySelectorAll(selector) {
      selectors.push(selector);
      return elements;
    },
    getElementById(id) {
      lookups.push(id);
      if (id === 'playground') return playground;
      if (id.startsWith('ctrl-')) return controls.get(id.slice(5));
      if (id.startsWith('out-')) return outputs.get(id.slice(4));
      return null;
    },
  };

  const context = vm.createContext({ document, TextRippling: TextRipplingSpy });
  vm.runInContext(demoSource, context, { filename: 'demo.js' });
  const lexicalState = vm.runInContext(
    '({ instances, pg, bind, instancesIsMap: instances instanceof Map })',
    context,
  );

  return {
    constructions,
    controls,
    elements,
    lexicalState,
    listenerRegistrations,
    lookups,
    outputs,
    selectors,
  };
}

test('demo bootstrap preserves data-option parsing and retained instance state', () => {
  const { constructions, elements, lexicalState, selectors } = runDemo();

  assert.deepEqual(selectors, ['[data-effect]']);
  assert.equal(constructions.length, 2);
  assert.deepEqual(constructions[0].options, {
    effect: 'wave',
    radius: 12.5,
    strength: 9,
    falloff: 'linear',
    revealMode: 'bloom-ripple',
    revealColor: '#abcdef',
    revealRadius: 41.5,
    revealFringe: 0,
    revealHoldMs: 250,
    redactRadius: 81,
    redactFringe: 121,
    redactTurnoverMs: 90,
    redactTurnoverFrac: 0.25,
    redactColor: '#123456',
    burnRadius: 52,
    burnRate: 0.01,
    burnSmolderRate: 0.002,
    burnSmolderReach: 3.5,
    burnCoolMs: 400,
    burnEmberColor: '#fedcba',
    burnTwinkleMs: 75,
  });
  assert.deepEqual(constructions[1].options, {
    effect: 'repel',
    radius: 160,
    strength: 30,
    falloff: 'gaussian',
  });

  assert.equal(lexicalState.instancesIsMap, true);
  assert.equal(lexicalState.instances.size, 2);
  assert.equal(lexicalState.instances.get(elements[0]), constructions[0]);
  assert.equal(lexicalState.instances.get(elements[1]), constructions[1]);
  assert.equal(lexicalState.pg, constructions[0]);
  assert.equal(typeof lexicalState.bind, 'function');
});

test('demo controls retain lookup order, listeners, coercion, and output formatting', () => {
  const {
    constructions,
    controls,
    listenerRegistrations,
    lookups,
    outputs,
  } = runDemo();

  assert.deepEqual(lookups, [
    'playground',
    'ctrl-effect', 'out-effect',
    'ctrl-falloff', 'out-falloff',
    'ctrl-radius', 'out-radius',
    'ctrl-strength', 'out-strength',
    'ctrl-spring', 'out-spring',
    'ctrl-damping', 'out-damping',
  ]);
  assert.deepEqual(listenerRegistrations, CONTROL_IDS.flatMap((id) => [
    ['ctrl-' + id, 'input'],
    ['ctrl-' + id, 'change'],
  ]));
  for (const control of controls.values()) {
    assert.equal(control.listeners.get('input'), control.listeners.get('change'));
  }

  const playgroundInstance = constructions[0];
  assert.deepEqual(playgroundInstance.updates, []);

  controls.get('effect').value = 'jelly';
  controls.get('effect').listeners.get('input')();
  controls.get('falloff').value = 'inverse';
  controls.get('falloff').listeners.get('change')();
  controls.get('radius').value = '12';
  controls.get('radius').listeners.get('input')();
  controls.get('strength').value = '';
  controls.get('strength').listeners.get('change')();
  controls.get('spring').value = '0.186';
  controls.get('spring').listeners.get('input')();
  controls.get('damping').value = '0.7';
  controls.get('damping').listeners.get('change')();

  assert.deepEqual(playgroundInstance.updates, [
    { effect: 'jelly' },
    { falloff: 'inverse' },
    { radius: 12 },
    { strength: 0 },
    { spring: 0.186 },
    { damping: 0.7 },
  ]);
  assert.equal(outputs.get('effect').textContent, 'jelly');
  assert.equal(outputs.get('falloff').textContent, 'inverse');
  assert.equal(outputs.get('radius').textContent, '12');
  assert.equal(outputs.get('strength').textContent, '0');
  assert.equal(outputs.get('spring').textContent, '0.19');
  assert.equal(outputs.get('damping').textContent, '0.70');
});

test('index loads only the library and external demo bootstrap, in order', () => {
  const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map(
    ([, attributes, body]) => ({
      body,
      src: attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1],
    }),
  );

  assert.deepEqual(scripts.map(({ src }) => src), [
    './src/text-rippling.js',
    './demo.js',
  ]);
  assert.ok(scripts.every(({ body }) => body.trim() === ''));
  assert.match(
    indexHtml,
    /<script src="\.\/src\/text-rippling\.js"><\/script>\s*<script src="\.\/demo\.js"><\/script>/,
  );
});

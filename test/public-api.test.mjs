import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const commonJs = require('..');
const esm = await import('../src/text-rippling.mjs');
const { PUBLIC_API } = await import('../source/public-api.js');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));

const COMMON_JS_KEYS = [
  'TextRippling',
  'bloomRipple',
  'burnReveal',
  'cursor',
  'effects',
  'falloffs',
  'glyphPickers',
  'redact',
  'revealLayer',
  'ripple',
  'rippleAll',
  'version',
  'waveReveal',
  'wordReveal',
];

const ESM_KEYS = [
  'TextRippling',
  'bloomRipple',
  'burnReveal',
  'default',
  'effects',
  'falloffs',
  'glyphPickers',
  'redact',
  'revealLayer',
  'ripple',
  'rippleAll',
  'version',
  'waveReveal',
  'wordReveal',
];

function closeTo(actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

function withRandom(values, operation) {
  const original = Math.random;
  let index = 0;
  Math.random = () => values[Math.min(index++, values.length - 1)];
  try {
    return operation();
  } finally {
    Math.random = original;
  }
}

function makeWord(length) {
  const chars = Array.from({ length }, (_, indexInWord) => ({
    indexInWord,
    revealed: false,
    wordState: null,
  }));
  const word = commonJs.wordReveal.makeWord(chars);
  for (const char of chars) char.wordState = word;
  return { chars, word };
}

test('CommonJS and ESM expose their exact public shapes', () => {
  assert.equal(typeof commonJs, 'function');
  assert.equal(commonJs.version, packageJson.version);
  assert.equal(commonJs, commonJs.TextRippling);
  assert.deepEqual(Object.keys(commonJs).sort(), COMMON_JS_KEYS.slice().sort());

  assert.deepEqual(Object.keys(esm).sort(), ESM_KEYS.slice().sort());
  assert.equal(esm.default, commonJs);
  assert.equal(esm.TextRippling, commonJs);
  assert.equal(Object.hasOwn(esm, 'cursor'), false);
  assert.equal(Object.hasOwn(commonJs, 'FeatureLifecycle'), false);
  assert.equal(Object.hasOwn(commonJs, 'featureLifecycle'), false);
  assert.equal(Object.hasOwn(esm, 'FeatureLifecycle'), false);
  assert.equal(Object.hasOwn(esm, 'featureLifecycle'), false);
  assert.equal(Object.hasOwn(PUBLIC_API, 'FeatureLifecycle'), false);
  assert.equal(Object.hasOwn(PUBLIC_API, 'featureLifecycle'), false);
  assert.equal(commonJs.cursor, commonJs.TextRippling.cursor);

  for (const key of ESM_KEYS) {
    if (key !== 'default' && key !== 'TextRippling') {
      assert.equal(esm[key], commonJs[key]);
    }
  }
});

test('loading installs the constructor globally and constructor validation is stable', () => {
  assert.equal(globalThis.TextRippling, commonJs);
  assert.equal(commonJs.version, '0.1.0');
  assert.throws(
    () => new commonJs(null),
    { message: 'TextRippling: element not found' },
  );
});

test('public strategy registries keep their exact keys', () => {
  assert.deepEqual(Object.keys(commonJs.effects).sort(), [
    'attract', 'glow', 'jelly', 'magnify', 'none', 'redact',
    'repel', 'ripple', 'scatter', 'swirl', 'wake', 'wave',
  ]);
  assert.deepEqual(Object.keys(commonJs.falloffs).sort(), [
    'gaussian', 'inverse', 'linear', 'smooth',
  ]);
  assert.deepEqual(Object.keys(commonJs.glyphPickers).sort(), [
    'caseFlip', 'pool',
  ]);
  assert.equal(commonJs.effects.ripple.global, true);
});

test('falloff curves retain their numeric behavior', () => {
  const { gaussian, inverse, linear, smooth } = commonJs.falloffs;

  for (const falloff of [gaussian, inverse, linear, smooth]) {
    assert.equal(falloff(0, 10), 1);
  }

  closeTo(gaussian(5, 10), Math.exp(-0.625));
  closeTo(inverse(5, 10), 0.5);
  assert.equal(linear(5, 10), 0.5);
  assert.equal(smooth(5, 10), 0.5);

  closeTo(gaussian(10, 10), Math.exp(-2.5));
  assert.equal(inverse(10, 10), 0.2);
  assert.equal(linear(10, 10), 0);
  assert.equal(smooth(10, 10), 0);
  assert.equal(linear(20, 10), 0);
  assert.equal(smooth(20, 10), 0);
});

test('effects retain direction, scale, brightness, and deterministic scatter math', () => {
  const effects = commonJs.effects;
  const options = { strength: 10 };

  assert.deepEqual(effects.none(), {
    tx: 0,
    ty: 0,
    rot: 0,
    scale: 1,
    brightness: 0,
    scramble: 0,
    interior: false,
  });
  assert.equal(Object.isFrozen(effects.none()), true);
  assert.equal(effects.redact(), effects.none());
  assert.deepEqual(effects.repel(3, 4, 5, 0.5, options), { tx: 3, ty: 4 });
  assert.deepEqual(effects.attract(3, 4, 5, 0.5, options), { tx: -3, ty: -4 });
  const jelly = effects.jelly(3, 4, 5, 0.5, options);
  assert.equal(jelly.tx, 3);
  assert.equal(jelly.ty, 4);
  closeTo(jelly.rot, 0.0225);
  assert.equal(jelly.scale, 1.3);
  assert.deepEqual(effects.magnify(3, 4, 5, 0.5, options), {
    ty: -2,
    scale: 1.45,
  });
  assert.deepEqual(effects.swirl(3, 4, 5, 0.5, options), { tx: -4, ty: 3 });
  assert.deepEqual(effects.wake(3, 4, 5, 0.5), { brightness: 0.5, scramble: 0.5 });
  assert.deepEqual(effects.glow(3, 4, 5, 0.5), { brightness: 0.5 });

  const scatter = effects.scatter(0, 0, 0, 0.5, options, { charSeed: 0.25 });
  closeTo(scatter.tx, 0);
  closeTo(scatter.ty, 5);
  closeTo(scatter.rot, 0.075);

  const wave = effects.wave(0, 0, 0, 0.5, options, {
    charX: 10,
    mouseX: 0,
    time: 0,
  });
  closeTo(wave.ty, Math.sin(0.2) * 5);
});

test('Ripple preserves the leading-frontier and passed-wake boundaries', () => {
  const ripple = commonJs.ripple;
  assert.deepEqual(ripple.DEFAULTS, {
    speed: 0.55,
    spatial: 180,
    postHit: 380,
    edge: 22,
  });
  assert.equal(ripple.compute(0, 0, 0, [], 1, 100, 100, 10), null);

  const stamp = [{ x: 0, y: 0, t0: 0 }];
  const amplitudeAtHit = Math.exp(-0.2);

  assert.deepEqual(ripple.compute(20, 0, 10, stamp, 1, 100, 100, 10), {
    brightness: 0,
    scramble: 0,
    interior: false,
  });

  const approaching = ripple.compute(20, 0, 11, stamp, 1, 100, 100, 10);
  assert.equal(approaching.brightness, 0);
  closeTo(approaching.scramble, amplitudeAtHit * 0.1);
  assert.equal(approaching.interior, false);

  const frontier = ripple.compute(20, 0, 20, stamp, 1, 100, 100, 10);
  closeTo(frontier.brightness, amplitudeAtHit);
  closeTo(frontier.scramble, amplitudeAtHit);
  assert.equal(frontier.interior, false);

  const passed = ripple.compute(20, 0, 30, stamp, 1, 100, 100, 10);
  closeTo(passed.brightness, amplitudeAtHit * Math.exp(-0.1));
  assert.equal(passed.scramble, 0);
  assert.equal(passed.interior, true);

  const mixed = ripple.compute(20, 0, 20, [
    stamp[0],
    { x: 20, y: 0, t0: 0 },
  ], 1, 100, 100, 10);
  assert.equal(mixed.interior, true);
  assert.equal(mixed.scramble, 0);
});

test('WordReveal blooms, collapses, and reactivates without clearing latched chars', () => {
  const reveal = commonJs.wordReveal;
  const { chars, word } = makeWord(5);
  const render = (now) => {
    for (const char of chars) reveal.applyChar(char, now, 10);
    return chars.map((char) => char.revealed);
  };

  reveal.resetScratch(word);
  reveal.touch(chars[2], 4);
  reveal.touch(chars[4], 1);
  reveal.tickWord(word, 100, 50, false);
  assert.equal(word.active, true);
  assert.equal(word.anchorIdx, 4);
  assert.equal(word.maxDistFromAnchor, 4);
  assert.deepEqual(render(100), [false, false, false, false, true]);
  assert.deepEqual(render(130), [false, true, true, true, true]);
  assert.deepEqual(render(140), [true, true, true, true, true]);

  reveal.resetScratch(word);
  reveal.tickWord(word, 149, 50, false);
  assert.equal(word.active, true);
  reveal.tickWord(word, 150, 50, false);
  assert.equal(word.active, false);
  assert.equal(word.collapseAt, 150);
  assert.deepEqual(render(150), [false, true, true, true, true]);
  assert.deepEqual(render(160), [false, false, true, true, true]);

  reveal.resetScratch(word);
  reveal.touch(chars[0], 0);
  reveal.tickWord(word, 165, 50, false);
  assert.equal(word.anchorIdx, 0);
  assert.equal(word.collapseAt, 0);
  assert.deepEqual(render(165), [true, false, true, true, true]);
  assert.deepEqual(render(175), [true, true, true, true, true]);

  reveal.resetWord(word);
  assert.deepEqual(
    [word.active, word.activatedAt, word.anchorIdx, word.collapseAt, word.lastTouchedAt, word.maxDistFromAnchor],
    [false, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(render(200), [false, false, false, false, false]);
});

test('glyph pickers preserve random interval boundaries', () => {
  const pickers = commonJs.glyphPickers;
  const options = { glyphPool: 'abc', swapSymbols: '!?' };

  assert.equal(withRandom([0], () => pickers.pool('X', options)), 'a');
  assert.equal(withRandom([1 - Number.EPSILON], () => pickers.pool('X', options)), 'c');
  assert.equal(pickers.pool('X', { glyphPool: '' }), null);

  assert.equal(withRandom([0.08], () => pickers.caseFlip('A', options)), 'a');
  assert.equal(withRandom([0.08], () => pickers.caseFlip('a', options)), 'A');
  assert.equal(withRandom([0.079, 1 - Number.EPSILON], () => pickers.caseFlip('A', options)), '?');
  assert.equal(withRandom([0.08, 0], () => pickers.caseFlip('1', options)), '!');
  assert.equal(withRandom([0.5], () => pickers.caseFlip('1', { swapSymbols: '' })), null);
});

test('Redact turnover changes membership while preserving in-band density', () => {
  const chars = Array.from({ length: 10 }, (_, index) => ({
    redactZone: 2,
    redacted: index < 6,
  }));
  const core = { redactZone: 1, redacted: true };
  const outside = { redactZone: 0, redacted: false };
  chars.push(core, outside);

  const before = chars.slice(0, 10).filter((char) => char.redacted).length;
  withRandom([0], () => {
    commonJs.redact.turnover(chars, { redactTurnoverFrac: 0.5 });
  });
  const after = chars.slice(0, 10).filter((char) => char.redacted).length;

  assert.equal(before, 6);
  assert.equal(after, before);
  assert.deepEqual(chars.slice(0, 10).map((char) => char.redacted), [
    false, false, false, true, true, true, true, true, true, false,
  ]);
  assert.equal(core.redacted, true);
  assert.equal(outside.redacted, false);
});

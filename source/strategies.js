import { REST } from './constants.js';
import { RippleSampler } from './ripple-sampler.js';

// ════════════════════════════════════════════════════════════════════
//  Falloffs — distance-to-radius weighting curves, range [0..1].
//  Effects use these to scale their output by cursor proximity.
// ════════════════════════════════════════════════════════════════════

const Falloffs = {
  gaussian: (d, r) => Math.exp(-((d / r) * (d / r)) * 2.5),
  linear:   (d, r) => Math.max(0, 1 - d / r),
  inverse:  (d, r) => 1 / (1 + (d / r) * (d / r) * 4),
  smooth:   (d, r) => {
    const t = Math.max(0, 1 - d / r);
    return t * t * (3 - 2 * t);
  },
};

// ════════════════════════════════════════════════════════════════════
//  Effects — pure (dx, dy, dist, f, opts, ctx) → targetState.
//
//  Sign convention: dx,dy = (charCenter − mouse). Positive dx means
//  char is to the right of cursor, so REPEL pushes it further right.
//
//  Target schema (all fields optional, defaults are the rest state):
//    { tx, ty, rot, scale, brightness, scramble }
//
//  Effects with `.global = true` are called every frame regardless of
//  cursor proximity — they read state from ctx (e.g. ctx.stamps).
// ════════════════════════════════════════════════════════════════════

const Effects = {
  // No motion / brightness / scramble. Useful when an instance only
  // wants the RevealLayer feature (or any other independent module
  // that doesn't depend on per-char effect output).
  none() { return REST; },

  // Pure displacement: chars pushed away from the cursor.
  repel(dx, dy, dist, f, p) {
    const k = (f * p.strength) / Math.max(dist, 1e-4);
    return { tx: dx * k, ty: dy * k };
  },

  // Inverse of repel: chars pulled toward the cursor.
  attract(dx, dy, dist, f, p) {
    const k = (f * p.strength) / Math.max(dist, 1e-4);
    return { tx: -dx * k, ty: -dy * k };
  },

  // Repel + scale + tilt — feels like soft jelly being pushed.
  jelly(dx, dy, dist, f, p) {
    const k = (f * p.strength) / Math.max(dist, 1e-4);
    return { tx: dx * k, ty: dy * k, rot: dx * f * 0.0015 * p.strength, scale: 1 + f * 0.6 };
  },

  // Vertical sine wave; cursor X drives phase, falloff modulates amplitude.
  wave(dx, dy, dist, f, p, ctx) {
    const phase = (ctx.charX - ctx.mouseX) * 0.02 + ctx.time * 0.004;
    return { ty: Math.sin(phase) * f * p.strength };
  },

  // Chars under the cursor swell up — distance only scales, no displacement.
  magnify(dx, dy, dist, f, p) {
    return { ty: -f * p.strength * 0.4, scale: 1 + f * 0.9 };
  },

  // Each char has a private direction; cursor controls intensity.
  scatter(dx, dy, dist, f, p, ctx) {
    const a = ctx.charSeed * Math.PI * 2;
    const r = f * p.strength;
    return { tx: Math.cos(a) * r, ty: Math.sin(a) * r, rot: ctx.charSeed * f * 0.6 };
  },

  // Tangential push — letters orbit around the cursor (90° CCW rotation of dx,dy).
  swirl(dx, dy, dist, f, p) {
    const k = (f * p.strength) / Math.max(dist, 1e-4);
    return { tx: -dy * k, ty: dx * k };
  },

  // Rudimentary "matrix" wake: bright + glyph swap proportional to falloff.
  // Kept for flavor; the physically-grounded effect is `ripple` below.
  wake(dx, dy, dist, f) {
    return { brightness: f, scramble: f };
  },

  // Brightness-only wake — glow trail without the glyph swap.
  glow(dx, dy, dist, f) {
    return { brightness: f };
  },

  // Top-level stochastic-density redaction. The glyph swap and
  // morphing turnover live in the `Redact` module above; this slot
  // is a routing flag — _tick checks `opts.effect === 'redact'` and
  // dispatches to Redact directly. Returns REST so no transform/
  // brightness/scramble target is produced.
  redact() { return REST; },

  // ── ripple — Effects-registry adapter onto the Ripple subsystem ───
  //
  // The physics lives in the `Ripple` module above; this slot exists so
  // the registry can dispatch on `effect: 'ripple'`. Marked .global below
  // so _tick calls it for every char regardless of cursor proximity —
  // the wake reaches across the whole page, not just the falloff radius.
  // Ignores dx/dy/f because wake amplitude is determined by stamp history,
  // not by the current cursor distance.
  //
  // Memo: when wave / bloom-ripple modes are active, wordWaveFrame
  // already computed Ripple for this char this frame and stashed it on
  // c._rippleStash. Reuse it to avoid a second O(stamps) loop. Frame
  // mismatch → stash is from a previous frame (or never populated, e.g.
  // cursor mode) → recompute as before.
  ripple(dx, dy, dist, f, p, ctx) {
    return RippleSampler.sampleForEffect(ctx, p) || REST;
  },
};

Effects.ripple.global = true;

// ════════════════════════════════════════════════════════════════════
//  GlyphPickers — strategies for choosing the substituted glyph.
// ════════════════════════════════════════════════════════════════════

function pickSymbol(opts) {
  const s = opts.swapSymbols;
  if (!s || s.length === 0) return null;
  return s.charAt((Math.random() * s.length) | 0);
}

const GlyphPickers = {
  // Uniform random pick from `glyphPool`. Matrix-style chaos.
  pool(originalChar, opts) {
    const pool = opts.glyphPool;
    if (!pool || pool.length === 0) return null;
    return pool.charAt((Math.random() * pool.length) | 0);
  },

  // Mostly toggle letter case (A↔a); ~8% of the time draw a symbol
  // from `swapSymbols`. Non-letters always draw a symbol. Closer to the
  // Pudgy Penguins reference effect — feels typographic, not glitchy.
  caseFlip(originalChar, opts) {
    if (Math.random() < 0.08) return pickSymbol(opts);
    const lower = originalChar.toLowerCase();
    const upper = originalChar.toUpperCase();
    if (lower !== upper) return originalChar === upper ? lower : upper;
    return pickSymbol(opts);
  },
};


export { Effects, Falloffs, GlyphPickers };

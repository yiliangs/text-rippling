import { CursorField } from './browser-runtime.js';
import { Color } from './color.js';
import { REF_DT_MS, REST } from './constants.js';
import { FeatureLifecycle } from './feature-lifecycle.js';
import { BurnReveal } from './features/burn-reveal.js';
import { Redact } from './features/redact.js';
import { BloomRipple, RevealLayer, WaveReveal } from './features/reveal.js';
import { Char, Renderer, writeLitColor } from './glyph-runtime.js';
import { Effects, Falloffs, GlyphPickers } from './strategies.js';

// The frame engine owns the state and policy of one animation pipeline.
// TextRippling remains the public DOM/lifecycle facade and passes its current
// options object into every call so replacing instance.options keeps working.
class FrameEngine {
  constructor(element, chars, options) {
    this._element = element;
    this._chars = chars;
    this._baseColorRgb = null;
    this._wakeCache = null;
    this._revealCache = null;
    this._emberCache = null;
    this._springAccum = 0;
    this._redactNextTurn = 0;
    this._frameId = 0;

    this._captureBaseColor();
    FeatureLifecycle.attach(chars, options, element);
  }

  update(options, patch) {
    // Snapshot previous values before mutating the facade's current options
    // object. In particular, this must not retain the constructor's object.
    const prev = Object.assign({}, options);
    Object.assign(options, patch);
    this._wakeCache = null;
    this._revealCache = null;
    this._emberCache = null;

    FeatureLifecycle.update(prev, options, this._chars, this._element);
  }

  tick(now, dt, options) {
    // Registries are public and mutable, so resolve every strategy each tick.
    const effect  = resolve(Effects,      options.effect,   Effects.repel);
    const falloff = resolve(Falloffs,     options.falloff,  Falloffs.gaussian);
    const picker  = resolve(GlyphPickers, options.swapMode, GlyphPickers.pool);

    if (!this._wakeCache) {
      const w = Color.parse(options.wakeColor);
      this._wakeCache = { rgb: w, str: `${w[0]},${w[1]},${w[2]}` };
    }
    // Lazy-parse revealColor only when set; otherwise reveal lerps toward
    // wakeColor too (brightness still differentiates the endpoints).
    if (!this._revealCache && options.revealColor) {
      const r = Color.parse(options.revealColor);
      this._revealCache = { rgb: r, str: `${r[0]},${r[1]},${r[2]}` };
    }
    if (!this._emberCache) {
      const e = Color.parse(options.burnEmberColor);
      this._emberCache = {
        rgb: e,
        str: `${e[0]},${e[1]},${e[2]}`,
        hot: [
          (e[0] + (255 - e[0]) * 0.45) | 0,
          (e[1] + (255 - e[1]) * 0.45) | 0,
          (e[2] + (255 - e[2]) * 0.45) | 0,
        ],
      };
    }
    const wakeRgb = this._wakeCache.rgb;
    const wakeStr = this._wakeCache.str;
    const baseRgb = this._baseColorRgb || [200, 200, 200];

    const ctx = makeContext(now, dt);
    ctx.frameId = ++this._frameId;
    const r = options.radius;
    const rCutoffSq = (r * 2) * (r * 2);
    const isGlobal = effect.global === true;

    this._springAccum += dt;
    let springSteps = 0;
    while (this._springAccum >= REF_DT_MS) {
      this._springAccum -= REF_DT_MS;
      springSteps++;
    }

    const isRedact = options.effect === 'redact';
    if (isRedact && now >= this._redactNextTurn) {
      Redact.turnover(this._chars, options);
      this._redactNextTurn = now + options.redactTurnoverMs;
    }

    const modeBundle = REVEAL_MODES[options.revealMode];
    if (modeBundle) modeBundle.frame(this._chars, ctx, options);
    const colorWriter = modeBundle ? modeBundle.colorWriter  : defaultColorWriter;
    const naturalOf   = modeBundle ? modeBundle.naturalGlyph : defaultNaturalGlyph;
    const scrambleOk  = modeBundle ? modeBundle.scrambleOk   : scrambleAlways;

    const colorCtx = {
      baseRgb,
      wakeRgb,
      wakeStr,
      revealRgb: this._revealCache ? this._revealCache.rgb : wakeRgb,
      revealStr: this._revealCache ? this._revealCache.str : wakeStr,
      emberRgb:    this._emberCache.rgb,
      emberStr:    this._emberCache.str,
      emberHotRgb: this._emberCache.hot,
      time: now,
      opts: options,
    };

    for (const c of this._chars) {
      const target = evalCharTarget(c, ctx, effect, falloff, options, isGlobal, rCutoffSq);

      Char.springStep(c, target.tx || 0, target.ty || 0, target.rot || 0,
                      typeof target.scale === 'number' ? target.scale : 1,
                      options.spring, options.damping, springSteps);
      Char.brightnessLerp(
        c,
        target.brightness || 0,
        options.wakeAttack,
        options.wakeDecay,
        dt,
      );

      if (isRedact) Redact.tick(c, ctx, options);

      const scrambleTarget = (c.redacted || !scrambleOk(c))
        ? 0
        : (target.scramble || 0);
      const naturalGlyph = naturalOf(c);

      // Render order is part of the frame contract.
      Renderer.transform(c);
      colorWriter(c, colorCtx);
      Renderer.glyph(c, scrambleTarget, now, options, picker, naturalGlyph);
      Renderer.cover(c);
    }
  }

  release() {
    this._chars = [];
    this._element = null;
  }

  _captureBaseColor() {
    if (this._chars.length === 0) return;
    const sample = this._chars[0].el;
    const prev = sample.style.color;
    sample.style.color = '';
    this._baseColorRgb = Color.parse(getComputedStyle(sample).color);
    sample.style.color = prev;
  }
}

function makeContext(now, dt) {
  const sx = window.scrollX || window.pageXOffset || 0;
  const sy = window.scrollY || window.pageYOffset || 0;
  return {
    mouseX:  CursorField.state.x + sx,
    mouseY:  CursorField.state.y + sy,
    mouseVx: CursorField.state.vx,
    mouseVy: CursorField.state.vy,
    time:    now,
    dt,
    stamps: CursorField.state.stamps,
    frameId: 0,
    charX: 0, charY: 0, charSeed: 0, char: null,
  };
}

function evalCharTarget(c, ctx, effect, falloff, options, isGlobal, rCutoffSq) {
  const dx = c.hx - ctx.mouseX;
  const dy = c.hy - ctx.mouseY;
  const d2 = dx * dx + dy * dy;

  if (!isGlobal && d2 >= rCutoffSq) return REST;

  const dist = Math.sqrt(d2);
  let f = 0;
  if (!isGlobal) {
    f = falloff(dist, options.radius);
    if (f < 0) f = 0; else if (f > 1) f = 1;
    if (f < 0.001) return REST;
  }

  ctx.charX = c.hx;
  ctx.charY = c.hy;
  ctx.charSeed = c.seed;
  ctx.char = c;
  return effect(dx, dy, dist, f, options, ctx) || REST;
}

function resolve(registry, name, fallback) {
  return typeof name === 'function' ? name : (registry[name] || fallback);
}

// Reveal mode policy belongs beside the frame dispatch that consumes it.
function defaultColorWriter(c, x) {
  const showLower = c.revealed && c.revealChar != null;
  const lerpRgb = showLower ? x.revealRgb : x.wakeRgb;
  const lerpStr = showLower ? x.revealStr : x.wakeStr;
  Renderer.colorAndGlow(c, x.baseRgb, lerpRgb, lerpStr);
}

function bloomColorWriter(c, x) {
  Renderer.colorAndGlowBloom(c, x.revealRgb, x.wakeRgb, x.wakeStr);
}

function burnColorWriter(c, x) {
  if (!c.revealed) {
    if (c.burnHeat > 0.01) {
      writeLitColor(c.el, c.burnHeat, x.baseRgb, x.emberRgb, x.emberStr);
      c.wasLit = true;
      c.colorPinned = true;
    } else if (c.wasLit || c.colorPinned) {
      c.el.style.color = '';
      c.el.style.textShadow = '';
      c.wasLit = false;
      c.colorPinned = false;
    }
    return;
  }
  const age = x.time - c.burnedAt;
  if (age < x.opts.burnCoolMs) {
    writeLitColor(
      c.el,
      1 - age / x.opts.burnCoolMs,
      x.revealRgb,
      x.emberHotRgb,
      x.emberStr,
    );
    c.wasLit = true;
    c.colorPinned = true;
    return;
  }
  Renderer.colorAndGlowBloom(c, x.revealRgb, x.wakeRgb, x.wakeStr);
}

function defaultNaturalGlyph(c) {
  return c.revealed && c.revealChar != null ? c.revealChar : c.originalChar;
}

function burnNaturalGlyph(c) {
  return c.revealed ? c.originalChar : (c.maskGlyph || c.originalChar);
}

function scrambleAlways() { return true; }
function scrambleRevealedOnly(c) { return c.revealed; }

const REVEAL_MODES = {
  'cursor':       { frame: RevealLayer.frame, colorWriter: defaultColorWriter, naturalGlyph: defaultNaturalGlyph, scrambleOk: scrambleAlways },
  'wave':         { frame: WaveReveal.frame,  colorWriter: defaultColorWriter, naturalGlyph: defaultNaturalGlyph, scrambleOk: scrambleAlways },
  'bloom-ripple': { frame: BloomRipple.frame, colorWriter: bloomColorWriter,   naturalGlyph: defaultNaturalGlyph, scrambleOk: scrambleAlways },
  'burn':         { frame: BurnReveal.frame,  colorWriter: burnColorWriter,    naturalGlyph: burnNaturalGlyph,    scrambleOk: scrambleRevealedOnly },
};

export { FrameEngine };

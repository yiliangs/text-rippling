import { AnimationLoop, CursorField } from './browser-runtime.js';
import { Color } from './color.js';
import { REF_DT_MS, REST } from './constants.js';
import {
  DEFAULTS,
  REVEAL_MODES,
  defaultColorWriter,
  defaultNaturalGlyph,
  scrambleAlways,
} from './defaults.js';
import { BurnReveal } from './features/burn-reveal.js';
import { Redact } from './features/redact.js';
import { RevealLayer } from './features/reveal.js';
import { Char, Renderer, Splitter } from './glyph-runtime.js';
import { Effects, Falloffs, GlyphPickers } from './strategies.js';

// ════════════════════════════════════════════════════════════════════
//  TextRippling — public façade.
//
//  Constructor:  new TextRippling(elementOrSelector, options?)
//  Methods:      .update(opts), .remeasure(), .destroy()
// ════════════════════════════════════════════════════════════════════

class TextRippling {
  constructor(element, options) {
    if (typeof element === 'string') element = document.querySelector(element);
    if (!element) throw new Error('TextRippling: element not found');

    this.element = element;
    this.options = Object.assign({}, DEFAULTS, options || {});
    this._originalHTML = element.innerHTML;
    this._chars = Splitter.split(element, this.options);
    this._baseColorRgb = null;
    this._wakeCache = null;
    this._revealCache = null;
    this._emberCache = null;
    this._ro = null;
    this._springAccum = 0;
    this._redactNextTurn = 0;
    this._frameId = 0;
    this._destroyed = false;

    this._captureBaseColor();
    RevealLayer.attach(this._chars, this.options, element);
    if (this.options.revealMode === 'burn') BurnReveal.attach(this._chars, this.options);
    this._measure();
    this._bind();

    CursorField.attach();
    AnimationLoop.add(this);

    // Re-measure once webfonts have loaded — char metrics may shift.
    // The instance may have been destroyed by then; guard accordingly.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (!this._destroyed) this._measure();
      });
    }
  }

  update(options) {
    // Snapshot prev opts so module onUpdate hooks can diff. Shallow
    // clone is cheap (~25 keys) and avoids per-key stash-pairs that
    // each new option would otherwise add to this method.
    const prev = Object.assign({}, this.options);
    Object.assign(this.options, options);
    this._wakeCache = null;
    this._revealCache = null;
    this._emberCache = null;
    // Reveal-mode change: c.colorPinned and c.wasLit have different
    // invariants per writer (defaultColorWriter treats colorPinned as
    // "revealed-and-painted-with-revealColor"; bloomColorWriter treats
    // it as "I've written some explicit color"). Swapping writers
    // mid-life would leave the new writer reading the old writer's
    // latch state — clear both so it starts from a known cover state.
    if (prev.revealMode !== this.options.revealMode) {
      for (const c of this._chars) { c.colorPinned = false; c.wasLit = false; }
    }
    // Per-module lifecycle fan-out. Each module owns its own
    // diff/cleanup logic — adding a new module's update side effects
    // means adding one onUpdate call here, not threading another
    // prev/curr stash through the body.
    RevealLayer.onUpdate(prev, this.options, this._chars, this.element);
    BurnReveal.onUpdate(prev, this.options, this._chars);
    Redact.onUpdate(prev, this.options, this._chars);
  }

  remeasure() {
    this._measure();
  }

  destroy() {
    this._destroyed = true;
    AnimationLoop.remove(this);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    this.element.innerHTML = this._originalHTML;
    this._chars = [];
  }

  // ── internals ──────────────────────────────────────────────────────

  // Capture the stylesheet-resolved text color from a sample char.
  // Called once at construction, before any inline `color` is written,
  // so the result reflects the user's CSS rather than a tinted rgb()
  // value left over from a prior frame. No-op on empty elements.
  _captureBaseColor() {
    if (this._chars.length === 0) return;
    const sample = this._chars[0].el;
    const prev = sample.style.color;
    sample.style.color = '';
    this._baseColorRgb = Color.parse(getComputedStyle(sample).color);
    sample.style.color = prev;
  }

  _measure() {
    // Char centers are stored in PAGE space (client + scroll). This is
    // the framework's canonical coord space — same as CursorField stamps
    // and `ctx.mouseX/Y`. The payoff: scrolling alone doesn't move chars
    // in page space, so no per-scroll remeasure is needed.
    const sx = window.scrollX || window.pageXOffset || 0;
    const sy = window.scrollY || window.pageYOffset || 0;
    for (const c of this._chars) {
      const prev = c.el.style.transform;
      c.el.style.transform = '';
      const r = c.el.getBoundingClientRect();
      c.hx = r.left + sx + r.width / 2;
      c.hy = r.top + sy + r.height / 2;
      c.el.style.transform = prev;
    }
  }

  _bind() {
    if (this.options.remeasureOn !== 'auto') return;
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._measure());
      this._ro.observe(this.element);
    }
    // No scroll listener: positions are page-space, so scrolling
    // doesn't change them. ResizeObserver still catches layout shifts.
  }

  _tick(now, dt) {
    const opts = this.options;
    const effect  = resolve(Effects,      opts.effect,   Effects.repel);
    const falloff = resolve(Falloffs,     opts.falloff,  Falloffs.gaussian);
    const picker  = resolve(GlyphPickers, opts.swapMode, GlyphPickers.pool);

    if (!this._wakeCache) {
      const w = Color.parse(opts.wakeColor);
      this._wakeCache = { rgb: w, str: `${w[0]},${w[1]},${w[2]}` };
    }
    // Lazy-parse revealColor only when set; otherwise reveal lerps
    // toward wakeColor too (brightness multiplier still differentiates).
    if (!this._revealCache && opts.revealColor) {
      const r = Color.parse(opts.revealColor);
      this._revealCache = { rgb: r, str: `${r[0]},${r[1]},${r[2]}` };
    }
    // Ember endpoints for burn mode — parsed once like the other color
    // caches. `hot` is the combustion-flash color (ember pushed toward
    // white); the cooling ramp decays from it back to revealColor.
    if (!this._emberCache) {
      const e = Color.parse(opts.burnEmberColor);
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
    const r = opts.radius;
    const rCutoffSq = (r * 2) * (r * 2);
    const isGlobal = effect.global === true;

    // Spring substep accumulator — pay one integration step per
    // REF_DT_MS regardless of refresh rate. Brightness lerp uses an
    // exact closed-form dt step instead, so it doesn't need this.
    this._springAccum += dt;
    let springSteps = 0;
    while (this._springAccum >= REF_DT_MS) {
      this._springAccum -= REF_DT_MS;
      springSteps++;
    }

    // Redact effect — fire the morphing turnover at most once per
    // redactTurnoverMs. The per-char zone classification + state
    // seeding happens inside the per-char loop below.
    const isRedact = opts.effect === 'redact';
    if (isRedact && now >= this._redactNextTurn) {
      Redact.turnover(this._chars, opts);
      this._redactNextTurn = now + opts.redactTurnoverMs;
    }

    // Reveal: look up the mode bundle (frame, colorWriter, naturalGlyph,
    // scrambleOk). The frame runs once per tick and sets c.revealed for
    // every char; the other three are consulted per char inside the
    // loop below. Unknown mode → no frame runs and the default writer/
    // resolver/gate are used (this is how an effect-only instance with
    // no reveal feature works — leave revealText empty so applyChar
    // wouldn't latch anything anyway, and the writer's revealed
    // branches stay dormant).
    const modeBundle = REVEAL_MODES[opts.revealMode];
    if (modeBundle) modeBundle.frame(this._chars, ctx, opts);
    const colorWriter = modeBundle ? modeBundle.colorWriter  : defaultColorWriter;
    const naturalOf   = modeBundle ? modeBundle.naturalGlyph : defaultNaturalGlyph;
    const scrambleOk  = modeBundle ? modeBundle.scrambleOk   : scrambleAlways;

    // Per-frame color context — resolve endpoints once so the per-char
    // writer doesn't have to re-check this._revealCache for every glyph.
    // revealRgb/Str fall back to wakeRgb/Str when revealColor is unset.
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
      opts,
    };

    for (const c of this._chars) {
      const target = evalCharTarget(c, ctx, effect, falloff, opts, isGlobal, rCutoffSq);

      Char.springStep(c, target.tx || 0, target.ty || 0, target.rot || 0,
                      typeof target.scale === 'number' ? target.scale : 1,
                      opts.spring, opts.damping, springSteps);
      Char.brightnessLerp(c, target.brightness || 0, opts.wakeAttack, opts.wakeDecay, dt);

      // Redact: per-char zone classification + state seeding. Boolean
      // state otherwise owned by the periodic turnover above. The
      // bottom text layer is never modified — Renderer.cover paints
      // the redaction bar on a separate absolutely-positioned layer,
      // so the original glyph keeps owning the slot's layout box.
      if (isRedact) Redact.tick(c, ctx, opts);

      // Suppress scramble while redacted so the (covered) glyph
      // underneath doesn't churn — the bar is opaque so it wouldn't
      // be visible anyway, but skipping the swap avoids needless DOM
      // writes and keeps the underlying char ready to re-emerge as
      // its original self the moment the cover lifts. The mode's
      // scramble gate can veto too (burn: masked chars must never
      // case-flip, which would leak the hidden payload).
      const scrambleTarget = (c.redacted || !scrambleOk(c)) ? 0 : (target.scramble || 0);
      const naturalGlyph   = naturalOf(c);

      Renderer.transform(c);
      colorWriter(c, colorCtx);
      Renderer.glyph(c, scrambleTarget, now, opts, picker, naturalGlyph);
      Renderer.cover(c);
    }
  }
}

// ════════════════════════════════════════════════════════════════════
//  Tick helpers — kept outside the class so the hot loop stays readable.
// ════════════════════════════════════════════════════════════════════

function makeContext(now, dt) {
  // Convert the cursor sample (client-space, as the browser delivers it)
  // into page space here so every effect sees a single coord convention
  // — same space as `c.hx/hy` and `CursorField.stamps`. mouseVx/Vy stay
  // as client-space deltas: that's the rate at which the user is moving
  // the mouse, independent of scroll, which is what effects expect.
  const sx = window.scrollX || window.pageXOffset || 0;
  const sy = window.scrollY || window.pageYOffset || 0;
  return {
    mouseX:  CursorField.state.x + sx,
    mouseY:  CursorField.state.y + sy,
    mouseVx: CursorField.state.vx,
    mouseVy: CursorField.state.vy,
    time:    now,
    // Frame delta (ms) for modules that integrate per-frame rates
    // (BurnReveal's heat field). Effects get their dt-correction via
    // the spring accumulator / brightness lerp instead.
    dt:      dt,
    stamps:  CursorField.state.stamps,
    // Per-frame instance counter. wordWaveFrame stamps it onto each
    // char's Ripple memo; Effects.ripple compares to know if the
    // stash is from this frame or stale. Set by _tick.
    frameId: 0,
    // Per-char scratch fields, mutated by evalCharTarget before each
    // effect call so effects can reach back to the char without
    // changing their (dx, dy, dist, f, opts, ctx) signature.
    charX: 0, charY: 0, charSeed: 0, char: null,
  };
}

// Evaluate one char's effect target. Short-circuits when the char is
// out of cursor reach (and the effect isn't `global`), returning REST
// so the integrators advance toward zero without a per-char alloc.
//
// SIDE EFFECT: writes ctx.charX/charY/charSeed before calling the
// effect. This is how per-char data reaches effects without re-allocating
// ctx per char per frame; treat ctx as scratch space owned by the loop.
function evalCharTarget(c, ctx, effect, falloff, opts, isGlobal, rCutoffSq) {
  const dx = c.hx - ctx.mouseX;
  const dy = c.hy - ctx.mouseY;
  const d2 = dx * dx + dy * dy;

  if (!isGlobal && d2 >= rCutoffSq) return REST;

  const dist = Math.sqrt(d2);
  let f = 0;
  if (!isGlobal) {
    f = falloff(dist, opts.radius);
    if (f < 0) f = 0; else if (f > 1) f = 1;
    if (f < 0.001) return REST;
  }

  ctx.charX = c.hx;
  ctx.charY = c.hy;
  ctx.charSeed = c.seed;
  ctx.char = c;
  return effect(dx, dy, dist, f, opts, ctx) || REST;
}

// Look up a strategy by name in a registry. Functions pass through so
// callers can hand in a custom strategy without registering it; unknown
// names fall back to the registry's documented default.
function resolve(registry, name, fallback) {
  return typeof name === 'function' ? name : (registry[name] || fallback);
}

export { TextRippling };

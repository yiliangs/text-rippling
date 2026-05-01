// text-rippling — mouse-reactive per-character text effects.
// v0.1.0  •  zero dependencies  •  single-file classic script
//
// Drop in via <script src="text-rippling.js"></script> and use the global
// `TextRippling` constructor. Also exposes CommonJS exports for Node /
// bundlers; an ESM wrapper lives at `text-rippling.mjs`.
//
// ── Internal architecture ────────────────────────────────────────────────
//
//   ┌──────────── Public API ────────────┐
//   │ new TextRippling(element, options) │
//   └─────────────────┬──────────────────┘
//                     │
//   ┌─────────────────▼──────────────────────────────────────────────┐
//   │  TextRippling (façade)                                          │
//   │   constructor → Splitter.split → measure → bind → register      │
//   │   _tick(now) →  for each Char:                                  │
//   │                   target = Effect(char, ctx)                    │
//   │                   Char.integrate(target)   // spring + lerp     │
//   │                   Renderer.write(char)     // transform/color/glyph│
//   └─────────────────┬──────────────────────────────────────────────┘
//                     │
//   ┌─────────────────▼──────────────────────────────────────────────┐
//   │  Subsystems (singletons / pure)                                 │
//   │   CursorField   — pointer position, velocity, stamp ring buffer │
//   │   AnimationLoop — single shared rAF, drives all instances        │
//   │   Splitter      — text → Char[]                                 │
//   │   Renderer      — pure DOM-write functions (idle-skipping)       │
//   │   Effects       — registry of (ctx → target) functions           │
//   │   Falloffs      — registry of (dist, radius → weight) functions  │
//   │   GlyphPickers  — registry of (originalChar, opts → string)      │
//   │   Color         — parse / lerp utilities                        │
//   └─────────────────────────────────────────────────────────────────┘

(function (root) {
  'use strict';

  const VERSION = '0.1.0';

  // ════════════════════════════════════════════════════════════════════
  //  Color — parse "#rgb" / "#rrggbb" / "rgb(...)" / "rgba(...)" → [r,g,b]
  // ════════════════════════════════════════════════════════════════════

  const Color = {
    parse(str) {
      if (!str) return [255, 255, 255];
      if (str.charAt(0) === '#') {
        let hex = str.slice(1);
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        if (hex.length === 6) {
          const n = parseInt(hex, 16);
          if (!isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        }
      }
      const m = str.match(/(\d+(?:\.\d+)?)[^\d.]+(\d+(?:\.\d+)?)[^\d.]+(\d+(?:\.\d+)?)/);
      if (m) return [+m[1] | 0, +m[2] | 0, +m[3] | 0];
      return [255, 255, 255];
    },
  };

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

    // ── ripple — true ring-physics water wave ──────────────────────────
    //
    // Each cursor sample drops a stamp on the page (CursorField.stamps).
    // Each stamp emits a wavefront that expands at `rippleSpeed` and has
    // amplitude `exp(-d / rippleSpatialAtten)` when it arrives at distance d
    // (energy attenuates with distance — bounds the wake's reach).
    // After the wavefront passes a char, the char's brightness decays
    // exponentially with time constant `ripplePostHit`.
    //
    // Glyph swap fires only at the wavefront's narrow band, suppressed
    // where the char is already lit by other (background) hits — so swaps
    // cluster at the leading edge of the wake, not throughout it.
    //
    // Ignores dx/dy/f. All coords are page-space (the framework's canonical
    // space) so the wake stays anchored to the document on scroll.
    ripple(dx, dy, dist, f, p, ctx) {
      const stamps = ctx.stamps;
      if (!stamps || stamps.length === 0) return REST;

      const cx = ctx.charX;
      const cy = ctx.charY;
      const speed = p.rippleSpeed;
      const spatial = p.rippleSpatialAtten;
      const postHit = p.ripplePostHit;
      const edge = p.rippleEdge;
      const now = ctx.time;

      let brightness = 0;
      let maxWavefront = 0;

      for (let i = 0; i < stamps.length; i++) {
        const s = stamps[i];
        const ddx = cx - s.x;
        const ddy = cy - s.y;
        const dd = Math.sqrt(ddx * ddx + ddy * ddy);

        const amplAtHit = Math.exp(-dd / spatial);
        if (amplAtHit < 0.02) continue;

        const timeFromHit = now - (s.t0 + dd / speed);

        if (timeFromHit >= 0) {
          const contrib = amplAtHit * Math.exp(-timeFromHit / postHit);
          if (contrib > brightness) brightness = contrib;
        }

        const edgeDist = Math.abs(timeFromHit) * speed;
        if (edgeDist < edge) {
          const es = (1 - edgeDist / edge) * amplAtHit;
          if (es > maxWavefront) maxWavefront = es;
        }
      }

      // Suppress scramble where the char is already lit from prior hits.
      const bg = Math.max(0, brightness - maxWavefront);
      const scramble = maxWavefront * Math.max(0, 1 - bg * 2);
      return { brightness, scramble };
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

    // Mostly toggle letter case (A↔a); ~25% of the time draw a symbol
    // from `swapSymbols`. Non-letters always draw a symbol. Closer to the
    // Pudgy Penguins reference effect — feels typographic, not glitchy.
    caseFlip(originalChar, opts) {
      if (Math.random() < 0.25) return pickSymbol(opts);
      const lower = originalChar.toLowerCase();
      const upper = originalChar.toUpperCase();
      if (lower !== upper) return originalChar === upper ? lower : upper;
      return pickSymbol(opts);
    },
  };

  // ════════════════════════════════════════════════════════════════════
  //  CursorField — global pointer state + wave-stamp ring buffer.
  //
  //  Singleton. Multiple TextRippling instances share one cursor.
  //
  //  Stamps drop in the pointer-event handler (not the rAF tick), so a
  //  fast stroke that fires several events per frame yields several
  //  stamps — the wake stays a continuous line instead of breaking into
  //  one-stamp-per-frame beads. Where PointerEvent is supported we also
  //  walk getCoalescedEvents() to harvest the browser's sub-frame samples
  //  (typically 120–240 Hz on modern hardware), promoting each to a stamp.
  //
  //  Stamps still respect STAMP_MIN_DIST: a parked cursor adds no new
  //  stamps so existing wakes decay to zero instead of being re-fed.
  //  Stamps are stored in page coordinates so the wake stays anchored
  //  to the document when the user scrolls.
  // ════════════════════════════════════════════════════════════════════

  const CursorField = (() => {
    const STAMP_MIN_DIST = 5;
    const STAMP_MIN_DIST_SQ = STAMP_MIN_DIST * STAMP_MIN_DIST;
    const STAMP_MAX_AGE = 2000;
    const STAMP_BUFFER_CAP = 200;

    const state = {
      x: -1e6, y: -1e6,
      vx: 0, vy: 0,
      stamps: [],
    };
    let lastX = -1e6, lastY = -1e6;
    let lastStampX = -1e6, lastStampY = -1e6;
    let attached = false;

    function dropStamp(x, y, t) {
      const dx = x - lastStampX;
      const dy = y - lastStampY;
      if (dx * dx + dy * dy < STAMP_MIN_DIST_SQ) return;
      state.stamps.push({
        x: x + (window.scrollX || window.pageXOffset || 0),
        y: y + (window.scrollY || window.pageYOffset || 0),
        t0: t,
      });
      lastStampX = x;
      lastStampY = y;
      if (state.stamps.length > STAMP_BUFFER_CAP) {
        state.stamps.splice(0, state.stamps.length - STAMP_BUFFER_CAP);
      }
    }

    function attach() {
      if (attached) return;
      attached = true;

      if (typeof window.PointerEvent !== 'undefined') {
        window.addEventListener('pointermove', (e) => {
          // Coalesced samples expose the browser's high-rate raw input
          // that would otherwise be discarded when it batches events to
          // one-per-frame. Chrome includes the event itself in the list;
          // Firefox can return empty — fall back to the event in that case.
          const samples = (typeof e.getCoalescedEvents === 'function')
            ? e.getCoalescedEvents()
            : null;
          if (samples && samples.length > 0) {
            for (let i = 0; i < samples.length; i++) {
              const s = samples[i];
              state.x = s.clientX;
              state.y = s.clientY;
              dropStamp(s.clientX, s.clientY, s.timeStamp);
            }
          } else {
            state.x = e.clientX;
            state.y = e.clientY;
            dropStamp(e.clientX, e.clientY, e.timeStamp);
          }
        }, { passive: true });
      } else {
        const onMove = (e) => {
          state.x = e.clientX;
          state.y = e.clientY;
          dropStamp(e.clientX, e.clientY, e.timeStamp);
        };
        window.addEventListener('mousemove', onMove, { passive: true });
        window.addEventListener('touchmove', (e) => {
          const t = e.touches && e.touches[0];
          if (t) {
            state.x = t.clientX;
            state.y = t.clientY;
            dropStamp(t.clientX, t.clientY, e.timeStamp);
          }
        }, { passive: true });
      }
    }

    function update(now) {
      state.vx = state.x - lastX;
      state.vy = state.y - lastY;
      lastX = state.x;
      lastY = state.y;

      // Stamps are dropped in the pointer handler. Here we only age out
      // expired entries; once per frame is enough for that.
      while (state.stamps.length > 0 && now - state.stamps[0].t0 > STAMP_MAX_AGE) {
        state.stamps.shift();
      }
    }

    return { attach, update, state };
  })();

  // ════════════════════════════════════════════════════════════════════
  //  AnimationLoop — single shared rAF that drives every instance.
  // ════════════════════════════════════════════════════════════════════

  const AnimationLoop = (() => {
    const instances = new Set();
    let rafId = null;
    let lastTick = 0;

    function tick(now) {
      rafId = requestAnimationFrame(tick);
      const dt = now - lastTick;
      lastTick = now;
      CursorField.update(now);
      for (const inst of instances) inst._tick(now, dt);
    }

    function add(inst) {
      instances.add(inst);
      if (rafId == null) {
        lastTick = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    }

    function remove(inst) {
      instances.delete(inst);
      if (instances.size === 0 && rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    return { add, remove };
  })();

  // ════════════════════════════════════════════════════════════════════
  //  Splitter — text → Char[].
  //
  //  Whitespace is normalized (collapsed runs, trimmed) so indented HTML
  //  source doesn't bleed visible leading space. Each whole word is
  //  wrapped in an inline-block to prevent mid-word breaks. Each char
  //  becomes its own animatable inline-block span. Inter-word spaces
  //  are plain text nodes so the browser collapses them at line wraps.
  // ════════════════════════════════════════════════════════════════════

  const Splitter = {
    split(element, opts) {
      const text = element.textContent.replace(/\s+/g, ' ').replace(/^ | $/g, '');
      element.textContent = '';
      const frag = document.createDocumentFragment();
      const tokens = opts.splitWords ? (text.match(/\S+|\s+/g) || []) : [text];
      const chars = [];

      for (const tok of tokens) {
        if (/^\s+$/.test(tok)) {
          frag.appendChild(document.createTextNode(' '));
          continue;
        }
        const word = document.createElement('span');
        word.className = opts.className + '-word';
        word.style.display = 'inline-block';
        word.style.whiteSpace = 'nowrap';
        for (const ch of Array.from(tok)) {
          const span = document.createElement('span');
          span.className = opts.className;
          span.style.display = 'inline-block';
          span.style.willChange = 'transform';
          span.textContent = ch;
          word.appendChild(span);
          chars.push(Char.create(span, ch));
        }
        frag.appendChild(word);
      }
      element.appendChild(frag);
      return chars;
    },
  };

  // ════════════════════════════════════════════════════════════════════
  //  Char — per-glyph state record + integrators.
  //
  //  Plain data record (no class — keeps allocation cheap). Operations
  //  are exposed as Char.<method>(c, ...) so the data layout stays flat.
  // ════════════════════════════════════════════════════════════════════

  const Char = {
    create(el, originalChar) {
      return {
        el,
        // Page-space center, refreshed by _measure on resize/scroll/font-load.
        hx: 0, hy: 0,
        // Transform channel: position + rotation + scale, with velocities.
        tx: 0, ty: 0, rot: 0, scale: 1,
        vx: 0, vy: 0, vr: 0, vs: 0,
        transformIdle: true,
        // Brightness channel: 0..1, asymmetric-lerped toward target.
        bright: 0,
        wasLit: false,
        // Glyph channel: discrete swap state, throttled per char.
        scrambled: false,
        nextSwap: 0,
        originalChar,
        // Deterministic seed for effects/strategies that want per-char jitter.
        seed: Math.random(),
      };
    },

    // Critically-stable spring step — accumulates velocity from spring force
    // toward target, then bleeds via damping. Same physics for tx/ty/rot/scale.
    springStep(c, tx, ty, rot, scale, k, d) {
      c.vx = (c.vx + (tx - c.tx) * k) * d;
      c.vy = (c.vy + (ty - c.ty) * k) * d;
      c.vr = (c.vr + (rot - c.rot) * k) * d;
      c.vs = (c.vs + (scale - c.scale) * k) * d;
      c.tx += c.vx;
      c.ty += c.vy;
      c.rot += c.vr;
      c.scale += c.vs;
    },

    // Asymmetric brightness lerp: snaps up fast (light entering), fades
    // slowly (the wake / lingering glow). Spring oscillation would look
    // like flicker on a brightness channel, so we use plain lerp.
    brightnessLerp(c, target, attack, decay) {
      const rate = target > c.bright ? attack : decay;
      c.bright += (target - c.bright) * rate;
      if (c.bright < 0.001) c.bright = 0;
    },
  };

  // ════════════════════════════════════════════════════════════════════
  //  Renderer — pure DOM-write functions, one per channel.
  //
  //  Each writer is idempotent and idle-skipping: when a channel is at
  //  rest AND was at rest last frame, no DOM write happens. This keeps
  //  the cost of inactive chars near zero.
  // ════════════════════════════════════════════════════════════════════

  const Renderer = {
    transform(c) {
      const idle =
        Math.abs(c.tx) < 0.05 && Math.abs(c.ty) < 0.05 &&
        Math.abs(c.rot) < 0.001 && Math.abs(c.scale - 1) < 0.005 &&
        Math.abs(c.vx) < 0.05 && Math.abs(c.vy) < 0.05;
      if (idle) {
        if (!c.transformIdle) {
          c.tx = 0; c.ty = 0; c.rot = 0; c.scale = 1;
          c.vx = 0; c.vy = 0; c.vr = 0; c.vs = 0;
          c.el.style.transform = '';
          c.transformIdle = true;
        }
      } else {
        c.el.style.transform =
          `translate(${c.tx.toFixed(2)}px,${c.ty.toFixed(2)}px) ` +
          `rotate(${c.rot.toFixed(4)}rad) ` +
          `scale(${c.scale.toFixed(3)})`;
        c.transformIdle = false;
      }
    },

    colorAndGlow(c, baseRgb, wakeRgb, wakeRgbStr) {
      const lit = c.bright > 0.005;
      if (lit) {
        const b = c.bright > 1 ? 1 : c.bright;
        // Square-root curve ≈ inverse of monitor gamma → perceptually
        // linear ramp. Faint trails stay visible without forcing high
        // brightness values.
        //
        // sqrt(b) has infinite slope at 0, so on its own it would leave a
        // visible step at the `lit` cutoff (sqrt(0.005) ≈ 0.07 → ~4 RGB
        // units of residual tint). Multiply by a smoothstep fade in the
        // bottom 0..fadeStart region: 1.0 above fadeStart (visible range
        // unchanged), tapering to 0 with zero slope at b = 0. The shadow
        // params get the same fade so blur/alpha vanish in lockstep.
        const fadeStart = 0.05;
        let fade;
        if (b >= fadeStart) fade = 1;
        else { const u = b / fadeStart; fade = u * u * (3 - 2 * u); }

        const t = Math.sqrt(b) * fade;
        const r = (baseRgb[0] + (wakeRgb[0] - baseRgb[0]) * t) | 0;
        const g = (baseRgb[1] + (wakeRgb[1] - baseRgb[1]) * t) | 0;
        const bl = (baseRgb[2] + (wakeRgb[2] - baseRgb[2]) * t) | 0;
        c.el.style.color = `rgb(${r},${g},${bl})`;
        c.el.style.textShadow = `0 0 ${(b * 14 * fade).toFixed(2)}px rgba(${wakeRgbStr},${(b * 0.85 * fade).toFixed(3)})`;
        c.wasLit = true;
      } else if (c.wasLit) {
        c.el.style.color = '';
        c.el.style.textShadow = '';
        c.bright = 0;
        c.wasLit = false;
      }
    },

    glyph(c, scrambleTarget, now, opts, picker) {
      // Enter scramble when target crosses the upper threshold AND this
      // char's per-char throttle has expired. Throttle is jittered by
      // seed so neighbors shimmer organically, not in lockstep.
      if (scrambleTarget > 0.35 && now >= c.nextSwap) {
        const newGlyph = picker(c.originalChar, opts);
        if (newGlyph != null && newGlyph !== c.el.textContent) {
          c.el.textContent = newGlyph;
          c.scrambled = true;
          c.nextSwap = now + opts.swapInterval * (0.7 + c.seed * 0.6);
        }
      } else if (scrambleTarget < 0.08 && c.scrambled) {
        c.el.textContent = c.originalChar;
        c.scrambled = false;
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════
  //  DEFAULTS — every option is a knob exposed to the user.
  // ════════════════════════════════════════════════════════════════════

  const DEFAULTS = {
    // Effect & shape
    effect:      'repel',
    radius:      160,           // px — proximity falloff radius (most effects)
    strength:    30,            // effect-specific magnitude
    falloff:     'gaussian',    // see Falloffs registry
    // Spring (transform channel)
    spring:      0.18,          // 0..1 — stiffness toward target
    damping:     0.72,          // 0..1 — velocity decay per frame
    // Brightness (asymmetric lerp)
    wakeAttack:  0.55,          // 0..1 — rise rate when target > current
    wakeDecay:   0.12,          // 0..1 — fall rate when target < current (lower = longer trail)
    wakeColor:   '#ffffff',     // CSS color — destination of the brightness lerp
    // Glyph swap
    swapMode:    'caseFlip',    // see GlyphPickers registry
    swapInterval: 70,           // ms between per-char re-rolls while scrambling
    glyphPool:   'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*+=<>?/',
    swapSymbols: '!@#$%^&*+=<>?/|~',
    // Ripple physics
    rippleSpeed:        0.55,   // px/ms — wavefront expansion rate
    rippleSpatialAtten: 180,    // px — wave amplitude is 1/e at this distance from stamp
    ripplePostHit:      380,    // ms — exp decay after wavefront passes
    rippleEdge:         22,     // px — width of the swap band at the wavefront
    // Layout / DOM
    splitWords:  true,          // wrap whole words in inline-block (prevents mid-word wrap)
    remeasureOn: 'auto',        // 'auto' | 'manual'
    className:   'tr-char',     // base class for char spans
  };

  // Frozen rest target — returned when a char has no active influence so
  // the integrators have a known-zero state without per-char allocation.
  const REST = Object.freeze({ tx: 0, ty: 0, rot: 0, scale: 1, brightness: 0, scramble: 0 });

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
      this._ro = null;

      this._measure();
      this._bind();

      CursorField.attach();
      AnimationLoop.add(this);

      // Re-measure once webfonts have loaded — char metrics may shift.
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => this._measure());
      }
    }

    update(options) {
      Object.assign(this.options, options);
      this._wakeCache = null;
    }

    remeasure() {
      this._measure();
    }

    destroy() {
      AnimationLoop.remove(this);
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      this.element.innerHTML = this._originalHTML;
      this._chars = [];
    }

    // ── internals ──────────────────────────────────────────────────────

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
      // Capture base text color once. Re-read needs `color: ''` so we see
      // the stylesheet-resolved value, not a previously-written rgb().
      if (!this._baseColorRgb && this._chars.length > 0) {
        const sample = this._chars[0].el;
        const prev = sample.style.color;
        sample.style.color = '';
        this._baseColorRgb = Color.parse(getComputedStyle(sample).color);
        sample.style.color = prev;
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

    _tick(now /*, dt */) {
      const opts = this.options;
      const effect  = resolve(Effects,      opts.effect,   Effects.repel);
      const falloff = resolve(Falloffs,     opts.falloff,  Falloffs.gaussian);
      const picker  = resolve(GlyphPickers, opts.swapMode, GlyphPickers.pool);

      if (!this._wakeCache) {
        const w = Color.parse(opts.wakeColor);
        this._wakeCache = { rgb: w, str: `${w[0]},${w[1]},${w[2]}` };
      }
      const wakeRgb = this._wakeCache.rgb;
      const wakeStr = this._wakeCache.str;
      const baseRgb = this._baseColorRgb || [200, 200, 200];

      const ctx = makeContext(now);
      const r = opts.radius;
      const rCutoffSq = (r * 2) * (r * 2);
      const isGlobal = effect.global === true;

      for (const c of this._chars) {
        const target = computeTarget(c, ctx, effect, falloff, opts, isGlobal, rCutoffSq);

        Char.springStep(c, target.tx || 0, target.ty || 0, target.rot || 0,
                        typeof target.scale === 'number' ? target.scale : 1,
                        opts.spring, opts.damping);
        Char.brightnessLerp(c, target.brightness || 0, opts.wakeAttack, opts.wakeDecay);

        Renderer.transform(c);
        Renderer.colorAndGlow(c, baseRgb, wakeRgb, wakeStr);
        Renderer.glyph(c, target.scramble || 0, now, opts, picker);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  Tick helpers — kept outside the class so the hot loop stays readable.
  // ════════════════════════════════════════════════════════════════════

  function makeContext(now) {
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
      stamps:  CursorField.state.stamps,
      charX: 0, charY: 0, charSeed: 0,
    };
  }

  // Compute one char's target state. Short-circuits when the char is out
  // of cursor reach (and the effect isn't `global`). Returns REST in that
  // case so the integrators advance toward zero without a per-char alloc.
  function computeTarget(c, ctx, effect, falloff, opts, isGlobal, rCutoffSq) {
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
    return effect(dx, dy, dist, f, opts, ctx) || REST;
  }

  // Look up a strategy by name in a registry. Functions pass through so
  // callers can hand in a custom strategy without registering it; unknown
  // names fall back to the registry's documented default.
  function resolve(registry, name, fallback) {
    return typeof name === 'function' ? name : (registry[name] || fallback);
  }

  // ════════════════════════════════════════════════════════════════════
  //  Convenience + exports
  // ════════════════════════════════════════════════════════════════════

  function rippleAll(selector, options) {
    return Array.from(document.querySelectorAll(selector))
      .map((el) => new TextRippling(el, options));
  }

  // Attach registries and helpers to the constructor for plugin authors.
  TextRippling.version      = VERSION;
  TextRippling.effects      = Effects;
  TextRippling.falloffs     = Falloffs;
  TextRippling.glyphPickers = GlyphPickers;
  TextRippling.rippleAll    = rippleAll;
  // Cursor field is exposed for advanced use: custom effects can read
  // history (cursor.state.stamps), and tests / alternative input sources
  // can push state.x/y and call cursor.update(now) directly.
  TextRippling.cursor       = CursorField;

  // Browser global (works under <script src> from file:// or http://).
  if (typeof root !== 'undefined') root.TextRippling = TextRippling;

  // CommonJS (Node, bundlers).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TextRippling;
    module.exports.TextRippling  = TextRippling;
    module.exports.rippleAll     = rippleAll;
    module.exports.effects       = Effects;
    module.exports.falloffs      = Falloffs;
    module.exports.glyphPickers  = GlyphPickers;
    module.exports.cursor        = CursorField;
    module.exports.version       = VERSION;
  }
}(typeof window !== 'undefined' ? window : globalThis));

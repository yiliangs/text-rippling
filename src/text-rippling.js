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
//   │   Ripple        — self-contained ring-wave physics; the          │
//   │                   `ripple` Effects entry is a thin adapter onto it│
//   │   RevealLayer   — sticky two-layer text overlay; cursor-proximity │
//   │                   driven, latches once and stays                  │
//   │   WaveReveal    — reversible two-layer overlay; wave-amplitude    │
//   │                   driven, dithered per-char threshold (Ripple)    │
//   │   Color         — parse / lerp utilities                        │
//   └─────────────────────────────────────────────────────────────────┘

(function (root) {
  'use strict';

  const VERSION = '0.1.0';

  // Reference frame interval (≈60Hz) — the rate the per-step integrator
  // constants in DEFAULTS are tuned for. The dt-aware integrators rescale
  // to this so visible behavior is identical across refresh rates.
  const REF_DT_MS = 16.67;

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
  //  Ripple — self-contained ring-physics water-wave subsystem.
  //
  //  Stateless and dependency-free: knows nothing about CursorField,
  //  Char, ctx, REST, or the rest of the framework. Given a char
  //  position, the current time, a stamp history, and four tuning
  //  constants, returns the wave-amplitude state at that char.
  //  `Effects.ripple` is the thin adapter that bolts this onto the
  //  Effects registry.
  //
  //  Input contract:
  //    charX, charY  — char center, ANY coord space, but must match the
  //                    coord space stamps were recorded in
  //    time          — current time (DOMHighResTimeStamp ms)
  //    stamps        — array of { x, y, t0 } disturbance origins, where
  //                    (x, y) shares the char coord space and t0 shares
  //                    `time`'s base. Read-only; never mutated.
  //    speed         — px/ms; wavefront expansion rate
  //    spatial       — px; wave amplitude is 1/e at this distance
  //    postHit       — ms; exponential decay after wavefront passes
  //    edge          — px; width of the swap band at the wavefront
  //
  //  Returns:
  //    { brightness, scramble, interior } — brightness/scramble in [0, 1];
  //                                          interior is a boolean
  //    null                                — char has no active wake
  //                                          (caller treats as rest)
  //
  //  Frontier semantics: the moment ANY stamp's wavefront has fully
  //  passed a char (edgeDist > edge AND timeFromHit > 0), `scramble` is
  //  forced to 0 and `interior` is true — only the leading ring of the
  //  wake scrambles glyphs; the bulk shows lit-but-original characters.
  //  `interior` is exposed for downstream modules (e.g. RevealLayer) that
  //  need the same "wave has passed" signal without re-deriving it.
  // ════════════════════════════════════════════════════════════════════

  const Ripple = {
    // Tuning defaults — the framework's DEFAULTS mirrors these under
    // `ripple*` keys so the physical constants are owned in one place.
    DEFAULTS: {
      speed:   0.55,
      spatial: 180,
      postHit: 380,
      edge:    22,
    },

    compute(charX, charY, time, stamps, speed, spatial, postHit, edge) {
      if (!stamps || stamps.length === 0) return null;

      let brightness = 0;
      let frontierAmp = 0;
      let interior = false;

      for (let i = 0; i < stamps.length; i++) {
        const s = stamps[i];
        const ddx = charX - s.x;
        const ddy = charY - s.y;
        const dd = Math.sqrt(ddx * ddx + ddy * ddy);

        const amplAtHit = Math.exp(-dd / spatial);
        if (amplAtHit < 0.02) continue;

        const timeFromHit = time - (s.t0 + dd / speed);

        if (timeFromHit >= 0) {
          const contrib = amplAtHit * Math.exp(-timeFromHit / postHit);
          if (contrib > brightness) brightness = contrib;
        }

        const edgeDist = Math.abs(timeFromHit) * speed;
        if (edgeDist < edge) {
          const es = (1 - edgeDist / edge) * amplAtHit;
          if (es > frontierAmp) frontierAmp = es;
        } else if (timeFromHit > 0) {
          // This stamp's wavefront has fully passed — char is in the wake bulk.
          interior = true;
        }
      }

      const scramble = interior ? 0 : frontierAmp;
      return { brightness, scramble, interior };
    },
  };

  // ════════════════════════════════════════════════════════════════════
  //  RevealLayer — optional two-layer text overlay.
  //
  //  Pairs each visible char with a counterpart from a "lower" string,
  //  supplied via `options.revealText` or a `data-reveal` attribute on
  //  the host element. The latch is purely cursor-proximity driven —
  //  no wave physics, no diffusion, no shared state with any effect.
  //  Two radii control the trigger:
  //    - `revealRadius`  — chars within this distance of the cursor
  //                        latch immediately ("always flip" core).
  //    - `revealFringe`  — additional outer band; chars in here latch
  //                        probabilistically by their per-char seed,
  //                        producing a stippled / dissolve-noise edge
  //                        rather than a clean ring.
  //  The latch is sticky: once a char is revealed, it stays revealed
  //  for the lifetime of the instance (lottery-ticket scratch model).
  //
  //  This module is independent — it works under any effect, including
  //  `none`. Color is pinned discretely via Renderer.colorAndGlow when
  //  `c.revealed` is true; no brightness modulation, no two-state ramp.
  //
  //  No setup → no behavior. With nothing in `revealText` and no
  //  `data-reveal` attribute, `showLower` always returns false and the
  //  module is effectively absent.
  // ════════════════════════════════════════════════════════════════════

  const RevealLayer = {
    // Walk chars[] and fill `revealChar` per visible position. Sources
    // (in priority order):
    //   1. `opts.revealText` (string)
    //   2. `element.dataset.reveal` (HTML `data-reveal="..."` fallback)
    //   3. neither — feature is off; all `revealChar` set to null
    // Length policy: short reveal pads with null (no swap on the tail —
    // upper still shows there); long reveal is truncated to chars.length.
    // Spaces in the reveal string are stripped so the mapping aligns
    // with Splitter's visible-char-only chars[] (Splitter doesn't emit
    // spans for whitespace either).
    attach(chars, opts, element) {
      let raw = opts.revealText;
      if (!raw && element && element.dataset && element.dataset.reveal) {
        raw = element.dataset.reveal;
      }
      if (!raw) {
        for (let i = 0; i < chars.length; i++) {
          chars[i].revealChar = null;
          chars[i].revealed = false;
          chars[i].revealAt = 0;
          chars[i].revealHoldUntil = 0;
        }
        return;
      }
      const lower = [];
      for (const ch of Array.from(raw)) {
        if (!/\s/.test(ch)) lower.push(ch);
      }
      for (let i = 0; i < chars.length; i++) {
        chars[i].revealChar = i < lower.length ? lower[i] : null;
        // Re-attach clears the sticky latch and any pending timer — a
        // new reveal text starts fresh, even if previous chars at the
        // same positions had been exposed (or engaged) earlier.
        chars[i].revealed = false;
        chars[i].revealAt = 0;
        chars[i].revealHoldUntil = 0;
      }
    },

    // Should this char be rendered as the lower layer RIGHT NOW?
    // Allocation-free; mutates `c.revealed` (and `c.revealAt`) as the
    // engagement state evolves. Caller derives the glyph and pinned
    // color from `c.revealed` afterward.
    //
    // STICKY: the first time the conditions hold, `c.revealed` latches to
    // true and the predicate returns true forever after.
    //
    // Trigger geometry:
    //   - distance ≤ revealRadius            → latch immediately (core)
    //   - revealRadius < d ≤ revealRadius+revealFringe (the fringe band)
    //       → on FIRST entry, engage this char:
    //           • `revealImmediate` fraction (by seed) latch immediately
    //           • the rest set `c.revealAt = now + delay`, where delay is
    //             a per-char fixed value uniform in [0, revealDelayMs]
    //         Once `revealAt` is set it counts down independent of the
    //         cursor — the char eventually latches even if you sweep
    //         away from it. Re-entries don't re-roll the timer.
    //   - any pending timer that has now fired → latch.
    //   - distance > outer AND no pending timer → no change.
    showLower(c, mouseX, mouseY, opts, now) {
      if (c.revealChar == null) return false;
      if (c.revealed) return true;

      const dx = c.hx - mouseX;
      const dy = c.hy - mouseY;
      const d2 = dx * dx + dy * dy;

      // Inner core overrides everything — instant flip.
      const radius = opts.revealRadius;
      if (d2 < radius * radius) {
        c.revealed = true;
        return true;
      }

      // Pending timer fired? Fire regardless of cursor position now.
      if (c.revealAt > 0 && now >= c.revealAt) {
        c.revealed = true;
        return true;
      }

      // Engage on first entry into the fringe band.
      const fringe = opts.revealFringe;
      if (c.revealAt === 0 && fringe > 0) {
        const outer = radius + fringe;
        if (d2 < outer * outer) {
          const immediate = opts.revealImmediate;
          if (c.seed < immediate) {
            c.revealed = true;
            return true;
          }
          // Map the remaining seed range [immediate, 1] linearly to
          // [0, revealDelayMs]. Deterministic per char — the same char
          // always gets the same delay.
          const delay = (1 - immediate) > 0
            ? (c.seed - immediate) / (1 - immediate) * opts.revealDelayMs
            : 0;
          c.revealAt = now + delay;
        }
      }
      return false;
    },
  };

  // ════════════════════════════════════════════════════════════════════
  //  WaveReveal — reversible wave-driven dithered two-layer overlay.
  //
  //  Sibling to RevealLayer. Same two-layer setup (revealChar per Char,
  //  revealColor as the pinned destination) and the same renderer hookup
  //  (Renderer.colorAndGlow's c.revealed branch already handles both
  //  pin AND unpin transitions). The DIFFERENCE from RevealLayer is the
  //  trigger:
  //
  //    RevealLayer  → cursor proximity, sticky once latched.
  //    WaveReveal   → wave amplitude (Ripple.compute), reversible —
  //                   c.revealed flips back when the wake fades.
  //
  //  Per char per frame: amplitude = Ripple.compute(...).brightness.
  //  c.revealed = (amplitude > c.seed). The per-char fixed seed gives
  //  the dither — at any amplitude level, the fraction of revealed
  //  chars in a region matches the amplitude there. Visual: a
  //  pixelated ripple — same propagation, same decay, same multi-stamp
  //  overlap as the smooth ripple effect, but binary per-glyph color
  //  states instead of a continuous color gradient.
  //
  //  Reuses ripple physics options (rippleSpeed, rippleSpatialAtten,
  //  ripplePostHit, rippleEdge) so the wave's character matches what
  //  the standard `ripple` effect would produce.
  // ════════════════════════════════════════════════════════════════════

  const WaveReveal = {
    tick(c, ctx, opts) {
      if (c.revealChar == null) {
        c.revealed = false;
        return false;
      }

      // Always-flip core: chars within `revealRadius` of the cursor flip
      // unconditionally and refresh the hold timer. Without this, a
      // char with a high seed (~0.95+) right under the cursor can fail
      // to flip because the wave amplitude only briefly exceeds its
      // threshold between frames, and the per-frame sample misses it.
      // The wave-driven dither still rules everything outside this core.
      const dx = c.hx - ctx.mouseX;
      const dy = c.hy - ctx.mouseY;
      const distSq = dx * dx + dy * dy;
      const innerR = opts.revealRadius;
      if (distSq < innerR * innerR) {
        c.revealed = true;
        c.revealHoldUntil = ctx.time + opts.revealHoldMs;
        return true;
      }

      // Outer wave-driven dither: amplitude vs per-char seed.
      const r = Ripple.compute(
        c.hx, c.hy, ctx.time, ctx.stamps,
        opts.rippleSpeed, opts.rippleSpatialAtten,
        opts.ripplePostHit, opts.rippleEdge,
      );
      const amplitude = r ? r.brightness : 0;

      // While the wave amplitude is above this char's threshold, the
      // char is revealed AND the hold timer is refreshed forward. Once
      // the wave drops back below the threshold, the timer counts down;
      // when it expires, the char flips back to the cover. Each frame
      // the amplitude crosses again refreshes the timer, so a char that
      // gets repeatedly brushed stays revealed continuously.
      if (amplitude > c.seed) {
        c.revealed = true;
        c.revealHoldUntil = ctx.time + opts.revealHoldMs;
      } else if (c.revealed && ctx.time >= c.revealHoldUntil) {
        c.revealed = false;
      }
      return c.revealed;
    },
  };

  // ════════════════════════════════════════════════════════════════════
  //  Redact — stochastic-density block redaction with morphing turnover.
  //
  //  Top-level effect, but implemented as a sibling module (like
  //  RevealLayer / WaveReveal). `Effects.redact` is a no-op routing slot;
  //  the per-char glyph swap is driven from `_tick` directly when
  //  `opts.effect === 'redact'`.
  //
  //  Spatial law:
  //    d <  redactRadius                 → redacted (always; "core")
  //    d >= redactRadius + redactFringe  → not redacted
  //    in band                           → redacted iff this char is
  //                                         currently in the redacted
  //                                         subset of the band.
  //
  //  Band entry seeds each char by gradient probability p(d) = (B-d)/(B-A),
  //  so initial density is 1.0 at the inner edge and 0.0 at the outer edge.
  //
  //  Morphing: every `redactTurnoverMs` (default 500ms, i.e. 2 turns/sec),
  //  the turnover swaps a `redactTurnoverFrac` (default 30%) slice of the
  //  current in-band redacted set OFF, and the same count of in-band
  //  unredacted chars ON. Net in-band redacted count is preserved; which
  //  specific chars are redacted shuffles. Reads as a stable cloud of
  //  redaction whose membership churns each turn.
  //
  //  Per-char state (on Char): `redacted` (boolean rendered state) and
  //  `redactZone` (0=outside, 1=core, 2=band) — the zone is tracked so
  //  band entry can be detected and seeded once, leaving the boolean
  //  state otherwise to the turnover.
  // ════════════════════════════════════════════════════════════════════

  const Redact = {
    tick(c, ctx, opts) {
      const dx = c.hx - ctx.mouseX;
      const dy = c.hy - ctx.mouseY;
      const d2 = dx * dx + dy * dy;
      const innerR = opts.redactRadius;
      const outerR = innerR + opts.redactFringe;

      if (d2 < innerR * innerR) {
        c.redacted = true;
        c.redactZone = 1;
      } else if (d2 >= outerR * outerR) {
        c.redacted = false;
        c.redactZone = 0;
      } else if (c.redactZone !== 2) {
        // Just entered the band from outside or from the core — seed the
        // boolean state by the position's gradient probability. After
        // this, the turnover owns transitions until the char leaves the
        // band again.
        const d = Math.sqrt(d2);
        const p = (outerR - d) / (outerR - innerR);
        c.redacted = Math.random() < p;
        c.redactZone = 2;
      }
    },

    // Picks redactTurnoverFrac of currently-redacted band chars and
    // unredacts them; picks the same count of currently-unredacted band
    // chars and redacts them. Net count preserved — only the membership
    // churns. Linear in chars.length; allocates two arrays per call.
    turnover(chars, opts) {
      const onSet = [];
      const offSet = [];
      for (const c of chars) {
        if (c.redactZone !== 2) continue;
        (c.redacted ? onSet : offSet).push(c);
      }
      // Symmetric swap: flip the same count both directions so the
      // total in-band redacted count is exactly preserved per turn.
      // Capped by both sides — if the band is near-saturated and the
      // unredacted pool is smaller than 30% of the redacted pool, the
      // swap shrinks to the smaller pool's size.
      const want = Math.floor(onSet.length * opts.redactTurnoverFrac);
      const swap = Math.min(want, offSet.length);
      // Partial Fisher–Yates: only the first N entries need to be a
      // uniform random pick, so we stop after N swaps.
      const pickFirst = (arr, n) => {
        for (let i = 0; i < n; i++) {
          const j = i + ((Math.random() * (arr.length - i)) | 0);
          const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        }
      };
      pickFirst(onSet, swap);
      for (let i = 0; i < swap; i++) onSet[i].redacted = false;
      pickFirst(offSet, swap);
      for (let i = 0; i < swap; i++) offSet[i].redacted = true;
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
    ripple(dx, dy, dist, f, p, ctx) {
      return Ripple.compute(
        ctx.charX, ctx.charY, ctx.time, ctx.stamps,
        p.rippleSpeed, p.rippleSpatialAtten, p.ripplePostHit, p.rippleEdge,
      ) || REST;
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
  //
  //  Each char span is a TWO-LAYER host so per-glyph effects that would
  //  otherwise resize the slot (the redact bar in particular, but also
  //  any future glyph-replacing effect) can paint on top without
  //  disturbing layout. Structure:
  //
  //    <span.tr-char position:relative>
  //      <span.tr-char-text>a</span>            ← layout-bearing glyph
  //      <span.tr-char-cover position:absolute  ← redact / cover layer
  //                          inset:0
  //                          background:currentColor
  //                          display:none></span>
  //    </span>
  //
  //  All textContent writes from Renderer.glyph target the inner text
  //  span; the parent's bounding box is sized by the text span alone,
  //  so the cover (when shown) has no effect on the line's metrics.
  // ════════════════════════════════════════════════════════════════════

  const Splitter = {
    split(element, opts) {
      const text = element.textContent.replace(/\s+/g, ' ').replace(/^ | $/g, '');
      element.textContent = '';
      const frag = document.createDocumentFragment();
      const tokens = opts.splitWords ? (text.match(/\S+|\s+/g) || []) : [text];
      const chars = [];
      const coverBg = opts.redactColor || 'currentColor';

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
          span.style.position = 'relative';
          span.style.willChange = 'transform';

          const textEl = document.createElement('span');
          textEl.className = opts.className + '-text';
          textEl.textContent = ch;
          span.appendChild(textEl);

          const coverEl = document.createElement('span');
          coverEl.className = opts.className + '-cover';
          coverEl.style.position = 'absolute';
          coverEl.style.left = '0';
          coverEl.style.top = '0';
          coverEl.style.right = '0';
          coverEl.style.bottom = '0';
          coverEl.style.background = coverBg;
          coverEl.style.display = 'none';
          coverEl.style.pointerEvents = 'none';
          span.appendChild(coverEl);

          word.appendChild(span);
          chars.push(Char.create(span, ch, textEl, coverEl));
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
    create(el, originalChar, textEl, coverEl) {
      return {
        el,
        // Two-layer split (see Splitter banner): textEl carries the
        // glyph and owns the slot's layout dimensions; coverEl is the
        // absolutely-positioned redact bar painted on top, toggled by
        // Renderer.cover on c.redacted transitions.
        textEl,
        coverEl,
        coverShown: false,
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
        // Lower-layer counterpart for the optional RevealLayer module.
        // Null when no reveal text is configured for this position.
        revealChar: null,
        // Sticky latch: set true the first time RevealLayer.showLower
        // returns true for this char, never cleared. The reveal behaves
        // like a scratched lottery ticket — once a position has been
        // exposed by a wavefront, it stays revealed for the lifetime of
        // the instance, regardless of whether the wake has faded.
        revealed: false,
        // Companion latch on the renderer side: tracks whether the
        // pinned reveal color has been written to inline style yet.
        // Reset by Renderer.colorAndGlow if `revealed` flips back.
        colorPinned: false,
        // Pending-reveal timer set by RevealLayer when cursor first
        // enters the fringe. 0 = unengaged. >0 = absolute timestamp
        // (DOMHighResTimeStamp) at which the latch should fire.
        revealAt: 0,
        // Hold-and-revert timer used by WaveReveal. Refreshed forward
        // each frame the wave amplitude is above this char's seed; the
        // char flips back to the cover once `now` passes this timestamp.
        revealHoldUntil: 0,
        // Stochastic block-redaction state (driven by Redact module).
        // `redacted` = currently rendered as the redact glyph;
        // `redactZone` classifies cursor proximity (0=outside,
        // 1=inner core, 2=fringe band). The zone is tracked so band
        // entry can be detected once and the boolean state seeded by
        // gradient — between entry and exit, only the periodic
        // turnover swaps the boolean.
        redacted: false,
        redactZone: 0,
        // Deterministic seed for effects/strategies that want per-char jitter.
        seed: Math.random(),
      };
    },

    // Critically-stable spring step — accumulates velocity from spring force
    // toward target, then bleeds via damping. Same physics for tx/ty/rot/scale.
    //
    // Runs `steps` integration substeps per call. The caller (TextRippling
    // ._tick) accumulates frame dt and pays one substep per REF_DT_MS, so
    // the spring's effective rate stays at ~60Hz whether the screen is
    // 60, 120, or 144Hz. `steps == 0` is a no-op (high-refresh frame that
    // hasn't yet accumulated a full reference interval).
    springStep(c, tx, ty, rot, scale, k, d, steps) {
      for (let i = 0; i < steps; i++) {
        c.vx = (c.vx + (tx - c.tx) * k) * d;
        c.vy = (c.vy + (ty - c.ty) * k) * d;
        c.vr = (c.vr + (rot - c.rot) * k) * d;
        c.vs = (c.vs + (scale - c.scale) * k) * d;
        c.tx += c.vx;
        c.ty += c.vy;
        c.rot += c.vr;
        c.scale += c.vs;
      }
    },

    // Asymmetric brightness lerp: snaps up fast (light entering), fades
    // slowly (the wake / lingering glow). Spring oscillation would look
    // like flicker on a brightness channel, so we use plain lerp.
    //
    // Closed-form dt correction: the per-step factor `rate` (tuned for
    // REF_DT_MS) is generalized to `1 - (1 - rate)^(dt / REF_DT_MS)` so
    // the real-time decay is identical at any refresh rate.
    brightnessLerp(c, target, attack, decay, dt) {
      const rate = target > c.bright ? attack : decay;
      const k = 1 - Math.pow(1 - rate, dt / REF_DT_MS);
      c.bright += (target - c.bright) * k;
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
      // Sticky reveal: once a char is revealed, pin its color to the
      // reveal destination at full saturation — no brightness modulation,
      // no shadow, no further writes. Discrete two-state, no ramping.
      // Matches the binary glyph swap: when text is switched, color is
      // switched; both states are stable.
      if (c.revealed) {
        if (!c.colorPinned) {
          c.el.style.color = `rgb(${wakeRgb[0]},${wakeRgb[1]},${wakeRgb[2]})`;
          c.el.style.textShadow = '';
          c.colorPinned = true;
          c.wasLit = false;
        }
        return;
      }
      // Just unpinned (e.g. RevealLayer.attach reset c.revealed via a
      // fresh revealText) — clear the leftover inline styles so the lerp
      // branch below can take over cleanly on subsequent waves.
      if (c.colorPinned) {
        c.el.style.color = '';
        c.el.style.textShadow = '';
        c.colorPinned = false;
        c.wasLit = false;
      }

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

    // `naturalGlyph` is the char to display when NOT actively scrambling
    // — usually `c.originalChar`, or `c.revealChar` when RevealLayer
    // says the lower layer should show. Caller computes it once.
    //
    // Writes target c.textEl (the inner glyph layer) so the cover layer
    // is never disturbed and the parent slot's layout stays stable
    // regardless of how the textContent shifts between scramble glyphs.
    glyph(c, scrambleTarget, now, opts, picker, naturalGlyph) {
      // Enter scramble when target crosses the upper threshold AND this
      // char's per-char throttle has expired. Throttle is jittered by
      // seed so neighbors shimmer organically, not in lockstep.
      if (scrambleTarget > 0.35 && now >= c.nextSwap) {
        const newGlyph = picker(c.originalChar, opts);
        if (newGlyph != null && newGlyph !== c.textEl.textContent) {
          c.textEl.textContent = newGlyph;
          c.scrambled = true;
          c.nextSwap = now + opts.swapInterval * (0.7 + c.seed * 0.6);
        }
      } else if (scrambleTarget < 0.08 && c.scrambled) {
        // Exit scramble — settle on whichever layer the caller chose.
        c.textEl.textContent = naturalGlyph;
        c.scrambled = false;
      } else if (!c.scrambled && c.textEl.textContent !== naturalGlyph) {
        // Layer changed without an intermediate scramble (e.g. a quiet
        // wavefront pass that didn't cross the scramble threshold).
        c.textEl.textContent = naturalGlyph;
      }
    },

    // Toggle the redact cover layer based on c.redacted. Single DOM
    // write per transition (gated by c.coverShown), zero work while the
    // state is steady. The cover is `position: absolute; inset: 0` so
    // showing/hiding it has no layout impact whatsoever — the bottom
    // text layer continues to own all slot dimensions.
    cover(c) {
      if (c.redacted && !c.coverShown) {
        c.coverEl.style.display = 'block';
        c.coverShown = true;
      } else if (!c.redacted && c.coverShown) {
        c.coverEl.style.display = 'none';
        c.coverShown = false;
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
    // Ripple physics — physical constants live in the Ripple subsystem;
    // these keys mirror them under prefixed names for the flat options bag.
    rippleSpeed:        Ripple.DEFAULTS.speed,    // px/ms — wavefront expansion rate
    rippleSpatialAtten: Ripple.DEFAULTS.spatial,  // px — wave amplitude is 1/e at this distance
    ripplePostHit:      Ripple.DEFAULTS.postHit,  // ms — exp decay after wavefront passes
    rippleEdge:         Ripple.DEFAULTS.edge,     // px — width of the swap band at the wavefront
    // Reveal layer — independent of effect. Three modes:
    //   'cursor' (default) — sticky proximity reveal, RevealLayer module
    //   'wave'             — reversible wave-driven dither, WaveReveal module
    //   any other value    — neither runs (still allows revealText to be set
    //                        without effect, e.g., for plugin-driven reveal)
    revealMode:      'cursor',
    revealText:      '',        // lower-layer string (1:1 to upper's visible chars); '' disables the feature
    revealColor:     '',        // CSS color the revealed glyph is pinned to; '' falls back to wakeColor
    // Cursor-mode tunables (RevealLayer)
    revealRadius:    60,        // px — chars within this distance of the cursor latch immediately
    revealFringe:    60,        // px — outer band beyond revealRadius; chars in here engage on first cursor entry
    revealImmediate: 0.25,      // 0..1 — fraction of fringe chars that flip immediately on engagement; rest get a delay
    revealDelayMs:   250,       // ms — upper bound of the per-char delay applied to non-immediate fringe chars (uniform 0..this)
    // Wave-mode tunables (WaveReveal) — also reuses rippleSpeed/Atten/PostHit/Edge above.
    revealHoldMs:    3000,      // ms — how long a wave-revealed char stays revealed past the last frame the wave was over its threshold
    // Redact effect — see Redact module above. Active when effect: 'redact'.
    // Visual is a CSS background bar painted on a per-char cover layer
    // (see Splitter banner) — no glyph swap, so redaction is layout- and
    // font-metric-neutral. The bar fills the original char's bounding box.
    redactRadius:       80,     // px — inner radius A; chars within this are always redacted
    redactFringe:       120,    // px — band width; outer radius B = A + this
    redactTurnoverMs:   500,    // ms — period between morphing swaps (default 2/sec)
    redactTurnoverFrac: 0.30,   // 0..1 — fraction of in-band redacted chars swapped per turn
    redactColor:        '',     // CSS color for the redact bar; '' falls back to currentColor (inherits text color)
    // Layout / DOM
    splitWords:  true,          // wrap whole words in inline-block (prevents mid-word wrap)
    remeasureOn: 'auto',        // 'auto' | 'manual'
    className:   'tr-char',     // base class for char spans
  };

  // Frozen rest target — returned when a char has no active influence so
  // the integrators have a known-zero state without per-char allocation.
  const REST = Object.freeze({ tx: 0, ty: 0, rot: 0, scale: 1, brightness: 0, scramble: 0, interior: false });

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
      this._ro = null;
      this._springAccum = 0;
      this._redactNextTurn = 0;
      this._destroyed = false;

      this._captureBaseColor();
      RevealLayer.attach(this._chars, this.options, element);
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
      const prevReveal      = this.options.revealText;
      const prevEffect      = this.options.effect;
      const prevRedactColor = this.options.redactColor;
      Object.assign(this.options, options);
      this._wakeCache = null;
      this._revealCache = null;
      // Reveal text changed (or `data-reveal` may now be the source) —
      // re-walk chars to refresh their `revealChar` assignments.
      if (this.options.revealText !== prevReveal) {
        RevealLayer.attach(this._chars, this.options, this.element);
      }
      // Effect switched away from 'redact' — Redact.tick won't run any
      // more, so any char still flagged redacted would stay covered
      // forever. Clear the state here; Renderer.cover will hide the
      // bar on the next frame's transition check.
      if (prevEffect === 'redact' && this.options.effect !== 'redact') {
        for (const c of this._chars) {
          c.redacted = false;
          c.redactZone = 0;
        }
      }
      // redactColor changed — re-apply to every cover element so the
      // next show transition picks up the new background. Done eagerly
      // so chars currently covered re-paint immediately.
      if (this.options.redactColor !== prevRedactColor) {
        const bg = this.options.redactColor || 'currentColor';
        for (const c of this._chars) c.coverEl.style.background = bg;
      }
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
      const wakeRgb = this._wakeCache.rgb;
      const wakeStr = this._wakeCache.str;
      const baseRgb = this._baseColorRgb || [200, 200, 200];

      const ctx = makeContext(now);
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

      for (const c of this._chars) {
        const target = evalCharTarget(c, ctx, effect, falloff, opts, isGlobal, rCutoffSq);

        Char.springStep(c, target.tx || 0, target.ty || 0, target.rot || 0,
                        typeof target.scale === 'number' ? target.scale : 1,
                        opts.spring, opts.damping, springSteps);
        Char.brightnessLerp(c, target.brightness || 0, opts.wakeAttack, opts.wakeDecay, dt);

        // Reveal: dispatch to whichever module is selected by revealMode.
        // 'cursor' (default) → RevealLayer (sticky proximity, with fringe timers)
        // 'wave'             → WaveReveal (reversible wave-driven dither)
        // any other value    → no reveal driver runs this frame
        let showLower = false;
        if (opts.revealMode === 'wave') {
          showLower = WaveReveal.tick(c, ctx, opts);
        } else if (opts.revealMode === 'cursor') {
          showLower = RevealLayer.showLower(c, ctx.mouseX, ctx.mouseY, opts, now);
        }

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
        // its original self the moment the cover lifts.
        const scrambleTarget = c.redacted ? 0 : (target.scramble || 0);
        const naturalGlyph   = showLower ? c.revealChar : c.originalChar;
        const lerpRgb = showLower && this._revealCache ? this._revealCache.rgb : wakeRgb;
        const lerpStr = showLower && this._revealCache ? this._revealCache.str : wakeStr;

        Renderer.transform(c);
        Renderer.colorAndGlow(c, baseRgb, lerpRgb, lerpStr);
        Renderer.glyph(c, scrambleTarget, now, opts, picker, naturalGlyph);
        Renderer.cover(c);
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
  // Ripple physics module is exposed so it can be used standalone — pass
  // any (charX, charY, time, stamps[, ...]) and get back wake amplitude,
  // independent of the rest of the framework.
  TextRippling.ripple       = Ripple;
  // RevealLayer is exposed for plugin authors that want to drive layer
  // assignment manually (skipping `revealText` / `data-reveal`) by
  // writing `c.revealChar` directly.
  TextRippling.revealLayer  = RevealLayer;
  // WaveReveal is exposed similarly — call .tick(c, ctx, opts) per char
  // per frame to drive a reversible wave-dithered reveal independently.
  TextRippling.waveReveal   = WaveReveal;
  // Redact is exposed for plugin authors that want to drive the
  // stochastic block redaction directly (skip Effects.redact dispatch).
  TextRippling.redact       = Redact;

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
    module.exports.ripple        = Ripple;
    module.exports.revealLayer   = RevealLayer;
    module.exports.waveReveal    = WaveReveal;
    module.exports.redact        = Redact;
    module.exports.version       = VERSION;
  }
}(typeof window !== 'undefined' ? window : globalThis));

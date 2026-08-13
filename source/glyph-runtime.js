import { REF_DT_MS } from './constants.js';
import { FeatureLifecycle } from './feature-lifecycle.js';
import { WordReveal } from './features/reveal.js';

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
      // Track this word's chars so we can stamp word membership onto
      // each Char after the word is fully built. The same array is
      // referenced from every member, so word-local lookups are O(1).
      const wordChars = [];
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
        const c = Char.create(span, ch, textEl, coverEl);
        c.indexInWord = wordChars.length;
        wordChars.push(c);
        chars.push(c);
      }
      // After the word is built, create a single shared per-word
      // state record and attach it to every member char. Both
      // RevealLayer and WaveReveal read state from this object via
      // `c.wordState` rather than tracking per-char animation timers.
      const wordState = WordReveal.makeWord(wordChars);
      for (let i = 0; i < wordChars.length; i++) wordChars[i].wordState = wordState;
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
  // Intrinsic fields only — fields owned by an optional module are
  // populated by that module's initChar(c) hook (called below).
  // Adding a new module should not require editing this method.
  create(el, originalChar, textEl, coverEl) {
    const c = {
      el,
      // Two-layer split (see Splitter banner): textEl carries the
      // glyph and owns the slot's layout dimensions; coverEl is the
      // absolutely-positioned redact bar painted on top.
      textEl,
      coverEl,
      // Word membership — populated by Splitter after each whole word
      // is built. `wordState` is the shared per-word state object
      // (see WordReveal banner) referenced by all sibling chars in
      // the same word; `indexInWord` is this char's position in that
      // word. Both REVEAL and WAVE-REVEAL modes use this to drive
      // word-level activation with per-char animation timing.
      wordState: null,
      indexInWord: 0,
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
      // Per-frame Ripple.compute memo. wordWaveFrame populates this
      // when it runs (wave / bloom-ripple modes); Effects.ripple checks
      // _rippleStashFrame === ctx.frameId before recomputing. Pre-init
      // both fields so V8 keeps the Char shape monomorphic.
      _rippleStash: null,
      _rippleStashFrame: -1,
    };
    // Per-module field hand-off. The lifecycle owns the fixed order;
    // each feature's public initChar hook still owns its own fields.
    FeatureLifecycle.initChar(c);
    return c;
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

// Shared lit-branch math: clamp brightness, smoothstep-fade the
// bottom 0..fadeStart range to kill the sqrt() step at the lit cutoff,
// sqrt-ramp for perceptual linearity, then write the per-component RGB
// lerp + matching textShadow directly to the el. Used by both
// colorAndGlow (base→wake) and colorAndGlowBloom (reveal→wake) — same
// math, different endpoints.
function writeLitColor(el, brightness, fromRgb, toRgb, wakeStr) {
  const b = brightness > 1 ? 1 : brightness;
  const fadeStart = 0.05;
  let fade;
  if (b >= fadeStart) fade = 1;
  else { const u = b / fadeStart; fade = u * u * (3 - 2 * u); }
  const t = Math.sqrt(b) * fade;
  const r = (fromRgb[0] + (toRgb[0] - fromRgb[0]) * t) | 0;
  const g = (fromRgb[1] + (toRgb[1] - fromRgb[1]) * t) | 0;
  const bl = (fromRgb[2] + (toRgb[2] - fromRgb[2]) * t) | 0;
  el.style.color = `rgb(${r},${g},${bl})`;
  el.style.textShadow = `0 0 ${(b * 14 * fade).toFixed(2)}px rgba(${wakeStr},${(b * 0.85 * fade).toFixed(3)})`;
}

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

    // Lit branch: ramp base→wake by brightness via writeLitColor (the
    // sqrt + smoothstep math is shared with colorAndGlowBloom — see
    // its banner above the helper for the curve rationale).
    const lit = c.bright > 0.005;
    if (lit) {
      writeLitColor(c.el, c.bright, baseRgb, wakeRgb, wakeRgbStr);
      c.wasLit = true;
    } else if (c.wasLit) {
      c.el.style.color = '';
      c.el.style.textShadow = '';
      c.bright = 0;
      c.wasLit = false;
    }
  },

  // BloomRipple-mode color writer. Replaces the discrete pin behavior of
  // colorAndGlow with a brightness-modulated lerp specifically targeted
  // at revealed chars — the user wants ripple to "stylize" the revealed
  // text, not blink past it as a hard switch. Three states the writer
  // produces, mirroring the BloomRipple banner's color contract:
  //
  //   !revealed                  →  CSS color (no inline style; the
  //                                 cover layer is the dark-gray base)
  //   revealed, bright ≈ 0       →  static at revealRgb (medium gray)
  //   revealed, bright > 0       →  lerp from revealRgb toward wakeRgb
  //                                 with the same gamma + fade-out
  //                                 curves as colorAndGlow
  //
  // Reuses c.colorPinned as a "have I written an explicit color this
  // session" latch so we only touch the DOM on transitions. c.wasLit
  // tracks whether the last write was the lerp (vs the static reveal
  // color) so we can fall back cleanly when ripple amplitude decays.
  colorAndGlowBloom(c, revealRgb, wakeRgb, wakeRgbStr) {
    if (!c.revealed) {
      // Cover state: drop any inline color so the CSS-default cover
      // color shows through. Reset the latches so the next reveal
      // re-paints from scratch.
      if (c.wasLit || c.colorPinned) {
        c.el.style.color = '';
        c.el.style.textShadow = '';
        c.bright = 0;
        c.wasLit = false;
        c.colorPinned = false;
      }
      return;
    }

    const lit = c.bright > 0.005;
    if (lit) {
      // Lit branch: ramp reveal→wake by brightness via writeLitColor
      // (shared math with colorAndGlow — only the endpoints differ).
      writeLitColor(c.el, c.bright, revealRgb, wakeRgb, wakeRgbStr);
      c.wasLit = true;
      c.colorPinned = true;
    } else if (c.wasLit || !c.colorPinned) {
      // Settle to the static reveal color (gray). Two trigger paths:
      // (a) just transitioned out of the lit lerp (c.wasLit), or
      // (b) just freshly revealed (c.colorPinned still false from cover).
      c.el.style.color = `rgb(${revealRgb[0]},${revealRgb[1]},${revealRgb[2]})`;
      c.el.style.textShadow = '';
      c.bright = 0;
      c.wasLit = false;
      c.colorPinned = true;
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

export { Char, Renderer, Splitter, writeLitColor };

import { BurnReveal } from './features/burn-reveal.js';
import { BloomRipple, RevealLayer, WaveReveal } from './features/reveal.js';
import { Renderer, writeLitColor } from './glyph-runtime.js';
import { Ripple } from './ripple.js';

// ════════════════════════════════════════════════════════════════════
//  Reveal mode strategy table. Each entry bundles (a) the per-frame
//  word orchestrator, (b) the per-char color writer that pairs with
//  it, (c) the resting-glyph resolver, and (d) the scramble gate.
//  _tick looks up one bundle by `opts.revealMode` and dispatches
//  through it — adding a new mode means adding one entry here, not
//  threading parallel if-ladders through _tick.
//
//  The mode→writer pairing was previously implicit (a `isBloomRipple`
//  flag in _tick chose the writer), which left it possible to add a
//  new mode and forget to wire its writer. Bundling makes the
//  coupling explicit.
//
//  Color writer signature: (c, x) where x is a per-frame ctx with
//  resolved color endpoints — baseRgb, wakeRgb, wakeStr, revealRgb,
//  revealStr (revealRgb/Str fall back to wakeRgb/Str when revealColor
//  is unset) — plus emberRgb/emberStr/emberHotRgb (burn mode), the
//  frame time, and the options bag. Writers internally derive any
//  per-char state they need.
// ════════════════════════════════════════════════════════════════════

// Default writer — paired with cursor and wave modes. Picks lerp
// endpoint per char based on whether the lower (reveal) layer is
// currently shown for that char.
function defaultColorWriter(c, x) {
  const showLower = c.revealed && c.revealChar != null;
  const lerpRgb = showLower ? x.revealRgb : x.wakeRgb;
  const lerpStr = showLower ? x.revealStr : x.wakeStr;
  Renderer.colorAndGlow(c, x.baseRgb, lerpRgb, lerpStr);
}

// Bloom writer — paired with bloom-ripple. Always lerps revealed
// chars from revealRgb (static gray) toward wakeRgb (ripple peak).
// Unrevealed chars are handled inside colorAndGlowBloom (cover state,
// no inline style).
function bloomColorWriter(c, x) {
  Renderer.colorAndGlowBloom(c, x.revealRgb, x.wakeRgb, x.wakeStr);
}

// Burn writer — paired with burn. Two hot states precede the
// bloom-ripple contract:
//   unburned, heat > 0  → cover→ember ramp by heat (the brightening
//                          edge; writeLitColor gives the same gamma +
//                          glow curve as every other lit path)
//   burned, cooling     → white-hot ember flash decaying to
//                          revealColor over burnCoolMs
//   burned, settled     → Renderer.colorAndGlowBloom — identical
//                          styling to bloom-ripple (static gray at
//                          rest, ripple washes toward wakeColor)
function burnColorWriter(c, x) {
  if (!c.revealed) {
    if (c.burnHeat > 0.01) {
      writeLitColor(c.el, c.burnHeat, x.baseRgb, x.emberRgb, x.emberStr);
      c.wasLit = true;
      c.colorPinned = true;
    } else if (c.wasLit || c.colorPinned) {
      // Cooled back to cover — drop inline styles so CSS color shows.
      c.el.style.color = '';
      c.el.style.textShadow = '';
      c.wasLit = false;
      c.colorPinned = false;
    }
    return;
  }
  const age = x.time - c.burnedAt;
  if (age < x.opts.burnCoolMs) {
    // Leaving c.wasLit set hands off cleanly below: colorAndGlowBloom's
    // wasLit branch settles the char to the static revealRgb.
    writeLitColor(c.el, 1 - age / x.opts.burnCoolMs, x.revealRgb, x.emberHotRgb, x.emberStr);
    c.wasLit = true;
    c.colorPinned = true;
    return;
  }
  Renderer.colorAndGlowBloom(c, x.revealRgb, x.wakeRgb, x.wakeStr);
}

// Per-mode resting-glyph resolvers — which char textEl settles on when
// not actively scrambling. The default shows the lower layer only for
// revealed chars; burn INVERTS the relationship (the procedural mask
// covers unrevealed chars, the element's own char is the payload).
function defaultNaturalGlyph(c) {
  return c.revealed && c.revealChar != null ? c.revealChar : c.originalChar;
}
function burnNaturalGlyph(c) {
  return c.revealed ? c.originalChar : (c.maskGlyph || c.originalChar);
}

// Per-mode scramble gates. Burn must suppress effect-driven scramble
// on masked chars: pickers derive from c.originalChar, so a wavefront
// case-flip would flash the hidden payload through the mask.
function scrambleAlways() { return true; }
function scrambleRevealedOnly(c) { return c.revealed; }

const REVEAL_MODES = {
  'cursor':       { frame: RevealLayer.frame, colorWriter: defaultColorWriter, naturalGlyph: defaultNaturalGlyph, scrambleOk: scrambleAlways },
  'wave':         { frame: WaveReveal.frame,  colorWriter: defaultColorWriter, naturalGlyph: defaultNaturalGlyph, scrambleOk: scrambleAlways },
  'bloom-ripple': { frame: BloomRipple.frame, colorWriter: bloomColorWriter,   naturalGlyph: defaultNaturalGlyph, scrambleOk: scrambleAlways },
  'burn':         { frame: BurnReveal.frame,  colorWriter: burnColorWriter,    naturalGlyph: burnNaturalGlyph,    scrambleOk: scrambleRevealedOnly },
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
  // Reveal layer — independent of effect. All three modes are word-level
  // (see WordReveal banner): touching any char activates its whole
  // word and the word blooms outward letter-by-letter from the
  // cursor-closest anchor. Settings:
  //   'cursor' (default) — sticky proximity reveal (RevealLayer)
  //   'wave'             — reversible wave-driven (WaveReveal)
  //   'bloom-ripple'     — sticky wave-driven bloom; pair with
  //                        effect: 'ripple' to stylize revealed words
  //                        (BloomRipple + Renderer.colorAndGlowBloom)
  //   'burn'             — paper-burn reveal of the element's OWN text
  //                        from under a twinkling procedural mask
  //                        (BurnReveal; char-level, ignores revealText;
  //                        pair with effect: 'ripple' for the styling)
  //   any other value    — none runs (still allows revealText to be set
  //                        without effect, e.g., for plugin-driven reveal)
  revealMode:      'cursor',
  revealText:      '',        // lower-layer string (1:1 to upper's visible chars); '' disables the feature
  revealColor:     '',        // CSS color the revealed glyph is pinned to; '' falls back to wakeColor
  revealRadius:     60,       // px — chars within this distance of the cursor count as touched
  revealHoldMs:     3000,     // ms — wave mode: how long a word stays active past its last touched frame
  revealWordStepMs: 30,       // ms — per-char step for the outward bloom (and inverse-collapse) within a word
  // Burn reveal — see BurnReveal module above. Active when revealMode:
  // 'burn'. Physical constants are owned by BurnReveal.DEFAULTS and
  // mirrored here under prefixed names (same pattern as ripple*).
  burnRadius:       BurnReveal.DEFAULTS.radius,       // px — cursor ignition reach
  burnRate:         BurnReveal.DEFAULTS.rate,         // heat/s at cursor center
  burnSmolderRate:  BurnReveal.DEFAULTS.smolderRate,  // heat/s — self-burn + neighbor radiation scale
  burnSmolderReach: BurnReveal.DEFAULTS.smolderReach, // px — radiation reach of a burning char
  burnIgnite:       BurnReveal.DEFAULTS.ignite,       // 0..1 — kindling point; past it a char always completes
  burnCoolMs:       BurnReveal.DEFAULTS.coolMs,       // ms — ember flash after combustion
  burnEmberColor:   BurnReveal.DEFAULTS.emberColor,   // CSS color of the burning edge
  burnTwinkleMs:    BurnReveal.DEFAULTS.twinkleMs,    // ms — mean mask re-roll interval
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

export {
  DEFAULTS,
  REVEAL_MODES,
  bloomColorWriter,
  burnColorWriter,
  defaultColorWriter,
  defaultNaturalGlyph,
  scrambleAlways,
};

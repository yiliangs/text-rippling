import { BurnReveal } from './features/burn-reveal.js';
import { Ripple } from './ripple.js';

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

export { DEFAULTS };

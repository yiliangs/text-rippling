import { RippleSampler } from '../ripple-sampler.js';

// ════════════════════════════════════════════════════════════════════
//  WordReveal — shared word-level reveal orchestration.
//
//  Both RevealLayer (cursor mode, sticky) and WaveReveal (wave mode,
//  reversible) sit on top of this module. The activation/deactivation
//  unit is the WORD; per-char `c.revealed` is derived from the word's
//  state plus this char's distance from the word's anchor letter.
//
//  Why: a per-char activation model with a separate cascade
//  choreography leaks orphan-letter artifacts when the cursor doubles
//  back — a returning wave can re-activate scattered letters mid-
//  collapse while others continue un-revealing per their stale
//  schedule. Word-level state with derived per-char render guarantees
//  any active phase keeps already-revealed chars revealed (only
//  flips false → true), and any collapse phase only flips true →
//  false. Re-activation simply latches: existing revealed chars stay
//  revealed; chars that had un-revealed re-bloom from the new anchor.
//
//  Per-word state object (created by Splitter, shared by all sibling
//  chars via `c.wordState`):
//
//    chars              — Char[] members of the word
//    active             — boolean: in ACTIVE phase
//    activatedAt        — timestamp the current ACTIVE phase began
//    anchorIdx          — index in chars[] of the activator letter
//    collapseAt         — 0 or timestamp the COLLAPSING phase began
//    lastTouchedAt      — most recent frame any char was touched
//    maxDistFromAnchor  — max |i - anchorIdx| across word, set on activation
//    _touchedThisFrame  — per-frame scratch: any char touched this frame?
//    _anchorCandidate*  — per-frame scratch: closest-to-cursor candidate
//
//  Animation rules (per char per frame, applied by applyChar):
//
//    active   →  c.revealed = c.revealed || (now >= activatedAt + dist*stepMs)
//    collapse →  c.revealed = c.revealed && (now <  collapseAt + (maxDist - dist)*stepMs)
//    idle     →  c.revealed = false
//
//  Active phase only flips chars false→true; collapse only true→false.
//  This is the key invariant that keeps back-and-forth tracks clean.
//
//  Anchor selection: on word activation, the cursor-closest touched
//  char becomes the anchor. Anchor is locked while word is active —
//  subsequent touches refresh `lastTouchedAt` but don't move the
//  anchor. A re-activation after collapse picks a fresh anchor.
// ════════════════════════════════════════════════════════════════════

const WordReveal = {
  // Construct a fresh per-word state record. Splitter calls this once
  // per word, then attaches the resulting object to every member char
  // via `c.wordState` (shared reference).
  makeWord(chars) {
    return {
      chars,
      active: false,
      activatedAt: 0,
      anchorIdx: 0,
      collapseAt: 0,
      lastTouchedAt: 0,
      maxDistFromAnchor: 0,
      // Per-frame scratch — reset by resetScratch() at frame start.
      _touchedThisFrame: false,
      _anchorCandidateIdx: -1,
      _anchorCandidateDistSq: Infinity,
    };
  },

  // Reset per-frame scratch fields. Caller should invoke once per word
  // per frame, before any touch() calls for that frame.
  resetScratch(w) {
    w._touchedThisFrame = false;
    w._anchorCandidateIdx = -1;
    w._anchorCandidateDistSq = Infinity;
  },

  // Mark a char as touched this frame; track closest-to-cursor as the
  // anchor candidate (used only if the word activates this frame —
  // already-active words keep their existing anchor).
  touch(c, distSqToCursor) {
    const w = c.wordState;
    if (!w) return;
    w._touchedThisFrame = true;
    if (distSqToCursor < w._anchorCandidateDistSq) {
      w._anchorCandidateDistSq = distSqToCursor;
      w._anchorCandidateIdx = c.indexInWord;
    }
  },

  // Per-word state transition. Caller invokes once per word per frame
  // after all touch() calls. `sticky=true` skips the active→collapse
  // transition (RevealLayer's lottery-ticket model).
  tickWord(w, now, holdMs, sticky) {
    if (w._touchedThisFrame) {
      w.lastTouchedAt = now;
      if (!w.active) {
        w.active = true;
        w.activatedAt = now;
        w.anchorIdx = w._anchorCandidateIdx;
        w.collapseAt = 0;
        const a = w.anchorIdx;
        const n = w.chars.length;
        w.maxDistFromAnchor = a > n - 1 - a ? a : n - 1 - a;
      }
    } else if (!sticky && w.active && w.lastTouchedAt + holdMs <= now) {
      w.active = false;
      w.collapseAt = now;
    }
  },

  // Per-char render. Latches c.revealed via the active/collapse rules
  // documented in the banner above. Caller invokes once per char per
  // frame after tickWord has settled the per-word state.
  applyChar(c, now, stepMs) {
    const w = c.wordState;
    if (!w) { c.revealed = false; return; }
    const di = c.indexInWord - w.anchorIdx;
    const dist = di < 0 ? -di : di;
    if (w.active) {
      if (!c.revealed && now >= w.activatedAt + dist * stepMs) c.revealed = true;
    } else if (w.collapseAt > 0) {
      const remain = w.collapseAt + (w.maxDistFromAnchor - dist) * stepMs;
      if (c.revealed && now >= remain) c.revealed = false;
    } else {
      c.revealed = false;
    }
  },

  // Reset a word's persistent state to IDLE. Called by RevealLayer.attach
  // when the reveal text changes (a fresh start should clear any
  // active/collapsing animation in progress).
  resetWord(w) {
    w.active = false;
    w.activatedAt = 0;
    w.anchorIdx = 0;
    w.collapseAt = 0;
    w.lastTouchedAt = 0;
    w.maxDistFromAnchor = 0;
  },
};

// ════════════════════════════════════════════════════════════════════
//  RevealLayer — optional two-layer text overlay (cursor mode).
//
//  Pairs each visible char with a counterpart from a "lower" string,
//  supplied via `options.revealText` or a `data-reveal` attribute on
//  the host element. Activation is purely cursor-proximity driven —
//  no wave physics, no diffusion, no shared state with any effect.
//
//  Trigger: when ANY char in a word is within `revealRadius` of the
//  cursor, the word activates with the cursor-closest touched char as
//  the anchor. The whole word then blooms outward letter-by-letter
//  per `revealWordStepMs`. Sticky — once activated, words never
//  collapse for the lifetime of the instance (lottery-ticket model).
//
//  Color is pinned discretely via Renderer.colorAndGlow when
//  `c.revealed` is true; no brightness modulation, no two-state ramp.
//
//  No setup → no behavior. With nothing in `revealText` and no
//  `data-reveal` attribute, `frame` does nothing and the module is
//  effectively absent.
// ════════════════════════════════════════════════════════════════════

const RevealLayer = {
  // Per-char field ownership. The per-word state lives on `c.wordState`
  // (intrinsic, populated by Splitter); this module owns only the
  // chars' lower-layer glyph + pinned-color latch.
  //
  //   revealChar   — null | string : lower-layer glyph (set by attach)
  //   revealed     — boolean       : derived per frame by WordReveal
  //   colorPinned  — boolean       : renderer-side latch paired with revealed
  initChar(c) {
    c.revealChar = null;
    c.revealed = false;
    c.colorPinned = false;
  },

  // Lifecycle hook: react to options changes from TextRippling.update().
  // Owned cleanup logic lives here, not in update(), so adding a new
  // reveal-related option doesn't require editing the façade.
  onUpdate(prev, curr, chars, element) {
    if (curr.revealText !== prev.revealText) {
      RevealLayer.attach(chars, curr, element);
    }
  },

  // Walk chars[] and fill `revealChar` per visible position. Sources
  // (in priority order):
  //   1. `opts.revealText` (string)
  //   2. `element.dataset.reveal` (HTML `data-reveal="..."` fallback)
  //   3. neither — feature is off; all `revealChar` set to null
  // Length policy: short reveal pads with null (no swap on the tail —
  // upper still shows there); long reveal is truncated to chars.length.
  // Spaces in the reveal string are stripped so the mapping aligns
  // with Splitter's visible-char-only chars[] (Splitter doesn't emit
  // spans for whitespace either). Also resets every word's state to
  // IDLE so a fresh reveal text starts cleanly.
  attach(chars, opts, element) {
    let raw = opts.revealText;
    if (!raw && element && element.dataset && element.dataset.reveal) {
      raw = element.dataset.reveal;
    }
    const lower = [];
    if (raw) {
      for (const ch of Array.from(raw)) {
        if (!/\s/.test(ch)) lower.push(ch);
      }
    }
    const seenWords = new Set();
    for (let i = 0; i < chars.length; i++) {
      chars[i].revealChar = raw && i < lower.length ? lower[i] : null;
      chars[i].revealed = false;
      const w = chars[i].wordState;
      if (w && !seenWords.has(w)) { seenWords.add(w); WordReveal.resetWord(w); }
    }
  },

  // Per-frame orchestrator (cursor mode, sticky). Runs three passes:
  //   1. touch detection — any char within `revealRadius` of cursor
  //      marks its word as touched, with the cursor-closest char
  //      becoming the anchor candidate.
  //   2. word state transition (sticky → never collapses; tickWord
  //      with sticky=true only handles the IDLE→ACTIVE direction).
  //   3. per-char render — c.revealed latched via WordReveal.applyChar.
  //
  // Module-private scratch Set tracks per-frame "words seen", used to
  // dedupe and to limit tickWord calls to words actually present.
  frame(chars, ctx, opts) {
    const stepMs = opts.revealWordStepMs;
    const innerR = opts.revealRadius;
    const innerRSq = innerR * innerR;
    _wordScratch.clear();

    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c.revealChar == null) { c.revealed = false; continue; }
      const w = c.wordState;
      if (!w) continue;
      if (!_wordScratch.has(w)) { WordReveal.resetScratch(w); _wordScratch.add(w); }
      const dx = c.hx - ctx.mouseX;
      const dy = c.hy - ctx.mouseY;
      const distSq = dx * dx + dy * dy;
      if (distSq < innerRSq) WordReveal.touch(c, distSq);
    }

    for (const w of _wordScratch) WordReveal.tickWord(w, ctx.time, Infinity, true);

    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c.revealChar == null) continue;
      WordReveal.applyChar(c, ctx.time, stepMs);
    }
  },
};

// Module-private scratch Set, reused frame-to-frame to avoid per-frame
// allocation. RevealLayer.frame and wordWaveFrame (the shared core
// behind WaveReveal and BloomRipple) both borrow it during their own
// pass — they don't run concurrently (revealMode dispatch is
// single-mode per instance per frame).
const _wordScratch = new Set();

// ════════════════════════════════════════════════════════════════════
//  wordWaveFrame — shared three-pass orchestrator behind both
//  WaveReveal (sticky=false) and BloomRipple (sticky=true).
//
//  Same shape as RevealLayer.frame: touch → tickWord → applyChar. The
//  touch predicate is cursor proximity OR wave amplitude > c.seed
//  (per the WaveReveal banner below). The two modules differ only in
//  the (sticky, holdMs) pair handed to WordReveal.tickWord — sticky
//  freezes the active→collapse transition, holdMs sets the idle
//  window for the non-sticky path.
// ════════════════════════════════════════════════════════════════════

function wordWaveFrame(chars, ctx, opts, sticky, holdMs) {
  const stepMs = opts.revealWordStepMs;
  const innerR = opts.revealRadius;
  const innerRSq = innerR * innerR;
  _wordScratch.clear();

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c.revealChar == null) { c.revealed = false; continue; }
    const w = c.wordState;
    if (!w) continue;
    if (!_wordScratch.has(w)) { WordReveal.resetScratch(w); _wordScratch.add(w); }

    const dx = c.hx - ctx.mouseX;
    const dy = c.hy - ctx.mouseY;
    const distSq = dx * dx + dy * dy;

    let touched = distSq < innerRSq;
    if (!touched) {
      // Stash the result so Effects.ripple (when paired with this
      // mode, e.g. bloom-ripple's effect: 'ripple') can reuse it
      // instead of paying the per-stamp loop a second time. Note:
      // when the char is inside cursor proximity (touched=true here)
      // we skip the call entirely — Effects.ripple will recompute
      // for that handful of chars, which is negligible vs the bulk.
      const r = RippleSampler.sampleForReveal(c, ctx, opts);
      if (r && r.brightness > c.seed) touched = true;
    }
    if (touched) WordReveal.touch(c, distSq);
  }

  for (const w of _wordScratch) WordReveal.tickWord(w, ctx.time, holdMs, sticky);

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c.revealChar == null) continue;
    WordReveal.applyChar(c, ctx.time, stepMs);
  }
}

// ════════════════════════════════════════════════════════════════════
//  WaveReveal — reversible wave-driven dithered two-layer overlay
//               with word-level activation.
//
//  Sibling to RevealLayer. Same two-layer setup (revealChar per Char,
//  revealColor as the pinned destination) and the same renderer hookup
//  (Renderer.colorAndGlow's c.revealed branch handles both pin AND
//  unpin transitions). DIFFERENCES from RevealLayer:
//
//    RevealLayer  → cursor proximity, sticky (no collapse).
//    WaveReveal   → cursor proximity OR wave amplitude > c.seed,
//                   reversible — word collapses back after holdMs of
//                   no touch.
//
//  Both use the shared WordReveal module: per-word activation/collapse
//  state plus per-char animation derived from word state + distance
//  from the word's anchor letter. See the WordReveal banner above.
//
//  Touch criteria (per char per frame):
//    1. distance to cursor < `revealRadius`  →  touched (always-flip
//       core; ensures sub-frame amplitude peaks under the cursor
//       can never be missed even if the per-char seed is high).
//    2. wave amplitude (Ripple.compute) > c.seed → touched (the
//       per-char seed gives the dither — a wave at half amplitude
//       touches roughly half the chars in its reach).
//
//  Any touched char in a word marks the word as touched-this-frame.
//  The cursor-closest touched char becomes the activation anchor.
//  Word stays active while any of its chars is touched any frame
//  within `revealHoldMs`; after that idle window the word collapses,
//  letters un-revealing furthest-from-anchor first.
//
//  Why word-level: a per-char activation model with a separate cascade
//  schedule leaks orphan-letter artifacts when the cursor doubles
//  back over a word mid-collapse. Word-level state plus the WordReveal
//  latching rules guarantee no orphan letters — re-activation just
//  means already-revealed chars stay revealed and the word continues
//  to bloom from the new anchor.
//
//  Reuses ripple physics options (rippleSpeed, rippleSpatialAtten,
//  ripplePostHit, rippleEdge) so the wave's character matches what
//  the standard `ripple` effect would produce.
// ════════════════════════════════════════════════════════════════════

const WaveReveal = {
  frame(chars, ctx, opts) {
    wordWaveFrame(chars, ctx, opts, false, opts.revealHoldMs);
  },
};

// ════════════════════════════════════════════════════════════════════
//  BloomRipple — wave-driven sticky bloom layered with ripple styling.
//
//  Composition of two existing systems, run in sequence per char:
//
//    Phase 1 (this module): word-level activation using the same touch
//    criteria as WaveReveal (cursor proximity OR wave amplitude > c.seed)
//    and the same WordReveal bloom mechanic. STICKY — once a word is
//    revealed, its chars stay revealed; tickWord is called with sticky=true
//    so the COLLAPSING transition is skipped entirely.
//
//    Phase 2 (Effects.ripple, set by user as `effect: 'ripple'`): the
//    ordinary ripple physics drives c.bright per char from the wave
//    amplitude history. Renderer.colorAndGlowBloom (paired with this
//    mode by FrameEngine) then lerps revealed chars from `revealColor`
//    (static gray) toward `wakeColor` (ripple peak white). Unrevealed
//    chars stay at the CSS cover color and ignore c.bright entirely.
//
//  Color contract:
//    - unrevealed         → CSS color (cover, e.g. dark gray)
//    - revealed, idle     → opts.revealColor (e.g. medium gray)
//    - revealed, ripple   → lerp from revealColor toward wakeColor
//
//  This keeps the static-revealed state visually distinct from the
//  ripple peak — the user picks gray for `revealColor` so peaks at
//  white read as wave activity, not as "this letter just appeared".
//
//  Frame body delegates to wordWaveFrame; the only difference from
//  WaveReveal is the sticky=true / holdMs=Infinity pair.
// ════════════════════════════════════════════════════════════════════

const BloomRipple = {
  frame(chars, ctx, opts) {
    wordWaveFrame(chars, ctx, opts, true, Infinity);
  },
};

export { BloomRipple, RevealLayer, WaveReveal, WordReveal };

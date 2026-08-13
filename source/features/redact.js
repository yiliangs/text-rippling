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
  // Per-char field ownership: this module is responsible for these
  // three Char fields, populated by Char.create via initChar.
  //
  //   redacted    — boolean : currently rendered as the cover bar
  //   redactZone  — 0/1/2  : 0=outside, 1=core, 2=band (entry detection)
  //   coverShown  — boolean : renderer-side latch for Renderer.cover
  initChar(c) {
    c.redacted = false;
    c.redactZone = 0;
    c.coverShown = false;
  },

  // Lifecycle hook: react to options changes from TextRippling.update().
  //   - Effect switched away from 'redact' → clear per-char state so
  //     Renderer.cover hides any still-shown bars on the next tick.
  //   - redactColor changed → re-paint every cover element so chars
  //     currently covered show the new color immediately.
  onUpdate(prev, curr, chars) {
    if (prev.effect === 'redact' && curr.effect !== 'redact') {
      for (const c of chars) {
        c.redacted = false;
        c.redactZone = 0;
      }
    }
    if (curr.redactColor !== prev.redactColor) {
      const bg = curr.redactColor || 'currentColor';
      for (const c of chars) c.coverEl.style.background = bg;
    }
  },

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

export { Redact };

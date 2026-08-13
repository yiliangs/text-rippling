// ════════════════════════════════════════════════════════════════════
//  BurnReveal — paper-burn reveal over a twinkling ASCII mask ('burn').
//
//  Inverts the family's authoring contract: the other reveal modes
//  treat the element's HTML as the visible surface and `revealText` /
//  `data-reveal` as the hidden layer, but here the surface is
//  PROCEDURAL — every char is covered by a random glyph drawn from
//  `glyphPool` — so the element's own text IS the hidden payload and
//  `revealText` is not consulted. (Side benefit: the real prose stays
//  in the DOM for copy/paste, screen readers, and search.)
//
//  Three cooperating behaviors:
//
//  1. TWINKLE — unburned mask glyphs re-roll at slow randomized
//     intervals (mean `burnTwinkleMs`), like stars; the hotter a
//     char gets, the faster it flickers.
//
//  2. BURN — a per-char heat scalar in [0,1], integrated per frame
//     from two inputs:
//       cursor  : heat/s = burnRate · prox^FOCUS inside burnRadius —
//                 chars under the pointer combust near-instantly,
//                 chars at the fringe only warm up.
//       smolder : chars at/above `burnIgnite` (the kindling point)
//                 self-sustain at the full smolder rate and radiate
//                 to neighbors within `burnSmolderReach`.
//     There is NO extinction: once anything is burning, the front
//     keeps creeping — however slowly — until it runs out of
//     reachable text. `burnIgnite` is the point of no return; below
//     it a char cools back off when nothing within reach is
//     radiating (a grazed char glows faintly and fades; one the
//     fire reaches inevitably completes). Heat reaching 1 is
//     permanent (paper doesn't unburn) — the char latches
//     c.revealed and shows its own glyph.
//
//  3. BLOOM-RIPPLE ADOPTION — burned chars join the bloom-ripple
//     color contract (static `revealColor` at rest, lerped toward
//     `wakeColor` by ripple brightness — pair with effect: 'ripple').
//     FrameEngine's dedicated burn writer prepends two hot
//     states: cover→ember by heat while burning, then an ember→
//     revealColor cooling flash over `burnCoolMs` right after
//     combustion. Chars still cooling also keep radiating, which is
//     how a fully burned char hands the fire onward.
//
//  Mask glyphs are swapped in-slot (same caveat as scramble, but
//  persistent): proportional fonts jitter layout — use monospace.
//
//  Char fields owned (via initChar): burnHeat, burnedAt, maskGlyph,
//  nextTwinkle. Also drives the shared c.revealed latch.
// ════════════════════════════════════════════════════════════════════

const BurnReveal = {
  // Physical tuning constants — DEFAULTS mirrors these under `burn*`
  // keys so the numbers are owned in one place (same pattern as Ripple).
  DEFAULTS: {
    radius:       90,        // px — cursor ignition reach
    rate:         6,         // heat/s at cursor center (heat 1 = burned through)
    smolderRate:  0.35,      // heat/s — self-burn past ignition; also scales neighbor radiation.
                             // Sets the front's creep speed (~1-2 chars/s at default): the
                             // "microburn" pace at which the fire eats on after the cursor leaves
    smolderReach: 40,        // px — radiation reach; must clear one line-height to spread vertically
    ignite:       0.22,      // heat threshold — below: warmth cools off; at/above: self-sustains
    coolMs:       700,       // ms — post-combustion ember flash; char keeps radiating during it
    emberColor:   '#ff9a3c', // CSS color of the burning edge
    twinkleMs:    2400,      // ms — mean interval between mask glyph re-rolls
  },

  // Internal constants (not knobs).
  COOL_RATE: 0.3,  // heat/s lost when nothing is feeding a sub-ignition char
  FOCUS:     2.2,  // cursor proximity exponent — "way faster" close to the flame
  MAX_DT:    50,   // ms — per-frame integration clamp (tab-switch dt spikes)

  // Per-char field ownership (see Char.create hand-off).
  initChar(c) {
    c.burnHeat = 0;
    c.burnedAt = 0;
    c.maskGlyph = null;
    c.nextTwinkle = 0;
  },

  // (Re)start the mode: reset burn state and mask every char NOW —
  // waiting for the first tick would flash one frame of the payload
  // text. Called from the constructor and on revealMode switches.
  attach(chars, opts) {
    for (const c of chars) {
      c.burnHeat = 0;
      c.burnedAt = 0;
      c.revealed = false;
      c.maskGlyph = burnMaskGlyph(opts.glyphPool, null);
      c.nextTwinkle = 0; // frame() staggers the first re-roll
      c.textEl.textContent = c.maskGlyph;
    }
  },

  // Lifecycle hook for TextRippling.update() — mask on entry; on exit
  // clear the burn state so revealed latches don't leak into the next
  // mode's writer (the new mode's naturalGlyph resolver restores the
  // original glyphs on its first tick).
  onUpdate(prev, curr, chars) {
    if (prev.revealMode !== 'burn' && curr.revealMode === 'burn') {
      BurnReveal.attach(chars, curr);
    } else if (prev.revealMode === 'burn' && curr.revealMode !== 'burn') {
      for (const c of chars) {
        c.burnHeat = 0;
        c.burnedAt = 0;
        c.revealed = false;
      }
    }
  },

  // Per-frame orchestrator. Two passes:
  //   1. bucket radiators (burning chars + fresh embers) into a coarse
  //      grid, pitch = smolderReach, so the neighbor query in pass 2
  //      touches only the 9 surrounding cells;
  //   2. per unburned char: integrate cursor + smolder heat, handle
  //      ignition/cooling/completion, and run the twinkle.
  frame(chars, ctx, opts) {
    const now = ctx.time;
    const dt = ctx.dt < BurnReveal.MAX_DT ? ctx.dt : BurnReveal.MAX_DT;
    const R = opts.burnRadius;
    const RSq = R * R;
    const reach = opts.burnSmolderReach;
    const reachSq = reach * reach;
    const ignite = opts.burnIgnite;
    const kCursor = (opts.burnRate / 1000) * dt;
    const kSmolder = (opts.burnSmolderRate / 1000) * dt;
    const kCool = (BurnReveal.COOL_RATE / 1000) * dt;

    _burnGrid.clear();
    let radiators = 0;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const radiating = c.revealed
        ? now - c.burnedAt < opts.burnCoolMs
        : c.burnHeat >= ignite;
      if (!radiating) continue;
      const key = ((c.hx / reach) | 0) * 8192 + ((c.hy / reach) | 0);
      const bucket = _burnGrid.get(key);
      if (bucket) bucket.push(c); else _burnGrid.set(key, [c]);
      radiators++;
    }

    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c.revealed) continue;

      let input = 0;

      // Cursor: the flame itself. Superlinear proximity ramp so the
      // center combusts near-instantly while the fringe only warms.
      const dx = c.hx - ctx.mouseX;
      const dy = c.hy - ctx.mouseY;
      const d2 = dx * dx + dy * dy;
      if (d2 < RSq) {
        const prox = 1 - Math.sqrt(d2) / R;
        input += kCursor * Math.pow(prox, BurnReveal.FOCUS);
      }

      // Smolder: radiation from burning neighbors. Contributions sum
      // (a wider front burns hotter) but are capped so a dense blaze
      // can't skip the burn animation entirely.
      if (radiators > 0) {
        const cx = (c.hx / reach) | 0;
        const cy = (c.hy / reach) | 0;
        let seed = 0;
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          for (let gy = cy - 1; gy <= cy + 1; gy++) {
            const bucket = _burnGrid.get(gx * 8192 + gy);
            if (!bucket) continue;
            for (let b = 0; b < bucket.length; b++) {
              const r = bucket[b];
              const rdx = r.hx - c.hx;
              const rdy = r.hy - c.hy;
              const rd2 = rdx * rdx + rdy * rdy;
              if (rd2 >= reachSq) continue;
              seed += 1 - Math.sqrt(rd2) / reach;
            }
          }
        }
        if (seed > 0) {
          if (seed > 1.4) seed = 1.4;
          // Per-char jitter keeps the creeping front ragged.
          input += kSmolder * seed * (0.7 + c.seed * 0.6);
        }
      }

      // Past the kindling point a char self-sustains at the full
      // smolder rate — the microburn that keeps the edge advancing
      // long after the cursor has moved on. No extinction, no decay:
      // the fire only ends when it runs out of reachable text.
      if (c.burnHeat >= ignite) input += kSmolder;

      if (input > 0) {
        c.burnHeat += input;
        if (c.burnHeat >= 1) {
          // Burned through — permanent. The glyph renderer swaps in
          // the payload char this same tick via burnNaturalGlyph.
          c.burnHeat = 1;
          c.revealed = true;
          c.burnedAt = now;
          continue;
        }
      } else if (c.burnHeat > 0) {
        // Nothing burning within reach and no flame — sub-kindling
        // warmth fades back to the cover state.
        c.burnHeat -= kCool;
        if (c.burnHeat < 0) c.burnHeat = 0;
      }

      // Twinkle — slow star-like re-roll; accelerates as the char heats.
      if (c.nextTwinkle === 0) {
        c.nextTwinkle = now + opts.burnTwinkleMs * (0.2 + Math.random());
      } else if (now >= c.nextTwinkle) {
        c.maskGlyph = burnMaskGlyph(opts.glyphPool, c.maskGlyph);
        const base = opts.burnTwinkleMs * (0.5 + Math.random());
        c.nextTwinkle = now + base * (1 - 0.85 * c.burnHeat);
      }
    }
  },
};

// Draw a mask glyph from the pool, avoiding an immediate repeat so a
// twinkle is always a visible change. Falls back to '#' on an empty pool.
function burnMaskGlyph(pool, current) {
  if (!pool || pool.length === 0) return current || '#';
  let g = pool.charAt((Math.random() * pool.length) | 0);
  if (g === current) g = pool.charAt((Math.random() * pool.length) | 0);
  return g;
}

// Module-private radiator grid, reused frame-to-frame (same rationale
// as _wordScratch above).
const _burnGrid = new Map();

export { BurnReveal };

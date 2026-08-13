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

export { Ripple };

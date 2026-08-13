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
  // Cap on stamps in flight. With STAMP_MIN_DIST=5 and a fast continuous
  // stroke (~16 px/frame at 60Hz), one stamp drops per frame; over the
  // 2s STAMP_MAX_AGE window that's ~120 stamps. Capping at 100 truncates
  // the oldest tail, which is below the 0.02 amplitude floor anyway
  // (a stamp 1.3s old contributes ~0.019 brightness at the wavefront —
  // imperceptible). Per-char Ripple.compute is O(stamps), so this cap
  // is a direct multiplier on every consumer's hot loop.
  const STAMP_BUFFER_CAP = 100;

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


export { AnimationLoop, CursorField };

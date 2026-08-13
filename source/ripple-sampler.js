import { Ripple } from './ripple.js';

// Owns the internal memo protocol shared by wave reveal and the ripple effect.
// Reveal sampling refreshes the memo; effect sampling only consumes an exact-
// frame memo and otherwise computes from the effect context without caching.
const RippleSampler = {
  initChar(c) {
    c._rippleStash = null;
    c._rippleStashFrame = -1;
  },

  sampleForReveal(c, ctx, opts) {
    const sample = compute(c.hx, c.hy, ctx, opts);
    c._rippleStash = sample;
    c._rippleStashFrame = ctx.frameId;
    return sample;
  },

  sampleForEffect(ctx, opts) {
    const c = ctx.char;
    if (c && c._rippleStashFrame === ctx.frameId) return c._rippleStash;
    return compute(ctx.charX, ctx.charY, ctx, opts);
  },
};

function compute(charX, charY, ctx, opts) {
  return Ripple.compute(
    charX, charY, ctx.time, ctx.stamps,
    opts.rippleSpeed, opts.rippleSpatialAtten,
    opts.ripplePostHit, opts.rippleEdge,
  );
}

export { RippleSampler };

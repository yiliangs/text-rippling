const VERSION = '0.1.0';

// Reference frame interval (≈60Hz), the rate the per-step integrator
// constants in DEFAULTS are tuned for. The dt-aware integrators rescale
// to this so visible behavior is identical across refresh rates.
const REF_DT_MS = 16.67;

// Frozen rest target, returned when a char has no active influence so
// the integrators have a known-zero state without per-char allocation.
const REST = Object.freeze({
  tx: 0,
  ty: 0,
  rot: 0,
  scale: 1,
  brightness: 0,
  scramble: 0,
  interior: false,
});

export { REF_DT_MS, REST, VERSION };

// ESM wrapper for `text-rippling`. Loads the classic-script library (which
// attaches `TextRippling` to the global) and re-exports its public surface.
import './text-rippling.js';

const TextRippling = (typeof window !== 'undefined' ? window : globalThis).TextRippling;

export { TextRippling };
export const version      = TextRippling.version;
export const effects      = TextRippling.effects;
export const falloffs     = TextRippling.falloffs;
export const glyphPickers = TextRippling.glyphPickers;
export const rippleAll    = TextRippling.rippleAll;
export default TextRippling;

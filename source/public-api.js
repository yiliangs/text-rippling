import { VERSION } from './constants.js';
import { BurnReveal } from './features/burn-reveal.js';
import { Redact } from './features/redact.js';
import {
  BloomRipple,
  RevealLayer,
  WaveReveal,
  WordReveal,
} from './features/reveal.js';
import { CursorField } from './browser-runtime.js';
import { Ripple } from './ripple.js';
import { Effects, Falloffs, GlyphPickers } from './strategies.js';
import { TextRippling } from './text-rippling.js';

function rippleAll(selector, options) {
  return Array.from(document.querySelectorAll(selector))
    .map((el) => new TextRippling(el, options));
}

// This object is the single source of truth for constructor attachments,
// CommonJS properties, and generated ESM named exports. Key order is part
// of the established CommonJS constructor shape and must remain stable.
const PUBLIC_API = {
  version: VERSION,
  effects: Effects,
  falloffs: Falloffs,
  glyphPickers: GlyphPickers,
  rippleAll,
  cursor: CursorField,
  ripple: Ripple,
  wordReveal: WordReveal,
  revealLayer: RevealLayer,
  waveReveal: WaveReveal,
  bloomRipple: BloomRipple,
  burnReveal: BurnReveal,
  redact: Redact,
};

Object.assign(TextRippling, PUBLIC_API);

export { PUBLIC_API, TextRippling };

import { BurnReveal } from './features/burn-reveal.js';
import { Redact } from './features/redact.js';
import { RevealLayer } from './features/reveal.js';

// Fixed lifecycle sequencing for the feature modules that share Char state.
// Keep method lookup on the public module objects dynamic: consumers may
// replace those methods through the established TextRippling attachments.
const FeatureLifecycle = {
  initChar(c) {
    RevealLayer.initChar(c);
    BurnReveal.initChar(c);
    Redact.initChar(c);
  },

  attach(chars, options, element) {
    RevealLayer.attach(chars, options, element);
    if (options.revealMode === 'burn') BurnReveal.attach(chars, options);
  },

  update(prev, curr, chars, element) {
    // Different reveal writers assign different meanings to these latches.
    if (prev.revealMode !== curr.revealMode) {
      for (const c of chars) { c.colorPinned = false; c.wasLit = false; }
    }

    RevealLayer.onUpdate(prev, curr, chars, element);
    BurnReveal.onUpdate(prev, curr, chars);
    Redact.onUpdate(prev, curr, chars);
  },
};

export { FeatureLifecycle };

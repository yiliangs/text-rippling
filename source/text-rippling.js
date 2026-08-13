import { AnimationLoop, CursorField } from './browser-runtime.js';
import { DEFAULTS } from './defaults.js';
import { FrameEngine } from './frame-engine.js';
import { Splitter } from './glyph-runtime.js';

// Public facade. It owns DOM setup, measurement, scheduling, and restoration;
// FrameEngine owns the frame pipeline behind the _tick/update adapters.
class TextRippling {
  constructor(element, options) {
    if (typeof element === 'string') element = document.querySelector(element);
    if (!element) throw new Error('TextRippling: element not found');

    this.element = element;
    this.options = Object.assign({}, DEFAULTS, options || {});
    this._originalHTML = element.innerHTML;
    this._chars = Splitter.split(element, this.options);
    this._ro = null;
    this._destroyed = false;
    this._engine = new FrameEngine(element, this._chars, this.options);

    this._measure();
    this._bind();

    CursorField.attach();
    AnimationLoop.add(this);

    // Re-measure once webfonts have loaded. The instance may have been
    // destroyed by then, so keep the existing guard.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (!this._destroyed) this._measure();
      });
    }
  }

  update(options) {
    this._engine.update(this.options, options);
  }

  remeasure() {
    this._measure();
  }

  destroy() {
    this._destroyed = true;
    AnimationLoop.remove(this);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    this._engine.release();
    this.element.innerHTML = this._originalHTML;
    this._chars = [];
  }

  // Char centers live in page space, matching cursor stamps and frame context.
  _measure() {
    const sx = window.scrollX || window.pageXOffset || 0;
    const sy = window.scrollY || window.pageYOffset || 0;
    for (const c of this._chars) {
      const prev = c.el.style.transform;
      c.el.style.transform = '';
      const r = c.el.getBoundingClientRect();
      c.hx = r.left + sx + r.width / 2;
      c.hy = r.top + sy + r.height / 2;
      c.el.style.transform = prev;
    }
  }

  _bind() {
    if (this.options.remeasureOn !== 'auto') return;
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._measure());
      this._ro.observe(this.element);
    }
  }

  _tick(now, dt) {
    this._engine.tick(now, dt, this.options);
  }
}

export { TextRippling };

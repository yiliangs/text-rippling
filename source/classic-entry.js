import { PUBLIC_API, TextRippling } from './public-api.js';

const root = typeof window !== 'undefined' ? window : globalThis;

// Browser global (works under <script src> from file:// or http://).
if (typeof root !== 'undefined') root.TextRippling = TextRippling;

// CommonJS (Node, bundlers). Assigning PUBLIC_API after TextRippling keeps
// module.exports.TextRippling identical to the constructor while retaining
// the constructor's established static-property insertion order.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TextRippling;
  module.exports.TextRippling = TextRippling;
  Object.assign(module.exports, PUBLIC_API);
}

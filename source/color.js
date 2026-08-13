// ════════════════════════════════════════════════════════════════════
//  Color — parse "#rgb" / "#rrggbb" / "rgb(...)" / "rgba(...)" → [r,g,b]
// ════════════════════════════════════════════════════════════════════

const Color = {
  parse(str) {
    if (!str) return [255, 255, 255];
    if (str.charAt(0) === '#') {
      let hex = str.slice(1);
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      if (hex.length === 6) {
        const n = parseInt(hex, 16);
        if (!isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      }
    }
    const m = str.match(/(\d+(?:\.\d+)?)[^\d.]+(\d+(?:\.\d+)?)[^\d.]+(\d+(?:\.\d+)?)/);
    if (m) return [+m[1] | 0, +m[2] | 0, +m[3] | 0];
    return [255, 255, 255];
  },
};

export { Color };

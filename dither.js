// Pure dithering and braille-packing logic, isolated from the DOM so it can
// run in the browser (as window.AsciifyDither) or under Node's test runner
// (as a CommonJS module) with no build step and no dependencies.
(function (global) {
  "use strict";

  function rgbaOffset(x, y, width) {
    return width * 4 * y + 4 * x;
  }

  class KernelDitherer {
    constructor(origin, numerators, denominator) {
      this.origin = origin;
      this.numerators = numerators;
      this.denominator = denominator || 1;
    }
    weights() {
      const weights = [];
      const [originX, originY] = this.origin;
      for (let y = 0; y < this.numerators.length; y++) {
        for (let x = 0; x < this.numerators[y].length; x++) {
          weights.push([x - originX, y - originY, this.numerators[y][x] / this.denominator]);
        }
      }
      return weights;
    }
    dither(input, threshold) {
      const output = { width: input.width, height: input.height, data: new Uint8ClampedArray(input.width * input.height * 4) };
      const weights = this.weights();
      for (let y = 0; y < input.height; y++) {
        for (let x = 0; x < input.width; x++) {
          const offset = rgbaOffset(x, y, input.width);
          const greyPixel = input.data[offset];
          const value = greyPixel > threshold ? 255 : 0;
          output.data.set([value, value, value, 255], offset);
          const error = greyPixel - value;
          for (const [wx, wy, weight] of weights) {
            if (weight === 0) continue;
            const o = rgbaOffset(x + wx, y + wy, input.width);
            const v = input.data[o];
            if (typeof v === "number" && o >= 0) {
              input.data[o] = v + error * weight;
            }
          }
        }
      }
      return output;
    }
  }

  const ditherers = {
    threshold: new KernelDitherer([0, 0], [], 1),
    floydSteinberg: new KernelDitherer([1, 0], [[0, 0, 7], [3, 5, 1]], 16),
    stucki: new KernelDitherer([2, 0], [[0, 0, 0, 8, 4], [2, 4, 8, 4, 2], [1, 2, 4, 2, 1]], 42),
    atkinson: new KernelDitherer([1, 0], [[0, 0, 1, 1], [1, 1, 1, 0], [0, 1, 0, 0]], 8),
  };

  // Packs one 2-wide x 4-tall block of dithered pixels into a single
  // Unicode braille codepoint (U+2800-U+28FF), per the Braille Patterns
  // block's dot numbering (dot 1 = top-left … dot 8 = bottom-right).
  function packBrailleCell(data, x, y, width, targetValue) {
    return 10240 +
      ((+(data[rgbaOffset(x + 1, y + 3, width)] === targetValue)) << 7) +
      ((+(data[rgbaOffset(x + 0, y + 3, width)] === targetValue)) << 6) +
      ((+(data[rgbaOffset(x + 1, y + 2, width)] === targetValue)) << 5) +
      ((+(data[rgbaOffset(x + 1, y + 1, width)] === targetValue)) << 4) +
      ((+(data[rgbaOffset(x + 1, y + 0, width)] === targetValue)) << 3) +
      ((+(data[rgbaOffset(x + 0, y + 2, width)] === targetValue)) << 2) +
      ((+(data[rgbaOffset(x + 0, y + 1, width)] === targetValue)) << 1) +
      ((+(data[rgbaOffset(x + 0, y + 0, width)] === targetValue)) << 0);
  }

  const api = { rgbaOffset, KernelDitherer, ditherers, packBrailleCell };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.AsciifyDither = api;
  }
})(typeof window !== "undefined" ? window : globalThis);

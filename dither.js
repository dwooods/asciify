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

  // Standard density ramp for classic ASCII-art rendering, ordered from
  // darkest/densest (@) to lightest/sparsest (space) - the convention most
  // ASCII-art tools use and document to users editing a custom palette.
  const asciiRamp = "@%#*+=-:. ";

  // A shorter ramp using Unicode block-shade characters for a smoother
  // gradient, at the cost of not being plain ASCII.
  const asciiRampBlocks = "█▓▒░ ";

  // Two additional user-contributed density ramps, offered as presets
  // alongside Standard/Blocks.
  const asciiRampDetailed = '@BR#$PX0woIcv:+!~". ';
  const asciiRampExtended = "@%#XRVYI|it*+=-;:'.";

  // Maps a single greyscale value (0-255) to a character from a density
  // ramp ordered darkest-to-lightest. invert swaps which end of the ramp
  // bright pixels map to, mirroring what "Invert" does for braille dots.
  function luminanceToChar(value, ramp, invert) {
    const v = invert ? 255 - value : value;
    const idx = Math.min(ramp.length - 1, Math.floor((v / 256) * ramp.length));
    return ramp[idx];
  }

  // Standard 3x3 Sobel operator: estimates the local brightness gradient
  // (dx, dy) at (x, y) from a greyscale RGBA buffer. Out-of-bounds reads
  // clamp to the nearest edge pixel rather than needing a padded buffer.
  function sobelGradient(data, x, y, width, height) {
    const sample = (sx, sy) => {
      const cx = Math.min(width - 1, Math.max(0, sx));
      const cy = Math.min(height - 1, Math.max(0, sy));
      return data[rgbaOffset(cx, cy, width)];
    };
    const dx =
      -sample(x - 1, y - 1) + sample(x + 1, y - 1) +
      -2 * sample(x - 1, y) + 2 * sample(x + 1, y) +
      -sample(x - 1, y + 1) + sample(x + 1, y + 1);
    const dy =
      -sample(x - 1, y - 1) - 2 * sample(x, y - 1) - sample(x + 1, y - 1) +
      sample(x - 1, y + 1) + 2 * sample(x, y + 1) + sample(x + 1, y + 1);
    return { dx, dy };
  }

  // A 3x3 Sobel kernel's magnitude maxes out at 4*255*sqrt(2); dividing by
  // that keeps the normalized magnitude comparable to the 0-255 threshold
  // range the UI already uses for the (unrelated) dithering threshold.
  const sobelMaxMagnitude = 4 * Math.SQRT2;

  // Buckets a gradient vector into one of four line-drawing characters
  // representing the edge's orientation (edges run perpendicular to the
  // gradient), or a space when the gradient is too weak to count as an edge.
  function edgeChar(dx, dy, threshold) {
    const magnitude = Math.sqrt(dx * dx + dy * dy) / sobelMaxMagnitude;
    if (magnitude <= threshold) return " ";
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI; // gradient direction, -180..180
    angle = ((angle % 180) + 180) % 180; // fold to 0..180 - edge orientation is direction-agnostic
    if (angle < 22.5 || angle >= 157.5) return "|"; // gradient ~horizontal -> edge runs vertical
    if (angle < 67.5) return "\\";
    if (angle < 112.5) return "-"; // gradient ~vertical -> edge runs horizontal
    return "/";
  }

  // Levels adjustment applied before dithering/ramp-mapping: brightness is
  // a flat offset, then blackPoint/whitePoint linearly remap that range to
  // 0-255 (values outside it clamp), the same "brightness + levels" model
  // real image-to-ASCII tools expose. Defaults (0, 0, 255) are a no-op.
  function adjustLevels(value, brightness, blackPoint, whitePoint) {
    const v = value + brightness;
    const range = whitePoint - blackPoint;
    const remapped = range === 0 ? (v < blackPoint ? 0 : 255) : ((v - blackPoint) / range) * 255;
    return Math.max(0, Math.min(255, remapped));
  }

  const api = {
    rgbaOffset,
    KernelDitherer,
    ditherers,
    packBrailleCell,
    asciiRamp,
    asciiRampBlocks,
    asciiRampDetailed,
    asciiRampExtended,
    luminanceToChar,
    sobelGradient,
    edgeChar,
    adjustLevels,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.AsciifyDither = api;
  }
})(typeof window !== "undefined" ? window : globalThis);

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

  // --- Auto-suggested settings ---------------------------------------
  // Heuristics for guessing reasonable starting settings from an image's
  // own greyscale statistics, so picking a style/threshold isn't pure
  // trial and error. These are first-pass constants, not yet calibrated
  // against a range of real photos - expect to retune them (see
  // suggestRenderMode/suggestSettingsForMode) once real images are tried.

  // Builds a 256-bucket luminance histogram from a greyscale RGBA buffer
  // (R=G=B after the luminosity composite already applied upstream).
  function computeHistogram(data, width, height) {
    const histogram = new Array(256).fill(0);
    const total = width * height;
    for (let i = 0; i < total; i++) histogram[data[i * 4]]++;
    return histogram;
  }

  // The luminance value below which `percentile`% of pixels fall - the
  // standard input to an "auto levels" contrast stretch.
  function histogramPercentile(histogram, percentile) {
    const total = histogram.reduce((sum, count) => sum + count, 0);
    if (total === 0) return 0;
    const target = (percentile / 100) * total;
    let cumulative = 0;
    for (let value = 0; value < 256; value++) {
      cumulative += histogram[value];
      if (cumulative >= target) return value;
    }
    return 255;
  }

  // Aggregate greyscale stats used to auto-suggest render settings:
  // overall brightness and spread (from the histogram), and edge density
  // (mean normalized Sobel gradient magnitude - see sobelMaxMagnitude) as
  // a proxy for how much of the image is sharp shapes vs smooth/flat
  // regions.
  function computeImageStats(data, width, height) {
    const histogram = computeHistogram(data, width, height);
    const total = width * height;

    let sum = 0;
    for (let value = 0; value < 256; value++) sum += value * histogram[value];
    const mean = sum / total;

    let sumSquaredDiff = 0;
    for (let value = 0; value < 256; value++) {
      sumSquaredDiff += histogram[value] * (value - mean) * (value - mean);
    }
    const stdev = Math.sqrt(sumSquaredDiff / total);

    let edgeSum = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const { dx, dy } = sobelGradient(data, x, y, width, height);
        edgeSum += Math.sqrt(dx * dx + dy * dy) / sobelMaxMagnitude;
      }
    }

    return {
      mean,
      stdev,
      edgeDensity: edgeSum / total,
      p2: histogramPercentile(histogram, 2),
      p98: histogramPercentile(histogram, 98),
    };
  }

  // Auto-levels: stretches the image's actual 2nd-98th percentile range to
  // fill 0-255, so a low-contrast (hazy, backlit, flat-lit) photo doesn't
  // waste most of the dithering/ramp range on tones it never uses. Falls
  // back to a minimum 1-value gap rather than a degenerate zero-width range
  // (e.g. a solid-color image, where p2 === p98).
  function suggestLevels(stats) {
    const blackPoint = Math.max(0, Math.min(254, stats.p2));
    const whitePoint = Math.max(blackPoint + 1, Math.min(255, stats.p98));
    return { blackPoint, whitePoint };
  }

  // Picks the render mode most likely to suit an image from its measured
  // stats: strong, plentiful edges suit line art; flat, low-contrast images
  // with few edges suit ASCII's continuous shading ramp; everything else
  // falls back to braille, the safest general-purpose choice.
  function suggestRenderMode(stats) {
    if (stats.edgeDensity > 40) return "edges";
    if (stats.edgeDensity < 15 && stats.stdev < 50) return "ascii";
    return "braille";
  }

  // Full settings suggestion for one specific render mode, so all three
  // can be computed and previewed side by side regardless of which one
  // suggestRenderMode() ends up recommending as the default.
  function suggestSettingsForMode(mode, stats) {
    const levels = suggestLevels(stats);
    if (mode === "edges") {
      // Aims the edge-sensitivity threshold at roughly 60% of the image's
      // own average edge strength - low enough to keep real detail, high
      // enough to drop noise from flatter regions.
      const threshold = Math.max(10, Math.min(200, Math.round(stats.edgeDensity * 0.6)));
      return { renderMode: "edges", threshold, ...levels };
    }
    if (mode === "ascii") {
      // A richer character ramp earns its keep on images with real tonal
      // gradient to render; a flatter image looks fine with the standard one.
      const charsetKey = stats.stdev > 30 ? "extended" : "standard";
      return { renderMode: "ascii", charsetKey, ...levels };
    }
    // Punchier Atkinson dithering suits higher-contrast images; smoother
    // Floyd-Steinberg suits everything else.
    const dithererName = stats.stdev > 60 ? "atkinson" : "floydSteinberg";
    return { renderMode: "braille", dithererName, threshold: 127, ...levels };
  }

  // Convenience: the single best-guess settings for an image, combining
  // suggestRenderMode() with suggestSettingsForMode() for that mode.
  function suggestSettings(stats) {
    return suggestSettingsForMode(suggestRenderMode(stats), stats);
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
    computeImageStats,
    suggestLevels,
    suggestRenderMode,
    suggestSettingsForMode,
    suggestSettings,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.AsciifyDither = api;
  }
})(typeof window !== "undefined" ? window : globalThis);

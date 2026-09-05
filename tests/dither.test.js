const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  rgbaOffset,
  KernelDitherer,
  ditherers,
  packBrailleCell,
  asciiRamp,
  luminanceToChar,
  sobelGradient,
  edgeChar,
  computeComplexityMap,
  buildGlyphAtlas,
  matchGlyph,
  adjustLevels,
  computeImageStats,
  suggestLevels,
  suggestRenderMode,
  suggestSettingsForMode,
  suggestSettings,
} = require("../dither.js");

test("rgbaOffset maps (x, y) to the red-channel index in a flat RGBA buffer", () => {
  assert.equal(rgbaOffset(0, 0, 4), 0);
  assert.equal(rgbaOffset(1, 0, 4), 4);
  assert.equal(rgbaOffset(0, 1, 4), 16);
  assert.equal(rgbaOffset(3, 2, 4), 4 * 4 * 2 + 4 * 3);
});

test("KernelDitherer.weights() is empty for the threshold kernel (no error diffusion)", () => {
  assert.deepEqual(ditherers.threshold.weights(), []);
});

test("KernelDitherer.weights() offsets each numerator from the kernel origin and divides by the denominator", () => {
  const weights = ditherers.floydSteinberg.weights();
  // origin is [1, 0]; numerators are [[0, 0, 7], [3, 5, 1]] over denominator 16.
  assert.equal(weights.length, 6);
  assert.deepEqual(weights[2], [1, 0, 7 / 16]); // row 0, x=2 -> offset (2-1, 0-0)
  assert.deepEqual(weights[3], [-1, 1, 3 / 16]); // row 1, x=0 -> offset (0-1, 1-0)
  assert.deepEqual(weights[4], [0, 1, 5 / 16]);
  assert.deepEqual(weights[5], [1, 1, 1 / 16]);
});

function makeGreyscaleImage(width, height, values) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = values[y * width + x];
      const o = rgbaOffset(x, y, width);
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

test("threshold dither snaps each pixel to pure black or white with no error diffusion", () => {
  const input = makeGreyscaleImage(2, 1, [200, 50]);
  const output = ditherers.threshold.dither(input, 127);

  assert.equal(output.data[rgbaOffset(0, 0, 2)], 255); // 200 > 127
  assert.equal(output.data[rgbaOffset(1, 0, 2)], 0);   // 50 <= 127
  assert.equal(output.data[rgbaOffset(0, 0, 2) + 3], 255); // alpha always opaque
});

test("floydSteinberg dither always produces pure black/white output", () => {
  const input = makeGreyscaleImage(4, 4, [
    10, 240, 128, 60,
    200, 5, 130, 128,
    60, 60, 200, 200,
    128, 5, 250, 0,
  ]);
  const output = ditherers.floydSteinberg.dither(input, 127);

  for (let i = 0; i < output.data.length; i += 4) {
    assert.ok(output.data[i] === 0 || output.data[i] === 255, `pixel at byte ${i} was ${output.data[i]}`);
  }
});

test("floydSteinberg diffuses quantization error into neighboring pixels", () => {
  // A uniform mid-grey row just above threshold should push some later
  // pixels below it once the rounding error accumulates and diffuses right.
  const input = makeGreyscaleImage(4, 1, [130, 130, 130, 130]);
  const output = ditherers.floydSteinberg.dither(input, 127);
  const values = [0, 1, 2, 3].map((x) => output.data[rgbaOffset(x, 0, 4)]);

  assert.ok(values.every((v) => v === 0 || v === 255));
  assert.ok(values.includes(0), "expected diffused error to flip at least one pixel to black");
});

test("packBrailleCell returns blank braille (U+2800) when no dot is set", () => {
  const width = 2;
  const data = new Uint8ClampedArray(width * 4 * 4).fill(255); // nothing matches targetValue 0
  assert.equal(packBrailleCell(data, 0, 0, width, 0), 0x2800);
});

test("packBrailleCell returns full braille (U+28FF) when every dot is set", () => {
  const width = 2;
  const data = new Uint8ClampedArray(width * 4 * 4).fill(0); // every pixel matches targetValue 0
  assert.equal(packBrailleCell(data, 0, 0, width, 0), 0x28ff);
});

test("packBrailleCell maps the top-left pixel to braille dot 1 (bit 0)", () => {
  const width = 2;
  const data = new Uint8ClampedArray(width * 4 * 4).fill(255);
  data[rgbaOffset(0, 0, width)] = 0; // only the top-left dot is "on"
  assert.equal(packBrailleCell(data, 0, 0, width, 0), 0x2801); // U+2801 = dot 1 only
});

test("packBrailleCell maps the bottom-right pixel to braille dot 8 (bit 7)", () => {
  const width = 2;
  const data = new Uint8ClampedArray(width * 4 * 4).fill(255);
  data[rgbaOffset(1, 3, width)] = 0; // only the bottom-right dot is "on"
  assert.equal(packBrailleCell(data, 0, 0, width, 0), 0x2880); // U+2880 = dot 8 only
});

test("luminanceToChar maps pure white to the lightest character in the ramp", () => {
  // asciiRamp is ordered darkest (index 0) to lightest (last index).
  assert.equal(luminanceToChar(255, asciiRamp, false), asciiRamp[asciiRamp.length - 1]);
});

test("luminanceToChar maps pure black to the densest character in the ramp", () => {
  assert.equal(luminanceToChar(0, asciiRamp, false), asciiRamp[0]);
});

test("luminanceToChar invert swaps which end of the ramp bright/dark pixels map to", () => {
  assert.equal(luminanceToChar(255, asciiRamp, true), asciiRamp[0]);
  assert.equal(luminanceToChar(0, asciiRamp, true), asciiRamp[asciiRamp.length - 1]);
});

test("luminanceToChar is monotonic: darker values never map to a denser ramp index", () => {
  let lastIndex = Infinity;
  for (let value = 255; value >= 0; value -= 17) {
    const char = luminanceToChar(value, asciiRamp, false);
    const index = asciiRamp.indexOf(char);
    assert.ok(index <= lastIndex, `value ${value} produced index ${index}, expected <= ${lastIndex}`);
    lastIndex = index;
  }
});

function makeImage(width, height, valueAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = valueAt(x, y);
      const o = rgbaOffset(x, y, width);
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return data;
}

test("sobelGradient finds a vertical edge (brightness changes along x, constant along y)", () => {
  const img = makeImage(9, 9, (x) => (x < 4 ? 0 : 255));
  const { dx, dy } = sobelGradient(img, 4, 4, 9, 9);
  assert.ok(dx > 0);
  assert.equal(dy, 0);
});

test("sobelGradient finds a horizontal edge (brightness changes along y, constant along x)", () => {
  const img = makeImage(9, 9, (x, y) => (y < 4 ? 0 : 255));
  const { dx, dy } = sobelGradient(img, 4, 4, 9, 9);
  assert.equal(dx, 0);
  assert.ok(dy > 0);
});

test("edgeChar maps a horizontal gradient to a vertical line character", () => {
  assert.equal(edgeChar(1020, 0, 0.1), "|");
});

test("edgeChar maps a vertical gradient to a horizontal line character", () => {
  assert.equal(edgeChar(0, 1020, 0.1), "-");
});

test("edgeChar maps a dark-upper-left/light-lower-right diagonal to a backslash", () => {
  assert.equal(edgeChar(765, 765, 0.1), "\\");
});

test("edgeChar maps a dark-lower-left/light-upper-right diagonal to a forward slash", () => {
  assert.equal(edgeChar(765, -765, 0.1), "/");
});

test("edgeChar returns a space when the gradient is weaker than the threshold", () => {
  // dx=5, dy=5 normalizes to a magnitude of ~1.25 (see sobelMaxMagnitude);
  // a threshold above that should suppress it to a blank cell.
  assert.equal(edgeChar(5, 5, 2.0), " ");
});

test("computeComplexityMap reports near-zero complexity for a flat image", () => {
  const img = makeImage(10, 10, () => 128);
  const complexity = computeComplexityMap(img, 10, 10, 2);
  for (let i = 0; i < complexity.length; i++) {
    assert.ok(complexity[i] < 0.01, `expected near-zero complexity at index ${i}, got ${complexity[i]}`);
  }
});

test("computeComplexityMap reports higher complexity near a hard edge than in a flat region", () => {
  const img = makeImage(20, 20, (x) => (x < 10 ? 0 : 255));
  const complexity = computeComplexityMap(img, 20, 20, 2);
  const atEdge = complexity[10 * 20 + 9]; // column 9, right next to the boundary at x=10
  const farFromEdge = complexity[10 * 20 + 1]; // column 1, well inside the flat left half
  assert.ok(atEdge > farFromEdge, `expected higher complexity at the edge (${atEdge}) than far from it (${farFromEdge})`);
});

test("computeComplexityMap treats two different but individually uniform brightnesses as equally simple", () => {
  // A dark region and a light region, each flat on its own - complexity
  // should be low in both, since it measures variation *within* a window,
  // not the window's own absolute brightness.
  const img = makeImage(20, 10, (x) => (x < 10 ? 20 : 220));
  const complexity = computeComplexityMap(img, 20, 10, 1);
  const darkSide = complexity[5 * 20 + 2]; // well inside the dark half
  const lightSide = complexity[5 * 20 + 17]; // well inside the light half
  assert.ok(darkSide < 0.05, `expected the flat dark region to score low, got ${darkSide}`);
  assert.ok(lightSide < 0.05, `expected the flat light region to score low, got ${lightSide}`);
});

test("computeComplexityMap scores fine-grained noise as more complex than a smooth gradient", () => {
  const noisy = makeImage(20, 20, (x, y) => ((x + y) % 2 === 0 ? 0 : 255));
  const smooth = makeImage(20, 20, (x) => Math.round((x / 19) * 255));
  const noisyComplexity = computeComplexityMap(noisy, 20, 20, 2);
  const smoothComplexity = computeComplexityMap(smooth, 20, 20, 2);
  const midIndex = 10 * 20 + 10;
  assert.ok(
    noisyComplexity[midIndex] > smoothComplexity[midIndex],
    `expected checkerboard noise (${noisyComplexity[midIndex]}) to score higher than a smooth gradient (${smoothComplexity[midIndex]})`
  );
});

// A 5x7 "font" grid (rough monospace character proportions) for
// buildGlyphAtlas/matchGlyph tests - 1 = ink, 0 = no ink.
function glyphBitmap(rows) {
  const arr = [];
  for (const row of rows) for (const ch of row) arr.push(ch === "#" ? 1 : 0);
  return arr;
}

const testGlyphs = [
  { char: " ", inkDensity: glyphBitmap([".....", ".....", ".....", ".....", ".....", ".....", "....."]) },
  { char: "#", inkDensity: glyphBitmap(["#####", "#####", "#####", "#####", "#####", "#####", "#####"]) },
  { char: "-", inkDensity: glyphBitmap([".....", ".....", ".....", "#####", ".....", ".....", "....."]) },
  { char: "|", inkDensity: glyphBitmap(["..#..", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."]) },
  { char: "/", inkDensity: glyphBitmap(["....#", "...#.", "..#..", "..#..", ".#...", "#....", "....."]) },
  { char: "\\", inkDensity: glyphBitmap(["#....", ".#...", "..#..", "..#..", "...#.", "....#", "....."]) },
];

test("matchGlyph picks the glyph whose shape exactly matches the image patch", () => {
  const atlas = buildGlyphAtlas(testGlyphs);
  const horizontal = glyphBitmap([".....", ".....", ".....", "#####", ".....", ".....", "....."]);
  const vertical = glyphBitmap(["..#..", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."]);
  const diagonal = glyphBitmap(["....#", "...#.", "..#..", "..#..", ".#...", "#....", "....."]);
  assert.equal(matchGlyph(horizontal, atlas, 0.7).char, "-");
  assert.equal(matchGlyph(vertical, atlas, 0.7).char, "|");
  assert.equal(matchGlyph(diagonal, atlas, 0.7).char, "/");
});

test("matchGlyph distinguishes a solid-dark patch from a blank patch by brightness, not just shape", () => {
  // Regression test: pure NCC mean-centers every patch, so a solid-black
  // and a solid-white patch both normalize toward an all-zero vector and
  // would score identically against every glyph on shape alone - only the
  // brightness term (blended in via structureWeight < 1) can tell them
  // apart.
  const atlas = buildGlyphAtlas(testGlyphs);
  const blank = glyphBitmap([".....", ".....", ".....", ".....", ".....", ".....", "....."]);
  const solid = glyphBitmap(["#####", "#####", "#####", "#####", "#####", "#####", "#####"]);
  assert.equal(matchGlyph(blank, atlas, 0.7).char, " ");
  assert.equal(matchGlyph(solid, atlas, 0.7).char, "#");
});

test("matchGlyph rescales patch brightness into the atlas's own achievable ink range", () => {
  // Regression test: a glyph set's densest character only ever covers a
  // fraction of its cell (no solid block in plain ASCII), so its meanInk
  // tops out well under 1.0. Comparing an image patch's raw meanInk
  // directly against that narrow achievable range collapsed every
  // moderately-dark-or-darker patch onto the single densest glyph
  // regardless of real brightness differences between them - confirmed
  // against a real photo, where pure brightness matching (structureWeight
  // 0) produced a near-solid wall of one character. Here, a glyph set
  // with a low achievable ceiling (max meanInk ~0.2) must still tell two
  // very different real patch brightnesses apart.
  const lowCeilingGlyphs = [
    { char: " ", inkDensity: glyphBitmap([".....", ".....", ".....", ".....", ".....", ".....", "....."]) },
    { char: ".", inkDensity: glyphBitmap([".....", ".....", ".....", ".....", ".....", "..#..", "....."]) },
    { char: ":", inkDensity: glyphBitmap([".....", "..#..", ".....", ".....", "..#..", ".....", "....."]) },
  ];
  const atlas = buildGlyphAtlas(lowCeilingGlyphs);
  const lightPatch = new Array(35).fill(0.1); // uniformly barely-inked
  const darkPatch = new Array(35).fill(0.9); // uniformly heavily-inked
  const lightMatch = matchGlyph(lightPatch, atlas, 0);
  const darkMatch = matchGlyph(darkPatch, atlas, 0);
  assert.notEqual(lightMatch.char, darkMatch.char, "expected distinctly different brightnesses to pick different glyphs");
  assert.equal(darkMatch.char, ":", "expected the darkest available patch to pick the densest available glyph");
});

test("matchGlyph treats a near-flat patch as having no structure to match", () => {
  // Regression test: L2-normalizing a near-zero-variance patch used to
  // divide a near-zero vector by a near-zero norm, amplifying tiny noise
  // into a full-strength "confident" unit vector - NCC against it was then
  // essentially random instead of correctly near-zero. A nearly (but not
  // exactly) flat patch should still be decided by brightness, the same
  // as an exactly flat one.
  const atlas = buildGlyphAtlas(testGlyphs);
  const almostBlank = glyphBitmap([".....", ".....", "....:", ".....", ".....", ".....", "....."]).map((v) =>
    v === 1 ? 0.01 : 0
  );
  assert.equal(matchGlyph(almostBlank, atlas, 0.9).char, " ");
});

test("adjustLevels with default settings (0 brightness, 0-255 range) is a no-op", () => {
  for (const v of [0, 1, 42, 128, 254, 255]) {
    assert.equal(adjustLevels(v, 0, 0, 255), v);
  }
});

test("adjustLevels applies brightness as a flat offset, clamped to 0-255", () => {
  assert.equal(adjustLevels(100, 50, 0, 255), 150);
  assert.equal(adjustLevels(240, 50, 0, 255), 255); // clamps above white
  assert.equal(adjustLevels(10, -50, 0, 255), 0); // clamps below black
});

test("adjustLevels remaps the black/white point range to 0-255", () => {
  assert.equal(adjustLevels(64, 0, 64, 192), 0); // at black point -> 0
  assert.equal(adjustLevels(192, 0, 64, 192), 255); // at white point -> 255
  assert.equal(adjustLevels(128, 0, 64, 192), 127.5); // midpoint -> midpoint
});

test("adjustLevels does not divide by zero when black and white points are equal", () => {
  assert.equal(adjustLevels(50, 0, 100, 100), 0); // below the single point
  assert.equal(adjustLevels(150, 0, 100, 100), 255); // above the single point
});

test("computeImageStats reports zero spread and zero edge density for a flat image", () => {
  const img = makeImage(10, 10, () => 128);
  const stats = computeImageStats(img, 10, 10);
  assert.equal(stats.mean, 128);
  assert.equal(stats.stdev, 0);
  assert.equal(stats.edgeDensity, 0);
  assert.equal(stats.p2, 128);
  assert.equal(stats.p98, 128);
});

test("computeImageStats reports high spread and positive edge density across a hard boundary", () => {
  const img = makeImage(10, 10, (x) => (x < 5 ? 0 : 255));
  const stats = computeImageStats(img, 10, 10);
  assert.equal(stats.mean, 127.5);
  assert.ok(stats.stdev > 100, `expected high stdev, got ${stats.stdev}`);
  assert.ok(stats.edgeDensity > 0, `expected some edge energy, got ${stats.edgeDensity}`);
  assert.equal(stats.p2, 0);
  assert.equal(stats.p98, 255);
});

test("computeImageStats reports higher edge concentration for a localized subject than for uniformly-spread edges", () => {
  // A 30x30 image sized so the 6x6 block grid divides evenly into 5x5
  // blocks. Both images have edges of the same intrinsic strength (a
  // 4px-period stripe pattern) and roughly comparable total edge density;
  // the only difference is WHERE those edges are - concentrated in one
  // corner (mimicking a subject on a plain background) vs. spread evenly
  // across the whole frame (mimicking a busy/cluttered scene).
  const stripe = (x) => (x % 4 < 2 ? 0 : 255);
  const concentrated = makeImage(30, 30, (x, y) => (x < 10 && y < 10 ? stripe(x) : 128));
  const uniform = makeImage(30, 30, (x) => stripe(x));

  const concentratedStats = computeImageStats(concentrated, 30, 30);
  const uniformStats = computeImageStats(uniform, 30, 30);

  assert.ok(
    concentratedStats.edgeConcentration > uniformStats.edgeConcentration,
    `expected localized edges (${concentratedStats.edgeConcentration}) to score higher than uniform edges (${uniformStats.edgeConcentration})`
  );
});

test("suggestLevels stretches the percentile range to fill 0-255", () => {
  assert.deepEqual(suggestLevels({ p2: 50, p98: 200 }), { blackPoint: 50, whitePoint: 200 });
});

test("suggestLevels avoids a zero-width range when p2 and p98 are equal", () => {
  const { blackPoint, whitePoint } = suggestLevels({ p2: 128, p98: 128 });
  assert.equal(blackPoint, 128);
  assert.equal(whitePoint, 129);
});

test("suggestLevels clamps to the valid 0-254/1-255 slider ranges", () => {
  assert.deepEqual(suggestLevels({ p2: -10, p98: 300 }), { blackPoint: 0, whitePoint: 255 });
});

test("suggestRenderMode picks edges for images with plentiful, unevenly-distributed edges", () => {
  assert.equal(suggestRenderMode({ edgeDensity: 60, edgeConcentration: 0.5, stdev: 80, entropy: 7 }), "edges");
});

test("suggestRenderMode avoids edges for busy/cluttered images despite high edge density", () => {
  // Regression test: found by testing against real photos - a "busy
  // clutter" photo can have edge density as high as a clean subject on a
  // plain background, but the edges are spread uniformly across the whole
  // frame (low concentration) rather than outlining a recognizable shape,
  // and renders as noise rather than line art.
  assert.equal(suggestRenderMode({ edgeDensity: 33, edgeConcentration: 0.27, stdev: 80, entropy: 7 }), "braille");
});

test("suggestRenderMode picks ascii for flat, low-contrast, low-edge images", () => {
  assert.equal(suggestRenderMode({ edgeDensity: 5, stdev: 20, entropy: 7 }), "ascii");
});

test("suggestRenderMode falls back to braille for everything in between", () => {
  assert.equal(suggestRenderMode({ edgeDensity: 20, stdev: 70, entropy: 7 }), "braille");
});

test("suggestRenderMode picks edges at real-photo-scale edge density, not just extreme synthetic values", () => {
  // Regression test: the edges cutoff used to be 40, a value no real photo
  // in a 20-image calibration set ever reached (max measured was ~35, for
  // a busy black-and-white photo) - edges mode was effectively
  // unreachable. 25 is roughly a tiger-face close-up's measured edge
  // density; recalibrated against real photos, this must pick edges.
  assert.equal(suggestRenderMode({ edgeDensity: 25, edgeConcentration: 0.5, stdev: 70, entropy: 7 }), "edges");
});

test("suggestRenderMode avoids edges for already-line-art images despite plentiful, concentrated edges", () => {
  // Regression test: a coloring-book-style illustration's outline is just
  // as concentrated on its subject as a real photo's edges are, so
  // edgeDensity/edgeConcentration alone picked "edges" for these - but
  // re-detecting edges on input that's already near-binary line art
  // produces visual noise, not a cleaner line (see JOURNEY.md). Low
  // entropy (few dominant tones: a fill, an outline, little in between) is
  // what actually distinguishes this case; 4.6 is roughly truck.jpg's
  // measured entropy, well inside the six coloring-book uploads that
  // motivated this (all <= 5.01), clear of the six real photos that
  // genuinely render well as line art (all >= 5.52).
  assert.equal(suggestRenderMode({ edgeDensity: 31, edgeConcentration: 0.72, stdev: 65, entropy: 4.6 }), "braille");
});

test("computeImageStats reports low entropy for a two-tone image and high entropy for a full-range one", () => {
  const twoTone = new Uint8ClampedArray(400);
  for (let i = 0; i < 100; i++) {
    const v = i % 4 === 0 ? 0 : 250; // 25% near-black, 75% near-white
    twoTone.set([v, v, v, 255], i * 4);
  }
  const fullRange = new Uint8ClampedArray(400);
  for (let i = 0; i < 100; i++) {
    const v = (i * 255) / 99;
    fullRange.set([v, v, v, 255], i * 4);
  }
  const twoToneStats = computeImageStats(twoTone, 10, 10);
  const fullRangeStats = computeImageStats(fullRange, 10, 10);
  assert.ok(twoToneStats.entropy < 1, `expected a two-tone image's entropy well under 1 bit, got ${twoToneStats.entropy}`);
  assert.ok(
    fullRangeStats.entropy > twoToneStats.entropy,
    "expected a full-range image to have higher entropy than a two-tone one"
  );
});

test("suggestSettingsForMode returns edges settings with a threshold derived from edge density", () => {
  const settings = suggestSettingsForMode("edges", { edgeDensity: 100, stdev: 50, p2: 10, p98: 240 });
  assert.equal(settings.renderMode, "edges");
  assert.equal(settings.threshold, 60); // round(100 * 0.6)
  assert.equal(settings.blackPoint, 10);
  assert.equal(settings.whitePoint, 240);
});

test("suggestSettingsForMode clamps the edges threshold into a sane range", () => {
  const low = suggestSettingsForMode("edges", { edgeDensity: 1, stdev: 0, p2: 0, p98: 255 });
  assert.equal(low.threshold, 10);
  const high = suggestSettingsForMode("edges", { edgeDensity: 1000, stdev: 0, p2: 0, p98: 255 });
  assert.equal(high.threshold, 200);
});

test("suggestSettingsForMode picks a richer ASCII charset for higher-contrast images", () => {
  const flat = suggestSettingsForMode("ascii", { stdev: 10, p2: 0, p98: 255 });
  assert.equal(flat.charsetKey, "standard");
  const contrasty = suggestSettingsForMode("ascii", { stdev: 50, p2: 0, p98: 255 });
  assert.equal(contrasty.charsetKey, "extended");
});

test("suggestSettingsForMode picks Atkinson dithering for higher-contrast braille images", () => {
  const flat = suggestSettingsForMode("braille", { stdev: 20, p2: 0, p98: 255 });
  assert.equal(flat.dithererName, "floydSteinberg");
  const contrasty = suggestSettingsForMode("braille", { stdev: 80, p2: 0, p98: 255 });
  assert.equal(contrasty.dithererName, "atkinson");
});

test("suggestSettings combines suggestRenderMode and suggestSettingsForMode", () => {
  const settings = suggestSettings({ edgeDensity: 60, edgeConcentration: 0.5, stdev: 80, entropy: 7, p2: 20, p98: 230 });
  assert.equal(settings.renderMode, "edges");
  assert.equal(settings.threshold, 36); // round(60 * 0.6)
});

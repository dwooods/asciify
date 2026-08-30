const { test } = require("node:test");
const assert = require("node:assert/strict");
const { rgbaOffset, KernelDitherer, ditherers, packBrailleCell } = require("../dither.js");

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

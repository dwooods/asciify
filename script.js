// Asciify
// Renders an image as Unicode braille dot-matrix text art in the browser.
// Dithering algorithm ported from Lachlan Arthur's Braille-ASCII-Art
// (https://github.com/LachlanArthur/Braille-ASCII-Art), MIT licensed.

(function () {
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
      const output = new ImageData(input.width, input.height);
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

  // Braille cell is 2 dots wide, 4 dots tall.
  const asciiXDots = 2, asciiYDots = 4;

  const ditherers = {
    threshold: new KernelDitherer([0, 0], [], 1),
    floydSteinberg: new KernelDitherer([1, 0], [[0, 0, 7], [3, 5, 1]], 16),
    stucki: new KernelDitherer([2, 0], [[0, 0, 0, 8, 4], [2, 4, 8, 4, 2], [1, 2, 4, 2, 1]], 42),
    atkinson: new KernelDitherer([1, 0], [[0, 0, 1, 1], [1, 1, 1, 0], [0, 1, 0, 0]], 8),
  };

  let dithererName = "floydSteinberg";
  let invert = false;
  let threshold = 127;
  let asciiWidth = 100;
  let image = null;
  let ascii = "";

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  const $ = (sel) => document.querySelector(sel);
  const filepicker = $("#filepicker");
  const ditherSel = $("#dither");
  const thresholdInput = $("#threshold");
  const thresholdVal = $("#thresholdVal");
  const widthInput = $("#width");
  const fontSizeInput = $("#fontSize");
  const fontSizeVal = $("#fontSizeVal");
  const invertInput = $("#invert");
  const output = $("#output");
  const emptyState = $("#emptyState");
  const charCount = $("#charCount");
  const copyBtn = $("#copyBtn");
  const downloadBtn = $("#downloadBtn");
  const dropzone = $("#dropzone");
  const thumb = $("#thumb");
  const thumbImg = $("#thumbImg");

  function loadFile(file) {
    if (!file) return;
    image = document.createElement("img");
    image.onload = render;
    image.src = URL.createObjectURL(file);
    thumbImg.src = image.src;
    thumb.style.display = "block";
  }

  filepicker.addEventListener("change", function () {
    if (this.files && this.files.length) loadFile(this.files[0]);
  });

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  ditherSel.addEventListener("change", function () {
    if (this.value === dithererName) return;
    dithererName = this.value;
    render();
  });

  thresholdInput.addEventListener("input", function () {
    thresholdVal.textContent = this.value;
  });
  thresholdInput.addEventListener("change", function () {
    const v = parseInt(this.value, 10);
    if (v === threshold) return;
    threshold = v;
    render();
  });

  widthInput.addEventListener("input", function () {
    const v = parseInt(this.value, 10);
    if (!v || v === asciiWidth || v < 1) return;
    asciiWidth = v;
    render();
  });

  fontSizeInput.addEventListener("input", function () {
    fontSizeVal.textContent = this.value + "px";
    output.style.setProperty("--font-size", this.value + "px");
  });

  invertInput.addEventListener("change", function () {
    invert = this.checked;
    render();
  });

  copyBtn.addEventListener("click", function () {
    if (!ascii) return;
    navigator.clipboard.writeText(ascii);
    const old = this.textContent;
    this.textContent = "Copied!";
    setTimeout(() => (this.textContent = old), 1000);
  });

  downloadBtn.addEventListener("click", function () {
    if (!ascii) return;
    const blob = new Blob([ascii], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "braille-art.txt";
    a.click();
    URL.revokeObjectURL(url);
  });

  function render() {
    if (!image) return;

    const asciiHeight = Math.ceil((asciiWidth * asciiXDots * (image.height / image.width)) / asciiYDots);
    canvas.width = asciiWidth * asciiXDots;
    canvas.height = asciiHeight * asciiYDots;

    context.globalCompositeOperation = "source-over";
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.globalCompositeOperation = "luminosity";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const ditherer = ditherers[dithererName];
    const greyPixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const dithered = ditherer.dither(greyPixels, threshold);
    const targetValue = invert ? 255 : 0;

    const asciiText = [];
    const asciiHtml = [];

    for (let y = 0; y < canvas.height; y += asciiYDots) {
      const line = [];
      for (let x = 0; x < canvas.width; x += asciiXDots) {
        const d = dithered.data;
        const w = canvas.width;
        line.push(
          10240 +
          ((+(d[rgbaOffset(x + 1, y + 3, w)] === targetValue)) << 7) +
          ((+(d[rgbaOffset(x + 0, y + 3, w)] === targetValue)) << 6) +
          ((+(d[rgbaOffset(x + 1, y + 2, w)] === targetValue)) << 5) +
          ((+(d[rgbaOffset(x + 1, y + 1, w)] === targetValue)) << 4) +
          ((+(d[rgbaOffset(x + 1, y + 0, w)] === targetValue)) << 3) +
          ((+(d[rgbaOffset(x + 0, y + 2, w)] === targetValue)) << 2) +
          ((+(d[rgbaOffset(x + 0, y + 1, w)] === targetValue)) << 1) +
          ((+(d[rgbaOffset(x + 0, y + 0, w)] === targetValue)) << 0)
        );
      }
      const lineChars = String.fromCharCode.apply(String, line);
      asciiText.push(lineChars);
      asciiHtml.push(lineChars.split("").map((c) => `<span>${c}</span>`).join(""));
    }

    ascii = asciiText.join("\n");
    charCount.textContent = ascii.length.toLocaleString();

    emptyState.style.display = "none";
    output.style.display = "block";
    output.innerHTML = asciiHtml.join("<br>");
  }
})();

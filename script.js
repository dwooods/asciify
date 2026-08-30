// Asciify
// Renders an image as Unicode braille dot-matrix text art in the browser.
// Dithering algorithm ported from Lachlan Arthur's Braille-ASCII-Art
// (https://github.com/LachlanArthur/Braille-ASCII-Art), MIT licensed.

(function () {
  "use strict";

  const { rgbaOffset, ditherers, packBrailleCell, asciiRamp, asciiRampBlocks, luminanceToChar, sobelGradient, edgeChar, adjustLevels } = window.AsciifyDither;

  const charsetPresets = { standard: asciiRamp, blocks: asciiRampBlocks };

  // Braille cell is 2 dots wide, 4 dots tall.
  const asciiXDots = 2, asciiYDots = 4;

  // Classic ASCII-art characters are roughly twice as tall as wide, so each
  // character's sampled block is shrunk vertically by this factor relative
  // to a square block - otherwise the output looks vertically stretched.
  const asciiCharAspect = 0.55;

  // Matches the #output font stack in style.css, so PNG/SVG exports render
  // the same glyphs the on-screen preview already proved out.
  const exportFontFamily = 'ui-monospace, "SF Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace';

  let renderMode = "braille";
  let dithererName = "floydSteinberg";
  let invert = false;
  let threshold = 127;
  let asciiWidth = 100;
  let lockAspect = true;
  let manualHeight = 50;
  let brightness = 0;
  let blackPoint = 0;
  let whitePoint = 255;
  let image = null;
  let ascii = "";

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  const $ = (sel) => document.querySelector(sel);
  const filepicker = $("#filepicker");
  const renderModeSel = $("#renderMode");
  const ditherField = $("#ditherField");
  const thresholdField = $("#thresholdField");
  const invertField = $("#invertField");
  const charsetField = $("#charsetField");
  const paletteField = $("#paletteField");
  const ditherSel = $("#dither");
  const thresholdInput = $("#threshold");
  const thresholdVal = $("#thresholdVal");
  const charsetSel = $("#charset");
  const paletteInput = $("#palette");
  const widthInput = $("#width");
  const heightInput = $("#height");
  const lockAspectInput = $("#lockAspect");
  const brightnessInput = $("#brightness");
  const brightnessVal = $("#brightnessVal");
  const blackPointInput = $("#blackPoint");
  const blackPointVal = $("#blackPointVal");
  const whitePointInput = $("#whitePoint");
  const whitePointVal = $("#whitePointVal");
  const fontSizeInput = $("#fontSize");
  const fontSizeVal = $("#fontSizeVal");
  const invertInput = $("#invert");
  const output = $("#output");
  const emptyState = $("#emptyState");
  const charCount = $("#charCount");
  const gridInfo = $("#gridInfo");
  const copyBtn = $("#copyBtn");
  const downloadBtn = $("#downloadBtn");
  const downloadPngBtn = $("#downloadPngBtn");
  const downloadSvgBtn = $("#downloadSvgBtn");
  const dropzone = $("#dropzone");
  const thumb = $("#thumb");
  const thumbImg = $("#thumbImg");
  const imageInfo = $("#imageInfo");
  const clearBtn = $("#clearBtn");

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function loadFile(file) {
    if (!file) return;
    imageInfo.textContent = `${file.name} · ${formatBytes(file.size)} · ${file.type || "unknown type"}`;
    image = document.createElement("img");
    image.onload = () => {
      imageInfo.textContent += ` · ${image.naturalWidth}×${image.naturalHeight}px`;
      render();
    };
    image.src = URL.createObjectURL(file);
    thumbImg.src = image.src;
    thumb.style.display = "block";
  }

  clearBtn.addEventListener("click", function () {
    image = null;
    ascii = "";
    filepicker.value = "";
    thumb.style.display = "none";
    thumbImg.src = "";
    imageInfo.textContent = "";
    gridInfo.textContent = "";
    charCount.textContent = "0";
    output.style.display = "none";
    output.innerHTML = "";
    emptyState.style.display = "flex";
  });

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

  // Uses the classic clipboardData paste event (not navigator.clipboard.read,
  // which needs a secure context) so pasting keeps working over file://.
  // Only intercept the paste when it actually contains an image, so pasting
  // text elsewhere on the page — including into the contenteditable output —
  // is left alone.
  window.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          loadFile(file);
        }
        break;
      }
    }
  });

  renderModeSel.addEventListener("change", function () {
    if (this.value === renderMode) return;
    renderMode = this.value;
    // Dither mode only means anything for braille output. Threshold applies
    // to braille (dither cutoff) and edges (edge sensitivity), but not to
    // ASCII's continuous brightness ramp. Invert only makes sense where a
    // pixel maps to one of two polarities (braille dots, the ASCII ramp) -
    // edge detection is polarity-symmetric, so it has no effect there.
    ditherField.style.display = renderMode === "braille" ? "" : "none";
    thresholdField.style.display = renderMode === "ascii" ? "none" : "";
    invertField.style.display = renderMode === "edges" ? "none" : "";
    charsetField.style.display = renderMode === "ascii" ? "" : "none";
    paletteField.style.display = renderMode === "ascii" ? "" : "none";
    render();
  });

  ditherSel.addEventListener("change", function () {
    if (this.value === dithererName) return;
    dithererName = this.value;
    render();
  });

  charsetSel.addEventListener("change", function () {
    const preset = charsetPresets[this.value];
    if (preset) paletteInput.value = preset;
    render();
  });

  paletteInput.addEventListener("input", function () {
    // If the box no longer matches a known preset, reflect that as "Custom"
    // in the dropdown rather than leaving it pointed at a preset it's since
    // diverged from.
    const matchedPreset = Object.entries(charsetPresets).find(([, v]) => v === this.value);
    charsetSel.value = matchedPreset ? matchedPreset[0] : "custom";
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

  heightInput.addEventListener("input", function () {
    if (lockAspect) return;
    const v = parseInt(this.value, 10);
    if (!v || v === manualHeight || v < 1) return;
    manualHeight = v;
    render();
  });

  lockAspectInput.addEventListener("change", function () {
    lockAspect = this.checked;
    heightInput.disabled = lockAspect;
    if (!lockAspect) {
      // Seed the manual height with whatever the auto-computed value
      // currently is, so unlocking doesn't cause a sudden jump in the output.
      manualHeight = parseInt(heightInput.value, 10) || manualHeight;
    }
    render();
  });

  brightnessInput.addEventListener("input", function () {
    brightnessVal.textContent = this.value;
  });
  brightnessInput.addEventListener("change", function () {
    const v = parseInt(this.value, 10);
    if (v === brightness) return;
    brightness = v;
    render();
  });

  blackPointInput.addEventListener("input", function () {
    blackPointVal.textContent = this.value;
  });
  blackPointInput.addEventListener("change", function () {
    const v = parseInt(this.value, 10);
    if (v === blackPoint) return;
    blackPoint = v;
    render();
  });

  whitePointInput.addEventListener("input", function () {
    whitePointVal.textContent = this.value;
  });
  whitePointInput.addEventListener("change", function () {
    const v = parseInt(this.value, 10);
    if (v === whitePoint) return;
    whitePoint = v;
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

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportFilename(extension) {
    return `${renderMode}-art.${extension}`;
  }

  downloadBtn.addEventListener("click", function () {
    if (!ascii) return;
    downloadBlob(new Blob([ascii], { type: "text/plain;charset=utf-8" }), exportFilename("txt"));
  });

  const exportFontSize = 16;

  // Shared sizing math for the PNG/SVG exports: both need the same grid
  // dimensions in pixels, derived from the monospace font's advance width.
  function measureAsciiGrid(lines) {
    const lineHeight = exportFontSize;
    const padding = exportFontSize;
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = `${exportFontSize}px ${exportFontFamily}`;
    const charWidth = measure.measureText("⠀").width;
    const cols = lines.reduce((max, l) => Math.max(max, l.length), 0);
    return {
      lineHeight,
      padding,
      width: Math.ceil(charWidth * cols) + padding * 2,
      height: lineHeight * lines.length + padding * 2,
    };
  }

  // Rasterizes the same text grid to a canvas so the dots survive outside a
  // monospace context (Discord, GitHub comments, print). Renders black text
  // on a white background regardless of the page's light/dark theme, since
  // the point is a portable, printable image rather than a screenshot of
  // the app itself.
  function renderAsciiToCanvas() {
    const lines = ascii.split("\n");
    const { lineHeight, padding, width, height } = measureAsciiGrid(lines);

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = width;
    exportCanvas.height = height;

    const ctx = exportCanvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "black";
    ctx.font = `${exportFontSize}px ${exportFontFamily}`;
    ctx.textBaseline = "top";
    lines.forEach((line, i) => {
      ctx.fillText(line, padding, padding + i * lineHeight);
    });

    return exportCanvas;
  }

  downloadPngBtn.addEventListener("click", function () {
    if (!ascii) return;
    renderAsciiToCanvas().toBlob((blob) => downloadBlob(blob, exportFilename("png")), "image/png");
  });

  function escapeXml(text) {
    return text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  downloadSvgBtn.addEventListener("click", function () {
    if (!ascii) return;
    const lines = ascii.split("\n");
    const { lineHeight, padding, width, height } = measureAsciiGrid(lines);

    const textEls = lines
      .map((line, i) => `<text x="${padding}" y="${padding + i * lineHeight + exportFontSize * 0.8}" xml:space="preserve">${escapeXml(line)}</text>`)
      .join("\n  ");

    // font-family is single-quoted: exportFontFamily embeds double-quoted
    // font names (e.g. "SF Mono"), which would otherwise close the
    // attribute early and produce invalid XML.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family='${exportFontFamily}' font-size="${exportFontSize}" fill="black">
  <rect width="100%" height="100%" fill="white"/>
  ${textEls}
</svg>
`;

    downloadBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), exportFilename("svg"));
  });

  // Shared tail for both render modes: takes the finished lines of
  // characters, joins them into the copy/download text, and paints the
  // on-screen preview.
  function finalizeOutput(lines) {
    const asciiHtml = lines.map((line) => line.split("").map((c) => `<span>${c}</span>`).join(""));

    ascii = lines.join("\n");
    charCount.textContent = ascii.length.toLocaleString();
    const cols = lines.reduce((max, l) => Math.max(max, l.length), 0);
    gridInfo.textContent = ` (${cols}×${lines.length})`;
    // While the aspect ratio is locked, keep the Height field showing the
    // real auto-computed value rather than a stale number from last render.
    if (lockAspect) heightInput.value = lines.length;

    emptyState.style.display = "none";
    output.style.display = "block";
    output.innerHTML = asciiHtml.join("<br>");
  }

  // Applies the brightness/black-point/white-point levels adjustment to a
  // greyscale RGBA buffer in place, before dithering or ramp-mapping. Only
  // needs to touch one channel per pixel since the luminosity composite
  // upstream already guarantees R=G=B, but all three (plus alpha) are kept
  // in sync so the buffer stays a valid, consistent ImageData if ever read
  // by anything else.
  function applyLevels(data, width, height) {
    if (brightness === 0 && blackPoint === 0 && whitePoint === 255) return;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = rgbaOffset(x, y, width);
        const v = adjustLevels(data[o], brightness, blackPoint, whitePoint);
        data[o] = data[o + 1] = data[o + 2] = v;
      }
    }
  }

  function renderBrailleMode() {
    // Each output character is one braille cell (asciiXDots x asciiYDots
    // pixels), so the canvas is sized in actual pixels at that multiple of
    // the requested character width/height.
    const asciiHeight = lockAspect
      ? Math.ceil((asciiWidth * asciiXDots * (image.height / image.width)) / asciiYDots)
      : manualHeight;
    canvas.width = asciiWidth * asciiXDots;
    canvas.height = asciiHeight * asciiYDots;

    context.globalCompositeOperation = "source-over";
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);

    // "luminosity" blend mode over a white background is a one-line trick
    // for getting a perceptual greyscale read of the image: it composites
    // using the source's luminance while keeping white's hue/saturation,
    // which collapses to R=G=B equal to the image's luminance at each pixel.
    context.globalCompositeOperation = "luminosity";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const ditherer = ditherers[dithererName];
    const greyPixels = context.getImageData(0, 0, canvas.width, canvas.height);
    applyLevels(greyPixels.data, canvas.width, canvas.height);
    const dithered = ditherer.dither(greyPixels, threshold);
    const targetValue = invert ? 255 : 0;

    const lines = [];

    // Walk the dithered bitmap one braille cell at a time (asciiXDots wide,
    // asciiYDots tall) and pack each cell into a single braille codepoint.
    for (let y = 0; y < canvas.height; y += asciiYDots) {
      const line = [];
      for (let x = 0; x < canvas.width; x += asciiXDots) {
        line.push(packBrailleCell(dithered.data, x, y, canvas.width, targetValue));
      }
      lines.push(String.fromCharCode.apply(String, line));
    }

    finalizeOutput(lines);
  }

  // Shared setup for ASCII and edge-detection modes: one output character
  // = one sampled pixel, so the source image is drawn scaled directly down
  // to the character grid's resolution and the browser's own image
  // downscaling does the per-cell brightness averaging for us.
  function prepareCharacterGrid() {
    const height = lockAspect
      ? Math.max(1, Math.round(asciiWidth * (image.height / image.width) * asciiCharAspect))
      : manualHeight;
    canvas.width = asciiWidth;
    canvas.height = height;

    context.globalCompositeOperation = "source-over";
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.globalCompositeOperation = "luminosity";
    context.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in context) context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    applyLevels(imageData.data, canvas.width, canvas.height);
    return imageData;
  }

  function renderAsciiMode() {
    // Falls back to the standard ramp if the palette box is emptied out -
    // an empty ramp has no valid character to index into.
    const ramp = paletteInput.value || asciiRamp;
    const { data, width, height } = prepareCharacterGrid();
    const lines = [];
    for (let y = 0; y < height; y++) {
      let line = "";
      for (let x = 0; x < width; x++) {
        line += luminanceToChar(data[rgbaOffset(x, y, width)], ramp, invert);
      }
      lines.push(line);
    }
    finalizeOutput(lines);
  }

  function renderEdgesMode() {
    // Reuses the "Threshold" slider as edge sensitivity: a Sobel gradient's
    // magnitude is normalized to roughly the same 0-255 range that slider
    // already covers for the dithering threshold (see sobelMaxMagnitude).
    const { data, width, height } = prepareCharacterGrid();
    const lines = [];
    for (let y = 0; y < height; y++) {
      let line = "";
      for (let x = 0; x < width; x++) {
        const { dx, dy } = sobelGradient(data, x, y, width, height);
        line += edgeChar(dx, dy, threshold);
      }
      lines.push(line);
    }
    finalizeOutput(lines);
  }

  function render() {
    if (!image) return;
    if (renderMode === "ascii") {
      renderAsciiMode();
    } else if (renderMode === "edges") {
      renderEdgesMode();
    } else {
      renderBrailleMode();
    }
  }
})();

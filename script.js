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

  // A width/height far beyond this is already absurdly detailed for any
  // practical use, and without a cap a large enough value (typed directly,
  // or restored from a shared permalink) makes the canvas exceed the
  // browser's own size limits, which throws rather than failing gracefully.
  const maxDimension = 2000;

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
  const loadError = $("#loadError");
  const srStatus = $("#srStatus");

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function showLoadError(message) {
    loadError.textContent = message;
    loadError.style.display = "block";
    srStatus.textContent = message;
    image = null;
    thumb.style.display = "none";
  }

  function loadFile(file) {
    if (!file) return;
    loadError.style.display = "none";
    imageInfo.textContent = `${file.name} · ${formatBytes(file.size)} · ${file.type || "unknown type"}`;
    image = document.createElement("img");
    image.onload = () => {
      imageInfo.textContent += ` · ${image.naturalWidth}×${image.naturalHeight}px`;
      render();
    };
    // file.type isn't a reliable gate (it can be empty for legitimate images
    // from some sources), so actual decode success/failure is the real
    // signal - this also catches corrupt files, not just wrong file types.
    image.onerror = () => {
      showLoadError(`Couldn't load "${file.name}" (${file.type || "unknown type"}) - it may not be a valid image.`);
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
    loadError.style.display = "none";
    gridInfo.textContent = "";
    charCount.textContent = "0";
    output.style.display = "none";
    output.innerHTML = "";
    emptyState.style.display = "flex";
    srStatus.textContent = "Image cleared.";
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

  // Dither mode only means anything for braille output. Threshold applies
  // to braille (dither cutoff) and edges (edge sensitivity), but not to
  // ASCII's continuous brightness ramp. Invert only makes sense where a
  // pixel maps to one of two polarities (braille dots, the ASCII ramp) -
  // edge detection is polarity-symmetric, so it has no effect there.
  function applyRenderModeVisibility() {
    ditherField.style.display = renderMode === "braille" ? "" : "none";
    thresholdField.style.display = renderMode === "ascii" ? "none" : "";
    invertField.style.display = renderMode === "edges" ? "none" : "";
    charsetField.style.display = renderMode === "ascii" ? "" : "none";
    paletteField.style.display = renderMode === "ascii" ? "" : "none";
  }

  // If the palette box no longer matches a known preset, reflect that as
  // "Custom" in the dropdown rather than leaving it pointed at a preset
  // it's since diverged from.
  function syncCharsetSelectFromPalette() {
    const matchedPreset = Object.entries(charsetPresets).find(([, v]) => v === paletteInput.value);
    charsetSel.value = matchedPreset ? matchedPreset[0] : "custom";
  }

  renderModeSel.addEventListener("change", function () {
    if (this.value === renderMode) return;
    renderMode = this.value;
    applyRenderModeVisibility();
    updateUrl();
    render();
  });

  ditherSel.addEventListener("change", function () {
    if (this.value === dithererName) return;
    dithererName = this.value;
    updateUrl();
    render();
  });

  charsetSel.addEventListener("change", function () {
    const preset = charsetPresets[this.value];
    if (preset) paletteInput.value = preset;
    updateUrl();
    render();
  });

  paletteInput.addEventListener("input", function () {
    syncCharsetSelectFromPalette();
    updateUrl();
    render();
  });

  thresholdInput.addEventListener("input", function () {
    thresholdVal.textContent = this.value;
  });
  thresholdInput.addEventListener("change", function () {
    const v = parseInt(this.value, 10);
    if (v === threshold) return;
    threshold = v;
    updateUrl();
    render();
  });

  widthInput.addEventListener("input", function () {
    const v = parseInt(this.value, 10);
    if (!v || v === asciiWidth || v < 1 || v > maxDimension) return;
    asciiWidth = v;
    updateUrl();
    render();
  });

  heightInput.addEventListener("input", function () {
    if (lockAspect) return;
    const v = parseInt(this.value, 10);
    if (!v || v === manualHeight || v < 1 || v > maxDimension) return;
    manualHeight = v;
    updateUrl();
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
    updateUrl();
    render();
  });

  brightnessInput.addEventListener("input", function () {
    brightnessVal.textContent = this.value;
  });
  brightnessInput.addEventListener("change", function () {
    const v = parseInt(this.value, 10);
    if (v === brightness) return;
    brightness = v;
    updateUrl();
    render();
  });

  blackPointInput.addEventListener("input", function () {
    blackPointVal.textContent = this.value;
  });
  blackPointInput.addEventListener("change", function () {
    const v = parseInt(this.value, 10);
    if (v === blackPoint) return;
    blackPoint = v;
    updateUrl();
    render();
  });

  whitePointInput.addEventListener("input", function () {
    whitePointVal.textContent = this.value;
  });
  whitePointInput.addEventListener("change", function () {
    const v = parseInt(this.value, 10);
    if (v === whitePoint) return;
    whitePoint = v;
    updateUrl();
    render();
  });

  // Preview size is a local display preference (how big the on-screen text
  // looks), not part of the rendered art itself, so it's deliberately left
  // out of the shareable permalink.
  fontSizeInput.addEventListener("input", function () {
    fontSizeVal.textContent = this.value + "px";
    output.style.setProperty("--font-size", this.value + "px");
  });

  invertInput.addEventListener("change", function () {
    invert = this.checked;
    updateUrl();
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
  const renderModeLabels = { braille: "braille dots", ascii: "ASCII characters", edges: "line-art edges" };

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

    // The rendered grid itself is marked aria-hidden (narrating thousands of
    // characters one by one is useless to a screen reader), so this concise
    // live-region summary - plus the always-accessible Copy/Download buttons
    // - is how a screen reader user finds out anything happened at all.
    srStatus.textContent = `Rendered ${renderModeLabels[renderMode]} art, ${cols} by ${lines.length} characters. Use the Copy or Download buttons to get the text.`;
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

  // Encodes the current settings (never the image itself - sharing a link
  // must never leak someone's uploaded photo) into the URL's query string,
  // so a link can be copied to share or bookmark a particular "look". Height
  // is only encoded when aspect ratio is unlocked, since otherwise it's a
  // derived value, not a setting. Preview size is deliberately excluded -
  // it's a local display preference, not part of the rendered art.
  function updateUrl() {
    const params = new URLSearchParams();
    if (renderMode !== "braille") params.set("mode", renderMode);
    if (dithererName !== "floydSteinberg") params.set("dither", dithererName);
    if (paletteInput.value !== asciiRamp) params.set("palette", paletteInput.value);
    if (threshold !== 127) params.set("threshold", threshold);
    if (asciiWidth !== 100) params.set("width", asciiWidth);
    if (!lockAspect) {
      params.set("lock", "0");
      params.set("height", manualHeight);
    }
    if (brightness !== 0) params.set("brightness", brightness);
    if (blackPoint !== 0) params.set("black", blackPoint);
    if (whitePoint !== 255) params.set("white", whitePoint);
    if (invert) params.set("invert", "1");

    const query = params.toString();
    history.replaceState(null, "", query ? `?${query}` : location.pathname);
  }

  // Restores settings from the URL on load (the counterpart to updateUrl).
  // Every value is validated before use, since a hand-edited or malformed
  // URL is untrusted input, not just our own previously-generated output.
  function restoreSettingsFromUrl() {
    const params = new URLSearchParams(location.search);
    if (!params.toString()) return;

    const mode = params.get("mode");
    if (["braille", "ascii", "edges"].includes(mode)) {
      renderMode = mode;
      renderModeSel.value = mode;
    }
    applyRenderModeVisibility();

    const dither = params.get("dither");
    if (dither && ditherers[dither]) {
      dithererName = dither;
      ditherSel.value = dither;
    }

    if (params.has("palette")) {
      paletteInput.value = params.get("palette");
      syncCharsetSelectFromPalette();
    }

    const intParam = (key, min, max) => {
      if (!params.has(key)) return null;
      const v = parseInt(params.get(key), 10);
      return Number.isFinite(v) && v >= min && v <= max ? v : null;
    };

    const t = intParam("threshold", 0, 254);
    if (t !== null) {
      threshold = t;
      thresholdInput.value = t;
      thresholdVal.textContent = t;
    }

    const w = intParam("width", 1, maxDimension);
    if (w !== null) {
      asciiWidth = w;
      widthInput.value = w;
    }

    if (params.get("lock") === "0") {
      lockAspect = false;
      lockAspectInput.checked = false;
      heightInput.disabled = false;
      const h = intParam("height", 1, maxDimension);
      if (h !== null) {
        manualHeight = h;
        heightInput.value = h;
      }
    }

    const b = intParam("brightness", -100, 100);
    if (b !== null) {
      brightness = b;
      brightnessInput.value = b;
      brightnessVal.textContent = b;
    }

    const bp = intParam("black", 0, 254);
    if (bp !== null) {
      blackPoint = bp;
      blackPointInput.value = bp;
      blackPointVal.textContent = bp;
    }

    const wp = intParam("white", 1, 255);
    if (wp !== null) {
      whitePoint = wp;
      whitePointInput.value = wp;
      whitePointVal.textContent = wp;
    }

    if (params.get("invert") === "1") {
      invert = true;
      invertInput.checked = true;
    }
  }

  restoreSettingsFromUrl();
})();

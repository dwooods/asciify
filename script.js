// Asciify
// Renders an image as Unicode braille dot-matrix text art in the browser.
// Dithering algorithm ported from Lachlan Arthur's Braille-ASCII-Art
// (https://github.com/LachlanArthur/Braille-ASCII-Art), MIT licensed.

(function () {
  "use strict";

  const { rgbaOffset, ditherers, packBrailleCell, asciiRamp, luminanceToChar } = window.AsciifyDither;

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
  let image = null;
  let ascii = "";

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  const $ = (sel) => document.querySelector(sel);
  const filepicker = $("#filepicker");
  const renderModeSel = $("#renderMode");
  const ditherField = $("#ditherField");
  const thresholdField = $("#thresholdField");
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
  const downloadPngBtn = $("#downloadPngBtn");
  const downloadSvgBtn = $("#downloadSvgBtn");
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
    const isBraille = renderMode === "braille";
    ditherField.style.display = isBraille ? "" : "none";
    thresholdField.style.display = isBraille ? "" : "none";
    render();
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

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportFilename(extension) {
    return `${renderMode === "ascii" ? "ascii" : "braille"}-art.${extension}`;
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

    emptyState.style.display = "none";
    output.style.display = "block";
    output.innerHTML = asciiHtml.join("<br>");
  }

  function renderBrailleMode() {
    // Each output character is one braille cell (asciiXDots x asciiYDots
    // pixels), so the canvas is sized in actual pixels at that multiple of
    // the requested character width/height.
    const asciiHeight = Math.ceil((asciiWidth * asciiXDots * (image.height / image.width)) / asciiYDots);
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

  function renderAsciiMode() {
    // One output character = one sampled pixel: the source image is drawn
    // scaled directly down to the character grid's resolution, so the
    // browser's own image downscaling does the per-cell brightness
    // averaging instead of a hand-rolled sampling loop.
    const asciiHeight = Math.max(1, Math.round(asciiWidth * (image.height / image.width) * asciiCharAspect));
    canvas.width = asciiWidth;
    canvas.height = asciiHeight;

    context.globalCompositeOperation = "source-over";
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.globalCompositeOperation = "luminosity";
    context.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in context) context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const lines = [];
    for (let y = 0; y < canvas.height; y++) {
      let line = "";
      for (let x = 0; x < canvas.width; x++) {
        line += luminanceToChar(data[rgbaOffset(x, y, canvas.width)], asciiRamp, invert);
      }
      lines.push(line);
    }

    finalizeOutput(lines);
  }

  function render() {
    if (!image) return;
    if (renderMode === "ascii") {
      renderAsciiMode();
    } else {
      renderBrailleMode();
    }
  }
})();

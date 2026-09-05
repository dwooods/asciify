// Asciify
// Renders an image as Unicode braille dot-matrix text art in the browser.
// Dithering algorithm ported from Lachlan Arthur's Braille-ASCII-Art
// (https://github.com/LachlanArthur/Braille-ASCII-Art), MIT licensed.

(function () {
  "use strict";

  const {
    rgbaOffset,
    ditherers,
    packBrailleCell,
    asciiRamp,
    asciiRampBlocks,
    asciiRampDetailed,
    asciiRampExtended,
    luminanceToChar,
    sobelGradient,
    edgeChar,
    computeComplexityMap,
    adjustLevels,
    computeImageStats,
    suggestRenderMode,
    suggestSettingsForMode,
  } = window.AsciifyDither;

  const charsetPresets = { standard: asciiRamp, blocks: asciiRampBlocks, detailed: asciiRampDetailed, extended: asciiRampExtended };

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
  let suppressBackground = false;
  // ASCII mode only: when true, computeAsciiLines() uses a reduced 3-
  // character ramp in visually flat/simple cells and the full palette in
  // busy ones, instead of always using the full palette everywhere.
  let adaptiveDetail = false;
  // A user-drawn rectangle (normalized 0-1 image coordinates, or null) that
  // always gets the full palette regardless of measured complexity - set by
  // dragging on the thumbnail overlay (see focusCanvas's listeners below).
  let focusRegion = null;
  let image = null;
  let ascii = "";
  let lastSuggestions = null;
  // Set when the page loaded with an explicit settings permalink (see
  // restoreSettingsFromUrl): a shared link's whole point is reproducing a
  // specific look, so auto-suggest must not immediately override it the
  // moment an image is uploaded. Only suppresses the very next load -
  // later uploads in the same session get auto-suggested normally.
  let suppressNextAutoSuggest = false;

  // Bumped whenever the image changes (a new upload or Clear image) so an
  // in-flight subject-detection request (see requestSubjectMask) that
  // resolves after the image it was computed for is gone can tell it's
  // stale and discard itself instead of touching a now-unrelated image.
  let imageGeneration = 0;

  // Render-time subject masking (the "Suppress background" checkbox): an
  // on-device vision model (see saliency.js) finds the photo's subject, and
  // background-masked cells are blanked in the braille/ASCII/edges render
  // loops (see isBackgroundPixel below) regardless of what other settings
  // are in effect. JOURNEY.md has the full story on why this - not feeding
  // the mask into the auto-suggest heuristic's stats - is the version that
  // actually fixes a busy background showing up in the output: stats only
  // pick a number for the whole frame, they can't remove anything from it.
  let subjectMask = null;
  let subjectMaskWidth = 0;
  let subjectMaskHeight = 0;
  // True while a detectForegroundMask() call is in flight, so toggling the
  // checkbox off and back on before it resolves doesn't fire a second
  // (redundant, several-second) request.
  let subjectMaskPending = false;

  // True if (x, y) in a width x height render buffer falls on a background
  // pixel per the current subjectMask - false (never suppress) when no mask
  // is set, so this is always safe to call unconditionally in the render
  // loops below.
  function isBackgroundPixel(x, y, width, height) {
    if (!subjectMask) return false;
    const mx = Math.min(subjectMaskWidth - 1, Math.floor((x / width) * subjectMaskWidth));
    const my = Math.min(subjectMaskHeight - 1, Math.floor((y / height) * subjectMaskHeight));
    return !subjectMask[my * subjectMaskWidth + mx];
  }

  // Mirrors the initial values above, so "Reset settings" can restore them
  // without touching the loaded image. Preview size isn't included - like
  // the permalink, it's a local display preference, not part of the art.
  const DEFAULTS = {
    renderMode: "braille",
    dithererName: "floydSteinberg",
    invert: false,
    threshold: 127,
    asciiWidth: 100,
    lockAspect: true,
    manualHeight: 50,
    brightness: 0,
    blackPoint: 0,
    whitePoint: 255,
    palette: asciiRamp,
    suppressBackground: false,
    adaptiveDetail: false,
  };

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
  const adaptiveDetailField = $("#adaptiveDetailField");
  const adaptiveDetailInput = $("#adaptiveDetail");
  const adaptiveDetailDesc = $("#adaptiveDetailDesc");
  const focusRegionField = $("#focusRegionField");
  const focusRegionStatus = $("#focusRegionStatus");
  const drawFocusBtn = $("#drawFocusBtn");
  const clearFocusBtn = $("#clearFocusBtn");
  const thumbImgWrap = $("#thumbImgWrap");
  const focusCanvas = $("#focusCanvas");
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
  const suppressBackgroundInput = $("#suppressBackground");
  const suppressBackgroundStatus = $("#suppressBackgroundStatus");
  const suppressBackgroundInfoIcon = $("#suppressBackgroundInfoIcon");
  const suppressBackgroundInfoPopover = $("#suppressBackgroundInfoPopover");
  const resetBtn = $("#resetBtn");
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
  const suggestField = $("#suggestField");
  const suggestionButtons = { braille: $("#suggestBraille"), ascii: $("#suggestAscii"), edges: $("#suggestEdges") };
  const suggestionPreviewEls = { braille: $("#suggestBraillePreview"), ascii: $("#suggestAsciiPreview"), edges: $("#suggestEdgesPreview") };

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
    imageGeneration++;
    subjectMask = null;
    loadError.style.display = "none";
    imageInfo.textContent = `${file.name} · ${formatBytes(file.size)} · ${file.type || "unknown type"}`;
    image = document.createElement("img");
    image.onload = () => {
      imageInfo.textContent += ` · ${image.naturalWidth}×${image.naturalHeight}px`;
      sizeFocusCanvasToImage();
      if (suppressNextAutoSuggest) {
        // A permalink's focusRegion (if any) belongs to this first image,
        // same as the settings suppressNextAutoSuggest itself protects -
        // don't clear it out from under a link that was shared to restore it.
        suppressNextAutoSuggest = false;
        render();
      } else {
        // Any later upload's focus region is about the previous image's
        // content, not this one.
        focusRegion = null;
        runAutoSuggest();
      }
      updateFocusOverlay();
      if (suppressBackground) requestSubjectMask();
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
    imageGeneration++;
    subjectMask = null;
    subjectMaskPending = false;
    resetSuppressBackgroundStatus();
    focusRegion = null;
    cancelFocusDrawing();
    updateFocusOverlay();
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
    suggestField.style.display = "none";
    lastSuggestions = null;
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
    adaptiveDetailField.style.display = renderMode === "ascii" || renderMode === "edges" ? "" : "none";
    focusRegionField.style.display = (renderMode === "ascii" || renderMode === "edges") && adaptiveDetail ? "" : "none";
    adaptiveDetailDesc.textContent =
      renderMode === "edges" ? "fewer stray lines in busy areas" : "full palette in busy areas, simplified elsewhere";
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
    if (renderMode !== "ascii") cancelFocusDrawing();
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

  suppressBackgroundInput.addEventListener("change", function () {
    suppressBackground = this.checked;
    updateUrl();
    if (!suppressBackground) {
      subjectMask = null;
      resetSuppressBackgroundStatus();
      render();
      return;
    }
    // Already have a mask for the current image - e.g. the box was
    // unchecked and re-checked without a new upload - nothing to redo,
    // just apply it.
    if (subjectMask) {
      render();
      return;
    }
    // A request from before the uncheck is still in flight (unchecking
    // doesn't cancel it, only tells its resolution not to apply - see
    // requestSubjectMask). Riding on it instead of starting a redundant
    // second one is correct, but the earlier uncheck already reset this
    // text to the default - without restoring it here, the user sees no
    // feedback at all until that request resolves, as if nothing were
    // happening.
    if (subjectMaskPending) {
      suppressBackgroundStatus.textContent = "detecting subject…";
      return;
    }
    requestSubjectMask();
  });

  // Tap/keyboard fallback for the info icon's native title tooltip - most
  // mobile browsers don't show `title` on tap at all, and it's unreachable
  // without a pointer for keyboard users. Click toggles it; blur or Escape
  // closes it, matching the "help" affordance the desktop hover already
  // gives without stepping on it.
  function toggleSuppressBackgroundInfo(show) {
    const next = show ?? suppressBackgroundInfoPopover.style.display === "none";
    suppressBackgroundInfoPopover.style.display = next ? "block" : "none";
    suppressBackgroundInfoIcon.setAttribute("aria-expanded", String(next));
  }

  suppressBackgroundInfoIcon.addEventListener("click", () => toggleSuppressBackgroundInfo());
  suppressBackgroundInfoIcon.addEventListener("keydown", function (evt) {
    if (evt.key !== "Enter" && evt.key !== " ") return;
    evt.preventDefault();
    toggleSuppressBackgroundInfo();
  });
  suppressBackgroundInfoIcon.addEventListener("blur", () => toggleSuppressBackgroundInfo(false));
  document.addEventListener("click", (evt) => {
    if (evt.target !== suppressBackgroundInfoIcon) toggleSuppressBackgroundInfo(false);
  });

  adaptiveDetailInput.addEventListener("change", function () {
    adaptiveDetail = this.checked;
    applyRenderModeVisibility();
    if (!adaptiveDetail) {
      cancelFocusDrawing();
      focusRegion = null;
      updateFocusOverlay();
    }
    updateUrl();
    render();
  });

  // Manual focus area: a user-drawn rectangle on the thumbnail that always
  // gets the full character palette in Adaptive detail, regardless of what
  // the automatic complexity measurement finds there - the "user overrides
  // the heuristic" half of adaptive detail, distinct from (and layered on
  // top of) the automatic half.
  let drawingFocus = false;
  let focusDragStart = null;

  function sizeFocusCanvasToImage() {
    focusCanvas.width = thumbImgWrap.clientWidth;
    focusCanvas.height = thumbImgWrap.clientHeight;
  }

  function focusPointFromEvent(evt) {
    const rect = focusCanvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (evt.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (evt.clientY - rect.top) / rect.height)),
    };
  }

  function normalizedRegionFrom(a, b) {
    return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  }

  function cancelFocusDrawing() {
    drawingFocus = false;
    focusDragStart = null;
    focusCanvas.classList.remove("drawing");
  }

  function updateFocusOverlay() {
    focusCanvas.classList.toggle("has-region", !!focusRegion && !drawingFocus);
    const ctx = focusCanvas.getContext("2d");
    ctx.clearRect(0, 0, focusCanvas.width, focusCanvas.height);
    if (!focusRegion) {
      focusRegionStatus.textContent = "optional - always full detail";
      return;
    }
    ctx.strokeStyle = "#e05a2b";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      focusRegion.x0 * focusCanvas.width,
      focusRegion.y0 * focusCanvas.height,
      (focusRegion.x1 - focusRegion.x0) * focusCanvas.width,
      (focusRegion.y1 - focusRegion.y0) * focusCanvas.height
    );
    focusRegionStatus.textContent = "set - tap Clear to remove";
  }

  drawFocusBtn.addEventListener("click", function () {
    if (!image) return;
    sizeFocusCanvasToImage();
    drawingFocus = true;
    focusDragStart = null;
    focusCanvas.classList.add("drawing");
    updateFocusOverlay();
  });

  clearFocusBtn.addEventListener("click", function () {
    focusRegion = null;
    cancelFocusDrawing();
    updateFocusOverlay();
    updateUrl();
    render();
  });

  // Shared by both mouse and touch input, so dragging a focus rectangle
  // works the same way (and is tested the same way) regardless of device.
  function startFocusDrag(point) {
    if (!drawingFocus) return;
    focusDragStart = point;
  }

  function updateFocusDrag(point) {
    if (!drawingFocus || !focusDragStart) return;
    focusRegion = normalizedRegionFrom(focusDragStart, point);
    updateFocusOverlay();
  }

  function finishFocusDrag(point) {
    if (!drawingFocus || !focusDragStart) return;
    const region = normalizedRegionFrom(focusDragStart, point);
    // A tap/click without a real drag draws a degenerate sliver - treat it
    // as "no region" rather than leaving an invisible, effectively-empty one.
    focusRegion = region.x1 - region.x0 >= 0.02 && region.y1 - region.y0 >= 0.02 ? region : null;
    cancelFocusDrawing();
    updateFocusOverlay();
    updateUrl();
    render();
  }

  function focusPointFromTouch(evt) {
    const touch = evt.touches[0] || evt.changedTouches[0];
    return focusPointFromEvent({ clientX: touch.clientX, clientY: touch.clientY });
  }

  focusCanvas.addEventListener("mousedown", (evt) => startFocusDrag(focusPointFromEvent(evt)));
  focusCanvas.addEventListener("mousemove", (evt) => updateFocusDrag(focusPointFromEvent(evt)));
  focusCanvas.addEventListener("mouseup", (evt) => finishFocusDrag(focusPointFromEvent(evt)));

  // Touch equivalents - preventDefault while actively drawing so dragging a
  // finger across the canvas draws a rectangle instead of scrolling the
  // page. Only suppressed while drawingFocus is true, so touch scrolling
  // elsewhere on the page (and taps that aren't drawing) are unaffected.
  focusCanvas.addEventListener(
    "touchstart",
    (evt) => {
      if (!drawingFocus) return;
      evt.preventDefault();
      startFocusDrag(focusPointFromTouch(evt));
    },
    { passive: false }
  );
  focusCanvas.addEventListener(
    "touchmove",
    (evt) => {
      if (!drawingFocus) return;
      evt.preventDefault();
      updateFocusDrag(focusPointFromTouch(evt));
    },
    { passive: false }
  );
  focusCanvas.addEventListener(
    "touchend",
    (evt) => {
      if (!drawingFocus) return;
      evt.preventDefault();
      finishFocusDrag(focusPointFromTouch(evt));
    },
    { passive: false }
  );

  // True if (x, y) in a width x height render buffer falls inside the
  // user-drawn focus region (see above) - false (never forced) when no
  // region is set, so this is always safe to call unconditionally.
  function isInFocusRegion(x, y, width, height) {
    if (!focusRegion) return false;
    const fx = x / width, fy = y / height;
    return fx >= focusRegion.x0 && fx <= focusRegion.x1 && fy >= focusRegion.y0 && fy <= focusRegion.y1;
  }

  // Restores every adjustment to its default, keeping the loaded image (if
  // any) in place, so a heavily-tweaked image can be started over cleanly
  // without re-uploading it.
  resetBtn.addEventListener("click", function () {
    renderMode = DEFAULTS.renderMode;
    renderModeSel.value = renderMode;
    applyRenderModeVisibility();

    dithererName = DEFAULTS.dithererName;
    ditherSel.value = dithererName;

    paletteInput.value = DEFAULTS.palette;
    syncCharsetSelectFromPalette();

    threshold = DEFAULTS.threshold;
    thresholdInput.value = threshold;
    thresholdVal.textContent = threshold;

    asciiWidth = DEFAULTS.asciiWidth;
    widthInput.value = asciiWidth;

    lockAspect = DEFAULTS.lockAspect;
    lockAspectInput.checked = lockAspect;
    heightInput.disabled = lockAspect;
    manualHeight = DEFAULTS.manualHeight;
    heightInput.value = manualHeight;

    brightness = DEFAULTS.brightness;
    brightnessInput.value = brightness;
    brightnessVal.textContent = brightness;

    blackPoint = DEFAULTS.blackPoint;
    blackPointInput.value = blackPoint;
    blackPointVal.textContent = blackPoint;

    whitePoint = DEFAULTS.whitePoint;
    whitePointInput.value = whitePoint;
    whitePointVal.textContent = whitePoint;

    invert = DEFAULTS.invert;
    invertInput.checked = invert;

    suppressBackground = DEFAULTS.suppressBackground;
    suppressBackgroundInput.checked = suppressBackground;
    subjectMask = null;
    resetSuppressBackgroundStatus();

    adaptiveDetail = DEFAULTS.adaptiveDetail;
    adaptiveDetailInput.checked = adaptiveDetail;
    focusRegion = null;
    cancelFocusDrawing();
    updateFocusOverlay();
    applyRenderModeVisibility();

    updateUrl();
    if (image) {
      // finalizeOutput() announces the fresh render itself, which is more
      // useful than a generic "reset" message once there's real output.
      render();
    } else {
      srStatus.textContent = "Settings reset to defaults.";
    }
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

  // Matches #output's CSS exactly (line-height: 1em, span width: 0.5em),
  // so exports reproduce the same on-screen proportions for every render
  // mode. This is deliberately NOT derived from the font's own glyph
  // metrics (e.g. canvas measureText) - those vary by font/platform and
  // don't match the live page's fixed cell width, which previously made
  // exports come out visibly stretched relative to the on-screen preview.
  const cellAspect = 0.5; // width : height, per character cell

  // Shared sizing math for the PNG/SVG exports: both need the same grid
  // dimensions in pixels.
  function measureAsciiGrid(lines) {
    const lineHeight = exportFontSize;
    const padding = exportFontSize;
    const charWidth = exportFontSize * cellAspect;
    const cols = lines.reduce((max, l) => Math.max(max, l.length), 0);
    return {
      lineHeight,
      padding,
      charWidth,
      width: Math.ceil(charWidth * cols) + padding * 2,
      height: lineHeight * lines.length + padding * 2,
    };
  }

  // Rasterizes the same text grid to a canvas so the dots survive outside a
  // monospace context (Discord, GitHub comments, print). Renders black text
  // on a white background regardless of the page's light/dark theme, since
  // the point is a portable, printable image rather than a screenshot of
  // the app itself. Draws one character at a time at a fixed x-step
  // (charWidth) rather than calling fillText once per line - canvas text
  // layout otherwise uses the font's own (wider, inconsistent) advance
  // width per character, which is what caused the stretching this fixes.
  function renderAsciiToCanvas() {
    const lines = ascii.split("\n");
    const { lineHeight, padding, charWidth, width, height } = measureAsciiGrid(lines);

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = width;
    exportCanvas.height = height;

    const ctx = exportCanvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "black";
    ctx.font = `${exportFontSize}px ${exportFontFamily}`;
    ctx.textBaseline = "top";
    lines.forEach((line, lineIndex) => {
      for (let i = 0; i < line.length; i++) {
        ctx.fillText(line[i], padding + i * charWidth, padding + lineIndex * lineHeight);
      }
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
    const { lineHeight, padding, charWidth, width, height } = measureAsciiGrid(lines);

    // textLength + lengthAdjust force each line to render at exactly
    // charWidth * length regardless of whatever font actually ends up
    // displaying the SVG (which may not even have the requested font
    // installed) - the same fixed-width-per-character guarantee the
    // canvas export gets from drawing character-by-character.
    const textEls = lines
      .map(
        (line, i) =>
          `<text x="${padding}" y="${padding + i * lineHeight + exportFontSize * 0.8}" textLength="${charWidth * line.length}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${escapeXml(line)}</text>`
      )
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

  // Computes the character grid for braille mode without touching the DOM,
  // so it can be reused both for the real render and for the auto-suggest
  // preview thumbnails (which must not disturb the live output).
  function computeBrailleLines() {
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
        line.push(
          isBackgroundPixel(x, y, canvas.width, canvas.height)
            ? 0x2800 // blank braille cell (no dots)
            : packBrailleCell(dithered.data, x, y, canvas.width, targetValue)
        );
      }
      lines.push(String.fromCharCode.apply(String, line));
    }

    return lines;
  }

  function renderBrailleMode() {
    finalizeOutput(computeBrailleLines());
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

  // Window radius (in character-grid cells) computeComplexityMap() looks at
  // around each cell - "3-5 pixel window" at this grid's resolution.
  const adaptiveDetailWindowRadius = 2;

  // A cell's complexity score (see computeComplexityMap in dither.js) at or
  // above this counts as "busy enough" for the full palette; below it, the
  // reduced ramp applies instead. Calibrated by eye against real photos:
  // low enough that ordinary subject detail still gets the full ramp, high
  // enough that faint background grain/gradients collapse to the reduced
  // one instead of flickering between adjacent ramp characters.
  const adaptiveDetailThreshold = 0.12;

  // Collapses a ramp to 3 characters (darkest, middle, lightest) spanning
  // the same range - enough to still read as light/mid/dark shading, with
  // far less tonal jitter than the full ramp on near-flat input. Ramps of
  // 3 characters or fewer are already "reduced", so they're used as-is.
  function reducedRamp(ramp) {
    if (ramp.length <= 3) return ramp;
    return ramp[0] + ramp[Math.floor((ramp.length - 1) / 2)] + ramp[ramp.length - 1];
  }

  function computeAsciiLines() {
    // Falls back to the standard ramp if the palette box is emptied out -
    // an empty ramp has no valid character to index into.
    const ramp = paletteInput.value || asciiRamp;
    const simplifiedRamp = reducedRamp(ramp);
    const { data, width, height } = prepareCharacterGrid();
    const complexity = adaptiveDetail ? computeComplexityMap(data, width, height, adaptiveDetailWindowRadius) : null;

    const lines = [];
    for (let y = 0; y < height; y++) {
      let line = "";
      for (let x = 0; x < width; x++) {
        if (isBackgroundPixel(x, y, width, height)) {
          line += " ";
          continue;
        }
        const useReduced = complexity && complexity[y * width + x] < adaptiveDetailThreshold && !isInFocusRegion(x, y, width, height);
        line += luminanceToChar(data[rgbaOffset(x, y, width)], useReduced ? simplifiedRamp : ramp, invert);
      }
      lines.push(line);
    }
    return lines;
  }

  function renderAsciiMode() {
    finalizeOutput(computeAsciiLines());
  }

  // How much higher the effective edge threshold gets in a "busy" cell (see
  // adaptiveDetailThreshold/computeComplexityMap) - on the same raw scale as
  // the Threshold slider (0-254). Dense parallel lines (a grille, a tread
  // pattern) or fine texture (fur, foliage) alias into visual noise once
  // downsampled to the character grid; raising the bar there keeps only the
  // strongest lines instead of a jumble, while flat regions keep the
  // slider's own threshold untouched. Calibrated by eye against
  // test-assets/truck.jpg (grille/tread), car.jpg, and high contrast
  // tiger.png (stripe texture) - 60+ started erasing real outline structure
  // along with the noise; 40 was the highest value that still visibly
  // decluttered without doing that.
  const edgesAdaptiveThresholdBoost = 40;

  function computeEdgesLines() {
    // Reuses the "Threshold" slider as edge sensitivity: a Sobel gradient's
    // magnitude is normalized to roughly the same 0-255 range that slider
    // already covers for the dithering threshold (see sobelMaxMagnitude).
    const { data, width, height } = prepareCharacterGrid();
    const complexity = adaptiveDetail ? computeComplexityMap(data, width, height, adaptiveDetailWindowRadius) : null;
    const lines = [];
    for (let y = 0; y < height; y++) {
      let line = "";
      for (let x = 0; x < width; x++) {
        if (isBackgroundPixel(x, y, width, height)) {
          line += " ";
          continue;
        }
        const { dx, dy } = sobelGradient(data, x, y, width, height);
        const busy = complexity && complexity[y * width + x] >= adaptiveDetailThreshold && !isInFocusRegion(x, y, width, height);
        line += edgeChar(dx, dy, busy ? threshold + edgesAdaptiveThresholdBoost : threshold);
      }
      lines.push(line);
    }
    return lines;
  }

  function renderEdgesMode() {
    finalizeOutput(computeEdgesLines());
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

  function computeLinesForMode(mode) {
    if (mode === "ascii") return computeAsciiLines();
    if (mode === "edges") return computeEdgesLines();
    return computeBrailleLines();
  }

  // A fixed, small working resolution for measuring an image's own
  // brightness/contrast/edge stats - independent of whatever the live
  // output width happens to be set to, so suggestions don't shift just
  // because the width slider was touched earlier.
  const statsWorkWidth = 120;

  function statsWorkHeightFor(image) {
    return Math.max(1, Math.round(statsWorkWidth * (image.height / image.width)));
  }

  function computeStatsForImage() {
    const height = statsWorkHeightFor(image);
    canvas.width = statsWorkWidth;
    canvas.height = height;

    context.globalCompositeOperation = "source-over";
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.globalCompositeOperation = "luminosity";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    return computeImageStats(imageData.data, canvas.width, canvas.height);
  }

  // A small width for the suggestion thumbnails - just enough to be
  // recognizable as a shape, not a full-fidelity render.
  const previewWidth = 32;

  // Computes the character-grid text for a settings suggestion without
  // touching the live render/output: temporarily swaps in the suggested
  // settings, computes the lines through the same tested render path
  // every other mode uses, then restores everything exactly as it was.
  function renderPreviewText(settings) {
    const saved = { renderMode, dithererName, threshold, asciiWidth, blackPoint, whitePoint, palette: paletteInput.value };

    renderMode = settings.renderMode;
    if (settings.dithererName) dithererName = settings.dithererName;
    if (settings.threshold !== undefined) threshold = settings.threshold;
    if (settings.charsetKey) paletteInput.value = charsetPresets[settings.charsetKey];
    blackPoint = settings.blackPoint;
    whitePoint = settings.whitePoint;
    asciiWidth = previewWidth;

    const lines = computeLinesForMode(renderMode);

    renderMode = saved.renderMode;
    dithererName = saved.dithererName;
    threshold = saved.threshold;
    asciiWidth = saved.asciiWidth;
    blackPoint = saved.blackPoint;
    whitePoint = saved.whitePoint;
    paletteInput.value = saved.palette;

    return lines.join("\n");
  }

  // Applies one mode's suggested settings (render mode, dither/charset,
  // threshold, levels) to the live state and controls. Only touches the
  // fields a suggestion actually specifies - width, aspect lock, and
  // invert are left as they are, since the heuristic doesn't have an
  // opinion on those.
  function applySuggestedSettings(settings) {
    renderMode = settings.renderMode;
    renderModeSel.value = renderMode;
    applyRenderModeVisibility();

    if (settings.dithererName) {
      dithererName = settings.dithererName;
      ditherSel.value = dithererName;
    }

    if (settings.charsetKey) {
      paletteInput.value = charsetPresets[settings.charsetKey];
      syncCharsetSelectFromPalette();
    }

    if (settings.threshold !== undefined) {
      threshold = settings.threshold;
      thresholdInput.value = threshold;
      thresholdVal.textContent = threshold;
    }

    blackPoint = settings.blackPoint;
    blackPointInput.value = blackPoint;
    blackPointVal.textContent = blackPoint;

    whitePoint = settings.whitePoint;
    whitePointInput.value = whitePoint;
    whitePointVal.textContent = whitePoint;
  }

  function highlightSuggestion(mode) {
    Object.entries(suggestionButtons).forEach(([key, btn]) => btn.classList.toggle("selected", key === mode));
  }

  // Runs on every fresh image load: measures the image's own stats and
  // suggests a full settings preset for all three render modes, previews
  // each as a small thumbnail, and applies the single best-guess mode
  // live so there's a sensible starting point without any clicking. This
  // is a heuristic based on image statistics, not real scene
  // understanding - a reasonable starting point, not a guaranteed-best
  // artistic choice. Deliberately has nothing to do with the "Suppress
  // background" model (see requestSubjectMask) - JOURNEY.md covers why
  // feeding that mask into these stats seemed like the same idea but
  // didn't actually fix anything.
  function runAutoSuggest() {
    if (!image) return;
    const stats = computeStatsForImage();
    const bestMode = suggestRenderMode(stats);
    const suggestions = {
      braille: suggestSettingsForMode("braille", stats),
      ascii: suggestSettingsForMode("ascii", stats),
      edges: suggestSettingsForMode("edges", stats),
    };
    lastSuggestions = suggestions;

    Object.entries(suggestions).forEach(([mode, settings]) => {
      suggestionPreviewEls[mode].textContent = renderPreviewText(settings);
    });

    applySuggestedSettings(suggestions[bestMode]);
    updateUrl();
    render();

    highlightSuggestion(bestMode);
    suggestField.style.display = "";
  }

  const defaultSuppressBackgroundStatus = suppressBackgroundStatus.textContent;

  function resetSuppressBackgroundStatus() {
    suppressBackgroundStatus.textContent = defaultSuppressBackgroundStatus;
  }

  // The model's own output resolution - requesting a mask coarser than this
  // loses nothing, and requesting one finer than this just upsamples the
  // model's own output, so this is the natural resolution ceiling regardless
  // of how wide the actual render ends up being.
  const maxMaskDimension = 320;

  // Aspect-correct mask dimensions for `img`, capped at maxMaskDimension on
  // the longer side. A render wider than this (e.g. a large custom Width)
  // will show a visibly blockier subject/background boundary than the rest
  // of the render - an inherent limit of a 320x320 segmentation model, not
  // a bug to chase.
  function maskDimensionsFor(img) {
    const aspect = img.naturalHeight / img.naturalWidth;
    if (aspect <= 1) {
      const width = maxMaskDimension;
      return { width, height: Math.max(1, Math.round(width * aspect)) };
    }
    const height = maxMaskDimension;
    return { width: Math.max(1, Math.round(height / aspect)), height };
  }

  // Kicks off the on-device subject-detection model (see saliency.js) for
  // the current image and, once it resolves, stores the mask for render-
  // time background suppression (see isBackgroundPixel/subjectMask) and
  // re-renders - independent of whatever render mode/settings are active,
  // since this only ever removes pixels from a render already chosen, never
  // changes what settings get chosen. If the model is unavailable (file://,
  // offline, blocked) or the image changes/clears before it resolves, this
  // leaves the render exactly as it already was.
  function requestSubjectMask() {
    if (!window.AsciifySaliency || !image) return;
    const generation = imageGeneration;
    const { width, height } = maskDimensionsFor(image);
    subjectMaskPending = true;
    suppressBackgroundStatus.textContent = "detecting subject…";

    window.AsciifySaliency
      .detectForegroundMask(image, image.naturalWidth, image.naturalHeight, width, height)
      .then((mask) => {
        if (generation !== imageGeneration) return; // image changed/cleared meanwhile
        subjectMaskPending = false;
        // The checkbox may have been unchecked while this was in flight -
        // don't silently turn suppression back on against that.
        if (!suppressBackground) return;
        if (!mask) {
          suppressBackgroundStatus.textContent = "unavailable - showing the full frame";
          return;
        }

        subjectMask = mask;
        subjectMaskWidth = width;
        subjectMaskHeight = height;
        resetSuppressBackgroundStatus();
        render();
        srStatus.textContent = "Background suppressed using on-device subject detection.";
      });
  }

  Object.entries(suggestionButtons).forEach(([mode, btn]) => {
    btn.addEventListener("click", function () {
      if (!lastSuggestions) return;
      applySuggestedSettings(lastSuggestions[mode]);
      updateUrl();
      render();
      highlightSuggestion(mode);
    });
  });

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
    if (suppressBackground) params.set("suppress", "1");
    if (adaptiveDetail) {
      params.set("adaptive", "1");
      if (focusRegion) {
        const r = focusRegion;
        params.set("focus", [r.x0, r.y0, r.x1, r.y1].map((v) => v.toFixed(3)).join(","));
      }
    }

    const query = params.toString();
    history.replaceState(null, "", query ? `?${query}` : location.pathname);
  }

  // Restores settings from the URL on load (the counterpart to updateUrl).
  // Every value is validated before use, since a hand-edited or malformed
  // URL is untrusted input, not just our own previously-generated output.
  function restoreSettingsFromUrl() {
    const params = new URLSearchParams(location.search);

    const mode = params.get("mode");
    if (["braille", "ascii", "edges"].includes(mode)) {
      renderMode = mode;
      renderModeSel.value = mode;
    }
    // Applies even with no query string at all, so the panel's field
    // visibility always matches renderMode on first load, not whatever
    // the raw HTML happens to show before any JS has run.
    applyRenderModeVisibility();

    if (!params.toString()) return;

    // A permalink's whole point is reproducing a specific look, so the
    // first image uploaded under it must not get silently overridden by
    // auto-suggest.
    suppressNextAutoSuggest = true;

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

    if (params.get("suppress") === "1") {
      suppressBackground = true;
      suppressBackgroundInput.checked = true;
    }

    if (params.get("adaptive") === "1") {
      adaptiveDetail = true;
      adaptiveDetailInput.checked = true;

      const focusParam = params.get("focus");
      if (focusParam) {
        const parts = focusParam.split(",").map(Number);
        const [x0, y0, x1, y1] = parts;
        const valid = parts.length === 4 && parts.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) && x0 < x1 && y0 < y1;
        if (valid) focusRegion = { x0, y0, x1, y1 };
      }
      applyRenderModeVisibility();
    }
  }

  restoreSettingsFromUrl();
})();

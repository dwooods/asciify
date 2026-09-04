// On-device subject detection: an optional, best-effort enhancement layer
// that runs a small salient-object-detection model (U²-Netp, see
// vendor/README.md) to find which pixels of an uploaded photo are the
// actual subject, so script.js can ask dither.js's computeImageStats() for
// stats about the subject instead of the whole frame (background clutter,
// framing, negative space) - see JOURNEY.md for why: three separate
// auto-suggest heuristic bugs all traced back to global stats not knowing
// what the subject was.
//
// This is a progressive enhancement, not a dependency: model loading
// requires fetch(), which fails under file:// and when offline/blocked, so
// every public function here resolves to null on any failure instead of
// throwing - callers fall back to today's whole-frame heuristic exactly as
// if this file didn't exist. Depends on onnxruntime-web's `ort` global
// (vendor/onnxruntime-web/ort.min.js, loaded before this file) and DOM/
// canvas, so - like script.js, and unlike dither.js - this isn't unit
// tested under Node; it's covered by the Playwright suite in
// tests/ui.test.js instead.
(function (global) {
  "use strict";

  // Leading "./" matters, not just style: this is loaded via a dynamic
  // import() internally, and a bare "vendor/..." path (no leading "./",
  // "../", or scheme) is an invalid/bare module specifier that browsers
  // reject outright, unlike a plain fetch() which resolves a bare relative
  // path against the document's URL just fine.
  const MODEL_URL = "./vendor/models/u2netp.onnx";
  const INPUT_SIZE = 320;
  // ImageNet mean/std, matching how the source model was trained - see
  // vendor/README.md for provenance.
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];
  // Above this normalized-to-0-255 mask value, a pixel counts as "subject".
  const MASK_THRESHOLD = 128;

  let sessionPromise = null;

  function getOrt() {
    return typeof global.ort !== "undefined" ? global.ort : null;
  }

  function createSession() {
    const ort = getOrt();
    if (!ort) return Promise.reject(new Error("onnxruntime-web is not loaded"));
    // Threaded WASM needs cross-origin-isolation headers (COOP/COEP) that a
    // plain static file server - the only kind this project requires - won't
    // set, so pin to a single thread rather than let it try and fail.
    ort.env.wasm.numThreads = 1;
    // ort.min.js defaults to a WebGPU-capable "jsep" WASM binary even when
    // only the "wasm" execution provider is requested (26 MB vs. 13 MB) -
    // point it at the smaller CPU-only build instead (see vendor/README.md).
    // The two paths resolve against different bases, so they need different
    // prefixes despite naming files in the same directory: `mjs` is loaded
    // via a dynamic import(), which resolves a relative specifier against
    // the *importing script's* URL (ort.min.js, itself under
    // vendor/onnxruntime-web/) - a "vendor/..." prefix here would double up
    // the directory. `wasm` is loaded via fetch() by that .mjs module,
    // which resolves a relative URL against the *document's* URL instead,
    // so it needs the full path from the document root.
    ort.env.wasm.wasmPaths = {
      mjs: "./ort-wasm-simd-threaded.mjs",
      wasm: "./vendor/onnxruntime-web/ort-wasm-simd-threaded.wasm",
    };
    return ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  }

  // Lazily creates and caches the inference session (WASM init + model
  // parse is the slow, one-time part - see JOURNEY.md for measured
  // latency). A failure isn't cached, so a transient problem (e.g. a slow
  // first fetch timing out) doesn't permanently disable the feature for the
  // rest of the page's lifetime.
  function getSession() {
    if (!sessionPromise) {
      sessionPromise = createSession().catch((err) => {
        sessionPromise = null;
        throw err;
      });
    }
    return sessionPromise;
  }

  // Draws any canvas-drawable source into a fresh size x size square canvas
  // (matching the model's fixed input resolution) and reads it back as
  // ImageData. Squashes rather than letterboxes, matching how the source
  // model was trained.
  function drawToSquare(source, sourceWidth, sourceHeight, size) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size);
  }

  // NCHW float32 input tensor data: each channel scaled by the image's own
  // max channel value (not a flat /255) then ImageNet-normalized - matching
  // vendor/models/u2netp.onnx's expected preprocessing (see vendor/README.md).
  function preprocess(imageData) {
    const { data, width, height } = imageData;
    const n = width * height;
    const out = new Float32Array(3 * n);
    let maxVal = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > maxVal) maxVal = data[i];
      if (data[i + 1] > maxVal) maxVal = data[i + 1];
      if (data[i + 2] > maxVal) maxVal = data[i + 2];
    }
    maxVal = Math.max(maxVal, 1e-6);
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      out[p] = (data[i] / maxVal - MEAN[0]) / STD[0];
      out[n + p] = (data[i + 1] / maxVal - MEAN[1]) / STD[1];
      out[2 * n + p] = (data[i + 2] / maxVal - MEAN[2]) / STD[2];
    }
    return out;
  }

  // Min-max normalizes the model's raw single-channel output to 0-255 and
  // draws it into a canvas at the model's native resolution, so it can be
  // resampled down to the caller's working resolution with the browser's
  // own (bilinear) image scaling rather than a hand-rolled resize.
  function outputToMaskCanvas(outputData, width, height) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < outputData.length; i++) {
      if (outputData[i] < min) min = outputData[i];
      if (outputData[i] > max) max = outputData[i];
    }
    const range = Math.max(max - min, 1e-6);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(width, height);
    for (let i = 0, p = 0; i < outputData.length; i++, p += 4) {
      const v = Math.max(0, Math.min(255, Math.round(((outputData[i] - min) / range) * 255)));
      imageData.data[p] = v;
      imageData.data[p + 1] = v;
      imageData.data[p + 2] = v;
      imageData.data[p + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  // Resamples a greyscale mask canvas down to targetWidth x targetHeight and
  // thresholds it into a one-byte-per-pixel 0/1 mask aligned with a
  // computeImageStats()-style pixel buffer at that resolution.
  function maskCanvasToBuffer(maskCanvas, targetWidth, targetHeight) {
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(maskCanvas, 0, 0, targetWidth, targetHeight);
    const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);

    const mask = new Uint8Array(targetWidth * targetHeight);
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      mask[i] = imageData.data[p] > MASK_THRESHOLD ? 1 : 0;
    }
    return mask;
  }

  // Runs subject detection on `source` (anything drawImage() accepts - this
  // project always passes the loaded HTMLImageElement) and returns a
  // Promise for a Uint8Array mask (1 = subject, 0 = background) sized
  // targetWidth x targetHeight, i.e. ready to pass straight into
  // AsciifyDither.computeImageStats(). Resolves to null - never rejects -
  // on any failure: model/network unavailable (file://, offline, blocked),
  // an unsupported browser, or anything else going wrong. Errors are logged
  // once for debugging, not surfaced to the user - this is a silent
  // best-effort refinement, not a feature the app depends on.
  async function detectForegroundMask(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
    try {
      const session = await getSession();
      const inputImage = drawToSquare(source, sourceWidth, sourceHeight, INPUT_SIZE);
      const inputData = preprocess(inputImage);
      const tensor = new global.ort.Tensor("float32", inputData, [1, 3, INPUT_SIZE, INPUT_SIZE]);
      const feeds = { [session.inputNames[0]]: tensor };
      const results = await session.run(feeds);
      const output = results[session.outputNames[0]] ?? Object.values(results)[0];
      const maskCanvas = outputToMaskCanvas(output.data, INPUT_SIZE, INPUT_SIZE);
      return maskCanvasToBuffer(maskCanvas, targetWidth, targetHeight);
    } catch (err) {
      console.warn("Asciify: on-device subject detection unavailable, using whole-frame stats instead.", err);
      return null;
    }
  }

  global.AsciifySaliency = { detectForegroundMask };
})(typeof window !== "undefined" ? window : globalThis);

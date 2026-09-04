# Vendored files

Committed directly into the repo (per project decision — see `JOURNEY.md`)
so the on-device subject-detection enhancement keeps working offline once
served over `http(s)`, with no CDN dependency and no build step.

## `onnxruntime-web/`

- **What**: Microsoft's [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) v1.27.0, browser build.
- **Files**: `ort.min.js` (the plain, non-module `<script>`-tag build - exposes
  a global `ort`, no bundler required) and the single-threaded WASM backend
  it loads at runtime (`ort-wasm-simd-threaded.wasm` + its `.mjs` loader).
  `ort.min.js` defaults to a larger WebGPU-capable ("jsep") WASM binary even
  when only the `wasm` execution provider is requested; `saliency.js`
  explicitly points `ort.env.wasm.wasmPaths` at these smaller CPU-only files
  instead (13 MB vs. 26 MB).
- **Source**: `npm pack onnxruntime-web@1.27.0`, `dist/` folder.
- **License**: MIT.

## `models/u2netp.onnx`

- **What**: U²-Netp, the lightweight variant of
  [U²-Net](https://github.com/xuebinqin/U-2-Net) - a class-agnostic salient
  object detection model (finds "the subject" of a photo regardless of what
  it is, rather than needing to recognize it as one of a fixed list of
  trained categories). Used here to separate a photo's actual subject from
  its background before computing the auto-suggest heuristic's brightness/
  contrast/edge statistics, instead of measuring the whole frame.
- **Source**: the pretrained weights bundled with
  [`@planby-tech/rmbg-webgpu`](https://www.npmjs.com/package/@planby-tech/rmbg-webgpu)
  v0.2.1 (`models/u2netp.onnx`), traced back to the original U-2-Net project.
- **License**: Apache License 2.0 (see `LICENSE-Apache-2.0.txt` in this
  directory).
- **Input/preprocessing**: 320x320 RGB, scaled by the image's own max
  channel value (not a flat /255), then normalized with ImageNet mean
  `[0.485, 0.456, 0.406]` / std `[0.229, 0.224, 0.225]`, NCHW float32.
  Output is min-max normalized to a 0-255 greyscale mask.

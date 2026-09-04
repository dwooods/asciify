# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A client-side image-to-braille-text converter: drop in an image, get back Unicode braille dot-matrix text art (U+2800–U+28FF) that pastes anywhere monospace text works. Plain HTML/CSS/JS, no build step — opening `index.html` directly (`file://`) must keep working for the core converter, so nothing here should require a bundler or ES modules. The one exception is the optional "Suppress background" enhancement (see Architecture below): it vendors a real runtime dependency (`onnxruntime-web` + a small vision model) and needs `http(s)`, degrading gracefully to no-op under `file://`/offline/blocked rather than breaking anything.

The dithering/braille-packing approach is ported from [Lachlan Arthur's Braille-ASCII-Art](https://github.com/LachlanArthur/Braille-ASCII-Art) (MIT).

## Commands

```bash
npm test              # run the test suite (node --test)
node --test            # same, directly
python3 -m http.server  # serve locally (needed for APIs file:// restricts)
npx http-server .       # alternative local server
```

There is no build/lint step. `npm install` is needed once to fetch Playwright (the project's only dependency, dev-only, used for the UI test suite) before `npm test` will pass. To run a single test, use Node's built-in filtering, e.g. `node --test --test-name-pattern="packBrailleCell"`.

CI (`.github/workflows/test.yml`) runs `npm test` on every push/PR to `main`. `main` also auto-deploys to GitHub Pages on every push.

## Architecture

The rendering pipeline is split across plain (non-module) scripts loaded in order by `index.html`:

- **`dither.js`** — pure logic only, no DOM access. Exposes `rgbaOffset`, `KernelDitherer`, `ditherers` (threshold/floydSteinberg/stucki/atkinson), and `packBrailleCell` via a UMD-style guard: `window.AsciifyDither` in the browser, `module.exports` under Node. This split exists specifically so the math is unit-testable with Node's built-in test runner without introducing a bundler, transpiler, or `ImageData`/DOM polyfills — `KernelDitherer.dither()` deliberately returns a plain `{width, height, data}` object rather than a real `ImageData` instance, since nothing downstream needs the real DOM type.
- **`script.js`** — all DOM/canvas wiring: reads `window.AsciifyDither`, binds the controls, and does the actual render pipeline in `render()`: draw the source image onto a hidden canvas at `width*2 × height*4` px (2×4 dots per braille cell) → composite in `luminosity` blend mode over white for greyscale → run the selected dithering kernel → pack each 2×4 pixel block into a braille codepoint via `packBrailleCell`. Also owns the "Suppress background" feature's render-time masking (`isBackgroundPixel`, `subjectMask` and friends) - background-masked cells are blanked in each mode's render loop, independent of whatever other settings are active.
- **`saliency.js`** — optional on-device subject detection behind the "Suppress background" checkbox: loads `onnxruntime-web` (vendored, see below) and a small salient-object-detection model (U²-Netp) to compute a subject/background mask for the current image. Every public function resolves to `null` on any failure (model blocked, offline, `file://`, unsupported browser) instead of throwing, so `script.js` always has a trivial fallback: render the whole frame, exactly as if this file weren't there. DOM/canvas-dependent like `script.js`, so it isn't unit tested under Node - covered by `tests/ui.test.js` instead.
- **`vendor/`** — committed third-party runtime for the above: `onnxruntime-web`'s browser build and the U²-Netp model weights (~18 MB total), with provenance and licenses in `vendor/README.md`. Committed rather than loaded from a CDN so the feature keeps working offline once served over `http(s)` - see `JOURNEY.md` for why that decision was made and what it costs.

Keep the dither.js/script.js split intact: any change to the dithering/packing math belongs in `dither.js` (and should get a test in `tests/dither.test.js`); anything touching the UI, events, or rendering orchestration belongs in `script.js`. Keep the on-device-detection code confined to `saliency.js` + the isolated hooks in `script.js` (the checkbox handler, `requestSubjectMask`, `isBackgroundPixel`) - it must never become load-bearing for the core converter.

`tests/dither.test.js` covers the pixel-quantization math and the bit-to-braille-dot mapping (validated against the actual Unicode Braille Patterns dot numbering). `tests/ui.test.js` covers the UI layer — drag-and-drop, paste, file loading and error handling, DOM rendering across all three render modes, exports, the settings permalink, and "Suppress background" (both its graceful-degradation path and, in one dedicated slower test, the real model) — driven with [Playwright](https://playwright.dev/) directly against `node:test` (not the `@playwright/test` runner), so both suites still run under a single `npm test`. That suite blocks `vendor/` requests by default in its shared test setup so the other ~65 tests don't each pay the on-device model's load/inference cost for a feature they aren't testing; only the dedicated test(s) that need the real model use their own unblocked page.

## Working process

For any change beyond a trivial fix, work it like a full engineer + QA pass, not just "make it compile":

1. **Before coding** — name the specific risk this change could hit, not a generic one: does it still work over `file://`? does it handle a 1×1 or non-square image, or a non-image file dropped in? does it change output for an existing dither mode?
2. **After coding** — verify, don't assume:
   - Run `npm test`.
   - Any change touching `render()`, `index.html`, or `style.css` gets a real browser pass (upload an image, cycle dither modes, toggle invert) — "the code looks right" is not verification.
   - Any change to the dithering/packing math gets a new or updated test in `tests/dither.test.js` — don't ship untested pixel math.
3. **Before opening a PR** — re-read the diff adversarially: what's the smallest input that breaks this? What existing behavior might silently change? Run `/code-review` as a second pass.
4. **Flag, don't guess** — if something is ambiguous or trades one thing off against another, say so in the PR description instead of deciding quietly.
5. **Update `JOURNEY.md`** for anything more than a trivial fix — a real bug found by using the feature (not just reading code), a threshold or heuristic recalibrated against real data, or a decision with a tradeoff attached. PR descriptions capture the diff; `JOURNEY.md` captures the story (what broke, what we tried, what we learned) for later reflection or writing up. Keep entries concrete: real numbers, what was actually tried, not just the final answer.

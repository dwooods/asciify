# Asciify

Turn any photo into text art, your way — braille dots, ASCII shading, or line-art outlines — right in your browser. Drop in a PNG/JPEG/WebP/GIF, pick a style and dithering algorithm, and get back text you can copy, paste, or download anywhere monospace text works — chat apps, code comments, READMEs, terminals.

The braille dithering/bit-packing approach is ported from [Lachlan Arthur's Braille-ASCII-Art](https://github.com/LachlanArthur/Braille-ASCII-Art) (MIT licensed); the ASCII and line-art modes, and everything around them, are original to this project. See [LICENSE](LICENSE) for attribution.

## Features

- Drag-and-drop, click to browse, or paste an image straight from the clipboard (Ctrl/Cmd+V)
- Three render styles:
  - **Braille dots** — each character is a 2×4 dot cell packed from Unicode braille (U+2800–U+28FF)
  - **ASCII characters** — classic shaded-character art, with Standard/Blocks/Custom character-set presets (type your own darkest→lightest ramp), or **Hand-drawn style**: picks each character by matching candidate glyphs' own rendered shapes against that cell's pixel content, instead of a brightness ramp — works well on illustrations and clean subjects; heavily-textured photos are a known limitation (see `JOURNEY.md`)
  - **Line art (edges)** — Sobel edge detection mapped to `-`, `|`, `/`, `\`
- Four dithering modes for braille output: Floyd–Steinberg, Stucki, Atkinson, or plain threshold
- **Adaptive detail** (ASCII/edges) — full character palette in visually busy areas, a simplified one elsewhere, with an optional manual focus area that always gets full detail regardless of measured complexity
- **Suppress background** — an on-device AI model (U²-Net, running locally via WebAssembly) finds the photo's subject and blanks the background in the render; degrades gracefully to no-op if the model can't load (offline, blocked, or opened via `file://`)
- **Redraw with AI** — optional, opt-in: paste your own free [Gemini API key](https://aistudio.google.com/apikey) and redraw the loaded photo as clean black-and-white line art (via `gemini-2.5-flash-image`) before converting — real photos often produce noisier text-art than bold, uniform-contrast line art, and this is a one-click way to get there (see `JOURNEY.md`). The request goes straight from your browser to Google's API over HTTPS using your own key; this project's code never sees it and there's no backend. The key lives only in the input field's in-memory value for the current page load — never written to `localStorage`/`sessionStorage`/cookies, never logged, never included in the shareable permalink — so reloading the page clears it. This is the one feature that needs genuine internet access, not just `http(s)` serving.
- Brightness, black point, and white point levels controls, applied before dithering/thresholding, with one-click auto-suggested settings based on the image's own statistics
- Adjustable output width, with an independent height once aspect-ratio lock is turned off
- Adjustable on-screen preview size
- Invert output polarity (braille/ASCII only — edge detection is polarity-symmetric)
- Image info (filename, size, type, dimensions) and a one-click clear button
- A visible, screen-reader-announced error if a dropped/selected file isn't a loadable image
- Copy to clipboard, or download as `.txt`, `.png`, or `.svg`
- Shareable settings permalink — render mode, dithering, palette, thresholds, dimensions, levels, adaptive detail, hand-drawn style, and invert all round-trip through the URL (never the image itself), so a link reproduces a look
- Accessible output: the (potentially huge) character grid is hidden from screen readers, with a concise live-region status announcing what was rendered
- No build step, no runtime dependencies for the core converter — plain HTML/CSS/JS, works straight from `file://`. Two opt-in exceptions: Suppress background vendors `onnxruntime-web` and needs `http(s)`; Redraw with AI needs genuine internet access to reach Google's API. Neither is required for the core converter.

## Running it

Just open `index.html` in a browser. Everything runs client-side; no server or install required.

If you'd rather serve it locally (some browsers restrict `file://` access for certain APIs):

```bash
npx http-server .
# or
python3 -m http.server 8000
```

## Deploying to GitHub Pages

1. Push this repo to GitHub (see below).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to `Deploy from a branch`, branch `main`, folder `/ (root)`.
4. Save — GitHub will publish it at `https://<your-username>.github.io/<repo-name>/`, and redeploy automatically on every push to `main`.

## Pushing this to your own GitHub repo

This project is already a local git repo with an initial commit. To put it on GitHub:

```bash
# 1. Create a new (empty) repository on github.com — don't initialize it with a README.
# 2. Point this local repo at it and push:
cd asciify
git remote add origin https://github.com/dwooods/asciify.git
git branch -M main
git push -u origin main
```

## Testing

The dithering kernels and braille-packing logic live in `dither.js`, a small dependency-free module (loaded as `window.AsciifyDither` in the browser, `require()`-able in Node) so they can be unit tested without a build step. The UI layer (drag-and-drop, paste, file loading and error handling, rendering across all three modes, exports, and the settings permalink) is covered separately with [Playwright](https://playwright.dev/) — the project's only dependency, dev-only:

```bash
npm install   # first time only, fetches Playwright
npm test
# or directly:
node --test
```

`tests/dither.test.js` covers the pixel-quantization math and the bit-to-braille-dot mapping; `tests/ui.test.js` drives a real headless browser against the app to cover the DOM/UI wiring. Both suites run under a single `npm test`.

CI (`.github/workflows/test.yml`) runs the full suite on every push/PR to `main`.

## How it works

- The source image is drawn onto a hidden `<canvas>` sized for the chosen output resolution (braille: `width*2 × height*4` px, one 2×4 dot cell per character; ASCII/edges: one pixel block per character, vertically compressed to correct for character aspect ratio).
- It's composited in `luminosity` blend mode over a white background to get a greyscale reading, then brightness/black-point/white-point levels are applied.
- **Braille mode** runs the selected dithering kernel (error-diffusion for Floyd–Steinberg/Stucki/Atkinson, or a flat cutoff for Threshold) to convert each pixel to pure black or white, then packs each 2×4 block into one of the 256 Unicode braille characters per the [Braille Patterns](https://en.wikipedia.org/wiki/Braille_Patterns) block layout.
- **ASCII mode** maps each block's average luminance onto a character ramp (a built-in preset or a custom one you type in) — or, in Hand-drawn style, rasterizes each candidate character in the real output font and picks whichever one's own ink pattern best matches that cell's pixel content, blending shape correlation with a brightness term.
- **Edges mode** runs a Sobel operator over the greyscale image and maps each block's gradient direction/strength to a line-drawing character or a blank.
- **Adaptive detail** reuses each cell's edge density and local contrast to classify it as "busy" or not, then reduces the character ramp (ASCII) or raises the effective edge threshold (Edges) in busy cells to cut down on visual noise, unless it falls inside a user-drawn focus area.
- **Suppress background** runs a small salient-object-detection model (U²-Netp) via `onnxruntime-web` to compute a subject mask, then blanks background-masked cells in whichever mode's render loop is active.
- **Redraw with AI** sends the loaded image (downscaled to at most 1024px) and a fixed line-art prompt straight from the browser to `gemini-2.5-flash-image` via a plain `fetch()` call — no SDK, since Google's official JS SDK adds a header that breaks the CORS preflight for this exact use case — and, on success, feeds the returned PNG through the same `loadFile()` every other upload uses.

## License

MIT — see [LICENSE](LICENSE). The braille dithering/packing algorithm is adapted from Lachlan Arthur's original project; that project's MIT notice is preserved there.

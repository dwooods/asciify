# Asciify

Turn any photo into text art, your way — braille dots, ASCII shading, or line-art outlines — right in your browser. Drop in a PNG/JPEG/WebP/GIF, pick a style and dithering algorithm, and get back text you can copy, paste, or download anywhere monospace text works — chat apps, code comments, READMEs, terminals.

The braille dithering/bit-packing approach is ported from [Lachlan Arthur's Braille-ASCII-Art](https://github.com/LachlanArthur/Braille-ASCII-Art) (MIT licensed); the ASCII and line-art modes, and everything around them, are original to this project. See [LICENSE](LICENSE) for attribution.

## Features

- Drag-and-drop, click to browse, or paste an image straight from the clipboard (Ctrl/Cmd+V)
- Three render styles:
  - **Braille dots** — each character is a 2×4 dot cell packed from Unicode braille (U+2800–U+28FF)
  - **ASCII characters** — classic shaded-character art, with Standard/Blocks/Custom character-set presets (type your own darkest→lightest ramp)
  - **Line art (edges)** — Sobel edge detection mapped to `-`, `|`, `/`, `\`
- Four dithering modes for braille output: Floyd–Steinberg, Stucki, Atkinson, or plain threshold
- Brightness, black point, and white point levels controls, applied before dithering/thresholding
- Adjustable output width, with an independent height once aspect-ratio lock is turned off
- Adjustable on-screen preview size
- Invert output polarity (braille/ASCII only — edge detection is polarity-symmetric)
- Image info (filename, size, type, dimensions) and a one-click clear button
- A visible, screen-reader-announced error if a dropped/selected file isn't a loadable image
- Copy to clipboard, or download as `.txt`, `.png`, or `.svg`
- Shareable settings permalink — render mode, dithering, palette, thresholds, dimensions, levels, and invert all round-trip through the URL (never the image itself), so a link reproduces a look
- Accessible output: the (potentially huge) character grid is hidden from screen readers, with a concise live-region status announcing what was rendered
- No build step, no runtime dependencies — plain HTML/CSS/JS, works straight from `file://`

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
- **ASCII mode** maps each block's average luminance onto a character ramp (a built-in preset or a custom one you type in).
- **Edges mode** runs a Sobel operator over the greyscale image and maps each block's gradient direction/strength to a line-drawing character or a blank.

## License

MIT — see [LICENSE](LICENSE). The braille dithering/packing algorithm is adapted from Lachlan Arthur's original project; that project's MIT notice is preserved there.

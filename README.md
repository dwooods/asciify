# Asciify

Convert any image into Unicode braille dot-matrix text art, right in your browser. Drop in a PNG/JPEG/WebP, pick a dithering algorithm, and get back text made entirely of braille characters (U+2800–U+28FF) that you can copy, paste, or download anywhere monospace text works — chat apps, code comments, READMEs, terminals.

This is a from-scratch web rewrite of the rendering approach in [Lachlan Arthur's Braille-ASCII-Art](https://github.com/LachlanArthur/Braille-ASCII-Art) (MIT licensed) — same dithering kernels and braille bit-packing logic, restructured as a single dependency-free `index.html` / `style.css` / `script.js` with a redesigned interface. See [LICENSE](LICENSE) for attribution.

## Features

- Drag-and-drop or click to load an image
- Four dithering modes: Floyd–Steinberg, Stucki, Atkinson, or plain threshold
- Adjustable output width (characters), threshold, and invert
- Copy to clipboard or download as a `.txt` file
- No build step, no dependencies — plain HTML/CSS/JS

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
4. Save — GitHub will publish it at `https://<your-username>.github.io/<repo-name>/`.

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

The dithering kernels and braille-packing logic live in `dither.js`, a small dependency-free module (loaded as `window.AsciifyDither` in the browser, `require()`-able in Node) so they can be unit tested without a build step. The UI layer (drag-and-drop, file loading, rendering to the DOM, exports, the settings permalink) is covered separately with [Playwright](https://playwright.dev/) — the project's only dependency, dev-only:

```bash
npm install   # first time only, fetches Playwright
npm test
# or directly:
node --test
```

`tests/dither.test.js` covers the pixel-quantization math and the bit-to-braille-dot mapping; `tests/ui.test.js` drives a real headless browser against the app to cover the DOM/UI wiring.

## How it works

- The source image is drawn onto a hidden `<canvas>` at `width*2 × height*4` pixels (each output character is one braille cell, 2 dots wide by 4 dots tall).
- It's composited in `luminosity` blend mode over a white background to get a greyscale reading.
- The selected dithering kernel (error-diffusion for Floyd–Steinberg/Stucki/Atkinson, or a flat cutoff for Threshold) converts each pixel to pure black or white.
- Each 2×4 block of pixels is packed into one of the 256 Unicode braille characters by mapping each dot to a bit, per the [Braille Patterns](https://en.wikipedia.org/wiki/Braille_Patterns) block layout.

## License

MIT — see [LICENSE](LICENSE). The dithering/braille-packing algorithm is adapted from Lachlan Arthur's original project; that project's MIT notice is preserved there.

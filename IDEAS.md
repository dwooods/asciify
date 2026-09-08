# IDEAS.md

A running backlog of things worth trying on asciify - brainstormed, not committed to. This is the "what could we work on" list; `JOURNEY.md` is the "what we actually did and found" record. When picking up work in a fresh session (including a plain local `claude` CLI session with no prior context), start here.

## How to use this file

- Add an idea any time one comes up, even half-formed - a one-line entry is fine.
- When starting on one, move it under **In progress** with the date.
- When it ships (or is deliberately abandoned), move it to **Done / decided against** with a one-line outcome and a link to the relevant `JOURNEY.md` phase - the full story belongs in `JOURNEY.md`, not here.
- Keep entries short. This file is a pointer to work, not a design doc.

## Backlog

- **PWA manifest + service worker** - `manifest.json` + a minimal service worker so Android/desktop browsers offer "Add to Home Screen" (installable icon, standalone window). No native tooling, no rewrite - the existing client-side architecture already works unmodified. See `CLAUDE.md`'s "Future direction" note. Small, self-contained, low risk.
- **Trace outline first still gets noisy at high output width** - the "Reduce noise" fix (see `JOURNEY.md` Phase 19) fixed the typical-resolution case, but Phase 17's original finding (smaller character cells sample weaker gradients) still shows up at width≈200+ on textured photos. Worth another pass, possibly a genuinely different technique (e.g. XDoG-style soft/tanh thresholding instead of a hard local-max rescale) rather than more constant-tuning.
- **Local AI redraw via Forge/ControlNet, tuned toward Gemini's flat-outline style** - proven to run on the user's own RX 6700 XT (Phase 18), but the default ControlNet-lineart preprocessor produces busy crosshatching that converts poorly. Would need prompt/preprocessor tuning (e.g. `lineart_realistic` + a low-line-density bias) to match the flat, sparse style that actually works well through this app's pipeline. Needs the user's own machine/GPU - not something drivable from a remote session.
- **Hand-drawn style's known limitation on heavily-textured photos** - flagged in the README since early in the project; several fixes attempted (Simplify tones, Trace outline first, bilateral blur) each helped a real case without fully resolving it. Revisit if a new idea surfaces, rather than another incremental pass on the same approach.

## In progress

_(nothing right now)_

## Done / decided against

- **Ollama's `z-image-turbo` as a local Gemini replacement** - investigated and ruled out: still macOS-only as of the check, and even where it runs, Ollama's own wrapper is text-to-image only (no img2img). See `JOURNEY.md` Phase 18 addendum.
- **Local contrast normalization, standalone** - real improvement on textured photos, but amplified noise into garbage on genuinely low-contrast photos on its own. Fixed by pairing it with the existing "Reduce noise" denoise step instead of shipping it alone. See `JOURNEY.md` Phase 19.
- **Redraw with AI (Gemini BYOK)** - shipped. Zero-backend architecture preserved; the user's own API key is used directly from their browser. See `JOURNEY.md` Phase 17-18.

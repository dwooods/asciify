# The Asciify Journey

A running log of what we built, why, what broke, what we learned, and the
decisions behind it — kept so we can reflect on it later and, if it's useful,
turn it into a blog post. Written as we go, not reconstructed after the fact.

This is a companion to the git history, not a replacement for it — PR
descriptions have the precise technical diffs; this has the story, the
dead ends, and the reasoning that doesn't fit in a commit message.

## The idea

Asciify converts any image into text art — braille dots, ASCII shading, or
line-art outlines — entirely in the browser. No backend, no build step, no
dependencies (until Playwright, see below). The braille dithering approach
is ported from [Lachlan Arthur's Braille-ASCII-Art](https://github.com/LachlanArthur/Braille-ASCII-Art);
everything else grew from there.

## Phase 1: Foundation (PRs #1-#5)

Before any new features, we set up the scaffolding a real project needs:
a dependency-free test suite for the dithering/braille-packing math (using
Node's built-in `node:test`, deliberately no test framework dependency),
a CI workflow to run it automatically, `CLAUDE.md` to give future sessions
the architecture and conventions up front, inline comments explaining the
non-obvious parts of the render pipeline (the luminosity-blend greyscale
trick, the braille-cell stepping math), and a documented "working process"
(name the risk before coding, verify after, re-read the diff adversarially
before opening a PR). That process became the standing default for
everything after it — including this document.

## Phase 2: Core features (PRs #6-#10)

Built out the actual creative range of the tool:

- **Clipboard paste + PNG/SVG export** (#6) — paste an image directly with
  Ctrl/Cmd+V, export the result as a portable image instead of only text.
  Caught during testing: the SVG export's `font-family` embeds
  double-quoted font names, which broke the XML when the attribute itself
  used double quotes — fixed by single-quoting that attribute.
- **ASCII character mode** (#7) — classic density-ramp ASCII art alongside
  braille dots. Confirmed the vertical-squish factor (0.55) against a real
  reference converter's aspect setting while we were at it.
- **Line-art edge detection mode** (#8) — a Sobel-gradient-based third
  style, tracing outlines instead of filling in tone. Reuses the existing
  "Threshold" slider as edge sensitivity rather than adding a new control.
- **Character-set presets, image info, clear button** (#9).
- **Brightness/levels controls, independent height with aspect lock**
  (#10) — inspired by looking at how Oxide Computer's internal "Mitos"
  ASCII-art tool exposes brightness/white-point/black-point as core
  controls, not buried settings.

## Phase 3: Robustness and polish (PR #11)

A repo-scan from another AI session surfaced real gaps: no UI-layer test
coverage, no error handling for a bad file upload, no accessibility for
the rendered output, no way to share a specific look. We verified each
claim against the actual code before acting on it (found `loadFile()`
truly had no `onerror`, confirmed no ARIA attributes existed anywhere),
then built:

- A **Playwright UI test suite** — the project's first-ever dependency
  (dev-only). Driven directly against `node:test`, not the
  `@playwright/test` runner, so `npm test` stays one command.
- **`loadFile()` error handling** — a non-image or corrupt upload now
  shows a visible error instead of silently doing nothing.
- **Accessibility** — originally planned as `role="img"`, but that
  conflicts with the existing `contenteditable="true"` on the same
  element (one implies opaque/non-interactive, the other implies
  editable text). Landed on `aria-hidden="true"` on the output grid plus
  a separate live-region status announcing concise render summaries —
  narrating thousands of individual characters to a screen reader helps
  no one.
- **A settings permalink** — render mode, dithering, palette, thresholds,
  dimensions, levels, and invert round-trip through the URL query string.
  The image itself is never encoded.
- **A real bug, found by using the feature we just built**: the permalink
  made it trivial to reach a latent bug that already existed — width/height
  had no upper bound, so a large enough value crashed canvas allocation
  instead of failing gracefully. Fixed with a `maxDimension` cap, enforced
  in both the input handlers and the URL-restore validation.

## Phase 4: Things a user actually found (PRs #12-#17)

This is where testing-by-actually-using-it started paying for itself:

- **README drift** (#12) — it still described the original braille-only
  tool. Brought current with everything shipped since.
- **A field-visibility bug on first load** (#13) — `restoreSettingsFromUrl()`
  bailed out early whenever there was no query string (the common case for
  a first visit), which skipped a visibility-sync call inside it. Result:
  every mode's fields showed at once until you switched styles and back.
  Found because the user tried it fresh and noticed the panel looked wrong.
- **Two more ASCII character-set presets** (#14), user-supplied.
- **A "Reset settings" button** (#15) — restores every adjustment to
  default while keeping the loaded image, so a heavily-tweaked image can
  be started over without re-uploading. Also added `test-assets/`, a
  folder for committing real sample photos — needed because this session
  runs in an isolated cloud container with no access to the user's local
  filesystem; committing images to the repo is the only way to hand them
  over.
- **The export-stretch bug** (#17) — the user pasted a before/after
  screenshot: a circular avatar looked correct on-screen but exported as
  a visibly wide oval. Root cause: the on-screen preview forces every
  character into a fixed `0.5em`-wide box via CSS
  (`#output span { width: 0.5em }`) so the braille grid's 2-wide/4-tall
  dot cells come out proportioned correctly regardless of the actual font.
  The PNG/SVG export instead trusted the font's own glyph advance width
  (`canvas.measureText`, native SVG text layout) — and whatever monospace
  font this environment's canvas resolved to rendered noticeably wider
  than `0.5em` per character. Measured it directly with a test circle:
  ~0.74 aspect instead of the correct 0.5, a ~48% stretch. Fixed by
  drawing PNG output character-by-character at a fixed step instead of
  calling `fillText` per line, and using SVG's `textLength`/`lengthAdjust`
  to pin the width regardless of what font ends up displaying it.

**Pattern noticed**: every one of these bugs survived code review and
passing tests. They only surfaced when someone (user or agent) actually
looked at the rendered output, not just the code. The project's own
"Working process" doc says to do a real browser pass for any change
touching rendering — this is the evidence for why that rule exists.

## Phase 5: Auto-suggested settings — the heuristic saga (PRs #18-#20, ongoing)

The user's framing of the problem: *"I'm realizing it's hard to find the
right setting with an image."* True trial-and-error with three render
modes, four dither algorithms, and half a dozen sliders.

**The decision that shaped everything after it**: real AI (an LLM call)
would need a backend to protect an API key, which breaks the project's
zero-backend, `file://`-safe architecture — so we explicitly chose a
client-side statistical heuristic instead. Not literally AI, but it
solves the actual problem: measure the image's own brightness, contrast,
and edge density, and suggest a full settings preset automatically.

**Design, agreed up front**: full auto (mode + every setting) fires the
moment an image loads, since there's no reason to make someone click a
button for the common case. Three small preview thumbnails (braille/
ASCII/edges) let you override the guess with one click instead of hunting
through sliders. A regression test per rule, mirroring the existing
dither.js test style, so future tuning can't silently break an earlier
case.

**The permalink conflict, caught before it shipped**: a settings
permalink's whole point is reproducing a specific look — auto-suggest
firing on the very next upload would silently override it. Fixed with a
one-shot suppression flag, set when settings were restored from a URL,
cleared after the first upload.

**First calibration reality check** — this is the part worth remembering
for a blog post. The heuristic shipped with a synthetic-circle-tested
threshold (`edgeDensity > 40` triggers line-art mode). The user uploaded
20 real photos (portraits, high-contrast animals, cluttered scenes, Star
Wars toy photography, screenshots) to `test-assets/`. Running all 20
through the actual app: **edges mode was suggested exactly zero times.**
Real photos topped out around ~35 on that scale even for the busiest
image in the set — the threshold was calibrated against a synthetic test
image and was simply unreachable by anything real. Lowered it to 20,
verified by rendering candidates across the real range: a toy AT-ST model
and a tiger's face close-up now render as clean, recognizable line art.

**Second reality check, immediately after** — with edges mode reachable,
three "busy clutter" photos (a messy desk, a dish rack, a cluttered room)
also started triggering it, and all three rendered as uniform noise, not
outlines. They scored just as high on raw edge density as the tiger and
the AT-ST. The insight: edge density alone can't tell "a clean subject
with real detail" from "detail spread everywhere" — a picture can be
edge-*dense* without having a coherent shape to trace.

The fix came from measuring *where* the edges were, not just how many:
split the image into a 6x6 grid, and compute the coefficient of variation
of edge density across those blocks. A clean subject on a plain
background concentrates edges into a few blocks and leaves the rest
nearly flat (high variation); a cluttered scene spreads edges evenly
across almost every block (low variation). Tested against the same 20
photos: every good line-art result scored **≥0.355** on this measure,
every busy-clutter false positive scored **≤0.322** — a clean gap, no
overlap. Added `edgeConcentration` as a second required condition.

**Third finding, still open** — checking two borderline cases
(`star wars airspeeder`, which the concentration fix didn't touch)
surfaced a genuine limitation rather than a bug to fix: the airspeeder's
edges render is clearly better than its current braille fallback, but
it fails the primary density gate by a small margin (19.3 vs. the 20
cutoff). Tried lowering the gate to catch it — and a hazy tricycle photo
(`bright image`) immediately became a false positive, because its high
concentration score came from a busy background (bare winter trees)
rather than a clean subject. **Concentration can't distinguish "detail
in the subject" from "detail in the background."** Left the threshold
alone rather than trade one fix for a new regression — an explicit,
documented trade-off, not an oversight.

A fourth finding surfaced the same week, not yet acted on: the auto-levels
percentile stretch (2nd/98th percentile → 0-255) assumes "narrow tonal
range" always means "should be stretched." For a photo that's
*deliberately* soft and hazy (backlit golden-hour shot), stretching
amplifies background/grain texture into visual noise the photo's actual
character doesn't have. Same root cause as the other two: a global
statistic can't tell "this is technically low-contrast" from "this is
low-contrast on purpose."

**The pivot point**: three real limitations in a row, all traceable to
the same cause — none of these heuristics know what the subject *is*.
That's not a threshold to retune; it's a ceiling on what per-pixel
statistics can do at all. Explicitly asked the question rather than
quietly kept tuning: keep polishing the free, dependency-free heuristic
(diminishing returns, but zero risk), or invest in an actual client-side
vision model that can separate subject from background before computing
any of these stats. Decision: invest in the model.

**Immediate near-miss on the model choice**: the obvious, most-cited
library for client-side background removal (`@imgly/background-removal`)
turned out to be AGPL-licensed with a paid alternative — using it would
have forced this MIT-licensed project into AGPL terms. Caught by checking
the license *before* writing any integration code, not after. Landed
instead on TensorFlow.js (Apache 2.0, ships browser-ready builds, no
bundler required — fits the existing "no build step" constraint) plus
U²-Netp, a small salient-object-detection model (also Apache 2.0) that's
class-agnostic — it doesn't need to recognize "toy AT-ST model" as a
known category the way a COCO-trained classifier would, which matters
a lot given how much of this project's real test data is Star Wars toy
photography that no standard object detector has ever heard of.

Open questions before building it: model loading needs `fetch()`, which
doesn't work over `file://` — has to degrade gracefully back to the
current heuristic, not break the site's core "just open the HTML file"
promise. Real per-image latency (likely 0.5-3s) where there's currently
none. Where to host several MB of model weights. Not yet decided.

**Answering the three open questions.** Talked through them before
writing any code:

1. *`file://` compatibility* — corrected the framing here: committing
   weights into the repo doesn't fix `file://` on its own. `fetch()` is
   blocked under the bare `file://` protocol regardless of where the
   bytes physically live — same-origin doesn't help. The real
   requirement is "served over `http(s)`," which GitHub Pages already
   satisfies and so does a fully offline `python3 -m http.server` with
   no internet connection at all. Only literally double-clicking
   `index.html` as `file:///path/...` loses the model and falls back to
   the pure-statistics heuristic. That's a much narrower loss than "needs
   network access" made it sound.
2. *Where to host the weights* — decided: commit them into the repo.
   Bigger repo, but works offline once served, no third-party CDN
   dependency.
3. *Real latency* — asked for actual numbers, not an estimate, before
   finalizing anything. Measured below.

**Measuring real latency, and a detour finding a model to measure.**
Went looking for TensorFlow.js + a TFJS-ported U²-Netp to benchmark, and
hit the same kind of environment constraint as the `file://` question,
just at the tooling layer this time: this sandbox's egress proxy blocks
`cdn.jsdelivr.net` and `huggingface.co` outright (403, org policy) —
which is where most published TFJS model conversions live — while
`registry.npmjs.org` and `raw.githubusercontent.com` are reachable.
Used that to `npm pack` candidates instead of fighting the CDN block:
found `@planby-tech/rmbg-webgpu` (MIT, on npm), which bundles a
`u2netp.onnx` (4.4 MB, Apache-2.0 via the original U-2-Net project) and
runs it through `onnxruntime-web` rather than TensorFlow.js. Read its
source directly (it's a small, readable bundle) to lift the exact
preprocessing it uses — 320×320 input, ImageNet mean/std normalization
after scaling by the image's own max channel value, NCHW float32 tensor
— and reimplemented that against `onnxruntime-web`'s plain
`ort.min.js` `<script>` build (no ES modules, matching this project's
constraints) in a standalone Playwright harness outside the repo, run
against four real `test-assets` photos.

Real numbers, single-threaded WASM (no COOP/COEP headers, so no
`SharedArrayBuffer` — the same constraint a plain static file server or
GitHub Pages would have), headless Chromium on this sandbox's CPU:

| Stage | Time |
|---|---|
| One-time session creation (WASM init + model parse) | ~1.1–2.4s |
| First inference (cold JIT) | ~3.1–4.3s |
| Each subsequent inference | ~1.9s, consistent across all four images |

And a footprint number that turned out to matter more than the latency:
the ONNX runtime's WASM binary alone is **13 MB** — three times the
size of the 4.4 MB model it's running. Total minimum footprint to commit
(`ort.min.js` + wasm + the model) is **~18 MB**, versus the whole rest of
this repo's source today. That's the real cost of "invest in a client-side
model" for a project whose pitch has been "plain files, no build step,
tiny enough to just grab" — worth surfacing plainly rather than only
reporting the latency number that was asked for.

Not yet decided: whether ~2-6 seconds of one-time-plus-per-image latency
and an ~18 MB repo addition is worth it against the heuristic's
documented failure modes above. That's a call for the next round with
the numbers in hand, not one to make silently while chasing the
technical answer.

**Building it, and a negative result.** Given the go-ahead, vendored
`onnxruntime-web` + `u2netp.onnx` into the repo, extended
`computeImageStats()` in `dither.js` to take an optional per-pixel mask
(pixels outside it are excluded from the histogram, edge-density sum, and
the 6×6 concentration grid — with a fallback to the whole frame if the
mask selects nothing, so a failed segmentation can't produce a zero-pixel
divide-by-zero), and added `saliency.js` to run the model and hand back a
mask. Two real bugs turned up before it even ran correctly: `ort.min.js`
resolves its WASM loader's `.mjs` companion via a dynamic `import()`
(needs a real relative specifier — a bare `"vendor/..."` path is rejected
outright, unlike `fetch()`) while it resolves the `.wasm` binary itself
via `fetch()` from inside that `.mjs` (relative to the *document*, not the
script) — two paths, in the same directory, needing different bases. Only
caught because a manual Playwright pass actually read the console output
instead of trusting a silent catch block.

Once it ran, ran it against the actual three documented failure photos
(not synthetic cases) and looked at the rendered output, not just the
chosen mode:

- **`bright image.png` (tricycle vs. bare trees)** — refined stats flipped
  it to edges mode. The render is edge noise across the *entire* frame,
  trees included — not fixed.
- **`busy clutter desk.png`** — the exact case PR #20's concentration
  metric was built to keep out of edges mode. Refined stats flipped it to
  edges anyway. Also not fixed — actively regressed back to the bug #20
  had already closed.
- **`low contrast photo dog.png`** — refined black/white points (141/206
  vs. the whole-frame 120/255) pushed the render into a dense, saturated
  block of `@`/`#` characters — arguably a different bad result, not
  obviously better than the over-stretch it was meant to replace.

The reason, once the renders made it obvious: **the mask only ever fed
`computeImageStats()`** — it biases which mode/threshold/levels get
*chosen*, but nothing about rendering itself is mask-aware. Braille/ASCII/
edges mode all still process every pixel in the frame regardless of what
the mask found. So even a perfectly accurate subject mask can only ever
pick a *better-calibrated threshold for the whole image* — it can't stop
a busy background from being part of "the whole image" once that
threshold is applied. Threshold tuning was never going to fix "background
clutter shows up in the render" because the render was never subject-
aware to begin with; only the number-picking was. Fixing this for real
would mean the mask actually suppressing/fading background pixels at
render time — a materially bigger, more visible change to what this tool
outputs, not a refinement to what settings it picks.

Left this branch of work uncommitted rather than opening a PR for it:
it's built, it's wired up, the tests are real (a route-blocked default
page keeps the existing suite fast — see below — plus one dedicated
unblocked-page test that runs the actual model), but it does not
demonstrably fix what it was built to fix, and shipping it risked
presenting a regression as a feature. Recording the negative result here
instead, since it's the more valuable thing to not lose.

One more concrete cost, found while getting the test suite green: the
model runs on every auto-suggest call by default, which means every
existing test that uploads an image now pays ~2-6s for a background
model call it isn't testing. Fixed by having the shared test setup block
`vendor/` requests by default (a real stand-in for the `file://`/offline/
blocked-CDN fallback path, exercised for free by nearly the whole suite)
and giving the one test that needs the real model its own unblocked page
— but it's a real tax on iteration speed that a whole-frame heuristic
never had, independent of whether the mask-based approach even works.

## Patterns worth remembering

- **Every real bug this project has shipped was found by actually looking
  at output, not by reading code or passing tests.** Export stretching,
  the field-visibility bug, all three heuristic-calibration misses — none
  of them would show up in a diff review.
- **Calibrate against real data before shipping a threshold, not after.**
  The edges-threshold saga happened because the original number was
  chosen against one synthetic test image during development. The fix
  process (20 real photos, measure, visualize, adjust, re-verify against
  all 20 again) is now the template for any future tuning pass.
- **A clean separation in a small sample is a real signal, not proof.**
  The concentration metric's 0.355-vs-0.322 gap across 20 images is
  encouraging, not definitive — and the airspeeder/bright-image pair
  proved that immediately by finding the metric's actual limit on the
  very next test.
- **Check the license before the code.** The AGPL near-miss cost a few
  minutes of research and would have cost a lot more to unwind after
  integration.
- **A heuristic's failure mode tells you what it's structurally missing.**
  Three different bugs (busy edges, hazy over-stretch, and — if we build
  it — whatever the vision model gets wrong next) all trace back to "no
  concept of subject vs. background." Naming that clearly is what turned
  a series of one-off threshold fixes into a single, deliberate
  architecture decision.
- **Measure the number that was actually asked for, then report the one
  that matters more if it's different.** Asked to check latency; the
  answer that turned out to matter most for this project wasn't the
  ~2-6 seconds of inference time, it was the 13 MB WASM runtime binary
  sitting underneath a 4.4 MB model. Don't let "answer the literal
  question" crowd out "surface what the investigation actually found."
- **Feeding a better signal into the decision isn't the same as fixing
  the output.** The saliency mask made `computeImageStats()` smarter, but
  the renderer never became mask-aware — so "pick a better-calibrated
  number for the whole frame" could never fix "a busy background shows up
  in the whole frame." A cleaner input to a heuristic doesn't help if the
  heuristic's output is spent somewhere the input's benefit can't reach.
  Building it and looking at the real output on the real failure cases
  is what caught this, not code review of the diff.

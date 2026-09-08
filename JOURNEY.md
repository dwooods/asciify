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

**Second attempt: mask the render, not the stats — and it works.** Asked
"does it work if we set the busy-clutter regression aside" and went
looking at the other cases with real before/after screenshots instead of
trusting the mode/threshold numbers. It didn't hold up there either — the
airspeeder's *original* whole-frame braille render was already clean, and
the "refined" edges version was busier, not better. That ruled out
"tune the stats differently" as a fix and pointed straight at the actual
structural problem named in the previous entry: apply the mask to
*rendering itself*. Background-masked cells are now blanked directly in
the braille/ASCII/edges render loops (`isBackgroundPixel` in `script.js`),
using whatever settings are already in effect — completely decoupled from
auto-suggest, so this doesn't touch `computeImageStats()` or `dither.js`
at all (both reverted to their pre-experiment state).

Validated against 6 real photos, forcing edges mode with a properly
calibrated threshold for a fair comparison:

- **Fixed**: `bright image.png` (tricycle vs. bare trees) and
  `busy clutter desk.png` — both went from noise across the entire frame
  to a clean, isolated subject silhouette. `car black and white.png` saw
  the same kind of improvement in a mode auto-suggest already picked
  correctly.
- **No regression**: `high contrast tiger.png`, `star wars at-pt.png`,
  `star wars airspeeder.png` — already-good renders stayed essentially
  identical (a few stray marks cleaned up, no lost detail).

**Shipping it as an opt-in checkbox, not an automatic behavior.** Unlike
auto-suggest (instant, always on), this now has a real, unavoidable cost —
~2-6s and a model that needs `http(s)` — so it ships behind an unchecked-
by-default "Suppress background" checkbox rather than running
automatically on every upload the way the (abandoned) stats-refinement
version did. Concretely:

- `index.html` no longer loads `onnxruntime-web` in a static `<script>`
  tag; `saliency.js` injects it dynamically on first actual use
  (`loadOrt()`). A visitor who never checks the box pays nothing — not
  even the ~350KB runtime script, let alone the 13MB WASM binary or the
  4.4MB model. Caught this by writing a test that asserts zero `vendor/`
  requests fire with the box unchecked, which failed the first time
  because the old static `<script src="vendor/onnxruntime-web/ort.min.js">`
  tag loaded unconditionally on every page view regardless of the
  checkbox — "off" wasn't actually off yet.
- Mask resolution is capped at 320px on the image's longer side (the
  model's own native resolution — asking for more just upsamples what
  it already produced), computed fresh per image rather than the
  prototype's fixed 240px constant.
- The mask is cached per image: unchecking and rechecking the box without
  a new upload reuses it instantly instead of re-running inference.
- Included in the settings permalink (`?suppress=1`), like Invert — a
  shared link's job is reproducing a specific look, and this is now part
  of the look.

## Phase 6: Adaptive detail and manual focus areas

A user brought a four-phase spec for a Python/OpenCV image-to-ASCII
pipeline — adaptive sampling density, foreground/background separation
via edge+contrast heuristics, auto- and manually-selected regions of
interest, multi-scale blending — asking for thoughts before porting it
into asciify. Worth a real look rather than a quick "sure, sounds good":

- **Phase 2 (foreground enhancement via edge density + local contrast,
  threshold 0.5) was, functionally, the exact experiment already run and
  abandoned earlier this phase** — a heuristic guess at "what's the
  subject" from edge/contrast statistics alone, no real segmentation.
  We'd already shown that fails on precisely this project's own busy
  clutter and busy-background photos, for a structural reason (busy
  backgrounds score just as high on edge/contrast as real subjects do).
  Flagged this directly rather than re-discovering it by re-implementing it.
- **The success-criteria percentages throughout the spec (~40% quality
  improvement, ~45% for desk scenarios, <10ms overhead, etc.) had no
  stated measurement methodology** and "quality improvement" isn't a
  defined metric for ASCII art to begin with — called these out as
  fabricated-looking placeholders rather than real targets to build toward.
- **Phase 1 (adaptive sampling density) and Phase 3's manual ROI selection
  were the two genuinely solid pieces** — real, well-established
  techniques with no hidden failure mode, since neither one needs to
  guess what the subject is. Recommended building those two and holding
  off on the rest.

Also worth naming as its own finding: "adaptive sampling density" as
originally specified — literally varying how many samples get taken per
region — doesn't translate to this project at all. ASCII/braille output
is a fixed monospace character grid; you can't sample some regions more
densely than others without changing the grid itself. The idea that
*does* translate is adjacent, not identical: keep the grid fixed, and
vary how much of the character *palette* a cell is allowed to use based
on local complexity — full ramp where there's real detail, a collapsed
3-character ramp (darkest/mid/lightest) where the region is visually
flat, cutting the jitter a rich ramp produces on faint grain or smooth
gradients. Re-interpreting a request for what a codebase's actual
constraints can support, rather than either forcing a literal (broken)
port or silently doing something unrelated, is what made this a real
feature instead of copied pseudocode.

Built as:

- `computeComplexityMap()` in `dither.js` — a 0-1 blend of local edge
  density and local brightness contrast in a small window, reusing the
  existing `sobelGradient` primitive rather than inventing new math.
  Caught a real, pre-existing wrinkle while calibrating it: the
  `sobelMaxMagnitude` constant's own comment says it normalizes Sobel
  magnitude to 0-1, but the code is missing a `× 255` the comment
  describes — it actually produces values on the same ~0-255-ish scale
  the Threshold slider and `computeImageStats().edgeDensity` already use
  (and were calibrated against, per the edges-threshold saga above).
  Not a bug worth fixing on its own — the rest of the codebase already
  depends on the *actual* behavior, not the comment — but exactly the
  kind of thing that produces a nonsensical complexity score (one
  synthetic test returned 9.6 on a supposedly 0-1 scale) if you trust
  the comment over the code.
- A manual focus area: a rectangle drawn directly on the source-image
  thumbnail (a `<canvas>` overlay, plain mouse events, normalized 0-1
  coordinates so it's resolution-independent), which always forces the
  full palette inside it regardless of measured complexity — the
  "override the heuristic" half, independent of and layered on top of
  the automatic half.
- Both are ASCII-mode-only: braille and edges don't have a comparable
  per-cell "richness" dial the same way a character ramp does.
- Both included in the settings permalink, and the focus rectangle is
  cleared on every new image upload (it describes a spot in specific
  image content, not a standing preference) except the very first
  upload after restoring one from a shared link — same carve-out
  `suppressNextAutoSuggest` already uses for auto-suggest.

## Phase 7: Touch support, a real mobile layout bug, and edges-mode decluttering

Three small-sounding requests ("add touch support," "add an info icon,"
"apply adaptive detail's idea to edges mode too") each turned up something
that only showed up by actually using the feature, not by reading the diff.

- **The focus-area canvas (Phase 6) only had mouse listeners** -
  `mousedown`/`mousemove`/`mouseup`, no touch equivalent, so drawing a
  focus rectangle silently did nothing on a phone or tablet. Refactored
  the drag logic into shared `startFocusDrag`/`updateFocusDrag`/
  `finishFocusDrag` functions driven by either input type, then added
  `touchstart`/`touchmove`/`touchend` listeners (`{ passive: false }` +
  `preventDefault()` while actively drawing, so dragging a finger draws a
  rectangle instead of scrolling the page). Verified with real
  `TouchEvent`/`Touch` objects dispatched directly at the canvas -
  `page.mouse`/`page.touchscreen` both do real hit-testing against
  viewport-relative coordinates, so a first pass that scrolled the canvas
  into view *after* computing its bounding box (rather than before) looked
  broken in exactly the way a genuine handler bug would: the drag appeared
  to do nothing. Fixed the test, not the code, once the coordinates were
  confirmed to land correctly - a reminder that a red assertion in a UI
  test can be the test's own geometry, not the feature.
- **The Suppress background checkbox's new info icon needed a
  tap/keyboard-reachable alternative to its `title` tooltip** (most mobile
  browsers ignore `title` on tap entirely, and it's not reachable without
  a pointer at all) - added a toggleable `.infoPopover` alongside it,
  shown/hidden explicitly by script.js rather than by CSS `:hover`. First
  version of the tooltip text ran ~250 characters describing the model by
  name and architecture; a screenshot from the user showed it overflowing
  its own popover box on their screen. Trimmed to ~140 characters that say
  what it does and how long it takes, dropping the implementation detail
  nobody asked for - a reminder that "technically accurate and complete"
  and "fits the affordance it's rendered in" are different bars, and only
  a real screenshot caught the gap.
- **A pre-existing horizontal-overflow bug, found while doing the mobile
  pass the touch-support work called for anyway.** At a 412px mobile
  viewport, `window.innerWidth` measured 566 - the whole page was wider
  than the device, silently breaking tap targets (Playwright's `tap()`
  kept hitting an unrelated element underneath the intended one, since
  the page had zoomed out to fit). Root cause: the "Suggested settings"
  previews are `<pre>` blocks with `white-space: pre` - unwrapped by
  design, so each one's *minimum* content width is the width of its
  longest unwrapped line, several times wider than the mobile column.
  `.panel` (a CSS grid item) and `.suggestion` (a flex item) both defaulted
  to `min-width: auto`, which bases an item's minimum size on its content
  instead of its track/flex-basis - the classic CSS grid/flexbox "overflow
  because nobody told it it's allowed to shrink" bug. Tried fixing it on
  the flex item (`.suggestion { min-width: 0 }`) first, on the theory that
  the deepest offending box was the right place to fix it; measured no
  change at all. The actual fix has to be on the grid item itself
  (`.panel`, `.output-panel { min-width: 0 }`) - the "if overflow isn't
  visible, this item's automatic minimum size is zero" carve-out in the
  spec applies to whichever box the *ancestor* layout (grid, in this case)
  is actually sizing, not to an arbitrary descendant that happens to look
  responsible. Verified the flex-level fix was genuinely redundant once
  the grid-level one was in place, and removed it rather than leaving two
  overlapping explanations in the CSS for one bug.
- **Extended the same local-complexity gating adaptive detail uses in
  ASCII mode to edges mode** - but inverted, since the two modes have
  opposite failure shapes. ASCII's problem was faint grain jittering
  between adjacent ramp characters, fixed by *reducing* the palette in
  flat areas. Edges mode's problem (the truck.jpg grille from the
  line-art investigation below, and the same aliasing on any fine
  texture) is the opposite: a busy cell has *too many* real edges once
  downsampled, and Sobel re-detecting all of them produces visual static
  rather than a readable line. So a busy cell (same `computeComplexityMap`
  score, same threshold as ASCII's) gets a *higher* effective edge
  threshold instead of a richer ramp - only the strongest lines in that
  cell survive. Calibrated by eye against truck.jpg (grille/tread),
  car.jpg, and high contrast tiger.png (stripe texture, not line art -
  confirms the fix generalizes past the one motivating case): a boost of
  60+ on the Threshold slider's 0-254 scale started erasing real outline
  structure along with the noise on all three; 40 was the highest value
  that still visibly decluttered the grille/stripes without doing that.
  The tiger result was the more convincing one of the two - the stripe
  texture that was pure visual static in the unmodified render actually
  reads as fur afterward, on an image that was never part of the original
  bug report.

**Line-art auto-suggest misclassification - investigated across two
sessions, resolved in the second.** truck.jpg and five similar
coloring-book-style uploads (spaceship, dog, house, boat, car) render far
better in braille mode than edges mode - the opposite of the
edges-threshold heuristic's fix in an earlier phase - but auto-suggest's
`edgeDensity`/`edgeConcentration` rule picked edges mode for them anyway,
since dense outline art scores just as high on raw edge density, and just
as *concentrated* on its subject, as a real photo's edges do.

First pass: gathered real stats (near-white fraction, midtone fraction, a
near-white+near-black "extreme" fraction) across all 26 test-assets images
at the time, looking for a signal that separates "line art" from "photo
where edges mode is actually correct." None had a safe margin -
`house.jpg`, the least line-art-like of the six, sat within 0.01-0.04 of
images already correctly classified as edges mode. Declined to ship a
threshold that close, per the concentration-metric lesson above, and left
it as an open question.

Second pass, after the edges-mode adaptive-detail work above and three new
technical-drawing test images (tech boat/car/house.jpg - pure thin-outline
schematics) landed: re-ran the same kind of stats gather against the
now-larger set, and used the new images to sanity-check that the "problem"
wasn't edge detection failing on line art in general - the tech drawings
already correctly suggested braille (their outlines are too sparse to
clear the existing `edgeDensity > 20` bar in the first place), and a
side-by-side render confirmed braille genuinely does look better than
edges there too, same as the coloring-book set. So the target was never
"make edges mode work on line art" - it was specifically "stop picking
edges mode for images that are *already* line art." Tried histogram
entropy (Shannon entropy of the luminance histogram) as a new candidate,
reasoning that a flat-shaded illustration is built from a handful of
dominant tones (a fill, an outline, maybe one shading tone) while a real
photo spreads real mass across most of the 0-255 range from sensor noise
and lighting gradients alone, even in a "flat" region. This one actually
separated cleanly: all six coloring-book uploads scored <= 5.01, all six
real photos that genuinely render well as line art scored >= 5.52 - a real
~0.5 gap, an order of magnitude wider than any edge-density-based signal
produced. Shipped as a third condition (`entropy >= 5.3`) on top of the
existing two, in `dither.js`'s `computeImageStats`/`suggestRenderMode`.
Verified against the live app, not just the stats: all six previously-
misclassified uploads now suggest braille, all six correct edges-mode
photos are unaffected.

Worth naming why the first pass's signals failed and this one didn't: near-
white/midtone/extreme fractions are all measuring *how much of the image
is background vs. subject* - a property real photos and line art share
about equally, since both can have a plain background and a detailed
subject. Entropy measures something else entirely - *how many distinct
tones the image is built from* - which is genuinely different between
"illustration" and "photograph" regardless of how much background either
one has. The earlier attempts weren't a wasted first pass so much as
narrowing down what dimension of difference wasn't the right one to
measure.

## Phase 8: A real race condition, found by a user report

A user reported that Suppress background's "detecting subject…" message
sometimes never appeared - unchecking and quickly re-checking the box, or
switching to a new image right after checking it, would leave the status
text stuck on its default with no visible feedback, as if the click had
done nothing.

Reproducing it turned out to be its own small lesson. A first pass at
racing the real model with fixed `waitForTimeout` delays between actions
gave wildly inconsistent results run to run - sometimes clean, sometimes
broken - because WASM inference genuinely blocks the page's main thread
for stretches, so Playwright's own `check()`/`uncheck()` calls queue up
behind it rather than landing at the intended moment; a "wait 150ms then
click" plan doesn't mean what it looks like it means when the page itself
isn't free to process that click for however long the WASM call is still
running. Switched to the same technique the existing "unchecking while in
flight" test already used - a controllable mock `detectForegroundMask()`
that only resolves when the test explicitly tells it to - and the race
became fully deterministic instead of a coin flip.

Root cause: unchecking Suppress background resets the status text to
default and clears the stored mask, but does *not* cancel whatever
detection request was already in flight - it only marks its eventual
resolution as a no-op if the box is still unchecked when it resolves (a
previous fix, in the "Adaptive detail and manual focus areas" phase's era,
already handles that half correctly). Re-checking before that request
resolves correctly avoids starting a wasteful second, redundant request -
but the code that decided to skip a new request never restored the
"detecting subject…" text either, so the user saw nothing until the
original, invisible request happened to finish on its own. The underlying
feature was never actually broken - detection kept working the whole
time - only its own status text was lying about it, silently, which reads
as "does this even do anything" the same as if it were.

Fix: split "already have a mask" (render immediately, no async wait
needed) from "a request is still pending" (restore the detecting text
and let the existing request's own resolution handle the rest) into two
separate checks instead of one combined one. One well-targeted comment
had described the intent for both cases; the code had actually only
implemented one and a half of them.



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
- **When a fix doesn't work, ask what's structurally different about the
  next attempt before retrying the same shape.** The first vision-model
  attempt and the one that actually worked used the exact same mask and
  the exact same model call — the only change was *where* the mask got
  applied (a settings heuristic vs. the render loop itself). Isolating
  that one variable, and testing it in isolation before combining it with
  anything else, is what made the second result trustworthy instead of
  just a different roll of the dice.
- **"Off by default" needs a test, not just a checkbox.** Wiring an
  unchecked checkbox felt sufficient until a test that actually watched
  network requests caught `ort.min.js` loading unconditionally anyway
  from a static `<script>` tag left over from the earlier auto-triggered
  design. Intent (a default value) and behavior (what actually fires)
  are different claims — only one of them was checked before the test
  existed.
- **A ported spec is a starting point for judgment, not a build order.**
  Handed a four-phase external spec, one whole phase turned out to be a
  heuristic already proven not to work on this exact codebase, and the
  headline feature ("adaptive sampling density") didn't literally fit a
  monospace character grid at all. Both needed catching *before* writing
  code, not discovering by implementing them and looking at the result —
  though looking at the result is still what caught the concrete bug
  (the mis-normalized Sobel constant) once real building started.
- **Fix an overflow at the box the outer layout is actually sizing, not
  the deepest descendant that looks responsible.** A `<pre>` with
  unwrapped content blew out a flex row, which blew out a CSS grid
  column, which blew out the whole mobile page. `min-width: 0` on the
  flex item (the seemingly obvious fix, right next to the offending
  content) measured zero effect; the actual fix was two layout levels up,
  on the grid item itself, because that's the box whose own `overflow`
  property the "automatic minimum size" spec rule actually reads. Same
  overflow, two candidate fixes, only one real - and only measuring
  (`window.innerWidth` at a real mobile viewport, not just eyeballing a
  screenshot) told them apart.
- **A test failure while a background test run overlaps a file edit isn't
  necessarily the code's fault.** Started `npm test` in the background,
  then kept editing `script.js`/`index.html` for an unrelated feature
  while it ran - this project's test server reads source files fresh off
  disk per request rather than bundling them, so a page navigation that
  landed mid-edit got a torn mix of old and new file content. One test
  failed in a way that looked like a real regression (a restored setting
  silently reverting to default) but reproduced only when editing and
  testing overlapped, and vanished on a clean re-run with no code changes
  in between. Worth remembering because the instinct when a test goes red
  is to start debugging the diff - checking whether anything touched the
  files *during* the run is a cheaper first question to ask.

## Phase 9: Hand-drawn style — chasing JavE, and finding its real limit

The actual, stated goal behind this whole project, said plainly for the
first time this phase: reproduce the feel of hand-crafted ASCII art like
JavE (Java Ascii Versatile Editor) and the pieces on asciiart.website -
not just a brightness ramp, but characters chosen because their *shape*
matches what's in the image. Braille mode stays as-is; this is entirely
about ASCII mode.

**Research, and a sandbox wall.** `WebFetch` was completely blocked for
every domain tried - `jave.de`, a GitHub Pages mirror, even
`en.wikipedia.org` - confirmed as a blanket egress policy, not a
domain-specific block. `WebSearch` still worked and found the academic
grounding (Xu et al.'s SIGGRAPH structure-based ASCII art, and Miyake et
al.'s simpler real-time variant), but the primary source - JavE's own
author explaining his algorithms - stayed unreachable until the user
uploaded the page directly as an `.mht` file. Worth remembering: when a
tool is flatly unavailable, the fix isn't to give up on the source, it's
to ask for the content directly.

That page turned out to matter for more than technique. Its author,
having tried edge-detection/tracing algorithms for image-to-ASCII
conversion, was explicitly skeptical they were the breakthrough people
expected ("I do not (yet) think so") - they combined badly with
greyscale shading and broke on fine detail. And his stated conclusion
was more humbling than any technique: automatic conversion is best used
as a *starting point* for hand-editing (the "plastic bag technique" -
watermark the source image into a text editor and draw over it by hand).
The tool that inspired this feature's whole name doesn't fully trust
automatic conversion to replace a human's touch-up pass. That's a real
ceiling to know about going in, not a discouragement to build the
feature anyway.

**Prototyping outside the repo first.** Before touching `dither.js` or
`script.js`, built the technique as standalone scratch scripts and
validated it against real photos with real screenshots, the same
discipline as every other phase here - a plausible-sounding technique
gets no special exemption from "look at the actual output."

The core idea (glyph matching): rasterize every candidate character in
the real output font into a small bitmap, treat each pixel's darkness as
"ink," and for each image cell, pick whichever character's ink pattern
correlates best with that cell's own pixel patch - via Normalized
Cross-Correlation (NCC), which is invariant to brightness/contrast and
only measures relative shape. Blend that with a brightness-matching term
so absolute tone still counts (pure NCC can't tell a solid-black patch
from a solid-white one - both mean-center to an all-zero vector).

**Two real bugs, found by testing on an actual image (`truck.jpg`), not
by reading the math:**

1. *Flat-patch noise amplification.* A patch with almost no variance
   (like a plain white background) would still get divided by its own
   near-zero norm during normalization, amplifying whatever tiny noise
   was there into a full-strength "confident" match - so flat regions
   picked essentially random characters instead of blanks or a low-ink
   character. Fixed with a stdev threshold: patches under it return an
   all-zero vector (deliberately "no shape here") instead of a noise-
   amplified one.
2. *Brightness-range mismatch.* Comparing an image patch's raw ink
   density (0-1, can reach nearly solid black) directly against the
   glyph atlas's *actual achievable* range - a plain ASCII set with no
   solid block character tops out around 0.34 mean ink - meant every
   moderately-dark-or-darker patch collapsed onto whatever the single
   densest available character was. Confirmed visually: pure brightness
   matching (structure weight 0) on a tiger photo produced a near-solid
   wall of `M`s. Fixed by rescaling each patch's ink density into the
   atlas's own `[minInk, maxInk]` range before comparing, instead of
   assuming the two scales already lined up.

**A harder problem, only partially solved.** Illustration-style images
(the truck, a toy spaceship, a car) matched the prototype's quality well
once both bugs were fixed. A tiger photo with fine fur and stripe texture
did not - nearly every cell registered as "busy" and collapsed onto the
densest available characters uniformly, worse than the plain tone ramp.
Fix: reuse the *existing* `computeComplexityMap()` (the same edge-density
+ contrast blend, same 0.12 threshold, that "Adaptive detail" already
uses) to drop the structure weight from 0.75 to 0.15 in busy cells, so
texture-heavy regions fall back toward brightness matching instead of
fighting for a "best" structural match among characters that are all
roughly equally wrong. This substantially improved the tiger result but
did not fully fix it - reported to the user honestly as a real,
documented limitation rather than something to quietly declare solved.
Real photos with heavy fine texture remain a harder case than clean
illustrations for this technique; four real-app end-to-end checks after
integration confirmed the pattern held outside the prototype too -
truck, spaceship, and dog photos all rendered as clearly recognizable
shapes with real structural detail, a car photo came through recognizable
but noisier, and a high-contrast tiger closeup rendered as a dense,
largely illegible block of the densest characters with none of the
animal's actual shape visible.

**A safety fix caught before it could ever crash anything.** Hand-drawn
style samples each character cell at real font resolution (roughly
10x18px per cell, more than the coarse 2x4-dot braille sampling), so the
backing canvas for a large custom grid could exceed browsers' actual
canvas dimension limit (~32767px) - the existing `maxDimension = 2000`
cap times an 18px cell height alone reaches 36000px. Rather than silently
shrinking the character grid the user asked for, `handDrawnGlyphCellFor()`
scales the *glyph* cell size down instead (floored at a legible 4x7px) to
keep the derived canvas within a safe budget - the grid dimensions the
user set stay exactly what they asked for.

**Design choice, made explicit rather than left implicit**: Hand-drawn
style and Adaptive detail are mutually exclusive - checking one unchecks
the other, both in the UI and through the settings permalink. They're
two different, incompatible strategies for choosing a character (shape-
matching vs. a brightness ramp with variable density), and the charset/
palette controls are meaningless once glyphs are chosen by shape rather
than by looking them up in a ramp - so those fields hide, too, exactly
the same pattern `applyRenderModeVisibility()` already used for
mode-specific fields.

## Phase 10: Chasing the tiger photo - three fixes tried, one real answer found

Phase 9 shipped Hand-drawn style with an honestly-documented limitation:
a heavily-textured, high-contrast photo (`high contrast tiger.png`)
rendered as a dense, illegible block, unlike the illustrations that
validated the feature. This phase is the story of three different,
genuinely-tried fixes for that limitation - all scratchpad-only, nothing
shipped - and what actually turned out to be true once each was tested
against the real photo instead of just reasoned about.

**Research first, hitting the sandbox's egress wall again.** Asked what
prior work exists on this exact problem. Found the real academic lineage:
Xu et al.'s 2010 "Structure-based ASCII art" (already the basis for this
feature) has two direct follow-ups by an overlapping author group - "ASCII
Art Synthesis from Natural Photographs" (IEEE TVCG, 2017) and "Texture-
aware ASCII art synthesis with proportional fonts" (2015) - both aimed at
exactly this failure mode: extracting real structure from natural photos
without texture drowning it out. Every one of these (Semantic Scholar,
IEEE Xplore, ResearchGate, and later a CUHK faculty page and a SlideServe
deck) was blocked by this sandbox's egress proxy - the same blanket
non-GitHub block found in Phase 9's JavE research, now confirmed across a
much wider set of domains. A user-uploaded PDF turned out to be a
*different* paper than the one being chased (Akiyama's "ASCII Art
Synthesis with Convolutional Networks", NIPS 2017) - a CNN trained on
real BBS-sourced ASCII art, but for a different sub-problem (character
selection from an already-extracted line drawing, not tone-based photo
rendering). Its related-work section still earned its keep: it corrected
an earlier web-search summary that had attributed "non-CRF modulation" to
the 2017 TVCG paper - the paper's own actual technique, per this
secondary source, is multi-orientation phase congruency via an extended
Gabor filter. Worth remembering: a search engine's synthesized summary of
a paper is not the paper, and a secondary source that actually cites it
correctly is worth more than three search snippets that don't quite agree
with each other.

**Attempt 1: non-CRF-style surround suppression.** Since the real papers
were unreachable, built a good-faith reimplementation of the general,
well-documented technique they build on (Grigorescu et al. 2003's
non-classical-receptive-field surround suppression for contour
detection): isolated edges survive, edges embedded in dense surrounding
texture get inhibited. Implemented as an isotropic annulus-average
suppression via a summed-area table for O(1) box queries at any radius,
deliberately simplified from the real oriented/anisotropic model and
disclosed as such in the prototype's own comments.

Before even testing the idea, found a real bug in the *test harness
itself*: the prototype's character-grid aspect-ratio formula divided by
`patchWidth/patchHeight` (≈0.556) instead of multiplying by the app's
actual `asciiCharAspect` (0.55) - two numerically similar but backwards
operations, numerically close enough to not immediately look wrong, that
inflated the tiger's test grid to 175 rows instead of the correct ~60,
badly distorting the image regardless of what algorithm ran on it. Fixed
across all three affected scratchpad scripts before drawing any
conclusion from them - a reminder that a scratchpad prototype's own
plumbing needs the same "don't guess, verify" discipline as shipped code,
just at lower stakes.

With the grid fixed, tested three variants side by side on the tiger
(shipped binary complexity gate, a non-CRF binary gate, a smooth non-CRF
blend): all three were visually indistinguishable, still an illegible
wall of dense characters. Isolating further - pure brightness matching
alone (`structureWeight = 0`, no NCC/structure influence whatsoever)
produced the same wall. **That ruled out texture/structure confusion
entirely** - this was never the problem non-CRF was built to solve.

**Finding the real symptom, by comparing against what already works.**
The plain ramp-based ASCII mode, on the identical image and the identical
100x60 grid, renders a clearly recognizable tiger face. Comparing the two
approaches on the exact same per-cell brightness data (not just the
screenshots) found the actual mechanism: `matchGlyph`'s brightness
scoring is a nearest-neighbor match against each glyph's *raw* ink
density, and the Hand-drawn charset's achievable ink range has a real
gap - four characters (`W`, `@`, `B`, `M`) all cluster within 0.007 of
each other at the dense end, with nothing between them and the next-
lightest character 0.03 away. Roughly a quarter of this photo's pixels
are genuinely very dark (confirmed from the real luminance histogram),
so a wide range of distinct dark-tail brightness values were all
nearest-matching onto that one tight cluster - collapsing exactly the
contrast needed to see the animal's dark facial features. This looked
like a clean, well-understood, fixable bug.

**Attempt 2: rank-based brightness scoring.** Reused the plain ramp's own
working idea - `luminanceToChar` assigns an *index* into an evenly-spaced
array, which by construction can never collapse two different brightness
levels onto the same crowded cluster the way nearest-ink-density matching
can. Built `matchGlyphRank`: pre-sort the glyph atlas by ink density,
assign each patch a target rank via the same `floor(v * n)` formula
`luminanceToChar` uses, and score brightness by rank-distance instead of
ink-distance. Verified the atlas rescaling and rank math directly against
the real 70-character set before rendering anything (confirmed evenly-
distributed, non-clustered target ranks) - and it still rendered the
tiger as an illegible wall, at every structure weight tried, including
pure rank-based brightness alone. It also *regressed* the truck photo
(one of Phase 9's validated good cases) into something new and worse.
**A rigorous, well-motivated fix, cleanly falsified by the same
photo it was built for and a working case it broke instead.**

**Attempt 3: charset curation.** Rasterized the full 95-character
printable ASCII range (not just the existing 70-character Hand-drawn
set) to search for a genuinely better-spaced subset. This surfaced a
fact worth remembering on its own: **no printable ASCII character in this
font, at this cell size, achieves more than ~34% ink coverage** - the
character-based ceiling is real and hard, unrelated to which 70 (or 95)
characters get chosen. The full pool's darkest end is just as clustered
as the curated 70's (`R` at 0.307, then `W`/`@`/`B`/`M`/`N` all crammed
into 0.331-0.339) - there simply aren't more distinct dense glyphs to
choose from. Built a curated 25-character set via greedy minimum-gap
selection (walk the sorted pool, keep a candidate only once it's ≥0.010
ink-density away from the last kept one, always keep the single darkest
as a ceiling anchor) and re-rendered the tiger with the shipped matching
logic. Still an illegible wall.

**The actual answer, found by checking the data one layer deeper.**
Before concluding rank-based scoring simply doesn't work, dumped the
real character-usage histogram it produced against the tiger's 6000
cells: a smooth, well-distributed spread across dozens of different
letters (`@` 671, `W` 310, `B` 240, `Q`/`Y` 139 each, tapering gradually
down through `a`, `p`, `n`, `z`, `t`... to single digits at the light
end). The *data* was correctly rank-preserving - there was no collapse
left to fix. Yet the *rendered image* still looked like undifferentiated
noise. That combination - correct data, illegible picture - means the
bottleneck was never in the scoring math at all: **a small hand-curated
tone ramp (`@%#*+=-:. `) reads as visually distinct shades because those
exact ten symbols were chosen, over decades of ASCII-art convention, for
perceived tonal weight at a glance - not because of their measured ink
density.** A wall of real dictionary characters (`W`, `B`, `Q`, `a`, `&`,
chosen for shape variety because structure-matching needs many different
silhouettes to match against) doesn't carry that same clean visual-weight
signal, no matter how correctly its underlying brightness data is
ordered. Rank-preserving math and perceptual tonal legibility turned out
to be two different properties - fixing the first doesn't buy the second.

**Where this leaves the tiger case.** Three different, real attempts
(non-CRF-style texture gating, rank-based brightness scoring, charset
curation) were each properly tested against the actual failing photo
rather than reasoned about in the abstract, and each was honestly
falsified by that test rather than declared a win on theory. The
underlying limitation looks structural, not a tuning problem: shape-
diverse structure matching and small-ramp tonal legibility appear to be
in real tension for a character set trying to do both jobs at once. No
code shipped from this phase - Hand-drawn style remains exactly as
Phase 9 left it, with its known limitation now backed by three ruled-out
explanations instead of one open question.

**Lessons worth keeping:**
- **A scratchpad prototype's own bugs can look exactly like the
  phenomenon you're trying to study.** The aspect-ratio bug in the non-CRF
  harness produced a badly-distorted grid that would have looked like
  "the algorithm fails on this photo" if not caught before drawing
  conclusions - the fix (matching the real app's `asciiCharAspect`
  formula, verified against the app's own actual grid dimensions for the
  same image) came from checking the harness against ground truth, not
  from staring harder at the output.
- **A negative result reached the same way as a positive one is still
  worth exactly as much.** Three fixes, three real tests against the
  actual failing photo, three honest falsifications - none of them
  wasted effort, because each one closed off a specific, previously-live
  hypothesis (texture confusion, ink-density collapse, poor charset
  spacing) rather than leaving it as vague, unresolved suspicion.
- **Well-distributed data and a legible rendering are not the same
  claim.** The rank-based fix's histogram was correct by every measure
  checked - yet the image it produced was still illegible. Checking "is
  the data right" and "does the picture look right" are two different
  verification steps, and this project's own working process (a real
  browser/output pass, not just checking the numbers) is exactly the
  discipline that caught the gap between them here.
- **A secondary source that gets the citation right beats three search
  snippets that don't agree.** The Akiyama paper wasn't the one being
  looked for, but its related-work section's specific, attributed claim
  ("Xu et al. 2017 used multi-orientation phase congruency") corrected a
  vaguer, likely-conflated web-search summary from earlier in the same
  investigation - worth more than the search that originally produced it.

**Addendum: getting the actual foundational paper, and what it confirms.**
After this phase's investigation, the user found and uploaded the real
Xu, Zhang, and Wong 2010 "Structure-based ASCII Art" paper directly (the
one this whole feature already credits as "a simpler relative of") - the
egress block that stopped every other attempt this session doesn't apply
to a file handed over directly. Reading it in full clarified something
today's three attempts had been quietly assuming rather than checking:
**academic "structure-based ASCII art," as this field defines it, is a
line-drawing-to-character problem, not a photograph-to-character one.**
Their actual pipeline vectorizes a line drawing into polylines, then
iteratively *deforms* those polylines via simulated annealing so they
match available character shapes better, then substitutes characters -
there is no step anywhere that takes a raw continuous-tone photograph's
pixels and shape-matches them directly the way Hand-drawn style's
`matchGlyph` does. Every example in the paper (a dragon, a temple, a
train) is a pure line tracing, not a shaded/toned image - much closer to
this app's existing "Edges" mode than to "ASCII" mode. That reframes
today's whole investigation: Hand-drawn style was trying to fuse two
problems the actual literature keeps separate (continuous tone and shape
matching) into one per-cell greedy decision, which may be a harder
problem than either half alone.

More directly useful: the paper's own Limitations section, from a method
with real shape deformation and a proper alignment-insensitive shape
metric (log-polar histograms, far more sophisticated than this feature's
NCC), states plainly - *"the extremely limited variety of characters...
[m]ost font sets do not contain characters representing a rich variety of
slopes of lines. This makes certain patterns very hard to be faithfully
represented."* That is an independent, academic confirmation of exactly
today's charset-curation finding (no printable ASCII character exceeds
~34% ink coverage, and the dense end is unavoidably clustered) - not
from three tuning attempts, but from the actual state of the art
admitting the same ceiling. Worth remembering the plain lesson here: when
a primary source is finally reachable, it doesn't just answer the
question that sent you looking for it - it can tell you the question
itself was aimed at the wrong pipeline.

## Phase 11: The real 2015 paper, a fourth attempt, and the fix that was never going to work

Getting the 2015 follow-up paper (Xu, Zhong, Xie, Qin, Chen, Jin, Wong,
Han, "Texture-Aware ASCII Art Synthesis with Proportional Fonts", NPAR/
Expressive 2015) took two more tries - a 101 MB "save whole page" export
was too large to upload, and a second upload turned out to be the same
2010 paper again by mistake - before the actual PDF came through. It was
worth the wait: unlike the 2010 paper, this one operates directly on
real photographs (not pre-vectorized line art), which is exactly the
problem Hand-drawn style is trying to solve.

**An independent, academic confirmation of the exact failure this project
found empirically.** The paper's own user study (Table 1) scores the
2010 method - fixed-width character matching, architecturally close to
what Hand-drawn style does - on real photos: 6.26/6.12/5.86
(similarity/recognition/aesthetics) vs. **8.72/8.61/8.46** for their new
method, which slightly *exceeds* the human-artist baseline (8.63) on
photos specifically. Their own stated reason: *"the fixed-width font
cannot well represent a variety of structures in natural images."* That
is a controlled, academic reproduction of the tiger's exact failure mode,
arrived at independently of anything tried here.

**The actual fix has two parts, and only one is usable here.** (1) A
dynamic-programming-optimized *proportional font* placement - solving
character width and position jointly rather than a fixed grid. Real
contributor to their result, but structurally inapplicable: asciify's
entire premise is monospace output that pastes into any plain-text
surface, so adopting proportional fonts isn't an option to chase, just a
ceiling to know about. (2) *Multi-orientation phase congruency that keeps
a vector, not a sum*: standard phase congruency (and, for that matter,
the earlier non-CRF attempt) collapses edge energy across all
orientations into one scalar, which over-emphasizes isotropic texture -
many orientations each contributing a little can sum to a lot. Their fix
keeps six separate per-orientation energy values; a real contour
concentrates energy in one orientation, while texture spreads it evenly
across all six.

**Attempt 4: orientation-dominance gating.** Implemented a good-faith,
disclosed simplification of part (2) - a bank of six oriented Gabor
magnitude filters (spatial-domain, single scale, standing in for the
paper's actual multi-scale log-Gabor phase-congruency computation, which
needs FFT machinery this prototype doesn't have) - and used each cell's
"dominance" (top orientation's share of total energy, vs. the 1/6
isotropic baseline) as a replacement busy-cell gate, same architecture as
the non-CRF attempt but with an orientation-aware signal instead of an
isotropic one.

Verified the discriminator actually worked before judging the result:
median dominance on the tiger was 0.213 against a 0.167 isotropic
baseline, and 95% of cells were correctly classified as "not real
structure" (texture, not contour) - a working signal, not a bug. Yet the
rendered tiger was still an illegible wall, structurally the same result
as every earlier attempt. Truck.jpg (the known-good case) still rendered
cleanly, confirming no regression - the gate itself is sound.

**Why this negative result was actually predictable, and a lesson about
not re-testing an already-isolated variable.** Phase 10 had already run
the one test that made this outcome foreseeable: pure brightness matching
alone (`structureWeight = 0`, meaning the *gate's* value cannot possibly
change the output) still rendered the tiger as an illegible wall. That
result means the busy-cell gate - whatever signal drives it, however
sophisticated - was never capable of fixing this image's failure, because
the brightness term alone already fails independent of any gating
decision. Non-CRF (Phase 10, attempt 1) and orientation-dominance
(this phase) are two different, genuinely more sophisticated texture
discriminators than a plain complexity threshold - and both were testing
the same already-ruled-out variable (how the gate decides between
structure and brightness weighting) rather than the actual bottleneck
(the brightness term's own nearest-ink-density collapse at the charset's
clustered dense end, found in Phase 10). The lesson: once a variable is
shown not to matter (here, via the weight=0 test), that finding applies
to the whole family of fixes that only act through that variable, not
just the one version already tried - re-testing a fancier version of an
already-eliminated mechanism costs real implementation and Gabor-filter
compute time for a result the earlier isolation had already implied.

**Where this leaves things.** Four attempts across two phases (non-CRF
gating, rank-based brightness, charset curation, orientation-dominance
gating) have now been tried and honestly falsified against the same real
photo. The 2015 paper's own architecture succeeds specifically by
combining phase congruency *with* proportional-font placement - and the
proportional-font half is the one piece that doesn't transfer to a
monospace-output tool. That is a legitimate, externally-validated reason
this specific problem may not have a fix available within asciify's own
constraints, rather than a fix nobody has found yet.

## Phase 12: A fifth attempt, and closing the tiger investigation

One idea from this whole arc had never actually been tested: build the
Hand-drawn charset from *empirical frequency* in real hand-made ASCII art
(already sitting in `test-assets/*.txt` - four pieces from
asciiart.website, confirmed hand-drawn back in this project's early
research) instead of deriving it from measured ink-density math. Unlike
the four fixes in Phases 10-11, all of which acted on the busy-cell gate
(already shown incapable of fixing this photo, since pure brightness
alone fails regardless of gating), this one changes a genuinely different
lever - which characters exist in the set at all.

Built a 60-character glyph atlas from every character that actually
appears across the four real files (not just the dominant 11), rasterized
in the app's real font at the same cell size as the shipped feature.
Checked the achievable ink range before rendering anything: **the
densest real character these artists ever used tops out at 0.30 mean
ink - lower than the existing 70-character set's 0.34 ceiling.** That's
consistent with the material itself: hand-drawn line art has no reason to
reach for dense, block-like letters (M, W, B, @), so a charset built
purely from that material inherits an even lower dark-tail ceiling than
the one already identified as the tiger's root cause.

Rendered anyway, rather than trusting that prediction. Result: the tiger
was still an illegible wall, if anything more uniform (heavier `#`/`0`/`H`
concentration, consistent with the lower ceiling forcing even more
distinct dark tones to collapse onto fewer characters). More
importantly, **the truck - the known-good case every other attempt this
session left untouched - visibly regressed**: horizontal banding
artifacts running through the whole image, worse than the shipped
70-character set. Excluding every character absent from a 4-piece sample
also excluded real, useful mid-tone shapes (several letters and
punctuation marks) that the shipped set relies on for illustrations,
not just photos. A charset that's empirically "authentic" to a small
real sample isn't automatically better for structure matching in
general - it's only as good as what that sample happened to need.

**Closing this out.** Five attempts, two research phases, one paywalled-
then-obtained academic paper, and a clean regression on the one thing
every earlier attempt had protected (the known-good illustrations) - all
converging on the same conclusion Phase 10 first found and Phase 11's
external validation confirmed: Hand-drawn style's tiger-photo failure is
rooted in the brightness term's own dark-tail collapse against a
necessarily-limited character set, not in texture handling, brightness
scoring, curated spacing, orientation-aware gating, or charset
provenance. The real fix (phase congruency plus proportional-font
placement, per the 2015 paper) needs an architectural piece - variable-
width characters - that this project cannot adopt without giving up its
core "pastes into any plain-text surface" premise. Hand-drawn style
ships as-is, with this limitation now understood rather than merely
observed: five specific, real hypotheses ruled out by name, not just a
vague "photos with heavy texture don't work well" note.

## Phase 13: "Simplify tones" - the sixth attempt, and the first real win

The user reopened the closed investigation with a genuinely different
framing: *"find a way to simplify the image first, then attempt to
convert to ASCII."* Worth distinguishing from what five earlier attempts
already covered before building anything: a global tone remap (the
rank-based attempt) and per-cell texture/structure gating (non-CRF, phase
congruency) were both tried and fell to the same root cause. The one
untested piece of "simplify first" was *spatial consolidation* -
forcing genuinely-similar-toned neighboring cells to share an identical
brightness target, on the theory that part of the tiger's illegibility
isn't just "too few dark characters" in the abstract, but that
neighboring cells within what should read as one coherent dark region
(the fur) were each independently picking among several near-tied glyphs
based on tiny pixel noise - producing a scattered, inconsistent mix
instead of a repeated, eye-readable block.

**Prototyped first, as always.** Quantized each cell's raw mean ink into
a small number of buckets spanning THIS image's own observed range
(deliberately absolute-value bucketing, not the rank-based attempt's
percentile stretch - rank normalization manufactures precision that
isn't really there, which is what caused that attempt's truck banding;
absolute bucketing can only merge cells that are already close in real
brightness, never invent contrast where none exists). At 8 buckets, the
tiger showed something none of the previous five attempts produced:
visible coherent blocks and a distinguishable eye-like shape near the
top - a real, visible qualitative change, not just a different-looking
wall of noise.

**But it regressed the truck** - the one thing every earlier attempt had
left untouched. Gating the quantization to only "busy" cells (reusing
the existing complexity threshold) didn't fix it: 68.7% of the truck's
own cells are *also* classified busy by that measure, so the gate barely
protected anything. Trying a gentler 16-bucket setting softened but
didn't eliminate the truck's degradation, while also shrinking the
tiger's benefit - confirming this is a genuine dial, not a threshold to
tune once and forget. **First real partial win in six attempts, with an
honest, unavoidable trade-off attached.**

**Decision, put to the user rather than made silently**: ship it as a
new user-adjustable control ("Simplify tones") rather than a new fixed
default, since no single setting serves both a clean illustration and a
heavily-textured photo well. Implementation:
- `quantizeInk(value, minObserved, maxObserved, levels)` in `dither.js` -
  pure, tested logic, `0` levels is an explicit off sentinel rather than
  a very-high-number stand-in, so the default path is a real, separate
  code branch (`if (!levels) return value`), not an approximation of one.
- `matchGlyph` gained an optional fourth `overrideMeanInk` parameter
  (`??`, not `||` - 0 is a legitimate real value, not "not provided").
  It replaces the brightness target only; shape matching still reads the
  cell's own real pixels, unmodified. Every existing call site is
  unaffected since the parameter defaults to `undefined`.
- The slider's own maximum value (32) IS the off sentinel, and the
  default - a real photo pass confirmed the render is unaffected until a
  user actually moves it down.
- Quantization only ever touches cells the existing complexity gate
  already calls "busy" - confirmed by testing, not assumed, that turning
  it off leaves illustrations exactly as validated in Phase 9.
- One bug caught in review before shipping, not by a test failing:
  background-masked cells (Suppress background) were being included in
  the bucket range computation despite never reaching `matchGlyph` -
  wasting buckets on content that renders as blank space instead of
  spending all of them on the subject's own real range. Fixed by
  excluding background-masked cells from the min/max scan, the same
  `isBackgroundPixel` check the render loop itself already uses.

**Where this leaves the tiger case, honestly**: "Simplify tones" is a
real, tested improvement a user can reach for on a difficult photo - not
a fix that makes Hand-drawn style's known limitation disappear. At its
most aggressive setting the tiger still doesn't read as fully
photorealistic; it reads as a more *coherent* rendering than before,
which is a genuinely different and better place to leave this than five
attempts that changed nothing. The underlying ceiling from Phases 10-12
(a monospace character set's achievable dark-tail resolution) is still
exactly what it was - this control works around part of its effect
without touching the ceiling itself.

**Lesson worth keeping**: a "closed" investigation is closed against the
hypotheses actually tested, not against every possible framing of the
problem. Five falsified attempts earned real confidence that texture
handling, brightness scoring, charset spacing, and orientation gating
weren't the answer - but "simplify first" turned out to name a mechanism
(spatial consolidation) genuinely outside that set, and reopening on a
specific, testable new idea rather than a vague "try harder" is what
made it worth the hour rather than a repeat of the same five results.

## Phase 14: "Trace outline first" - the actual academic pipeline, finally tried

The user proposed a third reopening, even more specific than Phase 13's:
generate a black-outline version of the photo first, then match
characters against *that* instead of the raw image - and asked directly
whether that needs an image-generation model. It doesn't, and saying so
plainly mattered: outline/edge extraction is the same deterministic pixel
math this project's own Edges mode already does (Sobel gradients), not
generative AI. More importantly, this is *literally* the real academic
pipeline Phase 11's addendum already found and didn't act on: Xu et al.
2010 vectorizes a line drawing first, then matches characters to that -
every attempt in Phases 10-13, including the otherwise-successful
"Simplify tones," still matched characters against raw continuous-tone
pixels. This was the one big structural piece nobody had actually tried.

**Prototyped it, and it worked better than anything else this
investigation produced.** Extracted a binary (pure black/white) edge map
via the existing `sobelGradient`, thresholded, then fed THOSE binary
patches into the unchanged `matchGlyph`/NCC machinery instead of
ink-density patches. At threshold 0.15 (normalized), the tiger's ears,
eyes, and muzzle became clearly recognizable for the first time in five
prior attempts - not "more coherent than before," genuinely readable as
a tiger face. The mechanism is exactly why: a binary source has no
continuous brightness to collapse, so Phase 10's root cause (the
charset's clustered dark-tail ceiling) simply doesn't apply to it.

**Real trade-offs, tested rather than assumed away:**
- A higher threshold (0.25) cleaned up the truck's edge noise but lost
  most of the tiger's structure - fur/contour edges are inherently
  lower-contrast than the truck's crisp painted panel lines, so any
  single threshold that suppresses one suppresses the other.
- Blurring before edge detection (the standard noise-reduction pre-step
  real edge detectors like Canny use) meaningfully cleaned up the
  truck's JPEG/surface-texture noise, but softened the tiger's fur edges
  enough to lose some of the facial clarity the unblurred version had.

Two real, independently-useful dials, not one setting to tune once -
the same shape of trade-off "Simplify tones" already established a
pattern for, so both shipped as opt-in controls rather than a forced
default, decided with the user rather than picked silently.

**What shipped**, all under a new "Trace outline first" checkbox nested
in Hand-drawn style (hides Simplify tones while active - a continuous
brightness target has nothing to quantize once the source is already
binary):
- `boxBlurLuminance(data, width, height)` in `dither.js` - a plain,
  tested 3x3 box blur, edge-clamped, returned as a drop-in RGBA-shaped
  buffer so it composes directly with the existing `sobelGradient`.
- `computeHandDrawnOutlinePatches()` in `script.js` - mirrors
  `computeHandDrawnPatches()`'s structure but slices a thresholded
  binary edge map into patches instead of ink density. Reuses `edgeChar`
  purely as an "is this pixel's gradient above threshold" test (discards
  the direction character it returns) rather than duplicating its
  magnitude-normalization math - one second-order benefit of that reuse:
  the new "Edge threshold" slider sits on the exact same 0-254 scale as
  the existing braille/edges Threshold control, for free.
- A fixed, near-maximum structure weight (0.95) when outline mode is
  active - there's no meaningful brightness fallback to blend toward
  once the patch itself already is a shape, and no busy-cell gating
  decision left to make (confirmed empirically, not assumed).
- "Reduce noise" checkbox (off by default - the unblurred setting gave
  the single best tiger result of the whole investigation) applies
  `boxBlurLuminance` before the Sobel pass.

**Where this leaves the tiger case, genuinely revised from Phase 12's
close-out**: this is not another partial, honestly-limited improvement -
it is a real, working fix for legibility on the hardest case this
project has tested, arrived at by finally building the actual technique
the academic literature uses instead of a simplification of it. The
underlying character-set ceiling from Phases 10-12 is still real, and
"Trace outline first" trades photorealistic tone for structural
legibility rather than delivering both - but "the tiger's face is
recognizable" is a materially different and better outcome than every
prior phase reached.

**Lesson worth keeping, on top of Phase 13's**: two "reopenings" of a
"closed" investigation in a row each found something real, because each
named a mechanism (spatial consolidation, then outline-first matching)
that hadn't actually been tried - not a re-ask of "can you try harder."
The second reopening in particular succeeded specifically because it
matched the technique degree-for-degree with a source the project had
*already read* (Phase 11's Xu 2010 addendum) but not yet acted on -
sometimes the fix was already sitting in the project's own research
notes, just not yet connected to the room where the source image gets
touched.

## Phase 15: Non-maximum suppression + hysteresis - the rest of Canny, and the first fix with no trade-off

Prompted by outside feedback (a user-shared GLSL shader and a written
description of a full Canny pipeline) pointing out that "Trace outline
first"'s edge extraction was still just a single global magnitude
threshold - the crudest possible version of edge detection, missing the
two steps (thinning, connectivity-based pruning) that separate a raw
Sobel response from an actual clean line drawing. Declined the specific
suggestion to do this on the GPU via WebGL (see the PR discussion for
why: it would make the edge math untestable under `node --test`, and the
character-matching step needs the result back in JS anyway, so a GPU
round-trip wouldn't even remove the CPU-side loop) - but the underlying
algorithmic point stood on its own and was worth testing independent of
how it was proposed.

**What was actually missing**: a raw Sobel magnitude thresholded at one
cutoff produces edges several pixels wide (every pixel near a boundary
exceeds the threshold, not just the one truest edge pixel), and a single
global threshold either lets isolated noise-driven pixels through or
cuts off genuine low-contrast edges - there's no way to have both with
one number. Non-maximum suppression (keep a pixel only if its magnitude
is the local max along its own gradient direction, else suppress it)
fixes the first problem. Hysteresis (keep strong edges outright; keep
weak edges only if 8-connected, transitively, to a strong one) fixes the
second.

**Prototyped against five real images already used throughout this
investigation** - the tiger (fur texture, the hardest case), the truck
(clean illustration, the case every fur-texture fix has previously
regressed), a dog photo (clear silhouette), a soft-lit portrait (sparse
edges), and a cluttered desk photo (genuine, not noise-driven, visual
density) - comparing foreground-pixel count and an objective "isolated
speck" count (foreground pixels with zero foreground 8-neighbors) before
and after:

| image | baseline fg / specks | NMS+hysteresis fg / specks |
|---|---|---|
| tiger | 29,635 / 195 | 26,274 / **0** |
| truck | 110,331 / 8 | 42,551 / 8 |
| dog | 50,180 / 0 | 15,929 / 0 |
| portrait | 4,726 / 2 | 2,078 / **0** |
| busy desk | 29,294 / 25 | 20,265 / **0** |

Isolated specks dropped to exactly zero everywhere they existed (hysteresis
doing precisely what it's supposed to), and thinning cut raw foreground
pixel counts by roughly 30-65% by collapsing multi-pixel-wide edges down
to single-pixel ridges - confirmed visually as thinner, crisper lines
rather than lost detail (most visible on the truck, whose thick doubled
strokes became clean single-line panel edges). Recognizability held on
every single image; nothing regressed.

**This is the first idea in this whole investigation (Phases 10-14) that
didn't trade one image for another.** Every previous fix either helped
the tiger and hurt the truck, or helped neither. NMS + hysteresis
improved edge quality in the same direction on all five test images,
including the two that have anchored every prior trade-off decision -
which is why, unlike Simplify tones and Trace outline first's own
threshold/blur controls, this shipped as an unconditional upgrade to the
existing edge-extraction internals rather than a new opt-in toggle. No
new UI: the existing "Edge threshold" slider now serves as the
hysteresis "strong" cutoff, with the "weak but keep if connected"
threshold fixed internally at half that value (the conventional Canny
2:1 starting ratio, and close enough to what was actually tuned in
testing - 0.18/0.08 - not to need its own control).

**What shipped**: `sobelMagnitude`/`edgeAngle` in `dither.js`, factored
out of `edgeChar`'s existing inline math so the same normalization and
angle-folding logic backs both the character-picking (`edgeChar`, used
by Edges mode) and the new pixel-level thinning/pruning functions
without duplicating the magic numbers twice. `nonMaxSuppress(magnitudes,
angles, width, height)` and `hysteresisThreshold(magnitudes, width,
height, highThreshold, lowThreshold)`, both pure array functions
consistent with everything else in `dither.js`, unit tested directly
(a five-pixel synthetic ridge for NMS; a small synthetic strong/weak/
isolated graph for hysteresis's connectivity behavior) rather than only
through screenshot comparison. `computeHandDrawnOutlinePatches()` in
`script.js` now runs Sobel → NMS → hysteresis instead of Sobel →
threshold, with no change to its public behavior (same checkbox, same
slider, same permalink parameter).

**Lesson**: generic-sounding advice ("here's a Canny pipeline," "here's a
WebGL shader for this") is worth the same test as anything self-generated
- not adopted because it sounds sophisticated, not dismissed because it
arrived as a large unsolicited code dump. The GPU delivery mechanism was
a genuine mismatch for this codebase's testing architecture and was
declined; the underlying algorithmic idea (NMS + hysteresis are real,
well-understood techniques, not this project's own invention) was
tested the same way every other idea in this investigation was, and this
time it earned its place with a clean, unconditional win.

## Phase 16: Bilateral filter replaces box blur - a real trade-off, decided rather than assumed

More outside feedback after Phase 15 (a second unsolicited write-up)
named one more real gap: "Reduce noise" was still a plain 3x3 box blur,
which can't tell a genuine edge from texture noise apart from raw
spatial proximity - it softens both equally. That's exactly what Phase
14 already found and documented as a cost: blurring "cleaned up the
truck's JPEG/surface-texture noise, but softened the tiger's fur edges
enough to lose some of the facial clarity." A bilateral filter's whole
premise is the fix for that specific problem - weight each neighbor by
BOTH spatial distance and how close its brightness is to the center
pixel's, so a same-side (texture) neighbor still gets smoothed while a
far-side (real edge) neighbor barely counts.

**Prototyped it the same way as Phase 15**: box blur, bilateral filter
(radius 2, sigmaSpatial 1.5, sigmaRange 30), and no blur at all (the
actual shipped default), each followed by the real Sobel → NMS →
hysteresis pipeline, across the same 5 test photos:

| image | no blur fg/specks | box blur fg/specks | bilateral fg/specks |
|---|---|---|---|
| tiger | 76,046 / 7 | 38,793 / 0 | 46,472 / 0 |
| truck | 43,569 / 48 | 42,759 / 12 | 43,112 / 50 |
| dog | 15,797 / 0 | 15,929 / 0 | 15,663 / 0 |
| portrait | 2,593 / 0 | 2,111 / 0 | 2,584 / 0 |
| busy desk | 30,066 / 3 | 26,436 / 0 | 28,074 / 2 |

**A genuinely different result shape than Phase 15's clean sweep.** On
the tiger - the actual reason "Reduce noise" exists - bilateral visibly
preserved the eyes, muzzle, and ear structure that box blur softened
away, while still cutting background/texture noise by almost as much
(46,472 vs 38,793, both down from 76,046 unblurred). But on the other
four images, box blur was consistently the more aggressive noise
cleaner; bilateral landed between "no blur" and "box blur" rather than
beating both. Screenshots of the truck and busy-desk cases, though,
showed this numeric gap was visually negligible - the renders were
close to indistinguishable - while the tiger's improvement was
substantial and immediately visible.

**Flagged rather than decided silently**, since this was a real
trade-off (unlike Phase 15's unconditional win): asked whether to
replace box blur outright, offer both as a choice, or leave it. Chose
to replace it outright - the tiger case is the one this option was
actually built for and names in its own tooltip ("Can make a
heavily-textured photo far more recognizable"), the losses elsewhere
were visually negligible even though numerically real, and a second
blur-method selector would be UI complexity for a difference nobody
would likely notice in practice.

**What shipped**: `bilateralBlurLuminance(data, width, height, radius,
sigmaSpatial, sigmaRange)` in `dither.js` replaces `boxBlurLuminance`
outright (deleted, not deprecated - it had exactly one caller and that
caller now uses the new function) with defaults matching the validated
comparison above. Same call site, same "Reduce noise" checkbox, same
permalink parameter - purely an internal algorithm swap.

**Lesson, continuing Phase 15's**: not every piece of outside advice
resolves the same way. Phase 15's suggestion (NMS + hysteresis) tested
out as a clean, unconditional win and shipped silently as an upgrade.
This one tested out as a genuine trade-off - better on the one case
that actually matters for this feature, mildly worse on four others -
and got a real decision rather than an assumption in either direction:
neither "sounds like a good idea, ship it" nor "it has some regression,
skip it," but actually looking at what the regression cost in practice
before choosing.

**Addendum: a real 2025 paper comparing ML classifiers against AISS for
structure-based ASCII art.** The user uploaded "Evaluating Machine
Learning Approaches for ASCII Art Generation" (Coumar & Kingston,
Purdue, arXiv:2503.14375, March 2025) - not previously seen, and worth
recording because it independently validates the direction "Trace
outline first" already took rather than suggesting a new one.

Their whole pipeline is the same shape as this feature's: extract line
structure first (they cite Canny, same family as `sobelGradient` +
`nonMaxSuppress` + `hysteresisThreshold`), then match characters to the
extracted structure rather than to raw continuous tone. They compare
that matching step across classical ML (k-NN, SVM, Random Forest),
deep learning (CNN, ResNet, MobileNetV2), and the same non-ML **AISS**
baseline (Xu, Zhang, Wong 2010) already cited in this file's Phase 11
addendum.

The one finding worth keeping: **AISS - pure structural-similarity
matching, no trained classifier at all - scored the highest SSIM
(structural fidelity) of every technique they tested (0.6681), ahead of
CNN (0.6638) and Random Forest (0.6654).** `matchGlyph`'s NCC-based
shape correlation is architecturally the same family as AISS (direct
similarity matching, not a learned classifier), not the same family as
any of their ML/DL methods - so this is independent, external evidence
that the deterministic-matching approach this whole codebase is built
on isn't a simplification standing in for "real" ML, it's competitive
with it on the metric that matters most for legibility.

Their "overmatching" finding is a useful piece of vocabulary, not a new
technique: ResNet and MobileNetV2 hit 96%+ character-classification
accuracy yet produced visibly worse art, because a confident classifier
would pick a complex-looking-but-wrong glyph in dense/ambiguous regions
(their examples: eyes, mouths). That is a different mechanism than but
the same *shape* of failure as Phase 10's root cause here (a small
cluster of very-dark characters absorbing a wide range of genuinely
different dark tones) - both are cases where a model's confidence and
its correctness diverge specifically in the hardest regions of an
image. Their HoG-features-don't-help and autoencoder-preprocessing-
hurts results are two more "tried it, no gain" findings, same spirit as
several of this project's own ruled-out attempts.

**Nothing here changed any code.** Their core comparison is classical
vs. deep ML *classifiers* for character selection - this codebase
doesn't use a trained classifier for that step at all, so importing
k-NN or Random Forest would mean adding a second ML dependency to the
core converter purely to reach parity with an approach (AISS-style
direct matching) already in use and already scoring better on their
own structural metric. The value here is confirmation, not a
prototype-worthy new idea.

## Phase 17: An AI-redrawn tiger produces the best result of the whole investigation - and reveals why

The user asked Gemini to redraw the tiger photo as a clean, monochromatic
line-art illustration - strictly black lines on white, no shading, no
gradients, no color, explicitly stylized (symmetric stripe patterns, a
"shaggy ruff" rendered as jagged contour lines) - then asked whether
asciify could do the same conversion itself, and whether feeding that
redrawn image back into the app would help.

**The two questions split cleanly.** Generating that image is a real
generative/artistic task - inventing plausible new linework, not
detecting edges already present in pixels - fundamentally different
from what `sobelGradient`/`nonMaxSuppress`/`hysteresisThreshold` do.
That's out of scope for this app's deterministic, dependency-light
architecture (more below). But converting an *already-drawn* clean
line-art image to ASCII is exactly the input "Trace outline first" was
built for, and testable immediately with zero code changes.

**First test, default settings, was a letdown.** At the shipped default
(100-character width), the Gemini image rendered about as busy and
unrecognizable as the real photo always had (3503 non-space characters,
barely different from the photo's 3595). The obvious hypothesis -
"clean art should have less noise" - looked wrong.

**The real variable turned out to be resolution, not noise.** Re-run at
200-character width, the *same* clean line-art image produced the
clearest, most legible tiger face this entire investigation has
produced - eyes, nose, muzzle outline, and individual stripe patterns
all genuinely readable, not just "more coherent than before." Run the
*real photo* through the identical 200-character-width test as a
controlled comparison, and it went the other way: the face disappeared
into scattered, disconnected marks, worse than at 100 characters.

That controlled pair (same image class, same width, opposite outcomes)
pins down the actual mechanism: it isn't about noise, it's about
**contrast uniformity**. Real fur boundaries are inherently low,
gradual-contrast edges - at finer grid resolution, each smaller cell
samples an even weaker gradient, so more cells fall below the edge
threshold and detection just fails. Bold hand-drawn ink lines stay
strong at any scale, so finer resolution just resolves more of the same
signal instead of losing it. This is a mechanistic explanation
confirmed by a controlled test, not a guess - and it means the
AI-redraw step helps not by "cleaning up" the photo but by converting
inherently low-contrast structure into inherently high-contrast
structure the existing pipeline already knows how to exploit at scale.

**Attempted to automate the redraw step locally, and hit a real hardware
wall rather than a software one.** The user runs Ollama locally and
asked whether it or DeepSeek's Janus-Pro could do this - both verified
and ruled out rather than assumed: Ollama's 2026 image-generation
feature is text-to-image only, no img2img; Janus-Pro is also
fundamentally text-to-image, and the "DeepSeek + Flux" workaround
people use goes through a text-description bottleneck that would lose
exact structural fidelity to the source photo (regenerating "a tiger,"
not preserving *this* tiger's specific features). The correct tool is
ComfyUI/Forge with a ControlNet lineart or canny preprocessor - genuine
structure-preserving img2img, run locally on the user's own GPU, free
and fully offline once set up, with the browser able to call a local
server directly (`http://localhost:PORT`) without this app needing any
backend of its own.

Setup ran into a real, well-corroborated hardware gap rather than a
fixable bug: the user's RX 6700 XT (RDNA2) is excluded from every
current official AMD acceleration path on Windows - native ROCm
(RDNA3+ only, per ComfyUI's own README), and the new WSL2 ROCDXG
solution (also RDNA3+/Ryzen AI only, confirmed directly against its
GitHub compatibility matrix) - leaving DirectML as the only path that
sees the GPU at all. DirectML got ComfyUI's own startup log to warn
outright that it "barely works... has not been updated in over 1 year
and might be removed soon," misreported the card's 12GB VRAM as 1GB,
and broke against current ComfyUI's dependencies twice (a `comfy_aimdo`
import ComfyUI's own requirements.txt was needed for but the wrapper
script never installed; then a genuine `comfy_kitchen` version
incompatible with DirectML's frozen PyTorch 2.4.1) before the user
reasonably called it - three independent sources (ComfyUI's README, the
ROCDXG compatibility matrix, and an older ROCm community thread on the
`amdgpu` WSL2 kernel module) all agreeing RDNA2 isn't supported was
enough to stop rather than keep patching around a real generational gap.

**Where this leaves things**: the research question is answered, fully
and concretely, independent of the automation outcome - a properly
prepared (bold, high-contrast, structure-preserving) input produces
dramatically better results through the exact pipeline already shipped,
with a real mechanistic explanation for why. Automating the redraw step
inside the app remains a real, understood, and separately-scoped future
option (ComfyUI + ControlNet, called from the browser to a local
server) - blocked on the user's current hardware generation, not on
anything in this codebase, and revisitable independent of any of it.

**Lesson**: verifying rather than assuming paid off twice in one
detour, in opposite directions - confirming Ollama/Janus-Pro genuinely
can't do img2img avoided building on a wrong assumption, while treating
"DirectML doesn't officially support your card" as worth investigating
anyway (rather than accepting the first "unsupported" verdict) found
that DirectML actually does see the GPU, just not well enough for
current software. Knowing precisely which layer failed - GPU detection
succeeded; production-grade compute for a fast-moving codebase like
current ComfyUI did not - is what made "stop here" a confident decision
instead of a shrug.

## Phase 18: Local generation abandoned for real, a BYOK Gemini API integration shipped instead

Phase 17 stopped at ComfyUI specifically - the user pushed further and
asked to try `stable-diffusion-webui-amdgpu-forge`, a different AMD-DirectML
fork, rather than accepting the ComfyUI wall as final. Worth recording
honestly: this *did* get further. After several real, ordinary packaging
issues (wrong Python version, `--use-directml` vs. the fork's actual
`--directml` flag, a `pkg_resources`/`bdist_wheel` build-isolation problem
installing CLIP, a wrong ControlNet model repo format - diffusers-style
`config.json`+`.safetensors` instead of the single-file format Forge's UI
actually reads), Forge ran end-to-end on the RX 6700 XT via DirectML and
produced real Stable Diffusion + ControlNet-lineart generations in
15-30 seconds, despite DirectML still misreporting VRAM (1024MB reported,
10.8GB+ actually used). So the hardware wall from Phase 17 was real for
ComfyUI's specific dependency stack, not for DirectML on this GPU in
general - a narrower conclusion than Phase 17 drew, corrected here rather
than left standing.

**But the generated line art itself was the wrong style.** The
ControlNet-lineart output was a busy crosshatch/engraving look - 15,128
non-space characters through the shipped pipeline, busier and less
legible than either the real photo or the Gemini-app image from Phase 17.
Compared side by side against a fresh Gemini-app redraw of the same
tiger (flat, sparse, uniform-weight contour lines, no crosshatching -
3,969 non-space characters, the cleanest result of the whole
investigation), the two are both genuinely "monochrome AI line art" by
category, but not interchangeable inputs for this pipeline: bold, flat,
low-line-count contours convert far better than dense hatching, which
just replaces photographic noise with a different kind of noise. This
matters for anyone revisiting local generation later - matching
Gemini's flat-outline style would need prompt/ControlNet-preprocessor
tuning (a lineart_realistic-style preprocessor and a low-density LoRA or
prompt bias, not just "add ControlNet"), not just getting a pipeline
running at all.

**At this point the user asked to abandon local generation entirely**
("this seems to be moving away from something cloning and easily
running this program") and pivot: use the Gemini API directly, with
each *user* supplying their own key so the redraw step costs the
project nothing and doesn't require a backend. That reframes the
question from "can we generate images" (answered, twice over, since
Phase 17) to "can a static, backend-less site call a paid cloud API
safely" - a real architecture question, tested rather than assumed:

- **CORS was the actual risk**, and it was resolved empirically, not
  guessed at. A standalone test page (`fetch()`, no SDK) called
  `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}`
  directly from the browser. The first attempt used the model name
  `gemini-2.0-flash-exp` and got HTTP 404 - which, critically, is a
  *server* response, not a thrown `fetch` `TypeError`, proving CORS
  didn't block the request at all; a real CORS block would never reach
  the point of getting an HTTP status back. (Google's newer `js-genai`
  SDK was tried first and *does* get CORS-blocked, because it adds an
  `Api-Revision` header that fails preflight - the plain REST call
  sidesteps that entirely, which is why this project calls the API
  directly rather than depending on the SDK.)
- **The model name was stale, not the architecture.** Querying the live
  `ListModels` endpoint directly (rather than trusting another
  secondhand search result) found current names as of testing:
  `gemini-2.5-flash-image` ("Nano Banana"), `gemini-3.1-flash-image`
  ("Nano Banana 2"), `gemini-3-pro-image`/`-preview` ("Nano Banana
  Pro"), `gemini-3.1-flash-lite-image`. Switching to
  `gemini-2.5-flash-image` got a real HTTP 200 with a genuine generated
  image back, end to end, no backend involved at any point.
- The user's own API-key test never touched this chat session - a
  self-contained local HTML page was built for them to open and paste
  their key into directly in their own browser, so the key was never
  pasted into, logged by, or transmitted through this conversation.

**The shipped feature** ("Redraw with AI" in `index.html`/`script.js`)
sends the loaded image at up to 1024px (downscaled client-side, matching
what testing validated) plus a fixed line-art prompt to
`gemini-2.5-flash-image`, and on success feeds the returned PNG through
the existing `loadFile()` - no separate image-loading path, no
duplicated thumb/auto-suggest/render logic. Explicit security decisions,
made because a pasted API key is real, if modest, exposure surface:

- The key is read fresh from the input element's value on every
  request and never assigned to a variable that outlives the click
  handler - no in-memory copy floating around to leak via a later bug.
- **Deliberately not persisted anywhere** - no `localStorage`, no
  `sessionStorage`, no cookie, no inclusion in the shareable settings
  permalink (`updateUrl()`/`restoreSettingsFromUrl()` were left
  untouched specifically so this can never happen by accident).
  Reloading the page clears the key completely. This trades convenience
  (re-pasting the key each session) for the strongest available
  guarantee against silent leakage, since a backend-less app has no
  server-side place to keep a secret safely anyway.
- Never passed to `console.log`/`console.error` - error paths report
  the HTTP status or a generic network-failure message, never the
  request URL (which embeds the key as a query parameter) or body.
- The input is `type="password"` with `autocomplete="off"`, and the app
  has no `<form>` element anywhere, which avoids inviting a browser
  password-manager save prompt for what isn't a login credential.
- The in-panel help text tells users to restrict their own key by HTTP
  referrer in Google AI Studio - the actual mitigation Google provides
  for a key that's going to sit in client-side JS, since no purely
  client-side app can fully hide a secret from its own user.
- Verified live in a real browser (Playwright), not just read as
  "looks right": confirmed the button's enabled/disabled state machine
  (needs both an image and a non-empty key), confirmed the key never
  appears in the URL after use, confirmed `localStorage`/`sessionStorage`
  stay empty after a full redraw-and-clear cycle, and confirmed no
  console message ever contains the key.

**Where this leaves things**: the zero-backend, zero-build-step
architecture this whole project is built around is preserved even for a
feature that needs a paid third-party API - the trick is that the user's
own key and the user's own browser do the paying and the calling, this
project's code is just the client. Local, free, fully-offline generation
(ComfyUI/Forge + ControlNet, tuned toward Gemini's flat-outline style
rather than the default crosshatch) remains a real, understood,
separately-scoped option for later - not blocked by hardware after all,
just by the extra tuning work needed to match the style that actually
converts well.

**Lesson**: Phase 17 called the ComfyUI wall a hardware gap; pushing
past that assumption (per this project's own stated engineering process
- verify, don't stop at the first plausible-sounding "unsupported")
found a working local path after all, just with the wrong output style.
Neither conclusion was wrong at the moment it was written, but the
second one was cheaper to reach *because* it built on the first
attempt's specific, logged failures instead of starting over. And the
CORS question - the one thing that could have killed the entire BYOK
approach - was answered by making one real request and reading the
actual response, not by reasoning about it from documentation alone.

**Addendum, after PR #31 merged**: the user's first real end-to-end run
against the actual API (real key, real tiger photo, real network) found
a genuine bug that every mocked test had missed - the status line got
stuck on "Redrawn - loading result…" forever, even though the image had
visibly finished loading and re-rendered (charCount populated, thumbnail
updated, auto-suggest re-run). Root cause: `loadFile()` decodes the blob
asynchronously via `image.onload`, and nothing told the AI-redraw code
when that finished - it just set an interim status string and never
followed up. Fixed by giving `loadFile()` an optional completion
callback (guarded by the same `imageGeneration` staleness check
`requestSubjectMask` already uses, in case a newer load starts before
this one's decode finishes), and tightened the existing test to assert
the exact final status string rather than a substring both the old buggy
message and the fixed one would have matched. The lesson isn't new but
it repeated anyway: eight passing mocked tests gave real confidence in
the request/response handling, none of them exercised the actual async
image-decode timing a live browser run immediately surfaced - "verify,
don't assume" applies to your own tests' coverage, not just the feature
under test.

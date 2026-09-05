// Browser-driven tests for the DOM/UI wiring in script.js and index.html -
// the layer tests/dither.test.js deliberately doesn't cover (see CLAUDE.md).
// Uses Playwright directly (not the @playwright/test runner) so everything
// still runs through the project's single `node --test` command.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".mjs": "text/javascript" };

const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFUlEQVQIHWP8z8Dwn4EIwDiqEF0oAJHiAf0DKtA0AAAAAElFTkSuQmCC";

let server;
let baseUrl;
let browser;
let testImagePath;
let testTextPath;
// A real photo (not the tiny synthetic fixture above) with both a detailed
// subject and a much flatter background - needed for adaptive-detail tests,
// since the tiny fixture doesn't have enough tonal range for the complexity
// map to meaningfully distinguish "busy" from "flat" regions within it.
const photoImagePath = path.join(ROOT, "test-assets", "soft portrait woman.png");

test.before(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const filePath = path.join(ROOT, pathname === "/" ? "/index.html" : pathname);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  testImagePath = path.join(os.tmpdir(), "asciify-ui-test-fixture.png");
  fs.writeFileSync(testImagePath, Buffer.from(TEST_PNG_BASE64, "base64"));
  testTextPath = path.join(os.tmpdir(), "asciify-ui-test-fixture.txt");
  fs.writeFileSync(testTextPath, "not an image");

  browser = await chromium.launch();
});

test.after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  fs.unlinkSync(testImagePath);
  fs.unlinkSync(testTextPath);
});

let page;
let pageErrors;

test.beforeEach(async () => {
  page = await browser.newPage();
  pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  // On-device subject detection (saliency.js) is a several-MB, ~2-4s-per-
  // image best-effort enhancement - loading and running it on every test's
  // upload would balloon the suite from seconds to minutes for no benefit,
  // since almost none of these tests are testing that feature. Blocking its
  // vendored runtime here doubles as a realistic "model unavailable"
  // scenario (the same graceful-degradation path a file:// or offline user
  // hits) that every other test now implicitly exercises. The one test that
  // actually needs the real model (below) uses its own unblocked page.
  await page.route(/\/vendor\//, (route) => route.abort());
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded" });
});

test.afterEach(async () => {
  assert.deepEqual(pageErrors, [], `page threw uncaught error(s): ${pageErrors.join("; ")}`);
  await page.close();
});

async function loadTestImage() {
  await page.setInputFiles("#filepicker", testImagePath);
  await page.waitForFunction(() => document.getElementById("charCount").textContent !== "0");
}

test("loads with the empty state visible and output hidden", async () => {
  assert.equal(await page.isVisible("#emptyState"), true);
  assert.equal(await page.isVisible("#output"), false);
});

test("a fresh load with no query string shows the fields correct for the default braille mode", async () => {
  // Regression test: restoreSettingsFromUrl() used to bail out entirely
  // when there was no query string, skipping the applyRenderModeVisibility()
  // call inside it - so a first-ever visit showed every mode's fields at
  // once (dither, threshold, character set, and palette all visible)
  // until the user switched modes and back.
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("ditherField")).display), "block");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("thresholdField")).display), "block");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("charsetField")).display), "none");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("paletteField")).display), "none");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("adaptiveDetailField")).display), "none");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("focusRegionField")).display), "none");
});

test("uploading a valid image renders output and hides the empty state", async () => {
  await loadTestImage();
  assert.equal(await page.isVisible("#output"), true);
  assert.equal(await page.isVisible("#emptyState"), false);
});

test("braille mode renders using only braille codepoints", async () => {
  // Explicitly selects braille mode rather than relying on it being the
  // default after upload - auto-suggest may apply a different mode based
  // on the image's own stats, so this only tests braille mode's own output.
  await loadTestImage();
  await page.selectOption("#renderMode", "braille");
  await page.waitForTimeout(100);
  const text = await page.evaluate(() => document.getElementById("output").innerText);
  const codepoints = [...text.replace(/\n/g, "")].map((c) => c.codePointAt(0));
  assert.ok(codepoints.every((cp) => cp >= 0x2800 && cp <= 0x28ff), "expected only braille codepoints");
});

test("uploading an image shows three non-empty suggestion previews with exactly one selected", async () => {
  await loadTestImage();
  assert.equal(await page.isVisible("#suggestField"), true);

  const [braillePreview, asciiPreview, edgesPreview] = await Promise.all([
    page.textContent("#suggestBraillePreview"),
    page.textContent("#suggestAsciiPreview"),
    page.textContent("#suggestEdgesPreview"),
  ]);
  assert.ok(braillePreview.length > 0);
  assert.ok(asciiPreview.length > 0);
  assert.ok(edgesPreview.length > 0);

  const selected = await page.evaluate(() =>
    ["suggestBraille", "suggestAscii", "suggestEdges"].filter((id) => document.getElementById(id).classList.contains("selected"))
  );
  assert.equal(selected.length, 1, "expected exactly one suggestion marked selected");
});

test("clicking a suggestion card applies that mode without needing a re-upload", async () => {
  await loadTestImage();
  const autoPickedMode = await page.inputValue("#renderMode");
  const otherMode = autoPickedMode === "ascii" ? "edges" : "ascii";
  const otherButtonId = `#suggest${otherMode[0].toUpperCase()}${otherMode.slice(1)}`;

  await page.click(otherButtonId);
  await page.waitForTimeout(100);

  assert.equal(await page.inputValue("#renderMode"), otherMode);
  assert.equal(await page.evaluate((id) => document.querySelector(id).classList.contains("selected"), otherButtonId), true);
  assert.notEqual(await page.textContent("#charCount"), "0");
});

test("auto-suggest does not override settings restored from a permalink on the first upload", async () => {
  // The whole point of a shared settings link is reproducing a specific
  // look - auto-suggest must not immediately clobber it the moment an
  // image is uploaded under that link.
  await page.goto(`${baseUrl}/index.html?mode=edges&threshold=200`, { waitUntil: "domcontentloaded" });
  await loadTestImage();
  assert.equal(await page.inputValue("#renderMode"), "edges");
  assert.equal(await page.inputValue("#threshold"), "200");
  // Auto-suggest is skipped entirely for this first load (not just its
  // effect on the live settings), so the suggestions UI stays hidden.
  assert.equal(await page.isVisible("#suggestField"), false);
});

test("Suppress background is off by default and never touches the network when left off", async () => {
  // This is the file://-equivalent default experience: without opting in,
  // the app should never even attempt to load the model, not just handle
  // it failing. Uses its own unblocked page specifically so a real request
  // would be observable - if this test saw one, the checkbox's default
  // wouldn't actually be doing anything.
  const freshPage = await browser.newPage();
  const vendorRequests = [];
  freshPage.on("request", (r) => { if (r.url().includes("/vendor/")) vendorRequests.push(r.url()); });
  await freshPage.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded" });

  assert.equal(await freshPage.isChecked("#suppressBackground"), false);
  await freshPage.setInputFiles("#filepicker", testImagePath);
  await freshPage.waitForFunction(() => document.getElementById("charCount").textContent !== "0");
  await freshPage.waitForTimeout(200);

  assert.deepEqual(vendorRequests, []);
  await freshPage.close();
});

test("Suppress background degrades gracefully when on-device subject detection is unavailable", async () => {
  // This test's page has vendor/ blocked by the shared beforeEach above -
  // the same failure mode as file://, offline, or a blocked CDN. Checking
  // the box must not crash or hang the output; it should say plainly that
  // detection is unavailable rather than leaving a "detecting..." status
  // stuck on forever.
  await loadTestImage();
  await page.check("#suppressBackground");
  await page.waitForFunction(
    () => document.getElementById("suppressBackgroundStatus").textContent !== "detecting subject…"
  );
  assert.match(await page.textContent("#suppressBackgroundStatus"), /unavailable/);
  assert.equal(await page.isVisible("#output"), true);
});

test("Suppress background suppresses the render once on-device subject detection finishes", async () => {
  // Unlike every other test in this file, this one needs the real model to
  // actually load and run, so it uses its own page rather than the shared
  // one the beforeEach above deliberately blocks vendor/ on. Model load +
  // inference measured at ~2-6s in JOURNEY.md - slow for a unit test, which
  // is exactly why only this one test pays that cost.
  const ortPage = await browser.newPage();
  const ortPageErrors = [];
  ortPage.on("pageerror", (err) => ortPageErrors.push(err.message));
  await ortPage.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded" });
  await ortPage.setInputFiles("#filepicker", testImagePath);
  await ortPage.waitForFunction(() => document.getElementById("charCount").textContent !== "0");

  const textBefore = await ortPage.evaluate(() => document.getElementById("output").innerText);

  await ortPage.check("#suppressBackground");
  await ortPage.waitForFunction(
    () => document.getElementById("suppressBackgroundStatus").textContent === "on-device AI, adds a few seconds",
    { timeout: 30000 }
  );
  assert.equal(
    await ortPage.textContent("#srStatus"),
    "Background suppressed using on-device subject detection."
  );

  const textAfter = await ortPage.evaluate(() => document.getElementById("output").innerText);
  assert.notEqual(textAfter, textBefore, "expected suppressing the background to change the rendered output");

  // Unchecking restores the original, un-suppressed render.
  await ortPage.uncheck("#suppressBackground");
  await ortPage.waitForTimeout(100);
  assert.equal(await ortPage.evaluate(() => document.getElementById("output").innerText), textBefore);

  assert.deepEqual(ortPageErrors, []);
  await ortPage.close();
});

test("unchecking Suppress background while detection is still in flight does not re-apply it once it resolves", async () => {
  // Regression test: the in-flight detectForegroundMask() promise used to
  // apply its mask unconditionally once it resolved, even if the user had
  // already unchecked the box in the meantime - silently turning
  // suppression back on against their explicit action.
  //
  // Uses a controllable mock instead of the real model so the race is
  // deterministic rather than dependent on real inference timing - which
  // turns out to be unreliable to race against directly: WASM init and
  // inference block the page's main thread for stretches, which stalls
  // Playwright's own commands too, so a fixed "wait 50ms then uncheck"
  // can't reliably land inside the real several-second window.
  await loadTestImage();
  const textBefore = await page.evaluate(() => document.getElementById("output").innerText);

  await page.evaluate(() => {
    window.__resolveMask = null;
    window.AsciifySaliency = {
      detectForegroundMask: () => new Promise((resolve) => { window.__resolveMask = resolve; }),
    };
  });

  await page.check("#suppressBackground");
  await page.waitForFunction(() => typeof window.__resolveMask === "function");
  await page.uncheck("#suppressBackground");

  // Resolve the request only now, after the checkbox has already been
  // unchecked - an all-background mask, so a wrongly-reapplied mask would
  // blank the entire render and be unmistakable against textBefore.
  await page.evaluate(() => window.__resolveMask(new Uint8Array(320 * 320)));
  await page.waitForTimeout(200);

  assert.equal(
    await page.evaluate(() => document.getElementById("output").innerText),
    textBefore,
    "expected the render to stay un-suppressed after unchecking, even once the in-flight request resolved"
  );
});

test("re-checking Suppress background while the original request is still in flight shows detecting status again", async () => {
  // Regression test: unchecking while a request is in flight resets the
  // status text to default (see the test above) but leaves that request
  // running - re-checking before it resolves correctly avoids starting a
  // redundant second request, but used to leave the status text stuck on
  // that default with no indication anything was happening, as if the
  // checkbox had silently done nothing, until the original request
  // eventually resolved on its own.
  await loadTestImage();

  await page.evaluate(() => {
    window.__resolveMask = null;
    window.AsciifySaliency = {
      detectForegroundMask: () => new Promise((resolve) => { window.__resolveMask = resolve; }),
    };
  });

  await page.check("#suppressBackground");
  await page.waitForFunction(() => typeof window.__resolveMask === "function");
  assert.equal(await page.textContent("#suppressBackgroundStatus"), "detecting subject…");

  await page.uncheck("#suppressBackground");
  assert.notEqual(await page.textContent("#suppressBackgroundStatus"), "detecting subject…");

  await page.check("#suppressBackground");
  assert.equal(
    await page.textContent("#suppressBackgroundStatus"),
    "detecting subject…",
    "expected re-checking to show detecting status again, riding on the still-in-flight original request"
  );

  // The original (only) in-flight request resolving now should still apply
  // normally - re-checking must not have started a second, orphaned request.
  const textBefore = await page.evaluate(() => document.getElementById("output").innerText);
  await page.evaluate(() => window.__resolveMask(new Uint8Array(320 * 320)));
  await page.waitForFunction(
    () => document.getElementById("suppressBackgroundStatus").textContent === "on-device AI, adds a few seconds"
  );
  assert.notEqual(await page.evaluate(() => document.getElementById("output").innerText), textBefore);
});

test("the Suppress background info icon toggles a tap/keyboard-accessible popover", async () => {
  // The native title attribute this icon also carries doesn't reliably show
  // on mobile tap and isn't keyboard-reachable, hence this separate popover
  // that script.js toggles explicitly.
  assert.equal(await page.isVisible("#suppressBackgroundInfoPopover"), false);
  assert.equal(await page.getAttribute("#suppressBackgroundInfoIcon", "aria-expanded"), "false");

  await page.click("#suppressBackgroundInfoIcon");
  assert.equal(await page.isVisible("#suppressBackgroundInfoPopover"), true);
  assert.equal(await page.getAttribute("#suppressBackgroundInfoIcon", "aria-expanded"), "true");
  assert.ok((await page.textContent("#suppressBackgroundInfoPopover")).length > 0);

  // Clicking elsewhere on the page closes it.
  await page.click("h1");
  assert.equal(await page.isVisible("#suppressBackgroundInfoPopover"), false);
  assert.equal(await page.getAttribute("#suppressBackgroundInfoIcon", "aria-expanded"), "false");

  // Keyboard: Enter while focused opens it too, for users without a pointer.
  await page.focus("#suppressBackgroundInfoIcon");
  await page.keyboard.press("Enter");
  assert.equal(await page.isVisible("#suppressBackgroundInfoPopover"), true);
});

test("switching to ASCII mode renders using only the palette's characters", async () => {
  await loadTestImage();
  await page.selectOption("#renderMode", "ascii");
  await page.waitForTimeout(200);
  const [text, palette] = await Promise.all([
    page.evaluate(() => document.getElementById("output").innerText),
    page.inputValue("#palette"),
  ]);
  const used = new Set(text.replace(/\n/g, ""));
  assert.ok([...used].every((c) => palette.includes(c)), "expected only palette characters in ASCII output");
});

test("Adaptive detail is offered in ASCII and edges mode, not braille", async () => {
  await loadTestImage();
  await page.selectOption("#renderMode", "braille");
  assert.equal(await page.isVisible("#adaptiveDetailField"), false);

  await page.selectOption("#renderMode", "ascii");
  assert.equal(await page.isVisible("#adaptiveDetailField"), true);
  assert.equal(await page.isVisible("#focusRegionField"), false);
  await page.check("#adaptiveDetail");
  assert.equal(await page.isVisible("#focusRegionField"), true);

  await page.selectOption("#renderMode", "edges");
  assert.equal(await page.isVisible("#adaptiveDetailField"), true);
  assert.equal(await page.isVisible("#focusRegionField"), true, "the checkbox state should carry over across modes");
});

test("Adaptive detail raises the effective edge threshold in busy areas, reducing edges-mode clutter", async () => {
  // The gating is the same complexity map ASCII's adaptive detail uses, but
  // inverted in effect: a busy edges-mode cell (fine texture, a cluster of
  // close parallel lines) gets a higher effective threshold so only the
  // strongest lines survive, rather than a richer character ramp.
  await page.setInputFiles("#filepicker", photoImagePath);
  await page.waitForFunction(() => document.getElementById("charCount").textContent !== "0");
  await page.selectOption("#renderMode", "edges");
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => document.getElementById("output").innerText);
  const countNonSpace = (text) => [...text].filter((c) => c !== " " && c !== "\n").length;

  await page.check("#adaptiveDetail");
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => document.getElementById("output").innerText);

  assert.notEqual(after, before, "expected adaptive detail to change the edges-mode render");
  assert.ok(
    countNonSpace(after) < countNonSpace(before),
    "expected adaptive detail to reduce, not increase, edge-character density"
  );
  const used = new Set(after.replace(/\n/g, ""));
  assert.ok([...used].every((c) => "-|/\\ ".includes(c)), "expected only edge characters or blanks");

  // Unchecking restores the original render.
  await page.uncheck("#adaptiveDetail");
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.getElementById("output").innerText), before);
});

test("Adaptive detail changes the ASCII render while keeping only palette characters", async () => {
  await page.setInputFiles("#filepicker", photoImagePath);
  await page.waitForFunction(() => document.getElementById("charCount").textContent !== "0");
  await page.selectOption("#renderMode", "ascii");
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => document.getElementById("output").innerText);

  await page.check("#adaptiveDetail");
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => document.getElementById("output").innerText);

  assert.notEqual(after, before, "expected adaptive detail to change the rendered output");
  const palette = await page.inputValue("#palette");
  const used = new Set(after.replace(/\n/g, ""));
  assert.ok([...used].every((c) => palette.includes(c)), "expected the reduced ramp to still be a subset of the palette");

  // Unchecking restores the original render.
  await page.uncheck("#adaptiveDetail");
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.getElementById("output").innerText), before);
});

test("Hand-drawn style is offered only in ASCII mode and is mutually exclusive with Adaptive detail", async () => {
  await loadTestImage();
  await page.selectOption("#renderMode", "braille");
  assert.equal(await page.isVisible("#handDrawnStyleField"), false);

  await page.selectOption("#renderMode", "edges");
  assert.equal(await page.isVisible("#handDrawnStyleField"), false);

  await page.selectOption("#renderMode", "ascii");
  assert.equal(await page.isVisible("#handDrawnStyleField"), true);
  assert.equal(await page.isVisible("#charsetField"), true);
  assert.equal(await page.isVisible("#paletteField"), true);

  await page.check("#adaptiveDetail");
  assert.equal(await page.isVisible("#handDrawnStyleField"), true, "Hand-drawn style stays reachable so it can still be turned on");
  await page.check("#handDrawnStyle");
  await page.waitForTimeout(100);
  assert.equal(await page.isChecked("#adaptiveDetail"), false, "expected checking Hand-drawn style to uncheck Adaptive detail");
  assert.equal(await page.isVisible("#charsetField"), false, "charset is meaningless once glyphs are chosen by shape-matching");
  assert.equal(await page.isVisible("#paletteField"), false);
  assert.equal(
    await page.isVisible("#adaptiveDetailField"),
    false,
    "Adaptive detail doesn't apply during Hand-drawn style, same as charset/palette"
  );
  assert.equal(await page.isVisible("#focusRegionField"), false);
  assert.equal(await page.isVisible("#handDrawnStyleField"), true, "its own checkbox stays visible/reachable to turn it back off");

  // The only way back is unchecking Hand-drawn style itself - Adaptive
  // detail's own checkbox is hidden while Hand-drawn style is active.
  await page.uncheck("#handDrawnStyle");
  await page.waitForTimeout(100);
  assert.equal(await page.isVisible("#charsetField"), true);
  assert.equal(await page.isVisible("#adaptiveDetailField"), true);
  assert.equal(await page.isChecked("#adaptiveDetail"), false, "Adaptive detail doesn't silently come back on its own");

  await page.check("#adaptiveDetail");
  await page.waitForTimeout(100);
  await page.check("#handDrawnStyle");
  await page.waitForTimeout(100);
  assert.equal(await page.isChecked("#adaptiveDetail"), false, "expected checking Hand-drawn style to uncheck Adaptive detail again");
});

test("Hand-drawn style renders ASCII output without erroring, using only its own charset", async () => {
  await page.setInputFiles("#filepicker", photoImagePath);
  await page.waitForFunction(() => document.getElementById("charCount").textContent !== "0");
  await page.selectOption("#renderMode", "ascii");
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => document.getElementById("output").innerText);

  await page.check("#handDrawnStyle");
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.getElementById("output").innerText);

  assert.notEqual(after, before, "expected Hand-drawn style to change the rendered output");
  assert.ok(after.replace(/\n/g, "").length > 0, "expected non-empty output");

  // Unchecking restores the standard ramp-based render.
  await page.uncheck("#handDrawnStyle");
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.getElementById("output").innerText), before);
});

test("Hand-drawn style round-trips through the settings permalink and resets to off", async () => {
  await page.goto(`${baseUrl}/index.html?mode=ascii&handdrawn=1`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.isChecked("#handDrawnStyle"), true);
  assert.equal(await page.isChecked("#adaptiveDetail"), false);
  assert.equal(await page.isVisible("#charsetField"), false);

  await loadTestImage();
  const url = new URL(page.url());
  assert.equal(url.searchParams.get("handdrawn"), "1");

  await page.click("#resetBtn");
  await page.waitForTimeout(100);
  assert.equal(await page.isChecked("#handDrawnStyle"), false);
  assert.equal(new URL(page.url()).searchParams.get("handdrawn"), null);
});

test("drawing and clearing a focus area updates status and the ASCII render", async () => {
  await page.setInputFiles("#filepicker", photoImagePath);
  await page.waitForFunction(() => document.getElementById("charCount").textContent !== "0");
  await page.selectOption("#renderMode", "ascii");
  await page.check("#adaptiveDetail");
  await page.waitForTimeout(150);
  const withoutRegion = await page.evaluate(() => document.getElementById("output").innerText);
  assert.equal(await page.textContent("#focusRegionStatus"), "optional - always full detail");

  await page.click("#drawFocusBtn");
  await page.locator("#focusCanvas").scrollIntoViewIfNeeded();
  const box = await page.locator("#focusCanvas").boundingBox();
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.9, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);

  assert.equal(await page.textContent("#focusRegionStatus"), "set - tap Clear to remove");
  const withRegion = await page.evaluate(() => document.getElementById("output").innerText);
  assert.notEqual(withRegion, withoutRegion, "expected drawing a focus region to change the render");

  await page.click("#clearFocusBtn");
  await page.waitForTimeout(150);
  assert.equal(await page.textContent("#focusRegionStatus"), "optional - always full detail");
  assert.equal(await page.evaluate(() => document.getElementById("output").innerText), withoutRegion);
});

test("drawing a focus area via touch events works the same as via mouse", async () => {
  // Regression coverage for touch support added alongside the mouse-based
  // drag handlers above - dispatches real TouchEvents rather than using
  // page.tap()/page.touchscreen, since those simulate hit-tested pointer
  // input and this page isn't loaded with a touch-capable browser context.
  await page.setInputFiles("#filepicker", photoImagePath);
  await page.waitForFunction(() => document.getElementById("charCount").textContent !== "0");
  await page.selectOption("#renderMode", "ascii");
  await page.check("#adaptiveDetail");
  await page.waitForTimeout(150);
  const withoutRegion = await page.evaluate(() => document.getElementById("output").innerText);

  await page.click("#drawFocusBtn");
  await page.locator("#focusCanvas").scrollIntoViewIfNeeded();
  const box = await page.locator("#focusCanvas").boundingBox();
  await page.evaluate(
    ({ x0, y0, x1, y1 }) => {
      const canvas = document.getElementById("focusCanvas");
      function fire(type, x, y) {
        const touch = new Touch({ identifier: 1, target: canvas, clientX: x, clientY: y });
        canvas.dispatchEvent(
          new TouchEvent(type, {
            touches: type === "touchend" ? [] : [touch],
            changedTouches: [touch],
            bubbles: true,
            cancelable: true,
          })
        );
      }
      fire("touchstart", x0, y0);
      fire("touchmove", x1, y1);
      fire("touchend", x1, y1);
    },
    { x0: box.x + box.width * 0.1, y0: box.y + box.height * 0.1, x1: box.x + box.width * 0.9, y1: box.y + box.height * 0.9 }
  );
  await page.waitForTimeout(150);

  assert.equal(await page.textContent("#focusRegionStatus"), "set - tap Clear to remove");
  const withRegion = await page.evaluate(() => document.getElementById("output").innerText);
  assert.notEqual(withRegion, withoutRegion, "expected a touch-drawn focus region to change the render");

  await page.click("#clearFocusBtn");
  await page.waitForTimeout(150);
  assert.equal(await page.textContent("#focusRegionStatus"), "optional - always full detail");
});

test("adaptive detail and a focus area round-trip through the settings permalink", async () => {
  await page.goto(`${baseUrl}/index.html?mode=ascii&adaptive=1&focus=0.100,0.200,0.800,0.900`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.isChecked("#adaptiveDetail"), true);
  assert.equal(await page.isVisible("#focusRegionField"), true);

  // The overlay (and its status text) only actually draws once there's an
  // image to draw it over - same as the suggestions field staying hidden
  // until upload.
  await loadTestImage();
  assert.equal(await page.textContent("#focusRegionStatus"), "set - tap Clear to remove");

  const url = new URL(page.url());
  assert.equal(url.searchParams.get("adaptive"), "1");
  assert.equal(url.searchParams.get("focus"), "0.100,0.200,0.800,0.900");
});

test("a malformed focus permalink parameter is ignored rather than crashing the page", async () => {
  await page.goto(`${baseUrl}/index.html?mode=ascii&adaptive=1&focus=not,valid,coords`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.isChecked("#adaptiveDetail"), true);
  assert.equal(await page.textContent("#focusRegionStatus"), "optional - always full detail");
});

test("switching to edges mode renders using only line-drawing characters or blanks", async () => {
  await loadTestImage();
  await page.selectOption("#renderMode", "edges");
  await page.waitForTimeout(200);
  const text = await page.evaluate(() => document.getElementById("output").innerText);
  const used = new Set(text.replace(/\n/g, ""));
  assert.ok([...used].every((c) => "-|/\\ ".includes(c)), "expected only edge characters or spaces");
});

test("pasting an image loads it the same as the file picker", async () => {
  const base64 = TEST_PNG_BASE64;
  const prevented = await page.evaluate(async (b64) => {
    const res = await fetch("data:image/png;base64," + b64);
    const blob = await res.blob();
    const file = new File([blob], "pasted.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, base64);
  assert.equal(prevented, true);
  await page.waitForFunction(() => document.getElementById("charCount").textContent !== "0");
});

test("dropping an image loads it the same as the file picker", async () => {
  const buffer = fs.readFileSync(testImagePath);
  const base64 = buffer.toString("base64");
  await page.evaluate(async (b64) => {
    const res = await fetch("data:image/png;base64," + b64);
    const blob = await res.blob();
    const file = new File([blob], "dropped.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const dropzone = document.getElementById("dropzone");
    dropzone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, base64);
  await page.waitForFunction(() => document.getElementById("charCount").textContent !== "0");
});

test("the panel does not overflow a narrow viewport once suggestions are shown", async () => {
  // Regression test: .panel (a CSS grid item) and its flex-row suggestion
  // previews (non-wrapping <pre> elements) both defaulted to min-width:auto,
  // so their content's intrinsic width silently widened the whole page past
  // the viewport on narrow/mobile screens - not visible on desktop, and only
  // caught by actually measuring layout at a mobile width, exactly the kind
  // of check CLAUDE.md's working process calls for beyond "the code compiles".
  const narrowPage = await browser.newPage({ viewport: { width: 412, height: 900 } });
  await narrowPage.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded" });
  await narrowPage.setInputFiles("#filepicker", testImagePath);
  await narrowPage.waitForFunction(() => document.getElementById("charCount").textContent !== "0");
  await narrowPage.waitForTimeout(100);

  const overflowed = await narrowPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflowed, false, "expected no horizontal overflow at a narrow viewport width");
  await narrowPage.close();
});

test("uploading a non-image file shows a load error instead of silently doing nothing", async () => {
  await page.setInputFiles("#filepicker", testTextPath);
  await page.waitForFunction(() => getComputedStyle(document.getElementById("loadError")).display !== "none");
  const [errorText, statusText, thumbVisible] = await Promise.all([
    page.textContent("#loadError"),
    page.textContent("#srStatus"),
    page.isVisible("#thumb"),
  ]);
  assert.ok(errorText.length > 0);
  assert.equal(statusText, errorText, "the live region should announce the same error to screen readers");
  assert.equal(thumbVisible, false);
});

test("a subsequent valid upload clears a previous load error", async () => {
  await page.setInputFiles("#filepicker", testTextPath);
  await page.waitForFunction(() => getComputedStyle(document.getElementById("loadError")).display !== "none");
  await loadTestImage();
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("loadError")).display), "none");
});

test("the rendered output is hidden from screen readers, with a live-region status instead", async () => {
  await loadTestImage();
  const [ariaHidden, statusRole, statusLive, statusText] = await Promise.all([
    page.getAttribute("#output", "aria-hidden"),
    page.getAttribute("#srStatus", "role"),
    page.getAttribute("#srStatus", "aria-live"),
    page.textContent("#srStatus"),
  ]);
  assert.equal(ariaHidden, "true");
  assert.equal(statusRole, "status");
  assert.equal(statusLive, "polite");
  assert.match(statusText, /Rendered .* characters/);
});

test("the clear button resets image and output state", async () => {
  await loadTestImage();
  await page.click("#clearBtn");
  const [thumbVisible, outputVisible, emptyVisible, charCount] = await Promise.all([
    page.isVisible("#thumb"),
    page.isVisible("#output"),
    page.isVisible("#emptyState"),
    page.textContent("#charCount"),
  ]);
  assert.equal(thumbVisible, false);
  assert.equal(outputVisible, false);
  assert.equal(emptyVisible, true);
  assert.equal(charCount, "0");
});

test("the reset button restores default settings but keeps the loaded image", async () => {
  await loadTestImage();

  // Tweak a spread of settings across every control type: sliders, selects,
  // a checkbox, and the palette textarea. Threshold is only visible in
  // braille/edges mode (not ASCII), so it's set before switching modes.
  await page.fill("#threshold", "200");
  await page.dispatchEvent("#threshold", "change");
  await page.selectOption("#renderMode", "ascii");
  await page.waitForTimeout(100);
  await page.selectOption("#charset", "detailed");
  await page.fill("#brightness", "40");
  await page.dispatchEvent("#brightness", "change");
  await page.check("#invert");
  await page.waitForTimeout(100);

  await page.click("#resetBtn");
  await page.waitForTimeout(100);

  const [renderMode, charset, palette, brightness, threshold, invert, thumbVisible, charCount] = await Promise.all([
    page.inputValue("#renderMode"),
    page.inputValue("#charset"),
    page.inputValue("#palette"),
    page.inputValue("#brightness"),
    page.inputValue("#threshold"),
    page.isChecked("#invert"),
    page.isVisible("#thumb"),
    page.textContent("#charCount"),
  ]);
  assert.equal(renderMode, "braille");
  assert.equal(charset, "standard");
  assert.equal(palette, "@%#*+=-:. ");
  assert.equal(brightness, "0");
  assert.equal(threshold, "127");
  assert.equal(invert, false);
  // The image itself must survive a reset - only the adjustments clear.
  assert.equal(thumbVisible, true);
  assert.notEqual(charCount, "0");
  assert.equal(await page.evaluate(() => location.search), "");
});

test("exports work with mode-correct filenames, and the SVG export is well-formed XML", async () => {
  await loadTestImage();
  await page.selectOption("#renderMode", "ascii");
  await page.waitForTimeout(200);

  const [txtDownload] = await Promise.all([page.waitForEvent("download"), page.click("#downloadBtn")]);
  assert.equal(txtDownload.suggestedFilename(), "ascii-art.txt");

  const [pngDownload] = await Promise.all([page.waitForEvent("download"), page.click("#downloadPngBtn")]);
  assert.equal(pngDownload.suggestedFilename(), "ascii-art.png");

  const [svgDownload] = await Promise.all([page.waitForEvent("download"), page.click("#downloadSvgBtn")]);
  assert.equal(svgDownload.suggestedFilename(), "ascii-art.svg");
  const svgPath = await svgDownload.path();
  const svgText = fs.readFileSync(svgPath, "utf8");
  const isValidXml = await page.evaluate(
    (text) => !new DOMParser().parseFromString(text, "image/svg+xml").querySelector("parsererror"),
    svgText
  );
  assert.equal(isValidXml, true, "expected the exported SVG to parse as well-formed XML");
});

test("the PNG export matches the on-screen character-cell aspect ratio", async () => {
  // Regression test: the PNG export used to size/lay out text using the
  // canvas font's own (font- and platform-dependent) glyph advance width,
  // which didn't match the fixed 0.5-wide/1-tall cell the on-screen CSS
  // enforces (#output span { width: 0.5em }) - so exports came out visibly
  // horizontally stretched relative to the live preview. The exported
  // per-character aspect ratio must match the CSS's 0.5 exactly.
  await loadTestImage();
  await page.waitForTimeout(100);

  const gridInfo = await page.textContent("#gridInfo");
  const [cols, rows] = gridInfo.match(/\d+/g).map(Number);

  const [pngDownload] = await Promise.all([page.waitForEvent("download"), page.click("#downloadPngBtn")]);
  const buf = fs.readFileSync(await pngDownload.path());
  const pngWidth = buf.readUInt32BE(16); // PNG IHDR chunk: width at bytes 16-19
  const pngHeight = buf.readUInt32BE(20); // height at bytes 20-23 (big-endian)

  // Back out padding (fixed at exportFontSize=16px per side) before
  // comparing, since it's the per-cell ratio that must match, not the
  // total image dimensions.
  const padding = 16;
  const cellAspect = (pngWidth - padding * 2) / cols / ((pngHeight - padding * 2) / rows);
  assert.ok(Math.abs(cellAspect - 0.5) < 0.02, `expected per-cell aspect ~0.5, got ${cellAspect}`);
});

test("changing settings updates the URL, and resetting to defaults clears it", async () => {
  assert.equal(await page.evaluate(() => location.search), "");

  await page.selectOption("#renderMode", "ascii");
  await page.waitForTimeout(100);
  const search1 = await page.evaluate(() => location.search);
  assert.match(search1, /mode=ascii/);

  await page.selectOption("#renderMode", "braille");
  await page.waitForTimeout(100);
  const search2 = await page.evaluate(() => location.search);
  assert.doesNotMatch(search2, /mode=/);
});

test("settings restore correctly from a URL query string on load", async () => {
  const url =
    `${baseUrl}/index.html?mode=edges&threshold=200&width=77` +
    `&brightness=-30&black=10&white=240&invert=1`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const [mode, threshold, width, brightness, black, white, invert] = await Promise.all([
    page.inputValue("#renderMode"),
    page.inputValue("#threshold"),
    page.inputValue("#width"),
    page.inputValue("#brightness"),
    page.inputValue("#blackPoint"),
    page.inputValue("#whitePoint"),
    page.isChecked("#invert"),
  ]);
  assert.equal(mode, "edges");
  assert.equal(threshold, "200");
  assert.equal(width, "77");
  assert.equal(brightness, "-30");
  assert.equal(black, "10");
  assert.equal(white, "240");
  assert.equal(invert, true);

  // Field visibility should match edges mode, same as if the user had
  // selected it by hand.
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("ditherField")).display), "none");
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById("thresholdField")).display), "none");
});

test("a malformed query string does not crash the page and falls back to defaults", async () => {
  await page.goto(`${baseUrl}/index.html?mode=bogus&threshold=abc&width=-5`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.inputValue("#renderMode"), "braille");
  await loadTestImage(); // proves the page is still fully functional
});

test("an absurdly large width/height is rejected rather than crashing the renderer", async () => {
  // Regression test: canvas dimensions beyond the browser's own limits throw
  // (ImageData allocation failure) instead of failing gracefully; a shared
  // permalink with an extreme value must not be able to trigger that.
  await page.goto(`${baseUrl}/index.html?lock=0&height=999999999999`, { waitUntil: "domcontentloaded" });
  await loadTestImage();
  const charCount = await page.textContent("#charCount");
  assert.notEqual(charCount, "0");
});

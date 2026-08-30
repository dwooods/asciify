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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFUlEQVQIHWP8z8Dwn4EIwDiqEF0oAJHiAf0DKtA0AAAAAElFTkSuQmCC";

let server;
let baseUrl;
let browser;
let testImagePath;
let testTextPath;

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

test("uploading a valid image renders braille output by default", async () => {
  await loadTestImage();
  assert.equal(await page.isVisible("#output"), true);
  assert.equal(await page.isVisible("#emptyState"), false);
  const text = await page.evaluate(() => document.getElementById("output").innerText);
  const codepoints = [...text.replace(/\n/g, "")].map((c) => c.codePointAt(0));
  assert.ok(codepoints.every((cp) => cp >= 0x2800 && cp <= 0x28ff), "expected only braille codepoints");
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

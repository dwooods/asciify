// Service worker for the installable-PWA enhancement. Purely a progressive
// enhancement (see CLAUDE.md "Future direction"): registration is optional
// and best-effort from script.js, so nothing here is load-bearing for the
// core converter, which must keep working with no service worker at all
// (file://, an old browser, or registration simply failing).
const CACHE_NAME = "asciify-shell-v1";

const SHELL_PATHS = [
  "./",
  "./index.html",
  "./style.css",
  "./dither.js",
  "./script.js",
  "./saliency.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon.png",
];
const SHELL_URLS = new Set(SHELL_PATHS.map((p) => new URL(p, self.location).href));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_PATHS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Only the small precached app shell is ever handled here. Everything
  // else - vendor/ (the ~18MB on-device model), the Gemini API call, and
  // anything cross-origin - is left completely untouched (no respondWith),
  // so it behaves exactly as if this service worker didn't exist. That's
  // deliberate: vendor/ must never pass through this worker's own fetch()
  // (the test suite blocks those requests at the page level for speed,
  // which can't reliably reach a fetch a service worker issues itself), and
  // the Gemini API call must never be seen, cached, or logged here, per
  // CLAUDE.md's API-key handling rules.
  if (event.request.method !== "GET" || !SHELL_URLS.has(event.request.url)) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

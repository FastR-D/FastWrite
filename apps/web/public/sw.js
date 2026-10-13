const BASE = new URL("./", self.location.href);
const CACHE = `fastwrite-shell-v3:${BASE.pathname}`;
const INDEX = new URL("index.html", BASE).href;
const API_PATH = new URL("api/", BASE).pathname;
const SHELL = [INDEX, new URL("manifest.webmanifest", BASE).href];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE && (/^fastwrite-shell-v\d+$/.test(key) || (key.startsWith("fastwrite-shell-") && key.endsWith(`:${BASE.pathname}`)))).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith(BASE.pathname) || url.pathname.startsWith(API_PATH) || request.headers.has("Authorization")) return;
  const immutable = /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(url.pathname.slice(BASE.pathname.length));
  const fetchAndCache = async () => {
    const response = await fetch(request);
    if (response.ok && response.type !== "opaque") {
      const copy = response.clone();
      const key = request.mode === "navigate" ? INDEX : request;
      await caches.open(CACHE).then((cache) => cache.put(key, copy)).catch(() => undefined);
    }
    return response;
  };
  event.respondWith((async () => {
    const cached = await caches.match(request).catch(() => undefined);
    if (immutable && cached) return cached;
    try { return await fetchAndCache(); }
    catch {
      // Only document navigations receive the offline HTML shell. Returning
      // HTML for a failed JS/CSS fetch hides its failure and breaks recovery.
      return cached || (request.mode === "navigate" ? await caches.match(INDEX).catch(() => undefined) : undefined) || Response.error();
    }
  })());
});

const CACHE = "fastwrite-shell-v2";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/busytex.js", "/busytex.wasm", "/worker.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (!response.ok || response.type === "opaque") return response;
    const copy = response.clone();
    void caches.open(CACHE).then((cache) => cache.put(request, copy));
    return response;
  }).catch(() => caches.match("/index.html")));
});

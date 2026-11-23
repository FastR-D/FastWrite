const CACHE = "fastwrite-shell-v4";
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
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => {
      if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
        const copy = response.clone();
        void caches.open(CACHE).then(cache => cache.put("/index.html", copy));
      }
      return response;
    }).catch(async () => await caches.match("/index.html") ?? Response.error()));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (!response.ok || response.type === "opaque") return response;
    const copy = response.clone();
    void caches.open(CACHE).then((cache) => cache.put(request, copy));
    return response;
  })));
});

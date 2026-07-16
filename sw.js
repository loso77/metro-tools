const CACHE_NAME = "metro-tools-v1";
const APP_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./train-query/",
  "./train-query/index.html",
  "./train-query/manifest.json",
  "./train-query/sw.js",
  "./trainsheet-ai/",
  "./trainsheet-ai/index.html",
  "./trainsheet-ai/style.css",
  "./trainsheet-ai/app.js",
  "./trainsheet-ai/manifest.json",
  "./trainsheet-ai/sw.js",
  "./trainsheet-ai/template.xlsx",
  "./group-query/",
  "./group-query/index.html",
  "./group-query/manifest.webmanifest",
  "./group-query/icon.svg",
  "./group-query/sw.js"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith("metro-tools-") && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.endsWith("/sw.js")) return;

  event.respondWith(
    caches.match(event.request, {ignoreSearch: true}).then(cached => {
      const networkUpdate = fetch(event.request)
        .then(response => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      if (cached) {
        event.waitUntil(networkUpdate);
        return cached;
      }
      return networkUpdate;
    })
  );
});

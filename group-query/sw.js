const CACHE_NAME = "train-group-query-v1";
const APP_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg"
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
      .then(keys => Promise.all(keys.filter(key => key.startsWith("train-group-query-") && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      caches.match("./index.html").then(cached => {
        const networkUpdate = fetch(event.request)
          .then(response => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put("./index.html", copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || networkUpdate;
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkUpdate = fetch(event.request)
        .then(response => {
          if (response.ok) {
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

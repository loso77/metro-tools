const CACHE = 'pr2607-network-fallback-v1';
const APP_SHELL = ['./index.html', './manifest.json'];
const NETWORK_TIMEOUT_MS = 1500;
const INDEX_URL = new URL('./index.html', self.registration.scope).href;

function timeout(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('network timeout')), ms);
  });
}

async function fetchAndCache(request) {
  const response = await fetch(request);
  if (response && response.ok && response.type === 'basic') {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, event) {
  const networkRequest = fetchAndCache(request);
  event.waitUntil(networkRequest.then(() => undefined).catch(() => undefined));

  try {
    return await Promise.race([networkRequest, timeout(NETWORK_TIMEOUT_MS)]);
  } catch (_) {
    const cachedPage = await caches.match(request, { ignoreSearch: true }) ||
                       await caches.match(INDEX_URL, { ignoreSearch: true });
    if (cachedPage) return cachedPage;
    return networkRequest;
  }
}

async function staleWhileRevalidate(request, event) {
  const cached = await caches.match(request, { ignoreSearch: true });
  const networkRequest = fetchAndCache(request);
  event.waitUntil(networkRequest.then(() => undefined).catch(() => undefined));
  return cached || networkRequest;
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith('pr2607-') && key !== CACHE)
            .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.endsWith('/sw.js')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, event));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, event));
});

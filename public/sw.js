// Simple service worker for FX Tactical Analyzer
// Caches an offline fallback page only. Network-first for navigations.
const CACHE_NAME = "fx-tactical-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
    })()
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle navigation requests; let everything else hit the network.
  if (req.mode !== "navigate") return;

  event.respondWith(
    (async () => {
      try {
        return await fetch(req);
      } catch (e) {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(OFFLINE_URL);
        return (
          cached ||
          new Response("Offline", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          })
        );
      }
    })()
  );
});

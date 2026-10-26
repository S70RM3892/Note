/* Sumi Note service worker: offline precache + Web Share Target inbox. */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = 'sumi-' + VERSION;
const SHARE_CACHE = 'sumi-share-inbox';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('sumi-') && k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

async function handleShare(request) {
  const form = await request.formData();
  const cache = await caches.open(SHARE_CACHE);
  let i = 0;
  for (const f of form.getAll('files')) {
    if (typeof f === 'string') continue;
    await cache.put(
      new Request(new URL(`./__share/${Date.now()}-${i++}`, self.registration.scope).href),
      new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(f.name || 'shared') } }),
    );
  }
  return Response.redirect(new URL('./#/share', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (req.mode === 'navigate') {
        const shell = (await cache.match('./index.html', { ignoreVary: true })) || (await cache.match('./', { ignoreVary: true }));
        if (shell) return shell;
        return fetch(req);
      }
      const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch {
        return new Response('offline', { status: 503, statusText: 'offline' });
      }
    })(),
  );
});

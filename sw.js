const CACHE = 'htvl-v21';
const BASE = '/hatangvinhlinh';
const ASSETS = [
  `${BASE}/`,
  `${BASE}/index.html`,
  `${BASE}/index.html?v=21`,
  `${BASE}/css/app.css`,
  `${BASE}/css/app.css?v=21`,
  `${BASE}/js/app.js`,
  `${BASE}/js/app.js?v=21`,
  `${BASE}/js/config.js`,
  `${BASE}/js/config.js?v=21`,
  `${BASE}/js/forecast.js`,
  `${BASE}/js/forecast.js?v=21`,
  `${BASE}/js/stats.js`,
  `${BASE}/js/stats.js?v=21`,
  `${BASE}/manifest.webmanifest`,
  `${BASE}/icons/icon-192.png`,
  `${BASE}/icons/icon-512.png`,
];

self.addEventListener('install', (event) => {
  // Không skipWaiting tự động — giữ banner đến khi người dùng nhấn Cập nhật
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isAppShell(url) {
  if (url.origin !== self.location.origin) return false;
  if (!url.pathname.startsWith(BASE)) return false;
  const path = url.pathname;
  return (
    path === `${BASE}/` ||
    path.endsWith('.html') ||
    path.endsWith('.js') ||
    path.endsWith('.css') ||
    path.endsWith('.webmanifest')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('google.com')
  ) {
    return;
  }

  // HTML/JS/CSS: network-first, bypass HTTP cache (Chrome Android PWA hay giữ bản cũ)
  if (req.mode === 'navigate' || isAppShell(url)) {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches
            .match(req)
            .then((c) => c || caches.match(`${BASE}/index.html`) || caches.match(`${BASE}/index.html?v=21`))
        )
    );
    return;
  }

  // Icons / other static: cache-first
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});

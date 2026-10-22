/*
 * EDGE service worker: makes the app load offline.
 *  - Your own files: network first (so updates show up right away, and every file in a
 *    release stays in sync), falling back to the saved copy after 3 seconds or when offline.
 *  - Fonts and icons never change: saved copy first.
 *  - Anything on another domain (the crew server) is left completely alone.
 * Bump VERSION when you ship a release.
 */
const VERSION = 'edge-v1.2.0';
const NETWORK_TIMEOUT_MS = 3000;
const PRECACHE = [
  './', 'index.html', 'styles.css', 'config.js', 'engine.js', 'crew.js', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/favicon-32.png',
  'fonts/inter-latin-400-normal.woff2', 'fonts/inter-latin-700-normal.woff2', 'fonts/inter-latin-900-normal.woff2',
  'fonts/space-mono-latin-400-normal.woff2', 'fonts/space-mono-latin-700-normal.woff2',
  'fonts/comic-neue-latin-700-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('edge-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch the crew server
  event.respondWith(respond(req, url));
});

async function respond(req, url) {
  const cache = await caches.open(VERSION);
  // every page load (?debug, #crew=…, index.html) shares one saved copy of the app
  const key = req.mode === 'navigate' ? new Request(self.registration.scope) : req;
  const isStatic = /\/(fonts|icons)\//.test(url.pathname);

  if (isStatic) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }

  try {
    const res = await fetchWithTimeout(req, isStatic ? 10000 : NETWORK_TIMEOUT_MS);
    if (res && res.ok && !res.redirected) cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const home = await cache.match(new Request(self.registration.scope));
      if (home) return home;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

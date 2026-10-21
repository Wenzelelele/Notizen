// Offline-Fähigkeit: App-Dateien kommen aus dem Cache und werden im Hintergrund aktualisiert
// (beim nächsten Öffnen ist dann die neue Version da). Notizen selbst liegen ohnehin im Gerät.
const CACHE = 'notizen-v1792589484900';
const SHELL = [
  './', 'index.html', 'manifest.json', 'icon.svg', 'icon-180.png', 'icon-512.png', 'css/style.css',
  'js/main.js', 'js/library.js', 'js/editor.js', 'js/ink.js', 'js/ui.js', 'js/store.js',
  'js/pdfio.js', 'js/onenote.js', 'js/sync.js', 'js/cloud.js', 'js/config.js', 'js/srs.js', 'js/cards.js', 'js/review.js', 'js/occlusion.js', 'js/version.js', 'js/split.js', 'js/claude.js', 'js/inbox.js', 'js/storage.js', 'js/pagenav.js',
];
// GitHub Pages erlaubt dem Browser, Dateien 10 Minuten zwischenzuspeichern (max-age=600). Ohne Rückfrage beim
// Server landen nach einem Update sonst alte Dateien im neuen Cache. Unveränderte Dateien kommen als kurzes 304.
const fresh = { cache: 'no-cache' };

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, fresh)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === location.origin;
  if (!own && url.hostname !== 'cdnjs.cloudflare.com') return; // Cloud-Speicher usw. immer übers Netz
  if (own && /\/(api|import)\//.test(url.pathname)) return;
  // Seite selbst: online immer frisch (damit Updates sofort ankommen), offline aus dem Cache
  if (req.mode === 'navigate') {
    e.respondWith(caches.open(CACHE).then(async cache => {
      try {
        const r = await fetch(req, fresh);
        if (r.ok) cache.put('./', r.clone());
        return r;
      } catch {
        return (await cache.match('./')) || (await cache.match('index.html'));
      }
    }));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: own });
    const net = fetch(req, own ? fresh : undefined).then(r => { if (r.ok) cache.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

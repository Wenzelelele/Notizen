// Offline-Fähigkeit: App-Dateien kommen aus dem Cache. Jede veröffentlichte Version hat ihren eigenen Cache
// (build-web.js setzt den Namen): Der neue Service Worker füllt ihn komplett, erst dann löst er den alten ab –
// alte und neue Dateien werden so nie gemischt. Notizen selbst liegen ohnehin im Gerät.
const CACHE = 'notizen-v1795708200109';
const SHELL = [
  './', 'index.html', 'manifest.json', 'icon.svg', 'icon-180.png', 'icon-512.png', 'css/style.css',
  'js/main.js', 'js/library.js', 'js/editor.js', 'js/ink.js', 'js/ui.js', 'js/store.js',
  'js/pdfio.js', 'js/onenote.js', 'js/sync.js', 'js/cloud.js', 'js/config.js', 'js/srs.js', 'js/cards.js', 'js/review.js', 'js/occlusion.js', 'js/version.js', 'js/split.js', 'js/claude.js', 'js/inbox.js', 'js/storage.js', 'js/pagenav.js', 'js/merge.js', 'js/covers.js', 'js/calc.js', 'js/calcui.js', 'js/find.js', 'js/findui.js',
];
// PDF-Bibliotheken (pdfio.js): Seit PDFs als Original abgeglichen werden, zeichnet jedes Gerät die Seitenbilder
// selbst – das muss auch ohne Internet gehen. Feste Versionen, ändern sich nie.
const LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
];
// GitHub Pages erlaubt dem Browser, Dateien 10 Minuten zwischenzuspeichern (max-age=600). Ohne Rückfrage beim
// Server landen nach einem Update sonst alte Dateien im neuen Cache. Unveränderte Dateien kommen als kurzes 304.
const fresh = { cache: 'no-cache' };

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(SHELL.map(u => new Request(u, fresh)));
    // Bibliotheken aus dem vorigen Cache übernehmen, sonst laden. Klappt das nicht (offline), holt sie der erste Gebrauch.
    await Promise.all(LIBS.map(async u => {
      try {
        const r = (await caches.match(u)) || (await fetch(u, { mode: 'cors' }));
        if (r.ok) await c.put(u, r);
      } catch { /* später */ }
    }));
  }).then(() => self.skipWaiting()));
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
  // Alles andere: aus dem Cache dieser Version. Nur was dort fehlt, kommt aus dem Netz (und wird aufgehoben).
  // Kein Auffrischen im Hintergrund – sonst lägen nach einem halb durchgelaufenen Update alte und neue Module
  // nebeneinander im Cache, und die App startete im schlimmsten Fall nicht mehr.
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: own });
    if (hit) return hit;
    const r = await fetch(req, own ? fresh : undefined);
    if (r.ok) cache.put(req, r.clone());
    return r;
  }));
});

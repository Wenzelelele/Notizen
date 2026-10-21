// Import der am PC konvertierten OneNote-Notizbücher (onenote-export.bat → Ordner import/, über den lokalen Server).
import { store, newNotebook } from './store.js';
import { drawBackground, drawImages, drawInk, drawText } from './ink.js';
import { loadImage } from './pdfio.js';

// Online-Version (https): den Export direkt vom PC-Server holen – klappt nur am PC selbst, während der Server läuft
const IMPORT_BASE = location.protocol === 'https:' ? 'http://localhost:5173/import/' : 'import/';
const url = path => IMPORT_BASE + path.split('/').map(encodeURIComponent).join('/');

// Feste IDs aus der OneNote-Seiten-ID: importieren zwei Geräte dieselbe Seite, entstehen dieselben
// Datensätze – der Sync führt sie zusammen statt sie zu verdoppeln.
export function hid(s) {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 2246822519);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

async function fetchOk(u) {
  const r = await fetch(u, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Datei fehlt (${r.status})`);
  return r;
}

// null = kein Export auf dem PC gefunden
export async function loadIndex() {
  let r;
  try { r = await fetch(IMPORT_BASE + 'index.json', { cache: 'no-store' }); } catch { return null; }
  if (!r.ok) return null;
  const idx = await r.json();
  if (idx.app !== 'notizen-onenote' || !(idx.version >= 3)) throw new Error('Veralteter Export – der OneNote-Export am PC muss nochmal laufen.');
  return idx;
}

// Eine OneNote-Seite wird eine eigene Notiz (mit einer – ggf. sehr großen – Seite).
// Titel und Datum kommen aus OneNote; source merkt sich die OneNote-Seite, damit sie nicht doppelt importiert wird.
export async function importPage(pg, { folderId, order }) {
  const pj = await (await fetchOk(url(pg.file))).json();
  let title = (pg.title || '').replace(/\s+/g, ' ').trim();
  if (!title || /^(untitled page|unbenannte seite)$/i.test(title)) title = 'Ohne Titel'; // OneNote liefert für leere Titel "Untitled page"
  const base = hid(pg.id);
  const nb = Object.assign(newNotebook({ title, folderId, template: 'blank' }), { id: 'on' + base, kind: 'onenote', source: 'onenote-page:' + pg.id, order });
  nb.updatedAt = Date.parse(pg.modified) || Date.now();
  nb.createdAt = Date.parse(pg.created) || nb.updatedAt;
  const page = {
    id: 'op' + base, notebookId: nb.id, w: pj.w, h: pj.h, template: pj.template || 'blank', paper: 'white', bg: null,
    strokes: pj.strokes.map((s, i) => ({ ...s, id: 'k' + i })),
    texts: pj.texts.map((t, i) => ({ ...t, id: 'x' + i })),
    images: [],
  };
  const forThumb = new Map();
  for (const [i, im] of pj.images.entries()) {
    const blob = await (await fetchOk(url(im.file))).blob();
    const rec = { id: 'i' + i, key: 'img_' + base + '_' + i, x: im.x, y: im.y, w: im.w, h: im.h };
    await store.putBlob(rec.key, blob);
    page.images.push(rec);
    if (im.y < 1400 && im.x < 900) forThumb.set(rec.id, await loadImage(blob));
  }
  nb.thumb = thumbnail(page, forThumb);
  for (const b of forThumb.values()) b.close?.();
  await store.put('pages', page);
  nb.pageIds = [page.id];
  await store.put('notebooks', nb, { keepTime: true });
  return nb;
}

// Vorschaubild: linker oberer Ausschnitt der Seite (Titel + Seitenanfang)
function thumbnail(page, imgs) {
  const vw = Math.min(page.w, 900), vh = (vw * 4) / 3, sc = 240 / vw;
  const c = document.createElement('canvas');
  c.width = 240;
  c.height = 320;
  const ctx = c.getContext('2d');
  ctx.scale(sc, sc);
  const r = { x0: 0, y0: 0, x1: vw, y1: vh };
  drawBackground(ctx, page, null, 0, vh);
  drawImages(ctx, page.images, imgs, r);
  drawInk(ctx, page.strokes, null, r, sc);
  for (const t of page.texts) if (t.y < vh) drawText(ctx, t);
  return c.toDataURL('image/jpeg', 0.8);
}

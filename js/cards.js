// Karteikarten. Eine Karte ist ein kleines Notizbuch (kind 'card') mit zwei Seiten: Vorder- und Rückseite.
// So lässt sie sich mit allen Editor-Werkzeugen beschreiben und wird wie alles andere synchronisiert.
// Lernstand (FSRS) steht in nb.srs, Herkunft eines Ausschnitts in nb.source.
import { store, uid, newNotebook } from './store.js';
import { drawBackground, drawImages, drawInk, drawText } from './ink.js';
import { loadImage } from './pdfio.js';
import { newSrs } from './srs.js';

export const CARD_W = 1000, CARD_H = 625;
export const isCard = nb => nb?.kind === 'card';
const isEmpty = p => !p || (!p.strokes.length && !p.texts.length && !(p.images || []).length);
const blankPage = nb => ({ id: uid(), notebookId: nb.id, w: CARD_W, h: CARD_H, template: 'blank', paper: 'white', bg: null, strokes: [], texts: [], images: [] });

// Karteikarten liegen nicht zwischen den Notizen, sondern im Unterordner „Karteikarten“ des jeweiligen
// Ordners (Fachs). Seine id steht fest (kf_<Ordner>), damit zwei Geräte nicht je einen eigenen anlegen.
export const isCardFolder = f => f?.kind === 'cards';
export const cardFolderId = parentId => 'kf_' + (parentId || 'root');
export async function cardFolderFor(folderId) {
  const f = folderId ? await store.get('folders', folderId) : null;
  if (isCardFolder(f)) return f.id;
  const id = cardFolderId(f?.id);
  if (!(await store.get('folders', id))) {
    await store.put('folders', { id, name: 'Karteikarten', parentId: f?.id || null, kind: 'cards', createdAt: Date.now() });
  }
  return id;
}
// Karten, die (noch) direkt bei den Notizen liegen – ältere Karten, von Claude oder einem anderen Gerät
// angelegte, verschobene –, in den Karteikarten-Ordner daneben räumen. true, wenn sich etwas geändert hat.
export async function tidyCards(folders, notebooks) {
  const byId = new Map(folders.map(f => [f.id, f]));
  let changed = false;
  for (const nb of notebooks) {
    if (!isCard(nb) || isCardFolder(byId.get(nb.folderId))) continue;
    nb.folderId = await cardFolderFor(byId.has(nb.folderId) ? nb.folderId : null);
    await store.put('notebooks', nb, { keepTime: true });
    changed = true;
  }
  return changed;
}

// image: { blob, w, h } – Ausschnitt (z. B. aus einer Folie), der auf die Vorder- oder Rückseite kommt.
// folderId: Ordner der Notiz – die Karte landet in dessen Karteikarten-Ordner.
export async function createCard({ folderId = null, image = null, side = 'back', source = null } = {}) {
  folderId = await cardFolderFor(folderId);
  const nb = Object.assign(newNotebook({ title: 'Karteikarte', folderId, template: 'blank', size: 'card' }), { kind: 'card', srs: newSrs(), source });
  const front = blankPage(nb), back = blankPage(nb);
  if (image) {
    const page = side === 'front' ? front : back;
    const m = 30, sc = Math.min(2, (CARD_W - 2 * m) / image.w); // Breite füllen, höchstens doppelt vergrößern
    const w = image.w * sc, h = image.h * sc;
    page.h = Math.max(CARD_H, Math.ceil(h + 2 * m));
    const key = 'img_' + uid();
    await store.putBlob(key, image.blob);
    page.images = [{ id: 'i0', key, x: (CARD_W - w) / 2, y: m, w, h }];
  }
  nb.pageIds = [front.id, back.id];
  await store.put('pages', front);
  await store.put('pages', back);
  nb.thumb = await thumbnail([front, back]);
  await store.put('notebooks', nb);
  return nb;
}

// Seite (oder Ausschnitt) als Canvas zeichnen; fehlende Bilder werden aus dem Speicher geladen.
// loaded: bereits geladene Bilder (Map id → Bild), z. B. aus dem Editor
export async function renderPage(page, { scale = 1, region = null, loaded = null } = {}) {
  const r = region || { x: 0, y: 0, w: page.w, h: page.h };
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(r.w * scale));
  c.height = Math.max(1, Math.round(r.h * scale));
  const ctx = c.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, -r.x * scale, -r.y * scale);
  const rect = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
  const imgs = new Map(loaded || []), own = [];
  let bg = null;
  if (page.bg) { const b = await store.getBlob(page.bg); if (b) { bg = await loadImage(b); own.push(bg); } }
  for (const im of page.images || []) {
    if (imgs.has(im.id) || im.x > rect.x1 || im.x + im.w < rect.x0 || im.y > rect.y1 || im.y + im.h < rect.y0) continue;
    const b = await store.getBlob(im.key);
    if (b) { const bm = await loadImage(b); imgs.set(im.id, bm); own.push(bm); }
  }
  drawBackground(ctx, page, bg, r.y, r.y + r.h);
  drawImages(ctx, page.images, imgs, rect);
  drawInk(ctx, page.strokes, null, rect, scale);
  for (const t of page.texts) drawText(ctx, t);
  for (const b of own) b.close?.();
  return c;
}

// Ausschnitt einer Seite als Bild (für "Karte aus Bereich")
export async function snapshot(page, region, loaded) {
  const c = await renderPage(page, { scale: Math.min(2, 1600 / region.w), region, loaded });
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.9));
  c.width = c.height = 0;
  return { blob, w: region.w, h: region.h };
}

// Vorschaubild: Vorderseite (oder Rückseite, falls vorne noch nichts steht)
export async function thumbnail(pages) {
  const p = isEmpty(pages[0]) && pages[1] ? pages[1] : pages[0];
  if (!p) return null;
  const c = await renderPage(p, { scale: 320 / p.w, region: { x: 0, y: 0, w: p.w, h: Math.min(p.h, p.w * 0.625) } });
  return c.toDataURL('image/jpeg', 0.8);
}

export async function updateThumb(nb) {
  const thumb = await thumbnail(await store.pagesOf(nb));
  if (thumb && thumb !== nb.thumb) { nb.thumb = thumb; await store.put('notebooks', nb, { keepTime: true }); }
}

// ---------- Abdeck-Karten (Image Occlusion) ----------
// nb.occl = { group, image: { key, w, h }, masks: [{ id, x, y, w, h }], target: maskId, mode: 'all' | 'one' }
// Eine Karte je verdecktem Bereich; alle Karten einer Gruppe teilen sich Bild und Masken.
// mode 'all': beim Abfragen sind alle Bereiche verdeckt, 'one': nur der abgefragte.
export const MASK = { target: '#e5484d', other: '#f5b83d' };

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Masken auf ein Canvas zeichnen (Koordinaten in Bild-Einheiten); px = Größe eines Bildschirmpixels
export function drawMasks(ctx, occl, { reveal = false, px = 1 } = {}) {
  for (const m of occl.masks) {
    const isTarget = m.id === occl.target;
    if (isTarget && reveal) { // aufgedeckt: nur Umriss
      ctx.lineWidth = 3 * px;
      ctx.strokeStyle = MASK.target;
      roundRect(ctx, m.x, m.y, m.w, m.h, 4 * px);
      ctx.stroke();
      continue;
    }
    if (!isTarget && occl.mode === 'one') continue;
    ctx.fillStyle = isTarget ? MASK.target : MASK.other;
    roundRect(ctx, m.x, m.y, m.w, m.h, 4 * px);
    ctx.fill();
    if (isTarget) {
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${Math.min(m.h * 0.7, 28 * px)}px -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', m.x + m.w / 2, m.y + m.h / 2);
    }
  }
}

export async function loadOcclusionImage(occl) {
  const b = await store.getBlob(occl.image.key);
  return b ? loadImage(b) : null;
}

// Abdeck-Karte als Canvas (Frage: Bereich verdeckt, Antwort: aufgedeckt)
export async function renderOcclusion(occl, { reveal = false, width = 600, dpr = 1, bitmap = null } = {}) {
  const bmp = bitmap || await loadOcclusionImage(occl);
  const k = (width * dpr) / occl.image.w;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(occl.image.w * k));
  c.height = Math.max(1, Math.round(occl.image.h * k));
  const ctx = c.getContext('2d');
  ctx.scale(k, k);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, occl.image.w, occl.image.h);
  if (bmp) ctx.drawImage(bmp, 0, 0, occl.image.w, occl.image.h);
  if (!bitmap) bmp?.close?.();
  drawMasks(ctx, occl, { reveal, px: 1 / k });
  c.style.width = width + 'px';
  return c;
}

export async function occlusionThumb(occl, bitmap) {
  const c = await renderOcclusion(occl, { width: 320, bitmap });
  return c.toDataURL('image/jpeg', 0.8);
}

// Notiz oder Karte löschen. Bei Abdeck-Karten verschwindet ihr Bereich auch aus den übrigen Karten der Gruppe;
// das Bild wird erst mit der letzten Karte gelöscht.
export async function deleteCard(nb) {
  await store.deleteNotebook(nb);
  if (!nb.occl) return;
  const rest = (await store.getAll('notebooks')).filter(n => n.occl?.group === nb.occl.group);
  if (!rest.length) { await store.delBlob(nb.occl.image.key); return; }
  const bitmap = await loadOcclusionImage(nb.occl);
  for (const c of rest) {
    c.occl.masks = c.occl.masks.filter(m => m.id !== nb.occl.target);
    c.thumb = await occlusionThumb(c.occl, bitmap);
    await store.put('notebooks', c);
  }
  bitmap?.close?.();
}

// Ordner-ids eines Teilbaums (inkl. Startordner); null = alles
export function subtree(folders, id) {
  if (!id) return null;
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

// Speicher: wie viel die Notizen belegen (auf dem Gerät und – geschätzt – in der Cloud) und große Notizen
// verkleinern. Supabase (kostenlos) hat 1 GB Dateispeicher; ist er voll, kann nichts mehr hochgeladen werden.
// Verkleinern: Folien und PDF-Seitenbilder etwas stärker komprimiert (JPEG 0.8) und auf höchstens die doppelte
// Anzeigegröße begrenzt – sichtbar ist das kaum. Gespeichert wird unter demselben Schlüssel, die anderen Geräte
// laden die kleinere Fassung beim nächsten Abgleich.
import { store } from './store.js';
import { h, icon, modal, progress, toast } from './ui.js';

export const CLOUD_LIMIT = 1024 ** 3;
const QUALITY = 0.8;
const PX_PER_UNIT = 2;        // Bildpixel je Seiteneinheit, mehr braucht auch ein iPad bei 100 % nicht
const MIN_BYTES = 60 * 1024;  // kleine Bilder lohnen sich nicht
const GZ = 0.3;               // Seiten liegen gzip-komprimiert in der Cloud (grob ein Drittel)

export const fmtMB = b => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2).replace('.', ',') + ' GB' : Math.max(0.1, b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0).replace('.', ',') + ' MB');

// Bilder einer Seite mit ihrem Anzeigekasten (Seiteneinheiten)
const imagesOf = p => [
  ...(p.bg ? [{ key: p.bg, w: p.w, h: p.h }] : []),
  ...(p.images || []).map(im => ({ key: im.key, w: im.w, h: im.h })),
];

// Seitendaten grob schätzen (je Zahl im Strich ~7 Zeichen) statt alle Seiten in Text umzuwandeln –
// das hätte bei großen OneNote-Notizen die App für Sekunden angehalten
const pageChars = p => 300 + (p.strokes || []).reduce((n, s) => n + 90 + (s.pts?.length || 0) * 7, 0)
  + (p.texts || []).reduce((n, t) => n + 120 + (t.text?.length || 0), 0) + (p.images || []).length * 120;

// Größe je Notiz (Bilder + Seitendaten) und insgesamt
export async function usage() {
  const [nbs, pages, blobs] = await Promise.all([store.getAll('notebooks'), store.getAll('pages'), store.allBlobs()]);
  const size = new Map(blobs.map(([k, b]) => [k, b?.size || 0]));
  const byPage = new Map(pages.map(p => [p.id, p]));
  const notes = [];
  let cloud = 0;
  for (const nb of nbs) {
    let images = 0, data = JSON.stringify(nb).length;
    for (const id of nb.pageIds || []) {
      const p = byPage.get(id);
      if (!p) continue;
      data += pageChars(p) * GZ;
      for (const im of imagesOf(p)) images += size.get(im.key) || 0;
    }
    if (nb.occl?.image?.key) images += size.get(nb.occl.image.key) || 0;
    notes.push({ nb, images, bytes: images + data });
    cloud += images + data;
  }
  // Abdeck-Karten teilen sich ein Bild: nicht doppelt zählen
  const occl = new Set();
  for (const n of notes) {
    const k = n.nb.occl?.image?.key;
    if (!k) continue;
    if (occl.has(k)) { cloud -= size.get(k) || 0; n.images -= size.get(k) || 0; n.bytes -= size.get(k) || 0; }
    occl.add(k);
  }
  let device = null;
  try { device = (await navigator.storage?.estimate?.())?.usage ?? null; } catch { /* egal */ }
  return { notes: notes.sort((a, b) => b.bytes - a.bytes), cloud, device };
}

async function shrinkImage(key, box) {
  const blob = await store.getBlob(key);
  if (!blob || blob.size < MIN_BYTES) return 0;
  const bmp = await createImageBitmap(blob);
  try {
    const k = Math.min(1, (box.w * PX_PER_UNIT) / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * k)), hh = Math.max(1, Math.round(bmp.height * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hh;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; // durchsichtige Stellen (PNG) wären in JPEG sonst schwarz
    ctx.fillRect(0, 0, w, hh);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, hh);
    const out = await new Promise(r => c.toBlob(r, 'image/jpeg', QUALITY));
    c.width = c.height = 0;
    if (!out || out.size > blob.size * 0.85) return 0; // spart zu wenig – Original behalten
    await store.putBlob(key, out);
    return blob.size - out.size;
  } finally { bmp.close?.(); }
}

// Alle Bilder einer Notiz verkleinern; liefert die gesparten Bytes
export async function shrinkNote(nb, onProgress) {
  const pages = await store.pagesOf(nb);
  const list = pages.flatMap(imagesOf);
  if (nb.occl?.image) list.push({ key: nb.occl.image.key, w: nb.occl.image.w, h: nb.occl.image.h });
  let saved = 0;
  for (const [i, im] of list.entries()) {
    onProgress?.(i, list.length);
    try { saved += await shrinkImage(im.key, im); } catch (err) { console.warn('Bild', im.key, err); }
  }
  return saved;
}

export async function shrinkWithProgress(nbs, title = 'Notizen werden verkleinert …') {
  const pr = progress(title);
  let saved = 0;
  try {
    for (const [n, nb] of nbs.entries()) {
      saved += await shrinkNote(nb, (i, k) => pr.set(`${nb.title}${nbs.length > 1 ? ` (${n + 1} von ${nbs.length})` : ''} – Bild ${i + 1} von ${k}`, (n + i / Math.max(1, k)) / nbs.length));
    }
  } finally { pr.close(); }
  toast(saved > 1024 * 1024 ? `${fmtMB(saved)} gespart – wird mit der Cloud abgeglichen` : 'Da war nicht viel zu holen – die Bilder sind schon klein');
  return saved;
}

// Dialog: ⋯ → „Speicher …“
export async function storageDialog(onDone) {
  const body = h('div', { class: 'help' }, h('p', { class: 'muted' }, 'Wird berechnet …'));
  const draw = async () => {
    const u = await usage();
    const share = Math.min(1, u.cloud / CLOUD_LIMIT);
    const big = u.notes.filter(n => n.images > 5 * 1024 ** 2);
    body.replaceChildren(
      h('p', {}, h('b', {}, 'Cloud (Supabase, kostenlos 1 GB): '), `ca. ${fmtMB(u.cloud)}`),
      h('div', { class: 'meter' + (share > 0.8 ? ' warn' : '') }, h('i', { style: { width: Math.round(share * 100) + '%' } })),
      u.device != null ? h('p', { class: 'muted small' }, `Auf diesem Gerät belegt die App ${fmtMB(u.device)}.`) : null,
      h('p', { class: 'small', style: { marginTop: '14px' } }, h('b', {}, 'Größte Notizen')),
      h('div', { class: 'usage-list' }, u.notes.filter(n => n.nb.kind !== 'card' || n.bytes > 1024 ** 2).slice(0, 8).map(n => h('div', { class: 'usage-row' },
        h('span', { class: 'grow' }, n.nb.title),
        h('span', { class: 'muted small' }, fmtMB(n.bytes)),
        n.images > 1024 ** 2 ? h('button', { class: 'btn sm', type: 'button', onclick: async () => { await shrinkWithProgress([n.nb]); await draw(); onDone?.(); } }, 'Verkleinern') : null))),
      big.length ? h('button', { class: 'btn block', type: 'button', onclick: async () => { await shrinkWithProgress(big.map(n => n.nb)); await draw(); onDone?.(); } },
        icon('download'), big.length === 1 ? 'Die große Notiz verkleinern' : `Alle ${big.length} großen Notizen verkleinern`) : null,
      h('p', { class: 'muted small' }, 'Verkleinern komprimiert Folien und PDF-Seiten etwas stärker – man sieht kaum einen Unterschied. Die anderen Geräte übernehmen die kleineren Bilder beim nächsten Abgleich. Die Schätzung zählt, was auf diesem Gerät liegt.'));
  };
  draw().catch(err => body.replaceChildren(h('p', {}, 'Fehler: ' + err.message)));
  await modal({ title: 'Speicher', body });
}

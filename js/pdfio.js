// PDF-Import (pdf.js) und PDF-Export (jsPDF). Beide Bibliotheken werden erst bei Bedarf geladen.
//
// Speicher: Von einem importierten PDF wird die Originaldatei abgeglichen (blobs: "pdf_…") – klein und die Quelle
// für jede Auflösung. Die Seitenbilder, die der Editor anzeigt, liegen nur auf dem Gerät (meta-Speicher,
// "pdfbg:<pdf>:<seite>", wird nicht abgeglichen): Jedes Gerät zeichnet sie bei Bedarf aus dem PDF. In der Cloud
// kostet eine Folie so meist nur einen Bruchteil. Seiten mit eigenem Bild im abgeglichenen Speicher (ältere
// Importe, sehr große PDFs) haben kein page.pdf – für sie gilt weiter page.bg als Schlüssel in blobs.
import { store, uid, newNotebook } from './store.js';
import { drawBackground, drawImages, drawInk, drawText } from './ink.js';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const MAX_PX = 9e6; // Obergrenze Pixel pro Seite (iPad-Speicher)
const MAX_PDF = 45 * 1024 * 1024; // größere Dateien nimmt der Cloud-Speicher nicht an (50 MB je Datei)

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous'; // sonst kann der Service Worker die Datei nicht für offline aufheben (sw.js)
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error('Bibliothek konnte nicht geladen werden – Internetverbindung prüfen.')); };
    document.head.append(s);
  });
}

let pdfjsP, jspdfP;
function getPdfjs() {
  return (pdfjsP ??= (async () => {
    await loadScript(PDFJS + 'pdf.min.js');
    const lib = window.pdfjsLib;
    // Worker von anderer Domain geht nicht direkt → als Blob-URL einbinden
    const code = await (await fetch(PDFJS + 'pdf.worker.min.js')).text();
    lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    return lib;
  })().catch(err => { pdfjsP = null; throw err; }));
}
function getJspdf() {
  return (jspdfP ??= loadScript(JSPDF).then(() => window.jspdf).catch(err => { jspdfP = null; throw err; }));
}

export async function loadImage(blob) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(blob); } catch { /* Fallback unten */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

// ---------- Bilder speichern ----------
// WebP, wo der Browser es schreiben kann (Chrome, Edge, Firefox): bei gleicher Schärfe etwa halb so groß wie JPEG.
// Safari schreibt kein WebP – toBlob lieferte dort stillschweigend PNG (viel größer), deshalb vorher prüfen.
// Lesen kann WebP jedes Gerät.
let webpOK = null;
export function canWebp() {
  if (webpOK == null) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 2;
      webpOK = c.toDataURL('image/webp').startsWith('data:image/webp');
    } catch { webpOK = false; }
  }
  return webpOK;
}
// quality: für WebP; jpeg: Qualität, falls es JPEG wird. forceJpeg: Ziel versteht nur JPEG (z. B. Dateien für Claude)
export function encodeImage(canvas, quality = 0.85, jpeg = quality, forceJpeg = false) {
  const webp = !forceJpeg && canWebp();
  return new Promise(r => canvas.toBlob(r, webp ? 'image/webp' : 'image/jpeg', webp ? quality : jpeg));
}

// ---------- PDF-Seiten zeichnen ----------
// intent 'print' rendert in einem Rutsch (ohne requestAnimationFrame) → stockt nicht, wenn die App im Hintergrund
// ist (Import). Beim Nachzeichnen im Editor 'display': pdf.js gibt dann zwischendurch die Kontrolle ab.
async function rasterCanvas(pg, intent) {
  const base = pg.getViewport({ scale: 1 });
  let sc = 2.5;
  if (base.width * base.height * sc * sc > MAX_PX) sc = Math.sqrt(MAX_PX / (base.width * base.height));
  const vp = pg.getViewport({ scale: sc });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width);
  c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: ctx, viewport: vp, intent }).promise;
  return { c, base };
}

export const rasterKey = p => `pdfbg:${p.pdf.key}:${p.pdf.n}`;

// Geöffnete PDFs bleiben kurz offen (mehrere Seiten nacheinander), danach wird der Speicher freigegeben
const docs = new Map(); // PDF-Schlüssel → { p: Promise<Dokument | null>, t: zuletzt benutzt }
let docT = 0;
function openDoc(key) {
  let e = docs.get(key);
  if (!e) {
    e = { p: (async () => {
      const blob = await store.getBlob(key);
      if (!blob) return null; // PDF (noch) nicht auf diesem Gerät
      const lib = await getPdfjs();
      return lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    })() };
    e.p.then(d => { if (!d && docs.get(key) === e) docs.delete(key); }, () => { if (docs.get(key) === e) docs.delete(key); });
    docs.set(key, e);
  }
  e.t = Date.now();
  if (!docT) docT = setTimeout(closeIdleDocs, 60000);
  return e.p;
}
function closeIdleDocs() {
  docT = 0;
  for (const [k, e] of docs) {
    if (running || Date.now() - e.t < 45000) continue;
    docs.delete(k);
    e.p.then(d => d?.destroy()).catch(() => {});
  }
  if (docs.size) docT = setTimeout(closeIdleDocs, 60000);
}

// Warteschlange: eine Seite nach der anderen, die zuletzt angefragte zuerst (das ist die gerade sichtbare)
const jobs = new Map(); // Schlüssel → Auftrag
const queue = [];
let running = false;
function renderRaster(page, key, wanted) {
  let job = jobs.get(key);
  if (!job) {
    job = { key, pdf: page.pdf, wanted: [] };
    job.promise = new Promise(res => { job.resolve = res; });
    jobs.set(key, job);
    queue.push(job);
  } else {
    const i = queue.indexOf(job);
    if (i >= 0) { queue.splice(i, 1); queue.push(job); } // erneut gefragt: nach vorn
  }
  job.wanted.push(wanted || (() => true));
  pump();
  return job.promise;
}
async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.pop();
      let blob = null;
      if (job.wanted.some(f => f())) {
        try {
          blob = await rasterize(job.pdf);
          if (blob) await store.setMeta(job.key, blob);
        } catch (err) { console.warn('PDF-Seite', job.key, err); }
      }
      jobs.delete(job.key);
      job.resolve(blob);
    }
  } finally { running = false; }
}
async function rasterize({ key, n }) {
  const doc = await openDoc(key);
  if (!doc) return null;
  const pg = await doc.getPage(n);
  const { c } = await rasterCanvas(pg, 'display');
  const blob = await encodeImage(c, 0.85);
  c.width = c.height = 0;
  pg.cleanup();
  return blob;
}

// Hintergrundbild einer Seite (PDF-Seite) oder null, wenn sie keins hat bzw. es (noch) nicht zu bekommen ist.
// wanted(): wird das Bild noch gebraucht? Beim schnellen Blättern ist eine Seite oft schon wieder aus dem Blick,
// bevor sie an der Reihe ist – dann wird sie gar nicht erst gezeichnet (Ergebnis null, später erneut anfragen).
export async function bgBlob(page, wanted = null) {
  if (!page?.bg) return null;
  if (!page.pdf) return (await store.getBlob(page.bg)) || null;
  const key = rasterKey(page);
  return (await store.getMeta(key)) || renderRaster(page, key, wanted);
}
// Liegt das Seitenbild schon auf dem Gerät? (ohne es zu zeichnen)
export async function hasBg(page) {
  if (!page?.bg) return true;
  return !!(page.pdf ? await store.getMeta(rasterKey(page)) : await store.getBlob(page.bg));
}

// Jede PDF-Seite wird eine Notizseite mit dem PDF als Hintergrund.
// Ohne `notebook` entsteht ein neues Notizbuch, sonst werden die Seiten angehängt.
// `meta` wird ins neue Notizbuch übernommen (z. B. Herkunft und Reihenfolge beim OneNote-Import).
// pageId(i) / pdfKey: feste ids (z. B. für PDFs aus dem Eingang, die zwei Geräte gleichzeitig abholen könnten)
export async function importPdf(file, { notebook, folderId = null, title, meta, onProgress, pageId, pdfKey } = {}) {
  const lib = await getPdfjs();
  // pdf.js übernimmt den Puffer (er ist danach leer) – das Original bleibt in `file`
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const name = title || file.name?.replace(/\.pdf$/i, '') || 'PDF';
  const nb = notebook || Object.assign(newNotebook({ title: name, folderId, template: 'blank', color: '#5b6475' }), { kind: 'pdf' }, meta);
  const key = pdfKey || 'pdf_' + uid();
  const added = [];
  let rasterBytes = 0;
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress?.(i, doc.numPages);
      const pg = await doc.getPage(i);
      const { c, base } = await rasterCanvas(pg, 'print');
      const blob = await encodeImage(c, 0.85, 0.82);
      c.width = c.height = 0;
      const id = pageId ? pageId(i) : uid();
      const page = {
        id, notebookId: nb.id,
        w: Math.round((base.width * 96) / 72), h: Math.round((base.height * 96) / 72),
        template: 'blank', paper: 'white', bg: 'bg_' + id, strokes: [], texts: [], pdf: { key, n: i },
      };
      await store.setMeta(rasterKey(page), blob);
      rasterBytes += blob.size;
      added.push(page);
      pg.cleanup();
    }
    // Was wird abgeglichen? Normalerweise das Original-PDF. Ist es größer als seine Seitenbilder (eingescannte
    // Fotos) oder zu groß zum Hochladen, dann wie früher die Seitenbilder selbst.
    if (file.size <= MAX_PDF && file.size < rasterBytes) {
      await store.putBlob(key, file.slice(0, file.size, 'application/pdf'));
    } else {
      for (const p of added) {
        const k = rasterKey(p), blob = await store.getMeta(k);
        if (blob) await store.putBlob(p.bg, blob);
        delete p.pdf;
      }
      await store.delMetaPrefix(`pdfbg:${key}:`);
    }
  } catch (err) {
    await store.delMetaPrefix(`pdfbg:${key}:`).catch(() => {});
    throw err;
  } finally {
    doc.destroy();
  }
  await store.batch(added.map(p => ({ name: 'pages', op: 'put', value: p })));
  nb.pageIds.push(...added.map(p => p.id));
  await store.put('notebooks', nb);
  return { notebook: nb, pages: added };
}

export async function exportPdf(pages, onProgress) {
  const { jsPDF } = await getJspdf();
  let doc;
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(i + 1, pages.length);
    const p = pages[i];
    let bg = null;
    if (p.bg) { const b = await bgBlob(p); if (b) bg = await loadImage(b); }
    const imgs = new Map();
    for (const im of p.images || []) { const b = await store.getBlob(im.key); if (b) imgs.set(im.id, await loadImage(b)); }

    // lange Seiten (z. B. aus OneNote) in Abschnitte im A4-Seitenverhältnis teilen
    const chunk = p.h > p.w * 1.414 * 1.15 ? Math.round(p.w * 1.414) : p.h;
    for (let y0 = 0; y0 < p.h; y0 += chunk) {
      const ch = Math.min(chunk, p.h - y0);
      let sc = 2;
      if (p.w * ch * sc * sc > MAX_PX) sc = Math.sqrt(MAX_PX / (p.w * ch));
      const c = document.createElement('canvas');
      c.width = Math.round(p.w * sc);
      c.height = Math.round(ch * sc);
      const ctx = c.getContext('2d');
      ctx.setTransform(sc, 0, 0, sc, 0, -y0 * sc);
      const r = { x0: 0, y0, x1: p.w, y1: y0 + ch };
      drawBackground(ctx, p, bg, y0, y0 + ch);
      drawImages(ctx, p.images, imgs, r);
      drawInk(ctx, p.strokes, null, r, sc);
      for (const t of p.texts) drawText(ctx, t);
      const data = c.toDataURL('image/jpeg', 0.92);
      c.width = c.height = 0;

      const w = p.w * 0.75, hh = ch * 0.75, o = w > hh ? 'l' : 'p';
      if (!doc) doc = new jsPDF({ unit: 'pt', format: [w, hh], orientation: o, compress: true });
      else doc.addPage([w, hh], o);
      doc.addImage(data, 'JPEG', 0, 0, w, hh, undefined, 'FAST');
    }
    bg?.close?.();
    for (const b of imgs.values()) b.close?.();
  }
  return doc.output('blob');
}

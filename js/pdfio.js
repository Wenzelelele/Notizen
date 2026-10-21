// PDF-Import (pdf.js) und PDF-Export (jsPDF). Beide Bibliotheken werden erst bei Bedarf geladen.
import { store, uid, newNotebook } from './store.js';
import { drawBackground, drawImages, drawInk, drawText } from './ink.js';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const MAX_PX = 9e6; // Obergrenze Pixel pro Seite (iPad-Speicher)

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
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

function thumbnail(c) {
  const t = document.createElement('canvas');
  t.width = 240;
  t.height = Math.min(400, Math.round((240 * c.height) / c.width));
  t.getContext('2d').drawImage(c, 0, 0, c.width, (t.height * c.width) / 240, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.7);
}

// Jede PDF-Seite wird eine Notizseite mit dem PDF als Hintergrund.
// Ohne `notebook` entsteht ein neues Notizbuch, sonst werden die Seiten angehängt.
// `meta` wird ins neue Notizbuch übernommen (z. B. Herkunft und Reihenfolge beim OneNote-Import).
// pageId(i): feste Seiten-ids (z. B. für PDFs aus dem Eingang, die zwei Geräte gleichzeitig abholen könnten)
export async function importPdf(file, { notebook, folderId = null, title, meta, onProgress, pageId } = {}) {
  const lib = await getPdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const name = title || file.name?.replace(/\.pdf$/i, '') || 'PDF';
  const nb = notebook || Object.assign(newNotebook({ title: name, folderId, template: 'blank', color: '#5b6475' }), { kind: 'pdf' }, meta);
  const added = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress?.(i, doc.numPages);
      const pg = await doc.getPage(i);
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
      // intent 'print' rendert in einem Rutsch (ohne requestAnimationFrame) → stockt nicht, wenn die Seite im Hintergrund ist
      await pg.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
      // 0.82 statt 0.9: rund ein Drittel kleiner (Speicher, Cloud, Sync), kaum sichtbar
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
      if (!nb.thumb && i === 1) nb.thumb = thumbnail(c);
      c.width = c.height = 0;

      const id = pageId ? pageId(i) : uid(), key = 'bg_' + id;
      await store.putBlob(key, blob);
      const page = {
        id, notebookId: nb.id,
        w: Math.round((base.width * 96) / 72), h: Math.round((base.height * 96) / 72),
        template: 'blank', paper: 'white', bg: key, strokes: [], texts: [],
      };
      await store.put('pages', page);
      nb.pageIds.push(id);
      added.push(page);
      pg.cleanup();
    }
  } finally {
    doc.destroy();
  }
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
    if (p.bg) { const b = await store.getBlob(p.bg); if (b) bg = await loadImage(b); }
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

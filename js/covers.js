// Vorschaubilder (Cover) für die Bibliothek: erste Seite einer PDF-/OneNote-Notiz bzw. Vorderseite einer Karte –
// samt Handschrift. Sie liegen nur auf dem Gerät (meta-Speicher "cover:<notiz>", wird nicht abgeglichen) und
// entstehen bei Bedarf neu. Früher steckten sie als Base64-Text im Notiz-Datensatz (nb.thumb): Dann las jede
// Bibliotheksansicht und jede Lernrunde alle Bilder aller Notizen und Karten mit, und jede Kartenbewertung lud
// das Bild erneut hoch. adoptThumbs() übernimmt solche alten Bilder und räumt sie aus den Datensätzen.
import { store, changes } from './store.js';
import { renderPage, renderOcclusion, isCard } from './cards.js';

const KEY = id => 'cover:' + id;
const isBlank = p => !p || (!p.strokes?.length && !p.texts?.length && !(p.images || []).length && !p.bg);
// Seiten, aus denen das Cover entsteht: Karte = Vorder- und Rückseite, Notiz = die ersten drei (Folien im
// Querformat stehen untereinander – so füllt das Cover sein Hochformat, statt eine Folie seitlich abzuschneiden)
export const coverPages = nb => (nb.occl ? [] : (nb.pageIds || []).slice(0, isCard(nb) ? 2 : 3));

// Eigene Notizen behalten ihr farbiges Cover mit Titel; ein Bild bekommen PDFs, OneNote-Seiten und Karten
export const hasCover = nb => nb.kind === 'pdf' || nb.kind === 'onenote' || nb.kind === 'card';

// Woran man am Datensatz erkennt, dass ein gespeichertes Cover nicht mehr passt: andere erste Seite bzw. bei
// Abdeck-Karten geänderte Bereiche. Geänderter Seiteninhalt wird gemeldet (Editor: makeCover, Sync: unten).
export function sigOf(nb) {
  if (!nb.occl) return coverPages(nb).join('|');
  const o = nb.occl;
  return ['o', o.image?.key, o.target, o.mode, ...(o.masks || []).map(m => [m.id, m.x, m.y, m.w, m.h].map(v => (typeof v === 'number' ? Math.round(v) : v)).join(','))].join('|');
}

export const coverEvents = new EventTarget(); // 'cover' { id, url }: neues Bild fertig
const mem = new Map();     // Notiz-id → { sig, pages, url }
const waiting = new Map(); // Notiz-id → Notiz (wartet aufs Zeichnen)
const failed = new Map();  // Notiz-id → sig, mit der es nicht ging (z. B. Seite noch nicht da)
let working = false;

// Sofort verfügbares Bild (schon in dieser Sitzung geladen) – auch ein veraltetes, bis das neue fertig ist
export const cachedCover = nb => mem.get(nb.id)?.url || null;

// Bild holen: aus dem Gerätespeicher; fehlt es oder ist es veraltet, wird es in der Warteschlange neu gezeichnet
// und per 'cover'-Ereignis nachgereicht (bis dahin das alte Bild bzw. null).
export async function loadCover(nb) {
  const sig = sigOf(nb);
  let m = mem.get(nb.id);
  if (!m) {
    const saved = await store.getMeta(KEY(nb.id)).catch(() => null);
    if (saved?.blob) {
      m = mem.get(nb.id) || { sig: saved.sig, pages: saved.pages, url: URL.createObjectURL(saved.blob) };
      mem.set(nb.id, m);
    }
  }
  if (m?.sig === sig) return m.url;
  if (failed.get(nb.id) !== sig) { waiting.set(nb.id, nb); work(); }
  return m?.url || null;
}

async function work() {
  if (working) return;
  working = true;
  try {
    while (waiting.size) {
      const [id, nb] = waiting.entries().next().value;
      waiting.delete(id);
      try { if (!(await makeCover(nb))) failed.set(id, sigOf(nb)); }
      catch (err) { console.warn('Vorschaubild', id, err); failed.set(id, sigOf(nb)); }
      await new Promise(r => setTimeout(r, 20)); // dazwischen Luft für Eingaben
    }
  } finally { working = false; }
}
// Bibliothek verlassen: nichts mehr im Hintergrund zeichnen (im Editor würde es das Schreiben stören)
export function pauseCovers() { waiting.clear(); }

// Cover jetzt neu zeichnen. pages: die (ersten) Seiten, falls schon im Speicher – z. B. beim Schließen des Editors
export async function makeCover(nb, pages = null) {
  const sig = sigOf(nb), card = isCard(nb);
  let c;
  if (nb.occl) c = await renderOcclusion(nb.occl, { width: 480 });
  else {
    const ps = pages || await store.getMany('pages', coverPages(nb));
    const p = card && isBlank(ps[0]) && ps[1] ? ps[1] : ps[0];
    if (!p || p.missing) return null;
    if (!card && p.w > p.h * 1.15) {
      // Querformat (Folien): bis zu drei Seiten untereinander
      const W = 360, H = 480, gap = 8;
      c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#e9ebf0';
      ctx.fillRect(0, 0, W, H);
      let y = 0;
      for (const q of ps) {
        if (!q || q.missing || y >= H) break;
        const part = await renderPage(q, { scale: W / q.w });
        ctx.drawImage(part, 0, y);
        y += part.height + gap;
        part.width = part.height = 0;
      }
    } else {
      // Karten: ganze Breite im Kartenformat. Notizen: Seitenanfang (bei sehr breiten OneNote-Seiten der linke Teil)
      const vw = card || p.bg ? p.w : Math.min(p.w, 900);
      const vh = Math.min(p.h, vw * (card ? 0.625 : 4 / 3));
      c = await renderPage(p, { scale: (card ? 480 : 360) / vw, region: { x: 0, y: 0, w: vw, h: vh } });
    }
  }
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
  c.width = c.height = 0;
  if (!blob) return null;
  const pagesUsed = coverPages(nb);
  await store.setMeta(KEY(nb.id), { sig, pages: pagesUsed, blob });
  const old = mem.get(nb.id), url = URL.createObjectURL(blob);
  mem.set(nb.id, { sig, pages: pagesUsed, url });
  failed.delete(nb.id);
  coverEvents.dispatchEvent(new CustomEvent('cover', { detail: { id: nb.id, url } }));
  if (old?.url) setTimeout(() => URL.revokeObjectURL(old.url), 10000); // wird vielleicht gerade noch angezeigt
  return url;
}

// Inhalt einer Cover-Seite hat sich auf einem anderen Gerät geändert (kam per Sync): Bild gilt als veraltet
async function invalidate(nbId, pageId) {
  const m = mem.get(nbId);
  if (m && m.pages?.includes(pageId)) m.sig = null;
  failed.delete(nbId);
  const saved = await store.getMeta(KEY(nbId)).catch(() => null);
  if (saved?.sig != null && saved.pages?.includes(pageId)) await store.setMeta(KEY(nbId), { ...saved, sig: null });
}
changes.addEventListener('change', e => {
  const { kind, id, remote, nb } = e.detail;
  if (kind === 'pages' && remote && nb) invalidate(nb, id).catch(() => {});
});

// Alte Vorschaubilder aus den Notiz-Datensätzen übernehmen (einmalig je Datensatz; auch für Datensätze, die ein
// noch nicht aktualisiertes Gerät später schickt). Ändert die übergebenen Notizen; true, wenn etwas zu tun war.
export async function adoptThumbs(notebooks) {
  const list = notebooks.filter(n => 'thumb' in n);
  if (!list.length) return false;
  const ops = [];
  for (const nb of list) {
    if (typeof nb.thumb === 'string' && nb.thumb.startsWith('data:') && hasCover(nb) && !mem.has(nb.id)) {
      try {
        if (!(await store.getMeta(KEY(nb.id)))) {
          const blob = await (await fetch(nb.thumb)).blob();
          ops.push({ name: 'meta', op: 'put', key: KEY(nb.id), value: { sig: sigOf(nb), pages: coverPages(nb), blob } });
        }
      } catch { /* wird bei Bedarf neu gezeichnet */ }
    }
    delete nb.thumb;
    ops.push({ name: 'notebooks', op: 'put', value: nb });
  }
  await store.batch(ops, { keepTime: true });
  return true;
}

// Zwei Foliensätze zu einer Notiz zusammenführen (z. B. dasselbe Skript als PDF und aus OneNote):
// Gleiche Folien (Bildvergleich) kommen nur einmal vor – mit der Handschrift aus beiden Sätzen darauf.
// Folien und Seiten, die es nur in einem Satz gibt, stehen an ihrer Stelle dazwischen.
// Es entsteht eine neue Notiz mit eigenen Kopien aller Bilder; die beiden alten bleiben unverändert.
import { store, uid, newNotebook } from './store.js';
import { h, modal, progress, toast } from './ui.js';
import { loadImage } from './pdfio.js';

// Vergleich in Tests (30 Folien mit gleicher Vorlage, nur andere Textzeilen; OneNote-Fassung gröber, teils
// beschnitten, mit eingebrannter Tinte): Erst ohne die gemeinsame Vorlage und als „gegenseitig bester Treffer“
// wurden alle echten Paare gefunden und keine falschen. Feste Schwellen allein verwechselten Folien.
export const SIZE = 24;   // Folien werden als SIZE × SIZE Graustufenbild verglichen (gröber trennt hier besser)
const FLOOR = 0.4;        // Mindestähnlichkeit des Inhalts (1 = identisch)
const NEAR = 0.03;        // so knapp unter dem besten Treffer zählt noch (wiederholte Folien, z. B. Gliederung)
const r2 = v => Math.round(v * 100) / 100;

// Die Folie einer Seite und ihr Rechteck auf der Seite: PDF-Hintergrund oder das größte Bild (OneNote).
// Seiten ohne Folie (nur Handschrift, leer eingefügt) haben keine und werden nie zusammengelegt.
export function slideOf(p) {
  if (p.bg) return { key: p.bg, x: 0, y: 0, w: p.w, h: p.h };
  let best = null;
  for (const im of p.images || []) if (!best || im.w * im.h > best.w * best.h) best = im;
  return best && best.w >= 0.4 * p.w ? best : null;
}

// Fingerabdruck einer Folie: verkleinert (schrittweise halbiert – sonst flimmert Schrift) als Graustufen.
// Verglichen wird erst nach distinct() – roh sind Folien mit derselben Vorlage kaum zu unterscheiden.
export async function fingerprint(blob, N = SIZE) {
  const bmp = await loadImage(blob);
  const temp = [];
  try {
    let src = trimmed(bmp, temp), w = src.width, hh = src.height;
    while (w > 2 * N || hh > 2 * N) {
      w = Math.max(N, Math.round(w / 2));
      hh = Math.max(N, Math.round(hh / 2));
      const c = document.createElement('canvas');
      c.width = w; c.height = hh;
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(src, 0, 0, w, hh);
      temp.push(c);
      src = c;
    }
    const c = document.createElement('canvas');
    c.width = c.height = N;
    temp.push(c);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#fff';
    x.fillRect(0, 0, N, N);
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, N, N);
    const d = x.getImageData(0, 0, N, N).data, v = new Float32Array(N * N);
    let mean = 0, sq = 0;
    for (let i = 0; i < v.length; i++) { v[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; mean += v[i]; sq += v[i] * v[i]; }
    mean /= v.length;
    if (sq / v.length - mean * mean < 4) return null; // einfarbig (leere Folie): taugt nicht zum Vergleichen
    return v;
  } finally {
    bmp.close?.();
    for (const c of temp) c.width = c.height = 0;
  }
}
// Weiße Ränder abschneiden (OneNote-Ausdrucke haben oft einen weißen Rand um die Folie, das PDF nicht).
// Nur rein weiße Zeilen/Spalten zählen als Rand – so wird dieselbe Folie mit und ohne Rand gleich zugeschnitten
// (auch weißer Folienhintergrund unter der letzten Zeile fällt bei beiden weg). Gemessen an einer kleinen
// Fassung; Ergebnis ist ein Canvas mit dem Folienbereich in voller Auflösung.
function trimmed(bmp, temp) {
  const W = bmp.width, H = bmp.height, k = Math.min(1, 256 / Math.max(W, H));
  const sw = Math.max(8, Math.round(W * k)), sh = Math.max(8, Math.round(H * k));
  const s = document.createElement('canvas');
  s.width = sw; s.height = sh;
  temp.push(s);
  const x = s.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#fff';
  x.fillRect(0, 0, sw, sh);
  x.drawImage(bmp, 0, 0, sw, sh);
  const d = x.getImageData(0, 0, sw, sh).data;
  const ink = (i, j) => { const p = (j * sw + i) * 4; return d[p] < 232 || d[p + 1] < 232 || d[p + 2] < 232; };
  let x0 = sw, y0 = sh, x1 = -1, y1 = -1;
  for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) if (ink(i, j)) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j; }
  if (x1 < 0 || (x0 <= 1 && y0 <= 1 && x1 >= sw - 2 && y1 >= sh - 2)) return bmp; // nichts oder kein Rand
  const cx = Math.max(0, (x0 - 1) / k), cy = Math.max(0, (y0 - 1) / k), cw = Math.min(W, (x1 + 2) / k) - cx, ch = Math.min(H, (y1 + 2) / k) - cy;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cw));
  c.height = Math.max(1, Math.round(ch));
  temp.push(c);
  c.getContext('2d').drawImage(bmp, cx, cy, cw, ch, 0, 0, c.width, c.height);
  return c;
}

// Was alle Folien eines Satzes gemeinsam haben (Vorlage: Titelbalken, Logo, Fußzeile), abziehen – übrig bleibt der
// Inhalt der einzelnen Folie. Danach Mittelwert 0 und Länge 1: Ähnlichkeit = Skalarprodukt (Korrelation des Inhalts).
export function distinct(prints) {
  const list = prints.filter(Boolean);
  if (!list.length) return prints;
  const avg = new Float32Array(list[0].length);
  for (const v of list) for (let i = 0; i < v.length; i++) avg[i] += v[i] / list.length;
  return prints.map(v => {
    if (!v) return null;
    const r = new Float32Array(v.length);
    let mean = 0;
    for (let i = 0; i < v.length; i++) { r[i] = v[i] - (list.length >= 6 ? avg[i] : 0); mean += r[i]; } // wenige Folien: Vorlage nicht schätzbar
    mean /= r.length;
    let norm = 0;
    for (let i = 0; i < r.length; i++) { r[i] -= mean; norm += r[i] * r[i]; }
    norm = Math.sqrt(norm);
    if (norm < 1e-6) return null; // nur Vorlage, kein eigener Inhalt
    for (let i = 0; i < r.length; i++) r[i] /= norm;
    return r;
  });
}
export const similarity = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// Welche Folienpaare kommen in Frage? ra/rb: je Seite { fp, aspect } oder null (keine Folie).
// Vorlage je Satz herausrechnen (jeder Satz hat seine eigene Darstellung), dann zählt ein Paar nur, wenn beide
// füreinander (fast) der beste Treffer sind und der Inhalt klar ähnlich ist. Liefert sim(i, j): > 0 = zulässig.
export function candidates(ra, rb) {
  const fa = distinct(ra.map(x => x?.fp || null)), fb = distinct(rb.map(x => x?.fp || null));
  const S = fa.map((a, i) => fb.map((b, j) => (a && b && Math.abs(ra[i].aspect / rb[j].aspect - 1) <= 0.15 ? similarity(a, b) : -1)));
  const rowBest = S.map(row => Math.max(-1, ...row));
  const colBest = fb.map((_, j) => Math.max(-1, ...S.map(row => row[j])));
  return (i, j) => {
    const s = S[i][j];
    return s >= FLOOR && s >= rowBest[i] - NEAR && s >= colBest[j] - NEAR ? s : -1;
  };
}

// Reihenfolge beider Sätze abgleichen (wie ein „diff“): möglichst viele gleiche Folien in derselben Reihenfolge.
// Ergebnis: [{ a, b }] – a/b Index der Seite oder -1 (nur im anderen Satz).
export function align(n, m, sim) {
  const S = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const how = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1 gleich, 2 nur A, 3 nur B
  for (let i = 1; i <= n; i++) how[i][0] = 2;
  for (let j = 1; j <= m; j++) how[0][j] = 3;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = S[i][j - 1], k = 3; // bei Gleichstand: B-Seiten nach den A-Seiten einordnen
      if (S[i - 1][j] > best) { best = S[i - 1][j]; k = 2; }
      const s = sim(i - 1, j - 1); // > 0 nur für zulässige Paare
      if (s > 0 && S[i - 1][j - 1] + s > best) { best = S[i - 1][j - 1] + s; k = 1; }
      S[i][j] = best;
      how[i][j] = k;
    }
  }
  const out = [];
  for (let i = n, j = m; i > 0 || j > 0;) {
    const k = how[i][j];
    if (k === 1) out.push({ a: --i, b: --j });
    else if (k === 2) out.push({ a: --i, b: -1 });
    else out.push({ a: -1, b: --j });
  }
  return out.reverse();
}

// ---------- Seiten bauen ----------
async function copyBlob(key, newKey) {
  const b = await store.getBlob(key);
  if (b) await store.putBlob(newKey, b);
  return newKey;
}
// Seite samt eigener Bildkopien in die neue Notiz übernehmen
async function copyPage(p, nb) {
  const q = JSON.parse(JSON.stringify(p));
  q.id = uid();
  q.notebookId = nb.id;
  delete q.updatedAt;
  q.strokes = (q.strokes || []).map(s => ({ ...s, id: uid() }));
  q.texts = (q.texts || []).map(t => ({ ...t, id: uid() }));
  if (q.bg) q.bg = await copyBlob(p.bg, 'bg_' + q.id);
  const images = [];
  for (const im of q.images || []) images.push({ ...im, key: await copyBlob(im.key, 'img_' + uid()) });
  q.images = images;
  return q;
}
// Inhalt der Seite o (Handschrift, Texte, weitere Bilder) auf Seite q übertragen: Folie auf Folie abgebildet
async function overlay(q, qs, o, os) {
  const kx = qs.w / os.w, ky = qs.h / os.h, k = (kx + ky) / 2;
  const X = x => r2(qs.x + (x - os.x) * kx), Y = y => r2(qs.y + (y - os.y) * ky);
  q.strokes.push(...(o.strokes || []).map(s => ({ ...s, id: uid(), size: r2(s.size * k), pts: s.pts.map((v, i) => (i % 3 === 0 ? X(v) : i % 3 === 1 ? Y(v) : v)) })));
  q.texts.push(...(o.texts || []).map(t => ({ ...t, id: uid(), x: X(t.x), y: Y(t.y), w: r2((t.w || 200) * kx), size: r2(t.size * k) })));
  for (const im of o.images || []) {
    if (im.key === os.key) continue; // die Folie selbst gibt es schon
    q.images.push({ ...im, id: 'i' + uid(), key: await copyBlob(im.key, 'img_' + uid()), x: X(im.x), y: Y(im.y), w: r2(im.w * kx), h: r2(im.h * ky) });
  }
}
// Seiten ohne PDF-Hintergrund wachsen mit, falls übertragene Notizen über den Rand ragen
function fitPage(q) {
  if (q.bg) return;
  let x0 = 0, y0 = 0, x1 = q.w, y1 = q.h;
  for (const s of q.strokes) for (let i = 0; i < s.pts.length; i += 3) { x0 = Math.min(x0, s.pts[i]); x1 = Math.max(x1, s.pts[i]); y0 = Math.min(y0, s.pts[i + 1]); y1 = Math.max(y1, s.pts[i + 1]); }
  for (const t of q.texts) { x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); x1 = Math.max(x1, t.x + (t.w || 0)); y1 = Math.max(y1, t.y + t.size * 1.3); }
  for (const im of q.images) { x0 = Math.min(x0, im.x); y0 = Math.min(y0, im.y); x1 = Math.max(x1, im.x + im.w); y1 = Math.max(y1, im.y + im.h); }
  const dx = x0 < 0 ? 16 - x0 : 0, dy = y0 < 0 ? 16 - y0 : 0;
  if (dx || dy) {
    for (const s of q.strokes) s.pts = s.pts.map((v, i) => (i % 3 === 0 ? r2(v + dx) : i % 3 === 1 ? r2(v + dy) : v));
    for (const t of q.texts) { t.x = r2(t.x + dx); t.y = r2(t.y + dy); }
    for (const im of q.images) { im.x = r2(im.x + dx); im.y = r2(im.y + dy); }
  }
  q.w = Math.ceil(Math.max(q.w, x1) + dx + (x1 > q.w ? 16 : 0));
  q.h = Math.ceil(Math.max(q.h, y1) + dy + (y1 > q.h ? 16 : 0));
}

// a, b: Notizbücher. Liefert { notebook, both, onlyA, onlyB }
export async function mergeNotes(a, b, onProgress = () => {}) {
  const [pa, pb] = await Promise.all([store.pagesOf(a), store.pagesOf(b)]);
  const total = pa.length + pb.length;
  let done = 0;
  const prints = async pages => {
    const out = [];
    for (const p of pages) {
      onProgress(`Folien vergleichen: ${++done} von ${total}`, (0.6 * done) / total);
      const s = slideOf(p), blob = s && (await store.getBlob(s.key));
      let fp = null;
      try { fp = blob ? await fingerprint(blob) : null; } catch (err) { console.warn('Folie', p.id, err); }
      out.push(fp && { fp, aspect: s.w / s.h });
    }
    return out;
  };
  const ra = await prints(pa), rb = await prints(pb);
  const plan = align(pa.length, pb.length, candidates(ra, rb));

  const nb = Object.assign(newNotebook({ title: a.title + ' (zusammengeführt)', folderId: a.folderId ?? null, template: a.template || 'blank', color: a.color }),
    { kind: a.kind === 'onenote' && b.kind === 'onenote' ? 'onenote' : 'pdf', thumb: a.thumb || b.thumb || null, order: a.order });
  let both = 0, onlyA = 0, onlyB = 0;
  const pages = [];
  for (const [n, { a: i, b: j }] of plan.entries()) {
    onProgress(`Seiten zusammenstellen: ${n + 1} von ${plan.length}`, 0.6 + (0.4 * (n + 1)) / plan.length);
    if (i >= 0 && j >= 0) {
      // Grundlage: die Seite mit Platz um die Folie (OneNote) – sonst die aus dem ersten Satz
      const [base, other] = !pa[i].bg || pb[j].bg ? [pa[i], pb[j]] : [pb[j], pa[i]];
      const q = await copyPage(base, nb);
      const qs = slideOf(q);
      await overlay(q, qs, other, slideOf(other));
      fitPage(q);
      pages.push(q);
      both++;
    } else {
      pages.push(await copyPage(i >= 0 ? pa[i] : pb[j], nb));
      if (i >= 0) onlyA++; else onlyB++;
    }
  }
  for (const q of pages) await store.put('pages', q);
  nb.pageIds = pages.map(q => q.id);
  await store.put('notebooks', nb);
  return { notebook: nb, both, onlyA, onlyB };
}

// ---------- Dialog (Bibliothek: ⋯ an einer Notiz → „Mit anderer Notiz zusammenführen …“) ----------
export async function mergeDialog(a, notebooks, folders) {
  const byId = new Map(folders.map(f => [f.id, f]));
  const pathOf = id => { const p = []; for (let f = byId.get(id); f && p.length < 20; f = byId.get(f.parentId)) p.unshift(f.name); return p.join(' › ') || 'Oberste Ebene'; };
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, '');
  const others = notebooks.filter(n => n.id !== a.id && n.kind !== 'card' && !n.occl)
    .sort((x, y) => (norm(y.title) === norm(a.title)) - (norm(x.title) === norm(a.title))
      || (y.folderId === a.folderId) - (x.folderId === a.folderId) || (y.updatedAt || 0) - (x.updatedAt || 0))
    .slice(0, 60);
  if (!others.length) { toast('Es gibt keine andere Notiz zum Zusammenführen.'); return null; }
  let pick = others[0].id;
  const list = h('div', { class: 'picks' }, others.map(n => h('label', { class: 'pick' },
    h('input', { type: 'radio', name: 'merge', checked: n.id === pick, onchange: () => { pick = n.id; } }),
    h('span', { class: 'grow' }, h('b', {}, n.title), h('span', { class: 'muted small' }, `${n.pageIds.length} Seiten · ${pathOf(n.folderId)}`)))));
  const ok = await modal({
    title: 'Zusammenführen mit …',
    body: h('div', { class: 'help' },
      h('p', {}, `„${a.title}“ (${a.pageIds.length} Seiten) und die gewählte Notiz werden zu einer neuen Notiz: gleiche Folien nur einmal – mit der Handschrift aus beiden –, Folien und Seiten, die nur in einer vorkommen, an ihrer Stelle dazwischen.`),
      h('p', { class: 'muted small' }, 'Die beiden bisherigen Notizen bleiben unverändert. Wenn das Ergebnis passt, kannst du sie selbst löschen.'),
      list),
    actions: [{ label: 'Abbrechen', value: false }, { label: 'Zusammenführen', value: true, primary: true }],
  });
  if (!ok) return null;
  const b = notebooks.find(n => n.id === pick);
  const pr = progress('Notizen werden zusammengeführt …');
  let res;
  try { res = await mergeNotes(a, b, (t, f) => pr.set(t, f)); }
  catch (err) { console.error(err); toast('Zusammenführen fehlgeschlagen: ' + err.message); return null; }
  finally { pr.close(); }
  const open = await modal({
    title: 'Zusammengeführt',
    body: h('div', { class: 'help' },
      h('p', {}, `Neue Notiz „${res.notebook.title}“ mit ${res.notebook.pageIds.length} Seiten:`),
      h('ul', {},
        h('li', {}, `${res.both} ${res.both === 1 ? 'Folie war' : 'Folien waren'} in beiden – jetzt einmal, mit der Handschrift aus beiden`),
        h('li', {}, `${res.onlyA} ${res.onlyA === 1 ? 'Seite' : 'Seiten'} nur in „${a.title}“`),
        h('li', {}, `${res.onlyB} ${res.onlyB === 1 ? 'Seite' : 'Seiten'} nur in „${b.title}“`)),
      h('p', { class: 'muted small' }, 'Bitte einmal durchblättern. Die alten Notizen sind noch da – löschen erst, wenn alles passt.')),
    actions: [{ label: 'Schließen', value: false }, { label: 'Öffnen', value: true, primary: true }],
  });
  if (open) location.hash = 'nb/' + res.notebook.id;
  return res;
}

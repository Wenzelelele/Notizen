// Volltextsuche in Skripten (kein DOM): Text der PDF-Folien (pdfio.pdfText), getippter Text und Text aus OneNote.
// Handschrift ist nur Strichwerk und wird nicht gefunden. Alles läuft auf dem Gerät – auch im Flugmodus.
//
// Jede Seite wird ein „Dokument“: der Text in vergleichbarer Schreibweise (klein, ohne Akzente, ß → ss) plus
// Rückverweise auf die Textstücke mit ihrer Lage – damit lassen sich Treffer auf der Seite markieren.
import { store, changes } from './store.js';
import { pdfText } from './pdfio.js';

// ---------- Vergleichbare Schreibweise ----------
const foldCache = new Map();
export function foldChar(c) {
  let f = foldCache.get(c);
  if (f == null) {
    if (c === 'ß' || c === 'ẞ') f = 'ss';
    else if (c === '­') f = ''; // weiches Trennzeichen
    else if (/[‐-―−]/.test(c)) f = '-';
    else if (/\s/.test(c)) f = ' ';
    else f = c.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('de'); // ä → a, ﬁ → fi, ² → 2
    foldCache.set(c, f);
  }
  return f;
}
export const fold = s => { let o = ''; for (let i = 0; i < s.length; i++) o += foldChar(s[i]); return o; };
const isWord = c => !!c && /[\p{L}\p{N}]/u.test(c);

// ---------- Seite → Dokument ----------
// items: [text, x, y, b, h, zeilenende] relativ zur Seite (0..1); aspect = Seitenhöhe / Seitenbreite
export function buildDoc(items, aspect = 1.414) {
  const raw = [], rItem = [], rChar = [], norm = [], n2r = [];
  const push = (ch, it, ci) => {
    const r = raw.length;
    raw.push(ch); rItem.push(it); rChar.push(ci);
    for (const x of foldChar(ch)) { norm.push(x); n2r.push(r); }
  };
  const pop = () => {
    const r = raw.length - 1;
    raw.pop(); rItem.pop(); rChar.pop();
    while (n2r.length && n2r[n2r.length - 1] === r) { n2r.pop(); norm.pop(); }
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i], s = it[0];
    for (let c = 0; c < s.length; c++) push(s[c], i, c);
    const nx = items[i + 1];
    if (!nx) break;
    const newLine = it[5] || Math.abs(nx[2] - it[2]) > Math.max(it[4], nx[4]) * 0.5 || nx[1] < it[1] - 0.01;
    if (newLine) {
      // Silbentrennung am Zeilenende („Um-“ / „formen“) wieder zusammenziehen
      if (/[-‐­]\s*$/.test(s) && /^\s*\p{Ll}/u.test(nx[0])) { while (/\s/.test(raw[raw.length - 1])) pop(); pop(); }
      else push('\n', -1, 0);
    } else {
      // Stücke derselben Zeile: Leerzeichen nur bei sichtbarem Abstand (pdf.js zerlegt manchmal mitten im Wort)
      const gap = (nx[1] - (it[1] + it[3])) / aspect; // in Seitenhöhen, wie h
      if (!/\s$/.test(s) && !/^\s/.test(nx[0]) && gap > it[4] * 0.12) push(' ', -1, 0);
    }
  }
  // Überschrift: die größte Schrift im oberen Teil der Seite (bei Folien der Folientitel)
  const titleItems = new Set();
  const hs = items.map(it => it[4]).sort((a, b) => a - b), med = hs[hs.length >> 1] || 0;
  const top = items.filter(it => it[2] < 0.3);
  const maxH = Math.max(0, ...top.map(it => it[4]));
  if (maxH > med * 1.2) items.forEach((it, i) => { if (it[2] < 0.3 && it[4] >= maxH * 0.85) titleItems.add(i); });
  const title = [...titleItems].map(i => items[i][0]).join(' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  return { norm: norm.join(''), n2r: Int32Array.from(n2r), raw: raw.join(''), rItem: Int32Array.from(rItem), rChar: Int32Array.from(rChar), items, title, titleItems };
}

// Getippter Text (auch aus OneNote) als Textstücke – Zeilen, die das Textfeld selbst umbricht, nur ungefähr
function textItems(page) {
  const out = [], W = page.w || 794, H = page.h || 1123;
  for (const t of page.texts || []) {
    const lh = (t.size || 16) * 1.3;
    let off = 0;
    (t.text || '').split('\n').forEach((line, i) => {
      // [7], [8]: Textfeld und Stelle im Text – damit markiert der Editor genau (findui.js, domRects)
      if (line.trim()) out.push([line, t.x / W, (t.y + i * lh) / H, Math.min(t.w || 400, line.length * (t.size || 16) * 0.55) / W, lh / H, 1, 0, t.id, off]);
      off += line.length + 1;
    });
  }
  return out;
}

// PDF-Text im Arbeitsspeicher (die letzten paar PDFs), damit Suchen beim Tippen nicht jedes Mal liest
const pdfMem = new Map();
async function pdfPages(key) {
  if (pdfMem.has(key)) { const v = pdfMem.get(key); pdfMem.delete(key); pdfMem.set(key, v); return v; }
  const v = await pdfText(key).catch(err => { console.warn('PDF-Text', key, err); return null; });
  if (v) { pdfMem.set(key, v); if (pdfMem.size > 12) pdfMem.delete(pdfMem.keys().next().value); }
  return v;
}

// Dokumente zu Seiten (null für fehlende Seiten). onPdf(i, n): Fortschritt beim ersten Lesen der PDFs.
// complete: false, wenn ein PDF (noch) nicht gelesen werden konnte (nicht auf dem Gerät, pdf.js fehlt)
export async function docsFor(pages, onPdf) {
  const keys = [...new Set(pages.filter(p => p?.pdf).map(p => p.pdf.key))];
  const texts = new Map();
  let complete = true;
  for (let i = 0; i < keys.length; i++) {
    onPdf?.(i, keys.length);
    const t = await pdfPages(keys[i]);
    if (!t) complete = false;
    texts.set(keys[i], t);
  }
  const docs = pages.map(p => {
    if (!p || p.missing) return null;
    // PDF-Text: aus dem Original-PDF (page.pdf) oder bei Seiten ohne Original mitgespeichert (page.ptext)
    const items = [...(p.pdf ? texts.get(p.pdf.key)?.[p.pdf.n - 1] || [] : p.ptext || []), ...textItems(p)];
    return buildDoc(items, (p.h || 1123) / (p.w || 794));
  });
  return { docs, complete };
}

// ---------- Index über Notizen (Bibliothek) ----------
// Je Notiz zwischengespeichert, bis sich eine ihrer Seiten oder sie selbst ändert
const nbCache = new Map(); // Notiz-id → { at, pages: [{ i, id, doc }] }
changes.addEventListener('change', e => {
  const { kind, id, nb } = e.detail;
  if (kind === 'notebooks') nbCache.delete(id);
  else if (kind === 'pages') { if (nb) nbCache.delete(nb); else nbCache.clear(); }
});
// nbs: Notizen (ohne Karteikarten). onProgress(text) während PDFs zum ersten Mal gelesen werden.
export async function buildIndex(nbs, onProgress) {
  const notes = [];
  for (let k = 0; k < nbs.length; k++) {
    const nb = nbs[k];
    let e = nbCache.get(nb.id);
    if (!e || e.at !== nb.updatedAt) {
      const pages = await store.getMany('pages', nb.pageIds || []);
      const { docs, complete } = await docsFor(pages, () => onProgress?.(`„${nb.title}“ wird durchsuchbar gemacht … (${k + 1} von ${nbs.length})`));
      e = { at: nb.updatedAt, pages: docs.map((doc, i) => doc && doc.norm.trim() ? { i, id: pages[i].id, doc } : null).filter(Boolean) };
      if (complete) nbCache.set(nb.id, e);
    }
    notes.push({ nb, pages: e.pages });
  }
  return { notes, vocab: null };
}

// ---------- Suchen ----------
// Wörter der Suche; jedes muss auf der Seite vorkommen (auch als Wortteil: „zieh“ findet „Tiefziehen“)
export function parseQuery(q) {
  return q.trim().split(/\s+/).map(w => fold(w).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean)
    // ph/f: Stereolithographie = Stereolithografie, Photopolymer = Fotopolymer
    .map(w => ({ w, alts: [...new Set([w, w.replace(/ph/g, 'f'), w.replace(/f/g, 'ph')])], how: 'exact' }));
}
function occ(norm, a, out, k, max = 300) {
  for (let i = norm.indexOf(a); i >= 0 && out.length < max; i = norm.indexOf(a, i + 1)) out.push({ a: i, b: i + a.length, k });
}
// Treffer einer Seite oder null, wenn ein Wort fehlt
// any: es genügt eines der Wörter (wenn keine Seite alle hat); jedes gefundene Wort zählt dann viel
export function matchDoc(doc, terms, any = false) {
  const hits = [];
  let score = 0, found = 0;
  for (let k = 0; k < terms.length; k++) {
    const mine = [];
    for (const a of terms[k].alts) occ(doc.norm, a, mine, k);
    if (!mine.length) { if (any) continue; return null; }
    found++;
    let s = 0;
    for (const x of mine) {
      s += 1 + (isWord(doc.norm[x.a - 1]) ? 0 : 0.5) + (doc.titleItems.has(doc.rItem[doc.n2r[x.a]]) ? 6 : 0);
    }
    score += Math.min(s, 14) + (any ? 20 : 0);
    hits.push(...mine);
  }
  if (!found) return null;
  hits.sort((x, y) => x.a - y.a || x.k - y.k);
  // mehrere Wörter direkt hintereinander (wie gesucht): deutlich besser
  for (let i = 0; i < hits.length - 1; i++) {
    const x = hits[i], y = hits[i + 1];
    if (y.k === x.k + 1 && y.a >= x.b && y.a - x.b <= 3) score += 4;
  }
  return { hits, score };
}

// Ähnliche Wörter bei Tippfehlern: kleinster Editierabstand des Suchworts zu einem beliebigen Wortteil
function approxDist(p, t, k) {
  const m = p.length;
  let prev = new Array(m + 1), cur = new Array(m + 1), best = m;
  for (let i = 0; i <= m; i++) prev[i] = i;
  for (let j = 1; j <= t.length; j++) {
    cur[0] = 0; // Anfang im Wort ist frei
    for (let i = 1; i <= m; i++) cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (p[i - 1] === t[j - 1] ? 0 : 1));
    if (cur[m] < best) best = cur[m];
    [prev, cur] = [cur, prev];
  }
  return best <= k ? best : k + 1;
}
function vocabOf(index) {
  if (index.vocab) return index.vocab;
  const v = new Map();
  for (const n of index.notes) for (const p of n.pages) for (const m of p.doc.norm.matchAll(/[\p{L}\p{N}]{3,}/gu)) v.set(m[0], (v.get(m[0]) || 0) + 1);
  return (index.vocab = v);
}
const anyHit = (index, alts) => index.notes.some(n => n.pages.some(p => alts.some(a => p.doc.norm.includes(a))));
// Wörter ohne Treffer: erst ae/oe/ue → ä/ö/ü, dann ähnliche Schreibweisen
function widen(index, terms) {
  for (const t of terms) {
    if (anyHit(index, t.alts)) continue;
    const um = t.w.replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u');
    if (um !== t.w && anyHit(index, [um])) { t.alts = [um]; continue; }
    if (t.w.length < 4) continue;
    const k = t.w.length >= 8 ? 2 : 1, cand = [];
    for (const [tok, n] of vocabOf(index)) {
      if (tok.length < t.w.length - k) continue;
      const d = approxDist(t.w, tok, k);
      if (d <= k) cand.push({ tok, d, n });
    }
    cand.sort((a, b) => a.d - b.d || b.n - a.n);
    if (cand.length) { t.alts = cand.slice(0, 6).map(c => c.tok); t.how = 'fuzzy'; }
  }
  return terms;
}

// Ergebnis: Gruppen je Notiz (beste zuerst), darin die Seiten in Seitenreihenfolge
export function search(index, query) {
  const terms = widen(index, parseQuery(query));
  if (!terms.length) return { terms, groups: [], total: 0 };
  const res = collect(index, terms, false);
  // keine Seite mit allen Wörtern: Seiten mit möglichst vielen davon
  if (!res.groups.length && terms.length > 1) return { ...collect(index, terms, true), partial: true };
  return res;
}
function collect(index, terms, any) {
  const groups = [];
  let total = 0;
  for (const n of index.notes) {
    const pages = [];
    for (const p of n.pages) {
      const m = matchDoc(p.doc, terms, any);
      if (m) pages.push({ ...p, ...m });
    }
    if (!pages.length) continue;
    total += pages.length;
    groups.push({ nb: n.nb, pages, best: Math.max(...pages.map(p => p.score)), sum: pages.reduce((a, p) => a + p.score, 0) });
  }
  groups.sort((a, b) => b.best - a.best || b.sum - a.sum);
  return { terms, groups, total, partial: false };
}

// Treffer auf der Seite als Rechtecke (relativ zur Seite, 0..1).
// exact(item, c0, c1): genaue Rechtecke für ein Textstück, falls bekannt (getippter Text im Editor), sonst null
export function hitRects(doc, hit, exact = null) {
  const by = new Map();
  for (let n = hit.a; n < hit.b; n++) {
    const r = doc.n2r[n], it = doc.rItem[r];
    if (it < 0) continue;
    const c = doc.rChar[r], e = by.get(it);
    if (!e) by.set(it, [c, c]); else { e[0] = Math.min(e[0], c); e[1] = Math.max(e[1], c); }
  }
  return [...by].flatMap(([it, [c0, c1]]) => {
    const I = doc.items[it], L = I[0].length || 1;
    return exact?.(I, c0, c1) || [{ x: I[1] + (I[3] * c0) / L, y: I[2], w: (I[3] * (c1 - c0 + 1)) / L, h: I[4] }];
  });
}

// Textausschnitt um den ersten Treffer: [{ t, m }] (m = markiert)
export function snippet(doc, hits, before = 60, after = 110) {
  const R = h => [doc.n2r[h.a], doc.n2r[h.b - 1] + 1];
  // die Überschrift steht schon über dem Ausschnitt: lieber eine Stelle im Folientext zeigen
  const first = hits.find(h => !doc.titleItems.has(doc.rItem[doc.n2r[h.a]])) || hits[0];
  const [r0, r1] = R(first), raw = doc.raw;
  let s = Math.max(0, r0 - before), e = Math.min(raw.length, r1 + after);
  if (s > 0) { const sp = raw.slice(s, r0).search(/\s/); if (sp >= 0) s += sp + 1; }
  if (e < raw.length) { const sp = raw.lastIndexOf(' ', e); if (sp > r1) e = sp; }
  const marks = hits.map(R).filter(([a, b]) => a >= s && b <= e).sort((x, y) => x[0] - y[0]);
  const parts = [];
  let at = s;
  for (const [a, b] of marks) {
    if (a < at) continue;
    if (a > at) parts.push({ t: raw.slice(at, a) });
    parts.push({ t: raw.slice(a, b), m: true });
    at = b;
  }
  if (at < e) parts.push({ t: raw.slice(at, e) });
  for (const p of parts) p.t = p.t.replace(/\s+/g, ' ');
  if (s > 0) parts.unshift({ t: '… ' });
  if (e < raw.length) parts.push({ t: ' …' });
  return parts;
}

// ---------- Stichwortverzeichnis ----------
// Fachbegriffe: großgeschriebene Wörter ab 5 Buchstaben und Abkürzungen (CNC, WIG), ohne Füllwörter und ohne
// das, was in einem Skript auf fast jeder Folie steht (Fußzeile, Name der Vorlesung). Wichtig = steht in einer
// Überschrift oder auf mehreren Seiten.
const STOP = new Set(('aber abbildung abb agenda allerdings also anhand anschliessend aufgabe aufgaben ausserdem '
  + 'beispiel beispiele beim bitte bild bilder dabei dadurch daher damit danach dann darauf daraus darstellung deren '
  + 'dessen diese dieser dieses durch eigene einer eines einsatz ende erste ersten fazit folie folien fragen frage gibt '
  + 'grundsatzlich hier hierbei hinweis hochschule inhalt inhalte jedoch kapitel konnen literatur lernziele mithilfe '
  + 'nach nachteile neben oder ohne quelle quellen seite seiten somit sowie tabelle teil uber ubersicht unter vorteile '
  + 'vorlesung welche welcher welches wenn werden wichtig wird zudem zusammenfassung zwischen zwei drei dies '
  + 'innsbruck universitatsstrasse unternehmerische warum wieso weshalb wozu alternativ einfuhrung motivation ziele '
  + 'zunachst insgesamt jeweils weitere weiteren meist stark bachelor by-sa cc lizenz creative commons').split(' '));
export function keywords(index, max = 600) {
  const terms = new Map(); // Schlüssel → { forms, pages: Set, heads, perNote: Map }
  // Wörter, die auch klein vorkommen, sind meist keine Nomen (großgeschrieben nur am Satzanfang: „Flüssige …“)
  const lower = new Map();
  for (const n of index.notes) for (const p of n.pages) for (const m of p.doc.raw.matchAll(/(?<![\p{L}\p{N}-])\p{Ll}[\p{L}\p{N}]{4,}/gu)) { const k = fold(m[0]); lower.set(k, (lower.get(k) || 0) + 1); }
  index.notes.forEach((n, ni) => {
    for (const p of n.pages) {
      const seen = new Set();
      for (const m of p.doc.raw.matchAll(/\p{L}[\p{L}\p{N}]*(?:-[\p{L}\p{N}]+)*/gu)) {
        const w = m[0];
        const acr = w.length >= 2 && w.length <= 6 && /^[\p{Lu}\p{N}-]+$/u.test(w) && /\p{Lu}.*\p{Lu}/u.test(w);
        const noun = w.length >= 5 && /^\p{Lu}\p{Ll}/u.test(w);
        if (!acr && !noun) continue;
        const key = fold(w);
        if (STOP.has(key) || (!acr && lower.has(key))) continue;
        let t = terms.get(key);
        if (!t) terms.set(key, t = { key, forms: new Map(), pages: new Set(), heads: 0, perNote: new Map() });
        t.forms.set(w, (t.forms.get(w) || 0) + 1);
        const ref = ni + ':' + p.i;
        if (!seen.has(key)) {
          seen.add(key);
          t.pages.add(ref);
          t.perNote.set(ni, (t.perNote.get(ni) || 0) + 1);
        }
        // Position im Rohtext → Textstück: Überschrift?
        if (p.doc.titleItems.size && p.doc.titleItems.has(p.doc.rItem[m.index])) t.heads++;
      }
    }
  });
  // Fußzeilen u. Ä.: in einem Skript (ab 6 Seiten) auf mehr als der Hälfte der Seiten
  for (const [key, t] of terms) {
    for (const [ni, c] of t.perNote) {
      const np = index.notes[ni].pages.length;
      if (np >= 6 && c > np * 0.5) { terms.delete(key); break; }
    }
  }
  // Einzahl/Mehrzahl zusammenlegen (Werkzeug/Werkzeuge, Verfahren/Verfahrens)
  for (const [key, t] of terms) {
    const m = key.match(/^(.{4,}?)(en|es|e|n|s|er)$/);
    const base = m && terms.get(m[1]);
    if (base && base !== t) {
      for (const [f, c] of t.forms) base.forms.set(f, (base.forms.get(f) || 0) + c);
      for (const r of t.pages) base.pages.add(r);
      base.heads += t.heads;
      terms.delete(key);
    }
  }
  const list = [...terms.values()]
    .map(t => ({ key: t.key, term: [...t.forms].sort((a, b) => b[1] - a[1])[0][0], pages: t.pages.size, heads: t.heads }))
    .filter(t => t.heads > 0 || t.pages >= 2)
    .sort((a, b) => b.heads * 3 + b.pages - (a.heads * 3 + a.pages))
    .slice(0, max);
  return list.sort((a, b) => a.term.localeCompare(b.term, 'de', { sensitivity: 'base' }));
}

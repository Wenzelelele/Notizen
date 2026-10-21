// Lange Seiten (OneNote: eine „Rolle“ mit oft 50–100 Folien untereinander) in einzelne Seiten aufteilen.
// Geschnitten wird zwischen den Folien (bzw. Bildzeilen) und in langen Bereichen nur mit Handschrift an
// möglichst leeren Stellen. Striche, Texte und Bilder bleiben unverändert erhalten, nur verschoben;
// jede neue Seite ist so groß wie ihr Inhalt.
import { store, uid } from './store.js';
import { strokeBBox } from './ink.js';
import { confirmDialog, progress, toast } from './ui.js';

const GAP_EDGE = 6; // Abstand des Schnitts zur nächsten Folie

// Lohnt sich das Aufteilen? (keine PDF-Seite mit Hintergrundbild, deutlich länger als breit)
export function isLongPage(p) {
  return !p.bg && p.h > 2.2 * Math.min(p.w, 2000) && p.h > 2400;
}

function textBox(t) {
  const lines = String(t.text || '').split('\n').length;
  return { x: t.x, y: t.y, w: t.w || 200, h: lines * (t.size || 16) * 1.3 };
}

// Schnittpositionen (y-Werte) für eine Seite
export function planCuts(page) {
  const boxes = page.strokes.map(s => strokeBBox(s)).concat(page.texts.map(textBox));
  // Bildzeilen: Bilder mit überlappender Höhe gehören zusammen (z. B. zwei Folien nebeneinander)
  const rows = [];
  for (const im of [...(page.images || [])].sort((a, b) => a.y - b.y)) {
    const last = rows[rows.length - 1];
    if (last && im.y < last.b - 1) last.b = Math.max(last.b, im.y + im.h);
    else rows.push({ t: im.y, b: im.y + im.h });
  }
  // Zielhöhe für Bereiche nur mit Handschrift: etwa A4 im Verhältnis zur Schriftbreite
  const rights = boxes.map(b => b.x + b.w).sort((a, b) => a - b);
  const lefts = boxes.map(b => b.x).sort((a, b) => a - b);
  const cw = rights.length ? rights[Math.floor(rights.length * 0.9)] - lefts[Math.floor(lefts.length * 0.1)] : page.w;
  const T = Math.min(2400, Math.max(1100, Math.min(cw, page.w) * 1.414));

  // Anzahl der Striche/Texte, die eine waagerechte Linie bei y schneiden würde:
  // (begonnen vor y) − (beendet bis y), beides per binärer Suche in sortierten Listen
  const starts = boxes.map(b => b.y).sort((a, b) => a - b);
  const ends = boxes.map(b => b.y + b.h).sort((a, b) => a - b);
  const below = (arr, y, strict) => { // wie viele Werte < y (strict) bzw. ≤ y
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (strict ? arr[m] < y : arr[m] <= y) lo = m + 1; else hi = m; }
    return lo;
  };
  const crossings = y => below(starts, y, true) - below(ends, y, false);
  // beste Schnittstelle in [a, b]: möglichst wenige geschnittene Striche, bei Gleichstand möglichst weit unten
  // (Notizen unter einer Folie bleiben bei ihr) bzw. in der Mitte einer leeren Lücke
  function bestCut(a, b, preferLow) {
    if (b - a < 1) return (a + b) / 2;
    const steps = Math.min(120, Math.max(8, Math.round((b - a) / 4)));
    let best = null;
    const counts = [];
    for (let i = 0; i <= steps; i++) counts.push(crossings(a + ((b - a) * i) / steps));
    const min = Math.min(...counts);
    if (preferLow) {
      for (let i = steps; i >= 0; i--) if (counts[i] === min) { best = a + ((b - a) * i) / steps; break; }
    } else { // Mitte des längsten Abschnitts mit den wenigsten Überschneidungen
      let run = 0, bestRun = 0, end = 0;
      for (let i = 0; i <= steps; i++) {
        run = counts[i] === min ? run + 1 : 0;
        if (run > bestRun) { bestRun = run; end = i; }
      }
      best = a + ((b - a) * (end - (bestRun - 1) / 2)) / steps;
    }
    return best;
  }

  // 1) zwischen den Bildzeilen schneiden
  const cuts = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i].b, b = rows[i + 1].t - GAP_EDGE;
    cuts.push(b > a ? bestCut(a, b, true) : (rows[i].b + rows[i + 1].t) / 2);
  }
  // 2) lange Bereiche ohne Bilder zusätzlich an leeren Stellen teilen (z. B. Rechnungen unter der letzten Folie)
  const bounds = [0, ...cuts, page.h];
  const extra = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const s = bounds[i], e = bounds[i + 1];
    const row = rows.find(r => r.t >= s - 1 && r.b <= e + 1);
    let pos = s;
    while (e - pos > 1.35 * T) {
      let a = pos + 0.65 * T, b = pos + 1.35 * T;
      if (row && row.b > a && row.t < b) { a = Math.max(a, row.b); b = Math.max(b, row.b + 0.7 * T); } // nie durch eine Folie
      b = Math.min(b, e - 0.3 * T);
      if (b <= a) break;
      const c = bestCut(a, b, false);
      extra.push(c);
      pos = c;
    }
  }
  return [...cuts, ...extra].sort((a, b) => a - b);
}

// Teile einer Seite als fertige Seiten-Objekte (neue ids; Striche/Bilder/Texte nach oben verschoben)
export function splitPage(page) {
  const cuts = planCuts(page);
  if (!cuts.length) return [page];
  const bounds = [0, ...cuts, page.h];
  const parts = bounds.slice(0, -1).map((t, i) => ({ t, b: bounds[i + 1], strokes: [], texts: [], images: [], top: t, bottom: bounds[i + 1], right: 0 }));
  const partAt = y => parts[Math.max(0, bounds.findIndex((b, i) => i > 0 && y < b) - 1)] || parts[parts.length - 1];
  const put = (list, item, box) => {
    const p = partAt(box.y + box.h / 2);
    p[list].push(item);
    p.top = Math.min(p.top, box.y);
    p.bottom = Math.max(p.bottom, box.y + box.h);
    p.right = Math.max(p.right, box.x + box.w);
  };
  for (const s of page.strokes) put('strokes', s, strokeBBox(s));
  for (const t of page.texts) put('texts', t, textBox(t));
  for (const im of page.images || []) put('images', im, im);
  return parts
    .filter(p => p.strokes.length || p.texts.length || p.images.length)
    .map(p => {
      const dy = -p.top;
      return {
        ...page,
        id: uid(),
        w: Math.round(Math.min(page.w, Math.max(Math.min(page.w, 794), p.right + 48))),
        h: Math.round(p.bottom - p.top + 24),
        strokes: p.strokes.map(s => ({ ...s, pts: s.pts.map((v, i) => (i % 3 === 1 ? Math.round((v + dy) * 100) / 100 : v)) })),
        texts: p.texts.map(t => ({ ...t, y: Math.round((t.y + dy) * 100) / 100 })),
        images: p.images.map(im => ({ ...im, y: Math.round((im.y + dy) * 100) / 100 })),
      };
    });
}

// Eine Notiz aufteilen: jede lange Seite wird durch ihre Teile ersetzt. Gibt die Zahl neuer Seiten zurück.
// Bilder bleiben dieselben Dateien (nur die Seiten verweisen neu darauf) – nichts wird doppelt hochgeladen.
export async function splitNote(nb) {
  const pages = await store.pagesOf(nb);
  const ids = [];
  let added = 0;
  const gone = [];
  for (const p of pages) {
    const parts = isLongPage(p) ? splitPage(p) : [p];
    if (parts.length < 2) { ids.push(p.id); continue; }
    for (const q of parts) await store.put('pages', q);
    ids.push(...parts.map(q => q.id));
    gone.push(p.id);
    added += parts.length - 1;
  }
  if (!gone.length) return 0;
  nb.pageIds = ids;
  await store.put('notebooks', nb);
  for (const id of gone) await store.del('pages', id); // Seite löschen, ihre Bilder aber behalten
  return added;
}

// Mit Rückfrage: erst zählen, was entstehen würde, dann aufteilen. true, wenn etwas aufgeteilt wurde.
export async function splitDialog(notes) {
  notes = notes.filter(n => n.kind !== 'card' && !n.occl);
  let pr = progress('Lange Seiten werden gesucht …');
  const todo = [];
  let longPages = 0, newPages = 0;
  try {
    for (const [i, nb] of notes.entries()) {
      pr.set(nb.title, i / Math.max(1, notes.length));
      let parts = 0, n = 0;
      for (const p of await store.pagesOf(nb)) {
        if (!isLongPage(p)) continue;
        const c = planCuts(p).length;
        if (c) { n++; parts += c + 1; }
      }
      if (n) { todo.push(nb); longPages += n; newPages += parts; }
    }
  } finally { pr.close(); }
  if (!todo.length) { toast('Keine langen Seiten zum Aufteilen gefunden.'); return false; }
  const what = todo.length === 1 ? `„${todo[0].title}“` : `${todo.length} Notizen`;
  const ok = await confirmDialog('In Seiten aufteilen?',
    `${what}: ${longPages === 1 ? 'Die lange Seite wird' : longPages + ' lange Seiten werden'} in insgesamt ${newPages} einzelne Seiten aufgeteilt – zwischen den Folien bzw. an leeren Stellen. Handschrift, Bilder und Texte bleiben vollständig erhalten. Danach kannst du an jeder Stelle Seiten einfügen.`,
    'Aufteilen');
  if (!ok) return false;
  pr = progress('Seiten werden aufgeteilt …');
  let added = 0;
  try {
    for (const [i, nb] of todo.entries()) {
      pr.set(nb.title, i / todo.length);
      added += await splitNote(nb);
    }
  } catch (err) {
    console.error(err);
    toast('Aufteilen fehlgeschlagen: ' + err.message);
  } finally { pr.close(); }
  if (added) toast(`Fertig – ${added + longPages} Seiten statt ${longPages}`);
  return added > 0;
}

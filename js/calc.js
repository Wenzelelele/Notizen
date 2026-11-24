// Handschriftliche Rechnungen erkennen und ausrechnen – ohne Netz und ohne Bibliothek.
// 1) segment: Striche einer Lasso-Auswahl in Zeilen und Zeichen aufteilen
// 2) Zeichen erkennen: Punkte, Komma, Minus, „=“, „:“ nach Größe und Lage in der Zeile; Ziffern, +, ×, Klammern,
//    / und ^ mit dem $P-Erkenner (Vatavu, Anthony, Wobbrock 2012): Jedes Zeichen wird zu einer Wolke aus 32 Punkten,
//    verglichen mit eingebauten Vorlagen und den Vorlagen, die der Benutzer selbst geschrieben hat. Strichreihenfolge
//    und Schreibrichtung sind dabei egal.
// 3) evaluate: Ausdruck auswerten (Punkt vor Strich, Klammern, Potenzen, Komma als Dezimalzeichen)
// Bewusst ohne DOM: läuft auch unter Node (Tests).

const N = 32;

// ---------- $P ----------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function pathLen(P) {
  let d = 0;
  for (let i = 1; i < P.length; i++) if (P[i].id === P[i - 1].id) d += dist(P[i - 1], P[i]);
  return d;
}
function resample(P, n) {
  P = P.slice();
  const len = pathLen(P);
  if (len < 1e-6) return Array.from({ length: n }, () => ({ ...P[0] }));
  const I = len / (n - 1), out = [P[0]];
  let D = 0;
  for (let i = 1; i < P.length; i++) {
    if (P[i].id !== P[i - 1].id) continue;
    const d = dist(P[i - 1], P[i]);
    if (d > 0 && D + d >= I) {
      const t = (I - D) / d;
      const q = { x: P[i - 1].x + t * (P[i].x - P[i - 1].x), y: P[i - 1].y + t * (P[i].y - P[i - 1].y), id: P[i].id };
      out.push(q);
      P.splice(i, 0, q);
      D = 0;
    } else D += d;
  }
  while (out.length < n) out.push({ ...P[P.length - 1] });
  return out.slice(0, n);
}
function normalize(P) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of P) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const s = Math.max(x1 - x0, y1 - y0) || 1;
  let cx = 0, cy = 0;
  const Q = P.map(p => ({ x: (p.x - x0) / s, y: (p.y - y0) / s }));
  for (const q of Q) { cx += q.x; cy += q.y; }
  cx /= Q.length; cy /= Q.length;
  return Q.map(q => ({ x: q.x - cx, y: q.y - cy }));
}
// strokes: [[[x, y], …], …] → Punktwolke
export function cloudOf(strokes) {
  const P = [];
  strokes.forEach((s, id) => { for (const [x, y] of s) P.push({ x, y, id }); });
  return normalize(resample(P, N));
}
function cloudDist(A, B, start) {
  const n = A.length, used = new Uint8Array(n);
  let sum = 0, i = start;
  do {
    let min = Infinity, idx = -1;
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const d = (A[i].x - B[j].x) ** 2 + (A[i].y - B[j].y) ** 2;
      if (d < min) { min = d; idx = j; }
    }
    used[idx] = 1;
    sum += (1 - ((i - start + n) % n) / n) * Math.sqrt(min);
    i = (i + 1) % n;
  } while (i !== start);
  return sum;
}
function match(A, B) {
  const step = Math.floor(Math.sqrt(N));
  let m = Infinity;
  for (let i = 0; i < N; i += step) m = Math.min(m, cloudDist(A, B, i), cloudDist(B, A, i));
  return m;
}

// ---------- eingebaute Vorlagen (Koordinaten etwa 0–60 breit, 0–100 hoch, y nach unten) ----------
function curve(P, k = 6) { // Catmull-Rom: Stützpunkte → glatte Linie
  if (P.length < 3) return P;
  const out = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(c => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3)));
    }
  }
  out.push(P[P.length - 1]);
  return out;
}
const ellipse = (cx, cy, rx, ry, from = -Math.PI / 2) => Array.from({ length: 33 }, (_, i) => { const a = from - (i / 32) * Math.PI * 2; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]; });
const C = (...P) => curve(P), L = (...P) => P;
const BUILTIN = {
  '0': [[ellipse(30, 50, 27, 48)], [ellipse(30, 50, 20, 48)]],
  '1': [[L([30, 0], [30, 100])], [L([8, 24], [30, 0], [30, 100])], [L([8, 24], [30, 0], [30, 100]), L([10, 100], [50, 100])]],
  '2': [[C([5, 25], [14, 6], [32, 0], [50, 10], [54, 28], [44, 48], [24, 70], [4, 100], [58, 100])],
    [C([6, 18], [22, 2], [42, 2], [54, 18], [50, 40], [4, 100]), L([4, 100], [58, 98])]],
  '3': [[C([5, 12], [22, 0], [42, 2], [54, 15], [50, 32], [30, 45], [50, 55], [58, 72], [52, 90], [32, 100], [12, 98], [2, 88])],
    [L([4, 2], [56, 2], [28, 40]), C([28, 40], [50, 50], [58, 72], [50, 92], [28, 100], [4, 90])]],
  '4': [[L([40, 0], [2, 68], [58, 68]), L([44, 35], [44, 100])], [L([15, 0], [5, 60], [58, 60]), L([45, 10], [45, 100])],
    [L([44, 100], [44, 0], [2, 68], [58, 68])]],
  '5': [[C([55, 0], [12, 0]), C([12, 0], [8, 42]), C([8, 42], [30, 36], [50, 44], [58, 65], [52, 88], [32, 100], [12, 96], [2, 86])],
    [C([12, 0], [8, 42], [30, 36], [50, 44], [58, 65], [52, 88], [32, 100], [12, 96], [2, 86]), L([12, 0], [55, 0])]],
  '6': [[C([50, 2], [30, 8], [12, 28], [4, 55], [6, 80], [20, 97], [38, 100], [54, 88], [56, 70], [44, 56], [26, 54], [8, 66])]],
  '7': [[L([2, 0], [58, 0], [25, 100])], [L([2, 0], [58, 0], [25, 100]), L([15, 52], [50, 52])], [L([2, 14], [6, 0], [58, 0], [28, 100])]],
  '8': [[C([48, 14], [30, 0], [10, 8], [10, 26], [30, 44], [52, 62], [56, 84], [38, 100], [18, 100], [4, 84], [10, 64], [30, 44], [50, 28], [48, 10], [32, 0])]],
  '9': [[C([54, 22], [42, 3], [24, 1], [8, 12], [6, 30], [20, 44], [40, 42], [54, 28], [56, 55], [50, 100])],
    [ellipse(30, 24, 24, 22, 0), L([54, 20], [52, 100])]],
  '+': [[L([30, 0], [30, 60]), L([0, 30], [60, 30])]],
  '·': [[L([0, 0], [50, 50]), L([50, 0], [0, 50])]], // × (Mal-Kreuz)
  '(': [[C([30, 0], [10, 25], [4, 50], [10, 75], [30, 100])]],
  ')': [[C([0, 0], [20, 25], [26, 50], [20, 75], [0, 100])]],
  '/': [[L([50, 0], [0, 100])]],
  '^': [[L([0, 40], [20, 0], [40, 40])]],
};
export const LEARNABLE = Object.keys(BUILTIN);
let builtin = null;
const builtinClouds = () => (builtin ??= Object.entries(BUILTIN).flatMap(([c, vs]) => vs.map(v => ({ c, cloud: cloudOf(v), user: false }))));

// user: [{ c, p: [x, y, x, y, …] }] (gespeicherte Punktwolken)
function classify(strokes, user) {
  const A = cloudOf(strokes);
  const best = new Map();
  for (const t of builtinClouds()) best.set(t.c, Math.min(best.get(t.c) ?? Infinity, match(A, t.cloud)));
  for (const u of user) {
    if (!u.cloud) { const Q = []; for (let i = 0; i < u.p.length; i += 2) Q.push({ x: u.p[i], y: u.p[i + 1] }); Object.defineProperty(u, 'cloud', { value: Q }); }
    best.set(u.c, Math.min(best.get(u.c) ?? Infinity, match(A, u.cloud) * 0.9)); // eigene Schrift zählt etwas mehr
  }
  return [...best].sort((a, b) => a[1] - b[1]);
}
// Punktwolke zum Speichern (gerundet)
export const flatCloud = strokes => cloudOf(strokes).flatMap(q => [Math.round(q.x * 1000) / 1000, Math.round(q.y * 1000) / 1000]);

// ---------- Zeilen und Zeichen ----------
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
function box(items) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const it of items) { b.x0 = Math.min(b.x0, it.x0); b.y0 = Math.min(b.y0, it.y0); b.x1 = Math.max(b.x1, it.x1); b.y1 = Math.max(b.y1, it.y1); }
  b.w = b.x1 - b.x0; b.h = b.y1 - b.y0; b.cx = (b.x0 + b.x1) / 2; b.cy = (b.y0 + b.y1) / 2;
  return b;
}

// strokes: Striche der Seite ({ pts: [x, y, druck, …] }). Ergebnis: Zeilen von oben nach unten, je Zeile die Zeichen
// von links nach rechts: { strokes, box, c (erkannt), choices (Alternativen), sup (hochgestellt), tiny }
export function recognize(strokes, user = []) {
  const items = strokes.filter(s => s.pts?.length >= 3).map(s => {
    const P = [];
    for (let i = 0; i < s.pts.length; i += 3) P.push([s.pts[i], s.pts[i + 1]]);
    return { P, ...box(P.map(([x, y]) => ({ x0: x, y0: y, x1: x, y1: y }))) };
  });
  if (!items.length) return [];
  const charH = Math.max(1, [...items.map(i => i.h)].sort((a, b) => a - b)[Math.floor(items.length * 0.75)] || 1);

  // Zeilen: hohe Striche legen sie fest, kleinere kommen zur nächstgelegenen
  const lines = [];
  for (const it of [...items].sort((a, b) => b.h - a.h)) {
    let best = null, bd = Infinity;
    for (const l of lines) {
      if (it.cy < l.y0 - 0.3 * charH || it.cy > l.y1 + 0.3 * charH) continue;
      const d = Math.abs(it.cy - (l.y0 + l.y1) / 2);
      if (d < bd) { bd = d; best = l; }
    }
    if (!best) lines.push(best = { items: [], y0: it.y0, y1: it.y1 });
    best.items.push(it);
    best.y0 = Math.min(best.y0, it.y0);
    best.y1 = Math.max(best.y1, it.y1);
  }
  lines.sort((a, b) => a.y0 + a.y1 - b.y0 - b.y1);
  return lines.map(l => line(l.items, user));
}

function line(items, user) {
  // Bezugshöhe: Ober- und Unterkante der großen Zeichen (Ziffern)
  const maxH = Math.max(...items.map(i => i.h));
  const tall = items.filter(i => i.h >= 0.55 * maxH);
  let top = median(tall.map(i => i.y0)), bot = median(tall.map(i => i.y1));
  if (bot - top < 0.3 * maxH) { top = Math.min(...items.map(i => i.y0)); bot = top + maxH; }
  const lh = Math.max(1, bot - top);
  const tinyOf = b => Math.max(b.w, b.h) < 0.25 * lh;
  // Komma: klein, eher senkrecht als waagerecht, ganz in der unteren Hälfte (nicht der untere Strich von „=“)
  const lowOf = b => Math.max(b.w, b.h) < 0.45 * lh && b.h > 0.6 * b.w && b.y0 > top + 0.5 * lh;
  // Zeichen: Striche, die sich waagerecht deutlich überlappen, gehören zusammen (+, =, 4, 5, 7 mit Querstrich …)
  const groups = [];
  const joins = (g, it) => {
    if (tinyOf(g) !== tinyOf(it)) return false; // Punkt nie an eine Ziffer hängen
    if (tinyOf(it)) return Math.abs(g.cx - it.cx) < 0.25 * lh; // zwei Punkte übereinander: „:“
    if (!tinyOf(it) && lowOf(g) !== lowOf(it)) return false; // Komma ebenso
    const ov = Math.min(g.x1, it.x1) - Math.max(g.x0, it.x0);
    const wMin = Math.max(Math.min(g.w, it.w), 0.25 * lh);
    if (ov > 0.5 * wMin) return true;
    const [n, w] = g.w < it.w ? [g, it] : [it, g]; // Mitte des schmaleren innerhalb des breiteren
    return n.cx > w.x0 + 0.1 * w.w && n.cx < w.x1 - 0.1 * w.w;
  };
  for (const it of [...items].sort((a, b) => a.x0 - b.x0)) {
    const g = groups.slice(-2).reverse().find(gr => joins(gr, it));
    if (g) { g.items.push(it); Object.assign(g, box(g.items), { items: g.items }); }
    else groups.push({ items: [it], ...box([it]) });
  }
  groups.sort((a, b) => a.cx - b.cx);

  const mid = top + lh / 2;
  const syms = groups.map(g => {
    const strokes = g.items.map(i => i.P), n = g.items.length, tiny = tinyOf(g);
    const flat = i => i.h <= 0.35 * Math.max(i.w, 1e-6) && i.w > 0.2 * lh;
    let c = null, choices = [];
    if (n >= 2 && g.items.every(i => tinyOf(i))) c = ':';
    else if (tiny) c = g.cy > top + 0.65 * lh ? ',' : '·'; // Punkt unten: Dezimalzeichen, in der Mitte: mal
    else if (n === 2 && g.items.every(flat) && Math.abs(g.items[0].cy - g.items[1].cy) > 0.1 * lh) c = '=';
    else if (n === 3 && g.items.filter(flat).length === 1 && g.items.filter(i => tinyOf(i)).length === 2) c = ':'; // ÷
    else if (n === 1 && flat(g.items[0]) && g.w > 0.2 * lh && g.h <= 0.3 * g.w) c = '-';
    else if (n === 1 && lowOf(g)) c = ',';
    else {
      const r = classify(strokes, user);
      c = r[0][0];
      choices = r.slice(0, 4).map(x => x[0]);
    }
    const sup = /[0-9()]/.test(c) && g.y1 < top + 0.55 * lh && g.h < 0.75 * lh;
    return { strokes, box: { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 }, c, choices, sup, tiny, mid };
  });
  const b = box(groups);
  return { syms, top, lh, box: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } };
}

// Ausdruck aus den Zeichen einer Zeile; hochgestellte Zeichen werden zur Potenz
export function exprOf(syms) {
  let s = '', sup = false;
  for (const y of syms) {
    if (!y.c) continue;
    if (y.sup && !sup) { s += '^('; sup = true; } else if (!y.sup && sup) { s += ')'; sup = false; }
    s += y.c;
  }
  if (sup) s += ')';
  return s.replace(/\^\((\d)\)/g, '^$1');
}

// ---------- Auswerten ----------
// Ergebnis: { value } | { error } | { empty: true }. Alles ab dem ersten „=“ wird ignoriert (steht da schon ein Ergebnis).
export function evaluate(src) {
  const s = String(src).split('=')[0].replace(/[×·*xX⋅∙]/g, '*').replace(/[:÷/]/g, '/').replace(/[−–—]/g, '-').replace(/\s+/g, '');
  if (!s) return { empty: true };
  let i = 0;
  const peek = () => s[i];
  const fail = () => new Error(i >= s.length ? 'Die Rechnung ist noch unvollständig.' : `„${s[i]}“ passt an dieser Stelle nicht.`);
  function primary() {
    if (peek() === '(') {
      i++;
      const v = expr();
      if (peek() === ')') i++;
      else if (i < s.length) throw fail(); // fehlende „)“ am Ende ist in Ordnung
      return v;
    }
    const m = /^(\d+(?:[.,]\d+)?|[.,]\d+)/.exec(s.slice(i));
    if (!m) throw fail();
    i += m[0].length;
    return parseFloat(m[0].replace(',', '.'));
  }
  function power() { const b = primary(); if (peek() === '^') { i++; return Math.pow(b, unary()); } return b; }
  function unary() { if (peek() === '-') { i++; return -unary(); } if (peek() === '+') { i++; return unary(); } return power(); }
  function term() {
    let v = unary();
    for (;;) {
      const c = peek();
      if (c === '*') { i++; v *= unary(); } else if (c === '/') { i++; v /= unary(); } else if (c === '(' || /\d/.test(c || '')) v *= unary(); // 2(3+4)
      else return v;
    }
  }
  function expr() {
    let v = term();
    for (;;) {
      const c = peek();
      if (c === '+') { i++; v += term(); } else if (c === '-') { i++; v -= term(); } else return v;
    }
  }
  try {
    const v = expr();
    if (i < s.length) throw fail();
    if (!Number.isFinite(v)) return { error: Number.isNaN(v) ? 'Das ergibt keine Zahl.' : 'Division durch 0.' };
    return { value: v };
  } catch (err) { return { error: err.message }; }
}

// Zahl auf Deutsch: Komma, höchstens 10 Nachkommastellen, Rundungsreste weg (0,1 + 0,2 = 0,3)
export function fmt(v) {
  const r = Number(v.toPrecision(12));
  if (Math.abs(r) >= 1e15 || (r !== 0 && Math.abs(r) < 1e-9)) return r.toExponential(6).replace('.', ',').replace(/0+e/, 'e').replace(/,e/, 'e');
  return r.toLocaleString('de-DE', { useGrouping: false, maximumFractionDigits: 10 });
}

// Zeichnen von Papier, Strichen und Text + Geometrie (Treffer, Lasso, Formerkennung).
// Alle Koordinaten sind "Seiteneinheiten" (A4 = 794 × 1123).
// Ein Strich: { id, tool: 'pen'|'hl', color, size, pts: [x, y, druck, x, y, druck, …], shape? }

export const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export const PAPERS = {
  white: { bg: '#ffffff', line: '#c8d5e8', margin: '#efb3b3' },
  cream: { bg: '#fbf5e6', line: '#ddd0b2', margin: '#e8ae9e' },
  dark:  { bg: '#26272b', line: '#45474f', margin: '#70474c' },
};
export const TEMPLATES = [['blank', 'Blanko'], ['lined', 'Liniert'], ['grid', 'Kariert'], ['dots', 'Gepunktet'], ['cornell', 'Cornell']];
export const PAPER_NAMES = [['white', 'Weiß'], ['cream', 'Creme'], ['dark', 'Dunkel']];

// ---------- Papier ----------

// y0/y1: nur dieser senkrechte Bereich wird gebraucht (Kachel einer langen Seite)
export function drawBackground(ctx, page, bgImg, y0 = 0, y1 = page.h) {
  const P = PAPERS[page.paper] || PAPERS.white, W = page.w, H = page.h;
  ctx.fillStyle = bgImg ? '#ffffff' : P.bg;
  ctx.fillRect(0, y0, W, y1 - y0);
  if (bgImg) { ctx.drawImage(bgImg, 0, 0, W, H); return; }

  const t = page.template;
  const from = (start, gap) => start + Math.max(0, Math.ceil((y0 - start) / gap)) * gap; // erste Linie im Bereich
  const to = Math.min(H, y1 + 2);
  ctx.save();
  ctx.strokeStyle = P.line;
  ctx.fillStyle = P.line;
  ctx.lineWidth = 1;
  if (t === 'lined' || t === 'cornell') {
    const top = 110, gap = 34;
    ctx.beginPath();
    for (let y = from(top, gap); y < Math.min(H - 20, to); y += gap) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.strokeStyle = P.margin;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (t === 'lined') {
      ctx.moveTo(90, 0); ctx.lineTo(90, H);
    } else {
      const cx = Math.round(W * 0.3), sy = H - 210;
      ctx.moveTo(0, top - gap); ctx.lineTo(W, top - gap);
      ctx.moveTo(cx, top - gap); ctx.lineTo(cx, sy);
      ctx.moveTo(0, sy); ctx.lineTo(W, sy);
    }
    ctx.stroke();
  } else if (t === 'grid') {
    const g = 26;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    for (let x = g; x < W; x += g) { ctx.moveTo(x, Math.max(0, y0 - 2)); ctx.lineTo(x, to); }
    for (let y = from(g, g); y < to; y += g) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  } else if (t === 'dots') {
    const g = 26;
    ctx.beginPath();
    for (let x = g; x < W; x += g) for (let y = from(g, g); y < to; y += g) { ctx.moveTo(x + 1.4, y); ctx.arc(x, y, 1.4, 0, 6.3); }
    ctx.fill();
  }
  ctx.restore();
}

const touches = (r, x, y, w, h) => !r || (x <= r.x1 && x + w >= r.x0 && y <= r.y1 && y + h >= r.y0);

// Bilder einer Seite (z. B. Folien aus OneNote); noch nicht geladene als hellgraue Fläche.
// r: nur was dieses Rechteck {x0, y0, x1, y1} berührt (Kachel einer großen Seite)
export function drawImages(ctx, images, loaded, r) {
  if (!images) return;
  for (const im of images) {
    if (!touches(r, im.x, im.y, im.w, im.h)) continue;
    const bmp = loaded?.get(im.id);
    if (bmp) ctx.drawImage(bmp, im.x, im.y, im.w, im.h);
    else { ctx.fillStyle = '#f1f2f4'; ctx.fillRect(im.x, im.y, im.w, im.h); }
  }
}

// ---------- Striche ----------

const pw = p => 0.35 + p * 1.0; // Druck → Strichbreiten-Faktor

// px: Bildschirmpixel pro Seiteneinheit. Stark verkleinert (Übersicht) wird jeder Strich vereinfacht
// als ein einziger Pfad gezeichnet – bei riesigen OneNote-Seiten ein Vielfaches schneller.
export function drawStroke(ctx, s, dx = 0, dy = 0, px = 1) {
  const a = s.pts, n = a.length / 3;
  if (!n) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = ctx.fillStyle = s.color;
  if (s.tool === 'hl') ctx.globalAlpha = 0.35;
  const X = i => a[i * 3] + dx, Y = i => a[i * 3 + 1] + dy;
  const uniform = s.tool === 'hl' || s.shape;

  if (px < 0.5 && n > 2) {
    const step = Math.max(1, Math.floor(0.5 / px));
    ctx.lineWidth = Math.max(s.size * (uniform ? 1 : 0.85), 0.5 / px);
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    for (let i = step; i < n - 1; i += step) ctx.lineTo(X(i), Y(i));
    ctx.lineTo(X(n - 1), Y(n - 1));
    ctx.stroke();
  } else if (n === 1) {
    ctx.beginPath();
    ctx.arc(X(0), Y(0), (uniform ? s.size : s.size * pw(a[2])) / 2, 0, 6.3);
    ctx.fill();
  } else if (uniform) {
    ctx.lineWidth = s.size;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    if (s.shape) {
      for (let i = 1; i < n; i++) ctx.lineTo(X(i), Y(i));
    } else {
      for (let i = 1; i < n - 1; i++) ctx.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
      ctx.lineTo(X(n - 1), Y(n - 1));
    }
    ctx.stroke();
  } else {
    // variable Breite nach Stiftdruck. Aufeinanderfolgende Kurvenstücke mit (fast) gleicher Breite werden in
    // einem Pfad gezeichnet: Breitenstufen unter ~0,6 Bildschirmpixel sieht man nicht, aber jeder einzelne
    // Zeichenbefehl kostet – bei OneNote-Seiten mit Druckdaten ein Vielfaches schneller.
    const q = Math.max(0.03 * s.size, 0.6 / px);
    let x = X(0), y = Y(0), level = NaN;
    for (let i = 1; i < n; i++) {
      const last = i === n - 1;
      const ex = last ? X(i) : (X(i) + X(i + 1)) / 2;
      const ey = last ? Y(i) : (Y(i) + Y(i + 1)) / 2;
      const lv = Math.round((s.size * pw((a[(i - 1) * 3 + 2] + a[i * 3 + 2]) / 2)) / q);
      if (lv !== level) {
        if (level === level) ctx.stroke(); // vorheriges Stück abschließen (NaN === NaN ist false)
        level = lv;
        ctx.lineWidth = Math.max(lv, 1) * q;
        ctx.beginPath();
        ctx.moveTo(x, y);
      }
      ctx.quadraticCurveTo(X(i), Y(i), ex, ey);
      x = ex; y = ey;
    }
    ctx.stroke();
  }
  ctx.restore();
}

// Marker zuerst, damit Stiftschrift nie vom Marker überdeckt wird.
// r: nur Striche zeichnen, die dieses Rechteck berühren (Kachel einer großen Seite).
export function drawInk(ctx, strokes, hide, r, px = 1) {
  const list = r ? strokesIn(strokes, r) : strokes;
  const vis = s => {
    if (hide?.has(s.id)) return false;
    if (!r) return true;
    const b = strokeBBox(s);
    return touches(r, b.x, b.y, b.w, b.h);
  };
  for (const s of list) if (s.tool === 'hl' && vis(s)) drawStroke(ctx, s, 0, 0, px);
  for (const s of list) if (s.tool !== 'hl' && vis(s)) drawStroke(ctx, s, 0, 0, px);
}

// ---------- Räumlicher Index ----------
// OneNote-Seiten haben teils über 10.000 Striche. Statt für jede Kachel (oder jeden Radierpunkt) alle zu
// prüfen, merkt sich der Index je Feld (CELL × CELL Einheiten), welche Striche es berühren.
// Das Strich-Array einer Seite wird bei jeder Änderung neu angelegt, daher hängt der Index am Array;
// kam nur ein Strich hinten dazu (der häufigste Fall beim Schreiben), wird der alte Index weiterverwendet.
const CELL = 256;
const SMALL = 300;    // so wenige Striche prüft man schneller direkt
const BIG_CELLS = 400; // Striche über mehr Felder kommen in eine eigene Liste
const idxCache = new WeakMap();
let recent = [];      // zuletzt benutzte Indizes (für das Anhängen eines Strichs)

function cellRange(x0, y0, x1, y1) {
  return [Math.max(0, Math.floor(x0 / CELL)), Math.max(0, Math.floor(y0 / CELL)), Math.max(0, Math.floor(x1 / CELL)), Math.max(0, Math.floor(y1 / CELL))];
}
function addToIndex(ix, s, i) {
  const b = strokeBBox(s), [c0, r0, c1, r1] = cellRange(b.x, b.y, b.x + b.w, b.y + b.h);
  if ((c1 - c0 + 1) * (r1 - r0 + 1) > BIG_CELLS) { ix.big.push(i); return; }
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const k = r * 100000 + c, l = ix.cells.get(k);
      if (l) l.push(i); else ix.cells.set(k, [i]);
    }
  }
}
function indexFor(strokes) {
  let ix = idxCache.get(strokes);
  if (ix) return ix;
  const n = strokes.length;
  const prev = recent.find(e => e.arr.length === n - 1 && e.arr[n - 2] === strokes[n - 2] && e.arr.every((s, i) => s === strokes[i]));
  if (prev) { // nur angehängt: Index übernehmen (das alte Array bekommt bei Bedarf einen neuen)
    ix = prev.ix;
    idxCache.delete(prev.arr);
    addToIndex(ix, strokes[n - 1], n - 1);
  } else {
    ix = { cells: new Map(), big: [] };
    strokes.forEach((s, i) => addToIndex(ix, s, i));
  }
  idxCache.set(strokes, ix);
  recent = [{ arr: strokes, ix }, ...recent.filter(e => e.arr !== strokes && e !== prev)].slice(0, 6);
  return ix;
}
// Striche, die das Rechteck r {x0, y0, x1, y1} berühren könnten – in Seitenreihenfolge (sie bestimmt, was oben liegt)
export function strokesIn(strokes, r) {
  if (strokes.length < SMALL) return strokes;
  const [c0, r0, c1, r1] = cellRange(r.x0, r.y0, r.x1, r.y1);
  if ((c1 - c0 + 1) * (r1 - r0 + 1) > 256) return strokes; // großer Ausschnitt (z. B. Übersicht): alle durchgehen
  const ix = indexFor(strokes), ids = [...ix.big];
  for (let rr = r0; rr <= r1; rr++) {
    for (let c = c0; c <= c1; c++) {
      const l = ix.cells.get(rr * 100000 + c);
      if (l) for (const i of l) ids.push(i);
    }
  }
  ids.sort((a, b) => a - b);
  const out = [];
  let last = -1;
  for (const i of ids) if (i !== last && i < strokes.length) { last = i; out.push(strokes[i]); }
  return out;
}

export function drawText(ctx, t) {
  ctx.save();
  ctx.fillStyle = t.color;
  ctx.font = `${t.size}px ${FONT}`;
  ctx.textBaseline = 'top';
  const lh = t.size * 1.3;
  let y = t.y + (lh - t.size) / 2;
  for (const para of t.text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (line.trim() && ctx.measureText(test).width > t.w) {
        ctx.fillText(line.trimEnd(), t.x, y);
        y += lh;
        line = word.trimStart();
      } else line = test;
    }
    ctx.fillText(line, t.x, y);
    y += lh;
  }
  ctx.restore();
}

// ---------- Geometrie ----------

const r2 = v => Math.round(v * 100) / 100;
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

const bbCache = new WeakMap();
export function strokeBBox(s) {
  let b = bbCache.get(s);
  if (b) return b;
  const a = s.pts;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < a.length; i += 3) {
    if (a[i] < x0) x0 = a[i];
    if (a[i] > x1) x1 = a[i];
    if (a[i + 1] < y0) y0 = a[i + 1];
    if (a[i + 1] > y1) y1 = a[i + 1];
  }
  const r = s.size / 2 + 1;
  b = { x: x0 - r, y: y0 - r, w: x1 - x0 + 2 * r, h: y1 - y0 + 2 * r };
  bbCache.set(s, b);
  return b;
}

export function hitStroke(s, x, y, r) {
  const b = strokeBBox(s);
  if (x < b.x - r || x > b.x + b.w + r || y < b.y - r || y > b.y + b.h + r) return false;
  const a = s.pts, rr = r + s.size / 2;
  if (a.length === 3) return Math.hypot(x - a[0], y - a[1]) <= rr;
  for (let i = 3; i < a.length; i += 3) {
    if (distSeg(x, y, a[i - 3], a[i - 2], a[i], a[i + 1]) <= rr) return true;
  }
  return false;
}

// poly: flaches Array [x, y, x, y, …]
export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function strokeInPoly(s, poly) {
  const a = s.pts;
  let n = 0, c = 0;
  for (let i = 0; i < a.length; i += 3) { n++; if (pointInPoly(a[i], a[i + 1], poly)) c++; }
  return c / n >= 0.5;
}

export function translateStroke(s, dx, dy) {
  const pts = s.pts.slice();
  for (let i = 0; i < pts.length; i += 3) { pts[i] = r2(pts[i] + dx); pts[i + 1] = r2(pts[i + 1] + dy); }
  return { ...s, pts };
}

// ---------- Formerkennung ----------
// hold = true: Stift wurde gehalten → großzügiger (z. B. leicht krumme Linie wird gerade)

function bboxOf(P) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of P) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

function simplify(P, eps) { // Douglas-Peucker
  const keep = new Uint8Array(P.length);
  keep[0] = keep[P.length - 1] = 1;
  const stack = [[0, P.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distSeg(P[i][0], P[i][1], P[a][0], P[a][1], P[b][0], P[b][1]);
      if (d > md) { md = d; mi = i; }
    }
    if (mi > 0 && md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return P.filter((_, i) => keep[i]);
}

// entfernt Ecken, die fast gerade weiterlaufen oder zu dicht beieinander liegen (geschlossener Polygonzug)
function cleanCorners(V, minEdge) {
  let changed = true;
  while (changed && V.length > 3) {
    changed = false;
    for (let i = 0; i < V.length; i++) {
      const p = V[(i - 1 + V.length) % V.length], c = V[i], n = V[(i + 1) % V.length];
      const ux = c[0] - p[0], uy = c[1] - p[1], vx = n[0] - c[0], vy = n[1] - c[1];
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      const turn = lu && lv ? Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)))) : 0;
      if (turn < 0.5 || lu < minEdge) { V.splice(i, 1); changed = true; break; }
    }
  }
  return V;
}

// mittlerer Abstand der Strichpunkte zum geschlossenen Polygon V
function polyErr(P, V) {
  let sum = 0;
  for (const p of P) {
    let m = Infinity;
    for (let i = 0; i < V.length; i++) { const a = V[i], b = V[(i + 1) % V.length]; m = Math.min(m, distSeg(p[0], p[1], a[0], a[1], b[0], b[1])); }
    sum += m;
  }
  return sum / P.length;
}

function axisAligned(V) {
  return V.every((p, i) => {
    const q = V[(i + 1) % V.length];
    let a = Math.abs(Math.atan2(q[1] - p[1], q[0] - p[0])) % (Math.PI / 2);
    return Math.min(a, Math.PI / 2 - a) < 0.26;
  });
}

const flat = P => P.flatMap(([x, y]) => [r2(x), r2(y), 0.5]);

function ellipse(cx, cy, rx, ry) {
  if (rx / ry > 0.8 && rx / ry < 1.25) rx = ry = (rx + ry) / 2;
  const P = [];
  for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2; P.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  return { type: rx === ry ? 'circle' : 'ellipse', pts: flat(P) };
}

// scale: Bildschirmpunkte pro Seiteneinheit (Zoom). Gerechnet wird in Bildschirmgröße – sonst wären die festen
// Toleranzen bei starkem Zoom viel zu grob (ein kleiner Kreis zerfiel dann in ein Viereck) und bei kleinem zu fein.
export function recognize(pts, hold, scale = 1) {
  const r = recognizeScreen(pts.map((v, i) => (i % 3 === 2 ? v : v * scale)), hold);
  if (r) r.pts = r.pts.map((v, i) => (i % 3 === 2 ? v : r2(v / scale)));
  return r;
}
// Punkte vereinheitlichen: Zittern unter 1,5 px weg (beim Halten sammeln sich sonst Dutzende Punkte am Ende
// und verfälschen die Kreisprüfung), dann gleichmäßig entlang des Strichs verteilen – so zählt jedes Stück
// gleich viel, egal ob schnell oder langsam gezeichnet.
function evenPoints(raw) {
  const D = [raw[0]];
  for (const p of raw) if (dist(p, D[D.length - 1]) >= 1.5) D.push(p);
  if (D.length > 1 && D[D.length - 1] !== raw[raw.length - 1] && dist(raw[raw.length - 1], D[D.length - 1]) > 0.5) D.push(raw[raw.length - 1]);
  let len = 0;
  for (let i = 1; i < D.length; i++) len += dist(D[i - 1], D[i]);
  const step = Math.max(1.5, len / 150), out = [D[0]];
  let prev = D[0], acc = 0;
  for (let i = 1; i < D.length; i++) {
    const cur = D[i];
    let d = dist(prev, cur);
    while (d > 0 && acc + d >= step) {
      const t = (step - acc) / d, q = [prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t];
      out.push(q);
      prev = q;
      d = dist(prev, cur);
      acc = 0;
    }
    acc += d;
    prev = cur;
  }
  const last = D[D.length - 1];
  if (dist(out[out.length - 1], last) > 0.3 * step) out.push(last);
  return out;
}

function recognizeScreen(pts, hold) {
  const raw = [];
  for (let i = 0; i < pts.length; i += 3) raw.push([pts[i], pts[i + 1]]);
  if (raw.length < 3) return null;
  const P = evenPoints(raw);
  if (P.length < 3) return null;
  let len = 0;
  for (let i = 1; i < P.length; i++) len += dist(P[i - 1], P[i]);
  if (len < 14) return null;

  const s = P[0], e = P[P.length - 1];
  const [bx0, by0, bx1, by1] = bboxOf(P);
  const W = bx1 - bx0, H = by1 - by0;
  const closed = dist(s, e) < Math.max(16, 0.16 * len) && len > 2.4 * Math.max(W, H);

  if (!closed) {
    const L = dist(s, e);
    if (L < 10) return null;
    let dev = 0;
    for (const p of P) dev = Math.max(dev, Math.abs((e[0] - s[0]) * (s[1] - p[1]) - (s[0] - p[0]) * (e[1] - s[1])) / L);
    if (dev < Math.max(3, 0.05 * L) || (hold && dev < 0.2 * L)) return { type: 'line', pts: flat([s, e]) };
    return null;
  }

  if (W < 8 || H < 8) return null;
  let V = simplify(P, Math.max(4, 0.03 * len));
  V.pop(); // Endpunkt ≈ Startpunkt
  V = cleanCorners(V, 0.06 * len);

  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2, rx = W / 2, ry = H / 2;
  let err = 0;
  for (const p of P) err += Math.abs(Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry) - 1);
  err /= P.length;

  if (err < 0.075) return ellipse(cx, cy, rx, ry);
  // Recht runde Form, zu der eine Ellipse besser passt als die gefundenen Ecken: etwas eckig geratener Kreis
  if ((V.length === 3 || V.length === 4) && err < 0.1 && polyErr(P, V) > 1.2 * err * (W + H) / 4) return ellipse(cx, cy, rx, ry);
  // Dreieck nur, wenn es eindeutig eins ist: Ellipse passt schlecht, die drei Seiten sind gerade, und es ist nicht
  // klein (kleine Dreiecke braucht man kaum – kleine runde Formen sind fast immer Kreise)
  if (V.length === 3) {
    if (err >= 0.15 && Math.max(W, H) >= 50 && polyErr(P, V) < 0.6 * err * (W + H) / 4) return { type: 'triangle', pts: flat([...V, V[0]]) };
    if (err < 0.18) return ellipse(cx, cy, rx, ry); // runde Form mit drei „Ecken“: ein Kreis
    return hold ? { type: 'polygon', pts: flat([...V, V[0]]) } : null; // kleines Dreieck: bleibt, wie gezeichnet
  }
  if (V.length === 4) {
    if (axisAligned(V)) {
      const [x0, y0, x1, y1] = bboxOf(V);
      return { type: 'rect', pts: flat([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]) };
    }
    return { type: 'quad', pts: flat([...V, V[0]]) };
  }
  if (err < 0.16) return ellipse(cx, cy, rx, ry);
  if (hold && V.length <= 6) return { type: 'polygon', pts: flat([...V, V[0]]) };
  return null;
}

// Notizbuch-Editor: Seiten anzeigen, mit Stift/Maus zeichnen, Lasso, Text, Rückgängig, Zoom.
import { store, uid, newPage, changes, PAGE_SIZES } from './store.js';
import * as ink from './ink.js';
import { h, icon, menu, modal, confirmDialog, promptText, toast, progress, pickFiles, download, safeName } from './ui.js';
import { importPdf, exportPdf } from './pdfio.js';
import { isCard, createCard, snapshot, updateThumb } from './cards.js';
import { startOcclusion } from './occlusion.js';
import { createPageNav } from './pagenav.js';
import { markForClaude } from './claude.js';
import { isLongPage, splitDialog } from './split.js';
import { userActive } from './sync.js';

const PEN_COLORS = ['#1c1c1e', '#1e5bd8', '#d7263d', '#159a4c', '#7b3fbf', '#ff8a00'];
const HL_COLORS = ['#ffe03a', '#7dff7a', '#62d6ff', '#ff86d6', '#ffb057'];
const SIZES = { pen: [1.2, 2.2, 3.5, 6], hl: [10, 18, 28], eraser: [5, 12, 24], text: [16, 22, 30] };
const TOOLS = [['pen', 'Stift'], ['hl', 'Marker'], ['eraser', 'Radierer'], ['lasso', 'Lasso'], ['text', 'Text'], ['card', 'Karteikarte aus Bereich']];
const MAX_PX = 5e6; // Pixel pro Kachel-Canvas (iPad-Speicher schonen)
const TILE_PX = 512; // angestrebte Kachelgröße in Bildschirmpunkten
const BUDGET_MS = 8; // so lange darf das Kachelzeichnen pro Frame höchstens dauern
const BG = '#bg';    // PDF-Hintergrund in den Bildlisten einer Seite
const HOLD_MS = 480;

const S = loadSettings();
let lastDrawTool = S.tool === 'hl' ? 'hl' : 'pen'; // Ziel beim Zurückwechseln vom Radierer
function loadSettings() {
  const d = { tool: 'pen', penColor: PEN_COLORS[0], hlColor: HL_COLORS[0], size: { pen: 1, hl: 1, eraser: 1, text: 0 }, shapeMode: false, fingerDraw: false, eraserMode: 'stroke' };
  try {
    const s = JSON.parse(localStorage.getItem('notizen.editor') || '{}');
    return { ...d, ...s, size: { ...d.size, ...(s.size || {}) } };
  } catch { return d; }
}
function saveSettings() { try { localStorage.setItem('notizen.editor', JSON.stringify(S)); } catch { /* egal */ } }

// Notiz und Kartenfenster können gleichzeitig offen sein: Tastenkürzel gehen an den zuletzt benutzten Editor,
// Werkzeugwechsel (auch per Doppeltipp) werden allen offenen Editoren gemeldet.
let keyOwner = null;
const toolEvents = new EventTarget();

// Seiteninhalt für Rückgängig. Strich- und Textlisten werden nie verändert, sondern immer durch neue ersetzt –
// ein Verweis genügt also. Kopien kosteten bei großen Seiten (OneNote: 10.000 Striche) viel Speicher, und
// jede Kopie brauchte beim Rückgängigmachen einen neuen Strich-Index.
const snap = p => ({ strokes: p.strokes, texts: p.texts });
const r2 = v => Math.round(v * 100) / 100;
const inside = (b, p, pad = 0) => p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;

// embed: { side, onClose, onFull } – Karte im Kartenfenster einer Notiz statt als eigene Ansicht
export async function openEditor(root, nbId, embed = null) {
  const nb = await store.get('notebooks', nbId);
  if (!nb) { if (embed) embed.onClose(); else location.hash = ''; return null; }
  if (nb.occl) { if (!embed) location.replace('#abdecken/' + nbId); return null; } // Abdeck-Karten haben einen eigenen Editor
  const pages = await store.pagesOf(nb);
  if (!pages.length) { const p = newPage(nb); pages.push(p); await store.put('pages', p); }
  nb.pageIds = pages.map(p => p.id);

  // k: vorübergehender Zoomfaktor während einer Zwei-Finger-Geste (nur per CSS, siehe pinchMove)
  const E = { pages, pvs: new Map(), zoom: 1, scale: 1, k: 1, undo: [], redo: [], act: null, cur: null, sel: null, clip: null, dirty: new Set() };
  const dpr = () => window.devicePixelRatio || 1;
  const card = isCard(nb); // Karteikarte: genau zwei Seiten (Vorder-/Rückseite)
  if (card && !embed && S.tool === 'card') S.tool = 'pen'; // im Kartenfenster wechselt erst der erste Strich (onDown)
  // "Zurück" führt dorthin, woher man kam (z. B. vom Skript zur neuen Karte und wieder zurück)
  const RETURN_KEY = 'notizen.return:' + nb.id;
  function goBack() {
    if (embed) { embed.onClose(); return; }
    let ret = null;
    try { ret = sessionStorage.getItem(RETURN_KEY); sessionStorage.removeItem(RETURN_KEY); } catch { /* egal */ }
    location.hash = ret || '';
  }

  // ---------- Oberfläche ----------
  const btn = (name, title, onclick, cls = '') => h('button', { class: 'ibtn ' + cls, title, 'aria-label': title, onclick }, icon(name));
  const vsep = () => h('span', { class: 'vsep' });
  const titleEl = h('button', { class: 'ed-title', title: 'Umbenennen', onclick: rename }, nb.title);
  const pageLabel = h('span', { class: 'page-label' });
  const undoBtn = btn('undo', 'Rückgängig', () => undo());
  const redoBtn = btn('redo', 'Wiederholen', () => redo());
  const zoomLabel = h('button', { class: 'zoom-label', title: 'Zoom zurücksetzen', onclick: () => setZoom(1) }, '100%');
  const toolsEl = h('div', { class: 'ed-tools' });
  const pagesEl = h('div', { class: 'pages' });
  // Hülle mit overflow: hidden, damit die CSS-Skalierung beim Zoomen den Scrollbereich nicht verändert
  const scroller = h('div', { class: 'scroller' }, h('div', { class: 'zoomwrap' }, pagesEl));
  const ov = h('canvas', { class: 'overlay' });
  const stage = h('div', { class: 'stage' }, scroller, ov);
  // Kartenfenster: neue Karte unten bzw. rechts neben der Notiz bearbeiten, die Folie bleibt sichtbar
  const panelHost = h('div', { class: 'card-panel' });
  const mainRow = h('div', { class: 'ed-main' }, stage); // links davon ggf. die Seitenübersicht
  const body = h('div', { class: 'ed-body' }, mainRow, embed || card ? null : panelHost);
  const editor = h('div', { class: 'editor' + (S.fingerDraw ? ' finger' : '') + (embed ? ' embedded' : '') },
    embed
      ? h('header', { class: 'ed-top' },
        h('span', { class: 'ed-title' }, 'Karteikarte'), h('div', { class: 'grow' }), undoBtn, redoBtn,
        btn('expand', 'Karte groß öffnen', () => embed.onFull()),
        h('button', { class: 'btn primary', onclick: goBack }, icon('check'), 'Fertig'))
      : h('header', { class: 'ed-top' },
        btn('back', 'Zurück', goBack),
        card ? null : btn('pages', 'Seitenübersicht', () => toggleNav()),
        titleEl, h('div', { class: 'grow' }), pageLabel, undoBtn, redoBtn,
        card ? null : btn('pagePlus', 'Seite hinzufügen', () => addPageAfter(currentIndex())),
        btn('more', 'Mehr', e => moreMenu(e.currentTarget))),
    embed ? null : toolsEl, body);
  root.replaceChildren(editor);
  editor.addEventListener('pointerdown', () => { keyOwner = editor; }, true);
  keyOwner = editor;

  function dotFor(t, i) {
    if (t === 'text') return h('b', { style: { fontSize: [13, 17, 22][i] + 'px' } }, 'A');
    const d = [5, 8, 12, 17][i];
    const color = t === 'hl' ? S.hlColor : S.penColor;
    return h('i', { style: { width: d + 'px', height: d + 'px', background: t === 'eraser' ? 'transparent' : color, border: t === 'eraser' ? '1.5px solid currentColor' : '0' } });
  }

  function renderTools() {
    const t = S.tool;
    const kids = [h('div', { class: 'seg' }, TOOLS.filter(([k]) => !(card && k === 'card')).map(([k, l]) => btn(k, l, () => setTool(k), t === k ? 'on' : '')))];
    if (t === 'pen' || t === 'hl') kids.push(vsep(), btn('shapes', 'Formen automatisch begradigen', toggleShapes, S.shapeMode ? 'on' : ''));
    if (t === 'pen' || t === 'hl' || t === 'text') {
      const list = t === 'hl' ? HL_COLORS : PEN_COLORS, cur = t === 'hl' ? S.hlColor : S.penColor;
      kids.push(vsep(),
        ...list.map(c => h('button', { class: 'swatch' + (c === cur ? ' on' : ''), style: { background: c }, 'aria-label': 'Farbe ' + c, onclick: () => setColor(c) })),
        h('label', { class: 'swatch custom' + (list.includes(cur) ? '' : ' on'), title: 'Eigene Farbe' },
          h('input', { type: 'color', value: cur, onchange: e => setColor(e.target.value) })));
    }
    if (t === 'eraser') kids.push(vsep(), h('div', { class: 'seg' },
      [['stroke', 'Ganze Striche', 'Löscht jeden berührten Strich ganz'], ['part', 'Teilweise', 'Entfernt nur, was du überfährst – wie ein echter Radierer']]
        .map(([m, label, title]) => h('button', { class: 'mode' + (S.eraserMode === m ? ' on' : ''), title, onclick: () => setEraserMode(m) }, label))));
    if (SIZES[t]) kids.push(vsep(), ...SIZES[t].map((_, i) =>
      h('button', { class: 'size' + (S.size[t] === i ? ' on' : ''), title: 'Größe ' + (i + 1), onclick: () => { S.size[t] = i; saveSettings(); renderTools(); } }, dotFor(t, i))));
    kids.push(h('div', { class: 'grow' }),
      h('div', { class: 'zoomctl' },
        btn('zoomOut', 'Verkleinern', () => setZoom(E.zoom / 1.25)), zoomLabel, btn('zoomIn', 'Vergrößern', () => setZoom(E.zoom * 1.25)), vsep()),
      btn('hand', 'Mit Finger zeichnen', toggleFinger, S.fingerDraw ? 'on' : ''));
    toolsEl.replaceChildren(...kids);
  }
  function setTool(t) {
    if (t !== S.tool) clearSelection();
    if (t === 'pen' || t === 'hl') lastDrawTool = t;
    S.tool = t;
    saveSettings();
    renderTools();
    toolEvents.dispatchEvent(new Event('change'));
  }
  function setEraserMode(m) {
    S.eraserMode = m; saveSettings(); renderTools();
    toast(m === 'part' ? 'Radierer entfernt nur, was du überfährst' : 'Radierer löscht ganze Striche');
  }
  function setColor(c) { if (S.tool === 'hl') S.hlColor = c; else S.penColor = c; saveSettings(); renderTools(); toolEvents.dispatchEvent(new Event('change')); }
  const onToolChange = () => renderTools();
  function toggleShapes() {
    S.shapeMode = !S.shapeMode; saveSettings(); renderTools();
    toast(S.shapeMode ? 'Formerkennung an – Formen werden automatisch begradigt' : 'Formerkennung aus – Stift halten begradigt trotzdem');
  }
  function toggleFinger() {
    S.fingerDraw = !S.fingerDraw; saveSettings(); renderTools();
    editor.classList.toggle('finger', S.fingerDraw);
    toast(S.fingerDraw ? 'Finger zeichnet – scrollen mit zwei Fingern' : 'Nur Stift zeichnet – Finger scrollt');
  }

  // ---------- Seiten ----------
  // Jede Seite ist in Kacheln (Zeilen × Spalten) geteilt. Ein Canvas gibt es nur für Kacheln in Sichtweite –
  // so bleiben auch riesige Seiten (z. B. aus OneNote) scharf und sparsam im Speicher.
  // Gezeichnet wird über eine Warteschlange: nächste Kacheln zuerst und nur wenige Millisekunden pro Frame,
  // damit Wischen und Zoomen auch auf dem iPad flüssig bleiben. Bis eine Kachel neu gezeichnet ist,
  // bleibt ihr alter Inhalt sichtbar (etwas unscharf statt leer).
  function makePV(page) {
    const pv = { page, dom: new Map(), active: new Set(), old: [], hide: null, near: null };
    pv.imgLayer = h('div', { class: 'pimgs' });
    pv.tilesEl = h('div', { class: 'tiles' });
    buildTiles(pv);
    pv.texts = h('div', { class: 'texts' });
    pv.num = h('div', { class: 'page-num' });
    pv.el = h('div', { class: 'page', 'data-id': page.id }, pv.imgLayer, pv.tilesEl, pv.texts,
      h('button', { class: 'page-btn', title: 'Seitenoptionen', 'aria-label': 'Seitenoptionen', onclick: e => pageMenu(pv, e.currentTarget) }, icon('more')),
      pv.num);
    E.pvs.set(page.id, pv);
    return pv;
  }
  // Kachelraster passend zur Zoomstufe (E.tileUnit). Kachel-Objekte entstehen erst, wenn sie gebraucht werden
  // (pv.active) – bei starkem Zoom hat eine riesige Seite sonst zehntausende Kacheln, die man bei jeder
  // Bewegung durchgehen müsste. Sichtbare Kacheln des alten Rasters bleiben als Platzhalter liegen, bis das
  // neue Raster gezeichnet ist – so blitzt beim Zoomen nichts auf.
  function buildTiles(pv) {
    for (const t of pv.active) {
      queue.delete(t);
      if (t.cv && t.want && pv.old.length < 64) pv.old.push(t);
      else freeCanvas(t);
    }
    const { page } = pv, u = E.tileUnit;
    const cols = Math.ceil(page.w / u), rows = Math.ceil(page.h / u);
    pv.grid = { cols, rows, tw: Math.ceil(page.w / cols), th: Math.ceil(page.h / rows) };
    pv.tmap = new Map();
    pv.active = new Set();
    pv.wkey = null;
  }
  function tileAt(pv, c, r) {
    const k = r * pv.grid.cols + c;
    let t = pv.tmap.get(k);
    if (!t) {
      const { tw, th } = pv.grid, p = pv.page;
      t = { pv, k, c, r, x0: c * tw, x1: Math.min(p.w, (c + 1) * tw), y0: r * th, y1: Math.min(p.h, (r + 1) * th), cv: null, rendered: false, fresh: false, want: false, bs: 1, pad: 0 };
      pv.tmap.set(k, t);
    }
    return t;
  }
  // Spalten/Zeilen der Kacheln, die das Bildschirmrechteck R berühren (null: Seite liegt nicht darin)
  function tileRange(pv, r, s, R) {
    const { cols, rows, tw, th } = pv.grid;
    const x0 = (R[0] - r.left) / s, y0 = (R[1] - r.top) / s, x1 = (R[2] - r.left) / s, y1 = (R[3] - r.top) / s;
    if (x1 < 0 || y1 < 0 || x0 > pv.page.w || y0 > pv.page.h) return null;
    return {
      c0: Math.max(0, Math.floor(x0 / tw)), c1: Math.min(cols - 1, Math.floor(x1 / tw)),
      r0: Math.max(0, Math.floor(y0 / th)), r1: Math.min(rows - 1, Math.floor(y1 / th)),
    };
  }
  const inRange = (g, t) => !!g && t.c >= g.c0 && t.c <= g.c1 && t.r >= g.r0 && t.r <= g.r1;
  function freeCanvas(t) {
    if (t.cv) { t.cv.width = t.cv.height = 0; t.cv.remove(); t.cv = null; }
    t.rendered = t.fresh = false;
  }
  function freeTile(t) {
    queue.delete(t);
    freeCanvas(t);
    t.want = false;
    t.pv.active.delete(t);
    t.pv.tmap.delete(t.k);
  }
  function dropOld(pv) { for (const t of pv.old) freeCanvas(t); pv.old = []; }

  // Kacheln in der Nähe des sichtbaren Bereichs vormerken, weit entfernte freigeben.
  // Während einer Zoom-Geste ist die Ansicht per CSS skaliert (E.k) – die Seitenrechtecke enthalten das schon.
  function updateVisible() {
    const sr = scroller.getBoundingClientRect(), s = E.scale * E.k;
    const A = [sr.left - 200, sr.top - 350, sr.right + 200, sr.bottom + 350]; // hier zeichnen
    const B = [sr.left - 500, sr.top - 650, sr.right + 500, sr.bottom + 650]; // erst außerhalb davon freigeben
    const pvs = [...E.pvs.values()], rects = pvs.map(pv => pv.el.getBoundingClientRect()); // erst lesen, dann ändern
    for (const [i, pv] of pvs.entries()) {
      const r = rects[i];
      const wa = tileRange(pv, r, s, A), wb = tileRange(pv, r, s, B);
      for (const t of pv.active) {
        if (inRange(wa, t)) continue;
        if (!inRange(wb, t)) freeTile(t);
        else { t.want = false; queue.delete(t); }
      }
      if (wa) {
        for (let rr = wa.r0; rr <= wa.r1; rr++) {
          for (let c = wa.c0; c <= wa.c1; c++) {
            const t = tileAt(pv, c, rr);
            t.want = true;
            pv.active.add(t);
            if (!t.fresh) queue.add(t);
          }
        }
      }
      const key = wa ? `${wa.c0},${wa.c1},${wa.r0},${wa.r1}` : '';
      if (key !== pv.wkey) { pv.wkey = key; syncAssets(pv); }
    }
    if (queue.size) schedulePump();
  }

  // Warteschlange abarbeiten: Kacheln nahe der Bildschirmmitte zuerst, höchstens BUDGET_MS pro Frame
  const queue = new Set();
  let pumpRaf = 0, pumpTo = 0;
  function schedulePump() {
    if (pumpRaf || E.dead) return;
    pumpRaf = requestAnimationFrame(pump);
    pumpTo = setTimeout(pump, 100); // falls gerade keine Frames kommen (Fenster verdeckt)
  }
  function pump() {
    cancelAnimationFrame(pumpRaf);
    clearTimeout(pumpTo);
    pumpRaf = pumpTo = 0;
    if (E.dead) return;
    const t0 = performance.now(), sr = scroller.getBoundingClientRect(), s = E.scale * E.k;
    const mx = (sr.left + sr.right) / 2, my = (sr.top + sr.bottom) / 2, rects = new Map();
    const dist = t => {
      let r = rects.get(t.pv);
      if (!r) rects.set(t.pv, (r = t.pv.el.getBoundingClientRect()));
      return Math.hypot(r.left + ((t.x0 + t.x1) / 2) * s - mx, r.top + ((t.y0 + t.y1) / 2) * s - my);
    };
    // während Wischen/Zoomen knapp, damit die Bewegung flüssig bleibt; sonst darf es etwas mehr sein
    const budget = gest || inertia ? BUDGET_MS : 2 * BUDGET_MS;
    const list = [...queue].map(t => [dist(t), t]).sort((a, b) => a[0] - b[0]);
    for (const [, t] of list) {
      queue.delete(t);
      if (t.want && !t.fresh) paintTile(t);
      if (performance.now() - t0 > budget) break;
    }
    for (const pv of E.pvs.values()) if (pv.old.length && ![...pv.active].some(t => t.want && !t.fresh)) dropOld(pv);
    if (queue.size) schedulePump();
    else paintPreviews();
  }

  // Grobe Vorschau der ganzen Seite unter den Kacheln: Wo nach schnellem Herauszoomen noch keine Kachel
  // gezeichnet ist, sieht man so unscharf den Inhalt statt einer leeren Fläche. Gezeichnet wird sie nur,
  // wenn sonst nichts zu tun ist und gerade weder gewischt, gezoomt noch geschrieben wird.
  let prevT = 0;
  function previewLater() {
    clearTimeout(prevT);
    prevT = setTimeout(() => { prevT = 0; schedulePump(); }, 2000);
  }
  function paintPreviews() {
    const pv = [...E.pvs.values()].find(p => p.near && !p.prevFresh); // near: Seite ist in Sichtweite
    if (!pv) return;
    if (gest || inertia || E.act) { previewLater(); return; }
    paintPreview(pv);
    schedulePump(); // nächste Seite im nächsten Frame
  }
  function paintPreview(pv) {
    const p = pv.page, ps = Math.min(0.5, Math.sqrt(1.2e6 / (p.w * p.h)));
    // Blanke Seite (weiß/PDF): Dort sind die Kacheln durchsichtig – eine grobe Vorschau darunter schiene als
    // unscharfer Rand um jeden Strich durch. Bilder zeigt ohnehin der Browser, reine Handschrift-Kacheln sind schnell gezeichnet.
    if (bare(p)) { freePreview(pv); pv.prevFresh = true; return; }
    if (!pv.prev) {
      pv.prev = h('canvas', { class: 'tile preview', width: 0, height: 0 });
      pv.tilesEl.prepend(pv.prev); // ganz unten, unter allen Kacheln
    }
    const c = pv.prev, W = Math.max(1, Math.round(p.w * ps)), H = Math.max(1, Math.round(p.h * ps));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d'), r = { x0: 0, y0: 0, x1: p.w, y1: p.h };
    ctx.setTransform(ps, 0, 0, ps, 0, 0);
    ink.drawBackground(ctx, p, null, 0, p.h);
    ink.drawInk(ctx, p.strokes, null, r, ps);
    pv.prevFresh = true;
    placePreview(pv);
  }
  function placePreview(pv) {
    if (pv.prev) Object.assign(pv.prev.style, { left: 0, top: 0, width: pv.page.w * E.scale + 'px', height: pv.page.h * E.scale + 'px' });
  }
  function freePreview(pv) {
    if (pv.prev) { pv.prev.width = pv.prev.height = 0; pv.prev.remove(); pv.prev = null; }
    pv.prevFresh = false;
  }

  // Kacheln liegen genau auf dem Pixelraster des Bildschirms: Läge eine Kachel auf einem halben Pixel,
  // müsste der Browser sie umrechnen – und alles (Schrift, Folien) würde leicht unscharf.
  // Kanten in ganzen Gerätepixeln ab dem Seitenrand; pv.off gleicht aus, falls die Seite selbst nicht
  // auf dem Raster liegt. 1 Gerätepixel Überlappung, damit zwischen Kacheln keine Haarlinien entstehen.
  const devPx = v => Math.round(v * E.scale * dpr());
  function placeTile(t) {
    const d = dpr(), o = t.pv.off || { x: 0, y: 0 };
    const X0 = devPx(t.x0), Y0 = devPx(t.y0), X1 = devPx(t.x1) + 1, Y1 = devPx(t.y1) + 1;
    Object.assign(t.cv.style, { left: (X0 - o.x) / d + 'px', top: (Y0 - o.y) / d + 'px', width: (X1 - X0) / d + 'px', height: (Y1 - Y0) / d + 'px' });
  }
  function paintTile(t) {
    if (bare(t.pv.page) && !hasInk(t)) { freeCanvas(t); t.fresh = true; return; } // nur Bild/Weiß: zeigt die Seite selbst
    if (!t.cv) {
      t.cv = h('canvas', { class: 'tile', width: 0, height: 0 }); // ohne Angabe wäre ein Canvas 300×150 px groß
      t.pv.tilesEl.append(t.cv);
    }
    placeTile(t);
    let bs = E.scale * dpr(), ox = devPx(t.x0), oy = devPx(t.y0);
    let W = devPx(t.x1) + 1 - ox, H = devPx(t.y1) + 1 - oy;
    if (W * H > MAX_PX) { // nur bei sehr großen Kacheln (kurz nach starkem Zoom): dann eben etwas gröber
      const k = Math.sqrt(MAX_PX / (W * H));
      bs *= k; ox *= k; oy *= k;
      W = Math.max(1, Math.round(W * k));
      H = Math.max(1, Math.round(H * k));
    }
    if (t.cv.width !== W || t.cv.height !== H) { t.cv.width = W; t.cv.height = H; }
    t.bs = bs;
    t.ox = ox;
    t.oy = oy;
    t.pad = 1 / bs;
    t.rendered = t.fresh = true;
    drawTile(t);
  }
  const tileCtx = t => {
    const ctx = t.cv.getContext('2d');
    ctx.setTransform(t.bs, 0, 0, t.bs, -t.ox, -t.oy);
    ctx.imageSmoothingQuality = 'high'; // Folien sauber verkleinern
    return ctx;
  };
  function drawTile(t, hide = t.pv.hide) {
    const { pv } = t, ctx = tileCtx(t), r = { x0: t.x0, y0: t.y0, x1: t.x1 + t.pad, y1: t.y1 + t.pad };
    if (bare(pv.page)) ctx.clearRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0); // PDF-Seite/Folien liegen als Bilder darunter
    else ink.drawBackground(ctx, pv.page, null, r.y0, r.y1);
    ink.drawInk(ctx, pv.page.strokes, hide, r, t.bs, pv.extra);
  }
  // „Blanke“ Seite: PDF-Hintergrund oder weißes Blanko-Papier – dann zeichnen die Kacheln nur Handschrift,
  // alles andere (weiße Seite, PDF, Folien) zeigt der Browser selbst und skaliert es auf der Grafikkarte.
  const bare = p => !!p.bg || ((!p.paper || p.paper === 'white') && (!p.template || p.template === 'blank'));
  function hasInk(t) {
    const r = { x0: t.x0 - 2, y0: t.y0 - 2, x1: t.x1 + 2, y1: t.y1 + 2 };
    return ink.strokesIn(t.pv.page.strokes, r).some(s => {
      const b = ink.strokeBBox(s);
      return b.x <= r.x1 && b.x + b.w >= r.x0 && b.y <= r.y1 && b.y + b.h >= r.y0;
    });
  }
  const hits = (t, b) => !b || (b.x <= t.x1 + t.pad && b.x + b.w >= t.x0 && b.y <= t.y1 + t.pad && b.y + b.h >= t.y0);
  // sofort neu zeichnen (beim Schreiben, Radieren, Verschieben …); hide: Striche, die gerade ausgeblendet sind
  function redraw(pv, hide = null, box = null) {
    pv.hide = hide;
    for (const t of pv.active) {
      if (!hits(t, box)) continue;
      if (t.rendered) drawTile(t);
      else if (t.want && t.fresh) paintTile(t); // bisher leere Kachel bekommt jetzt vielleicht Handschrift
    }
  }
  const joinBox = (b, c) => (!c ? b : !b ? c : { x: Math.min(b.x, c.x), y: Math.min(b.y, c.y), w: Math.max(b.x + b.w, c.x + c.w) - Math.min(b.x, c.x), h: Math.max(b.y + b.h, c.y + c.h) - Math.min(b.y, c.y) });
  // Nur die Kacheln neu zeichnen, in denen sich Striche geändert haben: Unveränderte Striche sind in alter und
  // neuer Liste dieselben Objekte. Auf großen Seiten (Rückgängig, Lasso) ein Vielfaches schneller als alles neu.
  function redrawChanged(pv, before) {
    const now = pv.page.strokes;
    if (now === before) return;
    const a = new Set(before), b = new Set(now);
    let box = null;
    for (const s of before) if (!b.has(s)) box = joinBox(box, ink.strokeBBox(s));
    for (const s of now) if (!a.has(s)) box = joinBox(box, ink.strokeBBox(s));
    if (box) redraw(pv, null, box);
  }
  // später neu zeichnen (z. B. wenn ein Bild fertig geladen ist)
  function invalidate(pv, box) {
    for (const t of pv.active) if ((t.rendered || t.fresh) && hits(t, box)) { t.fresh = false; if (t.want) queue.add(t); }
    if (queue.size) schedulePump();
  }
  function unrender(pv) {
    for (const t of [...pv.active]) freeTile(t);
    pv.wkey = null;
    dropOld(pv);
    syncAssets(pv);
  }

  // Bilder (Folien) und PDF-Hintergrund liegen als <img> in der Seite, unter den Kacheln. Der Browser
  // dekodiert sie im Hintergrund und skaliert sie auf der Grafikkarte – vorher wurden sie für jede Kachel
  // neu umgerechnet, das kostete in Safari 15–45 ms je Kachel. Geladen werden nur Bilder in der Nähe des
  // sichtbaren Bereichs (mit Vorlauf); weiter entfernte werden wieder freigegeben (Speicher).
  function assetsOf(pv) {
    const p = pv.page, list = [];
    if (p.bg) list.push({ id: BG, key: p.bg, x: 0, y: 0, w: p.w, h: p.h, z: 0 });
    (p.images || []).forEach((im, i) => list.push({ ...im, z: i + 1 }));
    return list;
  }
  const isNear = (pv, a) => { const b = pv.near; return !!b && a.x <= b.x1 && a.x + a.w >= b.x0 && a.y <= b.y1 && a.y + a.h >= b.y0; };
  const pct = (v, of) => (v / of) * 100 + '%';
  function placeImg(el, a, p) {
    Object.assign(el.style, { left: pct(a.x, p.w), top: pct(a.y, p.h), width: pct(a.w, p.w), height: pct(a.h, p.h), zIndex: a.z });
  }
  function dropImg(pv, id) {
    const d = pv.dom.get(id);
    if (!d) return;
    d.el.removeAttribute('src');
    d.el.remove();
    if (d.url) URL.revokeObjectURL(d.url);
    pv.dom.delete(id);
  }
  function showImg(pv, a) {
    const el = h('img', { class: 'pimg', alt: '', decoding: 'async', draggable: 'false' });
    placeImg(el, a, pv.page);
    pv.imgLayer.append(el);
    const d = { el, key: a.key, url: null };
    pv.dom.set(a.id, d);
    store.getBlob(a.key).then(b => {
      if (!b || pv.dom.get(a.id) !== d || E.dead) return;
      d.url = URL.createObjectURL(b);
      el.src = d.url;
    }).catch(err => console.error(err));
  }
  function syncAssets(pv) {
    const want = [...pv.active].filter(t => t.want);
    if (!want.length) {
      pv.near = null;
      freePreview(pv);
      for (const id of [...pv.dom.keys()]) dropImg(pv, id);
      return;
    }
    const m = 700 / E.scale; // Vorlauf: Bilder laden, bevor sie ins Bild kommen
    pv.near = {
      x0: Math.min(...want.map(t => t.x0)) - m, y0: Math.min(...want.map(t => t.y0)) - m,
      x1: Math.max(...want.map(t => t.x1)) + m, y1: Math.max(...want.map(t => t.y1)) + m,
    };
    const keep = new Set();
    for (const a of assetsOf(pv)) {
      if (!isNear(pv, a)) continue;
      keep.add(a.id);
      const d = pv.dom.get(a.id);
      if (d && d.key === a.key) placeImg(d.el, a, pv.page); // Seite kann größer geworden sein
      else { dropImg(pv, a.id); showImg(pv, a); }
    }
    for (const id of [...pv.dom.keys()]) if (!keep.has(id)) dropImg(pv, id);
  }
  // Bilder in voller Auflösung für Karteikarten-Ausschnitte: cards.js lädt sie selbst aus dem Speicher
  const fullImgs = () => new Map();

  function renderTexts(pv) {
    pv.texts.replaceChildren(...pv.page.texts.map(t => h('div', { class: 'text-item', 'data-id': t.id }, t.text)));
    layoutTexts(pv);
  }
  function layoutTexts(pv) {
    const s = E.scale;
    for (const d of pv.texts.children) {
      const t = pv.page.texts.find(x => x.id === d.dataset.id);
      if (t) Object.assign(d.style, { left: t.x * s + 'px', top: t.y * s + 'px', maxWidth: t.w * s + 'px', fontSize: t.size * s + 'px', color: t.color });
    }
  }
  function textBox(pv, t) {
    const d = pv.texts.querySelector(`[data-id="${t.id}"]`), s = E.scale;
    return { x: t.x, y: t.y, w: d ? d.offsetWidth / s : t.w, h: d ? d.offsetHeight / s : t.size * 1.3 };
  }

  // ---------- Layout & Zoom ----------
  function computeScale() {
    // An der typischen Seitenbreite ausrichten, aber nie kleiner als 40 %, damit Handschrift lesbar bleibt –
    // sehr breite Seiten (z. B. aus OneNote) scrollen dann seitlich.
    const ws = E.pages.map(p => p.w).sort((a, b) => a - b);
    E.fit = Math.min(1.6, Math.max(0.4, (scroller.clientWidth - 32) / ws[Math.floor(ws.length / 2)]));
    E.scale = E.fit * E.zoom;
    // Kacheln etwa TILE_PX Bildschirmpunkte groß; Zweierpotenzen, damit nicht bei jeder Zoomänderung neu aufgeteilt wird
    E.tileUnit = Math.min(32768, Math.max(128, 2 ** Math.round(Math.log2(TILE_PX / E.scale))));
  }
  function sizePV(pv) {
    const d = dpr();
    pv.el.style.width = devPx(pv.page.w) / d + 'px'; // ganze Gerätepixel, damit auch folgende Seiten auf dem Raster liegen
    pv.el.style.height = devPx(pv.page.h) / d + 'px';
  }
  function layoutPV(pv) {
    for (const t of pv.active) if (t.cv) placeTile(t);
    for (const t of pv.old) placeTile(t);
    placePreview(pv);
    layoutTexts(pv);
  }
  function layoutAll() {
    computeScale();
    // Abstand zwischen den Seiten wächst mit dem Zoom mit (6–30 px) – sonst passt die CSS-Skalierung während
    // einer Zoom-Geste nicht zum Layout danach, und bei kleinem Zoom springt die Ansicht beim Loslassen.
    const gap = Math.max(6, Math.min(30, 30 * E.scale));
    pagesEl.style.gap = gap + 'px';
    pagesEl.classList.toggle('tight', gap < 22); // dann ist kein Platz für „Seite N“
    for (const pv of E.pvs.values()) sizePV(pv);
    const d = dpr(), frac = v => ((v * d) % 1 + 1) % 1, pvs = [...E.pvs.values()];
    // Versatz der Seiten zum Pixelraster (z. B. durch Zentrieren). Erst alle Positionen lesen, dann schreiben:
    // abwechselnd hätte der Browser bei langen Skripten für jede Seite das ganze Layout neu berechnet.
    const rects = pvs.map(pv => pv.el.getBoundingClientRect());
    pvs.forEach((pv, i) => {
      pv.off = { x: frac(rects[i].left), y: frac(rects[i].top) };
      layoutPV(pv);
    });
    zoomLabel.textContent = Math.round(E.scale * 100) + '%'; // 100 % = Originalgröße
    if (E.sel) positionSel();
    refreshTiles();
    nav?.update();
  }
  // Nach Zoom/Größenänderung: Raster anpassen bzw. Kacheln als veraltet markieren. Neu gezeichnet wird
  // nach und nach über die Warteschlange; bis dahin bleiben die bisherigen Kacheln (skaliert) sichtbar.
  function refreshTiles() {
    if (E.builtUnit !== E.tileUnit) {
      for (const pv of E.pvs.values()) buildTiles(pv);
      E.builtUnit = E.tileUnit;
    } else if (E.paintScale !== E.scale) {
      for (const pv of E.pvs.values()) for (const t of pv.active) t.fresh = false;
    }
    E.paintScale = E.scale;
    if (E.holdVis) return;
    updateVisible();
    for (const pv of E.pvs.values()) syncAssets(pv); // Bildauflösung an die Zoomstufe anpassen
  }
  // Inhaltspunkt unter der Bildschirmposition (cx, cy), in Koordinaten der nächstgelegenen Seite
  function anchorAt(cx, cy) {
    let best = null, bd = Infinity;
    for (const pv of E.pvs.values()) {
      const r = pv.el.getBoundingClientRect();
      const d = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
      if (d < bd) { bd = d; best = { pv, r }; }
    }
    return best && { pv: best.pv, ux: (cx - best.r.left) / E.scale, uy: (cy - best.r.top) / E.scale };
  }
  // Zoomen und so scrollen, dass der Inhaltspunkt `a` danach genau unter (cx, cy) liegt
  const clampZoom = z => Math.min(4 / E.fit, Math.max(0.03 / E.fit, z)); // Darstellung zwischen 3 % und 400 % der Originalgröße
  function zoomAnchored(z, a, cx, cy) {
    E.zoom = clampZoom(z);
    E.holdVis = true; // Sichtbarkeit erst nach dem Scrollen prüfen, sonst würden gerade sichtbare Kacheln verworfen
    layoutAll();
    E.holdVis = false;
    if (a) {
      const r = a.pv.el.getBoundingClientRect();
      scroller.scrollLeft += r.left + a.ux * E.scale - cx;
      scroller.scrollTop += r.top + a.uy * E.scale - cy;
    }
    updateVisible();
    for (const pv of E.pvs.values()) syncAssets(pv);
    labelLater(); // nach dem Zoomen kann eine andere Seite in der Mitte stehen
  }
  function setZoom(z, cx, cy) {
    if (cx == null) { const sr = scroller.getBoundingClientRect(); cx = sr.left + sr.width / 2; cy = sr.top + sr.height / 2; }
    zoomAnchored(z, anchorAt(cx, cy), cx, cy);
  }

  function sizeOverlay() {
    ov.width = Math.round(stage.clientWidth * dpr());
    ov.height = Math.round(stage.clientHeight * dpr());
  }
  const ro = new ResizeObserver(() => {
    const sr = scroller.getBoundingClientRect(), a = anchorAt(sr.left + 20, sr.top + 20);
    sizeOverlay();
    zoomAnchored(E.zoom, a, sr.left + 20, sr.top + 20);
  });

  // ---------- Live-Ebene (gerade entstehender Strich, Lasso, Radierer) ----------
  function ovCtx(pv) {
    const ctx = ov.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ov.width, ov.height);
    if (pv) {
      const r = pv.el.getBoundingClientRect(), sr = stage.getBoundingClientRect(), d = dpr(), s = E.scale;
      ctx.setTransform(d * s, 0, 0, d * s, d * (r.left - sr.left), d * (r.top - sr.top));
    }
    return ctx;
  }
  let liveQ = false;
  function requestLive() { if (!liveQ) { liveQ = true; requestAnimationFrame(drawLive); } }
  function drawLive() {
    liveQ = false;
    const A = E.act;
    if (!A) { ovCtx(null); return; }
    if (A.needRedraw) { A.needRedraw = false; redraw(A.pv, A.removed || null, A.dirtyBox); A.dirtyBox = null; }
    const ctx = ovCtx(A.pv), s = E.scale;
    const lpx = s * dpr(); // Gerätepixel pro Seiteneinheit (Detailstufe wie in den Kacheln)
    if (E.cur) ink.drawStroke(ctx, E.cur, 0, 0, lpx);
    if (A.lasso) {
      const L = A.lasso;
      ctx.save();
      ctx.lineWidth = 1.5 / s;
      ctx.setLineDash([6 / s, 5 / s]);
      ctx.strokeStyle = '#2f6fed';
      ctx.fillStyle = 'rgba(47,111,237,.07)';
      ctx.beginPath();
      ctx.moveTo(L[0], L[1]);
      for (let i = 2; i < L.length; i += 2) ctx.lineTo(L[i], L[i + 1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    if (A.drag) for (const st of A.pv.page.strokes) if (E.sel.ids.has(st.id)) ink.drawStroke(ctx, st, A.drag.dx, A.drag.dy, lpx);
    if (A.tool === 'eraser' && A.last) {
      ctx.save();
      ctx.lineWidth = 1 / s;
      ctx.strokeStyle = 'rgba(0,0,0,.45)';
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.beginPath();
      ctx.arc(A.last.x, A.last.y, eraserR(), 0, 6.3);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---------- Eingabe ----------
  function toPage(pv, e, r = pv.el.getBoundingClientRect()) {
    return {
      x: (e.clientX - r.left) / E.scale,
      y: (e.clientY - r.top) / E.scale,
      p: e.pointerType === 'pen' ? Math.max(0.05, e.pressure || 0.5) : 0.5,
    };
  }

  // Ein Strich, dessen „Stift abgehoben“ nie ankam (kommt unter Last oder am Bildschirmrand vor), wird
  // abgeschlossen, sobald der Stift wieder aufsetzt – sonst würde jeder weitere Strich ignoriert und die
  // App wirkte eingefroren, bis man sie verlässt.
  const finishLost = () => onUp({ pointerId: E.act.pid, type: 'pointercancel' });
  function onDown(e) {
    if (E.act) {
      if (E.act.touch) { if (e.pointerType === 'touch') cancelAct(); return; } // zweiter Finger: Zoomen statt Zeichnen
      if (e.pointerType === 'touch') return; // Finger während eines Stiftstrichs ignorieren
      finishLost();
    }
    // Pencil auf dem Scroll-Griff (liegt über dem rechten Seitenrand): schreibt auf der Seite darunter
    const el = e.target.closest('.page') || (e.target.closest('.scrub') && document.elementsFromPoint(e.clientX, e.clientY).find(x => x.classList.contains('page')));
    if (!el || e.target.closest('.page-btn, .selmenu, .text-edit')) return;
    if (e.pointerType === 'touch' && !S.fingerDraw) return; // Finger scrollt
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (document.activeElement?.classList?.contains('text-edit')) {
      document.activeElement.blur();
      if (S.tool === 'text') return;
    }
    const pv = E.pvs.get(el.dataset.id);
    if (!pv) return;
    e.preventDefault();
    userActive(); // automatischen Abgleich kurz zurückstellen
    if (card && S.tool === 'card') setTool(lastDrawTool); // auf der Karte schreibt man (Rahmen gilt für die Notiz)
    try { el.setPointerCapture(e.pointerId); } catch { /* egal */ }
    const pt = toPage(pv, e);
    E.act = { pid: e.pointerId, touch: e.pointerType === 'touch', pv, tool: S.tool, start: pt, last: pt };
    if (S.tool === 'pen' || S.tool === 'hl') penDown(pt);
    else if (S.tool === 'eraser') eraseDown(pt);
    else if (S.tool === 'lasso') lassoDown(pt);
    else if (S.tool === 'card') cardDown(pt);
    requestLive();
  }
  function onMove(e) {
    const A = E.act;
    if (!A || e.pointerId !== A.pid) return;
    const r = A.pv.el.getBoundingClientRect();
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    const pts = (evs.length ? evs : [e]).map(ev => toPage(A.pv, ev, r));
    if (A.tool === 'pen' || A.tool === 'hl') penMove(pts);
    else if (A.tool === 'eraser') eraseMove(pts);
    else if (A.tool === 'lasso') lassoMove(pts);
    else if (A.tool === 'card') cardMove(pts);
    A.last = pts[pts.length - 1];
    requestLive();
  }
  function onUp(e) {
    const A = E.act;
    if (!A || e.pointerId !== A.pid) return;
    try { A.pv.el.releasePointerCapture?.(A.pid); } catch { /* egal */ }
    if (A.tool === 'pen' || A.tool === 'hl') penUp();
    else if (A.tool === 'eraser') eraseUp();
    else if (A.tool === 'lasso') lassoUp();
    else if (A.tool === 'card') cardUp(e.type === 'pointerup');
    else if (A.tool === 'text' && e.type === 'pointerup') { const pt = toPage(A.pv, e); editText(A.pv, hitText(A.pv, pt), pt); }
    E.act = null;
    requestLive();
  }
  function cancelAct() {
    const A = E.act;
    clearTimeout(E.holdT);
    E.cur = null;
    A.box?.remove();
    if (A.tool === 'eraser' && A.changed) { A.pv.extra = null; redraw(A.pv); } // ausgeblendete Striche wieder zeigen
    if (A.drag) { dragVisual(0, 0); redraw(A.pv); }
    E.act = null;
    requestLive();
  }

  // Stift & Marker – Stift halten = Linie/Form begradigen
  function penDown(pt) {
    const hl = S.tool === 'hl';
    E.cur = { id: uid(), tool: hl ? 'hl' : 'pen', color: hl ? S.hlColor : S.penColor, size: SIZES[S.tool][S.size[S.tool]], pts: [pt.x, pt.y, pt.p] };
    E.snapLine = false;
    armHold(pt);
  }
  function armHold(pt) {
    clearTimeout(E.holdT);
    E.holdAt = pt;
    E.holdT = setTimeout(onHold, HOLD_MS);
  }
  function onHold() {
    const c = E.cur;
    if (!c || c.shape) return;
    const r = ink.recognize(c.pts, true, E.scale); // Formerkennung in Bildschirmgröße
    if (!r) return;
    c.pts = r.pts;
    c.shape = true;
    E.snapLine = r.type === 'line'; // Endpunkt der Linie folgt danach weiter dem Stift
    if (E.snapLine) setLineEnd(c, c.pts[3], c.pts[4]);
    requestLive();
  }
  // fast waagerecht/senkrecht/45° → exakt einrasten
  function setLineEnd(c, x, y) {
    const sx = c.pts[0], sy = c.pts[1], len = Math.hypot(x - sx, y - sy);
    const a = Math.atan2(y - sy, x - sx), step = Math.PI / 4, snapA = Math.round(a / step) * step;
    if (Math.abs(a - snapA) < 0.07) { x = sx + Math.cos(snapA) * len; y = sy + Math.sin(snapA) * len; }
    c.pts[3] = x;
    c.pts[4] = y;
  }
  function penMove(pts) {
    const c = E.cur;
    if (!c) return;
    for (const pt of pts) {
      if (E.snapLine) { setLineEnd(c, pt.x, pt.y); continue; }
      if (c.shape) continue;
      // Abstände in Bildschirmpunkten (nicht Seiteneinheiten), damit sich Stift und „Halten“ bei jedem Zoom gleich
      // verhalten: Punkte unter 0,4 px Abstand weglassen; als „gehalten“ gilt, wer 480 ms unter 4 px bleibt.
      const n = c.pts.length, dx = (pt.x - c.pts[n - 3]) * E.scale, dy = (pt.y - c.pts[n - 2]) * E.scale;
      if (dx * dx + dy * dy < 0.16) continue;
      c.pts.push(pt.x, pt.y, pt.p);
      if (Math.hypot(pt.x - E.holdAt.x, pt.y - E.holdAt.y) * E.scale > 4) armHold(pt);
    }
  }
  function penUp() {
    clearTimeout(E.holdT);
    const c = E.cur, pv = E.act.pv;
    E.cur = null;
    if (!c) return;
    if (!c.shape && S.shapeMode) { const r = ink.recognize(c.pts, false, E.scale); if (r) { c.pts = r.pts; c.shape = true; } }
    c.pts = c.pts.map(r2);
    const before = snap(pv.page);
    pv.page.strokes = [...pv.page.strokes, c];
    commit(pv, before);
    const b = ink.strokeBBox(c);
    if (c.tool === 'pen') {
      // schneller Weg: nur den neuen Strich auf die betroffenen Kacheln malen
      for (const t of pv.active) {
        if (b.y > t.y1 + t.pad || b.y + b.h < t.y0 || b.x > t.x1 + t.pad || b.x + b.w < t.x0) continue;
        if (t.rendered) ink.drawStroke(tileCtx(t), c, 0, 0, t.bs);
        else if (t.want) paintTile(t); // bisher leer (nur Bild/Weiß) – jetzt mit Canvas
      }
    } else redraw(pv, null, b);
  }

  // Radierer: „Ganze Striche“ löscht jeden berührten Strich, „Teilweise“ nur das Stück unter dem Radierer
  const eraserR = () => SIZES.eraser[S.size.eraser];
  // Während des Radierens werden getroffene Striche nur ausgeblendet (A.removed); erst beim Absetzen
  // entsteht das neue Strich-Array. So muss der räumliche Index nicht bei jedem Treffer neu aufgebaut werden.
  // Beim teilweisen Radieren stehen die Reste so lange in A.groups (Original-ID → Stücke) und pv.extra.
  function eraseDown(pt) {
    const A = E.act;
    A.before = snap(A.pv.page);
    A.base = A.pv.page.strokes;
    A.removed = new Set();
    A.part = S.eraserMode === 'part';
    A.groups = new Map();
    A.owner = new Map(); // Reststück → ID des Original-Strichs
    A.changed = false;
    eraseAt(pt);
  }
  function eraseMove(pts) {
    const A = E.act, r = eraserR();
    let l = A.last;
    for (const pt of pts) {
      const n = Math.max(1, Math.ceil(Math.hypot(pt.x - l.x, pt.y - l.y) / (r / 2)));
      for (let i = 1; i <= n; i++) eraseAt({ x: l.x + ((pt.x - l.x) * i) / n, y: l.y + ((pt.y - l.y) * i) / n });
      l = pt;
    }
  }
  function eraseAt(pt) {
    const A = E.act, r = eraserR();
    // nur Striche in der Nähe prüfen (räumlicher Index, siehe ink.js)
    const near = ink.strokesIn(A.base, { x0: pt.x - r, y0: pt.y - r, x1: pt.x + r, y1: pt.y + r });
    const join = (b, c) => (b ? { x: Math.min(b.x, c.x), y: Math.min(b.y, c.y), w: Math.max(b.x + b.w, c.x + c.w) - Math.min(b.x, c.x), h: Math.max(b.y + b.h, c.y + c.h) - Math.min(b.y, c.y) } : c);
    // nur die Kacheln unter den getroffenen Strichen neu zeichnen
    const touched = s => {
      const sb = ink.strokeBBox(s);
      A.dirtyBox = join(A.dirtyBox, sb); // bis zum nächsten Frame
      A.eraseBox = join(A.eraseBox, sb); // ganze Geste
      A.changed = A.needRedraw = true;
    };
    if (A.part) { erasePart(pt, r, near, touched); return; }
    for (const s of near) {
      if (A.removed.has(s.id) || !ink.hitStroke(s, pt.x, pt.y, r)) continue;
      A.removed.add(s.id);
      touched(s);
    }
  }
  function erasePart(pt, r, near, touched) {
    const A = E.act;
    let cut = false;
    for (const s of near.filter(s => !A.removed.has(s.id)).concat([...A.owner.keys()])) {
      const rest = ink.cutStroke(s, pt.x, pt.y, r);
      if (!rest) continue;
      const pieces = rest.map(pts => ({ ...s, id: uid(), pts }));
      const orig = A.owner.get(s);
      if (orig) { // Reststück wird weiter zerschnitten
        const g = A.groups.get(orig);
        g.splice(g.indexOf(s), 1, ...pieces);
        A.owner.delete(s);
        for (const p of pieces) A.owner.set(p, orig);
      } else {
        A.removed.add(s.id);
        A.groups.set(s.id, pieces);
        for (const p of pieces) A.owner.set(p, s.id);
      }
      touched(s);
      cut = true;
    }
    if (cut) A.pv.extra = [...A.groups.values()].flat();
  }
  function eraseUp() {
    const A = E.act;
    A.pv.extra = null;
    if (!A.changed) return;
    // Reste an die Stelle des Originals (die Reihenfolge bestimmt, was oben liegt)
    A.pv.page.strokes = A.base.flatMap(s => (A.removed.has(s.id) ? A.groups.get(s.id) || [] : [s]));
    redraw(A.pv, null, A.eraseBox);
    commit(A.pv, A.before);
  }

  // Lasso
  function lassoDown(pt) {
    const A = E.act;
    if (E.sel && E.sel.pv === A.pv && inside(E.sel.box, pt, 8)) {
      A.drag = { dx: 0, dy: 0 };
      redraw(A.pv, E.sel.ids);
      return;
    }
    clearSelection();
    A.lasso = [pt.x, pt.y];
  }
  function lassoMove(pts) {
    const A = E.act;
    if (A.drag) {
      const p = pts[pts.length - 1];
      A.drag.dx = p.x - A.start.x;
      A.drag.dy = p.y - A.start.y;
      dragVisual(A.drag.dx, A.drag.dy);
    } else if (A.lasso) for (const p of pts) A.lasso.push(p.x, p.y);
  }
  function lassoUp() {
    const A = E.act, pv = A.pv, page = pv.page;
    if (A.drag) {
      const { dx, dy } = A.drag;
      dragVisual(0, 0);
      // Bereich der Auswahl vorher und nachher neu zeichnen (dort waren die Striche beim Ziehen ausgeblendet)
      const selBox = () => page.strokes.reduce((b, s) => (E.sel.ids.has(s.id) ? joinBox(b, ink.strokeBBox(s)) : b), null);
      let box = selBox();
      if (Math.abs(dx) + Math.abs(dy) > 0.5) {
        const before = snap(page);
        page.strokes = page.strokes.map(s => (E.sel.ids.has(s.id) ? ink.translateStroke(s, dx, dy) : s));
        page.texts = page.texts.map(t => (E.sel.tids.has(t.id) ? { ...t, x: r2(t.x + dx), y: r2(t.y + dy) } : t));
        commit(pv, before);
        renderTexts(pv);
        box = joinBox(box, selBox());
      }
      if (box) redraw(pv, null, box);
      else redraw(pv);
      updateSel();
      return;
    }
    const L = A.lasso;
    if (!L || L.length < 8) return;
    // nur Striche in der Nähe des Lassos genau prüfen (räumlicher Index) – große Seiten haben Tausende
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < L.length; i += 2) { x0 = Math.min(x0, L[i]); x1 = Math.max(x1, L[i]); y0 = Math.min(y0, L[i + 1]); y1 = Math.max(y1, L[i + 1]); }
    const near = ink.strokesIn(page.strokes, { x0, y0, x1, y1 }).filter(s => {
      const b = ink.strokeBBox(s);
      return b.x <= x1 && b.x + b.w >= x0 && b.y <= y1 && b.y + b.h >= y0;
    });
    const ids = new Set(near.filter(s => ink.strokeInPoly(s, L)).map(s => s.id));
    const tids = new Set(page.texts.filter(t => {
      const b = textBox(pv, t);
      return ink.pointInPoly(b.x + b.w / 2, b.y + b.h / 2, L) || ink.pointInPoly(b.x + 4, b.y + b.h / 2, L);
    }).map(t => t.id));
    if (ids.size || tids.size) setSelection(pv, ids, tids);
  }

  function setSelection(pv, ids, tids) {
    clearSelection();
    const boxEl = h('div', { class: 'selbox' });
    const barEl = h('div', { class: 'selmenu' },
      h('button', { onclick: deleteSel }, 'Löschen'),
      h('button', { onclick: duplicateSel }, 'Duplizieren'),
      h('button', { onclick: copySel }, 'Kopieren'),
      h('button', { onclick: e => menu(e.currentTarget, [{ swatches: [...PEN_COLORS, ...HL_COLORS], onPick: recolorSel }]) }, 'Farbe'));
    pv.el.append(boxEl, barEl);
    E.sel = { pv, ids, tids, boxEl, barEl, box: null };
    updateSel();
  }
  function clearSelection() {
    if (!E.sel) return;
    E.sel.boxEl.remove();
    E.sel.barEl.remove();
    E.sel = null;
  }
  function updateSel() {
    const sel = E.sel;
    if (!sel) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = b => { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); };
    for (const s of sel.pv.page.strokes) if (sel.ids.has(s.id)) add(ink.strokeBBox(s));
    for (const t of sel.pv.page.texts) if (sel.tids.has(t.id)) add(textBox(sel.pv, t));
    if (x0 === Infinity) { clearSelection(); return; }
    sel.box = { x: x0 - 6, y: y0 - 6, w: x1 - x0 + 12, h: y1 - y0 + 12 };
    positionSel();
  }
  function positionSel() {
    const { box, boxEl, barEl } = E.sel, s = E.scale;
    if (!box) return;
    Object.assign(boxEl.style, { left: box.x * s + 'px', top: box.y * s + 'px', width: box.w * s + 'px', height: box.h * s + 'px' });
    const top = box.y * s - 48;
    barEl.style.left = Math.max(0, box.x * s) + 'px';
    barEl.style.top = (top < 4 ? (box.y + box.h) * s + 8 : top) + 'px';
  }
  function dragVisual(dx, dy) {
    const sel = E.sel, s = E.scale;
    const tr = dx || dy ? `translate(${dx * s}px, ${dy * s}px)` : '';
    sel.boxEl.style.transform = sel.barEl.style.transform = tr;
    for (const d of sel.pv.texts.children) if (sel.tids.has(d.dataset.id)) d.style.transform = tr;
  }
  function selItems() {
    const { pv, ids, tids } = E.sel;
    return { strokes: pv.page.strokes.filter(s => ids.has(s.id)), texts: pv.page.texts.filter(t => tids.has(t.id)) };
  }
  function deleteSel() {
    const { pv, ids, tids } = E.sel, page = pv.page, before = snap(page);
    page.strokes = page.strokes.filter(s => !ids.has(s.id));
    page.texts = page.texts.filter(t => !tids.has(t.id));
    clearSelection();
    commit(pv, before);
    redrawChanged(pv, before.strokes);
    renderTexts(pv);
  }
  function addItems(pv, items, dx, dy) {
    const page = pv.page, before = snap(page);
    const ns = items.strokes.map(s => ({ ...ink.translateStroke(s, dx, dy), id: uid() }));
    const nt = items.texts.map(t => ({ ...t, id: uid(), x: t.x + dx, y: t.y + dy }));
    page.strokes = [...page.strokes, ...ns];
    page.texts = [...page.texts, ...nt];
    commit(pv, before);
    redrawChanged(pv, before.strokes);
    renderTexts(pv);
    setSelection(pv, new Set(ns.map(s => s.id)), new Set(nt.map(t => t.id)));
  }
  function duplicateSel() { addItems(E.sel.pv, selItems(), 24, 24); }
  function copySel() {
    E.clip = JSON.parse(JSON.stringify(selItems()));
    toast('Kopiert – über ⋯ an einer Seite einfügen');
  }
  function recolorSel(c) {
    const { pv, ids, tids } = E.sel, page = pv.page, before = snap(page);
    page.strokes = page.strokes.map(s => (ids.has(s.id) ? { ...s, color: c } : s));
    page.texts = page.texts.map(t => (tids.has(t.id) ? { ...t, color: c } : t));
    commit(pv, before);
    redrawChanged(pv, before.strokes);
    renderTexts(pv);
    updateSel();
  }

  // Karteikarte aus Bereich: Rahmen aufziehen → Ausschnitt (Folie + Handschrift) wird Antwort oder Frage einer neuen Karte
  function cardDown() {
    const A = E.act;
    A.box = h('div', { class: 'cardbox' });
    A.pv.el.append(A.box);
    A.r = { x: A.start.x, y: A.start.y, w: 0, h: 0 };
  }
  function cardMove(pts) {
    const A = E.act, p = pts[pts.length - 1], s = E.scale;
    A.r = { x: Math.min(A.start.x, p.x), y: Math.min(A.start.y, p.y), w: Math.abs(p.x - A.start.x), h: Math.abs(p.y - A.start.y) };
    Object.assign(A.box.style, { left: A.r.x * s + 'px', top: A.r.y * s + 'px', width: A.r.w * s + 'px', height: A.r.h * s + 'px' });
  }
  function cardUp(ok) {
    const { box, pv, r: raw } = E.act, page = pv.page;
    const x0 = Math.max(0, raw.x), y0 = Math.max(0, raw.y), x1 = Math.min(page.w, raw.x + raw.w), y1 = Math.min(page.h, raw.y + raw.h);
    const r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (!ok || r.w < 20 || r.h < 12) {
      box.remove();
      if (ok) toast('Zieh einen Rahmen um den Teil, der auf die Karteikarte soll.');
      return;
    }
    menu({ getBoundingClientRect: () => box.getBoundingClientRect() }, [
      panel && { header: 'Zur offenen Karte' },
      panel && { icon: 'cardPlus', label: 'Auf die Rückseite (Antwort)', onClick: () => addToCard(pv, r, 1) },
      panel && { icon: 'cardPlus', label: 'Auf die Vorderseite (Frage)', onClick: () => addToCard(pv, r, 0) },
      panel && { sep: true },
      { header: 'Neue Karteikarte aus dem Rahmen' },
      { icon: 'cardPlus', label: 'Als Antwort (Frage schreibst du)', onClick: () => makeCard(pv, r, 'back') },
      { icon: 'cardPlus', label: 'Als Frage (Antwort schreibst du)', onClick: () => makeCard(pv, r, 'front') },
      { icon: 'card', label: 'Als Abdeck-Karte (Bereiche verdecken)', onClick: () => makeOcclusion(pv, r) },
      { sep: true },
      { icon: 'sparkle', label: 'Für Claude markieren …', onClick: async () => { await flush(); markForClaude({ nb, page: pv.page, region: r, loaded: fullImgs(pv) }); } },
    ]);
    const watch = setInterval(() => { if (!document.querySelector('.menu')) { clearInterval(watch); box.remove(); } }, 250);
  }
  async function makeCard(pv, r, side) {
    await flush();
    saveView();
    const pr = progress('Karteikarte wird angelegt …');
    try {
      const image = await snapshot(pv.page, r, fullImgs(pv));
      const c = await createCard({ folderId: nb.folderId || null, image, side, source: { noteId: nb.id, pageId: pv.page.id, ...r } });
      pr.close();
      await openCardPanel(c.id, side);
      // Rahmen oben im sichtbaren Teil der Notiz halten – darunter steht meist, was auf die Karte soll
      const pr2 = pv.el.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
      scroller.scrollTop += pr2.top + r.y * E.scale - sr.top - 24;
      toast(side === 'front' ? 'Schreib die Antwort auf die Rückseite – die Folie bleibt sichtbar.' : 'Schreib die Frage auf die Vorderseite – die Folie bleibt sichtbar.');
    } catch (err) {
      console.error(err);
      toast('Karte konnte nicht angelegt werden: ' + err.message);
    } finally { pr.close(); }
  }

  // ---------- Kartenfenster ----------
  let panel = null; // { id, ed } – im Kartenfenster offene Karte
  async function openCardPanel(id, side) {
    await closeCardPanel();
    body.classList.add('with-card');
    const ed = await openEditor(panelHost, id, {
      side,
      onClose: () => closeCardPanel(),
      onFull: async () => { // Karte als eigene Ansicht öffnen, „Zurück“ führt wieder zur Notiz
        await closeCardPanel();
        try { sessionStorage.setItem('notizen.return:' + id, 'nb/' + nb.id); } catch { /* egal */ }
        location.hash = 'nb/' + id;
      },
    });
    if (ed) panel = { id, ed };
    else body.classList.remove('with-card');
  }
  async function closeCardPanel() {
    if (!panel) return;
    const p = panel;
    panel = null;
    await p.ed();
    panelHost.replaceChildren();
    body.classList.remove('with-card');
    keyOwner = editor;
  }
  // weiteren Ausschnitt aus der Notiz auf die offene Karte setzen (side 0 = Vorder-, 1 = Rückseite)
  async function addToCard(pv, r, side) {
    if (!panel) return;
    await flush();
    const pr = progress('Ausschnitt wird eingefügt …');
    try {
      await panel.ed.addImage(side, await snapshot(pv.page, r, fullImgs(pv)));
    } catch (err) {
      console.error(err);
      toast('Das hat nicht geklappt: ' + err.message);
    } finally { pr.close(); }
  }
  // (nur im Kartenfenster) Bild unter den bisherigen Inhalt einer Kartenseite setzen
  async function addImage(side, image) {
    const pv = E.pvs.get(E.pages[side]?.id);
    if (!pv) return;
    const page = pv.page;
    let bottom = 0;
    for (const im of page.images || []) bottom = Math.max(bottom, im.y + im.h);
    for (const t of page.texts) bottom = Math.max(bottom, t.y + t.size * 1.3);
    for (const st of page.strokes) { const b = ink.strokeBBox(st); bottom = Math.max(bottom, b.y + b.h); }
    const m = 30, sc = Math.min(2, (page.w - 2 * m) / image.w), w = image.w * sc, h2 = image.h * sc;
    const y = bottom ? bottom + 20 : m;
    const key = 'img_' + uid();
    await store.putBlob(key, image.blob);
    page.images = [...(page.images || []), { id: 'i' + uid(), key, x: (page.w - w) / 2, y, w, h: h2 }];
    if (y + h2 + m > page.h) { page.h = Math.ceil(y + h2 + m); unrender(pv); buildTiles(pv); layoutAll(); }
    else syncAssets(pv);
    markDirty(page);
    await flush();
    const pr = pv.el.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
    scroller.scrollTop += pr.top + y * E.scale - sr.top - 16; // eingefügten Ausschnitt zeigen
    updateVisible();
  }

  // Abdeck-Karte: Ausschnitt als Bild speichern, dann im Abdeck-Editor Bereiche verdecken
  async function makeOcclusion(pv, r) {
    await flush();
    saveView();
    const pr = progress('Ausschnitt wird vorbereitet …');
    try {
      const image = await snapshot(pv.page, r, fullImgs(pv));
      const key = 'img_' + uid();
      await store.putBlob(key, image.blob);
      startOcclusion({ key, w: r.w, h: r.h, folderId: nb.folderId || null, source: { noteId: nb.id, pageId: pv.page.id, ...r }, returnTo: 'nb/' + nb.id });
    } catch (err) {
      console.error(err);
      toast('Das hat nicht geklappt: ' + err.message);
    } finally { pr.close(); }
  }

  // Text
  function hitText(pv, pt) {
    for (let i = pv.page.texts.length - 1; i >= 0; i--) {
      const t = pv.page.texts[i];
      if (inside(textBox(pv, t), pt, 4)) return t;
    }
    return null;
  }
  function editText(pv, t, pt) {
    const s = E.scale, page = pv.page;
    const size = t ? t.size : SIZES.text[S.size.text];
    const color = t ? t.color : S.penColor;
    const x = t ? t.x : Math.max(4, Math.min(pt.x, page.w - 160));
    const y = t ? t.y : Math.max(4, pt.y - size * 0.65);
    const w = t ? t.w : Math.min(420, page.w - x - 24);
    const ta = h('textarea', { class: 'text-edit', spellcheck: true, 'aria-label': 'Text' });
    ta.value = t?.text || '';
    Object.assign(ta.style, { left: x * s + 'px', top: y * s + 'px', width: w * s + 'px', fontSize: size * s + 'px', color });
    const div = t && pv.texts.querySelector(`[data-id="${t.id}"]`);
    if (div) div.style.visibility = 'hidden';
    const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    ta.addEventListener('input', fit);
    ta.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') ta.blur(); });
    ta.addEventListener('blur', () => {
      const v = ta.value.replace(/\s+$/, '');
      ta.remove();
      if (div) div.style.visibility = '';
      const before = snap(page);
      if (t) {
        if (v === t.text) return;
        page.texts = v ? page.texts.map(x2 => (x2.id === t.id ? { ...x2, text: v } : x2)) : page.texts.filter(x2 => x2.id !== t.id);
      } else {
        if (!v) return;
        page.texts = [...page.texts, { id: uid(), x: r2(x), y: r2(y), w: r2(w), size, color, text: v }];
      }
      commit(pv, before);
      renderTexts(pv);
    }, { once: true });
    pv.el.append(ta);
    fit();
    ta.focus();
  }

  // ---------- Rückgängig / Speichern ----------
  function commit(pv, before) {
    E.undo.push({ id: pv.page.id, before, after: snap(pv.page) });
    if (E.undo.length > 300) E.undo.shift();
    E.redo = [];
    markDirty(pv.page);
    updUndo();
  }
  function undo() { if (E.act) return; const it = E.undo.pop(); if (!it) return; E.redo.push(it); applyState(it.id, it.before); }
  function redo() { if (E.act) return; const it = E.redo.pop(); if (!it) return; E.undo.push(it); applyState(it.id, it.after); }
  function applyState(id, st) {
    updUndo();
    const pv = E.pvs.get(id);
    if (!pv) return;
    clearSelection();
    const old = pv.page.strokes;
    pv.page.strokes = st.strokes;
    pv.page.texts = st.texts;
    redrawChanged(pv, old);
    renderTexts(pv);
    markDirty(pv.page);
    const r = pv.el.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
    if (r.bottom < sr.top || r.top > sr.bottom) showPage(pv, 'center');
  }
  function updUndo() { undoBtn.disabled = !E.undo.length; redoBtn.disabled = !E.redo.length; }

  function markDirty(page) {
    E.dirty.add(page);
    const pv = E.pvs.get(page.id);
    if (pv) { pv.prevFresh = false; previewLater(); } // Vorschau später (in einer Pause) auffrischen
    clearTimeout(E.saveT);
    // Große Seiten (OneNote: Tausende Striche) zu speichern dauert spürbar – dort erst nach einer längeren
    // Schreibpause. Beim Verlassen der Notiz oder der App wird ohnehin sofort gespeichert.
    E.saveT = setTimeout(flush, page.strokes.length > 1500 ? 2000 : 400);
  }
  async function flush() {
    clearTimeout(E.saveT);
    const list = [...E.dirty];
    E.dirty.clear();
    try {
      for (const p of list) await store.put('pages', p);
      if (list.length) await store.put('notebooks', nb);
    } catch (err) {
      console.error(err);
      toast('Speichern fehlgeschlagen: ' + err.message);
      list.forEach(p => E.dirty.add(p));
    }
  }
  const saveNb = () => store.put('notebooks', nb);

  // ---------- Seitenverwaltung ----------
  function currentIndex() {
    const sr = scroller.getBoundingClientRect(), mid = sr.top + sr.height / 2;
    let best = 0, bd = Infinity;
    E.pages.forEach((p, i) => {
      const r = E.pvs.get(p.id).el.getBoundingClientRect();
      const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  function updatePageLabel() { pageLabel.textContent = `${currentIndex() + 1} / ${E.pages.length}`; }
  // Seitenübersicht und Scroll-Leiste (pagenav.js) – nicht bei Karteikarten
  let nav = null;
  function toggleNav() {
    if (!nav) return;
    S.thumbs = !nav.open;
    saveSettings();
    nav.setOpen(S.thumbs);
  }
  function jumpTo(i) {
    const pv = E.pvs.get(E.pages[i]?.id);
    if (pv) showPage(pv);
  }
  // Seite in den sichtbaren Bereich holen – sofort und nur im Scrollbereich der Notiz. Kein scrollIntoView mit
  // „smooth“: Safari animiert dann weiter, auch wenn die App zwischendurch selbst scrollt (z. B. beim Zoomen
  // gleich nach dem Einfügen einer Seite), und landet danach an der alten Zielposition – auf einer ganz anderen Seite.
  function showPage(pv, where = 'start') {
    stopInertia();
    const r = pv.el.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
    scroller.scrollTop += where === 'center' ? r.top + r.height / 2 - (sr.top + sr.height / 2) : r.top - sr.top - 8;
    updateVisible();
  }
  function renumber() {
    E.pages.forEach((p, i) => { E.pvs.get(p.id).num.textContent = card ? ['Vorderseite – Frage', 'Rückseite – Antwort'][i] || `Seite ${i + 1}` : `Seite ${i + 1}`; });
    updatePageLabel();
    nav?.refresh();
  }
  async function insertPage(i, p) {
    E.pages.splice(i + 1, 0, p);
    nb.pageIds = E.pages.map(x => x.id);
    await store.put('pages', p);
    await saveNb();
    const pv = makePV(p), next = E.pages[i + 2];
    pagesEl.insertBefore(pv.el, next ? E.pvs.get(next.id).el : null);
    renderTexts(pv);
    layoutAll();
    updateVisible();
    renumber();
    return pv;
  }
  async function addPageAfter(i) {
    const ref = E.pages[i];
    // Format der Seite davor: normale Seite → gleiche Größe, Vorlage, Papier. PDF-Seite → gleich groß (Querformat
    // bleibt Querformat), Vorlage/Papier der Notiz. Lange OneNote-/Folienseite → A4 in derselben Ausrichtung.
    let base = null;
    if (ref && !ref.bg && !ref.images?.length && ref.h <= 2000) base = ref;
    else if (ref?.bg) base = { w: ref.w, h: ref.h, template: nb.template, paper: nb.paper };
    else if (ref) { const [w, h] = ref.w > ref.h ? PAGE_SIZES.a4l : PAGE_SIZES.a4p; base = { w, h, template: nb.template, paper: nb.paper }; }
    const pv = await insertPage(i, newPage(nb, base));
    showPage(pv);
  }
  async function duplicatePage(i) {
    const src = E.pages[i], p = JSON.parse(JSON.stringify(src));
    p.id = uid();
    p.strokes = p.strokes.map(s => ({ ...s, id: uid() }));
    p.texts = p.texts.map(t => ({ ...t, id: uid() }));
    if (src.bg) {
      p.bg = 'bg_' + p.id;
      const b = await store.getBlob(src.bg);
      if (b) await store.putBlob(p.bg, b);
    }
    p.images = [];
    for (const im of src.images || []) {
      const key = 'img_' + uid(), b = await store.getBlob(im.key);
      if (b) await store.putBlob(key, b);
      p.images.push({ ...im, id: uid(), key });
    }
    await insertPage(i, p);
  }
  async function deletePage(i) {
    if (!(await confirmDialog('Seite löschen?', `Seite ${i + 1} wird endgültig gelöscht.`, 'Löschen', true))) return;
    const p = E.pages[i], pv = E.pvs.get(p.id);
    if (E.sel?.pv === pv) clearSelection();
    unrender(pv);
    pv.el.remove();
    E.pvs.delete(p.id);
    E.pages.splice(i, 1);
    E.dirty.delete(p);
    nb.pageIds = E.pages.map(x => x.id);
    await store.del('pages', p.id);
    if (p.bg) await store.delBlob(p.bg);
    for (const im of p.images || []) await store.delBlob(im.key);
    if (!E.pages.length) await insertPage(-1, newPage(nb));
    else { await saveNb(); layoutAll(); renumber(); }
  }
  async function movePage(i, d) {
    const j = i + d;
    if (j < 0 || j >= E.pages.length) return;
    const [p] = E.pages.splice(i, 1);
    E.pages.splice(j, 0, p);
    nb.pageIds = E.pages.map(x => x.id);
    const el = E.pvs.get(p.id).el, next = E.pages[j + 1];
    pagesEl.insertBefore(el, next ? E.pvs.get(next.id).el : null);
    await saveNb();
    renumber();
    showPage(E.pvs.get(p.id), 'center');
  }
  function setPageProp(pv, k, v) { pv.page[k] = v; redraw(pv); markDirty(pv.page); }

  function pageMenu(pv, anchor) {
    const i = E.pages.indexOf(pv.page), p = pv.page;
    if (card) { // Karteikarte: nur Einfügen, Vorlage und Papier
      menu(anchor, [
        E.clip && { icon: 'paste', label: 'Kopiertes einfügen', onClick: () => addItems(pv, E.clip, 0, 0) },
        { header: 'Vorlage' },
        ...ink.TEMPLATES.map(([k, l]) => ({ label: l, checked: p.template === k, onClick: () => setPageProp(pv, 'template', k) })),
        { header: 'Papier' },
        ...ink.PAPER_NAMES.map(([k, l]) => ({ label: l, checked: p.paper === k, onClick: () => setPageProp(pv, 'paper', k) })),
      ]);
      return;
    }
    menu(anchor, [
      { icon: 'pagePlus', label: 'Neue Seite danach', onClick: () => addPageAfter(i) },
      { icon: 'copy', label: 'Seite duplizieren', onClick: () => duplicatePage(i) },
      isLongPage(p) && { icon: 'file', label: 'In Seiten aufteilen', onClick: async () => {
        await flush(); // erst speichern, dann aufteilen und die Notiz neu öffnen
        if (await splitDialog([nb])) dispatchEvent(new HashChangeEvent('hashchange'));
      } },
      E.clip && { icon: 'paste', label: 'Kopiertes einfügen', onClick: () => addItems(pv, E.clip, 0, 0) },
      ...(p.bg ? [] : [
        { sep: true }, { header: 'Vorlage' },
        ...ink.TEMPLATES.map(([k, l]) => ({ label: l, checked: p.template === k, onClick: () => setPageProp(pv, 'template', k) })),
        { header: 'Papier' },
        ...ink.PAPER_NAMES.map(([k, l]) => ({ label: l, checked: p.paper === k, onClick: () => setPageProp(pv, 'paper', k) })),
      ]),
      { sep: true },
      i > 0 && { icon: 'arrowUp', label: 'Nach oben', onClick: () => movePage(i, -1) },
      i < E.pages.length - 1 && { icon: 'arrowDown', label: 'Nach unten', onClick: () => movePage(i, 1) },
      { icon: 'trash', label: 'Seite löschen', danger: true, onClick: () => deletePage(i) },
    ]);
  }

  function moreMenu(anchor) {
    menu(anchor, [
      { icon: 'download', label: 'Als PDF exportieren', onClick: exportNb },
      { icon: 'file', label: 'PDF anhängen …', onClick: attachPdf },
      { icon: 'edit', label: 'Notizbuch umbenennen', onClick: rename },
      { sep: true },
      { icon: 'hand', label: 'Mit Finger zeichnen', checked: S.fingerDraw, onClick: toggleFinger },
      { icon: 'zoomIn', label: 'Zoom zurücksetzen', onClick: () => setZoom(1) },
      { icon: 'help', label: 'Tipps & Gesten', onClick: showHelp },
    ]);
  }
  async function exportNb() {
    await flush();
    const pr = progress('PDF wird erstellt …');
    try {
      const blob = await exportPdf(E.pages, (i, n) => pr.set(`Seite ${i} von ${n}`, i / n));
      download(blob, safeName(nb.title) + '.pdf');
    } catch (err) {
      console.error(err);
      toast('Export fehlgeschlagen: ' + err.message);
    } finally { pr.close(); }
  }
  function attachPdf() {
    pickFiles('application/pdf,.pdf').then(async ([f]) => {
      if (!f) return;
      await flush();
      const pr = progress('PDF wird angehängt …');
      try {
        const { pages: added } = await importPdf(f, { notebook: nb, onProgress: (i, n) => pr.set(`Seite ${i} von ${n}`, i / n) });
        for (const p of added) {
          E.pages.push(p);
          const pv = makePV(p);
          pagesEl.append(pv.el);
          renderTexts(pv);
        }
        layoutAll();
        updateVisible();
        renumber();
        if (added[0]) showPage(E.pvs.get(added[0].id));
      } catch (err) {
        console.error(err);
        toast('Import fehlgeschlagen: ' + err.message);
      } finally { pr.close(); }
    });
  }
  async function rename() {
    const t = await promptText('Notizbuch umbenennen', nb.title);
    if (!t) return;
    nb.title = t;
    titleEl.textContent = t;
    await saveNb();
  }
  function showHelp() {
    const li = (b, t) => h('li', {}, h('b', {}, b), ' – ', t);
    modal({
      title: 'Tipps & Gesten',
      body: h('ul', { class: 'help' },
        li('Apple Pencil', 'schreibt; der Finger scrollt, zwei Finger zoomen. Die Handfläche wird ignoriert.'),
        li('Karteikarte aus Bereich', 'Werkzeug mit dem Rahmen-Symbol: Rahmen um einen Teil der Folie ziehen → wird Antwort oder Frage einer neuen Karte.'),
        li('Doppeltipp mit dem Finger','wechselt zwischen Stift und Radierer (der Doppeltipp auf den Pencil selbst geht in Web-Apps leider nicht).'),
        li('Scroll-Leiste', 'Griff am rechten Rand kurz festhalten, dann ziehen – springt schnell durch lange Skripte. Einfach drüberwischen scrollt normal.'),
        li('Radierer','„Ganze Striche“ löscht jeden berührten Strich auf einmal, „Teilweise“ entfernt nur, was du überfährst – wie ein echter Radierer.'),
        li('Stift halten', 'am Ende eines Strichs kurz stillhalten → wird zur geraden Linie, zum Kreis, Rechteck oder Dreieck. Bei Linien kannst du danach den Endpunkt noch verschieben.'),
        li('Formen-Schalter', 'jede gezeichnete Form wird automatisch begradigt.'),
        li('Lasso', 'Inhalt umkreisen → verschieben, löschen, duplizieren, umfärben oder kopieren.'),
        li('Text', 'auf die Seite tippen und schreiben (mit dem Pencil geht auch Kritzeln/Scribble).'),
        li('Seitenmenü', '⋯ oben rechts an jeder Seite: Vorlage, Papier, duplizieren, verschieben, löschen.'),
        li('Am PC', 'Maus zeichnet, Strg + Mausrad zoomt, Strg + Z / Strg + Y.')),
    });
  }

  // ---------- Ereignisse ----------
  pagesEl.addEventListener('pointerdown', onDown);
  pagesEl.addEventListener('pointermove', onMove);
  pagesEl.addEventListener('pointerup', onUp);
  pagesEl.addEventListener('pointercancel', onUp);

  // Touch-Gesten steuert die App selbst (Safari würde sonst nebenbei mitscrollen und der Zoom verrutscht):
  // 1 Finger = scrollen mit Schwung, 2 Finger = zoomen + verschieben – der Inhaltspunkt zwischen den Fingern
  // bleibt dabei genau zwischen den Fingern. Der Pencil zeichnet; mit „Finger zeichnet“ zeichnet auch 1 Finger.
  const UI_SEL = 'button, input, textarea, select, label, .selmenu';
  let gest = null, inertia = 0;
  function stopInertia() { if (inertia) cancelAnimationFrame(inertia); inertia = 0; }
  // Schwung nach dem Loslassen. Zeiten sind die der Touch-Ereignisse selbst: Hängt die App kurz, kommen die
  // Bewegungen danach gebündelt an – mit der Verarbeitungszeit sähe das wie ein extrem schneller Wisch aus,
  // und die Notiz flog seitenweise davon. Zusätzlich begrenzt auf 4 px/ms (schneller wischt kaum jemand).
  const MAX_FLING = 4;
  function startInertia(samples, end) {
    const recent = samples.filter(s => end - s.t < 100);
    if (recent.length < 2 || end - recent[recent.length - 1].t > 50) return; // Finger lag zuletzt still: kein Schwung
    if (recent.length >= 3 && end - recent[0].t < 8) return; // alles im selben Augenblick angekommen: Tempo unbekannt
    const dt = Math.max(40, end - recent[0].t);
    let vx = recent.reduce((a, s) => a + s.dx, 0) / dt, vy = recent.reduce((a, s) => a + s.dy, 0) / dt;
    const v = Math.hypot(vx, vy);
    if (v < 0.15) return; // px pro ms
    if (v > MAX_FLING) { vx *= MAX_FLING / v; vy *= MAX_FLING / v; }
    let last = performance.now();
    const step = t => {
      const d = Math.min(50, t - last);
      last = t;
      scroller.scrollLeft -= vx * d;
      scroller.scrollTop -= vy * d;
      const k = Math.pow(0.996, d);
      vx *= k;
      vy *= k;
      inertia = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    inertia = requestAnimationFrame(step);
  }
  // Doppeltipp mit einem Finger: zwischen Radierer und dem zuletzt benutzten Stift/Marker wechseln.
  // Ersatz für den Doppeltipp auf den Pencil selbst – den meldet Safari an Web-Apps nicht.
  let tap = null, lastTap = null;
  function detectTap(e) {
    if (S.fingerDraw) { tap = lastTap = null; return; } // dann zeichnet ein Finger
    const t = e.changedTouches[0], now = performance.now();
    if (e.type === 'touchstart') {
      tap = e.touches.length === 1 ? { id: t.identifier, x: t.clientX, y: t.clientY, t: now } : null;
      if (e.touches.length > 1) lastTap = null;
    } else if (e.type === 'touchmove') {
      if (tap && [...e.touches].some(x => x.identifier === tap.id && Math.hypot(x.clientX - tap.x, x.clientY - tap.y) > 10)) tap = null;
    } else {
      const isTap = e.type === 'touchend' && tap && e.touches.length === 0 && t.identifier === tap.id && now - tap.t < 300;
      if (isTap && lastTap && now - lastTap.t < 400 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 50) {
        lastTap = null;
        toggleEraser();
      } else lastTap = isTap ? { t: now, x: t.clientX, y: t.clientY } : null;
      tap = null;
    }
  }
  function toggleEraser() {
    setTool(S.tool === 'eraser' ? lastDrawTool : 'eraser');
    toast(S.tool === 'eraser' ? 'Radierer' : TOOLS.find(([k]) => k === S.tool)[1]);
  }

  // Zwei-Finger-Zoom: Während der Geste wird nur per CSS-Transform skaliert und verschoben – das erledigt
  // die Grafikkarte, ohne Layout und ohne neu zu zeichnen. Erst beim Loslassen (oder nach einem großen
  // Zoomsprung) werden Layout und Kacheln in der neuen Größe berechnet. Der Inhaltspunkt zwischen den
  // Fingern bleibt dabei genau zwischen den Fingern.
  function pinchStart(ids, cx, cy, d) {
    const o = pagesEl.getBoundingClientRect(), s = scroller.getBoundingClientRect(), cs = getComputedStyle(pagesEl);
    gest = { mode: 'pinch', ids, d0: Math.max(d, 1), z0: E.zoom, z: E.zoom, anchor: anchorAt(cx, cy), ax: cx, ay: cy, cx, cy,
      ox: o.left, oy: o.top, ow: o.width, oh: o.height, sl: s.left, st: s.top, sw: scroller.clientWidth, sh: scroller.clientHeight,
      // Innenabstand um die Seiten: wächst beim Zoomen nicht mit (anders als in der CSS-Skalierung während der Geste)
      pl: parseFloat(cs.paddingLeft), pr: parseFloat(cs.paddingRight), pt: parseFloat(cs.paddingTop), pb: parseFloat(cs.paddingBottom) };
    pagesEl.classList.add('pinching');
  }
  function pinchMove(cx, cy, d) {
    const g = gest;
    g.z = clampZoom((g.z0 * d) / g.d0);
    g.cx = cx;
    g.cy = cy;
    const k = g.z / E.zoom;
    if (k > 1.8 || k < 0.55) { // weit gezoomt: zwischendurch scharf aufbauen, dann weiter
      pinchEnd();
      pinchStart(g.ids, cx, cy, d);
      return;
    }
    E.k = k;
    // Wie beim Scrollen nicht über Anfang/Ende der Notiz hinaus – sonst zeigt die Geste Leerraum und die Ansicht
    // springt beim Loslassen an den Rand zurück (bei kleinem Zoom um mehrere Seiten). Schmaler als der
    // Bildschirm: mittig, wie es das Layout danach auch tut.
    // Gerechnet wird mit dem Seitenbereich ohne Innenabstand (x/y: dessen linke/obere Kante auf dem Bildschirm)
    const iw = k * (g.ow - g.pl - g.pr), ih = k * (g.oh - g.pt - g.pb);
    let x = cx - k * (g.ax - g.ox - g.pl), y = cy - k * (g.ay - g.oy - g.pt);
    x = iw + g.pl + g.pr <= g.sw ? g.sl + (g.sw - iw - g.pl - g.pr) / 2 + g.pl : Math.min(g.sl + g.pl, Math.max(g.sl + g.sw - g.pr - iw, x));
    y = ih + g.pt + g.pb <= g.sh ? g.st + g.pt : Math.min(g.st + g.pt, Math.max(g.st + g.sh - g.pb - ih, y));
    pagesEl.style.transform = `translate(${x - k * g.pl - g.ox}px, ${y - k * g.pt - g.oy}px) scale(${k})`;
    zoomLabel.textContent = Math.round(E.fit * g.z * 100) + '%';
    updateVisible(); // beim Herauszoomen frei werdende Ränder schon zeichnen
  }
  function pinchEnd() {
    const g = gest;
    pagesEl.style.transform = '';
    pagesEl.classList.remove('pinching');
    E.k = 1;
    zoomAnchored(g.z, g.anchor, g.cx, g.cy);
  }

  function onTouch(e) {
    if ([...e.changedTouches].some(t => t.touchType === 'stylus')) {
      if (!e.target.closest(UI_SEL)) e.preventDefault(); // Pencil scrollt nie
      return;
    }
    if (!gest && e.target.closest(UI_SEL) && e.touches.length < 2) return; // Tippen auf Knöpfe/Textfelder normal durchlassen
    detectTap(e);
    if (e.cancelable) e.preventDefault();
    if (e.type === 'touchstart') { stopInertia(); userActive(); }
    const f = [...e.touches].filter(t => t.touchType !== 'stylus');
    if (f.length < 2 && gest?.mode === 'pinch') pinchEnd();
    if (f.length >= 2) {
      const [a, b] = f, cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), ids = a.identifier + ':' + b.identifier;
      if (!gest || gest.mode !== 'pinch' || gest.ids !== ids) {
        if (gest?.mode === 'pinch') pinchEnd();
        pinchStart(ids, cx, cy, d);
        return;
      }
      pinchMove(cx, cy, d);
    } else if (f.length === 1 && !S.fingerDraw) {
      const t = f[0];
      if (!gest || gest.mode !== 'pan' || gest.id !== t.identifier) {
        // Rest einer Zoom-Geste (ein Finger schon oben): verschiebt noch, gibt beim Loslassen aber keinen Schwung
        gest = { mode: 'pan', id: t.identifier, x: t.clientX, y: t.clientY, x0: t.clientX, y0: t.clientY, lock: null, samples: [], afterPinch: gest?.mode === 'pinch' };
        return;
      }
      let dx = t.clientX - gest.x, dy = t.clientY - gest.y;
      gest.x = t.clientX;
      gest.y = t.clientY;
      // Richtung sperren wie in iPad-Apps: Wer (fast) senkrecht wischt, scrollt nur senkrecht – sonst rutscht die
      // Ansicht bei jedem leicht schrägen Wisch seitlich hin und her (z. B. schmale Seite zwischen breiten)
      if (!gest.lock) {
        const tx = Math.abs(gest.x - gest.x0), ty = Math.abs(gest.y - gest.y0);
        if (tx + ty > 10) gest.lock = ty > 1.5 * tx ? 'y' : tx > 1.5 * ty ? 'x' : 'xy';
      }
      if (gest.lock === 'y') dx = 0;
      else if (gest.lock === 'x') dy = 0;
      scroller.scrollLeft -= dx;
      scroller.scrollTop -= dy;
      gest.samples.push({ t: e.timeStamp, dx, dy });
      if (gest.samples.length > 12) gest.samples.shift();
    } else {
      if (gest?.mode === 'pan' && !gest.afterPinch && e.type === 'touchend') startInertia(gest.samples, e.timeStamp);
      gest = null;
    }
  }
  for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) scroller.addEventListener(t, onTouch, { passive: false });

  scroller.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(E.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
  }, { passive: false });
  // Seitenzahl höchstens einmal je Frame (sie liest die Lage aller Seiten); Ersatz-Zeitgeber, falls gerade keine
  // Frames kommen – sonst bliebe die Zahl stehen
  let labelQ = null;
  function labelLater() {
    if (labelQ) return;
    const go = () => { if (!labelQ) return; cancelAnimationFrame(labelQ.r); clearTimeout(labelQ.t); labelQ = null; updatePageLabel(); };
    labelQ = { r: requestAnimationFrame(go), t: setTimeout(go, 150) };
  }
  scroller.addEventListener('scroll', () => { updateVisible(); labelLater(); nav?.update(); }, { passive: true });

  function onKey(e) {
    if (e.target.matches?.('input, textarea')) return;
    if (keyOwner && keyOwner !== editor && keyOwner.isConnected) return; // anderer Editor (Notiz/Kartenfenster) ist dran
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && E.sel) { e.preventDefault(); deleteSel(); }
  }
  // Zoom und Position je Notizbuch merken, damit man wieder dort landet, wo man aufgehört hat
  const VIEW_KEY = 'notizen.view.' + nb.id;
  function saveView() {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ zoom: E.zoom, x: scroller.scrollLeft / E.scale, y: scroller.scrollTop / E.scale })); } catch { /* egal */ }
  }
  // App verlassen: laufenden Strich abschließen, Gesten zurücksetzen, speichern
  const onVis = () => {
    if (document.visibilityState !== 'hidden') return;
    if (E.act) { if (E.act.touch) cancelAct(); else finishLost(); }
    if (gest?.mode === 'pinch') pinchEnd();
    gest = null;
    stopInertia();
    flush();
    saveView();
  };
  // „Stift abgehoben“ auch dann mitbekommen, wenn es außerhalb der Seiten ankommt (z. B. über der Werkzeugleiste)
  const onUpAnywhere = e => { if (E.act && e.pointerId === E.act.pid) onUp(e); };

  // Änderungen von einem anderen Gerät (Sync) an dieser Notiz sofort übernehmen – sonst würde das
  // nächste Speichern hier die ältere Fassung zurückschreiben.
  async function onRemote(e) {
    const { kind, id, remote } = e.detail;
    if (!remote || E.dead) return;
    if (kind === 'notebooks' && id === nb.id) {
      const fresh = await store.get('notebooks', id);
      if (!fresh) { if (embed) embed.onClose(); else location.hash = ''; return; }
      if (fresh.pageIds.join() !== E.pages.map(p => p.id).join()) {
        if (E.act) { setTimeout(() => onRemote(e), 500); return; } // erst den laufenden Strich fertig werden lassen
        await flush();
        if (embed) embed.onClose();
        else dispatchEvent(new HashChangeEvent('hashchange')); // Seiten hinzugekommen/weg: Notiz neu öffnen
        return;
      }
      nb.title = fresh.title;
      titleEl.textContent = fresh.title;
    } else if (kind === 'pages' && E.pvs.has(id)) {
      const pv = E.pvs.get(id);
      if (E.dirty.has(pv.page) || E.act) return; // eigene, noch nicht gespeicherte Änderung ist jünger
      const fresh = await store.get('pages', id);
      if (!fresh) return;
      const resized = fresh.w !== pv.page.w || fresh.h !== pv.page.h;
      Object.assign(pv.page, fresh);
      E.undo = E.undo.filter(u => u.id !== id);
      E.redo = E.redo.filter(u => u.id !== id);
      updUndo();
      if (E.sel?.pv === pv) clearSelection();
      if (resized) { unrender(pv); buildTiles(pv); layoutAll(); } // Kacheln kommen über die Warteschlange
      else { syncAssets(pv); redraw(pv); } // geänderte Bilder werden dabei neu geladen
      pv.prevFresh = false;
      previewLater();
      renderTexts(pv);
    }
  }
  changes.addEventListener('change', onRemote);
  toolEvents.addEventListener('change', onToolChange);
  addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVis);
  addEventListener('pointerup', onUpAnywhere, true);
  addEventListener('pointercancel', onUpAnywhere, true);

  // ---------- Start ----------
  let view = null;
  if (!embed) try { view = JSON.parse(localStorage.getItem(VIEW_KEY)); } catch { /* egal */ }
  if (view?.zoom > 0) E.zoom = view.zoom;
  computeScale();
  if (embed) { // Kartenfenster: eine Kartenseite passt ganz hinein
    E.zoom = Math.min(1, Math.max(0.3, (scroller.clientHeight - 40) / ((E.pages[0]?.h || 625) * E.fit)));
    computeScale();
  }
  E.builtUnit = E.tileUnit;
  for (const p of E.pages) pagesEl.append(makePV(p).el);
  renderTools();
  updUndo();
  sizeOverlay();
  layoutAll();
  for (const pv of E.pvs.values()) renderTexts(pv);
  if (view) { scroller.scrollLeft = view.x * E.scale; scroller.scrollTop = view.y * E.scale; }
  updateVisible();
  if (!card && !embed) {
    nav = createPageNav({ body: mainRow, stage, scroller, pages: () => E.pages, current: currentIndex, jump: jumpTo, busy: () => !!(gest || inertia || E.act),
      // Scroll-Griff: Finger wischen dort wie überall, der Pencil schreibt auf der Seite darunter
      touch: onTouch, pen: onDown, grabbed: () => { if (gest?.mode === 'pan') gest = null; stopInertia(); } });
    nav.setOpen(!!S.thumbs);
  }
  renumber();
  ro.observe(stage);
  if (embed?.side === 'front' && E.pages[1]) { // Frage steht schon vorne: gleich die Rückseite zeigen
    const pr = E.pvs.get(E.pages[1].id).el.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
    scroller.scrollTop += pr.top - sr.top - 12;
    updateVisible();
  }
  if (card && !embed) { // frisch aus einem Ausschnitt angelegt: kurz sagen, was jetzt zu tun ist
    let side = null;
    try { side = sessionStorage.getItem('notizen.hint:' + nb.id); sessionStorage.removeItem('notizen.hint:' + nb.id); } catch { /* egal */ }
    if (side) toast(side === 'back' ? 'Schreib jetzt die Frage auf die Vorderseite – „Zurück“ bringt dich zum Skript.' : 'Schreib jetzt die Antwort auf die Rückseite – „Zurück“ bringt dich zum Skript.');
  }

  const destroy = async () => {
    await closeCardPanel();
    if (!embed) saveView();
    for (const ta of editor.querySelectorAll('.text-edit')) ta.blur();
    await flush();
    if (card) await updateThumb(nb).catch(() => {}); // Vorschaubild der Karte auffrischen
    E.dead = true;
    cancelAnimationFrame(pumpRaf);
    clearTimeout(pumpTo);
    clearTimeout(prevT);
    queue.clear();
    stopInertia();
    nav?.destroy();
    ro.disconnect();
    removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    removeEventListener('pointerup', onUpAnywhere, true);
    removeEventListener('pointercancel', onUpAnywhere, true);
    changes.removeEventListener('change', onRemote);
    toolEvents.removeEventListener('change', onToolChange);
    for (const pv of E.pvs.values()) unrender(pv);
  };
  destroy.addImage = addImage;
  return destroy;
}

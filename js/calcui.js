// Rechnen mit Handschrift: Fenster „Berechnen“ (erkannte Zeichen prüfen, korrigieren, Ergebnis einfügen) und
// „Schrift beibringen“ (jedes Zeichen ein paarmal vorschreiben). Die Erkennung selbst steht in calc.js.
// Gelernte Zeichen liegen nur auf dem Gerät (meta-Speicher, wird nicht abgeglichen).
import { store } from './store.js';
import { h, modal, toast, confirmDialog } from './ui.js';
import { recognize, exprOf, evaluate, fmt, flatCloud, LEARNABLE } from './calc.js';

const KEY = 'calc.templates';
const PER_CHAR = 20; // so viele eigene Vorlagen je Zeichen (die ältesten fallen weg)
const SYMS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', ',', '+', '-', '·', ':', '/', '(', ')', '^', '='];
const show = c => ({ '-': '−', '·': '×', '^': 'xʸ' }[c] || c);
const TRAIN = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '·', '(', ')', '/'];

const templates = async () => (await store.getMeta(KEY).catch(() => null)) || [];
async function learn(samples) {
  if (!samples.length) return;
  const list = [...(await templates()), ...samples.map(s => ({ c: s.c, p: flatCloud(s.strokes) }))];
  const count = {}, keep = [];
  for (let i = list.length - 1; i >= 0; i--) if ((count[list[i].c] = (count[list[i].c] || 0) + 1) <= PER_CHAR) keep.unshift(list[i]);
  await store.setMeta(KEY, keep);
}

// kleines Bild der Striche eines Zeichens (damit man sieht, welches gemeint ist)
function thumb(strokes) {
  const c = h('canvas', { class: 'calc-thumb' }), d = 2, W = 26, H = 26;
  c.width = W * d; c.height = H * d;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const [x, y] of s) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const k = Math.min((W - 6) / Math.max(x1 - x0, 1), (H - 6) / Math.max(y1 - y0, 1), 3);
  const ox = (W - (x1 - x0) * k) / 2, oy = (H - (y1 - y0) * k) / 2;
  const ctx = c.getContext('2d');
  ctx.scale(d, d);
  ctx.lineWidth = 1.6;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text') || '#1c1c1e';
  for (const s of strokes) {
    ctx.beginPath();
    s.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](ox + (x - x0) * k, oy + (y - y0) * k));
    if (s.length === 1) ctx.lineTo(ox + (s[0][0] - x0) * k + 0.5, oy + (s[0][1] - y0) * k);
    ctx.stroke();
  }
  return c;
}

// strokes: ausgewählte Striche der Seite. Ergebnis: Texte zum Einfügen [{ text, x, y, w, size, color }] oder null
export async function calcDialog(strokes, { pageW = 794 } = {}) {
  strokes = strokes.filter(s => s.tool !== 'hl');
  for (;;) {
    const lines = recognize(strokes, await templates()).filter(l => l.syms.length);
    if (!lines.length) { toast('In der Auswahl ist keine Handschrift.'); return null; }
    const res = await calcWindow(lines);
    if (res === 'train') { await trainDialog(); continue; } // danach mit der neu gelernten Schrift nochmal erkennen
    if (!res) return null;
    await learn(res.learn).catch(err => console.warn('Lernen', err));
    const color = strokes[0]?.color || '#1c1c1e';
    return res.lines.map(({ line, text }) => {
      const size = Math.max(10, Math.min(120, line.lh * 1.35)); // Ziffern so hoch wie die eigenen
      const x = line.box.x1 + 0.35 * line.lh;
      return { text, x, y: line.top - 0.36 * size, w: Math.max(60, Math.min(pageW - x - 8, size * (0.62 * text.length + 1))), size, color };
    });
  }
}

function calcWindow(lines) {
  const learnFrom = [];
  const rows = lines.map(line => {
    const syms = line.syms.map(y => ({ ...y, c0: y.c, off: false }));
    const chips = h('div', { class: 'calc-chips' });
    const pal = h('div', { class: 'calc-pal' });
    const input = h('input', { class: 'input calc-expr', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, 'aria-label': 'Rechnung' });
    const out = h('div', { class: 'calc-res' });
    const row = { line, syms, input, value: null, manual: false };
    let open = -1; // Zeichen, dessen Auswahl gerade offen ist
    const recalc = () => {
      const r = evaluate(input.value);
      row.value = r.value ?? null;
      out.textContent = r.value != null ? '= ' + fmt(r.value) : r.empty ? 'Keine Rechnung erkannt' : r.error;
      out.classList.toggle('bad', r.value == null);
    };
    const fromChips = () => { input.value = exprOf(syms.filter(y => !y.off)).replace(/·/g, '×').replace(/-/g, '−'); row.manual = false; recalc(); };
    const drawChips = () => {
      chips.replaceChildren(...syms.map((y, i) => h('button', {
        type: 'button', class: 'calc-chip' + (y.off ? ' off' : '') + (y.c !== y.c0 ? ' fixed' : '') + (i === open ? ' on' : '') + (y.sup ? ' sup' : ''),
        title: 'Antippen zum Korrigieren', onclick: () => { open = open === i ? -1 : i; drawChips(); drawPal(); },
      }, h('b', {}, y.off ? '–' : show(y.c)), thumb(y.strokes))));
    };
    const drawPal = () => {
      if (open < 0) { pal.replaceChildren(); pal.hidden = true; return; }
      const y = syms[open];
      const pick = c => { y.off = c == null; if (c != null) y.c = c; open = -1; drawChips(); drawPal(); fromChips(); };
      const first = y.choices.filter(c => c !== y.c);
      pal.hidden = false;
      pal.replaceChildren(
        first.length ? h('div', { class: 'calc-pal-hint muted small' }, 'Vielleicht:') : null,
        ...first.map(c => h('button', { type: 'button', class: 'calc-key alt', onclick: () => pick(c) }, show(c))),
        first.length ? h('div', { class: 'calc-pal-break' }) : null,
        ...SYMS.map(c => h('button', { type: 'button', class: 'calc-key' + (c === y.c && !y.off ? ' on' : ''), onclick: () => pick(c) }, show(c))),
        h('button', { type: 'button', class: 'calc-key wide', onclick: () => pick(null) }, 'weglassen'));
    };
    input.addEventListener('input', () => { row.manual = true; recalc(); });
    drawChips();
    drawPal();
    fromChips();
    row.el = h('div', { class: 'calc-line' }, chips, pal, h('div', { class: 'calc-row' }, input, out));
    return row;
  });
  return modal({
    title: 'Berechnen',
    body: h('div', { class: 'calc' },
      ...rows.map(r => r.el),
      h('p', { class: 'muted small' }, 'Falsch erkannt? Zeichen antippen und richtiges wählen – die App merkt sich deine Schrift. Oder die Rechnung im Feld direkt ändern.')),
    actions: [
      { label: 'Schrift beibringen …', value: 'train' },
      { label: 'Abbrechen', value: null },
      { label: 'Ergebnis einfügen', primary: true, value: () => {
        // aus Korrekturen lernen (nicht aus Punkten/Kommas – die erkennt die App an Größe und Lage)
        for (const r of rows) for (const y of r.syms) if (!y.off && !y.tiny && y.c !== y.c0 && LEARNABLE.includes(y.c)) learnFrom.push({ c: y.c, strokes: y.strokes });
        const done = rows.filter(r => r.value != null).map(r => {
          // steht auf der Seite schon ein „=“ am Ende, kommt nur die Zahl dahinter
          const ends = r.syms.filter(y => !y.off).at(-1)?.c === '=';
          return { line: r.line, text: (ends ? '' : '= ') + fmt(r.value) };
        });
        if (!done.length) { toast('Da ist noch kein Ergebnis – erst die Rechnung korrigieren.'); return null; }
        return { lines: done, learn: learnFrom };
      } },
    ],
  });
}

// ---------- Schrift beibringen ----------
export async function trainDialog() {
  const seq = [...TRAIN, ...TRAIN]; // jedes Zeichen zweimal
  const got = []; // [{ c, strokes }] in Reihenfolge von seq (null = übersprungen)
  let k = 0, strokes = [], cur = null, timer = 0;
  const prompt = h('div', { class: 'train-prompt' });
  const prog = h('div', { class: 'muted small' });
  const pad = h('canvas', { class: 'train-pad' });
  const backBtn = h('button', { class: 'btn sm', type: 'button', onclick: back }, 'Zurück');
  const skipBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => next(null) }, 'Überspringen');
  const clearBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => { strokes = []; draw(); } }, 'Löschen');

  function size() {
    const d = window.devicePixelRatio || 1, r = pad.getBoundingClientRect();
    pad.width = Math.round(r.width * d); pad.height = Math.round(r.height * d);
    draw();
  }
  function draw() {
    const ctx = pad.getContext('2d'), d = window.devicePixelRatio || 1, W = pad.width / d, H = pad.height / d;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(127,127,127,.35)';
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(10, H * 0.2); ctx.lineTo(W - 10, H * 0.2); ctx.moveTo(10, H * 0.8); ctx.lineTo(W - 10, H * 0.8); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text') || '#1c1c1e';
    ctx.lineWidth = 3; ctx.lineCap = ctx.lineJoin = 'round';
    for (const s of strokes) { ctx.beginPath(); s.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x, y)); if (s.length === 1) ctx.lineTo(s[0][0] + 0.5, s[0][1]); ctx.stroke(); }
  }
  function update() {
    const done = k >= seq.length;
    prompt.replaceChildren(done ? 'Fertig – danke!' : h('span', {}, 'Schreib: ', h('b', {}, show(seq[k]))));
    prog.textContent = done ? `${got.filter(Boolean).length} Zeichen gelernt. Tipp auf „Speichern“.` : `${k + 1} von ${seq.length} · nach einer kurzen Pause geht es von selbst weiter`;
    backBtn.disabled = k === 0;
    skipBtn.disabled = clearBtn.disabled = done;
    strokes = [];
    draw();
  }
  function next(sample) { clearTimeout(timer); if (k >= seq.length) return; got[k] = sample; k++; update(); }
  function back() { clearTimeout(timer); if (k > 0) { k--; got.length = k; update(); } }
  const pos = e => { const r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  pad.addEventListener('pointerdown', e => {
    if (k >= seq.length) return;
    e.preventDefault();
    clearTimeout(timer);
    try { pad.setPointerCapture(e.pointerId); } catch { /* egal */ }
    cur = { id: e.pointerId, pts: [pos(e)] };
    strokes.push(cur.pts);
    draw();
  });
  pad.addEventListener('pointermove', e => {
    if (cur?.id !== e.pointerId) return;
    for (const ev of (e.getCoalescedEvents?.() || [e])) cur.pts.push(pos(ev));
    draw();
  });
  const up = e => {
    if (cur?.id !== e.pointerId) return;
    cur = null;
    clearTimeout(timer);
    timer = setTimeout(() => { if (strokes.length) next({ c: seq[k], strokes }); }, 900); // Pause: Zeichen fertig
  };
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);

  const body = h('div', { class: 'train' },
    h('p', { class: 'muted small' }, 'Schreib jedes Zeichen so, wie du es in Rechnungen schreibst – mit dem Pencil, etwa so groß wie zwischen den Linien. Jedes kommt zweimal.'),
    prompt, pad, h('div', { class: 'row train-btns' }, backBtn, clearBtn, skipBtn), prog);
  const ro = new ResizeObserver(size);
  const res = modal({
    title: 'Schrift beibringen',
    body,
    actions: [{ label: 'Gelerntes löschen', value: 'reset' }, { label: 'Abbrechen', value: null }, { label: 'Speichern', value: true, primary: true }],
    onOpen: () => { ro.observe(pad); update(); },
  });
  const v = await res;
  ro.disconnect();
  clearTimeout(timer);
  if (v === 'reset') {
    if (await confirmDialog('Gelerntes löschen?', 'Die App vergisst alles, was sie über deine Schrift gelernt hat, und erkennt wieder nur mit den eingebauten Formen.', 'Löschen', true)) {
      await store.setMeta(KEY, []);
      toast('Gelernte Schrift gelöscht');
    }
    return;
  }
  if (!v) return;
  const samples = got.filter(Boolean);
  await learn(samples);
  if (samples.length) toast(`${samples.length} Zeichen gelernt`);
}

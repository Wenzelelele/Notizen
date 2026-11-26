// Oberfläche der Volltextsuche (find.js): Treffer in der Bibliothek, Suchleiste in der offenen Notiz,
// Stichwortverzeichnis und der Offline-Check vor einer Klausur.
import { h, icon, modal, toast } from './ui.js';
import { store } from './store.js';
import { buildIndex, search, snippet, hitRects, docsFor, matchDoc, parseQuery, keywords } from './find.js';
import { pdfText, hasBg, bgBlob, loadPdfjs, PDF_LIBS } from './pdfio.js';

export const FIND_KEY = 'notizen.find';       // Notiz öffnen und gleich zum Treffer springen (Editor liest es)
export const LIBQ_KEY = 'notizen.libsearch';  // Suche in der Bibliothek beim Zurückkommen wiederherstellen
const ss = {
  get(k) { try { const v = sessionStorage.getItem(k); sessionStorage.removeItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* egal */ } },
};
export const takeFind = () => ss.get(FIND_KEY);
export const takeLibSearch = () => ss.get(LIBQ_KEY);

const snipEl = parts => h('span', { class: 'fr-snip' }, parts.map(p => (p.m ? h('mark', {}, p.t) : p.t)));
const pagesWord = n => (n === 1 ? '1 Seite' : n + ' Seiten');

// ---------- Treffer in der Bibliothek ----------
// Baut den Index (beim ersten Mal mit Hinweis), sucht und zeigt die Treffer in host.
// open(nb, pageId): Notiz an dieser Seite öffnen. Gibt eine Funktion zum Abbrechen zurück.
export function contentResults(host, { nbs, query, open, onKeywords, onDone }) {
  let dead = false;
  const status = h('p', { class: 'muted small fr-status' }, 'Suche im Skripttext …');
  host.replaceChildren(status);
  (async () => {
    const index = await buildIndex(nbs, t => { if (!dead) status.textContent = t; });
    if (dead) return;
    const res = search(index, query);
    if (dead) return;
    const searchable = index.notes.filter(n => n.pages.length).length;
    const kw = onKeywords ? h('button', { class: 'linkbtn', type: 'button', onclick: onKeywords }, 'Stichwortverzeichnis') : null;
    if (!res.groups.length) {
      host.replaceChildren(h('section', { class: 'fr' },
        h('h3', { class: 'sec-title' }, 'Im Skripttext'),
        h('p', { class: 'muted' }, searchable
          ? `„${query.trim()}“ kommt in keinem Skript vor. Andere Schreibweise oder ein Wortteil (z. B. „gieß“ statt „Gießverfahren“) findet oft mehr.`
          : 'In diesem Ordner gibt es keinen durchsuchbaren Text. Durchsuchbar sind PDF-Folien und getippter Text – Handschrift und Bilder nicht.'),
        kw));
      onDone?.();
      return;
    }
    const fuzzy = res.terms.filter(t => t.how === 'fuzzy');
    host.replaceChildren(h('section', { class: 'fr' },
      h('div', { class: 'fr-top' },
        h('h3', { class: 'sec-title' }, `Im Skripttext · ${pagesWord(res.total)} in ${res.groups.length === 1 ? '1 Skript' : res.groups.length + ' Skripten'}`),
        kw),
      res.partial ? h('p', { class: 'muted small' }, 'Keine Seite enthält alle Wörter – hier Seiten mit einzelnen davon.') : null,
      fuzzy.length ? h('p', { class: 'muted small' }, fuzzy.map(t => `Kein genauer Treffer für „${t.w}“ – ähnlich: ${t.alts.join(', ')}`).join(' · ')) : null,
      res.groups.map(g => group(g, query, open))));
    onDone?.();
  })().catch(err => {
    console.error(err);
    if (!dead) host.replaceChildren(h('p', { class: 'muted small' }, 'Suche im Text fehlgeschlagen: ' + err.message));
  });
  return () => { dead = true; };
}
function group(g, query, open) {
  const SHOW = 6;
  const list = h('div', { class: 'fr-list' });
  // die besten Seiten zuerst auswählen, angezeigt in Seitenreihenfolge
  const best = new Set([...g.pages].sort((a, b) => b.score - a.score).slice(0, SHOW));
  const draw = all => list.replaceChildren(...g.pages.filter(p => all || best.has(p)).map(p => hitRow(g.nb, p, open)),
    ...(!all && g.pages.length > SHOW ? [h('button', { class: 'linkbtn fr-more', type: 'button', onclick: () => draw(true) }, `Alle ${g.pages.length} Seiten zeigen`)] : []));
  draw(false);
  return h('div', { class: 'fr-group' },
    h('div', { class: 'fr-head' }, icon('file'), h('b', { class: 'grow' }, g.nb.title), h('span', { class: 'muted small' }, pagesWord(g.pages.length))),
    list);
}
function hitRow(nb, p, open) {
  return h('button', { class: 'fr-hit', type: 'button', onclick: () => open(nb, p.id) },
    h('span', { class: 'fr-page' }, 'S. ' + (p.i + 1)),
    h('span', { class: 'fr-body' },
      p.doc.title ? h('b', { class: 'fr-title' }, p.doc.title) : null,
      snipEl(snippet(p.doc, p.hits))));
}

// ---------- Stichwortverzeichnis ----------
// Fachbegriffe aller Skripte, alphabetisch; antippen sucht danach. Ergebnis: der gewählte Begriff oder null.
export async function keywordDialog(nbs, title) {
  const status = h('p', { class: 'muted small' }, 'Skripte werden gelesen …');
  const body = h('div', { class: 'kw' }, status);
  let index = null, list = [];
  const filter = h('input', { class: 'input', type: 'search', placeholder: 'Begriffe filtern', autocomplete: 'off', oninput: () => draw() });
  const listEl = h('div', { class: 'kw-list' });
  let pick = null;
  function draw() {
    const f = filter.value.trim().toLocaleLowerCase('de');
    const shown = f ? list.filter(t => t.term.toLocaleLowerCase('de').includes(f)) : list;
    const groups = new Map();
    for (const t of shown) {
      const L = t.term[0].toLocaleUpperCase('de').normalize('NFD')[0];
      const k = /[A-Z]/.test(L) ? L : '#';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    listEl.replaceChildren(...(shown.length ? [...groups].map(([L, ts]) => h('div', { class: 'kw-group' },
      h('div', { class: 'kw-letter' }, L),
      h('div', { class: 'kw-terms' }, ts.map(t => h('button', { class: 'kw-term' + (t.heads ? ' head' : ''), type: 'button', title: pagesWord(t.pages), onclick: () => pick(t.term) },
        t.term, h('span', { class: 'kw-n' }, t.pages)))))) : [h('p', { class: 'muted' }, 'Kein Begriff passt.')]));
  }
  const p = modal({
    title: 'Stichwortverzeichnis' + (title ? ' – ' + title : ''),
    body: close => { pick = close; return body; },
    actions: [{ label: 'Schließen', value: null }],
  });
  [...document.querySelectorAll('.modal')].at(-1)?.classList.add('wide');
  try {
    index = await buildIndex(nbs, t => { status.textContent = t; });
    list = keywords(index);
    body.replaceChildren(
      h('p', { class: 'muted small' }, list.length
        ? `${list.length} Begriffe aus ${index.notes.filter(n => n.pages.length).length} Skripten. Fett: steht in einer Folienüberschrift. Zahl: auf so vielen Seiten. Antippen sucht danach.`
        : 'Keine Begriffe gefunden – in diesem Ordner gibt es keinen durchsuchbaren Text (PDF-Folien, getippter Text).'),
      filter, listEl);
    draw();
  } catch (err) {
    console.error(err);
    status.textContent = 'Konnte die Skripte nicht lesen: ' + err.message;
  }
  return p;
}

// ---------- Offline-Check ----------
// Liegt alles, was für die Klausur gebraucht wird, auf dem Gerät? Fehlende Folienbilder werden gezeichnet,
// der Suchtext gelesen – danach geht Suchen und Blättern auch im Flugmodus sofort.
export async function offlineCheck(nbs, title) {
  const status = h('p', { class: 'muted small' }, 'Wird geprüft …');
  const bar = h('i');
  const rows = h('div', { class: 'oc-list' });
  const head = h('div', { class: 'oc-head' });
  const body = h('div', { class: 'oc' }, head, status, h('div', { class: 'bar' }, bar), rows);
  const p = modal({ title: 'Offline-Check' + (title ? ' – ' + title : ''), body, actions: [{ label: 'Fertig', value: true, primary: true }] });
  const row = (ok, name, text) => rows.append(h('div', { class: 'oc-row' + (ok ? ' ok' : ' warn') },
    h('span', { class: 'oc-ico' }, ok ? '✓' : '!'), h('div', { class: 'grow' }, h('b', {}, name), h('div', { class: 'muted small' }, text))));
  let problems = 0;
  try {
    // 1) die App selbst
    const installed = location.protocol === 'https:' && 'serviceWorker' in navigator;
    if (!installed) { row(false, 'App', 'Offline-Speicher gibt es nur in der veröffentlichten App (https) – hier wird nur der Inhalt geprüft.'); problems++; }
    else {
      const ctrl = !!navigator.serviceWorker.controller;
      let libs = (await Promise.all(PDF_LIBS.map(u => caches.match(u)))).every(Boolean);
      if (!libs && navigator.onLine) { await loadPdfjs().catch(() => {}); libs = (await Promise.all(PDF_LIBS.map(u => caches.match(u)))).every(Boolean); }
      const ok = ctrl && libs;
      if (!ok) problems++;
      row(ok, 'App', ok ? 'App und PDF-Programm sind offline gespeichert.'
        : !ctrl ? 'Die App ist noch nicht offline gespeichert – einmal mit Internet schließen und neu öffnen, dann erneut prüfen.'
          : 'Das PDF-Programm fehlt offline – mit Internet erneut prüfen.');
    }
    // 2) jede Notiz
    let done = 0;
    const total = nbs.reduce((a, nb) => a + (nb.pageIds?.length || 0), 0) || 1;
    for (const nb of nbs) {
      const pages = await store.getMany('pages', nb.pageIds || []);
      const issues = [];
      const missing = pages.filter(x => !x).length;
      if (missing) issues.push(`${missing} ${missing === 1 ? 'Seite fehlt' : 'Seiten fehlen'} auf diesem Gerät (Abgleich abwarten)`);
      const keys = [...new Set(pages.filter(x => x?.pdf).map(x => x.pdf.key))];
      let noPdf = 0;
      for (const k of keys) if (!(await store.getBlob(k))) noPdf++;
      if (noPdf) issues.push('Original-PDF fehlt (Abgleich abwarten)');
      let drawn = 0, noBg = 0, noImg = 0;
      for (const pg of pages) {
        status.textContent = `„${nb.title}“: Seite ${pages.indexOf(pg) + 1} von ${pages.length}`;
        bar.style.width = Math.round((++done / total) * 100) + '%';
        if (!pg) continue;
        if (pg.bg && !(await hasBg(pg))) {
          if (pg.pdf && (await bgBlob(pg))) drawn++;
          else noBg++;
        }
        for (const im of pg.images || []) if (!(await store.getBlob(im.key))) noImg++;
      }
      if (noBg) issues.push(`${noBg} Folienbilder fehlen`);
      if (noImg) issues.push(`${noImg} Bilder fehlen (Abgleich abwarten)`);
      for (const k of keys) await pdfText(k).catch(() => null);
      const { docs } = await docsFor(pages);
      const withText = docs.filter(d => d && d.norm.trim()).length, n = pages.length;
      let search = withText === n ? 'durchsuchbar' : withText ? `${withText} von ${n} Seiten durchsuchbar` : 'nicht durchsuchbar (nur Handschrift/Bilder)';
      if (!withText && (pages.some(x => x?.images?.length) || pages.some(x => x?.bg && !x.pdf))) search += ' – Tipp: das Original-PDF importieren, dann ist der Text durchsuchbar';
      if (issues.length) problems++;
      row(!issues.length && withText > 0, nb.title,
        [pagesWord(n), issues.length ? issues.join(', ') : 'offline bereit' + (drawn ? ` (${drawn} Folienbilder ergänzt)` : ''), search].join(' · '));
    }
    status.textContent = '';
    bar.parentElement.remove();
    head.replaceChildren(h('p', { class: 'oc-sum' + (problems ? ' warn' : ' ok') }, problems
      ? 'Noch nicht alles bereit – siehe unten. Mit Internet beheben und erneut prüfen.'
      : 'Alles bereit für den Flugmodus.'),
    h('p', { class: 'muted small' }, 'Tipp: Vor der Klausur einmal im Flugmodus öffnen und eine Suche ausprobieren.'));
  } catch (err) {
    console.error(err);
    status.textContent = 'Prüfung abgebrochen: ' + err.message;
  }
  return p;
}

// ---------- Suchleiste in der offenen Notiz ----------
// opts: host (Element für die Leiste), pages() → Seiten, pageEl(id) → Seiten-Element,
// show(pageId, rect): Stelle in den Blick holen, onClose()
export function createFindBar(opts) {
  let hits = [], cur = -1, seq = 0, timer = 0;
  const layers = [];
  const input = h('input', { class: 'input', type: 'search', placeholder: 'In dieser Notiz suchen', enterkeyhint: 'search', autocomplete: 'off',
    oninput: () => { clearTimeout(timer); timer = setTimeout(run, 220); },
    onkeydown: e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (timer) { clearTimeout(timer); run(); } // noch nicht gesucht: zum ersten Treffer
        else step(e.shiftKey ? -1 : 1);
      }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    } });
  const count = h('span', { class: 'fb-count' });
  const btn = (name, title, fn) => h('button', { class: 'ibtn sm', type: 'button', title, 'aria-label': title, onclick: fn }, icon(name));
  const bar = h('div', { class: 'findbar' }, icon('search'), input, count,
    btn('arrowUp', 'Vorheriger Treffer', () => step(-1)), btn('arrowDown', 'Nächster Treffer', () => step(1)), btn('close', 'Suche schließen', () => close()));
  opts.host.append(bar);

  function clearMarks() { for (const l of layers.splice(0)) l.remove(); }
  function drawMarks() {
    clearMarks();
    const byPage = new Map();
    hits.forEach((x, i) => { if (!byPage.has(x.pageId)) byPage.set(x.pageId, []); byPage.get(x.pageId).push([x, i]); });
    for (const [pid, list] of byPage) {
      const el = opts.pageEl(pid);
      if (!el) continue;
      const layer = h('div', { class: 'fhl-layer' });
      for (const [x, i] of list) for (const r of x.rects) {
        layer.append(h('div', { class: 'fhl' + (i === cur ? ' cur' : ''), 'data-i': i, style: { left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%' } }));
      }
      el.append(layer);
      layers.push(layer);
    }
  }
  function mark() { for (const l of layers) for (const d of l.children) d.classList.toggle('cur', +d.dataset.i === cur); }
  async function run(startPage = null) {
    timer = 0;
    const my = ++seq, q = input.value;
    const terms = parseQuery(q);
    if (!terms.length) { hits = []; cur = -1; clearMarks(); count.textContent = ''; return; }
    const pages = opts.pages();
    const { docs } = await docsFor(pages);
    if (my !== seq) return;
    hits = [];
    docs.forEach((doc, pi) => {
      const m = doc && matchDoc(doc, terms);
      if (!m) return;
      // jede Fundstelle einzeln (bei mehreren Wörtern: das erste Wort als Anker)
      for (const x of m.hits) {
        if (terms.length > 1 && x.k !== 0) continue;
        const rects = hitRects(doc, x);
        if (rects.length) hits.push({ pageId: pages[pi].id, pi, rects, y: rects[0].y });
      }
    });
    cur = -1;
    if (startPage) cur = hits.findIndex(x => x.pageId === startPage);
    else {
      const vis = opts.visiblePage?.();
      const from = vis != null ? hits.findIndex(x => x.pi >= vis) : 0;
      cur = hits.length ? Math.max(0, from) : -1;
    }
    if (cur < 0 && hits.length) cur = 0;
    drawMarks();
    updCount();
    if (cur >= 0) go(cur);
  }
  function updCount() {
    count.textContent = input.value.trim() ? (hits.length ? `${cur + 1} / ${hits.length}` : '0 Treffer') : '';
    bar.classList.toggle('none', !!input.value.trim() && !hits.length);
  }
  function step(d) {
    if (!hits.length) { if (input.value.trim()) toast('Kein Treffer. Durchsuchbar sind PDF-Folien und getippter Text, keine Handschrift.'); return; }
    cur = (cur + d + hits.length) % hits.length;
    go(cur);
  }
  function go(i) {
    mark();
    updCount();
    const x = hits[i];
    const r = x.rects.reduce((a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) }));
    opts.show(x.pageId, r);
  }
  function close() {
    clearTimeout(timer);
    seq++;
    clearMarks();
    bar.remove();
    opts.onClose?.();
  }
  return {
    open(q = null, pageId = null) {
      if (q != null) { input.value = q; run(pageId); }
      input.focus({ preventScroll: true });
      if (q == null) input.select();
    },
    // Seiten wurden neu aufgebaut (Seite eingefügt usw.): Markierungen neu setzen
    refresh() { if (input.value.trim()) run(hits[cur]?.pageId || null); },
    close,
  };
}

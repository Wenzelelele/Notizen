// Lernmodus: fällige Karteikarten eines Ordners (inkl. Unterordner) oder aller Ordner abfragen.
// Ablauf je Karte: Vorderseite → „Antwort zeigen“ → Rückseite → Bewertung (FSRS bestimmt den nächsten Termin).
import { store } from './store.js';
import { h, icon, toast } from './ui.js';
import { isCard, renderPage, subtree, renderOcclusion, loadOcclusionImage } from './cards.js';
import { preview, GRADES, fmtInterval } from './srs.js';

const NEW_PER_SESSION = 20; // neue Karten pro Lernrunde
const SOON = 20 * 6e4;      // Karten, die innerhalb von 20 Min wieder dran sind, bleiben in der Runde

export async function showReview(root, folderId) {
  const [folders, notebooks] = await Promise.all([store.getAll('folders'), store.getAll('notebooks')]);
  const ids = subtree(folders, folderId);
  const folder = folders.find(f => f.id === folderId);
  const now = Date.now();
  const cards = notebooks.filter(n => isCard(n) && (!ids || ids.has(n.folderId)));
  const queue = [
    ...cards.filter(c => c.srs.state !== 'new' && c.srs.due <= now).sort((a, b) => a.srs.due - b.srs.due),
    ...cards.filter(c => c.srs.state === 'new').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(0, NEW_PER_SESSION),
  ];
  const total = queue.length;
  let done = 0, again = 0, current = null, revealed = false, alive = true;

  const progressEl = h('span', { class: 'page-label' });
  const cardEl = h('div', { class: 'rv-card' });
  const footEl = h('div', { class: 'rv-foot' });
  const back = () => { location.hash = ''; };
  const wrap = h('div', { class: 'review' },
    h('header', { class: 'ed-top' },
      h('button', { class: 'ibtn', title: 'Zurück', 'aria-label': 'Zurück', onclick: back }, icon('back')),
      h('div', { class: 'ed-title' }, 'Lernen' + (folder ? ': ' + folder.name : '')),
      h('div', { class: 'grow' }), progressEl,
      h('button', { class: 'ibtn', title: 'Karte bearbeiten', 'aria-label': 'Karte bearbeiten', onclick: () => current && open(current.id, !!current.occl) }, icon('edit'))),
    h('div', { class: 'rv-body' }, cardEl), footEl);
  root.replaceChildren(wrap);

  // Karte zum Bearbeiten oder ihre Quelle öffnen – „Zurück“ führt wieder hierher
  function open(id, occl) {
    try { sessionStorage.setItem('notizen.return:' + id, location.hash.slice(1)); } catch { /* egal */ }
    location.hash = (occl ? 'abdecken/' : 'nb/') + id;
  }

  const sideWidth = () => Math.min(cardEl.clientWidth || 600, 900);
  async function side(page) {
    const w = sideWidth(), dpr = window.devicePixelRatio || 1;
    const c = await renderPage(page, { scale: (w * dpr) / page.w });
    c.style.width = w + 'px';
    c.className = 'rv-side';
    return c;
  }
  // Abdeck-Karte: dasselbe Bild, einmal mit verdecktem und einmal mit aufgedecktem Bereich
  async function occlSide(card, reveal) {
    const c = await renderOcclusion(card.occl, { reveal, width: sideWidth(), dpr: window.devicePixelRatio || 1, bitmap: card.__bmp });
    c.className = 'rv-side';
    return c;
  }

  async function show() {
    if (!alive) return;
    progressEl.textContent = `${Math.min(done + 1, total)} / ${total}`;
    current = queue.shift();
    revealed = false;
    if (!current) return finish();
    cardEl.replaceChildren(h('div', { class: 'muted small' }, 'Wird geladen …'));
    if (current.occl) current.__bmp = await loadOcclusionImage(current.occl);
    const pages = current.occl ? [] : await store.pagesOf(current);
    const front = current.occl ? await occlSide(current, false) : pages[0] ? await side(pages[0]) : h('p', {}, '(leer)');
    if (!alive) return;
    const src = current.source?.noteId;
    cardEl.replaceChildren(h('div', { class: 'rv-label' }, current.occl ? 'Was ist hier verdeckt?' : 'Frage'), front);
    footEl.replaceChildren(
      src ? h('button', { class: 'btn', onclick: () => open(src) }, icon('book'), 'Im Skript zeigen') : null,
      h('button', { class: 'btn primary rv-show', onclick: reveal }, 'Antwort zeigen'));
    current.__pages = pages;
  }

  async function reveal() {
    if (!current || revealed) return;
    revealed = true;
    if (current.occl) { // Bereich aufdecken (an derselben Stelle)
      cardEl.replaceChildren(h('div', { class: 'rv-label' }, 'Antwort'), await occlSide(current, true));
    } else {
      const page = current.__pages[1];
      cardEl.append(h('div', { class: 'rv-label' }, 'Antwort'), page ? await side(page) : h('p', {}, '(leer)'));
    }
    const options = preview(current.srs);
    footEl.replaceChildren(...GRADES.map(([g, label]) =>
      h('button', { class: 'btn rv-grade g' + g, onclick: () => grade(g, options[g - 1]) },
        h('b', {}, label), h('span', { class: 'small' }, fmtInterval(options[g - 1].due - Date.now())))));
    cardEl.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function grade(g, srs) {
    const c = current;
    delete c.__pages;
    c.__bmp?.close?.();
    delete c.__bmp;
    c.srs = srs;
    await store.put('notebooks', c);
    if (g === 1) again++;
    if (srs.due - Date.now() < SOON) queue.push(c); // kommt in dieser Runde nochmal
    else done++;
    show();
  }

  function finish() {
    current = null;
    progressEl.textContent = '';
    const next = cards.filter(c => c.srs.state !== 'new').map(c => c.srs.due).filter(d => d > Date.now()).sort((a, b) => a - b)[0];
    cardEl.replaceChildren(h('div', { class: 'empty' },
      h('div', { class: 'empty-ico' }, icon('learn')),
      h('h2', {}, total ? 'Geschafft!' : cards.length ? 'Gerade nichts fällig' : 'Noch keine Karteikarten'),
      h('p', { class: 'muted' }, total
        ? `${done} Karten wiederholt${again ? `, ${again}× „Nochmal“` : ''}.`
        : cards.length ? 'Alle Karten hier sind auf dem neuesten Stand.' : 'Leg Karten mit dem Rahmen-Werkzeug in einer Notiz an oder über „Neue Karteikarte“.'),
      next ? h('p', { class: 'muted small' }, `Nächste Karte fällig in ${fmtInterval(next - Date.now())}.`) : null));
    footEl.replaceChildren(h('button', { class: 'btn primary', onclick: back }, 'Zurück'));
  }

  function onKey(e) {
    if (e.target.matches?.('input, textarea')) return;
    if (!revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); reveal(); }
    else if (revealed && /^[1-4]$/.test(e.key)) footEl.querySelectorAll('.rv-grade')[+e.key - 1]?.click();
  }
  addEventListener('keydown', onKey);
  cardEl.addEventListener('click', () => { if (!revealed) reveal(); });

  if (!total && cards.length) toast('Gerade sind keine Karten fällig.');
  show();
  return () => { alive = false; removeEventListener('keydown', onKey); };
}

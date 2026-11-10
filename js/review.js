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
  let done = 0, again = 0, current = null, revealed = false, alive = true, busy = false;
  let last = null; // letzte Bewertung, zum Zurücknehmen: { card, srs (vorher), requeued, done, again }

  const progressEl = h('span', { class: 'page-label' });
  const cardEl = h('div', { class: 'rv-card' });
  const footEl = h('div', { class: 'rv-foot' });
  const back = () => { location.hash = ''; };
  const undoBtn = h('button', { class: 'ibtn', title: 'Letzte Bewertung zurücknehmen', 'aria-label': 'Letzte Bewertung zurücknehmen', onclick: () => undoGrade() }, icon('undo'));
  undoBtn.disabled = true;
  const wrap = h('div', { class: 'review' },
    h('header', { class: 'ed-top' },
      h('button', { class: 'ibtn', title: 'Zurück', 'aria-label': 'Zurück', onclick: back }, icon('back')),
      h('div', { class: 'ed-title' }, 'Lernen' + (folder ? ': ' + folder.name : '')),
      h('div', { class: 'grow' }), progressEl, undoBtn,
      h('button', { class: 'ibtn', title: 'Karte bearbeiten', 'aria-label': 'Karte bearbeiten', onclick: () => current && open(current.id, !!current.occl) }, icon('edit'))),
    h('div', { class: 'rv-body' }, cardEl), footEl);
  root.replaceChildren(wrap);

  // Karte zum Bearbeiten oder ihre Quelle öffnen – „Zurück“ führt wieder hierher
  function open(id, occl) {
    try { sessionStorage.setItem('notizen.return:' + id, location.hash.slice(1)); } catch { /* egal */ }
    location.hash = (occl ? 'abdecken/' : 'nb/') + id;
  }

  const sideWidth = () => Math.min(cardEl.clientWidth || 600, 900);
  const blank = () => h('p', {}, '(leer)');
  async function side(page) {
    const w = sideWidth(), dpr = window.devicePixelRatio || 1;
    const c = await renderPage(page, { scale: (w * dpr) / page.w });
    c.style.width = w + 'px';
    c.className = 'rv-side';
    return c;
  }
  // Abdeck-Karte: dasselbe Bild, einmal mit verdecktem und einmal mit aufgedecktem Bereich
  async function occlSide(card, bitmap, reveal) {
    const c = await renderOcclusion(card.occl, { reveal, width: sideWidth(), dpr: window.devicePixelRatio || 1, bitmap });
    c.className = 'rv-side';
    return c;
  }

  // Seiten im Voraus zeichnen: die Rückseite der aktuellen Karte (während man über die Frage nachdenkt) und die
  // Vorderseite der nächsten. So wechselt die Karte ohne Wartezeit und ohne „Wird geladen …“ dazwischen.
  const prep = new Map(); // Karten-id → { front, back?, makeBack(), close() }
  function prepare(card, withBack) {
    let e = prep.get(card.id);
    if (!e) {
      if (card.occl) {
        const bmp = loadOcclusionImage(card.occl);
        e = {
          front: bmp.then(b => occlSide(card, b, false)),
          makeBack: () => bmp.then(b => occlSide(card, b, true)),
          close: () => bmp.then(b => b?.close?.()).catch(() => {}),
        };
      } else {
        const pages = store.pagesOf(card);
        e = {
          front: pages.then(ps => (ps[0] ? side(ps[0]) : blank())),
          makeBack: () => pages.then(ps => (ps[1] ? side(ps[1]) : blank())),
          close: () => {},
        };
      }
      e.front.catch(() => {}); // Fehler meldet show()
      prep.set(card.id, e);
    }
    if (withBack && !e.back) { e.back = e.front.then(() => e.makeBack()); e.back.catch(() => {}); } // erst die Frage, dann die Antwort
    return e;
  }
  function discard(id) {
    const e = prep.get(id);
    if (!e) return;
    prep.delete(id);
    Promise.allSettled([e.front, e.back]).then(() => e.close()); // Bild erst freigeben, wenn nichts mehr daran zeichnet
  }

  async function show() {
    if (!alive) return;
    progressEl.textContent = `${Math.min(done + 1, total)} / ${total}`;
    current = queue.shift();
    revealed = false;
    if (!current) return finish();
    const c = current, e = prepare(c, true);
    for (const b of footEl.querySelectorAll('button')) b.disabled = true; // Knöpfe der vorigen Karte
    // Hinweis nur, wenn es wirklich dauert (sonst flackert er bei jedem Kartenwechsel)
    const wait = setTimeout(() => { if (alive && current === c) cardEl.replaceChildren(h('div', { class: 'muted small' }, 'Wird geladen …')); }, 300);
    let front;
    try { front = await e.front; } catch (err) { console.error(err); front = h('p', {}, 'Diese Karte konnte nicht geladen werden.'); }
    clearTimeout(wait);
    if (!alive || current !== c) return; // Lernmodus verlassen oder Bewertung zurückgenommen
    const src = c.source?.noteId;
    cardEl.replaceChildren(h('div', { class: 'rv-label' }, c.occl ? 'Was ist hier verdeckt?' : 'Frage'), front);
    cardEl.parentElement.scrollTop = 0;
    footEl.replaceChildren(
      src ? h('button', { class: 'btn', onclick: () => open(src) }, icon('book'), 'Im Skript zeigen') : null,
      h('button', { class: 'btn primary rv-show', onclick: reveal }, 'Antwort zeigen'));
    if (queue[0]) prepare(queue[0], false);
  }

  async function reveal() {
    if (!current || revealed) return;
    revealed = true;
    const c = current;
    let answer;
    try { answer = await prepare(c, true).back; } catch (err) { console.error(err); answer = h('p', {}, 'Die Antwort konnte nicht geladen werden.'); }
    if (!alive || current !== c) return;
    if (c.occl) cardEl.replaceChildren(h('div', { class: 'rv-label' }, 'Antwort'), answer); // Bereich aufdecken (an derselben Stelle)
    else cardEl.append(h('div', { class: 'rv-label' }, 'Antwort'), answer);
    const options = preview(c.srs);
    footEl.replaceChildren(...GRADES.map(([g, label]) =>
      h('button', { class: 'btn rv-grade g' + g, onclick: () => grade(g, options[g - 1]) },
        h('b', {}, label), h('span', { class: 'small' }, fmtInterval(options[g - 1].due - Date.now())))));
    cardEl.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function grade(g, srs) {
    const c = current;
    if (!c || busy) return;
    busy = true;
    try {
      last = { card: c, srs: c.srs, requeued: false, done, again };
      c.srs = srs;
      await store.put('notebooks', c);
      if (g === 1) again++;
      if (srs.due - Date.now() < SOON) { queue.push(c); last.requeued = true; } // kommt in dieser Runde nochmal
      else { done++; discard(c.id); }
      undoBtn.disabled = false;
    } finally { busy = false; }
    show();
  }

  // Verdrückt? Die letzte Bewertung zurücknehmen: Die Karte bekommt ihren Lernstand von vorher und wird nochmal gezeigt.
  async function undoGrade() {
    if (!last || busy) return;
    busy = true;
    const u = last;
    last = null;
    undoBtn.disabled = true;
    try {
      u.card.srs = u.srs;
      await store.put('notebooks', u.card);
      if (u.requeued) { const i = queue.lastIndexOf(u.card); if (i >= 0) queue.splice(i, 1); }
      done = u.done;
      again = u.again;
      if (current && current !== u.card) queue.unshift(current); // die gerade gezeigte Karte kommt danach
      queue.unshift(u.card);
    } finally { busy = false; }
    toast('Bewertung zurückgenommen');
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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoGrade(); }
    else if (!revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); reveal(); }
    else if (revealed && /^[1-4]$/.test(e.key)) footEl.querySelectorAll('.rv-grade')[+e.key - 1]?.click();
  }
  addEventListener('keydown', onKey);
  cardEl.addEventListener('click', () => { if (!revealed) reveal(); });

  if (!total && cards.length) toast('Gerade sind keine Karten fällig.');
  show();
  return () => {
    alive = false;
    removeEventListener('keydown', onKey);
    for (const id of [...prep.keys()]) discard(id);
  };
}

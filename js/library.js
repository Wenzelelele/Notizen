// Bibliothek: Ordner (beliebig verschachtelt), Notizbücher, Import (OneNote, PDF), Backup.
import { store, uid, newNotebook, newPage, exportBackup, importBackup } from './store.js';
import { h, icon, menu, modal, confirmDialog, promptText, toast, progress, pickFiles, download, seg, field, safeName } from './ui.js';
import { importPdf, exportPdf } from './pdfio.js';
import { loadIndex, importPage, hid } from './onenote.js';
import { syncDialog, syncEvents, syncStatus } from './sync.js';
import { cloudConfigured, currentUser } from './cloud.js';

// Die gerade sichtbare Bibliothek aktualisieren, wenn der Sync etwas geholt hat bzw. sich sein Status ändert
let active = null;
syncEvents.addEventListener('received', () => active?.reload());
syncEvents.addEventListener('status', () => active?.render());
import { TEMPLATES, PAPER_NAMES, drawBackground } from './ink.js';
import { isCard, createCard, deleteCard, isCardFolder, cardFolderFor, tidyCards } from './cards.js';
import { fmtInterval, newSrs } from './srs.js';
import { startOcclusion } from './occlusion.js';
import { loadImage } from './pdfio.js';
import { versionLabel } from './version.js';
import { splitDialog } from './split.js';
import { claudeDialog } from './claude.js';
import { checkInbox, inboxDialog } from './inbox.js';
import { storageDialog, shrinkWithProgress } from './storage.js';

const COVERS = ['#2f6fed', '#e0533d', '#2e9e6b', '#8a55d6', '#f0a020', '#3b4252', '#d94d8a', '#1a9bb0'];
const FOLDER_KEY = 'notizen.folder';

const fmtDate = ts => new Date(ts || Date.now()).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const clean = s => (s || '').replace(/\s+/g, ' ').trim();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export async function showLibrary(root) {
  let folders = [], notebooks = [];
  let current = null; // geöffneter Ordner (id) oder null = oberste Ebene
  try { current = localStorage.getItem(FOLDER_KEY) || null; } catch { /* egal */ }
  const wrap = h('div', { class: 'lib' });
  root.replaceChildren(wrap);

  // ---------- Ordnerbaum ----------
  const byId = id => folders.find(f => f.id === id);
  const parentOf = f => (f.parentId && byId(f.parentId) ? f.parentId : null);
  const subfolders = id => folders.filter(f => parentOf(f) === id);
  const folderOf = n => (n.folderId && byId(n.folderId) ? n.folderId : null);
  const notesIn = id => notebooks.filter(n => !isCard(n) && folderOf(n) === id);
  const cardsIn = id => notebooks.filter(n => isCard(n) && folderOf(n) === id);
  // Karteikarten im ganzen Teilbaum (null = alle) und wie viele davon jetzt dran sind (fällig + neu)
  const cardsUnder = id => { const ids = id ? new Set(descendants(id)) : null; return notebooks.filter(n => isCard(n) && (!ids || ids.has(folderOf(n)))); };
  const dueCount = list => { const now = Date.now(); return list.filter(c => c.srs.state === 'new' || c.srs.due <= now).length; };
  const pathTo = id => {
    const p = [];
    for (let f = byId(id); f && p.length < 50; f = byId(parentOf(f))) p.unshift(f);
    return p;
  };
  const descendants = id => { // Ordner-ids inkl. id selbst
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const f of subfolders(out[i])) out.push(f.id);
    return out;
  };
  const byOrder = (a, b) => (a.order ?? -1) - (b.order ?? -1);
  const byDate = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
  const byName = (a, b) => a.name.localeCompare(b.name, 'de');

  function go(id) {
    current = id || null;
    try { current ? localStorage.setItem(FOLDER_KEY, current) : localStorage.removeItem(FOLDER_KEY); } catch { /* egal */ }
    render();
    wrap.scrollTop = 0;
  }
  async function reload() {
    [folders, notebooks] = await Promise.all([store.getAll('folders'), store.getAll('notebooks')]);
    // Karteikarten gehören in den Karteikarten-Ordner des Fachs (auch ältere oder von Claude angelegte)
    if (await tidyCards(folders, notebooks)) folders = await store.getAll('folders');
    if (current && !byId(current)) current = null;
    render();
  }

  function render() {
    const path = pathTo(current);
    const here = path[path.length - 1] || null;
    const cardsHere = isCardFolder(here); // im Karteikarten-Ordner eines Fachs
    const subs = subfolders(current).sort((a, b) => isCardFolder(b) - isCardFolder(a) || byOrder(a, b) || byName(a, b));
    // in Ordnern: importierte OneNote-Seiten in OneNote-Reihenfolge, eigene Notizen davor
    const notes = notesIn(current).sort(current ? (a, b) => byOrder(a, b) || byDate(a, b) : byDate);
    const flash = cardsIn(current).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const learnable = cardsUnder(current), due = dueCount(learnable);
    const parts = [
      h('header', { class: 'lib-head' },
        here ? h('button', { class: 'ibtn', title: 'Zurück', 'aria-label': 'Zurück', onclick: () => go(parentOf(here)) }, icon('back')) : null,
        h('h1', {}, here ? here.name : 'Notizen'),
        h('div', { class: 'head-actions' },
        learnable.length ?h('button', { class: 'btn learn-btn' + (due ? ' due' : ''), title: here ? `Karteikarten in „${here.name}“ lernen` : 'Alle fälligen Karteikarten lernen', onclick: () => { location.hash = 'lernen' + (current ? '/' + current : ''); } },
          icon('learn'), h('span', { class: 'hide-sm' }, 'Lernen'), due ? h('span', { class: 'badge' }, due) : null) : null,
        cardsHere ? null : h('button', { class: 'btn', onclick: e => importMenu(e.currentTarget) }, icon('upload'), h('span', { class: 'hide-sm' }, 'Importieren')),
        cardsHere ? null : h('button', { class: 'ibtn', title: 'Neuer Ordner', 'aria-label': 'Neuer Ordner', onclick: newFolder }, icon('folderPlus')),
        cardsHere ? h('button', { class: 'btn primary', onclick: e => newFlashcard(e) }, icon('cardPlus'), h('span', { class: 'hide-sm' }, 'Karteikarte'))
          : h('button', { class: 'ibtn', title: 'Neue Karteikarte', 'aria-label': 'Neue Karteikarte', onclick: e => newFlashcard(e) }, icon('cardPlus')),
        cardsHere ? null : h('button', { class: 'btn primary', onclick: newNotebookDialog }, icon('plus'), h('span', { class: 'hide-sm' }, 'Notiz')),
        syncButton(),
        h('button', { class: 'ibtn', title: 'Mehr', 'aria-label': 'Mehr', onclick: e => (here ? folderMenu(here, e.currentTarget) : libMenu(e.currentTarget)) }, icon('more')))),
      here ? h('nav', { class: 'crumbs', 'aria-label': 'Ordnerpfad' },
        h('button', { onclick: () => go(null) }, 'Notizen'),
        path.map((f, i) => [h('span', { class: 'sep' }, '›'), i === path.length - 1 ? h('span', { class: 'cur' }, f.name) : h('button', { onclick: () => go(f.id) }, f.name)])) : null,
      learnable.length && !cardsHere ? learnPanel(learnable) : null,
      subs.length ? h('section', {}, h('h3', { class: 'sec-title' }, 'Ordner'), h('div', { class: 'fgrid' }, subs.map(folderCard))) : null,
      flash.length ? h('section', {}, h('h3', { class: 'sec-title' }, `Karteikarten · ${flash.length}`), h('div', { class: 'cgrid' }, flash.map(flashCard))) : null,
      notes.length ? h('section', {}, subs.length || flash.length ? h('h3', { class: 'sec-title' }, 'Notizen') : null, h('div', { class: 'grid' }, notes.map(card))) : null,
      !subs.length && !notes.length && !flash.length ? empty(here) : null];
    wrap.replaceChildren(...parts.filter(Boolean)); // replaceChildren würde null als Text "null" einfügen
  }

  // ---------- Lern-Übersicht: was heute dran ist, je Fach, und die nächsten 7 Tage ----------
  // Alles aus dem Lernstand der Karten (nb.srs) berechnet – wird also auch zwischen den Geräten abgeglichen.
  let allSubjects = false;
  function learnPanel(cards) {
    const now = Date.now(), t = new Date();
    // Tagesgrenzen nach Kalender (nicht 24 h): bei der Zeitumstellung hat ein Tag 23 oder 25 Stunden
    const day = i => new Date(t.getFullYear(), t.getMonth(), t.getDate() + i).getTime();
    const start = day(0), isNew = c => c.srs.state === 'new';
    const dueNow = cards.filter(c => !isNew(c) && c.srs.due <= now).length;
    const fresh = cards.filter(isNew).length;
    const today = cards.filter(c => (c.srs.last || 0) >= start).length;
    const days = Array.from({ length: 7 }, (_, i) => cards.filter(c => !isNew(c) && c.srs.due < day(i + 1) && (i === 0 || c.srs.due >= day(i))).length);
    const max = Math.max(1, ...days);
    const wd = i => new Date(day(i)).toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '');
    // Fach = Ordner, in dem der Karteikarten-Ordner liegt; Name relativ zum gerade geöffneten Ordner
    const bySubj = new Map();
    for (const c of cards) {
      const kf = byId(folderOf(c)), id = kf ? (isCardFolder(kf) ? parentOf(kf) : kf.id) : null;
      const e = bySubj.get(id) || { id, kf: kf?.id, due: 0, fresh: 0 };
      if (isNew(c)) e.fresh++; else if (c.srs.due <= now) e.due++;
      bySubj.set(id, e);
    }
    const label = e => {
      if (!e.id) return 'Ohne Fach';
      const names = pathTo(e.id).map(f => f.name), skip = pathTo(current).length;
      return names.slice(Math.min(skip, names.length - 1)).join(' › ');
    };
    const subjects = [...bySubj.values()].sort((a, b) => b.due + b.fresh - (a.due + a.fresh) || label(a).localeCompare(label(b), 'de'));
    const shown = allSubjects ? subjects : subjects.slice(0, 5);
    const stat = (n, l) => h('div', { class: 'lp-stat' }, h('b', {}, n), h('span', {}, l));
    return h('section', { class: 'learn-panel' },
      h('div', { class: 'lp-head' },
        h('div', { class: 'lp-stats' }, stat(dueNow, 'fällig'), stat(fresh, 'neu'), stat(today, 'heute gelernt')),
        h('div', { class: 'lp-days', title: 'Fällige Wiederholungen in den nächsten 7 Tagen' },
          days.map((n, i) => h('div', { class: 'lp-day' + (i === 0 ? ' now' : '') },
            h('b', {}, n || ''), h('div', { class: 'lp-bar' }, h('i', { style: { height: Math.round((n / max) * 100) + '%' } })), h('span', {}, i ? wd(i) : 'heute'))))),
      subjects.length > 1 || current === null ? h('div', { class: 'lp-subjects' },
        shown.map(e => h('button', { class: 'lp-subj', type: 'button', onclick: () => { location.hash = 'lernen/' + (e.id || e.kf); } },
          h('span', { class: 'grow' }, label(e)),
          e.due ? h('span', { class: 'badge' }, e.due) : null,
          e.fresh ? h('span', { class: 'muted small' }, e.fresh + ' neu') : null,
          !e.due && !e.fresh ? h('span', { class: 'muted small' }, 'erledigt') : null)),
        subjects.length > 5 ? h('button', { class: 'linkbtn', type: 'button', onclick: () => { allSubjects = !allSubjects; render(); } },
          allSubjects ? 'Weniger anzeigen' : `Alle ${subjects.length} Fächer`) : null) : null);
  }

  function syncButton() {
    const st = syncStatus(), cloud = cloudConfigured(), user = cloud && currentUser();
    const title = !cloud ? 'Synchronisieren (über den PC)' : !user ? 'Cloud-Sync: nicht angemeldet'
      : { busy: 'Wird abgeglichen …', error: 'Sync-Fehler: ' + st.text, offline: 'Offline – wird abgeglichen, sobald du online bist', ok: 'Abgeglichen' }[st.state] || 'Synchronisieren';
    return h('button', { class: `ibtn sync-btn ${st.state}${cloud && !user ? ' off' : ''}`, title, 'aria-label': title, onclick: () => syncDialog(reload) }, icon('sync'));
  }

  function folderCard(f) {
    const nSub = subfolders(f.id).length, nNotes = notesIn(f.id).length, under = cardsUnder(f.id), due = dueCount(under);
    const info = [nSub ? plural(nSub, 'Ordner', 'Ordner') : '', nNotes ? plural(nNotes, 'Notiz', 'Notizen') : '',
      under.length ? plural(under.length, 'Karte', 'Karten') + (due ? ` (${due} dran)` : '') : ''].filter(Boolean).join(' · ') || 'leer';
    const cards = isCardFolder(f);
    return h('div', { class: 'fcard' + (cards ? ' cards' : ''), oncontextmenu: e => { e.preventDefault(); folderMenu(f, e.currentTarget); } },
      h('button', { class: 'fopen', onclick: () => go(f.id) },
        h('span', { class: 'fico', style: { '--c': cards ? '#f0a020' : f.color || '#2f6fed' } }, icon(cards ? 'card' : 'folder')),
        h('span', { class: 'ftext' }, h('b', {}, f.name), h('span', { class: 'muted small' }, info))),
      h('button', { class: 'ibtn sm', title: 'Optionen', 'aria-label': 'Ordneroptionen', onclick: e => folderMenu(f, e.currentTarget) }, icon('more')));
  }

  function card(nb) {
    const open = () => { location.hash = 'nb/' + nb.id; };
    const cover = nb.thumb
      ? h('div', { class: 'cover doc' }, h('img', { src: nb.thumb, alt: '' }))
      : h('div', { class: 'cover', style: { '--c': nb.color } }, h('div', { class: 'label' }, nb.title));
    const n = nb.pageIds.length;
    return h('div', { class: 'nb-card', oncontextmenu: e => { e.preventDefault(); nbMenu(nb, e.currentTarget); } },
      h('button', { class: 'cover-btn', 'aria-label': nb.title + ' öffnen', onclick: open }, cover),
      h('div', { class: 'nb-meta' },
        h('div', { class: 'grow', onclick: open },
          h('div', { class: 't' }, nb.title),
          h('div', { class: 's' }, n > 1 ? `${n} Seiten · ${fmtDate(nb.updatedAt)}` : fmtDate(nb.updatedAt))),
        h('button', { class: 'ibtn sm', title: 'Optionen', 'aria-label': 'Optionen', onclick: e => nbMenu(nb, e.currentTarget) }, icon('more'))));
  }

  // ---------- Karteikarten ----------
  const openCard = nb => { location.hash = (nb.occl ? 'abdecken/' : 'nb/') + nb.id; };
  function flashCard(nb) {
    const open = () => openCard(nb);
    const s = nb.srs || newSrs(), now = Date.now();
    const state = s.state === 'new' ? 'neu' : s.due <= now ? 'dran' : 'in ' + fmtInterval(s.due - now);
    return h('div', { class: 'fc-card', oncontextmenu: e => { e.preventDefault(); flashMenu(nb, e.currentTarget); } },
      h('button', { class: 'fc-face', 'aria-label': 'Karteikarte öffnen', onclick: open }, nb.thumb ? h('img', { src: nb.thumb, alt: '' }) : h('span', { class: 'muted small' }, 'leer')),
      h('div', { class: 'nb-meta' },
        h('div', { class: 'grow s' + (s.state === 'new' || s.due <= now ? ' due' : '') }, state),
        h('button', { class: 'ibtn sm', title: 'Optionen', 'aria-label': 'Kartenoptionen', onclick: e => flashMenu(nb, e.currentTarget) }, icon('more'))));
  }
  function flashMenu(nb, anchor) {
    menu(anchor, [
      { icon: 'edit', label: nb.occl ? 'Bereiche bearbeiten' : 'Bearbeiten', onClick: () => openCard(nb) },
      nb.source?.noteId && { icon: 'book', label: 'Im Skript zeigen', onClick: () => { location.hash = 'nb/' + nb.source.noteId; } },
      { icon: 'folder', label: 'In Ordner verschieben', onClick: () => moveDialog(nb) },
      { icon: 'undo', label: 'Lernstand zurücksetzen', onClick: async () => { nb.srs = newSrs(); await store.put('notebooks', nb); render(); toast('Karte gilt wieder als neu'); } },
      { sep: true },
      { icon: 'trash', label: 'Löschen', danger: true, onClick: async () => {
        if (!(await confirmDialog('Karteikarte löschen?', 'Die Karte und ihr Lernstand werden endgültig gelöscht.', 'Löschen', true))) return;
        await deleteCard(nb);
        await reload();
      } },
    ]);
  }
  function newFlashcard(e) {
    menu(e.currentTarget, [
      { icon: 'cardPlus', label: 'Leere Karteikarte', onClick: async () => { const nb = await createCard({ folderId: current }); location.hash = 'nb/' + nb.id; } },
      { icon: 'card', label: 'Abdeck-Karte aus Bild oder Foto …', onClick: newOcclusionFromImage },
      { sep: true },
      { header: 'Tipp' },
      { label: 'Im Skript: Werkzeug „Karteikarte aus Bereich“', onClick: () => toast('Öffne eine Notiz und wähle das Rahmen-Werkzeug in der Werkzeugleiste.') },
    ]);
  }
  // Muss direkt im Klick laufen (Dateiauswahl am iPad)
  function newOcclusionFromImage() {
    pickFiles('image/*').then(async ([f]) => {
      if (!f) return;
      const pr = progress('Bild wird vorbereitet …');
      try {
        const bmp = await loadImage(f);
        const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height)); // große Fotos verkleinern
        const c = document.createElement('canvas');
        c.width = Math.round(bmp.width * k);
        c.height = Math.round(bmp.height * k);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close?.();
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
        const key = 'img_' + uid();
        await store.putBlob(key, blob);
        startOcclusion({ key, w: 1000, h: Math.round((1000 * c.height) / c.width), folderId: current, returnTo: '' });
      } catch (err) {
        console.error(err);
        toast('Das Bild konnte nicht geladen werden.');
      } finally { pr.close(); }
    });
  }

  function empty(here) {
    if (isCardFolder(here)) {
      return h('div', { class: 'empty' },
        h('div', { class: 'empty-ico' }, icon('card')),
        h('h2', {}, 'Noch keine Karteikarten'),
        h('p', { class: 'muted' }, 'Öffne eine Notiz dieses Fachs und zieh mit dem Rahmen-Werkzeug einen Bereich auf – die Karte landet hier.'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: e => newFlashcard(e) }, icon('cardPlus'), 'Neue Karteikarte')));
    }
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-ico' }, icon(here ? 'folder' : 'book')),
      h('h2', {}, here ? 'Dieser Ordner ist leer' : 'Noch keine Notizen'),
      h('p', { class: 'muted' }, here ? 'Leg hier eine Notiz oder einen Unterordner an.' : 'Leg eine neue Notiz an oder hol dir deine OneNote-Notizbücher vom PC.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: newNotebookDialog }, icon('plus'), 'Neue Notiz'),
        here ? h('button', { class: 'btn', onclick: newFolder }, icon('folderPlus'), 'Neuer Ordner')
          : h('button', { class: 'btn', onclick: pcImportDialog }, icon('book'), 'OneNote vom PC holen')));
  }

  // ---------- Notizen ----------
  async function newNotebookDialog() {
    let color = COVERS[notebooks.length % COVERS.length], template = 'lined', paper = 'white', size = 'a4p';
    const title = h('input', { class: 'input', value: 'Neue Notiz', 'aria-label': 'Titel' });
    const preview = k => {
      const c = h('canvas', { width: 108, height: 152 });
      const ctx = c.getContext('2d');
      // Ausschnitt statt ganzer Seite, damit die Linien in der Vorschau sichtbar sind
      ctx.scale(108 / 360, 152 / 507);
      drawBackground(ctx, { w: 360, h: 507, template: k, paper });
      return c;
    };
    const tplBox = h('div');
    const drawTpl = () => tplBox.replaceChildren(seg(TEMPLATES, template, v => { template = v; }, preview));
    drawTpl();
    const ok = await modal({
      title: 'Neue Notiz',
      body: h('div', { class: 'form' },
        field('Titel', title),
        field('Cover', seg(COVERS.map(c => [c, '']), color, v => { color = v; }, c => h('i', { class: 'cdot', style: { background: c } }), 'covers')),
        field('Vorlage', tplBox),
        field('Papier', seg(PAPER_NAMES, paper, v => { paper = v; drawTpl(); })),
        field('Format', seg([['a4p', 'A4 Hochformat'], ['a4l', 'A4 Querformat']], size, v => { size = v; }))),
      actions: [{ label: 'Abbrechen', value: false }, { label: 'Erstellen', value: true, primary: true }],
      onOpen: () => { title.focus(); title.select(); },
    });
    if (!ok) return;
    const nb = newNotebook({ title: title.value.trim() || 'Unbenannt', color, template, paper, size, folderId: current });
    const p = newPage(nb);
    nb.pageIds = [p.id];
    await store.put('pages', p);
    await store.put('notebooks', nb);
    location.hash = 'nb/' + nb.id;
  }

  function nbMenu(nb, anchor) {
    menu(anchor, [
      { icon: 'edit', label: 'Umbenennen', onClick: async () => {
        const t = await promptText('Notiz umbenennen', nb.title);
        if (t) { nb.title = t; await store.put('notebooks', nb); render(); }
      } },
      !nb.thumb && { icon: 'palette', label: 'Cover-Farbe', onClick: () => coverDialog(nb) },
      { icon: 'folder', label: 'In Ordner verschieben', onClick: () => moveDialog(nb) },
      { icon: 'download', label: 'Als PDF exportieren', onClick: () => exportNb(nb) },
      { icon: 'file', label: 'In Seiten aufteilen', onClick: async () => { if (await splitDialog([nb])) await reload(); } },
      (nb.kind === 'pdf' || nb.kind === 'onenote') && { icon: 'download', label: 'Speicher verkleinern', onClick: async () => { await shrinkWithProgress([nb]); await reload(); } },
      { sep: true },
      { icon: 'trash', label: 'Löschen', danger: true, onClick: async () => {
        if (!(await confirmDialog('Notiz löschen?', `„${nb.title}“ wird mit allen Seiten endgültig gelöscht.`, 'Löschen', true))) return;
        await store.deleteNotebook(nb);
        await reload();
        toast('Notiz gelöscht');
      } },
    ]);
  }

  async function coverDialog(nb) {
    let color = nb.color;
    const ok = await modal({
      title: 'Cover-Farbe',
      body: seg(COVERS.map(c => [c, '']), color, v => { color = v; }, c => h('i', { class: 'cdot', style: { background: c } }), 'covers'),
      actions: [{ label: 'Abbrechen', value: false }, { label: 'Übernehmen', value: true, primary: true }],
    });
    if (!ok) return;
    nb.color = color;
    await store.put('notebooks', nb);
    render();
  }

  // Zielordner aus dem ganzen Baum wählen; exclude: Ordner (samt Unterordnern), die nicht wählbar sind
  async function pickFolder(title, selected, exclude = []) {
    const tree = [[null, 'Oberste Ebene', 0]];
    const walk = (id, depth) => {
      for (const f of subfolders(id).sort((a, b) => byOrder(a, b) || byName(a, b))) {
        if (exclude.includes(f.id) || isCardFolder(f)) continue; // Karten wandern automatisch in den Karteikarten-Ordner
        tree.push([f.id, f.name, depth]);
        walk(f.id, depth + 1);
      }
    };
    walk(null, 1);
    let target = selected;
    const list = h('div', { class: 'tree' });
    const draw = () => list.replaceChildren(...tree.map(([id, name, d]) =>
      h('button', { type: 'button', class: 'tree-item' + (id === target ? ' on' : ''), style: { paddingLeft: 12 + d * 18 + 'px' }, onclick: () => { target = id; draw(); } },
        icon(id ? 'folder' : 'book'), name)));
    draw();
    const ok = await modal({ title, body: list, actions: [{ label: 'Abbrechen', value: false }, { label: 'Verschieben', value: true, primary: true }] });
    return ok ? { target } : null;
  }

  async function moveDialog(nb) {
    const res = await pickFolder('In Ordner verschieben', nb.folderId || null);
    if (!res) return;
    nb.folderId = res.target;
    await store.put('notebooks', nb);
    await reload(); // eine Karte landet dabei im Karteikarten-Ordner des Zielordners
  }

  async function exportNb(nb) {
    const pr = progress('PDF wird erstellt …');
    try {
      const pages = await store.pagesOf(nb);
      download(await exportPdf(pages, (i, n) => pr.set(`Seite ${i} von ${n}`, i / n)), safeName(nb.title) + '.pdf');
    } catch (err) {
      console.error(err);
      toast('Export fehlgeschlagen: ' + err.message);
    } finally { pr.close(); }
  }

  // ---------- Ordner ----------
  async function newFolder() {
    const name = await promptText('Neuer Ordner', '', 'Name des Ordners');
    if (!name) return;
    const f = { id: uid(), name, parentId: current, createdAt: Date.now() };
    await store.put('folders', f);
    folders.push(f);
    render();
  }

  function folderMenu(f, anchor) {
    if (isCardFolder(f)) {
      menu(anchor, [
        { icon: 'learn', label: 'Diese Karten lernen', onClick: () => { location.hash = 'lernen/' + f.id; } },
        { sep: true },
        { icon: 'trash', label: 'Alle Karten löschen', danger: true, onClick: () => deleteFolder(f) },
      ]);
      return;
    }
    menu(anchor, [
      { icon: 'edit', label: 'Ordner umbenennen', onClick: async () => {
        const name = await promptText('Ordner umbenennen', f.name);
        if (name) { f.name = name; await store.put('folders', f); render(); }
      } },
      { icon: 'folder', label: 'Ordner verschieben', onClick: async () => {
        const res = await pickFolder('Ordner verschieben', parentOf(f), descendants(f.id));
        if (!res) return;
        f.parentId = res.target;
        await store.put('folders', f);
        render();
      } },
      { icon: 'file', label: 'Lange Seiten aufteilen …', onClick: async () => {
        const ids = descendants(f.id); // samt Unterordnern
        if (await splitDialog(notebooks.filter(n => ids.includes(n.folderId)))) await reload();
      } },
      { sep: true },
      { icon: 'trash', label: 'Ordner löschen', danger: true, onClick: () => deleteFolder(f) },
    ]);
  }

  async function deleteFolder(f) {
    const ids = descendants(f.id);
    const notes = notebooks.filter(n => ids.includes(n.folderId));
    const content = notes.length || ids.length > 1;
    const what = [ids.length > 1 ? plural(ids.length - 1, 'Unterordner', 'Unterordner') : '', notes.length ? plural(notes.length, 'Notiz', 'Notizen') : ''].filter(Boolean).join(' und ');
    const choice = isCardFolder(f) // Karteikarten-Ordner: Behalten ergibt keinen Sinn (er gehört zum Fach)
      ? await modal({
        title: 'Karteikarten löschen?',
        body: h('p', { class: 'muted' }, notes.length ? `${plural(notes.length, 'Karteikarte', 'Karteikarten')} werden mit ihrem Lernstand endgültig gelöscht.` : 'Der leere Karteikarten-Ordner wird entfernt.'),
        actions: [{ label: 'Abbrechen', value: null }, { label: 'Löschen', value: 'all', danger: true }],
      })
      : await modal({
        title: 'Ordner löschen?',
        body: h('p', { class: 'muted' }, content
          ? `„${f.name}“ enthält ${what}. Du kannst den Inhalt behalten (er wandert eine Ebene nach oben) oder alles endgültig löschen.`
          : `Der leere Ordner „${f.name}“ wird gelöscht.`),
        actions: content
          ? [{ label: 'Abbrechen', value: null }, { label: 'Inhalt behalten', value: 'keep' }, { label: 'Alles löschen', value: 'all', danger: true }]
          : [{ label: 'Abbrechen', value: null }, { label: 'Löschen', value: 'all', danger: true }],
      });
    if (!choice) return;
    const up = parentOf(f);
    if (choice === 'keep') {
      for (const s of subfolders(f.id)) {
        if (isCardFolder(s)) { // Karten in den Karteikarten-Ordner eine Ebene höher
          const target = await cardFolderFor(up);
          for (const c of cardsIn(s.id)) { c.folderId = target; await store.put('notebooks', c); }
          await store.del('folders', s.id);
        } else { s.parentId = up; await store.put('folders', s); }
      }
      for (const n of notesIn(f.id)) { n.folderId = up; await store.put('notebooks', n); }
      await store.del('folders', f.id);
    } else {
      const pr = notes.length > 5 ? progress('Wird gelöscht …') : null;
      for (let i = 0; i < notes.length; i++) { pr?.set(notes[i].title, i / notes.length); await deleteCard(notes[i]); }
      for (const id of ids) await store.del('folders', id);
      pr?.close();
    }
    if (ids.includes(current)) current = up;
    await reload();
    toast('Ordner gelöscht');
  }

  // ---------- Import ----------
  function importMenu(anchor) {
    menu(anchor, [
      { icon: 'download', label: 'OneNote vom PC holen …', onClick: pcImportDialog },
      { icon: 'file', label: 'PDF importieren', onClick: () => pickFiles('application/pdf,.pdf', true).then(fs => runImport(fs, current)) },
      { sep: true },
      { icon: 'upload', label: 'Backup wiederherstellen …', onClick: restoreBackup },
    ]);
  }

  // ---------- OneNote vom PC (konvertiert von onenote-export.bat, über den lokalen Server) ----------
  // Notizbuch → Ordner, Fach (Abschnitt) → Unterordner, jede OneNote-Seite → eigene Notiz
  const isOldImport = n => n.kind === 'onenote' && (n.source || '').startsWith('onenote:'); // erste Version: Abschnitt = Notizbuch

  async function pcImportDialog() {
    let index;
    try { index = await loadIndex(); } catch (err) { toast(err.message); return; }
    if (!index) {
      const online = location.protocol === 'https:'; // App läuft im Internet, nicht vom PC
      await modal({
        title: 'OneNote vom PC holen',
        body: h('div', { class: 'help' }, online
          ? [h('p', {}, 'Den OneNote-Export holt die App direkt von deinem PC – das klappt nur am PC selbst, und dort muss der Notizen-Server laufen (start.bat).'),
             h('p', {}, 'Nach dem Import und Abgleich kommen die Notizen automatisch auf deine anderen Geräte.')]
          : [h('p', {}, 'Auf dem PC wurde noch kein OneNote-Export gefunden.'),
             h('p', {}, 'Am PC muss einmal der OneNote-Export laufen (onenote-export.bat). Danach hier nochmal „OneNote vom PC holen“ wählen.')]),
      });
      return;
    }
    const known = new Set(notebooks.map(n => n.source).filter(Boolean));
    const isNew = p => !known.has('onenote-page:' + p.id);
    const pagesOf = n => n.sections.flatMap(s => s.pages);
    const old = notebooks.filter(isOldImport);
    let replace = old.length > 0;
    const chosen = new Set(index.notebooks.filter(n => pagesOf(n).some(isNew)).map(n => n.name));
    const rows = index.notebooks.map(n => {
      const all = pagesOf(n), fresh = all.filter(isNew).length;
      const status = fresh === all.length ? '' : fresh ? ` · ${fresh} neu` : ' · schon importiert';
      return h('label', { class: 'pick' },
        h('input', { type: 'checkbox', checked: chosen.has(n.name), disabled: !fresh, onchange: e => (e.target.checked ? chosen.add(n.name) : chosen.delete(n.name)) }),
        h('span', { class: 'grow' },
          h('b', {}, clean(n.name)),
          h('span', { class: 'muted small' }, `${plural(n.sections.length, 'Fach', 'Fächer')} · ${plural(all.length, 'Notiz', 'Notizen')}${status}`)));
    });
    const ok = await modal({
      title: 'OneNote vom PC holen',
      body: h('div', { class: 'help' },
        h('p', {}, 'Jedes Notizbuch wird ein Ordner, jedes Fach (Abschnitt) ein Unterordner und jede OneNote-Seite eine eigene Notiz.'),
        h('div', { class: 'picks' }, rows,
          old.length ? h('label', { class: 'pick' },
            h('input', { type: 'checkbox', checked: true, onchange: e => { replace = e.target.checked; } }),
            h('span', { class: 'grow' },
              h('b', {}, 'Bisherigen OneNote-Import ersetzen'),
              h('span', { class: 'muted small' }, `Die ${old.length} zusammengefassten Notizbücher vom ersten Import werden gelöscht. Was du darin geändert hast, geht verloren.`))) : null),
        h('p', { class: 'muted small' }, `Export vom ${new Date(index.exportedAt).toLocaleString('de-DE')}. Das iPad während des Imports bitte nicht sperren.`)),
      actions: [{ label: 'Abbrechen', value: false }, { label: 'Importieren', value: true, primary: true }],
    });
    if (!ok || (!chosen.size && !replace)) return;
    if (replace && old.length) await removeOldImport(old);

    const jobs = [];
    for (const n of index.notebooks) {
      if (!chosen.has(n.name)) continue;
      n.sections.forEach((s, si) => s.pages.forEach((p, pi) => { if (isNew(p)) jobs.push({ n, s, si, p, pi }); }));
    }
    if (jobs.length) await runPcImport(jobs);
    else await reload();
  }

  async function removeOldImport(old) {
    const pr = progress('Bisheriger Import wird entfernt …');
    for (let i = 0; i < old.length; i++) { pr.set(old[i].title, i / old.length); await store.deleteNotebook(old[i]); }
    // Ordner der ersten Version (Quelle "onenote:<Notizbuch>"); eigene Notizen darin wandern nach oben
    const gone = new Set(old.map(n => n.id));
    for (const f of folders.filter(x => (x.source || '').startsWith('onenote:'))) {
      for (const n of notebooks.filter(x => x.folderId === f.id && !gone.has(x.id))) { n.folderId = null; await store.put('notebooks', n); }
      await store.del('folders', f.id);
    }
    pr.close();
    [folders, notebooks] = await Promise.all([store.getAll('folders'), store.getAll('notebooks')]);
  }

  async function runPcImport(jobs) {
    const pr = progress('OneNote wird importiert …');
    const cache = {};
    async function ensureFolder(key, name, parentId, extra = {}) {
      if (cache[key]) return cache[key];
      let f = folders.find(x => x.source === key);
      if (!f) {
        f = { id: 'of' + hid(key), name: clean(name) || 'Ohne Namen', parentId, source: key, createdAt: Date.now(), ...extra };
        await store.put('folders', f);
        folders.push(f);
      }
      return (cache[key] = f);
    }
    let done = 0, ok = 0;
    const tops = new Set();
    for (const { n, s, si, p, pi } of jobs) {
      try {
        const top = await ensureFolder('onenote-nb:' + n.name, n.name, null, { color: n.color });
        tops.add(top.id);
        const groups = [].concat(s.groups || []);
        let parent = top;
        for (let g = 0; g < groups.length; g++) parent = await ensureFolder(`onenote-grp:${n.name}/${groups.slice(0, g + 1).join('/')}`, groups[g], parent.id);
        const sec = await ensureFolder(`onenote-sec:${n.name}/${[...groups, s.name].join('/')}`, s.name, parent.id, { order: si, color: s.color });
        pr.set(`${clean(s.name)} › ${clean(p.title) || 'Ohne Titel'}  (${done + 1} von ${jobs.length})`, done / jobs.length);
        await importPage(p, { folderId: sec.id, order: pi });
        ok++;
      } catch (err) {
        console.error(err);
        toast(`Fehler bei „${clean(p.title) || s.name}“: ${err.message}`);
      }
      done++;
    }
    pr.close();
    if (tops.size === 1) current = [...tops][0];
    else if (tops.size > 1) current = null;
    try { current ? localStorage.setItem(FOLDER_KEY, current) : localStorage.removeItem(FOLDER_KEY); } catch { /* egal */ }
    await reload();
    toast(ok === jobs.length ? `${plural(ok, 'Notiz', 'Notizen')} importiert` : `${ok} von ${jobs.length} Notizen importiert`);
  }

  async function runImport(files, folderId) {
    if (!files?.length) return;
    const pr = progress('Importiere …');
    let ok = 0;
    for (const f of files) {
      try {
        await importPdf(f, { folderId, onProgress: (i, n) => pr.set(`${f.name} – Seite ${i} von ${n}`, i / n) });
        ok++;
      } catch (err) {
        console.error(err);
        toast(`Fehler bei ${f.name}: ${err.message}`);
      }
    }
    pr.close();
    await reload();
    if (ok) toast(ok === 1 ? 'Import abgeschlossen' : `${ok} PDFs importiert`);
  }

  // ---------- Backup ----------
  function restoreBackup() {
    pickFiles('application/json,.json').then(async ([f]) => {
      if (!f) return;
      const pr = progress('Backup wird eingelesen …');
      try { toast(`${await importBackup(f)} Notizen wiederhergestellt`); }
      catch (err) { console.error(err); toast('Fehler: ' + err.message); }
      finally { pr.close(); }
      await reload();
    });
  }

  function libMenu(anchor) {
    menu(anchor, [
      { icon: 'sync', label: 'Synchronisieren …', onClick: () => syncDialog(reload) },
      { icon: 'sparkle', label: 'Claude (MCP) …', onClick: () => claudeDialog(reload) },
      { icon: 'upload', label: 'PDFs aus Safari …', onClick: () => inboxDialog(reload) },
      { icon: 'file', label: 'Speicher …', onClick: () => storageDialog(reload) },
      { sep: true },
      { icon: 'download', label: 'Backup exportieren', onClick: async () => {
        const pr = progress('Backup wird erstellt …');
        try { download(await exportBackup(), `notizen-backup-${new Date().toISOString().slice(0, 10)}.json`); }
        catch (err) { console.error(err); toast('Fehler: ' + err.message); }
        finally { pr.close(); }
      } },
      { icon: 'upload', label: 'Backup wiederherstellen …', onClick: restoreBackup },
      { sep: true },
      { header: 'Version vom ' + versionLabel() },
      { icon: 'help', label: 'Über diese App', onClick: () => modal({
        title: 'Notizen',
        body: h('div', { class: 'help' },
          h('p', {}, 'Deine Notizen werden lokal auf diesem Gerät gespeichert.'),
          h('p', {}, 'Um Notizen auf ein anderes Gerät zu bringen: ', h('b', {}, 'Backup exportieren'), ' und dort ', h('b', {}, 'wiederherstellen'), '.'),
          h('p', { class: 'muted small' }, 'Tipp fürs iPad: In Safari „Teilen → Zum Home-Bildschirm“ – dann startet die App im Vollbild.')),
      }) },
    ]);
  }

  active = { reload, render };
  await reload();
  // PDFs aus dem Teilen-Menü (Kurzbefehl) abholen: gleich, beim Zurückholen der App und jede Minute
  const pollInbox = () => {
    if (document.visibilityState === 'visible') checkInbox().then(n => { if (n && active?.reload === reload) reload(); });
  };
  pollInbox();
  const inboxT = setInterval(pollInbox, 60000);
  document.addEventListener('visibilitychange', pollInbox);
  return () => {
    clearInterval(inboxT);
    document.removeEventListener('visibilitychange', pollInbox);
    if (active?.reload === reload) active = null;
  };
}

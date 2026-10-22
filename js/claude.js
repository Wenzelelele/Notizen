// Claude-Anbindung (MCP). Claude greift über den MCP-Server (supabase/functions/notizen-mcp) auf die
// Cloud-Daten zu – angemeldet mit dem Notizen-Konto. Hier die Teile in der App:
// - Zustimmungsseite für diese Anmeldung (Supabase leitet auf index.html?authorization_id=… um)
// - „Für Claude markieren“: Ausschnitt einer Seite als Bild nach claude/marked/ im Cloud-Speicher
// - Seitenbilder previews/<seite>/ (nur wenn eingeschaltet), damit Claude auch Handschrift sieht
// - Vorschaubilder für Karten, die Claude angelegt oder geändert hat
// - Dialog „Claude (MCP)“ in der Bibliothek
import { store, uid, changes } from './store.js';
import { h, icon, modal, toast, progress, field } from './ui.js';
import { CLOUD } from './config.js';
import { cloudConfigured, currentUser, accessToken, userFiles } from './cloud.js';
import { renderPage, snapshot, isCard, updateThumb } from './cards.js';
import { strokeBBox } from './ink.js';
import { syncEvents, syncDialog } from './sync.js';

export const MCP_URL = CLOUD.url ? CLOUD.url.replace(/\/+$/, '') + '/functions/v1/notizen-mcp' : '';
const SETTINGS_KEY = 'notizen.claude';
// Bilder für Claude: höchstens ~95 KB, weil claude.ai Werkzeug-Antworten bis ca. 150.000 Zeichen annimmt (Base64)
const MAX_BYTES = 95000;
const TILE_W = 1100, TILE_H = 1600, MAX_TILES = 80;
const MARK_DAYS = 30; // Markierungen danach automatisch löschen

const loggedIn = () => cloudConfigured() && !!currentUser();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = v => Math.round(v * 10) / 10;
const fmt = ts => new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function settings() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } }
function setSetting(k, v) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings(), [k]: v })); } catch { /* egal */ } }
const previewsOn = () => !!settings().previews;

// Canvas als JPEG unter maxBytes: erst Qualität senken, dann verkleinern
async function jpegUnder(canvas, maxBytes) {
  let c = canvas, blob = null;
  for (let round = 0; round < 5; round++) {
    for (const q of [0.78, 0.66, 0.55, 0.45]) {
      blob = await new Promise(res => c.toBlob(res, 'image/jpeg', q));
      if (blob && blob.size <= maxBytes) break;
    }
    if (blob && blob.size <= maxBytes) break;
    const s = document.createElement('canvas');
    s.width = Math.max(1, Math.round(c.width * 0.8));
    s.height = Math.max(1, Math.round(c.height * 0.8));
    s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
    if (c !== canvas) c.width = c.height = 0;
    c = s;
  }
  if (c !== canvas) c.width = c.height = 0;
  return blob;
}
const jsonBlob = o => new Blob([JSON.stringify(o)], { type: 'application/json' });

// ---------- Für Claude markieren (Rahmen-Werkzeug im Editor) ----------
const IDEAS = ['Erklär mir diese Aufgabe Schritt für Schritt', 'Prüf meine Lösung', 'Mach Karteikarten daraus'];

export async function markForClaude({ nb, page, region, loaded }) {
  if (!loggedIn()) {
    toast(cloudConfigured() ? 'Dafür zuerst unter ⋯ → Synchronisieren anmelden.' : 'Dafür braucht die App den Cloud-Sync.');
    return;
  }
  const note = h('textarea', { class: 'input', rows: 3, placeholder: 'z. B. Aufgabe 2b erklären', 'aria-label': 'Bemerkung für Claude' });
  const comment = await modal({
    title: 'Für Claude markieren',
    body: h('div', { class: 'form' },
      h('p', { class: 'muted small' }, 'Claude sieht diesen Ausschnitt, wenn du ihn in der Claude-App danach fragst (Connector „Notizen“).'),
      field('Was soll Claude damit machen? (optional)', note),
      h('div', { class: 'segc' }, IDEAS.map(t => h('button', { type: 'button', onclick: () => { note.value = t; note.focus(); } }, t)))),
    actions: [{ label: 'Abbrechen', value: null }, { label: 'Markieren', primary: true, value: () => note.value.trim() }],
    onOpen: () => note.focus(),
  });
  if (comment == null) return;
  if (!navigator.onLine) { toast('Dafür musst du online sein.'); return; }
  const pr = progress('Wird für Claude markiert …');
  try {
    const id = uid(), dir = 'claude/marked/';
    const c = await renderPage(page, { scale: Math.min(2, 1400 / Math.max(region.w, region.h)), region, loaded });
    const small = await jpegUnder(c, MAX_BYTES);
    c.width = c.height = 0;
    const full = await snapshot(page, region, loaded); // bessere Qualität, falls Claude daraus Karten mit Bild macht
    await userFiles.put(dir + id + '.jpg', small, 'image/jpeg');
    await userFiles.put(dir + id + '.full.jpg', full.blob, 'image/jpeg');
    await userFiles.put(dir + id + '.json', jsonBlob({
      id, at: Date.now(), noteId: nb.id, noteTitle: nb.title, folderId: nb.folderId || null,
      pageId: page.id, pageIndex: nb.pageIds.indexOf(page.id) + 1,
      region: { x: r1(region.x), y: r1(region.y), w: r1(region.w), h: r1(region.h) }, comment,
    }), 'application/json');
    pr.close();
    cleanupMarked().catch(() => {});
    await modal({
      title: 'Für Claude markiert',
      body: h('div', { class: 'help' },
        h('p', {}, 'Öffne jetzt Claude und schreib z. B.:'),
        h('p', {}, h('b', {}, comment ? `„Schau dir meine Markierung in Notizen an“` : `„${IDEAS[0]} – meine Markierung in Notizen“`)),
        h('p', { class: 'muted small' }, 'Im Chat muss der Connector „Notizen“ eingeschaltet sein (Knopf „+“ bzw. Werkzeuge).')),
    });
  } catch (err) {
    console.error(err);
    toast(/fetch|network/i.test(err.message) ? 'Keine Verbindung zum Cloud-Speicher – bist du online?' : 'Markieren fehlgeschlagen: ' + err.message);
  } finally { pr.close(); }
}

async function markedList() {
  const files = await userFiles.list('claude/marked');
  return files.filter(f => f.name.endsWith('.json')).map(f => ({ id: f.name.slice(0, -5), at: Date.parse(f.created_at) || 0 })).sort((a, b) => b.at - a.at);
}
async function deleteMarked(id) {
  for (const ext of ['.json', '.jpg', '.full.jpg']) await userFiles.del(`claude/marked/${id}${ext}`);
}
async function cleanupMarked() {
  const old = Date.now() - MARK_DAYS * 864e5;
  for (const m of await markedList()) if (m.at && m.at < old) await deleteMarked(m.id);
}

// ---------- Seitenbilder für Claude ----------
// Jede Seite wird in Kacheln von höchstens ~1100 × 1600 Pixeln gerendert (leere Kacheln entfallen).
// previews/<seite>/<stand>.json beschreibt die Kacheln <stand>_<n>.jpg; <stand> = updatedAt der Seite.
// Dateien werden nie überschrieben (neuer Stand = neue Namen), alte Stände danach gelöscht.
export function tileGrid(page) {
  const scale = Math.min(1.5, Math.max(0.55, TILE_W / page.w));
  const cols = Math.max(1, Math.ceil((page.w * scale) / TILE_W - 0.05));
  const rows = Math.max(1, Math.ceil((page.h * scale) / TILE_H - 0.05));
  const cw = page.w / cols, rh = page.h / rows, tiles = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) tiles.push({ x: c * cw, y: r * rh, w: cw, h: rh });
  return { scale, tiles };
}
function hasContent(page, t) {
  if (page.bg) return true;
  const hit = (x, y, w, h) => x < t.x + t.w && x + w > t.x && y < t.y + t.h && y + h > t.y;
  for (const im of page.images || []) if (hit(im.x, im.y, im.w, im.h)) return true;
  for (const tx of page.texts || []) if (tx.text?.trim() && hit(tx.x, tx.y, tx.w, tx.size * 1.3 * (tx.text.split('\n').length + tx.text.length / 40))) return true;
  for (const s of page.strokes || []) { const b = strokeBBox(s); if (hit(b.x, b.y, b.w, b.h)) return true; }
  return false;
}

const Q = { ids: new Set(), done: {}, running: false, made: 0, error: '', ready: null };
export const claudeEvents = new EventTarget();
const emit = () => claudeEvents.dispatchEvent(new Event('status'));
let saveT;
function saveQueue() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { store.setMeta('claudeQueue', [...Q.ids]).catch(() => {}); store.setMeta('claudeDone', Q.done).catch(() => {}); }, 800);
}
const loadQueue = () => (Q.ready ??= (async () => {
  const [ids, done] = await Promise.all([store.getMeta('claudeQueue'), store.getMeta('claudeDone')]);
  for (const id of ids || []) Q.ids.add(id);
  Q.done = { ...(done || {}), ...Q.done };
})());

async function renderPreview(id, page) {
  const dir = `previews/${id}`;
  if (!page) { // Seite gelöscht → ihre Bilder auch
    for (const f of await userFiles.list(dir)) await userFiles.del(`${dir}/${f.name}`);
    delete Q.done[id];
    return;
  }
  const at = page.updatedAt || 0;
  if (Q.done[id] === at) return;
  const files = await userFiles.list(dir);
  if (!files.some(f => f.name === `${at}.json`)) { // sonst schon da, z. B. von einem anderen Gerät
    const { scale, tiles } = tileGrid(page);
    const keep = [];
    let truncated = false;
    for (const t of tiles) {
      // Notiz geöffnet oder App im Hintergrund: sofort aufhören (eine große Seite hat bis zu 80 Teile) – später weiter
      if (busyRoute() || document.visibilityState !== 'visible') throw Object.assign(new Error('pausiert'), { pause: true });
      if (!hasContent(page, t)) continue;
      if (keep.length >= MAX_TILES) { truncated = true; break; }
      const c = await renderPage(page, { scale, region: t });
      const blob = await jpegUnder(c, MAX_BYTES);
      c.width = c.height = 0;
      const file = `${at}_${keep.length}.jpg`;
      await userFiles.put(`${dir}/${file}`, blob, 'image/jpeg');
      keep.push({ i: keep.length, x: r1(t.x), y: r1(t.y), w: r1(t.w), h: r1(t.h), file });
      await sleep(30);
    }
    await userFiles.put(`${dir}/${at}.json`, jsonBlob({ at, w: page.w, h: page.h, scale, tiles: keep, truncated }), 'application/json');
    for (const f of files) if (!f.name.startsWith(at + '_') && f.name !== at + '.json') await userFiles.del(`${dir}/${f.name}`);
  }
  Q.done[id] = at;
}

// Im Editor/Lernmodus nicht rendern (sonst ruckelt das Schreiben) – dort geht es danach weiter
const busyRoute = () => /^#(nb|abdecken|lernen)/.test(location.hash);
const offlineError = err => /fetch|network|load failed|verbindung|anmeld|abgelaufen|\b40[13]\b/i.test(err?.message || '');

async function work() {
  if (Q.running || !previewsOn() || !loggedIn() || !navigator.onLine) return;
  await loadQueue();
  if (!Q.ids.size) return;
  Q.running = true;
  emit();
  try {
    for (const id of [...Q.ids]) {
      if (!previewsOn() || busyRoute() || document.visibilityState !== 'visible' || !navigator.onLine) break;
      const page = await store.get('pages', id);
      if (page && Date.now() - (page.updatedAt || 0) < 15000) continue; // wird gerade bearbeitet
      try {
        await renderPreview(id, page);
        Q.made++;
        Q.error = '';
      } catch (err) {
        if (err.pause) break; // bleibt in der Warteschlange
        console.warn('Seitenbild', id, err);
        Q.error = err.message;
        if (offlineError(err)) break; // später nochmal
      }
      Q.ids.delete(id);
      saveQueue();
      emit();
      await sleep(100);
    }
  } finally {
    Q.running = false;
    emit();
  }
}

async function enqueueAll() {
  await loadQueue();
  const nbs = (await store.getAll('notebooks')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const nb of nbs) for (const id of nb.pageIds || []) Q.ids.add(id);
  saveQueue();
  emit();
  work();
}

// ---------- Vorschaubilder für Karten, die Claude angelegt/geändert hat ----------
const thumbQ = new Map();
let thumbT;
function queueThumb(kind, id) {
  thumbQ.set(kind + ':' + id, { kind, id });
  clearTimeout(thumbT);
  thumbT = setTimeout(runThumbs, 1500);
}
async function runThumbs() {
  const jobs = [...thumbQ.values()];
  thumbQ.clear();
  const done = new Set();
  for (const { kind, id } of jobs) {
    try {
      let nb, force = false;
      if (kind === 'notebooks') nb = await store.get('notebooks', id);
      else { const p = await store.get('pages', id); nb = p && (await store.get('notebooks', p.notebookId)); force = true; }
      if (!nb || !isCard(nb) || nb.occl || done.has(nb.id) || (!force && nb.thumb)) continue;
      const pages = await store.pagesOf(nb);
      if (pages.length < nb.pageIds.length) continue; // Seiten kommen noch
      done.add(nb.id);
      await updateThumb(nb);
    } catch (err) { console.warn('Kartenvorschau', err); }
  }
  if (done.size) syncEvents.dispatchEvent(new Event('received')); // Bibliothek neu zeichnen
}

let started = false;
export async function startClaude() {
  if (started) return;
  started = true;
  changes.addEventListener('change', e => {
    const { kind, id, remote } = e.detail;
    if (remote && (kind === 'notebooks' || kind === 'pages')) queueThumb(kind, id);
    if (kind === 'pages' && previewsOn() && !Q.ids.has(id)) { Q.ids.add(id); saveQueue(); }
  });
  await loadQueue();
  // Karten ohne Vorschaubild (z. B. von Claude angelegt, bevor diese Version lief)
  for (const nb of await store.getAll('notebooks')) if (isCard(nb) && !nb.occl && !nb.thumb) queueThumb('notebooks', nb.id);
  syncEvents.addEventListener('status', () => setTimeout(work, 500));
  addEventListener('hashchange', () => setTimeout(work, 1500));
  addEventListener('online', () => setTimeout(work, 1500));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(work, 1500); });
  setInterval(work, 30000);
  setTimeout(work, 4000);
}

// ---------- Dialog in der Bibliothek ----------
export async function claudeDialog(onDone) {
  if (!cloudConfigured()) {
    await modal({ title: 'Claude (MCP)', body: h('p', { class: 'muted' }, 'Claude greift über den Cloud-Sync auf deine Notizen zu – dafür muss in js/config.js ein Supabase-Projekt eingetragen sein.') });
    return;
  }
  if (!currentUser()) {
    const go = await modal({
      title: 'Claude (MCP)',
      body: h('p', { class: 'muted' }, 'Claude greift über den Cloud-Sync auf deine Notizen zu. Melde dich zuerst an.'),
      actions: [{ label: 'Abbrechen', value: false }, { label: 'Anmelden …', value: true, primary: true }],
    });
    if (go) await syncDialog(onDone);
    return;
  }
  await loadQueue();
  const nbs = await store.getAll('notebooks');
  const total = nbs.reduce((n, nb) => n + (nb.pageIds?.length || 0), 0);
  const url = h('input', { class: 'input', value: MCP_URL, readonly: true, 'aria-label': 'Adresse für Claude', onfocus: e => e.target.select() });
  const copy = async () => {
    try { await navigator.clipboard.writeText(MCP_URL); toast('Adresse kopiert'); }
    catch { url.focus(); url.select(); toast('Markiert – jetzt kopieren'); }
  };
  const status = h('div', { class: 'muted small' });
  const prepBtn = h('button', { class: 'btn block', type: 'button', onclick: () => { enqueueAll(); toast('Fehlende Seitenbilder werden im Hintergrund erstellt.'); } }, 'Fehlende Seitenbilder jetzt erstellen');
  const drawStatus = () => {
    const ready = Object.keys(Q.done).length;
    status.textContent = !previewsOn() ? 'Aus – Claude sieht dann nur getippten Text und markierte Bereiche.'
      : `${Math.min(ready, total)} von ${total} Seiten bereit` + (Q.ids.size ? ` · ${Q.ids.size} in der Warteschlange${Q.running ? ' (läuft)' : ''}` : '') + (Q.error ? ` · Fehler: ${Q.error}` : '');
    prepBtn.disabled = !previewsOn();
  };
  // Einschalten = gleich alle vorhandenen Seiten vormerken (schon fertige werden übersprungen)
  const toggle = h('input', { type: 'checkbox', checked: previewsOn(), onchange: e => { setSetting('previews', e.target.checked); drawStatus(); if (e.target.checked) enqueueAll(); } });
  const marks = h('div', { class: 'muted small' }, 'Markierungen werden geladen …');
  const onStatus = () => drawStatus();
  claudeEvents.addEventListener('status', onStatus);
  drawStatus();
  const loadMarks = async () => {
    try {
      const list = await markedList();
      marks.replaceChildren(list.length
        ? h('span', {}, `${list.length} ${list.length === 1 ? 'Markierung' : 'Markierungen'} (neueste vom ${fmt(list[0].at)}) – werden nach ${MARK_DAYS} Tagen gelöscht. `,
          h('button', { class: 'linkbtn', type: 'button', onclick: async () => {
            marks.textContent = 'Wird gelöscht …';
            for (const m of list) await deleteMarked(m.id).catch(() => {});
            loadMarks();
          } }, 'Jetzt alle löschen'))
        : 'Noch keine Markierungen. Im Editor: Rahmen-Werkzeug → Bereich aufziehen → „Für Claude markieren“.');
    } catch (err) { marks.textContent = 'Markierungen: ' + err.message; }
  };
  loadMarks();
  await modal({
    title: 'Claude (MCP)',
    body: h('div', { class: 'help' },
      h('p', {}, 'Mit deinem Claude-Abo (z. B. Pro) kann Claude auf deine Notizen zugreifen: markierte Aufgaben erklären, Karteikarten anlegen und verbessern. Löschen kann Claude nichts.'),
      field('Adresse für den Connector in Claude', h('div', { class: 'copyrow' }, url, h('button', { class: 'btn', type: 'button', onclick: copy }, icon('copy'), 'Kopieren'))),
      h('ol', { class: 'small' },
        h('li', {}, 'Am besten am PC auf claude.ai: Einstellungen → Connectors → „Benutzerdefinierten Connector hinzufügen“, Name „Notizen“, diese Adresse einfügen.'),
        h('li', {}, '„Verbinden“ → hier mit deinem Notizen-Konto anmelden und „Erlauben“ tippen.'),
        h('li', {}, 'Danach in jedem Chat – auch in der Claude-App auf dem iPad – den Connector „Notizen“ einschalten.')),
      h('label', { class: 'pick' }, toggle,
        h('span', { class: 'grow' }, h('b', {}, 'Seitenbilder für Claude hochladen'),
          h('span', { class: 'muted small' }, 'Damit Claude Handschrift und Folien lesen kann. Braucht Platz im Cloud-Speicher (etwa 50–100 KB je Seitenteil).'))),
      status, prepBtn,
      h('p', { class: 'small', style: { marginTop: '14px' } }, h('b', {}, 'Markierte Bereiche: '), marks)),
  });
  claudeEvents.removeEventListener('status', onStatus);
}

// ---------- Zustimmungsseite (OAuth 2.1 von Supabase Auth) ----------
// Supabase schickt den Browser hierher (Site URL + Authorization Path, mit ?authorization_id=…), wenn Claude
// sich verbinden will. Anmelden, Anfrage anzeigen, erlauben → zurück zu Claude.
export function showConsent(root, authorizationId) {
  document.title = 'Claude verbinden – Notizen';
  const box = h('div', { class: 'modal consent' });
  root.replaceChildren(h('div', { class: 'consent-page' }, box));
  let token = null;
  const base = CLOUD.url.replace(/\/+$/, '') + '/auth/v1';
  const call = (path, opt = {}) => fetch(base + path, {
    ...opt,
    headers: { apikey: CLOUD.key, 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  });
  const show = (...kids) => box.replaceChildren(h('h2', {}, 'Claude mit Notizen verbinden'), ...kids);
  const fail = (msg, detail) => show(h('p', {}, msg), h('p', { class: 'muted small' }, 'Starte die Verbindung in Claude einfach nochmal (Connector „Notizen“ → Verbinden).'),
    detail ? h('p', { class: 'muted small' }, 'Antwort des Servers: ' + detail) : null);
  const busy = text => show(h('p', { class: 'muted' }, text));

  function login(msg) {
    const email = h('input', { class: 'input', type: 'email', autocomplete: 'username', placeholder: 'name@beispiel.de', 'aria-label': 'E-Mail' });
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Passwort' });
    const err = h('p', { class: 'danger-text small' }, msg || '');
    const go = async e => {
      e.preventDefault();
      if (!email.value.trim() || !pw.value) { err.textContent = 'Bitte E-Mail und Passwort eingeben.'; return; }
      busy('Anmelden …');
      try {
        const r = await call('/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: email.value.trim(), password: pw.value }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.access_token) return login(r.status === 400 ? 'E-Mail oder Passwort stimmt nicht.' : j.msg || `Anmeldung fehlgeschlagen (${r.status}).`);
        token = j.access_token; // nur für diese Seite – wird nicht gespeichert
        details();
      } catch { login('Keine Verbindung – bist du online?'); }
    };
    show(h('form', { class: 'form', onsubmit: go },
      h('p', { class: 'muted small' }, 'Melde dich mit deinem Notizen-Konto an (dasselbe wie für den Cloud-Sync).'),
      field('E-Mail', email), field('Passwort', pw), err,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Anmelden'))));
    email.focus();
  }

  async function details() {
    busy('Anfrage wird geladen …');
    let r, j;
    try {
      r = await call('/oauth/authorizations/' + encodeURIComponent(authorizationId));
      j = await r.json().catch(() => ({}));
    } catch { return fail('Keine Verbindung – bist du online?'); }
    if (r.status === 401 || r.status === 403) { token = null; return login('Bitte melde dich an.'); }
    if (!r.ok) return fail('Diese Anfrage gibt es nicht (mehr) – sie ist vermutlich abgelaufen.', `${r.status} ${j.msg || j.message || j.error_description || ''}`.trim());
    if (j.redirect_url && !j.authorization_id) { busy('Schon erlaubt – zurück zu Claude …'); location.replace(j.redirect_url); return; }
    let host = '';
    try { host = new URL(j.redirect_uri).host; } catch { host = j.redirect_uri || '?'; }
    const name = j.client?.name || 'Eine App';
    show(
      h('p', {}, h('b', {}, name), ' möchte auf deine Notizen zugreifen.'),
      h('ul', { class: 'small' },
        h('li', {}, 'Ordner, Notizen, Karteikarten und markierte Bereiche lesen'),
        h('li', {}, 'Karteikarten anlegen und verbessern, Seiten mit Erklärungen einfügen'),
        h('li', {}, 'Nichts löschen')),
      h('p', { class: 'muted small' }, 'Konto: ', h('b', {}, j.user?.email || '?'), h('br'), 'Danach geht es weiter zu: ', h('b', {}, host),
        host !== 'claude.ai' ? h('span', { class: 'danger-text' }, ' – das ist nicht claude.ai! Nur erlauben, wenn du diese Verbindung selbst gestartet hast.') : null),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: () => decide('deny') }, 'Ablehnen'),
        h('button', { class: 'btn primary', onclick: () => decide('approve') }, 'Erlauben')));
  }

  async function decide(action) {
    busy(action === 'approve' ? 'Wird erlaubt …' : 'Wird abgelehnt …');
    try {
      const r = await call(`/oauth/authorizations/${encodeURIComponent(authorizationId)}/consent`, { method: 'POST', body: JSON.stringify({ action }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.redirect_url) return fail('Das hat nicht geklappt.', `${r.status} ${j.msg || j.message || ''}`.trim());
      busy(action === 'approve' ? 'Erlaubt – zurück zu Claude …' : 'Abgelehnt.');
      location.replace(j.redirect_url);
    } catch { fail('Keine Verbindung – bist du online?'); }
  }

  (async () => {
    if (currentUser()) { try { token = await accessToken(); } catch { token = null; } }
    if (token) details(); else login();
  })();
}

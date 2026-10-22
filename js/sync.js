// Abgleich zwischen Geräten über einen Sync-Speicher.
// Ablauf: 1) eigene Änderungen (Outbox) hochladen  2) Änderungen anderer Geräte holen und einspielen.
// Konflikte: pro Datensatz gewinnt die jüngere Änderung (Zeitstempel).
// Speicher-"Adapter": Cloud (Supabase, cloud.js) – oder ohne Cloud-Konfiguration der PC-Server (httpAdapter).
import { store, uid } from './store.js';
import { h, modal, toast, progress, field } from './ui.js';
import { cloudConfigured, cloudAdapter, currentUser, signIn, signUp, signOut } from './cloud.js';

// ---------- Sync-Speicher auf dem PC (server.js) ----------
export function httpAdapter(base, key) {
  const call = async (path, opt = {}) => {
    const r = await fetch(base + path, { ...opt, cache: 'no-store', headers: { 'X-Sync-Key': key, ...(opt.headers || {}) } });
    if (r.status === 401) throw new Error('Der Sync-Code stimmt nicht.');
    if (!r.ok) throw new Error(`Sync-Speicher antwortet nicht richtig (${r.status}).`);
    return r;
  };
  return {
    target: () => 'pc:' + (base || location.host),
    info: async () => (await call('/api/sync/info')).json(),
    push: async (device, changes) => (await call('/api/sync/push', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, changes }),
    })).json(),
    pull: async since => (await call('/api/sync/pull?since=' + since)).json(),
    putBlob: async (k, blob) => { await call('/api/sync/blob/' + encodeURIComponent(k), { method: 'PUT', body: blob }); },
    getBlob: async k => (await call('/api/sync/blob/' + encodeURIComponent(k))).blob(),
  };
}

export async function deviceId() {
  let d = await store.getMeta('deviceId');
  if (!d) { d = uid(); await store.setMeta('deviceId', d); }
  return d;
}

// n Aufgaben gleichzeitig (Bilder hoch-/herunterladen)
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

// ---------- Abgleich ----------
let running = null;
export async function syncNow(adapter, onProgress = () => {}) {
  while (running) await running.catch(() => {}); // nie zwei Abgleiche gleichzeitig
  running = doSync(adapter, onProgress);
  try { return await running; } finally { running = null; }
}

async function doSync(adapter, onProgress) {
  const device = await deviceId();
  // neues Ziel (z. B. erstmals Cloud oder anderes Konto): Stand zurücksetzen und alles hochladen
  const target = adapter.target();
  if ((await store.getMeta('syncTarget')) !== target) {
    await store.setMeta('syncTarget', target);
    await store.setMeta('cursor', 0);
    await store.setMeta('initialQueued', false);
  }
  if (!(await store.getMeta('initialQueued'))) { await store.queueAll(); await store.setMeta('initialQueued', true); }

  // 1) Hochladen: erst Bilder (damit Seiten nie auf fehlende Bilder zeigen), dann Datensätze in Paketen
  const box = await store.outboxAll();
  const blobs = box.filter(e => e.kind === 'blobs'), recs = box.filter(e => e.kind !== 'blobs');
  let done = 0;
  await pool(blobs.filter(e => e.op === 'put'), 4, async e => {
    const b = await store.getBlob(e.id);
    if (b) await adapter.putBlob(e.id, b);
    onProgress(`Hochladen: Bild ${++done} von ${blobs.length}`, done / Math.max(1, box.length));
  });
  let batch = [], size = 0, n = 0;
  const flush = async () => {
    if (!batch.length) return;
    await adapter.push(device, batch.map(x => x.change));
    await store.outboxDone(batch.map(x => x.entry));
    batch = [];
    size = 0;
  };
  for (const e of [...blobs, ...recs]) {
    let data = null, op = e.op;
    if (e.kind !== 'blobs' && op === 'put') { data = await store.get(e.kind, e.id); if (!data) op = 'del'; }
    // nur einmal in Text umwandeln (große Seiten: mehrere MB) – die Cloud lädt genau diesen Text hoch
    const json = data ? JSON.stringify(data) : null;
    const change = Object.defineProperty({ kind: e.kind, id: e.id, op, at: e.at, data }, 'json', { value: json });
    batch.push({ change, entry: e });
    size += json ? json.length : 100;
    if (e.kind !== 'blobs') onProgress(`Hochladen: Notizen ${++n} von ${recs.length}`, (blobs.length + n) / Math.max(1, box.length));
    if (size > 8e6 || batch.length >= 300) await flush();
  }
  await flush();

  // 2) Herunterladen (seitenweise ab dem letzten Stand)
  let cursor = (await store.getMeta('cursor')) || 0, more = true, got = 0, missing = 0;
  while (more) {
    const res = await adapter.pull(cursor);
    const pending = new Map((await store.outboxAll()).map(e => [e.key, e]));
    const todo = res.changes.filter(c => {
      if (c.device === device) return false; // eigene Änderung
      const local = pending.get(c.kind + ':' + c.id);
      return !(local && local.at >= c.at); // hier gibt es eine neuere, noch nicht hochgeladene Version
    });
    await pool(todo.filter(c => c.kind === 'blobs' && c.op === 'put'), 4, async c => {
      try { await store.putBlob(c.id, await adapter.getBlob(c.id), { sync: false }); } catch { missing++; }
      onProgress(`Herunterladen: ${++got} Änderungen`, null);
    });
    for (const c of todo) {
      if (c.kind === 'blobs') { if (c.op === 'del') await store.delBlob(c.id, { sync: false }); }
      else if (c.op === 'put') { if (c.data) await store.put(c.kind, c.data, { sync: false, keepTime: true }); }
      else await store.del(c.kind, c.id, { sync: false });
      const local = pending.get(c.kind + ':' + c.id);
      if (local) await store.outboxDone([local]);
      if (c.kind !== 'blobs') onProgress(`Herunterladen: ${++got} Änderungen`, null);
    }
    cursor = res.cursor;
    more = res.more;
    await store.setMeta('cursor', cursor);
  }
  await store.setMeta('lastSync', Date.now());
  setStatus('ok');
  return { sent: box.length, received: got, missing };
}

// ---------- Status + automatischer Abgleich (nur Cloud, nach dem ersten Abgleich) ----------
export const syncEvents = new EventTarget();
let status = { state: 'idle', text: '' };
function setStatus(state, text = '') { status = { state, text }; syncEvents.dispatchEvent(new Event('status')); }
export const syncStatus = () => status;

// Während geschrieben, gewischt oder gezoomt wird, wartet der automatische Abgleich kurz: große Seiten in Text
// umzuwandeln und zu packen kostet Rechenzeit, die dem Stift fehlen würde. Spätestens nach 3 Minuten läuft er trotzdem.
let quietUntil = 0, lastAuto = 0, retryT = 0;
export function userActive(ms = 4000) { quietUntil = Math.max(quietUntil, Date.now() + ms); }

export async function autoSync() {
  if (running || !cloudConfigured() || !currentUser() || !navigator.onLine) return;
  const now = Date.now();
  if (now < quietUntil && now - lastAuto < 180000) {
    clearTimeout(retryT);
    retryT = setTimeout(autoSync, quietUntil - now + 300);
    return;
  }
  lastAuto = now;
  if ((await store.getMeta('syncTarget')) !== cloudAdapter().target() || !(await store.getMeta('initialQueued'))) return;
  try {
    setStatus('busy');
    const r = await syncNow(cloudAdapter());
    if (r.received) syncEvents.dispatchEvent(new Event('received'));
  } catch (err) {
    setStatus('error', err.message);
  }
}
export function startAutoSync() {
  setTimeout(autoSync, 2000);
  setInterval(autoSync, 60000);
  addEventListener('online', autoSync);
  addEventListener('offline', () => setStatus('offline'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') autoSync(); });
}

// ---------- Oberfläche ----------
export async function syncDialog(onDone) {
  if (!cloudConfigured()) return pcSyncDialog(onDone);
  if (!currentUser() && !(await loginDialog())) return;
  const user = currentUser();
  const adapter = cloudAdapter();
  const [pending, last, tgt] = await Promise.all([store.outboxAll(), store.getMeta('lastSync'), store.getMeta('syncTarget')]);
  const first = tgt !== adapter.target();
  const choice = await modal({
    title: 'Synchronisieren',
    body: h('div', { class: 'help' },
      h('p', {}, 'Angemeldet als ', h('b', {}, user.email), '. Deine Notizen werden mit deinem Cloud-Speicher abgeglichen – nach dem ersten Mal automatisch im Hintergrund.'),
      h('p', { class: 'muted small' }, first
        ? 'Beim ersten Abgleich wird alles hoch- bzw. heruntergeladen. Das kann einige Minuten dauern – Gerät bitte nicht sperren.'
        : `Letzter Abgleich: ${last ? new Date(last).toLocaleString('de-DE') : 'noch nie'} · ${pending.length} Änderungen warten aufs Hochladen.`)),
    actions: [{ label: 'Abmelden', value: 'logout' }, { label: 'Abbrechen', value: false }, { label: 'Jetzt abgleichen', value: 'sync', primary: true }],
  });
  if (choice === 'logout') { await signOut(); toast('Abgemeldet'); return; }
  if (choice !== 'sync') return;
  await runWithProgress(adapter, onDone);
}

async function runWithProgress(adapter, onDone) {
  const pr = progress('Synchronisieren …');
  try {
    setStatus('busy');
    const r = await syncNow(adapter, (t, f) => pr.set(t, f));
    toast(`Abgeglichen: ${r.sent} hochgeladen, ${r.received} geholt` + (r.missing ? ` (${r.missing} Bilder fehlten)` : ''));
  } catch (err) {
    console.error(err);
    setStatus('error', err.message);
    toast(/fetch|network/i.test(err.message) ? 'Keine Verbindung zum Sync-Speicher – bist du online?' : err.message);
  } finally {
    pr.close();
    onDone?.();
  }
}

async function loginDialog() {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'username', placeholder: 'name@beispiel.de', 'aria-label': 'E-Mail' });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'mindestens 6 Zeichen', 'aria-label': 'Passwort' });
  const mode = await modal({
    title: 'Anmelden für den Cloud-Sync',
    body: h('div', { class: 'form' },
      h('p', { class: 'muted small' }, 'Mit demselben Konto auf iPad und PC anmelden – dann sind überall dieselben Notizen.'),
      field('E-Mail', email), field('Passwort', pw)),
    actions: [{ label: 'Abbrechen', value: null }, { label: 'Konto erstellen', value: 'signup' }, { label: 'Anmelden', value: 'signin', primary: true }],
    onOpen: () => email.focus(),
  });
  if (!mode) return false;
  const e = email.value.trim(), p = pw.value;
  if (!e || !p) { toast('Bitte E-Mail und Passwort eingeben.'); return false; }
  try {
    if (mode === 'signin') { await signIn(e, p); return true; }
    const r = await signUp(e, p);
    if (r.user) return true;
    await modal({ title: 'Fast geschafft', body: h('p', {}, 'Wir haben dir eine E-Mail geschickt. Klick auf den Link darin und melde dich danach hier an.') });
    return false;
  } catch (err) {
    toast(/fetch|network/i.test(err.message) ? 'Keine Verbindung – bist du online?' : err.message);
    return false;
  }
}

// Ohne Cloud: Sync-Speicher auf dem PC (nur im selben WLAN). Am PC füllt die App den Sync-Code selbst aus.
async function pcSyncDialog(onDone) {
  let key = await store.getMeta('syncKey');
  if (!key) {
    try { const r = await fetch('/api/sync/key', { cache: 'no-store' }); if (r.ok) key = (await r.json()).key; } catch { /* nur am PC erreichbar */ }
  }
  const [pending, last] = await Promise.all([store.outboxAll(), store.getMeta('lastSync')]);
  const code = h('input', { class: 'input', value: key || '', placeholder: 'z. B. K7QM-4XTB', autocapitalize: 'characters', 'aria-label': 'Sync-Code' });
  const ok = await modal({
    title: 'Synchronisieren',
    body: h('div', { class: 'help' },
      h('p', {}, 'Gleicht deine Notizen mit dem Sync-Speicher auf deinem PC ab – Geräte müssen dafür im selben WLAN sein.'),
      h('p', { class: 'muted small' }, `Letzter Abgleich: ${last ? new Date(last).toLocaleString('de-DE') : 'noch nie'} · ${pending.length} Änderungen warten aufs Hochladen.`),
      field('Sync-Code (steht am PC in diesem Fenster)', code)),
    actions: [{ label: 'Abbrechen', value: false }, { label: 'Jetzt abgleichen', value: true, primary: true }],
  });
  if (!ok) return;
  key = code.value.trim().toUpperCase();
  if (!key) { toast('Bitte den Sync-Code eingeben.'); return; }
  const adapter = httpAdapter('', key);
  try { await adapter.info(); } catch (err) { toast(err.message); return; }
  await store.setMeta('syncKey', key);
  await runWithProgress(adapter, onDone);
}

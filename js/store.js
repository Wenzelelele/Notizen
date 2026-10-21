// Lokale Speicherung im Browser (IndexedDB).
// Für den Sync wird jede Änderung an Ordnern, Notizen, Seiten und Bildern in derselben Transaktion
// im "outbox"-Speicher vermerkt (Schlüssel + Zeitpunkt). sync.js schickt diese Änderungen an den
// Sync-Speicher und spielt Änderungen anderer Geräte ein (dann mit { sync: false }).

const DB_NAME = 'notizen';
const SYNCED = new Set(['folders', 'notebooks', 'pages', 'blobs']);
let dbPromise;

function db() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = e => {
      const d = req.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('folders', { keyPath: 'id' });
        d.createObjectStore('notebooks', { keyPath: 'id' });
        d.createObjectStore('pages', { keyPath: 'id' });
        d.createObjectStore('blobs');
      }
      if (e.oldVersion < 2) {
        d.createObjectStore('outbox', { keyPath: 'key' }); // noch nicht abgeglichene Änderungen
        d.createObjectStore('meta'); // Geräte-ID, Sync-Stand, Sync-Code …
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function txn(names, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction(names, mode);
    let result;
    const req = fn(tx);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  }));
}
const run = (name, mode, fn) => txn(name, mode, tx => fn(tx.objectStore(name)));

// Schreibzugriff + Vermerk in der Outbox, atomar in einer Transaktion
function write(name, sync, key, fn) {
  const logged = sync && SYNCED.has(name);
  return txn(logged ? [name, 'outbox'] : name, 'readwrite', tx => {
    const req = fn(tx.objectStore(name));
    if (logged) tx.objectStore('outbox').put({ key: name + ':' + key, kind: name, id: key, op: req.__op, at: Date.now() });
    return req;
  });
}
const op = (req, kind) => Object.assign(req, { __op: kind });

// remote: die Änderung kam per Sync von einem anderen Gerät (z. B. damit der Editor neu lädt)
export const changes = new EventTarget();
const changed = (kind, id, remote = false) => changes.dispatchEvent(new CustomEvent('change', { detail: { kind, id, remote } }));

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export const store = {
  get: (name, id) => run(name, 'readonly', st => st.get(id)),
  getAll: name => run(name, 'readonly', st => st.getAll()),
  // keepTime: Änderungszeit nicht neu setzen (z. B. beim Import das Datum aus OneNote behalten)
  // sync: false, wenn die Änderung von einem anderen Gerät kommt (nicht wieder zurückschicken)
  put(name, obj, { keepTime = false, sync = true } = {}) {
    if (!keepTime || !obj.updatedAt) obj.updatedAt = Date.now();
    return write(name, sync, obj.id, st => op(st.put(obj), 'put')).then(() => changed(name, obj.id, !sync));
  },
  del: (name, id, { sync = true } = {}) => write(name, sync, id, st => op(st.delete(id), 'del')).then(() => changed(name, id, !sync)),
  getBlob: key => run('blobs', 'readonly', st => st.get(key)),
  putBlob: (key, blob, { sync = true } = {}) => write('blobs', sync, key, st => op(st.put(blob, key), 'put')).then(() => changed('blobs', key, !sync)),
  delBlob: (key, { sync = true } = {}) => write('blobs', sync, key, st => op(st.delete(key), 'del')),

  // ---------- Sync-Hilfen ----------
  getMeta: key => run('meta', 'readonly', st => st.get(key)),
  setMeta: (key, value) => run('meta', 'readwrite', st => st.put(value, key)),
  outboxAll: () => run('outbox', 'readonly', st => st.getAll()),
  // abgeglichene Einträge entfernen – aber nur, wenn sie seitdem nicht erneut geändert wurden
  outboxDone: entries => txn('outbox', 'readwrite', tx => {
    const st = tx.objectStore('outbox');
    for (const e of entries) {
      const r = st.get(e.key);
      r.onsuccess = () => { if (r.result && r.result.at === e.at) st.delete(e.key); };
    }
  }),
  // alles Vorhandene einmalig zum Hochladen vormerken (Daten, die vor dem Sync angelegt wurden).
  // Zeitpunkt 1 = "uralt": liegt auf einem anderen Gerät schon eine Version vor, gewinnt diese.
  queueAll: () => txn([...SYNCED, 'outbox'], 'readwrite', tx => {
    const out = tx.objectStore('outbox');
    for (const name of SYNCED) {
      const r = tx.objectStore(name).getAllKeys();
      r.onsuccess = () => {
        for (const id of r.result) {
          const key = name + ':' + id, g = out.get(key);
          g.onsuccess = () => { if (!g.result) out.put({ key, kind: name, id, op: 'put', at: 1 }); };
        }
      };
    }
  }),

  async pagesOf(nb) {
    const pages = await Promise.all(nb.pageIds.map(id => this.get('pages', id)));
    return pages.filter(Boolean);
  },

  async deleteNotebook(nb) {
    for (const id of nb.pageIds) {
      const p = await this.get('pages', id);
      if (p?.bg) await this.delBlob(p.bg);
      for (const im of p?.images || []) await this.delBlob(im.key);
      await this.del('pages', id);
    }
    await this.del('notebooks', nb.id);
  },

  allBlobs: () => db().then(d => new Promise((resolve, reject) => {
    const out = [];
    const tx = d.transaction('blobs');
    const cur = tx.objectStore('blobs').openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { out.push([c.key, c.value]); c.continue(); }
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  })),
};

export const PAGE_SIZES = { a4p: [794, 1123], a4l: [1123, 794], card: [1000, 625] };

export function newNotebook(o = {}) {
  return {
    id: uid(),
    title: o.title || 'Neues Notizbuch',
    color: o.color || '#2f6fed',
    folderId: o.folderId ?? null,
    template: o.template || 'lined',
    paper: o.paper || 'white',
    size: o.size || 'a4p',
    pageIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function newPage(nb, ref) {
  const [w, h] = ref ? [ref.w, ref.h] : PAGE_SIZES[nb.size] || PAGE_SIZES.a4p;
  return {
    id: uid(),
    notebookId: nb.id,
    w, h,
    template: ref?.template ?? nb.template,
    paper: ref?.paper ?? nb.paper,
    bg: null,
    strokes: [],
    texts: [],
    images: [],
  };
}

// ---------- Backup (Übertragen zwischen Geräten, bis Sync eingebaut ist) ----------

const blobToDataURL = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

export async function exportBackup() {
  const [folders, notebooks, pages, blobs] = await Promise.all([
    store.getAll('folders'), store.getAll('notebooks'), store.getAll('pages'), store.allBlobs(),
  ]);
  const b = {};
  for (const [k, blob] of blobs) b[k] = await blobToDataURL(blob);
  const data = { app: 'notizen', version: 1, exportedAt: new Date().toISOString(), folders, notebooks, pages, blobs: b };
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

export async function importBackup(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'notizen') throw new Error('Das ist keine Notizen-Backup-Datei.');
  for (const f of data.folders || []) await store.put('folders', f);
  for (const [k, url] of Object.entries(data.blobs || {})) await store.putBlob(k, await (await fetch(url)).blob());
  for (const p of data.pages || []) await store.put('pages', p);
  for (const n of data.notebooks || []) await store.put('notebooks', n);
  return (data.notebooks || []).length;
}

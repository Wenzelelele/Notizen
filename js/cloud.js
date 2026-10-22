// Cloud-Speicher für den Sync: Supabase (Login, Datenbank-Tabelle "records", Datei-Speicher "notizen").
// Bewusst ohne Supabase-Bibliothek – nur fetch, damit die App offline nichts nachladen muss.
// Datenbank-Einrichtung: cloud-setup.sql (einmal im Supabase SQL-Editor ausführen).
import { CLOUD } from './config.js';

const SESSION_KEY = 'notizen.session';
const BUCKET = 'notizen';
export const cloudConfigured = () => !!(CLOUD.url && CLOUD.key);
const base = () => CLOUD.url.replace(/\/+$/, '');

// ---------- Anmeldung ----------
function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } }
function saveSession(s) {
  const session = { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (s.expires_in || 3600), user: { id: s.user.id, email: s.user.email } };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* egal */ }
  return session;
}
export const currentUser = () => loadSession()?.user || null;

const MESSAGES = {
  invalid_credentials: 'E-Mail oder Passwort stimmt nicht.',
  invalid_grant: 'E-Mail oder Passwort stimmt nicht.',
  email_not_confirmed: 'Bitte zuerst den Link in der Bestätigungs-E-Mail anklicken.',
  user_already_exists: 'Für diese E-Mail gibt es schon ein Konto – bitte anmelden.',
  weak_password: 'Das Passwort ist zu schwach (mindestens 6 Zeichen).',
  over_email_send_rate_limit: 'Zu viele E-Mails in kurzer Zeit – bitte ein paar Minuten warten.',
};
async function authCall(path, body, token) {
  const r = await fetch(base() + '/auth/v1/' + path, {
    method: 'POST',
    headers: { apikey: CLOUD.key, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(MESSAGES[j.error_code] || MESSAGES[j.error] || j.msg || j.error_description || `Anmeldung fehlgeschlagen (${r.status})`), { status: r.status });
  return j;
}

// Ergebnis: { user } angemeldet, oder { confirm: true } wenn erst die E-Mail bestätigt werden muss
export async function signUp(email, password) {
  const j = await authCall('signup?redirect_to=' + encodeURIComponent(location.origin + location.pathname), { email, password });
  if (j.access_token) return { user: saveSession(j).user };
  return { confirm: true };
}
export async function signIn(email, password) {
  return { user: saveSession(await authCall('token?grant_type=password', { email, password })).user };
}
export async function signOut() {
  const s = loadSession();
  try { localStorage.removeItem(SESSION_KEY); } catch { /* egal */ }
  if (s) authCall('logout', {}, s.access_token).catch(() => {});
}
// Abgelaufene Anmeldung erneuern. Gleichzeitige Aufrufe (z. B. vier Bild-Uploads) warten auf dieselbe Erneuerung –
// sonst würde dasselbe Erneuerungs-Token mehrfach benutzt, und Supabase kann die Sitzung dann beenden.
// Abgemeldet wird nur, wenn Supabase die Anmeldung wirklich ablehnt – nicht bei einem kurzen Netzproblem.
let refreshing = null;
async function token() {
  const s = loadSession();
  if (!s) throw new Error('Bitte zuerst anmelden.');
  if (s.expires_at - 60 >= Date.now() / 1000) return s;
  refreshing ??= (async () => {
    try { return saveSession(await authCall('token?grant_type=refresh_token', { refresh_token: s.refresh_token })); }
    catch (err) {
      if ([400, 401, 403].includes(err.status)) {
        try { localStorage.removeItem(SESSION_KEY); } catch { /* egal */ }
        throw new Error('Anmeldung abgelaufen – bitte neu anmelden.');
      }
      throw new Error('Keine Verbindung zur Cloud – bist du online?');
    } finally { refreshing = null; }
  })();
  return refreshing;
}

// ---------- Datenbank + Dateien ----------
async function api(path, opt = {}) {
  const s = await token();
  const r = await fetch(base() + path, { ...opt, headers: { apikey: CLOUD.key, Authorization: 'Bearer ' + s.access_token, ...(opt.headers || {}) } });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Cloud-Speicher: ${r.status} ${t.slice(0, 160)}`);
  }
  return r;
}
const objPath = (uid, p) => `/storage/v1/object/${BUCKET}/${uid}/${p.split('/').map(encodeURIComponent).join('/')}`;
const putObject = async (p, blob, type) => (await api(objPath((await token()).user.id, p), { method: 'POST', headers: { 'x-upsert': 'true', 'Content-Type': type || blob.type || 'application/octet-stream' }, body: blob }));
// v: Stand einer überschriebenen Datei (Seiten) → eigene Adresse je Stand, damit weder CDN (Supabase: bis 60 s nach
// dem Überschreiben) noch Browser-Cache eine alte Fassung liefern. Der Speicher ignoriert unbekannte Parameter.
const getObject = async (p, v) => (await api(objPath((await token()).user.id, p) + (v ? '?v=' + v : ''), v ? { cache: 'no-store' } : {})).blob();
const delObject = async p => { try { await api(objPath((await token()).user.id, p), { method: 'DELETE' }); } catch { /* war schon weg */ } };

// Datenbank-Aufruf mit der Anmeldung des Benutzers (z. B. rpc/set_inbox_key, inbox.js)
export const cloudRest = (path, opt) => api(path, opt);

// ---------- Dateien für Claude (claude.js): Seitenbilder, markierte Bereiche ----------
export const accessToken = async () => (await token()).access_token;
export const userFiles = {
  put: (p, blob, type) => putObject(p, blob, type),
  get: async p => (await getObject(p)),
  del: p => delObject(p),
  // Dateien eines Ordners (ohne Unterordner): [{ name, created_at, metadata }]
  async list(dir) {
    const s = await token(), out = [];
    for (let offset = 0; ; offset += 1000) {
      const r = await api(`/storage/v1/object/list/${BUCKET}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: `${s.user.id}/${dir}`, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
      });
      const rows = await r.json();
      out.push(...rows.filter(o => o.id));
      if (rows.length < 1000) return out;
    }
  },
};

// Seiten können mehrere MB groß sein → gzip-komprimiert als Datei statt in der Datenbank
async function gzip(text) {
  if (!window.CompressionStream) throw new Error('Dieser Browser ist zu alt für den Cloud-Sync.');
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
const gunzip = async blob => JSON.parse(await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text());
const pageFile = id => `pages/${id}.json.gz`;

// Adapter für sync.js – dieselben Funktionen wie der PC-Sync (httpAdapter)
export function cloudAdapter() {
  return {
    target: () => 'cloud:' + (currentUser()?.id || '?'),
    info: async () => { await api('/rest/v1/records?select=seq&limit=1'); return { ok: true }; },
    async push(device, changes) {
      const rows = [];
      for (const c of changes) {
        if (c.kind === 'pages') {
          if (c.op === 'put') await putObject(pageFile(c.id), await gzip(c.json ?? JSON.stringify(c.data)), 'application/gzip');
          else await delObject(pageFile(c.id));
          rows.push({ ...c, data: null });
        } else {
          if (c.kind === 'blobs' && c.op === 'del') await delObject('blobs/' + c.id);
          rows.push(c);
        }
      }
      await api('/rest/v1/rpc/sync_push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, changes: rows }) });
      return { ok: true };
    },
    async pull(since) {
      const limit = 300;
      const rows = await (await api(`/rest/v1/records?select=kind,id,op,at,device,seq,data&seq=gt.${since}&order=seq.asc&limit=${limit}`)).json();
      for (const r of rows) if (r.kind === 'pages' && r.op === 'put') r.data = await gunzip(await getObject(pageFile(r.id), r.seq));
      return { changes: rows, cursor: rows.length ? rows[rows.length - 1].seq : since, more: rows.length === limit };
    },
    putBlob: (k, blob) => putObject('blobs/' + k, blob),
    getBlob: k => getObject('blobs/' + k),
  };
}

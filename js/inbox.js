// PDFs aus dem Teilen-Menü von Safari: Der iOS-Kurzbefehl „In Notizen sichern“ schickt das PDF an die
// Edge Function notizen-inbox (siehe INBOX.md). Sie legt es im Cloud-Speicher unter inbox/<id>.pdf ab,
// dazu inbox/<id>.json mit Titel und Zielordner. Die App holt es hier ab und macht daraus eine Notiz.
// Feste ids (aus der Eingangs-id): holen zwei Geräte gleichzeitig ab, entsteht dieselbe Notiz statt zwei.
import { store } from './store.js';
import { CLOUD } from './config.js';
import { cloudConfigured, currentUser, userFiles, cloudRest } from './cloud.js';
import { importPdf } from './pdfio.js';
import { h, icon, modal, confirmDialog, toast, progress, field } from './ui.js';
import { hid } from './onenote.js';
import { syncDialog } from './sync.js';

export const INBOX_URL = CLOUD.url ? CLOUD.url.replace(/\/+$/, '') + '/functions/v1/notizen-inbox' : '';
const KEY_STORE = 'notizen.inboxKey'; // eigener Schlüssel, damit der Dialog die Adresse wieder zeigen kann

let busy = false, lastCheck = 0;

// Eingang abholen; liefert die Zahl der neu angelegten Notizen.
// files: zum Testen eine nachgebaute Ablage statt des Cloud-Speichers
export async function checkInbox({ force = false, files = null } = {}) {
  const box = files || userFiles;
  if (busy) return 0;
  if (!files && (!INBOX_URL || !cloudConfigured() || !currentUser() || !navigator.onLine)) return 0;
  if (!force && Date.now() - lastCheck < 20000) return 0;
  busy = true;
  lastCheck = Date.now();
  let n = 0;
  try {
    const list = (await box.list('inbox')).filter(f => f.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
    for (const f of list) {
      try { if (await takeItem(box, f.name.slice(0, -5))) n++; } catch (err) { console.error('PDF-Eingang', f.name, err); }
    }
  } catch (err) {
    console.warn('PDF-Eingang nicht erreichbar:', err.message);
  } finally { busy = false; }
  return n;
}

async function takeItem(box, id) {
  const nbId = 'ib' + hid('inbox:' + id);
  const clear = async () => { await box.del(`inbox/${id}.pdf`); await box.del(`inbox/${id}.json`); };
  if (await store.get('notebooks', nbId)) { await clear(); return false; } // schon übernommen (z. B. am anderen Gerät)
  const meta = JSON.parse(await (await box.get(`inbox/${id}.json`)).text());
  let pdf;
  try { pdf = await box.get(`inbox/${id}.pdf`); } catch { return false; } // gerade woanders abgeholt
  const folderId = meta.folderId && (await store.get('folders', meta.folderId)) ? meta.folderId : null;
  const title = String(meta.title || 'PDF').slice(0, 120);
  const pr = progress('PDF aus Safari wird übernommen …');
  try {
    await importPdf(new File([pdf], title + '.pdf', { type: 'application/pdf' }), {
      folderId, title,
      meta: { id: nbId, source: 'inbox:' + id },
      pageId: i => nbId + 'p' + i,
      onProgress: (i, k) => pr.set(`${title} – Seite ${i} von ${k}`, i / k),
    });
  } finally { pr.close(); }
  await clear();
  toast(`„${title}“ ist da` + (folderId && meta.folderPath ? ` – in ${meta.folderPath}` : ''));
  return true;
}

// ---------- Einrichten (⋯ → „PDFs aus Safari …“) ----------
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const savedKey = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } };
const addressFor = key => (key ? `${INBOX_URL}?k=${key}` : '');

export async function inboxDialog(onDone) {
  if (!cloudConfigured() || !INBOX_URL) {
    await modal({ title: 'PDFs aus Safari', body: h('p', { class: 'muted' }, 'Dafür braucht die App den Cloud-Sync (Supabase in js/config.js).') });
    return;
  }
  if (!currentUser()) {
    const go = await modal({
      title: 'PDFs aus Safari',
      body: h('p', { class: 'muted' }, 'Die PDFs kommen über deine Cloud an. Melde dich zuerst an.'),
      actions: [{ label: 'Abbrechen', value: false }, { label: 'Anmelden …', value: true, primary: true }],
    });
    if (go) await syncDialog(onDone);
    return;
  }
  let key = savedKey();
  const url = h('input', { class: 'input', value: addressFor(key), readonly: true, placeholder: 'noch keine Adresse', 'aria-label': 'Adresse für den Kurzbefehl', onfocus: e => e.target.select() });
  const status = h('div', { class: 'muted small' });
  const copyBtn = h('button', { class: 'btn', type: 'button', onclick: copy }, icon('copy'), 'Kopieren');
  const testBtn = h('button', { class: 'btn', type: 'button', onclick: test }, icon('check'), 'Verbindung testen');
  const makeBtn = h('button', { class: 'btn' + (key ? '' : ' primary'), type: 'button', onclick: make }, key ? 'Neue Adresse erzeugen' : 'Adresse erzeugen');
  const draw = () => { url.value = addressFor(key); copyBtn.disabled = testBtn.disabled = !key; };
  draw();

  async function make() {
    if (key && !(await confirmDialog('Neue Adresse erzeugen?', 'Die alte funktioniert dann nicht mehr – im Kurzbefehl musst du sie an beiden Stellen ersetzen.', 'Neu erzeugen'))) return;
    makeBtn.disabled = true;
    status.textContent = 'Wird erzeugt …';
    try {
      const k = [...crypto.getRandomValues(new Uint8Array(32))].map(b => ALPHABET[b % ALPHABET.length]).join('');
      await cloudRest('/rest/v1/rpc/set_inbox_key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash: await sha256(k) }) });
      key = k;
      try { localStorage.setItem(KEY_STORE, k); } catch { /* egal */ }
      draw();
      makeBtn.textContent = 'Neue Adresse erzeugen';
      makeBtn.classList.remove('primary');
      status.textContent = 'Fertig – jetzt kopieren und in den Kurzbefehl einfügen.';
    } catch (err) {
      status.textContent = /set_inbox_key|PGRST202|404/.test(err.message)
        ? 'Die Cloud ist dafür noch nicht eingerichtet: in Supabase einmal inbox-setup.sql ausführen (siehe INBOX.md).'
        : 'Das hat nicht geklappt: ' + err.message;
    } finally { makeBtn.disabled = false; }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(url.value); toast('Adresse kopiert'); }
    catch { url.focus(); url.select(); toast('Markiert – jetzt kopieren'); }
  }
  async function test() {
    status.textContent = 'Wird geprüft …';
    try {
      const r = await fetch(url.value, { cache: 'no-store' });
      const body = await r.text();
      if (r.ok) {
        const n = Math.max(0, JSON.parse(body).length - 1);
        status.textContent = `✓ Verbunden – der Kurzbefehl bietet ${n} ${n === 1 ? 'Ordner' : 'Ordner'} an.`;
      } else if (r.status === 404) status.textContent = 'Die Funktion „notizen-inbox“ ist in Supabase noch nicht bereitgestellt (siehe INBOX.md).';
      else status.textContent = body.slice(0, 200) || 'Fehler ' + r.status;
    } catch {
      status.textContent = 'Keine Verbindung zur Funktion – ist „notizen-inbox“ in Supabase bereitgestellt und „Verify JWT“ aus?';
    }
  }

  await modal({
    title: 'PDFs aus Safari',
    body: h('div', { class: 'help' },
      h('p', {}, 'Im Teilen-Menü von Safari ein PDF „In Notizen sichern“: Ordner wählen, fertig. Beim nächsten Öffnen der App liegt es dort als Notiz zum Beschreiben – auch PDFs hinter dem Uni-Login.'),
      field('Deine persönliche Adresse (wie ein Passwort behandeln)', h('div', { class: 'copyrow' }, url, copyBtn)),
      h('div', { class: 'row' }, makeBtn, testBtn),
      status,
      h('p', { class: 'small', style: { marginTop: '14px' } }, h('b', {}, 'Kurzbefehl anlegen (einmalig, in der App „Kurzbefehle“):')),
      h('ol', { class: 'small' },
        h('li', {}, '„+“ → oben den Namen antippen → „Umbenennen“: ', h('b', {}, 'In Notizen sichern'), '.'),
        h('li', {}, 'Unten „i“ (Details) → ', h('b', {}, '„Im Share-Sheet anzeigen“'), ' einschalten. Oben bei „Eingabe empfangen“ ', h('b', {}, 'nur PDFs'), ' auswählen.'),
        h('li', {}, h('b', {}, '„Inhalte von URL abrufen“'), ' – als URL deine Adresse von oben einfügen.'),
        h('li', {}, h('b', {}, '„Aus Liste auswählen“'), ' – Hinweis z. B. „Welches Semester?“.'),
        h('li', {}, h('b', {}, '„Inhalte von URL abrufen“'), ' mit derselben Adresse. Auf den Pfeil tippen: Methode ', h('b', {}, 'POST'), ', Anfragetext ', h('b', {}, 'Formular'),
          ', Feld „Text“: Schlüssel ', h('code', {}, 'folder'), ', Wert „Ausgewähltes Objekt“.'),
        h('li', {}, h('b', {}, '„Aus Liste auswählen“'), ' – Hinweis z. B. „In welchen Ordner?“.'),
        h('li', {}, h('b', {}, '„Inhalte von URL abrufen“'), ' wie in Schritt 5 (Feld ', h('code', {}, 'folder'), ' = „Ausgewähltes Objekt“) und zusätzlich Feld „Datei“: Schlüssel ',
          h('code', {}, 'file'), ', Wert ', h('b', {}, '„Kurzbefehleingabe“'), '.'),
        h('li', {}, h('b', {}, '„Mitteilung anzeigen“'), ' mit „Inhalte von URL“ – dann siehst du, wo das PDF landet.')),
      h('p', { class: 'muted small' }, 'Wichtig: kein „PDF erstellen“ verwenden – das druckt die Safari-Seite neu und liefert leere Seiten. ',
        'Benutzen: PDF in Safari öffnen (das PDF selbst, nicht nur die Seite mit dem Link) → Teilen → „In Notizen sichern“ → Semester → Ordner. Geht auch aus der Dateien-App oder aus Mails.')),
  });
}

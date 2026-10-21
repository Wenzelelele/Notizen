import { showLibrary } from './library.js';
import { openEditor } from './editor.js';
import { closeMenus, toast } from './ui.js';
import { startAutoSync } from './sync.js';
import { showReview } from './review.js';
import { showOcclusion } from './occlusion.js';
import { versionLabel } from './version.js';
import { startClaude, showConsent } from './claude.js';

const app = document.getElementById('app');
// Claude verbindet sich gerade (Anmeldung über Supabase, siehe claude.js): nur die Zustimmungsseite zeigen
const consentId = new URLSearchParams(location.search).get('authorization_id');
let destroy = null, seq = 0;

async function route() {
  const my = ++seq;
  closeMenus();
  if (destroy) { const d = destroy; destroy = null; await d(); } // speichert u. a. die offene Notiz
  if (updateReady && !busy()) { applyUpdate(); return; }
  const m = location.hash.match(/^#nb\/(.+)$/), lern = location.hash.match(/^#lernen(?:\/(.+))?$/), occl = location.hash.match(/^#abdecken\/(.+)$/);
  const d = m ? await openEditor(app, decodeURIComponent(m[1]))
    : lern ? await showReview(app, lern[1] ? decodeURIComponent(lern[1]) : null)
    : occl ? await showOcclusion(app, decodeURIComponent(occl[1]))
    : await showLibrary(app);
  if (my !== seq) { await d?.(); return; }
  destroy = d;
}

if (!consentId) addEventListener('hashchange', route);
// iPad: Safari-eigenes Zoomen der ganzen Seite verhindern (wir zoomen selbst)
document.addEventListener('gesturestart', e => e.preventDefault());
// Browser bitten, die Notizen nicht bei Speicherknappheit automatisch zu löschen
navigator.storage?.persist?.().catch(() => {});
// Offline-Fähigkeit, sobald die App im Internet (https) läuft – nicht beim Entwickeln am PC.
// Updates: Der Service Worker holt eine neue Version im Hintergrund. Steht sie bereit, lädt die App sich neu –
// sofort, wenn keine Notiz offen ist, sonst beim nächsten Wechsel zur Übersicht (dann ist alles gespeichert).
let updateReady = false;
const busy = () => /^#(nb|abdecken)\//.test(location.hash);
function applyUpdate() {
  try { sessionStorage.setItem('notizen.updated', '1'); } catch { /* egal */ }
  location.reload();
}
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; } // Erstinstallation: es läuft schon die neueste Version
    if (updateReady) return;
    updateReady = true;
    if (!busy()) applyUpdate();
  });
  navigator.serviceWorker.register('sw.js').then(reg => {
    // iPad: Die App wird oft nur aus dem Hintergrund geholt statt neu gestartet – dann auch nach Updates schauen
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}
if (consentId) showConsent(app, consentId);
else {
  startAutoSync();
  startClaude();
  route().then(() => {
    try {
      if (!sessionStorage.getItem('notizen.updated')) return;
      sessionStorage.removeItem('notizen.updated');
      toast('App aktualisiert – Version vom ' + versionLabel());
    } catch { /* egal */ }
  });
}

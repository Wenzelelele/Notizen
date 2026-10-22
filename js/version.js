// App-Version: build-web.js setzt beim Veröffentlichen den Zeitpunkt ein (am PC bleibt es 'dev')
export const BUILD = '2026-10-22T09:11:57.474Z';

export function versionLabel() {
  const d = new Date(BUILD);
  return isNaN(d) ? 'Entwicklung' : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

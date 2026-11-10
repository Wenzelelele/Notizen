// Speicher: wie viel die Notizen belegen (auf dem Gerät und in der Cloud) und wie man Platz spart.
// Supabase (kostenlos) hat 1 GB Dateispeicher; ist er voll, kann nichts mehr hochgeladen werden.
//
// Was Platz spart, ohne dass etwas unscharf wird:
// - PDFs: abgeglichen wird das Original-PDF, die Seitenbilder liegen nur auf dem Gerät (pdfio.js).
// - „Verkleinern“: Bilder (OneNote-Folien, ältere PDF-Seiten, Kartenausschnitte) in voller Auflösung als WebP neu
//   speichern. Gemessen an 90 Bildern aus dem OneNote-Export: JPEG → 67 %, PNG → 47 % der Größe, die Abweichung
//   zum Original liegt unter dem, was man sieht (PSNR im Mittel 47 dB bzw. 43 dB). Schreiben kann WebP nur
//   Chrome/Edge/Firefox – also am PC ausführen; lesen kann es jedes Gerät, die anderen übernehmen die kleineren
//   Bilder beim nächsten Abgleich (gleicher Schlüssel).
// - Ohne WebP (Safari) bleibt der frühere Weg: JPEG 0.8 und höchstens doppelte Anzeigegröße – das sieht man eher.
import { store } from './store.js';
import { h, icon, modal, progress, toast, confirmDialog } from './ui.js';
import { canWebp } from './pdfio.js';
import { cloudConfigured, currentUser, userFiles, pool } from './cloud.js';
import { deletePreviews } from './claude.js';

export const CLOUD_LIMIT = 1024 ** 3;
const WEBP_Q = 0.9;           // siehe oben
const WEBP_PX = 3;            // Bildpunkte je Seiteneinheit: mehr sieht man auch bei 300 % Zoom nicht
const JPEG_Q = 0.8;
const JPEG_PX = 2;
const MIN_BYTES = 40 * 1024;  // kleine Bilder lohnen sich nicht
const GZ = 0.3;               // Seiten liegen gzip-komprimiert in der Cloud (grob ein Drittel)

export const fmtMB = b => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2).replace('.', ',') + ' GB' : Math.max(0.1, b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0).replace('.', ',') + ' MB');

// Bilder einer Seite im abgeglichenen Speicher, mit ihrem Anzeigekasten (Seiteneinheiten).
// PDF-Seiten mit page.pdf haben dort kein Bild (nur das gemeinsame PDF).
const imagesOf = p => [
  ...(p.bg && !p.pdf ? [{ key: p.bg, w: p.w, h: p.h }] : []),
  ...(p.images || []).map(im => ({ key: im.key, w: im.w, h: im.h })),
];
// Lässt sich das Bild noch verkleinern? Schon umgewandelte (WebP) nicht nochmal – jede Runde kostet etwas Qualität
const shrinkable = (type, size) => size >= MIN_BYTES && type !== 'image/webp' && !type.startsWith('application/');

// Seitendaten grob schätzen (je Zahl im Strich ~7 Zeichen) statt alle Seiten in Text umzuwandeln –
// das hätte bei großen OneNote-Notizen die App für Sekunden angehalten
const pageChars = p => 300 + (p.strokes || []).reduce((n, s) => n + 90 + (s.pts?.length || 0) * 7, 0)
  + (p.texts || []).reduce((n, t) => n + 120 + (t.text?.length || 0), 0) + (p.images || []).length * 120;

// Größe je Notiz (Bilder/PDF + Seitendaten) und insgesamt. Die Seiten werden einzeln durchgegangen (Cursor) –
// alle auf einmal zu laden braucht bei großen OneNote-Importen mehrere hundert MB Arbeitsspeicher.
export async function usage() {
  const [nbs, blobs] = await Promise.all([store.getAll('notebooks'), store.allBlobs()]);
  const size = new Map(), type = new Map();
  for (const [k, b] of blobs) { size.set(k, b?.size || 0); type.set(k, b?.type || ''); }
  const owner = new Map();
  for (const nb of nbs) for (const id of nb.pageIds || []) owner.set(id, nb.id);
  const acc = new Map(nbs.map(nb => [nb.id, { nb, images: 0, data: JSON.stringify(nb).length, pdfs: new Set(), gain: 0 }]));
  await store.each('pages', p => {
    const a = acc.get(owner.get(p.id));
    if (!a) return; // Seite gehört zu keiner Notiz (mehr)
    a.data += pageChars(p) * GZ;
    if (p.pdf) a.pdfs.add(p.pdf.key);
    for (const im of imagesOf(p)) {
      const s = size.get(im.key) || 0;
      a.images += s;
      if (shrinkable(type.get(im.key) || '', s)) a.gain += s;
    }
  });
  const notes = [];
  let cloud = 0;
  for (const a of acc.values()) {
    for (const k of a.pdfs) a.images += size.get(k) || 0;
    const o = a.nb.occl?.image?.key;
    if (o) { a.images += size.get(o) || 0; if (shrinkable(type.get(o) || '', size.get(o) || 0)) a.gain += size.get(o) || 0; }
    notes.push({ nb: a.nb, images: a.images, gain: a.gain, bytes: a.images + a.data });
    cloud += a.images + a.data;
  }
  // Abdeck-Karten teilen sich ein Bild: nicht doppelt zählen
  const occl = new Set();
  for (const n of notes) {
    const k = n.nb.occl?.image?.key;
    if (!k) continue;
    if (occl.has(k)) { const s = size.get(k) || 0; cloud -= s; n.images -= s; n.bytes -= s; n.gain = Math.max(0, n.gain - s); }
    occl.add(k);
  }
  let device = null;
  try { device = (await navigator.storage?.estimate?.())?.usage ?? null; } catch { /* egal */ }
  return { notes: notes.sort((a, b) => b.bytes - a.bytes), cloud, device };
}

async function shrinkImage(key, box) {
  const blob = await store.getBlob(key);
  if (!blob || !shrinkable(blob.type || '', blob.size)) return 0;
  const bmp = await createImageBitmap(blob);
  try {
    const webp = canWebp();
    const k = Math.min(1, (box.w * (webp ? WEBP_PX : JPEG_PX)) / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * k)), hh = Math.max(1, Math.round(bmp.height * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hh;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; // durchsichtige Stellen (PNG) wären in JPEG sonst schwarz
    ctx.fillRect(0, 0, w, hh);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, hh);
    const out = await new Promise(r => c.toBlob(r, webp ? 'image/webp' : 'image/jpeg', webp ? WEBP_Q : JPEG_Q));
    c.width = c.height = 0;
    if (!out || out.size > blob.size * 0.85) return 0; // spart zu wenig – Original behalten
    await store.putBlob(key, out);
    return blob.size - out.size;
  } finally { bmp.close?.(); }
}

// Alle Bilder einer Notiz verkleinern; liefert die gesparten Bytes
export async function shrinkNote(nb, onProgress) {
  const pages = await store.pagesOf(nb);
  const list = pages.flatMap(imagesOf);
  if (nb.occl?.image) list.push({ key: nb.occl.image.key, w: nb.occl.image.w, h: nb.occl.image.h });
  let saved = 0;
  for (const [i, im] of list.entries()) {
    onProgress?.(i, list.length);
    try { saved += await shrinkImage(im.key, im); } catch (err) { console.warn('Bild', im.key, err); }
  }
  return saved;
}

export async function shrinkWithProgress(nbs, title = 'Bilder werden neu gespeichert …') {
  const pr = progress(title);
  let saved = 0;
  try {
    for (const [n, nb] of nbs.entries()) {
      saved += await shrinkNote(nb, (i, k) => pr.set(`${nb.title}${nbs.length > 1 ? ` (${n + 1} von ${nbs.length})` : ''} – Bild ${i + 1} von ${k}`, (n + i / Math.max(1, k)) / nbs.length));
    }
  } finally { pr.close(); }
  toast(saved > 1024 * 1024 ? `${fmtMB(saved)} gespart – wird mit der Cloud abgeglichen` : 'Da war nicht viel zu holen – die Bilder sind schon klein');
  return saved;
}

// Was wirklich in der Cloud liegt (Dateilisten des Speichers, nur lesend): Bilder/PDFs, Seiten, Seitenbilder für
// Claude, Sonstiges. orphans: Bild-Dateien, zu denen es auf diesem Gerät nichts (mehr) gibt.
export async function cloudUsage(onProgress = () => {}) {
  const sum = list => list.reduce((n, f) => n + (f.metadata?.size || 0), 0);
  onProgress('Bilder und Seiten …', 0.05);
  const [blobs, pages, marked, inbox] = await Promise.all([userFiles.list('blobs'), userFiles.list('pages'), userFiles.list('claude/marked'), userFiles.list('inbox')]);
  const local = new Set((await store.allBlobs()).map(([k]) => k));
  const lost = blobs.filter(f => !local.has(f.name));
  const out = {
    blobs: sum(blobs), blobFiles: blobs.length, pages: sum(pages), pageFiles: pages.length,
    other: sum(marked) + sum(inbox), previews: 0, previewFiles: 0,
    orphans: sum(lost), orphanFiles: lost.length,
  };
  const dirs = await userFiles.list('previews', { dirs: true });
  let n = 0;
  await pool(dirs, 6, async d => {
    const l = await userFiles.list('previews/' + d.name);
    out.previews += sum(l);
    out.previewFiles += l.length;
    onProgress(`Seitenbilder für Claude: ${++n} von ${dirs.length} Seiten`, 0.1 + (0.9 * n) / dirs.length);
  });
  out.total = out.blobs + out.pages + out.previews + out.other;
  return out;
}

// Dialog: ⋯ → „Speicher …“
export async function storageDialog(onDone) {
  const body = h('div', { class: 'help' }, h('p', { class: 'muted' }, 'Wird berechnet …'));
  const exact = h('div', {}); // Ergebnis von „genau nachmessen“ (bleibt beim Neuzeichnen stehen)
  const webp = canWebp();
  const online = cloudConfigured() && !!currentUser();

  async function measure() {
    const pr = progress('Cloud-Speicher wird gemessen …');
    try {
      const c = await cloudUsage((t, f) => pr.set(t, f));
      const row = (label, bytes, extra = null) => h('div', { class: 'usage-row' }, h('span', { class: 'grow' }, label), h('span', { class: 'muted small' }, fmtMB(bytes)), extra);
      exact.replaceChildren(
        h('p', { class: 'small', style: { marginTop: '14px' } }, h('b', {}, `In der Cloud liegen ${fmtMB(c.total)} `), `(${Math.round((c.total / CLOUD_LIMIT) * 100)} % von 1 GB):`),
        h('div', { class: 'usage-list' },
          row(`Bilder und PDFs (${c.blobFiles} Dateien)`, c.blobs),
          row(`Seiten mit Handschrift (${c.pageFiles})`, c.pages),
          c.previewFiles ? row(`Seitenbilder für Claude (${c.previewFiles})`, c.previews,
            h('button', { class: 'btn sm', type: 'button', onclick: dropPreviews }, 'Löschen')) : null,
          c.other ? row('Markierungen für Claude, PDF-Eingang', c.other) : null),
        c.orphanFiles ? h('p', { class: 'muted small' }, `${c.orphanFiles} Bild-Dateien (${fmtMB(c.orphans)}) haben auf diesem Gerät kein Gegenstück – Reste gelöschter Notizen oder noch nicht abgeglichen.`) : null);
    } catch (err) {
      console.error(err);
      toast(/fetch|network/i.test(err.message) ? 'Keine Verbindung zur Cloud – bist du online?' : 'Messen fehlgeschlagen: ' + err.message);
    } finally { pr.close(); }
  }
  async function dropPreviews() {
    if (!(await confirmDialog('Seitenbilder für Claude löschen?', 'Claude sieht dann wieder nur getippten Text und markierte Bereiche. Das Hochladen wird ausgeschaltet; unter ⋯ → „Claude (MCP)“ lässt es sich jederzeit wieder einschalten.', 'Löschen', true))) return;
    const pr = progress('Seitenbilder werden gelöscht …');
    try { await deletePreviews((i, n) => pr.set(`${i} von ${n} Seiten`, i / Math.max(1, n))); }
    catch (err) { console.error(err); toast('Löschen fehlgeschlagen: ' + err.message); }
    finally { pr.close(); }
    await measure();
  }

  const draw = async () => {
    const u = await usage();
    const share = Math.min(1, u.cloud / CLOUD_LIMIT);
    const big = u.notes.filter(n => n.gain > 3 * 1024 ** 2);
    const run = async list => { await shrinkWithProgress(list); await draw(); onDone?.(); };
    body.replaceChildren(
      h('p', {}, h('b', {}, 'Cloud (Supabase, kostenlos 1 GB): '), `ca. ${fmtMB(u.cloud)}`),
      h('div', { class: 'meter' + (share > 0.8 ? ' warn' : '') }, h('i', { style: { width: Math.round(share * 100) + '%' } })),
      u.device != null ? h('p', { class: 'muted small' }, `Auf diesem Gerät belegt die App ${fmtMB(u.device)} (samt Seitenbildern der PDFs, die nicht in die Cloud gehen).`) : null,
      online ? h('button', { class: 'btn sm', type: 'button', onclick: measure }, 'Cloud genau nachmessen') : null,
      exact,
      h('p', { class: 'small', style: { marginTop: '14px' } }, h('b', {}, 'Größte Notizen')),
      h('div', { class: 'usage-list' }, u.notes.filter(n => n.nb.kind !== 'card' || n.bytes > 1024 ** 2).slice(0, 8).map(n => h('div', { class: 'usage-row' },
        h('span', { class: 'grow' }, n.nb.title),
        h('span', { class: 'muted small' }, fmtMB(n.bytes)),
        n.gain > 1024 ** 2 ? h('button', { class: 'btn sm', type: 'button', onclick: () => run([n.nb]) }, 'Verkleinern') : null))),
      big.length ? h('button', { class: 'btn block', type: 'button', onclick: () => run(big.map(n => n.nb)) },
        icon('download'), big.length === 1 ? 'Die große Notiz verkleinern' : `Alle ${big.length} großen Notizen verkleinern`) : null,
      h('p', { class: 'muted small' }, webp
        ? 'Verkleinern speichert die Bilder in voller Auflösung im sparsameren WebP-Format: Fotos und Folien werden etwa ein Drittel kleiner, Bildschirmfotos etwa halb so groß – ohne sichtbaren Unterschied. Die anderen Geräte übernehmen die kleineren Bilder beim nächsten Abgleich.'
        : 'Dieser Browser kann Bilder nur als JPEG verkleinern – das komprimiert stärker und begrenzt die Auflösung. Ohne sichtbaren Unterschied geht es am PC in Chrome oder Edge (dort als WebP, etwa ein Drittel kleiner); die anderen Geräte übernehmen das Ergebnis beim Abgleich.'),
      h('p', { class: 'muted small' }, 'Neu importierte PDFs brauchen in der Cloud nur noch die Originaldatei. Die Schätzung oben zählt, was auf diesem Gerät liegt.'));
  };
  draw().catch(err => body.replaceChildren(h('p', {}, 'Fehler: ' + err.message)));
  await modal({ title: 'Speicher', body });
}

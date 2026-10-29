// Navigation in langen Notizen: Seitenübersicht (Miniaturen am linken Rand) und Scroll-Leiste rechts.
// Leistung: Die Scroll-Leiste liest nur die Scrollposition. Miniaturen entstehen nur bei offener Übersicht,
// nur für sichtbare Einträge, eine nach der anderen und nur, wenn gerade nicht gewischt, gezoomt oder
// geschrieben wird. Fertige Miniaturen bleiben auf dem Gerät gespeichert (meta-Speicher, wird nicht
// synchronisiert) und werden nur neu erstellt, wenn sich die Seite geändert hat.
import { store } from './store.js';
import { h } from './ui.js';
import { renderPage } from './cards.js';

const ITEM_H = 132;   // Höhe eines Eintrags in der Übersicht (Bild + Seitenzahl)
const THUMB_W = 76;   // Breite der Miniatur in Bildschirmpunkten
const MAX_RATIO = 1.4; // sehr hohe Seiten: nur der obere Teil

// nächster Frame – mit Ersatz-Zeitgeber, falls gerade keine Frames kommen (Fenster verdeckt)
function frame(fn) {
  let done = false;
  const go = () => { if (done) return; done = true; cancelAnimationFrame(r); clearTimeout(t); fn(); };
  const r = requestAnimationFrame(go), t = setTimeout(go, 120);
  return () => { done = true; cancelAnimationFrame(r); clearTimeout(t); };
}

const sig = p => [p.updatedAt || 0, p.strokes.length, (p.images || []).length, p.bg || '', p.w, p.h].join('|');
const mem = new Map(); // Seiten-id → { sig, url }

async function thumbUrl(page) {
  const s = sig(page), m = mem.get(page.id);
  if (m?.sig === s) return m.url;
  let blob = null;
  try { const saved = await store.getMeta('thumb:' + page.id); if (saved?.sig === s) blob = saved.blob; } catch { /* egal */ }
  if (!blob) {
    const dpr = Math.min(2, window.devicePixelRatio || 1), scale = (THUMB_W * dpr) / page.w;
    const region = { x: 0, y: 0, w: page.w, h: Math.min(page.h, page.w * MAX_RATIO) };
    const c = await renderPage(page, { scale, region });
    blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.7));
    c.width = c.height = 0;
    if (!blob) return null;
    try { await store.setMeta('thumb:' + page.id, { sig: s, blob }); } catch { /* egal */ }
  }
  if (m?.url) URL.revokeObjectURL(m.url);
  const url = URL.createObjectURL(blob);
  mem.set(page.id, { sig: s, url });
  return url;
}

// api: { body, stage, scroller, pages(), current(), jump(i), busy(), touch(e), pen(e), grabbed() }
export function createPageNav(api) {
  // ---------- Scroll-Leiste ----------
  const knob = h('div', { class: 'scrub-knob' });
  const bubble = h('div', { class: 'scrub-bubble' });
  const scrub = h('div', { class: 'scrub' }, knob, bubble);
  api.stage.append(scrub);
  let dragging = null, hideT = 0;
  const range = () => Math.max(1, api.scroller.scrollHeight - api.scroller.clientHeight);
  function placeKnob() {
    const sc = api.scroller, long = sc.scrollHeight > sc.clientHeight * 2.5;
    scrub.classList.toggle('on', long);
    if (!long) return;
    const track = scrub.clientHeight - knob.offsetHeight;
    knob.style.transform = `translateY(${Math.round((sc.scrollTop / range()) * track)}px)`;
  }
  function label() {
    const n = api.pages().length;
    bubble.textContent = n > 1 ? `Seite ${api.current() + 1} / ${n}` : Math.round((api.scroller.scrollTop / range()) * 100) + ' %';
  }
  function scrubTo(clientY) {
    const r = scrub.getBoundingClientRect(), track = r.height - knob.offsetHeight;
    const f = Math.min(1, Math.max(0, (clientY - r.top - dragging.grab) / Math.max(1, track)));
    api.scroller.scrollTop = f * range();
    bubble.style.transform = `translateY(${Math.round(f * track)}px)`;
    label();
  }
  // Die Maus zieht sofort. Ein Finger muss den Griff kurz festhalten (wie bei iOS): Ein normaler Wisch, der
  // zufällig am rechten Rand auf dem Griff beginnt, scrollt wie überall – vorher sprang die Notiz dabei um viele
  // Seiten. Der Pencil schreibt auf der Seite darunter weiter.
  const HOLD_MS = 250;
  let hold = null; // Finger liegt auf dem Griff, noch nicht gegriffen
  function grab(id, y) {
    dragging = { id, grab: y - knob.getBoundingClientRect().top };
    scrub.classList.add('drag');
    clearTimeout(hideT);
  }
  knob.addEventListener('pointerdown', e => {
    if (e.pointerType === 'pen') { api.pen?.(e); return; }
    e.preventDefault();
    e.stopPropagation();
    try { knob.setPointerCapture(e.pointerId); } catch { /* egal */ }
    if (e.pointerType !== 'touch') { grab(e.pointerId, e.clientY); return; }
    clearTimeout(hold?.timer);
    const h0 = { id: e.pointerId, x: e.clientX, y: e.clientY };
    h0.timer = setTimeout(() => {
      if (hold !== h0) return;
      hold = null;
      api.grabbed?.(); // begonnenes Wischen abbrechen
      grab(h0.id, h0.y);
      const track = scrub.clientHeight - knob.offsetHeight;
      bubble.style.transform = `translateY(${Math.round((api.scroller.scrollTop / range()) * track)}px)`;
      label();
    }, HOLD_MS);
    hold = h0;
  });
  knob.addEventListener('pointermove', e => {
    if (hold?.id === e.pointerId && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 8) { clearTimeout(hold.timer); hold = null; } // gewischt
    if (dragging?.id === e.pointerId) scrubTo(e.clientY);
  });
  // Finger-Ereignisse auf dem Griff steuern die Notiz wie überall (wischen, zoomen) – außer der Griff ist gepackt
  for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    knob.addEventListener(t, e => { if (dragging) { if (e.cancelable) e.preventDefault(); } else api.touch?.(e); }, { passive: false });
  }
  const end = e => {
    if (hold?.id === e.pointerId) { clearTimeout(hold.timer); hold = null; }
    if (dragging?.id !== e.pointerId) return;
    dragging = null;
    hideT = setTimeout(() => scrub.classList.remove('drag'), 600);
  };
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);
  // App verlassen, während der Griff gepackt ist: „Finger hoch“ kommt dann nie an – loslassen
  const onVis = () => {
    if (document.visibilityState !== 'hidden') return;
    clearTimeout(hold?.timer);
    hold = dragging = null;
    scrub.classList.remove('drag');
  };
  document.addEventListener('visibilitychange', onVis);

  // ---------- Seitenübersicht ----------
  const list = h('div', { class: 'thumbs-list' });
  const side = h('aside', { class: 'thumbs', 'aria-label': 'Seitenübersicht' }, list);
  api.body.prepend(side);
  const items = new Map(); // Index → Element
  let open = false, active = -1, userScroll = 0, queueT = 0;

  function drawList() {
    const pages = api.pages();
    list.style.height = pages.length * ITEM_H + 'px';
    const first = Math.max(0, Math.floor(side.scrollTop / ITEM_H) - 3);
    const last = Math.min(pages.length - 1, Math.ceil((side.scrollTop + side.clientHeight) / ITEM_H) + 3);
    for (const [i, el] of items) if (i < first || i > last || el.dataset.id !== pages[i]?.id) { el.remove(); items.delete(i); }
    for (let i = first; i <= last; i++) {
      if (items.has(i)) continue;
      const p = pages[i], m = mem.get(p.id);
      const img = h('img', { alt: '', draggable: 'false' });
      if (m?.sig === sig(p)) img.src = m.url;
      const el = h('button', { class: 'thumb' + (i === active ? ' on' : ''), type: 'button', 'data-id': p.id, style: { top: i * ITEM_H + 'px' }, onclick: () => api.jump(i) },
        h('span', { class: 'thumb-img' }, img), h('span', { class: 'thumb-num' }, String(i + 1)));
      list.append(el);
      items.set(i, el);
    }
    scheduleThumbs();
  }
  // fehlende Miniaturen der sichtbaren Einträge nacheinander erstellen – nur in Ruhephasen
  function scheduleThumbs() {
    if (!open || queueT) return;
    queueT = setTimeout(async () => {
      queueT = 0;
      if (!open) return;
      if (api.busy()) { scheduleThumbs(); return; }
      const pages = api.pages();
      const next = [...items.entries()].sort((a, b) => Math.abs(a[0] - active) - Math.abs(b[0] - active))
        .find(([i, el]) => !el.querySelector('img').getAttribute('src') && pages[i]);
      if (!next) return;
      const [i, el] = next;
      try {
        const url = await thumbUrl(pages[i]);
        if (url && items.get(i) === el) el.querySelector('img').src = url;
        else if (!url) el.querySelector('img').setAttribute('src', 'data:,');
      } catch (err) { console.warn('Miniatur', err); el.querySelector('img').setAttribute('src', 'data:,'); }
      scheduleThumbs();
    }, 40);
  }
  let autoTop = -1; // zuletzt von der App selbst gesetzte Position – das zählt nicht als Scrollen von Hand
  side.addEventListener('scroll', () => { if (Math.abs(side.scrollTop - autoTop) > 2) userScroll = Date.now(); frame(drawList); }, { passive: true });

  function markActive() {
    const i = api.current();
    if (i === active) return;
    items.get(active)?.classList.remove('on');
    active = i;
    items.get(i)?.classList.add('on');
    // aktuelle Seite in der Übersicht sichtbar halten (außer man scrollt dort gerade selbst)
    if (open && Date.now() - userScroll > 1500) {
      const top = i * ITEM_H;
      if (top < side.scrollTop || top + ITEM_H > side.scrollTop + side.clientHeight) {
        side.scrollTop = Math.max(0, top - side.clientHeight / 2 + ITEM_H / 2);
        autoTop = side.scrollTop;
      }
    }
  }

  let rafQ = null;
  return {
    // bei jedem Scrollen der Notiz (gedrosselt auf einen Frame)
    update() {
      if (rafQ) return;
      rafQ = frame(() => {
        rafQ = null;
        if (!dragging) placeKnob();
        if (open) { markActive(); drawList(); }
      });
    },
    get open() { return open; },
    setOpen(v) {
      open = !!v;
      side.classList.toggle('on', open);
      // erst die volle Höhe der Liste, dann zur aktuellen Seite – sonst bleibt die Liste bei Seite 1 stehen
      if (open) { list.style.height = api.pages().length * ITEM_H + 'px'; userScroll = 0; active = -1; markActive(); frame(drawList); }
      else { for (const el of items.values()) el.remove(); items.clear(); }
    },
    refresh() { for (const el of items.values()) el.remove(); items.clear(); if (open) drawList(); placeKnob(); },
    destroy() {
      clearTimeout(queueT);
      clearTimeout(hideT);
      clearTimeout(hold?.timer);
      document.removeEventListener('visibilitychange', onVis);
      rafQ?.();
      open = false;
      for (const m of mem.values()) URL.revokeObjectURL(m.url);
      mem.clear();
      side.remove();
      scrub.remove();
    },
  };
}

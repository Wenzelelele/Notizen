// Abdeck-Editor: Rechtecke über Beschriftungen/Bereiche einer Abbildung ziehen.
// Jeder Bereich wird eine Karteikarte (siehe cards.js, nb.occl). Route: #abdecken/neu (Entwurf) oder #abdecken/<karten-id>.
import { store, uid, newNotebook } from './store.js';
import { h, icon, toast, seg } from './ui.js';
import { newSrs } from './srs.js';
import { loadOcclusionImage, occlusionThumb, MASK, cardFolderFor } from './cards.js';

export const DRAFT_KEY = 'notizen.occlDraft';
export const NEW_RETURN = 'notizen.return:occl';

// Neue Abdeck-Karte vorbereiten: Bild ist schon gespeichert (key), dann zum Editor wechseln
export function startOcclusion({ key, w, h, folderId = null, source = null, returnTo = '' }) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ image: { key, w, h }, folderId, source }));
    sessionStorage.setItem(NEW_RETURN, returnTo);
  } catch { /* egal */ }
  location.hash = 'abdecken/neu';
}

export async function showOcclusion(root, id) {
  const isNew = id === 'neu';
  let image, mode = 'all', masks = [], folderId = null, source = null, groupId, group = [];
  if (isNew) {
    let draft = null;
    try { draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY)); } catch { /* egal */ }
    if (!draft) { location.hash = ''; return null; }
    ({ image, folderId, source } = draft);
    groupId = uid();
  } else {
    const c = await store.get('notebooks', id);
    if (!c?.occl) { location.hash = ''; return null; }
    groupId = c.occl.group;
    group = (await store.getAll('notebooks')).filter(n => n.occl?.group === groupId);
    ({ image, mode } = c.occl);
    masks = c.occl.masks.map(m => ({ ...m }));
    folderId = c.folderId;
    source = c.source || null;
  }
  const returnKey = isNew ? NEW_RETURN : 'notizen.return:' + id;
  const bitmap = await loadOcclusionImage({ image });
  let sel = null, drag = null, scale = 1;

  const canvas = h('canvas', { class: 'oc-canvas' });
  const stage = h('div', { class: 'oc-stage' }, canvas);
  const delBtn = h('button', { class: 'ibtn', title: 'Bereich löschen', 'aria-label': 'Bereich löschen', onclick: removeSelected }, icon('trash'));
  const doneBtn = h('button', { class: 'btn primary', onclick: save });
  const wrap = h('div', { class: 'occl' },
    h('header', { class: 'ed-top' },
      h('button', { class: 'ibtn', title: 'Abbrechen', 'aria-label': 'Abbrechen', onclick: cancel }, icon('back')),
      h('div', { class: 'ed-title' }, 'Bereiche verdecken'),
      h('div', { class: 'grow' }),
      seg([['all', 'Andere verdeckt'], ['one', 'Andere sichtbar']], mode, v => { mode = v; }),
      delBtn, doneBtn),
    h('div', { class: 'oc-hint muted small' }, 'Zieh Rechtecke über alles, was abgefragt werden soll – jeder Bereich wird eine Karte. Antippen wählt aus, Ziehen verschiebt.'),
    stage);
  root.replaceChildren(wrap);

  function layout() {
    const aw = Math.max(100, stage.clientWidth - 32), ah = Math.max(100, stage.clientHeight - 32), dpr = window.devicePixelRatio || 1;
    scale = Math.min(aw / image.w, ah / image.h, 3);
    canvas.style.width = image.w * scale + 'px';
    canvas.style.height = image.h * scale + 'px';
    canvas.width = Math.round(image.w * scale * dpr);
    canvas.height = Math.round(image.h * scale * dpr);
    draw();
  }
  function draw() {
    const dpr = window.devicePixelRatio || 1, k = scale * dpr, ctx = canvas.getContext('2d');
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, image.w, image.h);
    if (bitmap) ctx.drawImage(bitmap, 0, 0, image.w, image.h);
    const px = 1 / k;
    masks.forEach((m, i) => {
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = MASK.other;
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.globalAlpha = 1;
      ctx.lineWidth = (m.id === sel ? 3 : 1.5) * px * dpr;
      ctx.strokeStyle = m.id === sel ? '#2f6fed' : '#b07a10';
      ctx.strokeRect(m.x, m.y, m.w, m.h);
      ctx.fillStyle = '#5a3d00';
      ctx.font = `700 ${Math.min(m.h * 0.6, 14 * px * dpr)}px -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), m.x + m.w / 2, m.y + m.h / 2);
    });
    if (drag?.mode === 'new') {
      const r = norm(drag.start, drag.cur);
      ctx.setLineDash([6 * px * dpr, 4 * px * dpr]);
      ctx.lineWidth = 2 * px * dpr;
      ctx.strokeStyle = '#2f6fed';
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
    }
    delBtn.disabled = !sel;
    doneBtn.textContent = masks.length ? `Fertig (${masks.length} ${masks.length === 1 ? 'Karte' : 'Karten'})` : 'Fertig';
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function toImg(e) {
    const r = canvas.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / scale, 0, image.w), y: clamp((e.clientY - r.top) / scale, 0, image.h) };
  }
  const norm = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  const hit = p => [...masks].reverse().find(m => p.x >= m.x && p.x <= m.x + m.w && p.y >= m.y && p.y <= m.y + m.h);

  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* egal */ }
    const p = toImg(e), m = hit(p);
    if (m) { sel = m.id; drag = { mode: 'move', id: e.pointerId, m, start: p, ox: m.x, oy: m.y }; }
    else { sel = null; drag = { mode: 'new', id: e.pointerId, start: p, cur: p }; }
    draw();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const p = toImg(e);
    if (drag.mode === 'move') {
      drag.m.x = clamp(drag.ox + p.x - drag.start.x, 0, image.w - drag.m.w);
      drag.m.y = clamp(drag.oy + p.y - drag.start.y, 0, image.h - drag.m.h);
    } else drag.cur = p;
    draw();
  });
  const up = e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.mode === 'new') {
      const r = norm(drag.start, drag.cur);
      if (r.w >= 8 && r.h >= 6) { const m = { id: uid(), ...r }; masks.push(m); sel = m.id; }
    }
    drag = null;
    draw();
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  function removeSelected() {
    if (!sel) return;
    masks = masks.filter(m => m.id !== sel);
    sel = null;
    draw();
  }

  function leave() {
    let ret = '';
    try { ret = sessionStorage.getItem(returnKey) || ''; sessionStorage.removeItem(returnKey); } catch { /* egal */ }
    location.hash = ret;
  }
  async function cancel() {
    if (isNew) { await store.delBlob(image.key); try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* egal */ } }
    leave();
  }
  async function save() {
    if (!masks.length) { toast('Zieh mindestens einen Bereich auf, der verdeckt werden soll.'); return; }
    doneBtn.disabled = true;
    const byMask = new Map(group.map(c => [c.occl.target, c]));
    const keep = new Set(masks.map(m => m.id));
    const base = { group: groupId, image, masks: masks.map(m => ({ id: m.id, x: m.x, y: m.y, w: m.w, h: m.h })), mode };
    folderId = await cardFolderFor(folderId); // neue Karten in den Karteikarten-Ordner des Fachs
    for (const [i, m] of masks.entries()) {
      // Bereich schon vorhanden → Lernstand behalten; neu → neue Karte
      const c = byMask.get(m.id) || Object.assign(newNotebook({ title: 'Abdeck-Karte', folderId, template: 'blank', size: 'card' }), { kind: 'card', srs: newSrs(), source });
      c.occl = { ...base, target: m.id };
      c.order = i;
      c.thumb = await occlusionThumb(c.occl, bitmap);
      await store.put('notebooks', c);
    }
    for (const c of group) if (!keep.has(c.occl.target)) await store.del('notebooks', c.id);
    if (isNew) try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* egal */ }
    toast(`${masks.length} ${masks.length === 1 ? 'Abdeck-Karte' : 'Abdeck-Karten'} gespeichert`);
    leave();
  }

  const onKey = e => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); removeSelected(); }
    else if (e.key === 'Escape') { sel = null; draw(); }
  };
  addEventListener('keydown', onKey);
  const ro = new ResizeObserver(layout);
  ro.observe(stage);
  layout();
  return () => { removeEventListener('keydown', onKey); ro.disconnect(); bitmap?.close?.(); };
}

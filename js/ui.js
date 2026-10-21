// Kleine UI-Bausteine: Elemente, Icons, Menüs, Dialoge, Hinweise.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el[k] = true;
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const ICONS = {
  back: '<path d="m15 18-6-6 6-6"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  hl: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  lasso: '<path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/><circle cx="5" cy="16" r="2"/>',
  text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  shapes: '<rect x="3" y="3" width="8" height="8" rx="1"/><circle cx="17" cy="17" r="4"/><path d="M17 3l4 6.5h-8z"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pagePlus: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 12v6M9 15h6"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6M11 8v6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  card: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M8 10h8M8 14h5"/>',
  cardPlus: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M12 9v6M9 12h6"/>',
  learn: '<path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>',
  sync: '<path d="M21 12a9 9 0 0 0-15-6.7L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7"/><path d="M16 16h5v5"/>',
  folderPlus:'<path d="M12 10v6M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  pages: '<rect x="3" y="3" width="7" height="8" rx="1.5"/><rect x="3" y="13" width="7" height="8" rx="1.5"/><path d="M14 5h7M14 9h5M14 15h7M14 19h5"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1.2"/><circle cx="17.5" cy="10.5" r="1.2"/><circle cx="8.5" cy="7.5" r="1.2"/><circle cx="6.5" cy="12.5" r="1.2"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1a1.6 1.6 0 0 1 1.6-1.7H17c3 0 5.5-2.5 5.5-5.5C22 6 17.5 2 12 2z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  arrowUp: '<path d="m18 15-6-6-6 6"/>',
  arrowDown: '<path d="m6 9 6 6 6-6"/>',
  sparkle: '<path d="M11 3.5 12.9 9l5.6 1.9-5.6 1.9L11 18.5l-1.9-5.7-5.6-1.9L9.1 9z"/><path d="M19 3v4M17 5h4M18.5 16.5v3M17 18h3"/>',
};

export function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return t.content.firstChild;
}

// ---------- Menü ----------

let openMenu = null;
export function closeMenus() {
  if (!openMenu) return;
  openMenu.m.remove();
  document.removeEventListener('pointerdown', openMenu.outside, true);
  openMenu = null;
}

export function menu(anchor, items) {
  closeMenus();
  const m = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) m.append(h('hr'));
    else if (it.header) m.append(h('div', { class: 'hdr' }, it.header));
    else if (it.swatches) m.append(h('div', { class: 'menu-swatches' }, it.swatches.map(c =>
      h('button', { class: 'swatch', style: { background: c }, 'aria-label': c, onclick: () => { closeMenus(); it.onPick(c); } }))));
    else m.append(h('button', { class: it.danger ? 'danger' : '', role: 'menuitem', onclick: e => { closeMenus(); it.onClick(e); } },
      it.icon ? icon(it.icon) : h('span', { class: 'mi-space' }),
      h('span', { class: 'grow' }, it.label),
      it.checked ? icon('check') : null));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const x = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8));
  let y = r.bottom + 6;
  if (y + m.offsetHeight > innerHeight - 8) y = Math.max(8, r.top - m.offsetHeight - 6);
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  const outside = e => { if (!m.contains(e.target)) closeMenus(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  openMenu = { m, outside };
}

// ---------- Dialoge ----------

export function modal({ title, body, actions = [{ label: 'OK', value: true, primary: true }], onOpen }) {
  return new Promise(resolve => {
    let done = false, back;
    const val = a => (typeof a.value === 'function' ? a.value() : a.value);
    const close = v => {
      if (done) return;
      done = true;
      back.remove();
      removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        const p = actions.find(a => a.primary);
        if (p) { e.preventDefault(); close(val(p)); }
      }
    };
    const content = typeof body === 'function' ? body(close) : body;
    back = h('div', { class: 'modal-back' },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        title && h('h2', {}, title),
        content,
        h('div', { class: 'modal-actions' }, actions.map(a =>
          h('button', { class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), onclick: () => close(val(a)) }, a.label)))));
    back.addEventListener('pointerdown', e => { if (e.target === back) close(null); });
    addEventListener('keydown', onKey, true);
    document.body.append(back);
    onOpen?.();
  });
}

export const confirmDialog = (title, text, okLabel = 'OK', danger = false) => modal({
  title,
  body: h('p', { class: 'muted' }, text),
  actions: [{ label: 'Abbrechen', value: false }, { label: okLabel, value: true, primary: true, danger }],
});

export function promptText(title, value = '', placeholder = '') {
  const input = h('input', { class: 'input', value, placeholder });
  return modal({
    title,
    body: input,
    actions: [{ label: 'Abbrechen', value: null }, { label: 'OK', primary: true, value: () => input.value.trim() }],
    onOpen: () => { input.focus(); input.select(); },
  });
}

export function progress(title) {
  const txt = h('div', { class: 'muted small' }), bar = h('i');
  const back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', {}, title), txt, h('div', { class: 'bar' }, bar)));
  document.body.append(back);
  return {
    set(t, f) { txt.textContent = t; if (f != null) bar.style.width = Math.round(f * 100) + '%'; },
    close() { back.remove(); },
  };
}

export function seg(options, value, onChange, render, cls = '') {
  const wrap = h('div', { class: 'segc ' + cls });
  const draw = () => wrap.replaceChildren(...options.map(([v, label]) =>
    h('button', { type: 'button', class: (v === value ? 'on ' : '') + (render ? 'rich' : ''), onclick: () => { value = v; onChange(v); draw(); } },
      render ? render(v) : null, label)));
  draw();
  return wrap;
}

export const field = (label, el) => h('div', { class: 'field' }, h('span', {}, label), el);

let toastT;
export function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastT);
  toastT = setTimeout(() => t.remove(), 2800);
}

// Muss direkt im Klick-Handler aufgerufen werden (iPad erlaubt den Dateidialog nur dann).
export function pickFiles(accept, multiple = false) {
  return new Promise(resolve => {
    const inp = h('input', { type: 'file', accept, multiple, class: 'vh' });
    inp.addEventListener('change', () => { resolve([...inp.files]); inp.remove(); });
    inp.addEventListener('cancel', () => { resolve([]); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const safeName = s => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Notizbuch';

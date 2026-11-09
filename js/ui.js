// ui.js — tiny DOM helpers and formatters. Everything user-typed goes through textContent, never innerHTML.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  } else if (attrs != null) {
    children.unshift(attrs);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function svg(tag, attrs, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

/** Safe external link: only http(s) URLs become links, anything else is shown as text. */
export function link(url, text) {
  const t = text || url;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      return h('a', { href: u.href, target: '_blank', rel: 'noopener noreferrer' }, t);
    }
  } catch {
    /* not a URL */
  }
  return h('span', null, t);
}

// ---------------------------------------------------------------- formatting

const ZERO_DEC = new Set(['KRW', 'JPY']);

export function fmtMoney(v, ccy = '', opts = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  const dec = opts.decimals ?? (ZERO_DEC.has(ccy) ? 0 : Math.abs(v) < 10 && opts.price ? 4 : 2);
  const s = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const sign = v < 0 ? '−' : opts.plus && v > 0 ? '+' : '';
  const sym = { USD: '$', GBP: '£', EUR: '€', KRW: '₩', JPY: '¥', GBX: 'p' }[ccy];
  if (ccy === 'GBX') return `${sign}${s}p`;
  return sym ? `${sign}${sym}${s}` : `${sign}${s}${ccy ? ' ' + ccy : ''}`;
}

export function fmtPct(v, opts = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  const dec = opts.decimals ?? 2;
  const sign = v < 0 ? '−' : opts.plus && v > 0 ? '+' : '';
  return `${sign}${(Math.abs(v) * 100).toFixed(dec)}%`;
}

export function fmtNum(v, dec = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: dec });
}

export function fmtX(v) {
  return v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(2)}×`;
}

export function ago(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function pnlClass(v) {
  if (v == null || !Number.isFinite(v) || v === 0) return 'neutral';
  return v > 0 ? 'pos' : 'neg';
}

// ---------------------------------------------------------------- forms

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function input(attrs) {
  return h('input', { type: 'text', ...attrs });
}

export function select(options, value, attrs = {}) {
  const s = h('select', attrs);
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label);
    if (String(o.value) === String(value)) opt.selected = true;
    s.append(opt);
  }
  return s;
}

export function button(label, onClick, cls = '') {
  return h('button', { type: 'button', class: `btn ${cls}`.trim(), onClick }, label);
}

export function numVal(el, d = 0) {
  const v = parseFloat(String(el.value).replace(/,/g, ''));
  return Number.isFinite(v) ? v : d;
}

// ---------------------------------------------------------------- modal / toast

export function modal(title, bodyEl, { wide = false, onClose } = {}) {
  const closeIt = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') closeIt();
  };
  const overlay = h(
    'div',
    { class: 'overlay', onClick: (e) => e.target === overlay && closeIt() },
    h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', null, title), button('✕', closeIt, 'icon')),
      h('div', { class: 'modal-body' }, bodyEl)),
  );
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  return { close: closeIt, el: overlay };
}

let toastTimer = null;
export function toast(msg, kind = 'info') {
  let t = document.getElementById('toast');
  if (!t) {
    t = h('div', { id: 'toast', role: 'status' });
    document.body.append(t);
  }
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3500);
}

export function confirmDialog(msg) {
  return new Promise((resolve) => {
    const m = modal('Please confirm', h('div', null, h('p', null, msg), h('div', { class: 'row end' }, button('Cancel', () => { m.close(); resolve(false); }), button('Confirm', () => { m.close(); resolve(true); }, 'danger'))));
  });
}

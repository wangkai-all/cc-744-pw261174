/** Small DOM helpers — no framework. */

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'html') el.innerHTML = value;
      else if (key === 'text') el.textContent = value;
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('zh-CN').format(n);
}

export function signed(n) {
  if (n === null || n === undefined) return '—';
  return n > 0 ? `+${fmt(n)}` : fmt(n);
}

const ITEM_COLORS = {
  A: 'var(--item-a)',
  T: 'var(--item-t)',
  C: 'var(--item-c)',
};

export function itemColor(itemId, index = 0) {
  if (ITEM_COLORS[itemId]) return ITEM_COLORS[itemId];
  return ['var(--item-a)', 'var(--item-t)', 'var(--item-c)'][index % 3];
}

export function itemPill(market, itemId) {
  const item = market.itemById.get(itemId);
  const idx = market.items.findIndex((i) => i.id === itemId);
  return h(
    'span',
    { class: 'pill item', title: item?.desc || '' },
    h('span', { class: 'dot', style: { background: itemColor(itemId, idx) } }),
    item ? `${item.name}` : itemId,
  );
}

const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => escapeMap[c]);
}

export function download(filename, content, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function focusTrap(container) {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function onKey(event) {
    if (event.key !== 'Tab') return;
    const nodes = [...container.querySelectorAll(selector)].filter((n) => n.offsetParent !== null);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  container.addEventListener('keydown', onKey);
  return () => container.removeEventListener('keydown', onKey);
}

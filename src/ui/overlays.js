import { h, mount, focusTrap, clear, itemPill } from './dom.js';

let toastTimer = null;

export function toast(message, kind = '') {
  const root = document.getElementById('toast-root');
  while (root.children.length >= 2) root.firstElementChild.remove();
  const el = h('div', { class: `toast ${kind}`.trim() }, message);
  root.append(el);
  setTimeout(() => el.remove(), 3600);
}

export function closeOverlay() {
  const drawerRoot = document.getElementById('drawer-root');
  const modalRoot = document.getElementById('modal-root');
  clear(drawerRoot);
  clear(modalRoot);
  document.body.style.overflow = '';
  window.__overlayCleanup?.();
  window.__overlayCleanup = null;
}

/**
 * Drawer used for quote explanations and payment details.
 * `build(close)` returns the body content.
 */
export function openDrawer({ title, subtitle, build, onClose }) {
  closeOverlay();
  const root = document.getElementById('drawer-root');
  const body = h('div', { class: 'drawer-body' });
  const close = () => {
    closeOverlay();
    onClose?.();
  };
  const drawer = h(
    'div',
    { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
    h(
      'div',
      { class: 'drawer-head' },
      h(
        'div',
        null,
        h('h2', null, title),
        subtitle ? h('div', { class: 'sub' }, subtitle) : null,
      ),
      h(
        'button',
        { class: 'icon-btn', type: 'button', 'aria-label': '关闭', onclick: close },
        h('span', { html: '✕', 'aria-hidden': 'true' }),
      ),
    ),
    body,
  );
  const backdrop = h('div', { class: 'drawer-backdrop', onclick: close });
  mount(body, build(close));
  root.append(backdrop, drawer);
  document.body.style.overflow = 'hidden';
  const releaseTrap = focusTrap(drawer);
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  window.__overlayCleanup = () => {
    document.removeEventListener('keydown', onKey);
    releaseTrap();
  };
  requestAnimationFrame(() => {
    (drawer.querySelector('button, [href], input, select') || drawer).focus();
  });
  return close;
}

export function openModal({ title, subtitle, build, onClose, width }) {
  closeOverlay();
  const root = document.getElementById('modal-root');
  const close = () => {
    closeOverlay();
    onClose?.();
  };
  const modal = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1', style: width ? { width } : undefined },
    h(
      'div',
      { class: 'drawer-head' },
      h('div', null, h('h2', null, title), subtitle ? h('div', { class: 'sub' }, subtitle) : null),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭', onclick: close }, h('span', { html: '✕', 'aria-hidden': 'true' })),
    ),
    h('div', { class: 'drawer-body' }, build(close)),
  );
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (event) => {
    if (event.target === event.currentTarget) close();
  } }, modal);
  root.append(backdrop);
  document.body.style.overflow = 'hidden';
  const releaseTrap = focusTrap(modal);
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  window.__overlayCleanup = () => {
    document.removeEventListener('keydown', onKey);
    releaseTrap();
  };
  requestAnimationFrame(() => {
    (modal.querySelector('button, [href], input, select') || modal).focus();
  });
  return close;
}

/** Attach a lightweight tooltip to an element. */
export function tooltip(el, content) {
  const tip = document.getElementById('tooltip');
  let text = content;
  const show = (event) => {
    tip.innerHTML = '';
    const lines = Array.isArray(text) ? text : [text];
    for (const line of lines) {
      const div = document.createElement('div');
      div.innerHTML = line;
      tip.append(div);
    }
    tip.hidden = false;
    move(event);
  };
  const move = (event) => {
    const pad = 12;
    const rect = tip.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  };
  const hide = () => {
    tip.hidden = true;
  };
  el.addEventListener('mouseenter', show);
  el.addEventListener('mousemove', move);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('focus', (event) => {
    const rect = el.getBoundingClientRect();
    show({ clientX: rect.left + rect.width / 2, clientY: rect.bottom });
  });
  el.addEventListener('blur', hide);
}

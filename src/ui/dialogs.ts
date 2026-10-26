import { h } from './dom';
import { icon, type IconName } from './icons';

let toastTimer = 0;

export function toast(msg: string, ms = 1800) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), ms);
}

export interface ModalHandle {
  el: HTMLElement;
  close: () => void;
}

/** Bottom-sheet / centred modal. Resolves when closed. */
export function modal(title: string, body: Node, opts: { wide?: boolean; onClose?: () => void; actions?: HTMLElement[] } = {}): ModalHandle {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  const sheet = h(
    'div',
    { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': '閉じる', onclick: close }, icon('close'))),
    h('div', { class: 'modal-body' }, body),
    opts.actions?.length ? h('div', { class: 'modal-actions' }, opts.actions) : null,
  );
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.appendChild(sheet);
  document.body.appendChild(backdrop);
  return { el: sheet, close };
}

export function confirmDialog(title: string, message: string, ok = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const okBtn = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => ((result = true), m.close()) }, ok);
    const cancel = h('button', { class: 'btn', onclick: () => m.close() }, 'キャンセル');
    const m = modal(title, h('p', { class: 'muted' }, message), { actions: [cancel, okBtn], onClose: () => resolve(result) });
    okBtn.focus();
  });
}

export function promptDialog(title: string, value = '', placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h('input', { class: 'input', value, placeholder, enterkeyhint: 'done' });
    const submit = () => {
      result = input.value.trim();
      m.close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    const m = modal(title, input, {
      actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'キャンセル'), h('button', { class: 'btn primary', onclick: submit }, 'OK')],
      onClose: () => resolve(result),
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  onClick: () => void;
}

/** Popover menu anchored to an element. */
export function popover(anchor: HTMLElement | { x: number; y: number }, content: HTMLElement, cls = ''): () => void {
  const layer = h('div', { class: 'popover-layer' });
  const pop = h('div', { class: 'popover ' + cls }, content);
  layer.appendChild(pop);
  const close = () => {
    layer.remove();
    window.removeEventListener('resize', close);
  };
  layer.addEventListener('pointerdown', (e) => {
    if (e.target === layer) {
      e.preventDefault();
      close();
    }
  });
  window.addEventListener('resize', close);
  document.body.appendChild(layer);
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = r.left + r.width / 2 - pw / 2;
  let y = r.bottom + 8;
  if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 8);
  x = Math.max(8, Math.min(window.innerWidth - pw - 8, x));
  pop.style.left = `${x}px`;
  pop.style.top = `${y}px`;
  return close;
}

export function menu(anchor: HTMLElement | { x: number; y: number }, items: (MenuItem | null)[]): () => void {
  const list = h('div', { class: 'menu', role: 'menu' });
  let close = () => {};
  for (const it of items) {
    if (!it) {
      list.appendChild(h('div', { class: 'menu-sep' }));
      continue;
    }
    list.appendChild(
      h(
        'button',
        {
          class: 'menu-item' + (it.danger ? ' danger' : ''),
          role: 'menuitem',
          disabled: it.disabled,
          onclick: () => {
            close();
            it.onClick();
          },
        },
        it.icon ? icon(it.icon, 18) : h('span', { class: 'menu-icon-gap' }),
        h('span', null, it.label),
        it.checked ? icon('check', 16) : null,
      ),
    );
  }
  close = popover(anchor, list, 'menu-pop');
  return close;
}

/** Open the system file picker. */
export function pickFiles(accept: string, opts: { multiple?: boolean; capture?: string } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: 'display:none' });
    if (opts.multiple) input.multiple = true;
    if (opts.capture) input.setAttribute('capture', opts.capture);
    let done = false;
    input.addEventListener('change', () => {
      done = true;
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    // Resolve empty if the picker is dismissed.
    window.addEventListener(
      'focus',
      () =>
        setTimeout(() => {
          if (!done) {
            resolve([]);
            input.remove();
          }
        }, 1500),
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: 'display:none' });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 4000);
}

/** Share a file through the Android share sheet when possible, else download it. */
export async function shareOrDownload(blob: Blob, name: string) {
  const file = new File([blob], name, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name });
      return;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return;
    }
  }
  downloadBlob(blob, name);
}

export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'note';
}

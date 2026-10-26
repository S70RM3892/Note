import { h } from '../ui/dom';

const KEY = 'sumi.redsheet';

interface SheetRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 赤シート. A multiply-blended pure red overlay keeps only the red channel of what is
 * underneath: red/orange ink becomes the same red as the paper and disappears, black
 * ink stays black, and the 暗記グリーン highlighter turns black and hides the text on it.
 * The sheet ignores the pen (you can keep writing under it); drag it by its grip.
 */
export class RedSheet {
  private el: HTMLElement | null = null;
  private rect: SheetRect = { x: 0.08, y: 0.45, w: 0.84, h: 0.32 }; // fractions of the host

  constructor(private host: HTMLElement) {
    try {
      const r = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (r) this.rect = r;
    } catch {
      /* ignore */
    }
  }

  get visible() {
    return !!this.el;
  }

  toggle(): boolean {
    if (this.el) this.hide();
    else this.show();
    return this.visible;
  }

  hide() {
    this.el?.remove();
    this.el = null;
  }

  show() {
    if (this.el) return;
    const grip = h('div', { class: 'grip' }, '赤シート ⇕ ドラッグで移動');
    const resize = h('div', { class: 'resize' });
    this.el = h('div', { class: 'red-sheet', 'data-testid': 'red-sheet' }, grip, resize);
    this.host.appendChild(this.el);
    this.apply();
    this.drag(grip, (dx, dy, r0) => {
      this.rect.x = r0.x + dx;
      this.rect.y = r0.y + dy;
    });
    this.drag(resize, (dx, dy, r0) => {
      this.rect.w = Math.max(0.15, r0.w + dx);
      this.rect.h = Math.max(0.08, r0.h + dy);
    });
  }

  private apply() {
    if (!this.el) return;
    const r = this.rect;
    Object.assign(this.el.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
  }

  private drag(handle: HTMLElement, onMove: (dx: number, dy: number, r0: SheetRect) => void) {
    let start: { x: number; y: number; r0: SheetRect } | null = null;
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      start = { x: e.clientX, y: e.clientY, r0: { ...this.rect } };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start) return;
      const b = this.host.getBoundingClientRect();
      onMove((e.clientX - start.x) / b.width, (e.clientY - start.y) / b.height, start.r0);
      this.rect.x = Math.min(0.95, Math.max(-this.rect.w + 0.05, this.rect.x));
      this.rect.y = Math.min(0.95, Math.max(0, this.rect.y));
      this.apply();
    });
    const end = () => {
      if (!start) return;
      start = null;
      try {
        localStorage.setItem(KEY, JSON.stringify(this.rect));
      } catch {
        /* ignore */
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}

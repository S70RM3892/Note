import { clamp } from '../core/geometry';
import type { Layout, Page, Rect } from '../core/types';

export const PAGE_GAP = 28;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 10;

/** Camera + page layout. World units = page units; pages are placed in world space. */
export class Viewport {
  zoom = 1;
  camX = 0; // world x at screen left
  camY = 0; // world y at screen top
  width = 1; // CSS px
  height = 1;
  dpr = 1;
  rects: Rect[] = [];
  layoutMode: Layout = 'vertical';
  private bounds: Rect = { x: 0, y: 0, w: 1, h: 1 };

  layout(pages: Page[], mode: Layout) {
    this.layoutMode = mode;
    this.rects = [];
    let cursor = 0;
    for (const p of pages) {
      if (mode === 'vertical') {
        this.rects.push({ x: -p.w / 2, y: cursor, w: p.w, h: p.h });
        cursor += p.h + PAGE_GAP;
      } else {
        this.rects.push({ x: cursor, y: -p.h / 2, w: p.w, h: p.h });
        cursor += p.w + PAGE_GAP;
      }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of this.rects) {
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
    if (minX === Infinity) minX = minY = maxX = maxY = 0;
    this.bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  get contentBounds(): Rect {
    return this.bounds;
  }

  toScreenX(wx: number) {
    return (wx - this.camX) * this.zoom;
  }

  toScreenY(wy: number) {
    return (wy - this.camY) * this.zoom;
  }

  toWorld(sx: number, sy: number) {
    return { x: sx / this.zoom + this.camX, y: sy / this.zoom + this.camY };
  }

  /** Visible world rectangle. */
  get view(): Rect {
    return { x: this.camX, y: this.camY, w: this.width / this.zoom, h: this.height / this.zoom };
  }

  pageAt(wx: number, wy: number, slack = 0): number {
    for (let i = 0; i < this.rects.length; i++) {
      const r = this.rects[i];
      if (wx >= r.x - slack && wx <= r.x + r.w + slack && wy >= r.y - slack && wy <= r.y + r.h + slack) return i;
    }
    return -1;
  }

  visiblePages(marginPx = 0): number[] {
    const m = marginPx / this.zoom;
    const v = this.view;
    const out: number[] = [];
    for (let i = 0; i < this.rects.length; i++) {
      const r = this.rects[i];
      if (r.x < v.x + v.w + m && r.x + r.w > v.x - m && r.y < v.y + v.h + m && r.y + r.h > v.y - m) out.push(i);
    }
    return out;
  }

  /** Index of the page that occupies the most of the screen. */
  currentPage(): number {
    const v = this.view;
    let best = 0, bestArea = -1;
    for (const i of this.visiblePages()) {
      const r = this.rects[i];
      const w = Math.min(r.x + r.w, v.x + v.w) - Math.max(r.x, v.x);
      const h = Math.min(r.y + r.h, v.y + v.h) - Math.max(r.y, v.y);
      const a = Math.max(0, w) * Math.max(0, h);
      if (a > bestArea) {
        bestArea = a;
        best = i;
      }
    }
    return best;
  }

  fitZoom(): number {
    const maxW = Math.max(...this.rects.map((r) => r.w), 1);
    if (this.layoutMode === 'vertical') return clamp((this.width - 32) / maxW, MIN_ZOOM, MAX_ZOOM);
    const maxH = Math.max(...this.rects.map((r) => r.h), 1);
    return clamp(Math.min((this.height - 24) / maxH, (this.width - 32) / maxW), MIN_ZOOM, MAX_ZOOM);
  }

  /** Keep the content reachable; center it when it is smaller than the screen. */
  clampCamera() {
    const b = this.bounds;
    const vw = this.width / this.zoom, vh = this.height / this.zoom;
    const margin = 60 / this.zoom;
    if (b.w <= vw) this.camX = b.x + b.w / 2 - vw / 2;
    else this.camX = clamp(this.camX, b.x - margin, b.x + b.w + margin - vw);
    if (this.layoutMode === 'horizontal' && b.h <= vh) this.camY = b.y + b.h / 2 - vh / 2;
    else {
      const extra = this.layoutMode === 'vertical' ? vh * 0.4 : margin;
      this.camY = clamp(this.camY, b.y - margin, Math.max(b.y - margin, b.y + b.h + extra - vh));
    }
  }

  zoomAt(sx: number, sy: number, z: number) {
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const w = this.toWorld(sx, sy);
    this.zoom = z;
    this.camX = w.x - sx / z;
    this.camY = w.y - sy / z;
  }

  /** Scroll so page i is at the top (vertical) or left (horizontal), centred across. */
  scrollToPage(i: number) {
    const r = this.rects[i];
    if (!r) return;
    const vw = this.width / this.zoom, vh = this.height / this.zoom;
    if (this.layoutMode === 'vertical') {
      this.camY = r.y - 12 / this.zoom;
      this.camX = r.x + r.w / 2 - vw / 2;
    } else {
      this.camX = r.w <= vw ? r.x + r.w / 2 - vw / 2 : r.x - 12 / this.zoom;
      this.camY = r.y + r.h / 2 - vh / 2;
    }
    this.clampCamera();
  }
}

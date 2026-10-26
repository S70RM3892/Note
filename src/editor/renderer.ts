import { inflate, rectUnion } from '../core/geometry';
import type { Page, Rect } from '../core/types';
import type { AssetCache } from './assets';
import type { EditorDoc } from './doc';
import { maxScaleFor, paintPage } from './paint';
import type { Viewport } from './viewport';

interface PageCache {
  canvas: HTMLCanvasElement;
  scale: number;
  complete: boolean;
  dirty: Rect | null; // page-space region needing repaint
  dirtyAll: boolean;
  used: number;
}

const CACHE_PIXEL_BUDGET = 72e6;
// Quarter-octave steps: a cache is at most ~19% larger than needed.
const LEVELS = Array.from({ length: 29 }, (_, k) => Math.round(Math.pow(2, (k - 12) / 4) * 1000) / 1000);

function levelFor(target: number): number {
  for (const l of LEVELS) if (l >= target * 0.98) return l;
  return LEVELS[LEVELS.length - 1];
}

export interface RenderHooks {
  /** Ids per page to leave out of caches (they are painted live by `overlay`). */
  skip(pageId: string): Set<string> | undefined;
  /** Paint live objects for a page; ctx is already in page coordinates. */
  overlay(ctx: CanvasRenderingContext2D, page: Page, scale: number): void;
  tapeMode(): 'normal' | 'hide';
}

/** Paints committed content onto the main canvas via per-page bitmap caches. */
export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  private caches = new Map<string, PageCache>();
  private raf = 0;
  /** True while a pinch/pan is running: caches are scaled instead of re-rendered. */
  gesture = false;
  desk = '#e4e5e9';
  shadow = 'rgba(0,0,0,0.16)';
  onFrame: () => void = () => {};

  constructor(
    public canvas: HTMLCanvasElement,
    private vp: Viewport,
    private doc: () => EditorDoc | null,
    private assets: AssetCache,
    private hooks: RenderHooks,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  resize(w: number, h: number, dpr: number) {
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.request();
  }

  /** Mark part of a page's cache stale (null = the whole page). */
  invalidate(pageId: string, region: Rect | null) {
    const c = this.caches.get(pageId);
    if (c) {
      if (!region) c.dirtyAll = true;
      else c.dirty = rectUnion(c.dirty, inflate(region, 2));
    }
    this.request();
  }

  invalidateAll() {
    for (const c of this.caches.values()) c.dirtyAll = true;
    this.request();
  }

  /** Drop cached bitmaps (e.g. after closing a notebook). */
  clear() {
    for (const c of this.caches.values()) c.canvas.width = 0;
    this.caches.clear();
  }

  forget(pageId: string) {
    const c = this.caches.get(pageId);
    if (c) c.canvas.width = 0;
    this.caches.delete(pageId);
  }

  request() {
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  /** Synchronous render (used right before clearing the live layer). */
  renderNow() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.render();
  }

  pageCanvas(pageId: string): HTMLCanvasElement | null {
    return this.caches.get(pageId)?.canvas ?? null;
  }

  private buildCache(page: Page, scale: number, existing?: PageCache): PageCache {
    const w = Math.max(1, Math.round(page.w * scale)), h = Math.max(1, Math.round(page.h * scale));
    const canvas = existing?.canvas ?? document.createElement('canvas');
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d', { alpha: false })!;
    ctx.setTransform(w / page.w, 0, 0, h / page.h, 0, 0);
    const complete = paintPage(ctx, page, { scale, assets: this.assets, skip: this.hooks.skip(page.id), tapes: this.hooks.tapeMode() });
    return { canvas, scale, complete, dirty: null, dirtyAll: false, used: performance.now() };
  }

  private repaintRegion(page: Page, c: PageCache) {
    const ctx = c.canvas.getContext('2d', { alpha: false })!;
    ctx.setTransform(c.canvas.width / page.w, 0, 0, c.canvas.height / page.h, 0, 0);
    const r = c.dirty!;
    // Snap the clip to device pixels to avoid seams.
    const s = c.scale;
    const x0 = Math.floor(r.x * s) / s, y0 = Math.floor(r.y * s) / s;
    const clip = { x: x0, y: y0, w: Math.ceil((r.x + r.w) * s) / s - x0, h: Math.ceil((r.y + r.h) * s) / s - y0 };
    const ok = paintPage(ctx, page, { scale: s, clip, assets: this.assets, skip: this.hooks.skip(page.id), tapes: this.hooks.tapeMode() });
    c.complete = c.complete && ok;
    c.dirty = null;
  }

  private evict(visible: Set<string>) {
    let total = 0;
    for (const c of this.caches.values()) total += c.canvas.width * c.canvas.height;
    if (total <= CACHE_PIXEL_BUDGET) return;
    const entries = [...this.caches.entries()].filter(([id]) => !visible.has(id)).sort((a, b) => a[1].used - b[1].used);
    for (const [id, c] of entries) {
      if (total <= CACHE_PIXEL_BUDGET) break;
      total -= c.canvas.width * c.canvas.height;
      c.canvas.width = 0;
      this.caches.delete(id);
    }
  }

  private render() {
    const doc = this.doc();
    const ctx = this.ctx;
    const vp = this.vp;
    const dpr = vp.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.desk;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!doc) return;
    const z = vp.zoom;
    const target = z * dpr;
    const visibleIdx = vp.visiblePages();
    const visible = new Set(visibleIdx.map((i) => doc.pages[i]?.id));
    let built = 0;
    let deferred = false;
    const now = performance.now();

    for (const i of visibleIdx) {
      const page = doc.pages[i];
      const r = vp.rects[i];
      if (!page || !r) continue;
      const sx = (r.x - vp.camX) * z * dpr, sy = (r.y - vp.camY) * z * dpr;
      const sw = r.w * z * dpr, sh = r.h * z * dpr;
      ctx.fillStyle = this.shadow;
      ctx.fillRect(sx + 1.5 * dpr, sy + 2 * dpr, sw, sh);

      const cap = maxScaleFor(page.w, page.h);
      if (target > cap * 1.02) {
        // Deep zoom: paint vectors for the visible part only.
        const v = vp.view;
        const clip = {
          x: Math.max(0, v.x - r.x) - 1,
          y: Math.max(0, v.y - r.y) - 1,
          w: Math.min(page.w, v.x + v.w - r.x) - Math.max(0, v.x - r.x) + 2,
          h: Math.min(page.h, v.y + v.h - r.y) - Math.max(0, v.y - r.y) + 2,
        };
        const pdfRegion = page.pdf ? this.assets.pdfRegion(page.pdf.asset, page.pdf.index, target, clip, page, !this.gesture) : null;
        ctx.save();
        ctx.setTransform(z * dpr, 0, 0, z * dpr, sx, sy);
        paintPage(ctx, page, { scale: target, clip, assets: this.assets, skip: this.hooks.skip(page.id), tapes: this.hooks.tapeMode(), pdfRegion });
        ctx.restore();
      } else {
        const level = Math.min(levelFor(target), cap);
        let c = this.caches.get(page.id);
        const wrongScale = !!c && Math.abs(c.scale - level) > 1e-3;
        let build = false;
        if (!c) build = built < 2;
        else if (c.dirtyAll) build = true; // content changed: correctness first
        else if (wrongScale) build = !this.gesture && built < 1; // sharpen after the gesture, one page per frame
        if (build) {
          c = this.buildCache(page, level, c);
          this.caches.set(page.id, c);
          built++;
        } else if (!c || wrongScale) deferred = true;
        if (c) {
          if (c.dirty) this.repaintRegion(page, c);
          c.used = now;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = this.gesture ? 'low' : 'medium';
          ctx.drawImage(c.canvas, sx, sy, sw, sh);
        } else {
          ctx.fillStyle = page.pdf ? '#ffffff' : page.bg.color;
          ctx.fillRect(sx, sy, sw, sh);
        }
      }
      ctx.save();
      ctx.setTransform(z * dpr, 0, 0, z * dpr, sx, sy);
      ctx.beginPath();
      ctx.rect(0, 0, page.w, page.h);
      ctx.clip();
      this.hooks.overlay(ctx, page, target);
      ctx.restore();
    }
    this.evict(visible);
    // Deferred builds continue on the next frame; assets that finish loading invalidate their pages.
    if (deferred && !this.gesture) this.request();
    this.onFrame();
  }
}

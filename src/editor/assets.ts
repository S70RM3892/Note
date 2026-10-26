import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { VectorDoc } from '../core/types';
import { openPdf } from '../pdf/pdfjs';
import type { Repo } from '../store/repo';

interface PdfBitmap {
  canvas: HTMLCanvasElement;
  scale: number;
  used: number;
}

const PDF_PIXEL_BUDGET = 48e6;
const REGION_MAX_DIM = 4096;

/** Parsed vector artwork with one Path2D per tile and layer. */
export interface VectorArt {
  doc: VectorDoc;
  paths: { color: string; tiles: { b: [number, number, number, number]; path: Path2D | null; d: string }[] }[];
}

export interface PdfRegion {
  canvas: HTMLCanvasElement;
  scale: number;
  rect: { x: number; y: number; w: number; h: number }; // page units
}

/** Decoded images and rendered PDF pages, shared by all editors. */
export class AssetCache {
  private images = new Map<string, ImageBitmap | null>();
  private vectors = new Map<string, VectorArt | null>();
  private pdfDocs = new Map<string, Promise<PDFDocumentProxy>>();
  private pdfBitmaps = new Map<string, PdfBitmap[]>(); // key asset:index
  private queue: { asset: string; index: number; scale: number }[] = [];
  private running = false;
  private listeners = new Set<(asset: string, index?: number) => void>();
  private regions = new Map<string, PdfRegion>(); // key asset:index, one sharp region per page
  private regionJob: { key: string; asset: string; index: number; scale: number; rect: PdfRegion['rect'] } | null = null;
  private regionRunning = false;

  constructor(private repo: Repo) {}

  subscribe(fn: (asset: string, index?: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Notify that an asset (or one PDF page of it) became available. */
  private emit(asset: string, index?: number) {
    this.listeners.forEach((l) => l(asset, index));
  }

  image(id: string): ImageBitmap | null {
    if (this.images.has(id)) return this.images.get(id) ?? null;
    this.images.set(id, null);
    void (async () => {
      const a = await this.repo.getAsset(id);
      if (!a) return;
      try {
        this.images.set(id, await createImageBitmap(a.blob));
        this.emit(id);
      } catch (e) {
        console.warn('image decode failed', e);
      }
    })();
    return null;
  }

  /** Vector artwork of a scan; null until loaded (subscribers are notified). */
  vector(id: string): VectorArt | null {
    if (this.vectors.has(id)) return this.vectors.get(id) ?? null;
    this.vectors.set(id, null);
    void (async () => {
      const a = await this.repo.getAsset(id);
      if (!a) return;
      try {
        const doc = JSON.parse(await a.blob.text()) as VectorDoc;
        const art: VectorArt = { doc, paths: doc.layers.map((l) => ({ color: l.color, tiles: l.tiles.map((t) => ({ b: t.b, d: t.d, path: null })) })) };
        this.vectors.set(id, art);
        this.emit(id);
      } catch (e) {
        console.warn('vector load failed', e);
      }
    })();
    return null;
  }

  /** Vector artwork, waiting for it to load. */
  async vectorAsync(id: string): Promise<VectorArt | null> {
    const ready = this.vector(id);
    if (ready) return ready;
    const a = await this.repo.getAsset(id);
    if (!a) return null;
    const doc = JSON.parse(await a.blob.text()) as VectorDoc;
    return { doc, paths: doc.layers.map((l) => ({ color: l.color, tiles: l.tiles.map((t) => ({ b: t.b, d: t.d, path: null })) })) };
  }

  pdfDoc(asset: string): Promise<PDFDocumentProxy> {
    let d = this.pdfDocs.get(asset);
    if (!d) {
      d = (async () => {
        const a = await this.repo.getAsset(asset);
        if (!a) throw new Error('PDF not found');
        return openPdf(new Uint8Array(await a.blob.arrayBuffer()));
      })();
      d.catch(() => this.pdfDocs.delete(asset));
      this.pdfDocs.set(asset, d);
    }
    return d;
  }

  /**
   * Best available rendering of a PDF page; schedules a render at `scale`
   * (device pixels per page unit) when nothing close enough exists.
   */
  pdfPage(asset: string, index: number, scale: number): { canvas: HTMLCanvasElement; scale: number } | null {
    const key = asset + ':' + index;
    const list = this.pdfBitmaps.get(key) ?? [];
    let best: PdfBitmap | null = null;
    for (const b of list) {
      if (!best || Math.abs(Math.log(b.scale / scale)) < Math.abs(Math.log(best.scale / scale))) best = b;
    }
    if (best) best.used = performance.now();
    if (!best || best.scale < scale * 0.92) this.request(asset, index, scale);
    return best;
  }

  /**
   * A sharp rendering of part of a PDF page for deep zoom (the whole-page bitmap is
   * capped in size). Returns a ready region covering `want`, or null and schedules one.
   */
  pdfRegion(asset: string, index: number, scale: number, want: PdfRegion['rect'], page: { w: number; h: number }, schedule: boolean): PdfRegion | null {
    const key = asset + ':' + index;
    const r = this.regions.get(key);
    const covers = (a: PdfRegion['rect'], b: PdfRegion['rect']) => a.x <= b.x + 0.5 && a.y <= b.y + 0.5 && a.x + a.w >= b.x + b.w - 0.5 && a.y + a.h >= b.y + b.h - 0.5;
    const ok = r && Math.abs(r.scale / scale - 1) < 0.01 && covers(r.rect, want);
    if (!ok && schedule) {
      // Render a margin around the view so small pans stay sharp.
      const mx = want.w * 0.25, my = want.h * 0.25;
      let x = Math.max(0, want.x - mx), y = Math.max(0, want.y - my);
      let w = Math.min(page.w, want.x + want.w + mx) - x, h = Math.min(page.h, want.y + want.h + my) - y;
      const maxU = REGION_MAX_DIM / scale;
      if (w > maxU) {
        x = Math.max(0, want.x + want.w / 2 - maxU / 2);
        w = maxU;
      }
      if (h > maxU) {
        y = Math.max(0, want.y + want.h / 2 - maxU / 2);
        h = maxU;
      }
      const job = { key, asset, index, scale, rect: { x, y, w, h } };
      const pending = this.regionJob;
      if (!pending || pending.key !== key || Math.abs(pending.scale / scale - 1) > 0.01 || !covers(pending.rect, want)) {
        this.regionJob = job;
        void this.pumpRegion();
      }
    }
    return r && Math.abs(r.scale / scale - 1) < 0.01 ? r : null;
  }

  private async pumpRegion() {
    if (this.regionRunning) return;
    this.regionRunning = true;
    try {
      while (this.regionJob) {
        const job = this.regionJob;
        this.regionJob = null;
        try {
          const doc = await this.pdfDoc(job.asset);
          const page = await doc.getPage(job.index + 1);
          const vp = page.getViewport({ scale: (job.scale * 96) / 72 });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.ceil(job.rect.w * job.scale));
          canvas.height = Math.max(1, Math.ceil(job.rect.h * job.scale));
          await page.render({ canvas, viewport: vp, background: '#ffffff', transform: [1, 0, 0, 1, -job.rect.x * job.scale, -job.rect.y * job.scale] }).promise;
          const old = this.regions.get(job.key);
          if (old) old.canvas.width = 0;
          this.regions.set(job.key, { canvas, scale: job.scale, rect: job.rect });
          // Keep only a few sharp regions around.
          while (this.regions.size > 4) {
            const [k, v] = this.regions.entries().next().value as [string, PdfRegion];
            v.canvas.width = 0;
            this.regions.delete(k);
          }
          this.emit(job.asset, job.index);
        } catch (e) {
          console.warn('pdf region render failed', e);
        }
      }
    } finally {
      this.regionRunning = false;
    }
  }

  private request(asset: string, index: number, scale: number) {
    if (this.queue.some((q) => q.asset === asset && q.index === index && Math.abs(q.scale - scale) < 0.01)) return;
    this.queue.push({ asset, index, scale });
    void this.pump();
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.pop()!; // newest first: that is what is on screen now
        const key = job.asset + ':' + job.index;
        const list = this.pdfBitmaps.get(key) ?? [];
        if (list.some((b) => Math.abs(b.scale - job.scale) < 0.01)) continue;
        try {
          const doc = await this.pdfDoc(job.asset);
          const page = await doc.getPage(job.index + 1);
          const vp = page.getViewport({ scale: (job.scale * 96) / 72 });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.ceil(vp.width));
          canvas.height = Math.max(1, Math.ceil(vp.height));
          await page.render({ canvas, viewport: vp, background: '#ffffff' }).promise;
          page.cleanup();
          // Keep at most two resolutions per page.
          list.push({ canvas, scale: job.scale, used: performance.now() });
          list.sort((a, b) => b.used - a.used);
          while (list.length > 2) list.pop()!.canvas.width = 0;
          this.pdfBitmaps.set(key, list);
          this.evict();
          this.emit(job.asset, job.index);
        } catch (e) {
          console.warn('pdf render failed', e);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private evict() {
    const all: { key: string; b: PdfBitmap }[] = [];
    for (const [key, list] of this.pdfBitmaps) for (const b of list) all.push({ key, b });
    let total = all.reduce((s, x) => s + x.b.canvas.width * x.b.canvas.height, 0);
    if (total <= PDF_PIXEL_BUDGET) return;
    all.sort((a, b) => a.b.used - b.b.used);
    for (const { key, b } of all) {
      if (total <= PDF_PIXEL_BUDGET) break;
      total -= b.canvas.width * b.canvas.height;
      const list = this.pdfBitmaps.get(key)!.filter((x) => x !== b);
      b.canvas.width = 0;
      if (list.length) this.pdfBitmaps.set(key, list);
      else this.pdfBitmaps.delete(key);
    }
  }

  /** Drop PDF renderings (e.g. when leaving a notebook). */
  trim() {
    for (const list of this.pdfBitmaps.values()) for (const b of list) b.canvas.width = 0;
    this.pdfBitmaps.clear();
    for (const r of this.regions.values()) r.canvas.width = 0;
    this.regions.clear();
    this.regionJob = null;
    this.queue.length = 0;
    for (const d of this.pdfDocs.values()) d.then((doc) => doc.destroy()).catch(() => {});
    this.pdfDocs.clear();
  }
}

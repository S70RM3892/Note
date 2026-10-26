import type { PDFDocumentProxy } from 'pdfjs-dist';
import { openPdf } from '../pdf/pdfjs';
import type { Repo } from '../store/repo';

interface PdfBitmap {
  canvas: HTMLCanvasElement;
  scale: number;
  used: number;
}

const PDF_PIXEL_BUDGET = 48e6;

/** Decoded images and rendered PDF pages, shared by all editors. */
export class AssetCache {
  private images = new Map<string, ImageBitmap | null>();
  private pdfDocs = new Map<string, Promise<PDFDocumentProxy>>();
  private pdfBitmaps = new Map<string, PdfBitmap[]>(); // key asset:index
  private queue: { asset: string; index: number; scale: number }[] = [];
  private running = false;
  private listeners = new Set<(asset: string) => void>();

  constructor(private repo: Repo) {}

  subscribe(fn: (asset: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(asset: string) {
    this.listeners.forEach((l) => l(asset));
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
          this.emit(job.asset);
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
    this.queue.length = 0;
    for (const d of this.pdfDocs.values()) d.then((doc) => doc.destroy()).catch(() => {});
    this.pdfDocs.clear();
  }
}

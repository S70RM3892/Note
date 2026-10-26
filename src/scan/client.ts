import type { VectorDoc } from '../core/types';
import type { P2 } from './homography';
import type { ScanRequest, ScanResponse } from './worker';

type Pending = { resolve: (r: ScanResponse) => void; reject: (e: Error) => void };

/** Promise wrapper around the scan worker. */
export class ScanWorker {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<ScanResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.type === 'error') p.reject(new Error(e.data.message));
      else p.resolve(e.data);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'scan worker failed'));
      this.pending.clear();
    };
  }

  private call(msg: Omit<ScanRequest, 'id'>, transfer: Transferable[] = []): Promise<ScanResponse> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Warp + clean the page. Returns the cleaned colour image. */
  async prepare(img: ImageData, quad: P2[], long: number): Promise<ImageData> {
    const buf = img.data.slice().buffer;
    const r = await this.call({ type: 'prepare', rgba: buf, w: img.width, h: img.height, quad, long } as Omit<ScanRequest, 'id'>, [buf]);
    if (r.type !== 'prepared') throw new Error('unexpected response');
    return new ImageData(new Uint8ClampedArray(r.clean), r.w, r.h);
  }

  async vectorize(mode: 'mono' | 'color', sensitivity: number): Promise<{ doc: VectorDoc; shapes: number; ms: number }> {
    const r = await this.call({ type: 'vectorize', mode, sensitivity } as Omit<ScanRequest, 'id'>);
    if (r.type !== 'vectorized') throw new Error('unexpected response');
    return { doc: r.doc, shapes: r.shapes, ms: r.ms };
  }

  dispose() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('cancelled'));
    this.pending.clear();
  }
}

/// <reference lib="webworker" />
import type { VectorDoc } from '../core/types';
import type { InkMaps } from './enhance';
import type { P2 } from './homography';
import { prepare, vectorize } from './pipeline';

/** Heavy scan work off the main thread. The prepared page is kept for quick re-tracing. */

export type ScanRequest =
  | { id: number; type: 'prepare'; rgba: ArrayBuffer; w: number; h: number; quad: P2[]; long: number }
  | { id: number; type: 'vectorize'; mode: 'mono' | 'color'; sensitivity: number };

export type ScanResponse =
  | { id: number; type: 'prepared'; w: number; h: number; clean: ArrayBuffer }
  | { id: number; type: 'vectorized'; doc: VectorDoc; shapes: number; ms: number }
  | { id: number; type: 'error'; message: string };

let maps: InkMaps | null = null;

self.onmessage = (e: MessageEvent<ScanRequest>) => {
  const m = e.data;
  const post = (r: ScanResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(r, transfer);
  try {
    if (m.type === 'prepare') {
      maps = prepare({ w: m.w, h: m.h, data: new Uint8ClampedArray(m.rgba) }, m.quad, m.long);
      const clean = maps.clean.slice().buffer;
      post({ id: m.id, type: 'prepared', w: maps.w, h: maps.h, clean }, [clean]);
    } else {
      if (!maps) throw new Error('not prepared');
      const t0 = performance.now();
      const { doc, shapes } = vectorize(maps, m.mode, m.sensitivity);
      post({ id: m.id, type: 'vectorized', doc, shapes, ms: performance.now() - t0 });
    }
  } catch (err) {
    post({ id: m.id, type: 'error', message: (err as Error).message });
  }
};

import type { VectorDoc } from '../core/types';
import { estimateBackground, inkMaps, splitLayers, type InkMaps } from './enhance';
import { outputSize, warp, type P2 } from './homography';
import type { RGBA } from './raster';
import { DEFAULT_TRACE, vectorizeMask } from './trace';

export type ScanMode = 'mono' | 'color' | 'photo';

/** Perspective-correct the page and normalise its paper colour. */
export function prepare(src: RGBA, quad: P2[], long: number): InkMaps {
  const { w, h } = outputSize(quad, long);
  const page = warp(src, quad, w, h);
  return inkMaps(page, estimateBackground(page));
}

/** Trace the ink of a prepared page into a VectorDoc. */
export function vectorize(maps: InkMaps, mode: 'mono' | 'color', sensitivity: number): { doc: VectorDoc; shapes: number } {
  const long = Math.max(maps.w, maps.h);
  const k = long / 3000;
  const opt = {
    ...DEFAULT_TRACE,
    minArea: Math.max(3, Math.round(8 * k * k)),
    tolerance: Math.max(0.5, 0.75 * k),
    sliver: Math.max(3, Math.round(Math.min(maps.w, maps.h) * 0.012)),
  };
  const layers = splitLayers(maps, mode, sensitivity);
  let shapes = 0;
  const out: VectorDoc['layers'] = [];
  for (const l of layers) {
    const v = vectorizeMask(l.mask, maps.w, maps.h, opt);
    shapes += v.shapes;
    if (v.tiles.length) out.push({ color: l.color, tiles: v.tiles });
  }
  return { doc: { w: maps.w, h: maps.h, tile: opt.tile, layers: out }, shapes };
}

export function vectorBytes(doc: VectorDoc): number {
  let n = 0;
  for (const l of doc.layers) for (const t of l.tiles) n += t.d.length;
  return n;
}

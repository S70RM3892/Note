import { strokeBounds } from '../core/geometry';
import type { Page, Rect, Stroke } from '../core/types';

export interface InkLine {
  strokes: Stroke[];
  box: Rect;
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** Strokes that can be writing: pen ink, not recognised shapes. */
export function writingStrokes(strokes: Stroke[]): Stroke[] {
  return strokes.filter((s) => s.kind === 'pen' && !s.shape && s.pts.length >= 3);
}

/**
 * Group handwriting into horizontal lines (横書き). A stroke joins the line whose vertical band it
 * overlaps most (by at least 40 % of the smaller height); strokes much taller than the typical
 * character (diagrams, brackets across lines) are left out. Lines come back top to bottom with
 * their strokes in writing order.
 */
export function segmentLines(strokes: Stroke[]): InkLine[] {
  const items = writingStrokes(strokes).map((s, order) => ({ s, b: strokeBounds(s), order }));
  if (!items.length) return [];
  const charH = Math.max(4, median(items.map((i) => Math.max(i.b.h, i.b.w * 0.6)).filter((h) => h > 2)));
  const usable = items.filter((i) => i.b.h <= charH * 3.5);
  usable.sort((a, b) => a.b.y + a.b.h / 2 - (b.b.y + b.b.h / 2));
  const lines: { top: number; bottom: number; members: typeof usable }[] = [];
  for (const it of usable) {
    const t = it.b.y, b = it.b.y + it.b.h;
    let best: (typeof lines)[number] | null = null, bestOv = 0;
    for (const l of lines) {
      const ov = Math.min(b, l.bottom) - Math.max(t, l.top);
      const need = 0.4 * Math.max(1, Math.min(it.b.h, l.bottom - l.top));
      if (ov >= need && ov > bestOv) {
        best = l;
        bestOv = ov;
      }
    }
    if (best) {
      best.members.push(it);
      // Grow the band only moderately so one tall stroke doesn't swallow the next line.
      best.top = Math.min(best.top, Math.max(t, best.top - charH * 0.3));
      best.bottom = Math.max(best.bottom, Math.min(b, best.bottom + charH * 0.3));
    } else lines.push({ top: t, bottom: b, members: [it] });
  }
  return lines
    .map((l) => {
      const ms = l.members.sort((a, b) => a.order - b.order);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const m of ms) {
        x0 = Math.min(x0, m.b.x);
        y0 = Math.min(y0, m.b.y);
        x1 = Math.max(x1, m.b.x + m.b.w);
        y1 = Math.max(y1, m.b.y + m.b.h);
      }
      return { strokes: ms.map((m) => m.s), box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
    })
    .sort((a, b) => a.box.y - b.box.y);
}

/** Which writing strokes a page has (changes when ink is added, erased or split). */
export function inkSignature(page: Pick<Page, 'strokes'>): string {
  const ws = writingStrokes(page.strokes);
  let h = 5381;
  for (const s of ws) for (let i = 0; i < s.id.length; i++) h = ((h << 5) + h + s.id.charCodeAt(i)) | 0;
  return `${ws.length}:${(h >>> 0).toString(36)}`;
}

/**
 * Strokes as the recognizer wants them: per stroke a flat [x, y, t, …] list, relative to the
 * line's box plus `pad`. Times aren't recorded, so they are synthesised in writing order (the
 * recognizer only needs the order).
 */
export function inkPayload(line: InkLine, pad = 0): number[][] {
  const ox = line.box.x - pad, oy = line.box.y - pad;
  let t = 0;
  return line.strokes.map((s) => {
    const out: number[] = [];
    for (let i = 0; i < s.pts.length; i += 3) {
      out.push(Math.round((s.pts[i] - ox) * 10) / 10, Math.round((s.pts[i + 1] - oy) * 10) / 10, t);
      t += 8;
    }
    t += 120;
    return out;
  });
}

import type { P2 } from './homography';
import { downscaleGray, otsu, toGray, type RGBA } from './raster';

/** Corners (TL, TR, BR, BL) slightly inside the image, used when no page is found. */
export function insetQuad(w: number, h: number, f = 0.03): P2[] {
  const dx = w * f, dy = h * f;
  return [
    { x: dx, y: dy },
    { x: w - dx, y: dy },
    { x: w - dx, y: h - dy },
    { x: dx, y: h - dy },
  ];
}

function quadArea(q: P2[]): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i], n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

function convex(q: P2[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-9) return false;
    const s = Math.sign(z);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/**
 * Find the sheet of paper in a photo: the largest bright region, reduced to its four
 * extreme corners. Good enough as a starting point; the user can drag the corners.
 */
export function detectDocument(img: RGBA): { quad: P2[]; found: boolean } {
  const long = Math.max(img.w, img.h);
  const f = Math.max(1, Math.ceil(long / 360));
  const g = downscaleGray(toGray(img), f);
  const t = otsu(g);
  const { w, h, data } = g;
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  let best = -1, bestArea = 0, bestBorder = 0;
  let comp = 0;
  for (let i = 0; i < w * h; i++) {
    if (label[i] !== -1 || data[i] <= t) continue;
    let sp = 0, area = 0, border = 0;
    stack[sp++] = i;
    label[i] = comp;
    while (sp) {
      const p = stack[--sp];
      area++;
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border++;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q >= 0 && label[q] === -1 && data[q] > t) {
          label[q] = comp;
          stack[sp++] = q;
        }
      }
    }
    if (area > bestArea) {
      bestArea = area;
      best = comp;
      bestBorder = border;
    }
    comp++;
  }
  const fallback = { quad: insetQuad(img.w, img.h), found: false };
  if (best < 0 || bestArea < w * h * 0.12) return fallback;
  // A region hugging most of the frame is the desk, not the paper.
  if (bestBorder > (w + h) * 2 * 0.6) return fallback;
  let tl = { s: Infinity, x: 0, y: 0 }, br = { s: -Infinity, x: 0, y: 0 };
  let tr = { s: -Infinity, x: 0, y: 0 }, bl = { s: -Infinity, x: 0, y: 0 };
  for (let i = 0; i < w * h; i++) {
    if (label[i] !== best) continue;
    const x = i % w, y = (i / w) | 0;
    if (x + y < tl.s) tl = { s: x + y, x, y };
    if (x + y > br.s) br = { s: x + y, x, y };
    if (x - y > tr.s) tr = { s: x - y, x, y };
    if (y - x > bl.s) bl = { s: y - x, x, y };
  }
  const up = (p: { x: number; y: number }) => ({ x: Math.min(img.w, (p.x + 0.5) * f), y: Math.min(img.h, (p.y + 0.5) * f) });
  const quad = [up(tl), up(tr), up(br), up(bl)];
  if (!convex(quad) || quadArea(quad) < img.w * img.h * 0.12) return fallback;
  return { quad, found: true };
}

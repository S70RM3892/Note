import { describe, expect, it } from 'vitest';
import { applyMat, cropItem, fullItem, itemCorners, similarity, transformItem } from '../../src/core/geometry';
import { formatPageRanges, parsePageRanges } from '../../src/core/pages';
import type { ImageItem } from '../../src/core/types';

const img = (extra: Partial<ImageItem> = {}): ImageItem => ({ id: 'i', type: 'image', asset: 'a', x: 100, y: 50, w: 400, h: 200, rot: 0, ...extra });

/** Page position of a point of the picture given as fractions of the whole picture. */
function pictureToPage(it: ImageItem, u: number, v: number) {
  const f = fullItem(it);
  const [tl, tr, , bl] = itemCorners(f);
  return { x: tl.x + (tr.x - tl.x) * u + (bl.x - tl.x) * v, y: tl.y + (tr.y - tl.y) * u + (bl.y - tl.y) * v };
}

describe('トリミング', () => {
  it('crops to the chosen part and keeps the picture where it is', () => {
    const it0 = img();
    const c = cropItem(it0, { x: 0.5, y: 0.25, w: 0.5, h: 0.5 });
    expect(c).toMatchObject({ x: 300, y: 100, w: 200, h: 100, crop: { x: 0.5, y: 0.25, w: 0.5, h: 0.5 } });
    expect(fullItem(c)).toMatchObject({ x: 100, y: 50, w: 400, h: 200 });
    expect(fullItem(c).crop).toBeUndefined();
  });

  it('holds under rotation: every point of the picture stays put', () => {
    const it0 = img({ rot: 0.7 });
    const c = cropItem(it0, { x: 0.2, y: 0.1, w: 0.3, h: 0.6 });
    for (const [u, v] of [[0, 0], [1, 1], [0.35, 0.4], [0.2, 0.7]]) {
      const a = pictureToPage(it0, u, v), b = pictureToPage(c, u, v);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.y).toBeCloseTo(a.y, 6);
    }
    // The item's own box is exactly the cropped part.
    const tl = itemCorners(c)[0], want = pictureToPage(it0, 0.2, 0.1);
    expect(tl.x).toBeCloseTo(want.x, 6);
    expect(tl.y).toBeCloseTo(want.y, 6);
  });

  it('can be widened again, and the full frame removes the crop', () => {
    const c = cropItem(img({ rot: -0.3 }), { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
    const wider = cropItem(c, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    expect(wider.w).toBeCloseTo(320, 6);
    const back = cropItem(wider, { x: 0, y: 0, w: 1, h: 1 });
    expect(back.crop).toBeUndefined();
    expect(back).toMatchObject({ w: 400, h: 200 });
    expect(back.x).toBeCloseTo(100, 6);
    expect(back.y).toBeCloseTo(50, 6);
    expect(cropItem(c, null).crop).toBeUndefined();
  });

  it('a cropped picture can still be moved, scaled and rotated', () => {
    const c = cropItem(img(), { x: 0.5, y: 0, w: 0.5, h: 1 });
    const m = similarity(0, 0, 2, 0.5);
    const t = transformItem(c, m);
    expect(t.crop).toEqual(c.crop);
    const a = pictureToPage(c, 0.75, 0.5), b = pictureToPage(t, 0.75, 0.5);
    const want = applyMat(m, a.x, a.y);
    expect(b.x).toBeCloseTo(want.x, 6);
    expect(b.y).toBeCloseTo(want.y, 6);
  });

  it('clamps a frame that sticks out', () => {
    const c = cropItem(img(), { x: -0.2, y: 0.5, w: 2, h: 2 });
    expect(c.crop).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });
});

describe('page ranges', () => {
  it('reads single pages, ranges and open ends', () => {
    expect(parsePageRanges('3', 10)).toEqual([2]);
    expect(parsePageRanges('2-5', 10)).toEqual([1, 2, 3, 4]);
    expect(parsePageRanges('1, 4, 8-10', 10)).toEqual([0, 3, 7, 8, 9]);
    expect(parsePageRanges('7-', 10)).toEqual([6, 7, 8, 9]);
    expect(parsePageRanges('-3', 10)).toEqual([0, 1, 2]);
    expect(parsePageRanges('5-2', 10)).toEqual([1, 2, 3, 4]);
    expect(parsePageRanges('3,3,2-3', 10)).toEqual([1, 2]);
  });

  it('accepts Japanese input', () => {
    expect(parsePageRanges('２〜４、７', 10)).toEqual([1, 2, 3, 6]);
    expect(parsePageRanges('3ページ', 10)).toEqual([2]);
    expect(parsePageRanges('p.2 - p.3', 10)).toEqual([1, 2]);
  });

  it('stops at the last page and rejects what is not a range', () => {
    expect(parsePageRanges('8-20', 10)).toEqual([7, 8, 9]);
    expect(parsePageRanges('11', 10)).toBeNull();
    expect(parsePageRanges('0', 10)).toBeNull();
    expect(parsePageRanges('', 10)).toBeNull();
    expect(parsePageRanges('abc', 10)).toBeNull();
    expect(parsePageRanges('1-2-3', 10)).toBeNull();
    expect(parsePageRanges('-', 10)).toBeNull();
  });

  it('formats back', () => {
    expect(formatPageRanges([0, 1, 2, 4, 7, 8])).toBe('1-3, 5, 8-9');
    expect(formatPageRanges(parsePageRanges('1,4,8-10', 10)!)).toBe('1, 4, 8-10');
  });
});

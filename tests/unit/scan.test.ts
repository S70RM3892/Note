import { describe, expect, it } from 'vitest';
import { detectDocument } from '../../src/scan/detect';
import { hysteresis } from '../../src/scan/enhance';
import { applyH, homography, outputSize, warp } from '../../src/scan/homography';
import { prepare, vectorize } from '../../src/scan/pipeline';
import type { RGBA } from '../../src/scan/raster';
import { labelComponents, simplifyClosed, traceLoops, vectorizeMask } from '../../src/scan/trace';

function maskFrom(rows: string[]): { mask: Uint8Array; w: number; h: number } {
  const h = rows.length, w = rows[0].length;
  const mask = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((c, x) => (mask[y * w + x] = c === '#' ? 1 : 0)));
  return { mask, w, h };
}

describe('contour tracing', () => {
  it('single pixel is a unit square outline', () => {
    const { mask, w, h } = maskFrom(['#']);
    const loops = traceLoops(mask, w, h, labelComponents(mask, w, h));
    expect(loops).toHaveLength(1);
    expect(loops[0].area).toBe(1);
    expect(loops[0].pts).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
  });

  it('ring: clockwise outline and counter-clockwise hole in one component', () => {
    const { mask, w, h } = maskFrom(['.......', '.#####.', '.#...#.', '.#...#.', '.#...#.', '.#####.', '.......']);
    const comps = labelComponents(mask, w, h);
    expect(comps.count).toBe(1);
    const loops = traceLoops(mask, w, h, comps);
    expect(loops.map((l) => l.area).sort((a, b) => a - b)).toEqual([-9, 25]);
    expect(new Set(loops.map((l) => l.comp)).size).toBe(1);
  });

  it('diagonal pixels are one 8-connected shape', () => {
    const { mask, w, h } = maskFrom(['#..', '.#.', '..#']);
    const comps = labelComponents(mask, w, h);
    expect(comps.count).toBe(1);
    const loops = traceLoops(mask, w, h, comps);
    expect(loops).toHaveLength(1);
    expect(loops[0].area).toBe(3);
  });

  it('drops specks and keeps shapes, grouped into tiles', () => {
    const rows = Array.from({ length: 40 }, () => '.'.repeat(40).split(''));
    for (let y = 5; y < 20; y++) for (let x = 5; x < 20; x++) rows[y][x] = '#';
    rows[30][30] = '#'; // speck
    const { mask, w, h } = maskFrom(rows.map((r) => r.join('')));
    const v = vectorizeMask(mask, w, h, { minArea: 4, tolerance: 0.75, cornerAngle: 1.05, tile: 256, sliver: 2 });
    expect(v.shapes).toBe(1);
    expect(v.tiles).toHaveLength(1);
    expect(v.tiles[0].b).toEqual([5, 5, 20, 20]);
    // Square keeps its corners.
    expect(v.tiles[0].d).toMatch(/^M.*L5 5.*Z$/);
  });

  it('simplifies a staircase diagonal to few points', () => {
    const pts: number[] = [];
    for (let i = 0; i < 50; i++) pts.push(i, i, i + 1, i);
    pts.push(50, 50, 0, 50);
    const s = simplifyClosed(pts, 0.75);
    expect(s.length / 2).toBeLessThan(6);
  });
});

describe('homography & warp', () => {
  it('maps the corners and inverts', () => {
    const src = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const dst = [
      { x: 10, y: 20 },
      { x: 210, y: 30 },
      { x: 190, y: 260 },
      { x: 5, y: 240 },
    ];
    const H = homography(src, dst);
    for (let i = 0; i < 4; i++) {
      const p = applyH(H, src[i].x, src[i].y);
      expect(p.x).toBeCloseTo(dst[i].x, 6);
      expect(p.y).toBeCloseTo(dst[i].y, 6);
    }
    const s = outputSize(dst, 300);
    expect(Math.max(s.w, s.h)).toBe(300);
  });

  it('warp of an axis-aligned quad is a crop', () => {
    const img: RGBA = { w: 4, h: 4, data: new Uint8ClampedArray(64) };
    for (let i = 0; i < 16; i++) img.data.set([i * 10, 0, 0, 255], i * 4);
    const out = warp(img, [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 3 }], 2, 2);
    expect(Array.from(out.data.filter((_, i) => i % 4 === 0))).toEqual([50, 60, 90, 100]);
  });
});

describe('threshold', () => {
  it('hysteresis grows from strong ink into connected faint ink only', () => {
    const w = 6, h = 1;
    const dark = Uint8Array.from([200, 80, 80, 0, 80, 0]);
    expect(Array.from(hysteresis(dark, w, h, 150, 60))).toEqual([1, 1, 1, 0, 0, 0]);
  });
});

/** Synthetic photo: dark desk, skewed white sheet with a black bar, a ring and a red disc, plus a shadow. */
function photo(): { img: RGBA; quad: { x: number; y: number }[] } {
  const w = 640, h = 480;
  const data = new Uint8ClampedArray(w * h * 4);
  const quad = [
    { x: 90, y: 60 },
    { x: 560, y: 80 },
    { x: 540, y: 430 },
    { x: 70, y: 400 },
  ];
  const H = homography(quad, [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const p = applyH(H, x, y);
      let c = [60, 55, 50];
      if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
        const shade = 1 - 0.35 * p.x; // shadow across the page
        c = [245 * shade, 242 * shade, 235 * shade];
        const u = p.x, v = p.y;
        if (u > 0.1 && u < 0.6 && v > 0.15 && v < 0.22) c = [20, 20, 25];
        const dr = Math.hypot(u - 0.3, v - 0.6);
        if (dr < 0.12 && dr > 0.06) c = [25, 25, 30];
        if (Math.hypot(u - 0.75, v - 0.6) < 0.08) c = [210 * shade, 30, 35];
      }
      data.set([c[0], c[1], c[2], 255], o);
    }
  }
  return { img: { w, h, data }, quad };
}

/** A flat sheet (no warp needed) with a big solid red disc and a hard-edged shadow over the bottom. */
function bigShapes(): RGBA {
  const w = 600, h = 800;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const shade = y > 600 ? 0.6 : 1;
      let c = [244 * shade, 240 * shade, 232 * shade];
      if (Math.hypot(x - 300, y - 300) < 150) c = [205, 40, 38];
      if (y > 650 && y < 680 && x > 100 && x < 500) c = [18 * shade, 18 * shade, 22 * shade];
      data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  }
  return { w, h, data };
}

describe('scan pipeline', () => {
  it('keeps a large solid shape filled and still flattens a hard shadow', () => {
    const img = bigShapes();
    const maps = prepare(img, [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 800 }, { x: 0, y: 800 }], 800);
    const px = (x: number, y: number) => Array.from(maps.clean.subarray((y * maps.w + x) * 4, (y * maps.w + x) * 4 + 3));
    const [r, g] = px(300, 300);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(90); // the disc centre stays red, not bleached to paper
    expect(Math.min(...px(50, 750))).toBeGreaterThan(225); // paper in the shadow is white
    const color = vectorize(maps, 'color', 0.5);
    expect(color.doc.layers).toHaveLength(2);
    const loops = (l: { tiles: { d: string }[] }) => l.tiles.map((t) => t.d).join('').match(/M/g)?.length ?? 0;
    expect(loops(color.doc.layers[0])).toBe(1); // a disc, not a ring
    expect(loops(color.doc.layers[1])).toBe(1); // the bar inside the shadow, and no shadow edge
  });

  it('finds the sheet', () => {
    const { img, quad } = photo();
    const d = detectDocument(img);
    expect(d.found).toBe(true);
    d.quad.forEach((p, i) => {
      expect(Math.abs(p.x - quad[i].x)).toBeLessThan(14);
      expect(Math.abs(p.y - quad[i].y)).toBeLessThan(14);
    });
  });

  it('removes the shadow and vectorizes black and red ink separately', () => {
    const { img, quad } = photo();
    const maps = prepare(img, quad, 600);
    // Paper is white on both the lit and the shaded side after normalisation.
    const px = (u: number, v: number) => maps.clean[(Math.floor(v * maps.h) * maps.w + Math.floor(u * maps.w)) * 4];
    expect(px(0.05, 0.9)).toBeGreaterThan(235);
    expect(px(0.95, 0.9)).toBeGreaterThan(235);
    const mono = vectorize(maps, 'mono', 0.5);
    expect(mono.doc.layers).toHaveLength(1);
    expect(mono.shapes).toBe(3); // bar, ring, disc (red is dark enough in luminance)
    const color = vectorize(maps, 'color', 0.5);
    expect(color.doc.layers).toHaveLength(2);
    const [red, black] = color.doc.layers;
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [r, g, b] = rgb(red.color);
    expect(r).toBeGreaterThan(g + 60);
    expect(r).toBeGreaterThan(b + 60);
    expect(black.color).toBe('#141414');
    // The ring keeps its hole: two loops in the black layer path data.
    const black_d = black.tiles.map((t) => t.d).join('');
    expect((black_d.match(/M/g) ?? []).length).toBe(3); // bar + ring outline + ring hole
  });
});

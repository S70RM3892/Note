import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELER, StrokeModeler, modelerParams, type ModelPoint } from '../../src/core/modeler';

/** Deterministic noise. */
function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

interface In {
  x: number;
  y: number;
  p: number;
  t: number;
}

/** Sample a parametric path f(u), u∈[0,1], over `ms` at `hz`, with `noise` px jitter. */
function sampled(f: (u: number) => { x: number; y: number }, ms: number, hz: number, noise = 0, pressure = (_u: number) => 0.5, seed = 7): In[] {
  const r = rng(seed);
  const n = Math.max(2, Math.round((ms / 1000) * hz));
  return Array.from({ length: n + 1 }, (_, i) => {
    const u = i / n;
    const q = f(u);
    return { x: q.x + r() * noise, y: q.y + r() * noise, p: pressure(u), t: 1000 + (i * ms) / n };
  });
}

function run(input: In[], m = new StrokeModeler(DEFAULT_MODELER)): ModelPoint[] {
  const out = [m.reset(input[0].x, input[0].y, input[0].p, input[0].t)];
  for (const s of input.slice(1)) out.push(...m.update(s.x, s.y, s.p, s.t));
  out.push(...m.finish());
  return out;
}

const turn = (a: ModelPoint, b: ModelPoint, c: ModelPoint) => {
  const a1 = Math.atan2(b.y - a.y, b.x - a.x), a2 = Math.atan2(c.y - b.y, c.x - b.x);
  let d = Math.abs(a2 - a1);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
};

describe('stroke modeler', () => {
  it('turns a sparse, fast curve into a smooth one (no polygon corners)', () => {
    // A quick 「の」-like loop: radius 18 px, one turn in 90 ms, at only 120 Hz.
    const loop = (u: number) => ({ x: 100 + 18 * Math.cos(u * 2 * Math.PI), y: 100 + 18 * Math.sin(u * 2 * Math.PI) });
    const input = sampled(loop, 90, 120);
    const raw = input.map((s) => ({ ...s }));
    const maxRawTurn = Math.max(...raw.slice(2).map((c, i) => turn(raw[i], raw[i + 1], c)));
    const out = run(input).filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 0.2);
    const maxTurn = Math.max(...out.slice(2).map((c, i) => turn(out[i], out[i + 1], c)));
    expect(maxRawTurn).toBeGreaterThan(0.5); // ~30° corners in the raw polyline
    expect(maxTurn).toBeLessThan(maxRawTurn / 2.5);
    expect(out.length).toBeGreaterThan(raw.length * 3.5); // upsampled to ≥ 480/s
  });

  it('stays on the written shape at normal writing speed', () => {
    // An S-curve written at ~250 px/s, 240 Hz, light digitizer noise.
    const s = (u: number) => ({ x: 50 + u * 120, y: 80 + 25 * Math.sin(u * 2 * Math.PI) });
    const input = sampled(s, 600, 240, 0.15);
    const out = run(input);
    let worst = 0;
    for (const p of out) {
      // Distance to the true curve (dense search).
      let best = Infinity;
      for (let k = 0; k <= 2000; k++) {
        const q = s(k / 2000);
        best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
      }
      worst = Math.max(worst, best);
    }
    expect(worst).toBeLessThan(1.2);
  });

  it('ends at the last input without a straight catch-up jump', () => {
    // A fast はらい: 140 px in 60 ms, curving, ending while still moving.
    const harai = (u: number) => ({ x: 200 + 140 * u, y: 100 + 60 * u * u });
    const input = sampled(harai, 60, 240);
    const out = run(input);
    const end = out[out.length - 1], fin = input[input.length - 1];
    expect(Math.hypot(end.x - fin.x, end.y - fin.y)).toBeLessThanOrEqual(1.5);
    const lastSeg = Math.hypot(end.x - out[out.length - 2].x, end.y - out[out.length - 2].y);
    expect(lastSeg).toBeLessThan(3); // the old filter added one straight segment of the whole lag here
  });

  it('keeps the corners of a fast zigzag (く・レ written quickly)', () => {
    // Legs of 60 px down/up, 20 px across, at 750 px/s, 240 Hz.
    const T = (Math.hypot(60, 20) / 750) * 1000;
    const input: In[] = [];
    const n = Math.round((T / 1000) * 240);
    for (let k = 0; k < 6; k++) {
      for (let i = k ? 1 : 0; i <= n; i++) {
        const u = i / n;
        input.push({ x: 100 + (k + u) * 20, y: k % 2 ? 160 - 60 * u : 100 + 60 * u, p: 0.5, t: 1000 + (k + u) * T });
      }
    }
    const out = run(input);
    for (const [cx, cy] of [
      [120, 160],
      [140, 100],
      [160, 160],
      [180, 100],
      [200, 160],
    ]) {
      const miss = Math.min(...out.map((p) => Math.hypot(p.x - cx, p.y - cy)));
      expect(miss).toBeLessThan(3.5);
    }
  });

  it('removes digitizer wobble from slow strokes', () => {
    // A slow straight line (20 px/s) with ±0.6 px jitter.
    const input = sampled((u) => ({ x: 10 + 20 * u, y: 50 }), 1000, 240, 0.6, undefined, 3);
    const out = run(input).slice(20, -20);
    const sd = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + (x - 50) ** 2, 0) / v.length);
    expect(sd(out.map((p) => p.y))).toBeLessThan(sd(input.map((p) => p.y)) * 0.5);
  });

  it('pressure follows the raw input, including the lift-off taper', () => {
    const input = sampled((u) => ({ x: 10 + 100 * u, y: 10 }), 200, 240, 0, (u) => (u < 0.8 ? 0.7 : 0.7 - (u - 0.8) * 3));
    const out = run(input);
    expect(out[Math.floor(out.length / 2)].p).toBeCloseTo(0.7, 1);
    expect(out[out.length - 1].p).toBeLessThan(0.15);
  });

  it('predict() shows the catch-up without changing the stroke', () => {
    const input = sampled((u) => ({ x: 10 + 200 * u, y: 10 + 30 * Math.sin(u * 6) }), 120, 240);
    const a = new StrokeModeler(DEFAULT_MODELER), b = new StrokeModeler(DEFAULT_MODELER);
    const outA = [a.reset(input[0].x, input[0].y, input[0].p, input[0].t)];
    const outB = [b.reset(input[0].x, input[0].y, input[0].p, input[0].t)];
    for (const s of input.slice(1)) {
      outA.push(...a.update(s.x, s.y, s.p, s.t));
      const pr = a.predict();
      expect(pr.length).toBeGreaterThan(0);
      outB.push(...b.update(s.x, s.y, s.p, s.t));
    }
    expect(outA).toEqual(outB);
  });

  it('a tap is a single dot', () => {
    const m = new StrokeModeler(DEFAULT_MODELER);
    const out = [m.reset(5, 5, 0.6, 0), ...m.finish()];
    expect(out).toHaveLength(1);
  });

  it('works in page units at any zoom (the spring model is scale-free)', () => {
    const f = (u: number) => ({ x: 20 + 80 * u, y: 40 + 20 * Math.sin(u * 5) });
    const scr = sampled(f, 200, 240);
    const z = 2.5;
    const page = scr.map((s) => ({ ...s, x: s.x / z, y: s.y / z }));
    const a = run(scr, new StrokeModeler(modelerParams(1)));
    const b = run(page, new StrokeModeler(modelerParams(z)));
    expect(b.length).toBe(a.length);
    b.forEach((p, i) => {
      expect(p.x * z).toBeCloseTo(a[i].x, 3);
      expect(p.y * z).toBeCloseTo(a[i].y, 3);
    });
  });
});

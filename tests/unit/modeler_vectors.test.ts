import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELER, StrokeModeler, type ModelerParams } from '../../src/core/modeler';

/**
 * Shared vectors: the Android shell's Modeler.kt must produce the same points as
 * core/modeler.ts (its wet ink has to match the committed stroke). Regenerate with
 * UPDATE_VECTORS=1 after changing the algorithm; the Kotlin test reads the same file.
 */
const FILE = 'android/app/src/test/resources/modeler_vectors.json';

interface Case {
  name: string;
  params: ModelerParams;
  input: [number, number, number, number][]; // x, y, p, t
  predictAt: number; // also record predict() after this many inputs
}

function cases(): Case[] {
  let seed = 11;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const mk = (n: number, hz: number, f: (u: number) => [number, number], p: (u: number) => number, noise = 0) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const u = i / n;
      const [x, y] = f(u);
      return [x + r() * noise, y + r() * noise, p(u), 5000 + (i * 1000) / hz] as [number, number, number, number];
    });
  const stab = (k: number): ModelerParams => ({ ...DEFAULT_MODELER, wobbleWindow: DEFAULT_MODELER.wobbleWindow + 100 * k, speedFloor: DEFAULT_MODELER.speedFloor * (1 + 3 * k), speedCeiling: DEFAULT_MODELER.speedCeiling * (1 + 3 * k) });
  return [
    { name: 'loop120', params: DEFAULT_MODELER, input: mk(12, 120, (u) => [100 + 18 * Math.cos(u * 6.283), 100 + 18 * Math.sin(u * 6.283)], () => 0.5), predictAt: 6 },
    { name: 'scurve240noise', params: stab(0.25), input: mk(60, 240, (u) => [50 + u * 120, 80 + 25 * Math.sin(u * 6.283)], (u) => 0.3 + 0.5 * Math.sin(u * 3.14), 0.3), predictAt: 30 },
    { name: 'harai', params: DEFAULT_MODELER, input: mk(14, 240, (u) => [200 + 140 * u, 100 + 60 * u * u], (u) => 0.7 - 0.6 * u), predictAt: 10 },
    { name: 'slow', params: stab(0.5), input: mk(80, 240, (u) => [10 + 20 * u, 50], () => 0.6, 0.6), predictAt: 40 },
    { name: 'tap', params: DEFAULT_MODELER, input: [[5, 5, 0.6, 1000]], predictAt: 0 },
  ];
}

function compute(c: Case) {
  const m = new StrokeModeler(c.params);
  const [x0, y0, p0, t0] = c.input[0];
  const out = [m.reset(x0, y0, p0, t0)];
  let predicted: unknown[] = [];
  c.input.slice(1).forEach(([x, y, p, t], i) => {
    out.push(...m.update(x, y, p, t));
    if (i + 1 === c.predictAt) predicted = m.predict();
  });
  if (c.predictAt === 0) predicted = m.predict();
  out.push(...m.finish());
  return { output: out, predicted };
}

describe('modeler vectors (shared with Modeler.kt)', () => {
  it('match the committed fixture', () => {
    const data = cases().map((c) => ({ ...c, ...compute(c) }));
    if (process.env.UPDATE_VECTORS || !existsSync(FILE)) writeFileSync(FILE, JSON.stringify(data));
    const saved = JSON.parse(readFileSync(FILE, 'utf8'));
    expect(saved.length).toBe(data.length);
    saved.forEach((s: any, i: number) => {
      expect(s.output.length).toBe(data[i].output.length);
      s.output.forEach((q: any, k: number) => {
        const d = data[i].output[k];
        expect(Math.abs(q.x - d.x) + Math.abs(q.y - d.y) + Math.abs(q.p - d.p) + Math.abs(q.t - d.t)).toBeLessThan(1e-9);
      });
      expect(s.predicted.length).toBe((data[i].predicted as unknown[]).length);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { ExprError, parseExpr, parseNumber } from '../../src/core/expr';
import { buildGraph, niceStep, piLabel, traceCurve, type GraphSpec } from '../../src/core/graph';

const at = (src: string, x: number) => parseExpr(src)(x);

describe('expression parser', () => {
  it('reads math the way it is written by hand', () => {
    expect(at('y = x^2 - 2x - 3', 4)).toBe(5);
    expect(at('2x²+1', 3)).toBe(19);
    expect(at('-x^2', 3)).toBe(-9);
    expect(at('(x+1)(x-2)', 3)).toBe(4);
    expect(at('x(x-1)', 4)).toBe(12);
    expect(at('f(x) = 1/2x', 4)).toBe(2);
    expect(at('2^-x', 1)).toBe(0.5);
    expect(at('e^x', 0)).toBe(1);
    expect(at('ｘ＾２', 3)).toBe(9); // 全角
    expect(at('3 × x ÷ 2 − 1', 2)).toBe(2);
  });
  it('functions with and without parentheses', () => {
    const x = 0.7;
    expect(at('sin x', x)).toBeCloseTo(Math.sin(x));
    expect(at('sinx', x)).toBeCloseTo(Math.sin(x));
    expect(at('sin 2x', x)).toBeCloseTo(Math.sin(2 * x));
    expect(at('2sin x cos x', x)).toBeCloseTo(Math.sin(2 * x));
    expect(at('sin^2 x + cos^2 x', x)).toBeCloseTo(1);
    expect(at('sin(x)^2', x)).toBeCloseTo(Math.sin(x) ** 2);
    expect(at('sin x + 1', x)).toBeCloseTo(Math.sin(x) + 1);
    expect(at('√x', 9)).toBe(3);
    expect(at('sqrt(1-x^2)', 0.6)).toBeCloseTo(0.8);
    expect(at('log x', Math.E)).toBeCloseTo(1); // 数III: natural log
    expect(at('log_2 x', 8)).toBeCloseTo(3);
    expect(at('log_{10}(x)', 1000)).toBeCloseTo(3);
    expect(at('xe^-x', 1)).toBeCloseTo(1 / Math.E);
    expect(at('sinhx', 1)).toBeCloseTo(Math.sinh(1));
  });
  it('absolute value bars', () => {
    expect(at('|x-1|', -2)).toBe(3);
    expect(at('|x|+|x-2|', 1)).toBe(2);
    expect(at('2|x|', -3)).toBe(6);
  });
  it('constants in range fields', () => {
    expect(parseNumber('2π')).toBeCloseTo(2 * Math.PI);
    expect(parseNumber('-pi/2')).toBeCloseTo(-Math.PI / 2);
    expect(parseNumber('3/2')).toBe(1.5);
  });
  it('errors say what is wrong', () => {
    expect(() => parseExpr('x^')).toThrow(ExprError);
    expect(() => parseExpr('(x+1')).toThrow('「)」が足りない');
    expect(() => parseExpr('foo(x)')).toThrow('読めない');
    expect(() => parseExpr('')).toThrow('空');
    expect(() => parseExpr('x$2')).toThrow('使えない');
  });
});

const measure = (t: string, size: number) => ({ w: t.length * size * 0.6, h: size * 1.4 });
const spec = (p: Partial<GraphSpec>): GraphSpec => ({ exprs: [], xmin: -5, xmax: 5, width: 300, equal: false, grid: false, numbers: true, piTicks: false, ...p });

describe('graph', () => {
  it('nice steps and π labels', () => {
    expect(niceStep(10)).toBe(1);
    expect(niceStep(37)).toBe(5);
    expect(niceStep(0.9)).toBeCloseTo(0.1);
    expect([1, 2, 3, 4, -1, -2].map((k) => piLabel(k, 2))).toEqual(['π/2', 'π', '3π/2', '2π', '−π/2', '−π']);
  });
  it('a parabola: axes, ticks, labels and one smooth curve inside the box', () => {
    const g = buildGraph(spec({ exprs: ['y = x^2 - 2x - 3'], xmin: -3, xmax: 5 }), measure);
    expect(g.errors).toEqual([null]);
    expect(g.ymin).toBeLessThanOrEqual(-4); // vertex (1, -4) is in view
    const curves = g.lines.filter((l) => l.width === 1.6);
    expect(curves).toHaveLength(1);
    expect(curves[0].pts.length / 2).toBeGreaterThan(20);
    for (const v of curves[0].pts) expect(Number.isFinite(v)).toBe(true);
    const texts = g.labels.map((l) => l.text);
    expect(texts).toEqual(expect.arrayContaining(['x', 'y', 'O', '4', '−2']));
    for (const l of g.lines) for (const v of l.pts) expect(v).toBeGreaterThanOrEqual(-1e-9);
  });
  it('breaks tan x at its asymptotes instead of joining them', () => {
    const sx = (x: number) => ((x + Math.PI) / (2 * Math.PI)) * 300;
    const sy = (y: number) => ((4 - y) / 8) * 200;
    const polys = traceCurve(Math.tan, sx, sy, -Math.PI, Math.PI, 300, 200);
    expect(polys).toHaveLength(3);
    for (const p of polys) for (let k = 1; k < p.length; k += 2) expect(p[k]).toBeGreaterThanOrEqual(-1e-6), expect(p[k]).toBeLessThanOrEqual(200 + 1e-6);
  });
  it('a curve with a gap in its domain (√ and log) starts at the domain edge', () => {
    const sx = (x: number) => ((x + 2) / 6) * 300;
    const sy = (y: number) => ((3 - y) / 6) * 200;
    const [p] = traceCurve(parseExpr('√x'), sx, sy, -2, 4, 300, 200);
    expect(p[0]).toBeCloseTo(sx(0), 1);
    const q = traceCurve(parseExpr('1/x'), sx, sy, -2, 4, 300, 200);
    expect(q).toHaveLength(2);
  });
  it('π ticks for trig graphs and equal scale', () => {
    const g = buildGraph(spec({ exprs: ['sin x', 'cos x'], xmin: -2 * Math.PI, xmax: 2 * Math.PI, ymin: -1.5, ymax: 1.5, piTicks: true, equal: true }), measure);
    const texts = g.labels.map((l) => l.text);
    expect(texts).toEqual(expect.arrayContaining(['π/2', 'π', '2π', '−3π/2', 'y=sin x', 'y=cos x']));
    expect(g.lines.filter((l) => l.width === 1.6).map((l) => l.color)).toEqual(['#1a1a1a', '#1e4fd8']);
  });
  it('reports bad expressions without dropping the good ones', () => {
    const g = buildGraph(spec({ exprs: ['x^2', 'sin(x'] }), measure);
    expect(g.errors[0]).toBeNull();
    expect(g.errors[1]).toContain(')');
    expect(g.lines.some((l) => l.width === 1.6)).toBe(true);
  });
});

describe('graph labels', () => {
  it('names of curves ending at the same point do not overlap', () => {
    const g = buildGraph(spec({ exprs: ['sin x', 'cos x', 'sin x + 0.01'], xmin: -6.28, xmax: 6.28, ymin: -1.5, ymax: 1.5 }), measure);
    const names = g.labels.filter((l) => l.text.startsWith('y='));
    expect(names).toHaveLength(3);
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i], b = names[j];
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
  });
});

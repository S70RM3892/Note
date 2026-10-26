import { describe, expect, it } from 'vitest';
import type { Stroke } from '../../src/core/types';
import { inkPayload, inkSignature, segmentLines } from '../../src/ink/lines';

let n = 0;
/** A "character": a short zigzag inside a box. */
function glyph(x: number, y: number, size = 20, extra: Partial<Stroke> = {}): Stroke {
  const pts: number[] = [];
  for (let i = 0; i <= 6; i++) pts.push(x + (i / 6) * size, y + (i % 2 ? size : 0), 0.5);
  return { id: `s${n++}`, kind: 'pen', style: 'ballpoint', color: '#000', width: 2, pts: new Float32Array(pts), ...extra };
}

describe('handwriting lines', () => {
  it('groups characters into lines top to bottom, in writing order', () => {
    // Line 2 written first, then line 1; a little vertical wobble.
    const l2 = [glyph(100, 200), glyph(125, 204), glyph(150, 198)];
    const l1 = [glyph(100, 100), glyph(124, 96), glyph(149, 103), glyph(175, 100)];
    const lines = segmentLines([...l2, ...l1]);
    expect(lines.map((l) => l.strokes.length)).toEqual([4, 3]);
    expect(lines[0].strokes.map((s) => s.id)).toEqual(l1.map((s) => s.id));
    expect(lines[0].box.y).toBeLessThan(lines[1].box.y);
  });

  it('leaves out highlighter, shapes and tall diagram strokes', () => {
    const text = [glyph(100, 100), glyph(125, 100), glyph(150, 100)];
    const hl = glyph(90, 95, 120, { kind: 'highlighter' });
    const shape = glyph(100, 100, 20, { shape: true });
    const tall: Stroke = { ...glyph(300, 0), id: 'tall', pts: new Float32Array([300, 0, 0.5, 302, 400, 0.5]) };
    const lines = segmentLines([...text, hl, shape, tall]);
    expect(lines).toHaveLength(1);
    expect(lines[0].strokes.map((s) => s.id)).toEqual(text.map((s) => s.id));
  });

  it('payload is relative to the line box and keeps writing order in time', () => {
    const [line] = segmentLines([glyph(100, 100), glyph(130, 100)]);
    const p = inkPayload(line, 5);
    expect(p).toHaveLength(2);
    // First point (100, 100) relative to the line box, plus the padding.
    expect(p[0][0]).toBeCloseTo(100 - line.box.x + 5, 1);
    expect(p[0][1]).toBeCloseTo(100 - line.box.y + 5, 1);
    expect(Math.min(...p.flatMap((s) => s.filter((_, i) => i % 3 === 0)))).toBeGreaterThanOrEqual(5);
    const tLast0 = p[0][p[0].length - 1], tFirst1 = p[1][2];
    expect(tFirst1).toBeGreaterThan(tLast0);
  });

  it('signature changes when ink changes, not for highlighter', () => {
    const a = [glyph(0, 0), glyph(30, 0)];
    const s1 = inkSignature({ strokes: a });
    expect(inkSignature({ strokes: [...a, glyph(0, 0, 50, { kind: 'highlighter' })] })).toBe(s1);
    expect(inkSignature({ strokes: [...a, glyph(60, 0)] })).not.toBe(s1);
    expect(inkSignature({ strokes: a.slice(1) })).not.toBe(s1);
  });
});

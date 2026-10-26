import { eraseStroke } from '../../core/eraser';
import { capsuleHitsStroke, distToSegment, itemContains } from '../../core/geometry';
import type { Stroke } from '../../core/types';
import type { Content } from '../doc';
import type { Editor } from '../editor';
import type { Sample, Tool } from '../tool';

/** Stroke eraser or precise (partial) eraser. Tapes are removed whole. */
export class EraserTool implements Tool {
  private prev: Sample | null = null;
  private before = new Map<string, Content>();
  private cursor: { x: number; y: number } | null = null;

  constructor(private ed: Editor) {}

  private radiusWorld() {
    return this.ed.settings.get().eraserSize / this.ed.vp.zoom;
  }

  down(s: Sample) {
    this.before.clear();
    this.prev = s;
    this.cursor = { x: s.sx, y: s.sy };
    this.eraseSeg(s, s);
    this.ed.requestUI();
  }

  move(samples: Sample[]) {
    if (!this.prev) return;
    for (const s of samples) {
      this.eraseSeg(this.prev, s);
      this.prev = s;
    }
    const last = samples[samples.length - 1];
    if (last) this.cursor = { x: last.sx, y: last.sy };
    this.ed.requestUI();
  }

  private eraseSeg(a: Sample, b: Sample) {
    const r = this.radiusWorld();
    const partial = this.ed.settings.get().eraserMode === 'partial';
    const doc = this.ed.doc!;
    const vp = this.ed.vp;
    for (const i of vp.visiblePages()) {
      const rect = vp.rects[i];
      const page = doc.pages[i];
      if (Math.max(a.wx, b.wx) + r < rect.x || Math.min(a.wx, b.wx) - r > rect.x + rect.w) continue;
      if (Math.max(a.wy, b.wy) + r < rect.y || Math.min(a.wy, b.wy) - r > rect.y + rect.h) continue;
      const ax = a.wx - rect.x, ay = a.wy - rect.y, bx = b.wx - rect.x, by = b.wy - rect.y;
      let changed = false;
      const strokes: Stroke[] = [];
      for (const s of page.strokes) {
        if (s.locked) {
          strokes.push(s);
          continue;
        }
        if (partial) {
          const res = eraseStroke(s, ax, ay, bx, by, r);
          if (res === null) strokes.push(s);
          else {
            strokes.push(...res);
            changed = true;
          }
        } else if (capsuleHitsStroke(s, ax, ay, bx, by, r)) changed = true;
        else strokes.push(s);
      }
      const items = page.items.filter((it) => {
        if (it.type !== 'tape' || it.locked) return true;
        const hit =
          itemContains(it, ax, ay, r) ||
          itemContains(it, bx, by, r) ||
          itemContains(it, (ax + bx) / 2, (ay + by) / 2, r) ||
          distToSegment(it.x + it.w / 2, it.y + it.h / 2, ax, ay, bx, by) < r;
        if (hit) changed = true;
        return !hit;
      });
      if (!changed) continue;
      if (!this.before.has(page.id)) this.before.set(page.id, doc.content(page.id));
      doc.setContent(page.id, { strokes, items });
    }
  }

  up() {
    const doc = this.ed.doc!;
    doc.record([...this.before].map(([pageId, before]) => ({ pageId, before, after: doc.content(pageId) })));
    this.before.clear();
    this.prev = null;
  }

  cancel() {
    this.up();
  }

  abort() {
    const doc = this.ed.doc!;
    for (const [pageId, before] of this.before) doc.setContent(pageId, before);
    this.before.clear();
    this.prev = null;
  }

  hover(s: Sample | null) {
    this.cursor = s ? { x: s.sx, y: s.sy } : null;
    this.ed.requestUI();
  }

  deactivate() {
    this.cursor = null;
  }

  drawUI(ctx: CanvasRenderingContext2D) {
    if (!this.cursor) return;
    const r = this.ed.settings.get().eraserSize;
    ctx.beginPath();
    ctx.arc(this.cursor.x, this.cursor.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(60,60,70,0.8)';
    ctx.stroke();
  }
}

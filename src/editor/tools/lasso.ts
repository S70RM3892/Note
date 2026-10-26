import { distToSegment, itemCenter, itemContains, pointInPolygon } from '../../core/geometry';
import type { Pt } from '../../core/types';
import type { Editor, PageHit } from '../editor';
import type { Sample, Tool } from '../tool';

/** Free-form lasso. Tap selects a single object; drags on the selection move/scale/rotate it. */
export class LassoTool implements Tool {
  private path: Pt[] = []; // world
  private hit: PageHit | null = null;
  private dragging = false;

  constructor(private ed: Editor) {}

  down(s: Sample) {
    const sel = this.ed.selection;
    const h = sel.hitHandle(s.sx, s.sy);
    if (h) {
      this.dragging = true;
      sel.beginDrag(h, s.wx, s.wy);
      return;
    }
    sel.clear();
    this.ed.setRegion(null);
    this.hit = this.ed.pageAt(s.wx, s.wy, 40);
    this.path = [{ x: s.wx, y: s.wy }];
  }

  move(samples: Sample[]) {
    const last = samples[samples.length - 1];
    if (!last) return;
    if (this.dragging) {
      this.ed.selection.dragTo(last.wx, last.wy);
      return;
    }
    if (!this.hit) return;
    for (const s of samples) this.path.push({ x: s.wx, y: s.wy });
    this.ed.requestUI();
  }

  up(s: Sample) {
    if (this.dragging) {
      this.dragging = false;
      this.ed.selection.endDrag();
      this.ed.requestUI();
      return;
    }
    const hit = this.hit;
    this.hit = null;
    const path = this.path;
    this.path = [];
    this.ed.requestUI();
    if (!hit) return;
    const page = hit.page;
    let travel = 0;
    for (let i = 1; i < path.length; i++) travel += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    const tap = travel * this.ed.vp.zoom < 8;
    if (tap) {
      // Select the top-most object under the pen.
      const x = s.wx - hit.ox, y = s.wy - hit.oy;
      const tol = 8 / this.ed.vp.zoom;
      const pick = (id: string, locked?: boolean) => {
        if (locked) this.ed.onLockedTap(page, id, s.sx, s.sy);
        else this.ed.selection.set(page.id, [id]);
      };
      // Same order as painting, top-most first: tapes/text, ink, then photos/scans underneath.
      const above = (t: string) => t === 'tape' || t === 'text';
      for (let i = page.items.length - 1; i >= 0; i--) {
        const it = page.items[i];
        if (above(it.type) && itemContains(it, x, y, tol)) return pick(it.id, it.locked);
      }
      for (let i = page.strokes.length - 1; i >= 0; i--) {
        const st = page.strokes[i];
        const p = st.pts;
        const reach = tol + st.width / 2;
        if (p.length === 3 && Math.hypot(x - p[0], y - p[1]) <= reach) return pick(st.id, st.locked);
        for (let k = 0; k + 5 < p.length; k += 3) {
          if (distToSegment(x, y, p[k], p[k + 1], p[k + 3], p[k + 4]) <= reach) return pick(st.id, st.locked);
        }
      }
      for (let i = page.items.length - 1; i >= 0; i--) {
        const it = page.items[i];
        if (!above(it.type) && itemContains(it, x, y, tol)) return pick(it.id, it.locked);
      }
      return;
    }
    const poly = path.map((p) => ({ x: p.x - hit.ox, y: p.y - hit.oy }));
    if (poly.length < 3) return;
    const ids: string[] = [];
    for (const st of page.strokes) {
      if (st.locked) continue;
      const p = st.pts;
      const n = p.length / 3;
      const step = Math.max(1, Math.floor(n / 40));
      let inside = 0, total = 0;
      for (let k = 0; k < n; k += step) {
        total++;
        if (pointInPolygon(p[k * 3], p[k * 3 + 1], poly)) inside++;
      }
      if (total && inside / total >= 0.5) ids.push(st.id);
    }
    for (const it of page.items) {
      if (it.locked) continue;
      const c = itemCenter(it);
      if (pointInPolygon(c.x, c.y, poly)) ids.push(it.id);
    }
    if (ids.length) {
      this.ed.selection.set(page.id, ids);
      return;
    }
    // Nothing selectable inside: keep the area itself (copy a PDF figure, send a problem to the まちがいノート…).
    const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
    const x0 = Math.max(0, Math.min(...xs)), y0 = Math.max(0, Math.min(...ys));
    const x1 = Math.min(page.w, Math.max(...xs)), y1 = Math.min(page.h, Math.max(...ys));
    if (x1 - x0 >= 24 && y1 - y0 >= 16) this.ed.setRegion(page.id, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }

  cancel() {
    if (this.dragging) this.ed.selection.endDrag();
    this.dragging = false;
    this.path = [];
    this.hit = null;
    this.ed.requestUI();
  }

  deactivate() {
    this.ed.selection.clear();
    this.ed.setRegion(null);
  }

  drawUI(ctx: CanvasRenderingContext2D) {
    if (this.path.length > 1) {
      const vp = this.ed.vp;
      ctx.save();
      ctx.beginPath();
      this.path.forEach((p, i) => {
        const x = vp.toScreenX(p.x), y = vp.toScreenY(p.y);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(59,130,246,0.08)';
      ctx.fill();
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#3b82f6';
      ctx.stroke();
      ctx.restore();
    }
    this.ed.selection.drawUI(ctx);
    const rg = this.ed.region;
    const i = rg ? this.ed.doc?.indexOf(rg.pageId) ?? -1 : -1;
    if (rg && i >= 0) {
      const vp = this.ed.vp, o = vp.rects[i];
      const x = vp.toScreenX(o.x + rg.rect.x), y = vp.toScreenY(o.y + rg.rect.y);
      ctx.save();
      ctx.fillStyle = 'rgba(232,89,12,0.07)';
      ctx.fillRect(x, y, rg.rect.w * vp.zoom, rg.rect.h * vp.zoom);
      ctx.setLineDash([7, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#e8590c';
      ctx.strokeRect(x, y, rg.rect.w * vp.zoom, rg.rect.h * vp.zoom);
      ctx.restore();
    }
  }
}

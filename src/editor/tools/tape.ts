import { uid } from '../../core/id';
import type { TapeItem } from '../../core/types';
import type { Editor, PageHit } from '../editor';
import type { Sample, Tool } from '../tool';

/** 暗記テープ: drag to lay a strip of tape over an answer; tap a tape to peel/restore it. */
export class TapeTool implements Tool {
  private start: Sample | null = null;
  private end: Sample | null = null;
  private hit: PageHit | null = null;

  constructor(private ed: Editor) {}

  down(s: Sample) {
    this.start = this.end = s;
    this.hit = this.ed.pageAt(s.wx, s.wy);
  }

  move(samples: Sample[]) {
    if (!this.start) return;
    this.end = samples[samples.length - 1] ?? this.end;
    this.ed.requestUI();
  }

  private geometry(a: Sample, b: Sample): { cx: number; cy: number; len: number; ang: number; h: number } {
    let ang = Math.atan2(b.wy - a.wy, b.wx - a.wx);
    const deg = (ang * 180) / Math.PI;
    if (Math.abs(deg) < 7) ang = 0;
    else if (Math.abs(Math.abs(deg) - 180) < 7) ang = 0;
    else if (Math.abs(Math.abs(deg) - 90) < 7) ang = (Math.sign(deg) * Math.PI) / 2;
    const h = this.ed.settings.get().tapeWidth;
    const len = Math.hypot(b.wx - a.wx, b.wy - a.wy) + h * 0.4;
    return { cx: (a.wx + b.wx) / 2, cy: (a.wy + b.wy) / 2, len, ang, h };
  }

  up(s: Sample) {
    const a = this.start;
    this.end = s;
    this.start = null;
    this.ed.requestUI();
    if (!a || !this.hit) return;
    if (Math.hypot(s.sx - a.sx, s.sy - a.sy) < 6) {
      this.ed.toggleTapeAt(s.wx, s.wy);
      return;
    }
    const g = this.geometry(a, s);
    const h = this.hit;
    const tape: TapeItem = {
      id: uid(),
      type: 'tape',
      x: g.cx - h.ox - g.len / 2,
      y: g.cy - h.oy - g.h / 2,
      w: g.len,
      h: g.h,
      rot: g.ang,
      color: this.ed.settings.get().tapeColor,
    };
    this.ed.doc!.addItems(h.page.id, [tape]);
  }

  cancel() {
    this.start = null;
    this.ed.requestUI();
  }

  drawUI(ctx: CanvasRenderingContext2D) {
    if (!this.start || !this.end) return;
    const g = this.geometry(this.start, this.end);
    const vp = this.ed.vp;
    ctx.save();
    ctx.translate(vp.toScreenX(g.cx), vp.toScreenY(g.cy));
    ctx.rotate(g.ang);
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = this.ed.settings.get().tapeColor;
    const w = g.len * vp.zoom, h = g.h * vp.zoom;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, 3);
    ctx.fill();
    ctx.restore();
  }
}

import { uid } from '../../core/id';
import { radiusFor } from '../../core/ink';
import { StrokeModeler, modelerParams, type ModelPoint } from '../../core/modeler';
import { recognizeShape, type RecognizedShape } from '../../core/shapes';
import type { PenStyle, Pt, Stroke } from '../../core/types';
import type { Editor, PageHit } from '../editor';
import type { Sample, Tool } from '../tool';

const HOLD_MS = 450;
const HOLD_SLOP = 5; // CSS px

/**
 * Pen and highlighter: pressure ink with hold-to-snap shape recognition. Raw samples go through
 * the stroke modeler (core/modeler.ts) in page units; the live layer shows the modeled stroke
 * plus, on its prediction overlay, the catch-up to the pen tip and the platform's predicted points.
 */
export class PenTool implements Tool {
  private hit: PageHit | null = null;
  private pts: number[] = [];
  private model = new StrokeModeler();
  private style: PenStyle = 'ballpoint';
  private color = '#000';
  private width = 2;
  private holdTimer = 0;
  private hold = { x: 0, y: 0 };
  private snapped: RecognizedShape | null = null;
  private last: Sample | null = null;
  private started = 0;
  private predTimer = 0;
  /** The shell is drawing this stroke as low-latency wet ink: no live ink of our own. */
  private wet = false;
  /** S Pen hovering: where the tip would land (screen px). */
  private cursor: { x: number; y: number } | null = null;

  constructor(private ed: Editor, private kind: 'pen' | 'highlighter') {}

  private radius(p: number) {
    return radiusFor(this.kind, this.style, this.width, p);
  }

  hover(s: Sample | null) {
    const show = !!s && this.ed.settings.get().penCursor;
    if (!show && !this.cursor) return;
    this.cursor = show && s ? { x: s.sx, y: s.sy } : null;
    this.ed.requestUI();
  }

  deactivate() {
    this.cursor = null;
  }

  /** A dot the size and colour of a mid-pressure stroke, outlined so it shows on any paper. */
  drawUI(ctx: CanvasRenderingContext2D) {
    if (!this.cursor) return;
    const st = this.ed.settings.get();
    const pen = this.kind === 'pen';
    const w = pen ? st.pen.width : st.highlighter.width;
    const r = Math.max(1.5, radiusFor(this.kind, pen ? st.pen.style : 'marker', w, 0.5) * this.ed.vp.zoom);
    ctx.beginPath();
    ctx.arc(this.cursor.x, this.cursor.y, r, 0, Math.PI * 2);
    ctx.globalAlpha = pen ? 0.75 : 0.45;
    ctx.fillStyle = pen ? st.pen.color : st.highlighter.color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(this.cursor.x, this.cursor.y, r + 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.stroke();
  }

  down(s: Sample) {
    if (this.cursor) this.hover(null);
    const hit = this.ed.pageAt(s.wx, s.wy);
    if (!hit) {
      this.ed.wet?.cancel();
      return;
    }
    this.wet = this.kind === 'pen' && !!this.ed.wet?.claim();
    const st = this.ed.settings.get();
    if (this.kind === 'pen') {
      this.style = st.pen.style;
      this.color = st.pen.color;
      this.width = st.pen.width;
    } else {
      this.style = 'marker';
      this.color = st.highlighter.color;
      this.width = st.highlighter.width;
    }
    this.hit = hit;
    this.pts = [];
    this.snapped = null;
    this.started = s.t;
    this.model = new StrokeModeler(this.modelParams(st.stabilization));
    this.ed.live.begin(this.color, this.kind === 'highlighter', hit.dark, this.pencilOrigin());
    const first = this.model.reset(s.wx - hit.ox, s.wy - hit.oy, s.p, s.t);
    this.push(first.x, first.y, first.p, true);
    this.last = s;
    // 直線マーカー: the stroke is a straight line from the start (the snapped-line path below).
    if (this.kind === 'highlighter' && st.highlighterStraight) {
      this.snapped = { kind: 'line', pts: [{ x: first.x, y: first.y }, { x: first.x, y: first.y }], closed: false };
      this.drawSnapped();
      return;
    }
    this.armHold(s);
  }

  /** 手ぶれ補正 widens the slow-speed smoothing (0 = the modeler's defaults). */
  private modelParams(stabilization: number) {
    const p = modelerParams(this.ed.vp.zoom);
    const k = 1 + 3 * stabilization;
    return { ...p, wobbleWindow: p.wobbleWindow + 100 * stabilization, speedFloor: p.speedFloor * k, speedCeiling: p.speedCeiling * k };
  }

  private pencilOrigin(): { x: number; y: number } | undefined {
    if (this.kind !== 'pen' || this.style !== 'pencil' || !this.hit) return undefined;
    const vp = this.ed.vp;
    return { x: vp.toScreenX(this.hit.ox), y: vp.toScreenY(this.hit.oy) };
  }

  private armHold(s: Sample) {
    clearTimeout(this.holdTimer);
    this.hold = { x: s.sx, y: s.sy };
    if (!this.ed.settings.get().shapeHold) return;
    this.holdTimer = window.setTimeout(() => this.trySnap(), HOLD_MS);
  }

  /** Append a modeled point (page coordinates of the stroke's page). */
  private push(x: number, y: number, p: number, force = false, show = true) {
    const h = this.hit!;
    const wx = x + h.ox, wy = y + h.oy;
    const n = this.pts.length;
    if (!force && n) {
      const dx = x - this.pts[n - 3], dy = y - this.pts[n - 2];
      if (dx * dx + dy * dy < (0.45 / this.ed.vp.zoom) ** 2) return;
    }
    this.pts.push(x, y, p);
    if (this.wet) return;
    const vp = this.ed.vp;
    this.ed.live.add(vp.toScreenX(wx), vp.toScreenY(wy), this.radius(p) * vp.zoom, show);
  }

  move(samples: Sample[], predicted: Sample[]) {
    if (!this.hit) return;
    const last = samples[samples.length - 1];
    if (last) this.last = last;
    if (this.snapped) {
      if (this.snapped.kind === 'line' && last) {
        const a = this.snapped.pts[0];
        let x = last.wx - this.hit.ox, y = last.wy - this.hit.oy;
        const ang = Math.atan2(y - a.y, x - a.x);
        const snapA = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
        if (Math.abs(ang - snapA) < (4 * Math.PI) / 180) {
          const len = Math.hypot(x - a.x, y - a.y);
          x = a.x + Math.cos(snapA) * len;
          y = a.y + Math.sin(snapA) * len;
        }
        this.snapped.pts[1] = { x, y };
        this.drawSnapped();
      }
      return;
    }
    const h = this.hit;
    for (const s of samples) {
      for (const q of this.model.update(s.wx - h.ox, s.wy - h.oy, s.p, s.t)) this.push(q.x, q.y, q.p, false, false);
      if (Math.hypot(s.sx - this.hold.x, s.sy - this.hold.y) > HOLD_SLOP) this.armHold(s);
    }
    if (this.wet) return;
    this.ed.live.show();
    // The modeled tip trails the pen a little: show the catch-up to the pen (as if it lifted
    // now) and then the platform's predicted points, on the overlay that is redrawn each event.
    const vp = this.ed.vp;
    const n = this.pts.length;
    if (n < 3) return this.ed.live.predict(null, []);
    const tip = { sx: vp.toScreenX(this.pts[n - 3] + h.ox), sy: vp.toScreenY(this.pts[n - 2] + h.oy), r: this.radius(this.pts[n - 1]) * vp.zoom };
    const ahead = this.model.predict().map((q: ModelPoint) => ({ sx: vp.toScreenX(q.x + h.ox), sy: vp.toScreenY(q.y + h.oy), r: this.radius(q.p) * vp.zoom }));
    const r = ahead.length ? ahead[ahead.length - 1].r : tip.r;
    for (const q of predicted.slice(0, 3)) ahead.push({ sx: q.sx, sy: q.sy, r });
    this.ed.live.predict(tip, ahead);
    // If the pen stops, no further events arrive: don't leave an overshoot on screen.
    clearTimeout(this.predTimer);
    this.predTimer = window.setTimeout(() => this.ed.live.predict(tip, this.model.predict().map((q) => ({ sx: vp.toScreenX(q.x + h.ox), sy: vp.toScreenY(q.y + h.oy), r: this.radius(q.p) * vp.zoom }))), 50);
  }

  private shapePoints(): Pt[] {
    const out: Pt[] = [];
    for (let i = 0; i < this.pts.length; i += 3) out.push({ x: this.pts[i], y: this.pts[i + 1] });
    return out;
  }

  private trySnap() {
    if (!this.hit || this.snapped || this.pts.length < 18) return;
    const shape = recognizeShape(this.shapePoints());
    if (!shape) return;
    this.snapped = shape;
    navigator.vibrate?.(12);
    // The shape preview is ours: take the wet stroke off the screen.
    if (this.wet) {
      this.wet = false;
      this.ed.wet?.cancel();
    }
    this.drawSnapped();
  }

  private drawSnapped() {
    const h = this.hit!, s = this.snapped!, vp = this.ed.vp;
    this.ed.live.clear();
    this.ed.live.polyline(
      s.pts.map((p) => ({ x: vp.toScreenX(p.x + h.ox), y: vp.toScreenY(p.y + h.oy) })),
      this.width * vp.zoom,
      s.closed,
    );
  }

  repaintLive() {
    if (!this.hit || this.wet) return;
    if (this.snapped) return this.drawSnapped();
    const vp = this.ed.vp, h = this.hit;
    this.ed.live.begin(this.color, this.kind === 'highlighter', h.dark, this.pencilOrigin());
    for (let i = 0; i < this.pts.length; i += 3) {
      this.ed.live.add(vp.toScreenX(this.pts[i] + h.ox), vp.toScreenY(this.pts[i + 1] + h.oy), this.radius(this.pts[i + 2]) * vp.zoom);
    }
  }

  up(s: Sample) {
    clearTimeout(this.holdTimer);
    clearTimeout(this.predTimer);
    if (!this.hit) return;
    const h = this.hit;
    let stroke: Stroke;
    if (this.snapped) {
      const pts = new Float32Array(this.snapped.pts.length * 3);
      this.snapped.pts.forEach((p, i) => {
        pts[i * 3] = p.x;
        pts[i * 3 + 1] = p.y;
        pts[i * 3 + 2] = 0.5;
      });
      stroke = { id: uid(), kind: this.kind, style: this.style, color: this.color, width: this.width, pts, shape: true, closed: this.snapped.closed || undefined };
    } else {
      // The lift-off sample, then the tip follows the spring to it (no straight catch-up jump).
      const l = this.last;
      if (s && l && (s.wx !== l.wx || s.wy !== l.wy) && s.t >= l.t) {
        for (const q of this.model.update(s.wx - h.ox, s.wy - h.oy, l.p, s.t)) this.push(q.x, q.y, q.p, false, false);
      }
      for (const q of this.model.finish()) this.push(q.x, q.y, q.p, false, false);
      stroke = { id: uid(), kind: this.kind, style: this.style, color: this.color, width: this.width, pts: new Float32Array(this.pts) };
    }
    this.hit = null;
    this.ed.live.predict(null, []);
    this.ed.commitStroke(h.page.id, stroke, this.wet);
    this.wet = false;
    this.ed.noteActivity(s ? s.t - this.started : 0);
  }

  abort() {
    clearTimeout(this.holdTimer);
    clearTimeout(this.predTimer);
    if (this.wet) this.ed.wet?.cancel();
    this.wet = false;
    this.hit = null;
    this.ed.live.predict(null, []);
    this.ed.live.clear();
  }

  cancel() {
    // Keep what was written: Android may cancel the pen when the palm lands.
    if (this.hit && this.last) this.up(this.last);
    clearTimeout(this.holdTimer);
    this.hit = null;
  }
}

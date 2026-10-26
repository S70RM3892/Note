import { uid } from '../../core/id';
import { radiusFor } from '../../core/ink';
import { recognizeShape, type RecognizedShape } from '../../core/shapes';
import type { PenStyle, Pt, Stroke } from '../../core/types';
import type { Editor, PageHit } from '../editor';
import type { Sample, Tool } from '../tool';

const HOLD_MS = 450;
const HOLD_SLOP = 5; // CSS px

/** Pen and highlighter: smoothed pressure ink with hold-to-snap shape recognition. */
export class PenTool implements Tool {
  private hit: PageHit | null = null;
  private pts: number[] = [];
  private sm = { x: 0, y: 0, p: 0.5 };
  private style: PenStyle = 'ballpoint';
  private color = '#000';
  private width = 2;
  private holdTimer = 0;
  private hold = { x: 0, y: 0 };
  private snapped: RecognizedShape | null = null;
  private last: Sample | null = null;
  private started = 0;

  constructor(private ed: Editor, private kind: 'pen' | 'highlighter') {}

  private radius(p: number) {
    return radiusFor(this.kind, this.style, this.width, p);
  }

  down(s: Sample) {
    const hit = this.ed.pageAt(s.wx, s.wy);
    if (!hit) return;
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
    this.sm = { x: s.wx, y: s.wy, p: s.p };
    this.ed.live.begin(this.color, this.kind === 'highlighter', hit.dark, this.pencilOrigin());
    this.push(s.wx, s.wy, s.p, true);
    this.last = s;
    this.armHold(s);
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

  private push(wx: number, wy: number, p: number, force = false, show = true) {
    const h = this.hit!;
    const x = wx - h.ox, y = wy - h.oy;
    const n = this.pts.length;
    if (!force && n) {
      const dx = x - this.pts[n - 3], dy = y - this.pts[n - 2];
      if (dx * dx + dy * dy < (0.45 / this.ed.vp.zoom) ** 2) return;
    }
    this.pts.push(x, y, p);
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
    const k = this.ed.settings.get().stabilization;
    for (const s of samples) {
      this.sm.x += (s.wx - this.sm.x) * (1 - k);
      this.sm.y += (s.wy - this.sm.y) * (1 - k);
      this.sm.p += (s.p - this.sm.p) * 0.6;
      this.push(this.sm.x, this.sm.y, this.sm.p, false, false);
      if (Math.hypot(s.sx - this.hold.x, s.sy - this.hold.y) > HOLD_SLOP) this.armHold(s);
    }
    this.ed.live.show();
    // Prediction: extend from the current smoothed tip to where the pen is heading.
    const vp = this.ed.vp;
    const n = this.pts.length;
    if (n >= 3 && predicted.length) {
      const tip = { sx: vp.toScreenX(this.pts[n - 3] + this.hit.ox), sy: vp.toScreenY(this.pts[n - 2] + this.hit.oy), r: this.radius(this.pts[n - 1]) * vp.zoom };
      this.ed.live.predict(tip, predicted.slice(0, 3).map((q) => ({ sx: q.sx, sy: q.sy, r: tip.r })));
    } else this.ed.live.predict(null, []);
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
    if (!this.hit) return;
    if (this.snapped) return this.drawSnapped();
    const vp = this.ed.vp, h = this.hit;
    this.ed.live.begin(this.color, this.kind === 'highlighter', h.dark, this.pencilOrigin());
    for (let i = 0; i < this.pts.length; i += 3) {
      this.ed.live.add(vp.toScreenX(this.pts[i] + h.ox), vp.toScreenY(this.pts[i + 1] + h.oy), this.radius(this.pts[i + 2]) * vp.zoom);
    }
  }

  up(s: Sample) {
    clearTimeout(this.holdTimer);
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
      // Catch up with the pen tip that smoothing lagged behind.
      if (s && (s.wx !== this.sm.x || s.wy !== this.sm.y)) this.push(s.wx, s.wy, this.sm.p);
      stroke = { id: uid(), kind: this.kind, style: this.style, color: this.color, width: this.width, pts: new Float32Array(this.pts) };
    }
    this.hit = null;
    this.ed.live.predict(null, []);
    this.ed.commitStroke(h.page.id, stroke);
    this.ed.noteActivity(s ? s.t - this.started : 0);
  }

  abort() {
    clearTimeout(this.holdTimer);
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

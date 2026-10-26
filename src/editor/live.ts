import { HIGHLIGHT_ALPHA, LiveInkPainter, pencilFill } from '../core/ink';

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function grow(b: Box | null, x: number, y: number, r: number): Box {
  if (!b) return { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
  return { x0: Math.min(b.x0, x - r), y0: Math.min(b.y0, y - r), x1: Math.max(b.x1, x + r), y1: Math.max(b.y1, y + r) };
}

function union(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/**
 * Low-latency layer for the stroke being drawn.
 *
 * The visible canvas uses the `desynchronized` hint (front-buffer rendering where
 * the platform supports it). Ink is painted into an offscreen buffer and the changed
 * region is copied over, so predicted segments can be drawn on top and replaced next
 * event without ever clearing the visible canvas mid-stroke.
 */
export class LiveLayer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buf: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private painter: LiveInkPainter;
  private predPainter: LiveInkPainter;
  private dirty: Box | null = null;
  private predBox: Box | null = null;
  private inkBox: Box | null = null;
  private raf = 0;
  private lastPt: { x: number; y: number; pad: number } | null = null;
  private clearGen = 0;
  private pendingClear = false;
  dpr = 1;
  readonly lowLatency: boolean;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ed-live';
    this.ctx = this.canvas.getContext('2d', { desynchronized: true, alpha: true })!;
    this.lowLatency = !!(this.ctx.getContextAttributes?.() as { desynchronized?: boolean } | undefined)?.desynchronized;
    this.buf = document.createElement('canvas');
    this.bctx = this.buf.getContext('2d')!;
    this.painter = new LiveInkPainter(this.bctx, '#000');
    this.predPainter = new LiveInkPainter(this.ctx, '#000');
  }

  resize(w: number, h: number, dpr: number) {
    this.dpr = dpr;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    for (const c of [this.canvas, this.buf]) {
      c.width = W;
      c.height = H;
    }
    this.inkBox = this.dirty = this.predBox = null;
  }

  /** `pencilOrigin`: page origin in CSS px, to anchor the pencil grain like the committed stroke. */
  begin(color: string, highlighter: boolean, darkPaper: boolean, pencilOrigin?: { x: number; y: number }) {
    if (this.pendingClear) this.clear();
    const d = this.dpr;
    const fill = pencilOrigin ? pencilFill(this.bctx, color, darkPaper, pencilOrigin.x * d, pencilOrigin.y * d) : null;
    const pfill = pencilOrigin ? pencilFill(this.ctx, color, darkPaper, pencilOrigin.x * d, pencilOrigin.y * d) : null;
    this.painter.reset(color, fill);
    this.predPainter.reset(color, pfill);
    this.lastPt = null;
    this.canvas.style.mixBlendMode = highlighter && !darkPaper ? 'multiply' : 'normal';
    this.canvas.style.opacity = highlighter && darkPaper ? String(HIGHLIGHT_ALPHA) : '1';
  }

  /** Add a sample (CSS px, radius in CSS px). Pass show=false to batch, then call show(). */
  add(sx: number, sy: number, r: number, show = true) {
    const d = this.dpr;
    this.painter.add(sx * d, sy * d, r * d);
    const pad = r * d + 2;
    // The new segment reaches back to the previous sample: copy that part too.
    if (this.lastPt) this.dirty = grow(this.dirty, this.lastPt.x, this.lastPt.y, this.lastPt.pad);
    this.dirty = grow(this.dirty, sx * d, sy * d, pad);
    this.inkBox = grow(this.inkBox, sx * d, sy * d, pad);
    this.lastPt = { x: sx * d, y: sy * d, pad };
    if (show) this.flush();
  }

  /** Copy everything added since the last show to the screen. */
  show() {
    this.flush();
  }

  /** Draw a constant-width polyline (shape preview), replacing the ink so far. */
  polyline(pts: { x: number; y: number }[], width: number, closed?: boolean) {
    const d = this.dpr;
    const b = this.bctx;
    b.clearRect(0, 0, this.buf.width, this.buf.height);
    b.save();
    b.strokeStyle = this.painter.color;
    b.lineWidth = Math.max(1, width * d);
    b.lineCap = 'round';
    b.lineJoin = 'round';
    b.beginPath();
    pts.forEach((p, i) => (i ? b.lineTo(p.x * d, p.y * d) : b.moveTo(p.x * d, p.y * d)));
    if (closed) b.closePath();
    b.stroke();
    b.restore();
    let box: Box | null = null;
    for (const p of pts) box = grow(box, p.x * d, p.y * d, width * d + 2);
    this.dirty = union(union(this.dirty, this.inkBox), box);
    this.inkBox = box;
    this.flush();
  }

  /** Predicted continuation, drawn on the visible canvas only. */
  predict(tip: { sx: number; sy: number; r: number } | null, pts: { sx: number; sy: number; r: number }[]) {
    this.dirty = union(this.dirty, this.predBox);
    this.predBox = null;
    this.flush();
    if (!tip || !pts.length) return;
    const d = this.dpr;
    this.predPainter.reset(this.painter.color, this.predPainter.fill);
    this.predPainter.add(tip.sx * d, tip.sy * d, tip.r * d);
    let box: Box | null = grow(null, tip.sx * d, tip.sy * d, tip.r * d + 2);
    for (const p of pts) {
      this.predPainter.add(p.sx * d, p.sy * d, p.r * d);
      box = grow(box, p.sx * d, p.sy * d, p.r * d + 2);
    }
    this.predBox = box;
  }

  private flush() {
    const b = this.dirty;
    if (!b) return;
    this.dirty = null;
    const x = Math.max(0, Math.floor(b.x0)), y = Math.max(0, Math.floor(b.y0));
    const w = Math.min(this.canvas.width, Math.ceil(b.x1)) - x, h = Math.min(this.canvas.height, Math.ceil(b.y1)) - y;
    if (w <= 0 || h <= 0) return;
    const c = this.ctx;
    c.save();
    // 'copy' replaces the region atomically (no blank frame on a front buffer);
    // the clip is essential, otherwise 'copy' wipes everything outside the image.
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
    c.globalCompositeOperation = 'copy';
    c.drawImage(this.buf, x, y, w, h, x, y, w, h);
    c.restore();
  }

  /** Clear after the main canvas has had time to show the committed stroke. */
  clearSoon() {
    const gen = ++this.clearGen;
    this.pendingClear = true;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      this.raf = requestAnimationFrame(() => {
        if (gen === this.clearGen && this.pendingClear) this.clear();
      });
    });
  }

  clear() {
    this.pendingClear = false;
    this.clearGen++;
    this.bctx.clearRect(0, 0, this.buf.width, this.buf.height);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.inkBox = this.dirty = this.predBox = null;
    this.lastPt = null;
  }
}

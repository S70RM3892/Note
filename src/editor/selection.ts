import {
  IDENTITY,
  applyMat,
  itemBounds,
  matMul,
  rectUnion,
  similarity,
  strokeBounds,
  transformItem,
  transformStroke,
  translate,
  type Mat,
} from '../core/geometry';
import { uid } from '../core/id';
import type { Item, Pt, Rect, Stroke, TapeItem } from '../core/types';
import type { Editor } from './editor';

export type Handle = 'move' | 'nw' | 'ne' | 'se' | 'sw' | 'rotate';

interface Clip {
  strokes: Stroke[];
  items: Item[];
  bounds: Rect;
}

/** App-wide clipboard so content can be pasted into another notebook. */
let clipboard: Clip | null = null;

export function hasClipboard() {
  return !!clipboard;
}

/** Assets the clipboard still points at (kept by asset garbage collection). */
export function clipboardAssets(): Set<string> {
  const s = new Set<string>();
  for (const it of clipboard?.items ?? []) if (it.type === 'image') s.add(it.asset);
  return s;
}

const HANDLE_R = 14; // CSS px touch radius

/** Lasso selection on one page: live transform, actions and the floating menu. */
export class SelectionManager {
  pageId: string | null = null;
  ids = new Set<string>();
  bounds: Rect = { x: 0, y: 0, w: 0, h: 0 }; // page coordinates (before m)
  m: Mat = IDENTITY;
  private drag: { handle: Handle; start: Pt; m0: Mat; pivot: Pt; startAngle: number; startDist: number } | null = null;
  /** Lock these objects when the selection is dismissed (a freshly placed photo/scan). */
  private autoLock = false;
  onChange: () => void = () => {};

  constructor(private ed: Editor) {}

  get active() {
    return !!this.pageId && this.ids.size > 0;
  }

  private objects() {
    const page = this.ed.doc?.page(this.pageId!);
    if (!page) return { strokes: [] as Stroke[], items: [] as Item[] };
    return { strokes: page.strokes.filter((s) => this.ids.has(s.id)), items: page.items.filter((i) => this.ids.has(i.id)) };
  }

  private computeBounds(): Rect {
    const { strokes, items } = this.objects();
    let r: Rect | null = null;
    for (const s of strokes) r = rectUnion(r, strokeBounds(s));
    for (const i of items) r = rectUnion(r, itemBounds(i));
    return r ?? { x: 0, y: 0, w: 0, h: 0 };
  }

  set(pageId: string, ids: Iterable<string>, opts: { autoLock?: boolean } = {}) {
    this.clear();
    this.pageId = pageId;
    this.ids = new Set(ids);
    this.autoLock = !!opts.autoLock;
    if (!this.ids.size) {
      this.pageId = null;
      return;
    }
    this.bounds = this.computeBounds();
    this.m = IDENTITY;
    this.ed.renderer.invalidate(pageId, this.bounds);
    this.onChange();
  }

  clear() {
    if (this.pageId) {
      const pid = this.pageId;
      const ids = this.ids;
      const b = this.worldlessBounds();
      const lockNow = this.autoLock && this.ed.settings.get().autoLockPlaced;
      this.autoLock = false;
      this.pageId = null;
      this.ids = new Set();
      this.ed.renderer.invalidate(pid, b);
      if (lockNow && this.ed.doc?.page(pid)) {
        this.ed.setLocked(pid, ids, true, false);
        this.ed.toast?.('固定した（投げ縄でタップすると解除できる）');
      }
      this.onChange();
    }
    this.drag = null;
    this.m = IDENTITY;
  }

  /** Current box corners in page coordinates (after the live transform). */
  corners(): Pt[] {
    const b = this.bounds;
    return [
      { x: b.x, y: b.y },
      { x: b.x + b.w, y: b.y },
      { x: b.x + b.w, y: b.y + b.h },
      { x: b.x, y: b.y + b.h },
    ].map((p) => applyMat(this.m, p.x, p.y));
  }

  private worldlessBounds(): Rect {
    const cs = this.corners();
    const xs = cs.map((p) => p.x), ys = cs.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x: x - 4, y: y - 4, w: Math.max(...xs) - x + 8, h: Math.max(...ys) - y + 8 };
  }

  private origin(): Pt {
    const i = this.ed.doc!.indexOf(this.pageId!);
    const r = this.ed.vp.rects[i];
    return { x: r?.x ?? 0, y: r?.y ?? 0 };
  }

  /** Screen positions of corners and the rotate knob. */
  screenGeometry() {
    const o = this.origin();
    const vp = this.ed.vp;
    const cs = this.corners().map((p) => ({ x: vp.toScreenX(p.x + o.x), y: vp.toScreenY(p.y + o.y) }));
    const topMid = { x: (cs[0].x + cs[1].x) / 2, y: (cs[0].y + cs[1].y) / 2 };
    const ang = Math.atan2(cs[1].y - cs[0].y, cs[1].x - cs[0].x);
    const rot = { x: topMid.x + Math.sin(ang) * 30, y: topMid.y - Math.cos(ang) * 30 };
    return { cs, rot };
  }

  hitHandle(sx: number, sy: number): Handle | null {
    if (!this.active) return null;
    const { cs, rot } = this.screenGeometry();
    const near = (p: Pt) => Math.hypot(p.x - sx, p.y - sy) <= HANDLE_R + 6;
    if (near(rot)) return 'rotate';
    const names: Handle[] = ['nw', 'ne', 'se', 'sw'];
    for (let i = 0; i < 4; i++) if (near(cs[i])) return names[i];
    // Inside the (possibly rotated) box?
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const a = cs[i], b = cs[j];
      if (a.y > sy !== b.y > sy && sx < ((b.x - a.x) * (sy - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside ? 'move' : null;
  }

  beginDrag(handle: Handle, wx: number, wy: number) {
    const o = this.origin();
    const p = { x: wx - o.x, y: wy - o.y };
    const cs = this.corners();
    const center = { x: (cs[0].x + cs[2].x) / 2, y: (cs[0].y + cs[2].y) / 2 };
    const opposite: Record<string, Pt> = { nw: cs[2], ne: cs[3], se: cs[0], sw: cs[1] };
    const pivot = handle === 'rotate' || handle === 'move' ? center : opposite[handle];
    this.drag = {
      handle,
      start: p,
      m0: this.m,
      pivot,
      startAngle: Math.atan2(p.y - pivot.y, p.x - pivot.x),
      startDist: Math.max(1, Math.hypot(p.x - pivot.x, p.y - pivot.y)),
    };
  }

  dragTo(wx: number, wy: number) {
    const d = this.drag;
    if (!d) return;
    const o = this.origin();
    const p = { x: wx - o.x, y: wy - o.y };
    let step: Mat;
    if (d.handle === 'move') step = translate(p.x - d.start.x, p.y - d.start.y);
    else if (d.handle === 'rotate') {
      let a = Math.atan2(p.y - d.pivot.y, p.x - d.pivot.x) - d.startAngle;
      const snap = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      if (Math.abs(a - snap) < 0.05) a = snap;
      step = similarity(d.pivot.x, d.pivot.y, 1, a);
    } else {
      const k = Math.max(0.05, Math.hypot(p.x - d.pivot.x, p.y - d.pivot.y) / d.startDist);
      step = similarity(d.pivot.x, d.pivot.y, k, 0);
    }
    this.m = matMul(step, d.m0);
    this.ed.renderer.request();
    this.ed.requestUI();
  }

  endDrag() {
    if (!this.drag) return;
    this.drag = null;
    this.applyTransform();
  }

  get dragging() {
    return !!this.drag;
  }

  /** Bake the live transform into the objects (moving them to another page if dropped there). */
  private applyTransform() {
    const doc = this.ed.doc!;
    const m = this.m;
    if (m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9)) return;
    const srcId = this.pageId!;
    const src = doc.page(srcId)!;
    const o = this.origin();
    const cs = this.corners();
    const center = { x: (cs[0].x + cs[2].x) / 2 + o.x, y: (cs[0].y + cs[2].y) / 2 + o.y };
    const ti = this.ed.vp.pageAt(center.x, center.y);
    const dst = ti >= 0 ? doc.pages[ti] : src;
    let mm = m;
    if (dst !== src) {
      const r = this.ed.vp.rects[ti];
      mm = matMul(translate(o.x - r.x, o.y - r.y), m);
    }
    const moved = new Map<string, Stroke | Item>();
    for (const s of src.strokes) if (this.ids.has(s.id)) moved.set(s.id, transformStroke(s, mm));
    for (const it of src.items) if (this.ids.has(it.id)) moved.set(it.id, transformItem(it, mm));
    const before = doc.content(srcId);
    if (dst === src) {
      const after = {
        strokes: before.strokes.map((s) => (moved.get(s.id) as Stroke) ?? s),
        items: before.items.map((i) => (moved.get(i.id) as Item) ?? i),
      };
      this.m = IDENTITY;
      doc.commit([{ pageId: srcId, before, after }]);
    } else {
      const dBefore = doc.content(dst.id);
      const ms = [...moved.values()];
      const afterSrc = { strokes: before.strokes.filter((s) => !this.ids.has(s.id)), items: before.items.filter((i) => !this.ids.has(i.id)) };
      const afterDst = {
        strokes: [...dBefore.strokes, ...(ms.filter((x) => 'pts' in x) as Stroke[])],
        items: [...dBefore.items, ...(ms.filter((x) => !('pts' in x)) as Item[])],
      };
      this.m = IDENTITY;
      this.pageId = dst.id;
      doc.commit([
        { pageId: srcId, before, after: afterSrc },
        { pageId: dst.id, before: dBefore, after: afterDst },
      ]);
      this.ed.renderer.invalidate(srcId, null);
    }
    this.bounds = this.computeBounds();
    this.ed.renderer.invalidate(this.pageId!, this.bounds);
    this.onChange();
  }

  // ---------- actions ----------

  /** 固定: lock the selection so the lasso and eraser leave it alone. */
  lock() {
    if (!this.active) return;
    const pid = this.pageId!;
    const ids = [...this.ids];
    this.autoLock = false;
    this.clear();
    this.ed.setLocked(pid, ids, true);
  }

  delete() {
    if (!this.active) return;
    this.autoLock = false;
    const doc = this.ed.doc!;
    const pid = this.pageId!;
    const before = doc.content(pid);
    const ids = this.ids;
    this.clear();
    doc.commit([{ pageId: pid, before, after: { strokes: before.strokes.filter((s) => !ids.has(s.id)), items: before.items.filter((i) => !ids.has(i.id)) } }]);
  }

  copy() {
    if (!this.active) return;
    const { strokes, items } = this.objects();
    clipboard = { strokes, items, bounds: this.computeBounds() };
    this.onChange();
  }

  cut() {
    this.copy();
    this.delete();
  }

  duplicate() {
    if (!this.active) return;
    this.autoLock = false;
    this.copy();
    const pid = this.pageId!;
    this.pasteInto(pid, { x: this.bounds.x + 24, y: this.bounds.y + 24 });
  }

  /** Paste the clipboard onto a page; `at` is the top-left in page coordinates. */
  pasteInto(pageId: string, at?: Pt) {
    if (!clipboard) return;
    const doc = this.ed.doc!;
    const page = doc.page(pageId)!;
    const b = clipboard.bounds;
    const target = at ?? { x: Math.max(0, (page.w - b.w) / 2), y: Math.max(0, (page.h - b.h) / 2) };
    const m = translate(target.x - b.x, target.y - b.y);
    const strokes = clipboard.strokes.map((s) => transformStroke(s, m, uid()));
    const items = clipboard.items.map((i) => transformItem(i, m, uid()));
    const before = doc.content(pageId);
    this.clear();
    doc.commit([{ pageId, before, after: { strokes: [...before.strokes, ...strokes], items: [...before.items, ...items] } }]);
    this.set(pageId, [...strokes.map((s) => s.id), ...items.map((i) => i.id)]);
  }

  recolor(color: string) {
    if (!this.active) return;
    const doc = this.ed.doc!;
    const pid = this.pageId!;
    const before = doc.content(pid);
    const after = {
      strokes: before.strokes.map((s) => (this.ids.has(s.id) && s.kind === 'pen' ? { ...s, color } : s)),
      items: before.items.map((i) => (this.ids.has(i.id) && i.type === 'text' ? { ...i, color } : i)),
    };
    doc.commit([{ pageId: pid, before, after }]);
  }

  /** Cover the selection with 暗記テープ. */
  toTape() {
    if (!this.active) return;
    const b = this.computeBounds();
    const pid = this.pageId!;
    this.clear();
    const pad = 2;
    const tape: TapeItem = { id: uid(), type: 'tape', x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2, rot: 0, color: this.ed.settings.get().tapeColor };
    this.ed.doc!.addItems(pid, [tape]);
  }

  drawUI(ctx: CanvasRenderingContext2D) {
    if (!this.active) return;
    const { cs, rot } = this.screenGeometry();
    ctx.save();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    cs.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo((cs[0].x + cs[1].x) / 2, (cs[0].y + cs[1].y) / 2);
    ctx.lineTo(rot.x, rot.y);
    ctx.stroke();
    for (const p of [...cs, rot]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}

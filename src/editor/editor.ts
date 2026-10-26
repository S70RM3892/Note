import { itemContains } from '../core/geometry';
import { isDarkColor } from '../core/ink';
import type { Page, Rect, Stroke, TapeItem } from '../core/types';
import type { SettingsStore } from '../store/settings';
import type { AssetCache } from './assets';
import type { EditorDoc } from './doc';
import { LiveLayer } from './live';
import { paintObjects } from './paint';
import { Renderer } from './renderer';
import { SelectionManager } from './selection';
import type { Sample, Tool, ToolName } from './tool';
import { EraserTool } from './tools/eraser';
import { LassoTool } from './tools/lasso';
import { PenTool } from './tools/pen';
import { TapeTool } from './tools/tape';
import { TextEditor, TextTool } from './tools/text';
import { Viewport } from './viewport';

export interface PageHit {
  index: number;
  page: Page;
  /** World position of the page's top-left corner. */
  ox: number;
  oy: number;
  dark: boolean;
}

interface TouchPt {
  x: number;
  y: number;
  x0: number;
  y0: number;
}

type GestureMode = 'none' | 'pending' | 'pan' | 'pinch' | 'draw' | 'select';

const TAP_MS = 280;
const TAP_SLOP = 12;
const PEN_TOUCH_BLOCK_MS = 450;

/** The note canvas: viewport, input routing, tools and rendering. */
export class Editor {
  readonly el: HTMLDivElement;
  readonly vp = new Viewport();
  readonly renderer: Renderer;
  readonly live = new LiveLayer();
  readonly selection: SelectionManager;
  readonly textEditor: TextEditor;
  doc: EditorDoc | null = null;
  tool: ToolName = 'pen';
  /** Hide every tape regardless of its own state (review mode). */
  tapeMode: 'normal' | 'hide' = 'normal';
  /** Set by the Android shell / keyboard when the S Pen side button is held. */
  sideButtonHeld = false;
  /** Reference viewer: the pen scrolls instead of writing and nothing is modified. */
  readOnly = false;

  private ui: HTMLCanvasElement;
  private uiCtx: CanvasRenderingContext2D;
  private uiRaf = 0;
  private tools: Record<ToolName, Tool>;
  private activeTool: Tool | null = null;
  private toolPtr: number | null = null;
  private toolPtrType = '';
  private touches = new Map<number, TouchPt>();
  private ignored = new Set<number>();
  private mode: GestureMode = 'none';
  private maxTouches = 0;
  private gestureStart = 0;
  private tapMoved = false;
  private pinch = { d0: 1, z0: 1, wx: 0, wy: 0 };
  private panLast = { x: 0, y: 0, t: 0 };
  private velocity = { x: 0, y: 0 };
  private momentumRaf = 0;
  private lastPen = -1e9;
  private hoverTool: Tool | null = null;
  private mousePan: { x: number; y: number; id: number } | null = null;
  private listeners = new Set<() => void>();
  private stateRaf = 0;
  private unsubAssets: () => void;
  private ro: ResizeObserver;
  penSeen = false;
  onActivity: (durationMs: number) => void = () => {};

  constructor(host: HTMLElement, public settings: SettingsStore, public assets: AssetCache) {
    this.el = document.createElement('div');
    this.el.className = 'ed-stage';
    const main = document.createElement('canvas');
    main.className = 'ed-main';
    this.ui = document.createElement('canvas');
    this.ui.className = 'ed-ui';
    this.uiCtx = this.ui.getContext('2d')!;
    const overlays = document.createElement('div');
    overlays.className = 'ed-overlays';
    // Order matters: the low-latency live canvas must be the top-most layer.
    this.el.append(main, this.ui, overlays, this.live.canvas);
    host.appendChild(this.el);

    this.renderer = new Renderer(main, this.vp, () => this.doc, assets, {
      skip: (pageId) => this.skipIds(pageId),
      overlay: (ctx, page, scale) => this.paintOverlay(ctx, page, scale),
      tapeMode: () => this.tapeMode,
    });
    this.renderer.onFrame = () => {
      this.textEditor.layout();
      this.requestUI();
      this.emitSoon();
    };
    this.selection = new SelectionManager(this);
    this.selection.onChange = () => {
      this.requestUI();
      this.emitSoon();
    };
    this.textEditor = new TextEditor(this, overlays);
    this.tools = {
      pen: new PenTool(this, 'pen'),
      highlighter: new PenTool(this, 'highlighter'),
      eraser: new EraserTool(this),
      lasso: new LassoTool(this),
      text: new TextTool(this),
      tape: new TapeTool(this),
    };
    try {
      this.penSeen = localStorage.getItem('sumi.penSeen') === '1';
    } catch {
      /* storage unavailable */
    }

    this.unsubAssets = assets.subscribe((asset, index) => {
      const doc = this.doc;
      if (!doc) return;
      for (const p of doc.pages) {
        const pdfHit = p.pdf?.asset === asset && (index === undefined || p.pdf.index === index);
        const itemHit = p.items.some((i) => (i.type === 'image' && i.asset === asset) || (i.type === 'scan' && (i.vector === asset || i.photo === asset)));
        if (pdfHit || itemHit) this.renderer.invalidate(p.id, null);
      }
    });

    const el = this.el;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e, false));
    el.addEventListener('pointercancel', (e) => this.onUp(e, true));
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'pen' && this.toolPtr === null) this.hoverTool?.hover?.(null);
    });
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
  }

  destroy() {
    this.ro.disconnect();
    this.unsubAssets();
    this.renderer.clear();
    this.el.remove();
  }

  // ---------- state ----------

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emitSoon() {
    if (this.stateRaf) return;
    this.stateRaf = requestAnimationFrame(() => {
      this.stateRaf = 0;
      this.listeners.forEach((l) => l());
    });
  }

  get currentPage(): number {
    return this.vp.currentPage();
  }

  // ---------- document ----------

  open(doc: EditorDoc) {
    this.close();
    this.doc = doc;
    doc.onContent = (pageId, region) => {
      this.renderer.invalidate(pageId, region);
      this.emitSoon();
    };
    doc.onStructure = () => {
      const keep = new Set(doc.pages.map((p) => p.id));
      if (this.selection.pageId && !keep.has(this.selection.pageId)) this.selection.clear();
      this.relayout(true);
    };
    doc.history.onChange = () => this.emitSoon();
    this.relayout(false);
    this.vp.zoom = this.vp.fitZoom();
    this.vp.scrollToPage(Math.min(doc.nb.lastPage ?? 0, doc.pages.length - 1));
    this.vp.clampCamera();
    this.renderer.request();
    this.emitSoon();
  }

  close() {
    if (!this.doc) return;
    this.cancelInput();
    this.textEditor.commit();
    this.selection.clear();
    this.region = null;
    this.doc.nb.lastPage = this.currentPage;
    this.doc.markNotebookDirty();
    this.renderer.clear();
    this.live.clear();
    this.doc = null;
  }

  relayout(keepPosition: boolean) {
    const doc = this.doc;
    if (!doc) return;
    const anchor = keepPosition ? this.vp.currentPage() : 0;
    const before = keepPosition ? this.vp.rects[anchor] : null;
    this.vp.layout(doc.pages, doc.nb.layout ?? this.settings.get().layout);
    if (before && this.vp.rects[anchor]) {
      this.vp.camX += this.vp.rects[anchor].x - before.x;
      this.vp.camY += this.vp.rects[anchor].y - before.y;
    }
    for (const id of [...doc.pages.map((p) => p.id)]) this.renderer.invalidate(id, null);
    this.vp.clampCamera();
    this.renderer.request();
    this.emitSoon();
  }

  pageAt(wx: number, wy: number, slack = 0): PageHit | null {
    const i = this.vp.pageAt(wx, wy, slack);
    if (i < 0 || !this.doc) return null;
    const page = this.doc.pages[i];
    const r = this.vp.rects[i];
    return { index: i, page, ox: r.x, oy: r.y, dark: !page.pdf && isDarkColor(page.bg.color) };
  }

  private skipIds(pageId: string): Set<string> | undefined {
    const sel = this.selection.pageId === pageId ? this.selection.ids : null;
    const editing = this.textEditor.editingId;
    if (!sel && !editing) return undefined;
    const s = new Set(sel ?? []);
    if (editing) s.add(editing);
    return s;
  }

  private paintOverlay(ctx: CanvasRenderingContext2D, page: Page, scale: number) {
    if (this.selection.pageId !== page.id || !this.selection.active) return;
    const m = this.selection.m;
    ctx.save();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    paintObjects(ctx, page, this.selection.ids, this.assets, scale);
    ctx.restore();
  }

  commitStroke(pageId: string, s: Stroke) {
    this.doc!.addStroke(pageId, s);
    // Show the stroke on the main canvas before the live layer is wiped.
    this.renderer.renderNow();
    this.live.clearSoon();
  }

  noteActivity(ms: number) {
    this.onActivity(ms);
  }

  /** Peel or restore the top-most tape at a world point. */
  toggleTapeAt(wx: number, wy: number): boolean {
    const hit = this.pageAt(wx, wy);
    if (!hit) return false;
    const x = wx - hit.ox, y = wy - hit.oy;
    const items = hit.page.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === 'tape' && itemContains(it, x, y, 4 / this.vp.zoom)) {
        const next: TapeItem = { ...it, revealed: this.tapeMode === 'hide' ? true : !it.revealed };
        if (this.tapeMode === 'hide') this.tapeMode = 'normal';
        this.doc!.replaceItem(hit.page.id, it, next, false);
        navigator.vibrate?.(8);
        return true;
      }
    }
    return false;
  }

  /** Set every tape in the notebook hidden (true) or revealed (false). */
  setAllTapes(hidden: boolean) {
    const doc = this.doc;
    if (!doc) return;
    this.tapeMode = 'normal';
    for (const p of doc.pages) {
      if (!p.items.some((i) => i.type === 'tape')) continue;
      const items = p.items.map((i) => (i.type === 'tape' ? { ...i, revealed: !hidden } : i));
      doc.setContent(p.id, { strokes: p.strokes, items }, null);
    }
  }

  // ---------- tools ----------

  setTool(t: ToolName) {
    if (t === this.tool) return;
    this.cancelInput();
    this.tools[this.tool].deactivate?.();
    this.tool = t;
    this.requestUI();
    this.emitSoon();
  }

  undo() {
    this.cancelInput();
    this.textEditor.commit();
    this.selection.clear();
    this.doc?.history.undo();
  }

  redo() {
    this.cancelInput();
    this.textEditor.commit();
    this.selection.clear();
    this.doc?.history.redo();
  }

  private cancelInput() {
    if (this.activeTool) this.activeTool.cancel();
    this.activeTool = null;
    this.toolPtr = null;
    this.touches.clear();
    this.mode = 'none';
    this.stopMomentum();
    this.renderer.gesture = false;
  }

  // ---------- rendering helpers ----------

  requestUI() {
    if (this.uiRaf) return;
    this.uiRaf = requestAnimationFrame(() => {
      this.uiRaf = 0;
      const c = this.uiCtx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, this.ui.width, this.ui.height);
      c.setTransform(this.vp.dpr, 0, 0, this.vp.dpr, 0, 0);
      const t = this.activeTool ?? this.tools[this.tool];
      this.drawLockBadges(c);
      t.drawUI?.(c);
      if (t !== this.tools.lasso) this.selection.drawUI(c);
    });
  }

  private resize() {
    const r = this.el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const first = this.vp.width <= 1;
    const centerW = this.vp.toWorld(this.vp.width / 2, 0);
    // Stay "fit to width" across rotation / split-screen changes.
    const wasFit = !first && !!this.doc && Math.abs(this.vp.zoom - this.vp.fitZoom()) < 0.01;
    this.vp.width = Math.max(1, r.width);
    this.vp.height = Math.max(1, r.height);
    this.vp.dpr = dpr;
    this.renderer.resize(r.width, r.height, dpr);
    this.live.resize(r.width, r.height, dpr);
    this.ui.width = Math.round(r.width * dpr);
    this.ui.height = Math.round(r.height * dpr);
    if (this.doc) {
      if (first) this.vp.zoom = this.vp.fitZoom();
      else {
        if (wasFit) this.vp.zoom = this.vp.fitZoom();
        this.vp.camX = centerW.x - this.vp.width / 2 / this.vp.zoom; // keep horizontal centre on rotation
        this.vp.camY = centerW.y;
      }
      this.vp.clampCamera();
      this.emitSoon();
    }
    this.renderer.request();
    this.requestUI();
  }

  setZoom(z: number, sx = this.vp.width / 2, sy = this.vp.height / 2) {
    this.vp.zoomAt(sx, sy, z);
    this.vp.clampCamera();
    this.renderer.request();
    this.emitSoon();
  }

  fitWidth() {
    const cur = this.currentPage;
    this.vp.zoom = this.vp.fitZoom();
    this.vp.scrollToPage(cur);
    this.renderer.request();
    this.emitSoon();
  }

  goToPage(i: number) {
    this.vp.scrollToPage(i);
    this.renderer.request();
    this.emitSoon();
  }

  /** World point at the centre of the visible part of a page. */
  visibleCenterOn(index: number): { x: number; y: number } {
    const r = this.vp.rects[index], v = this.vp.view;
    const x0 = Math.max(r.x, v.x), x1 = Math.min(r.x + r.w, v.x + v.w);
    const y0 = Math.max(r.y, v.y), y1 = Math.min(r.y + r.h, v.y + v.h);
    return { x: (x0 + x1) / 2 - r.x, y: (y0 + y1) / 2 - r.y };
  }

  // ---------- input ----------

  private sample(e: PointerEvent | { clientX: number; clientY: number; pressure: number; timeStamp: number; pointerType: string }, rect: DOMRect): Sample {
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const w = this.vp.toWorld(sx, sy);
    let p = e.pressure;
    if (e.pointerType !== 'pen' || !(p > 0)) p = 0.5;
    else p = Math.pow(Math.min(1, p), this.settings.get().pressureGamma);
    return { sx, sy, wx: w.x, wy: w.y, p, t: e.timeStamp, pointerType: e.pointerType };
  }

  private fingerDraws(): boolean {
    const f = this.settings.get().fingerDrawing;
    return f === 'on' || (f === 'auto' && !this.penSeen);
  }

  private notePen() {
    this.lastPen = performance.now();
    if (!this.penSeen) {
      this.penSeen = true;
      try {
        localStorage.setItem('sumi.penSeen', '1');
      } catch {
        /* ignore */
      }
    }
  }

  private toolFor(e: PointerEvent): Tool {
    if (e.pointerType === 'pen') {
      if (e.buttons & 32) return this.tools.eraser; // eraser end / eraser button
      if (e.buttons & 2 || this.sideButtonHeld) {
        const a = this.settings.get().sideButton;
        if (a === 'eraser') return this.tools.eraser;
        if (a === 'lasso') return this.tools.lasso;
      }
    }
    return this.tools[this.tool];
  }

  private onDown(e: PointerEvent) {
    if (!this.doc) return;
    // Taps inside the text box being edited belong to the text box (caret, selection).
    if ((e.target as HTMLElement | null)?.closest?.('.ed-textedit')) return;
    const rect = this.el.getBoundingClientRect();
    const now = performance.now();
    if (e.pointerType === 'pen') this.notePen();

    if (e.pointerType === 'touch') {
      const palm = (e.width || 0) > 90 && (e.height || 0) > 90;
      if (this.toolPtrType === 'pen' || now - this.lastPen < PEN_TOUCH_BLOCK_MS || palm) {
        this.ignored.add(e.pointerId);
        return;
      }
      this.stopMomentum();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      this.touches.set(e.pointerId, { x, y, x0: x, y0: y });
      if (this.touches.size === 1) {
        this.maxTouches = 1;
        this.gestureStart = now;
        this.tapMoved = false;
        // Finger on the selection drags it.
        if (this.tool === 'lasso' && this.selection.hitHandle(x, y)) {
          const w = this.vp.toWorld(x, y);
          this.selection.beginDrag(this.selection.hitHandle(x, y)!, w.x, w.y);
          this.mode = 'select';
        } else if (this.fingerDraws() && this.toolPtr === null && !this.readOnly) {
          this.mode = 'draw';
          this.startTool(e, this.tools[this.tool], rect);
        } else {
          this.mode = 'pending';
          this.panLast = { x, y, t: now };
          this.velocity = { x: 0, y: 0 };
        }
      } else {
        this.maxTouches = Math.max(this.maxTouches, this.touches.size);
        if (this.mode === 'draw') {
          // Second finger: abandon the finger stroke and zoom instead.
          const t = this.activeTool;
          if (t) (t.abort ?? t.cancel).call(t);
          this.activeTool = null;
          this.toolPtr = null;
          this.toolPtrType = '';
        }
        if (this.mode === 'select') this.selection.endDrag();
        this.beginPinch();
      }
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointers */
      }
      return;
    }

    if ((e.pointerType === 'mouse' && e.button !== 0) || this.readOnly) {
      this.stopMomentum();
      this.mousePan = { x: e.clientX, y: e.clientY, id: e.pointerId };
      this.renderer.gesture = true;
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointers */
      }
      return;
    }
    if (this.toolPtr !== null) return;
    // The pen wins over any finger gesture in progress (and stops a fling).
    this.stopMomentum();
    this.renderer.gesture = false;
    if (this.touches.size) {
      if (this.mode === 'draw' && this.activeTool) {
        const t = this.activeTool;
        (t.abort ?? t.cancel).call(t);
        this.activeTool = null;
        this.toolPtr = null;
      }
      if (this.mode === 'select') this.selection.endDrag();
      this.touches.clear();
      this.mode = 'none';
      this.renderer.gesture = false;
    }
    this.startTool(e, this.toolFor(e), rect);
  }

  private startTool(e: PointerEvent, tool: Tool, rect: DOMRect) {
    if (tool !== this.tools.text) this.textEditor.commit();
    if (tool !== this.tools.lasso && this.selection.active && tool !== this.tools[this.tool]) this.selection.clear();
    this.toolPtr = e.pointerId;
    this.toolPtrType = e.pointerType;
    this.activeTool = tool;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers */
    }
    tool.down(this.sample(e, rect));
    this.requestUI();
  }

  private onMove(e: PointerEvent) {
    if (!this.doc) return;
    const rect = this.el.getBoundingClientRect();
    if (e.pointerType === 'pen') this.notePen();

    if (this.mousePan && e.pointerId === this.mousePan.id) {
      this.vp.camX -= (e.clientX - this.mousePan.x) / this.vp.zoom;
      this.vp.camY -= (e.clientY - this.mousePan.y) / this.vp.zoom;
      this.mousePan.x = e.clientX;
      this.mousePan.y = e.clientY;
      this.vp.clampCamera();
      this.renderer.request();
      return;
    }

    if (e.pointerId === this.toolPtr && this.activeTool) {
      const events = e.getCoalescedEvents?.() ?? [];
      const samples = (events.length ? events : [e]).map((ev) => this.sample(ev, rect));
      const predicted = (e.getPredictedEvents?.() ?? []).map((ev) => this.sample(ev, rect));
      this.activeTool.move(samples, predicted);
      return;
    }

    if (e.pointerType === 'touch') {
      const t = this.touches.get(e.pointerId);
      if (!t) return;
      t.x = e.clientX - rect.left;
      t.y = e.clientY - rect.top;
      if (Math.hypot(t.x - t.x0, t.y - t.y0) > TAP_SLOP) this.tapMoved = true;
      if (this.mode === 'select') {
        const w = this.vp.toWorld(t.x, t.y);
        this.selection.dragTo(w.x, w.y);
      } else if (this.mode === 'pending' && this.tapMoved) {
        this.mode = 'pan';
        this.renderer.gesture = true;
        this.panLast = { x: t.x, y: t.y, t: performance.now() };
      } else if (this.mode === 'pan') this.panMove(t);
      else if (this.mode === 'pinch') this.pinchMove();
      return;
    }

    // The pen came into range while fingers/palm are down: that contact was the palm.
    if (e.pointerType === 'pen' && this.touches.size && this.mode !== 'select') {
      for (const id of this.touches.keys()) this.ignored.add(id);
      if (this.mode === 'draw' && this.activeTool) {
        const t = this.activeTool;
        (t.abort ?? t.cancel).call(t);
        this.activeTool = null;
        this.toolPtr = null;
        this.toolPtrType = '';
      }
      this.touches.clear();
      this.mode = 'none';
      this.stopMomentum();
      this.renderer.gesture = false;
      this.renderer.request();
    }

    // Hover (pen in range, nothing pressed) – cursor preview.
    if (e.pointerType === 'pen' && this.toolPtr === null && e.buttons === 0 && !this.readOnly) {
      const tool = this.toolFor(e);
      if (this.hoverTool && this.hoverTool !== tool) this.hoverTool.hover?.(null);
      this.hoverTool = tool;
      tool.hover?.(this.sample(e, rect));
    }
  }

  private onUp(e: PointerEvent, cancelled: boolean) {
    if (!this.doc) return;
    if (this.ignored.delete(e.pointerId)) return;
    const rect = this.el.getBoundingClientRect();
    if (this.mousePan && e.pointerId === this.mousePan.id) {
      this.mousePan = null;
      this.renderer.gesture = false;
      this.renderer.request();
      return;
    }
    if (e.pointerId === this.toolPtr && this.activeTool) {
      const tool = this.activeTool;
      this.activeTool = null;
      this.toolPtr = null;
      this.toolPtrType = '';
      if (cancelled && e.pointerType !== 'pen') tool.cancel();
      else tool.up(this.sample(e, rect));
      if (this.mode === 'draw') this.mode = 'none';
      this.touches.delete(e.pointerId);
      if (e.pointerType === 'pen') this.lastPen = performance.now();
      this.requestUI();
      return;
    }
    if (e.pointerType !== 'touch') return;
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    this.touches.delete(e.pointerId);
    if (this.mode === 'select') {
      this.selection.endDrag();
      this.mode = 'none';
      return;
    }
    if (this.touches.size === 0) {
      const quick = performance.now() - this.gestureStart < TAP_MS && !this.tapMoved && !cancelled;
      if (quick) this.onTap(this.maxTouches, t);
      if (this.mode === 'pan') this.startMomentum();
      else {
        this.renderer.gesture = false;
        this.renderer.request();
      }
      this.mode = 'none';
    } else if (this.touches.size === 1 && this.mode === 'pinch') {
      // Continue as a one-finger pan.
      const rest = [...this.touches.values()][0];
      this.mode = 'pan';
      this.panLast = { x: rest.x, y: rest.y, t: performance.now() };
      this.velocity = { x: 0, y: 0 };
    } else if (this.mode === 'pinch') this.beginPinch();
  }

  private onTap(fingers: number, t: TouchPt) {
    if (this.readOnly) return;
    if (fingers === 1) {
      const w = this.vp.toWorld(t.x, t.y);
      if (this.toggleTapeAt(w.x, w.y)) return;
      if (this.selection.active && !this.selection.hitHandle(t.x, t.y)) this.selection.clear();
    } else if (performance.now() - this.lastPen < 900) {
      // A palm landing right after writing looks like a multi-finger tap: ignore it.
      return;
    } else if (fingers === 2 && this.settings.get().twoFingerUndo) {
      this.undo();
      this.toast?.('元に戻す');
    } else if (fingers === 3 && this.settings.get().twoFingerUndo) {
      this.redo();
      this.toast?.('やり直す');
    }
  }

  toast?: (msg: string) => void;

  /** The lasso tapped a locked object (the view offers to unlock it). */
  onLockedTap: (page: Page, id: string, sx: number, sy: number) => void = () => {};

  /** A lassoed area with nothing selectable in it (e.g. a problem on a PDF), page coordinates. */
  region: { pageId: string; rect: Rect } | null = null;

  setRegion(pageId: string | null, rect?: Rect) {
    const next = pageId && rect ? { pageId, rect } : null;
    if (!next && !this.region) return;
    this.region = next;
    this.requestUI();
    this.emitSoon();
  }

  /** Lock or unlock objects on a page. */
  setLocked(pageId: string, ids: Iterable<string>, locked: boolean, record = true) {
    const doc = this.doc;
    const page = doc?.page(pageId);
    if (!doc || !page) return;
    const set = new Set(ids);
    const before = doc.content(pageId);
    const after = {
      strokes: before.strokes.map((s) => (set.has(s.id) && !!s.locked !== locked ? { ...s, locked: locked || undefined } : s)),
      items: before.items.map((i) => (set.has(i.id) && !!i.locked !== locked ? { ...i, locked: locked || undefined } : i)),
    };
    if (record) doc.commit([{ pageId, before, after }]);
    else doc.setContent(pageId, after, null);
  }

  /** Small padlocks on locked photos/text/tapes while the lasso is active. */
  private drawLockBadges(c: CanvasRenderingContext2D) {
    const doc = this.doc;
    if (!doc || this.tool !== 'lasso') return;
    for (const i of this.vp.visiblePages()) {
      const page = doc.pages[i];
      const r = this.vp.rects[i];
      for (const it of page.items) {
        if (!it.locked) continue;
        const x = this.vp.toScreenX(r.x + it.x + it.w), y = this.vp.toScreenY(r.y + it.y);
        c.save();
        c.translate(x - 16, y + 4);
        c.fillStyle = 'rgba(30,32,40,0.72)';
        c.beginPath();
        c.roundRect(-4, -2, 20, 20, 6);
        c.fill();
        c.strokeStyle = '#fff';
        c.fillStyle = '#fff';
        c.lineWidth = 1.6;
        c.beginPath();
        c.arc(6, 6, 3.6, Math.PI, 0);
        c.stroke();
        c.fillRect(1.5, 6, 9, 7);
        c.restore();
      }
    }
  }

  private panMove(t: TouchPt) {
    const now = performance.now();
    const dx = t.x - this.panLast.x, dy = t.y - this.panLast.y;
    const dt = Math.max(1, now - this.panLast.t);
    this.velocity = { x: 0.8 * (dx / dt) + 0.2 * this.velocity.x, y: 0.8 * (dy / dt) + 0.2 * this.velocity.y };
    this.panLast = { x: t.x, y: t.y, t: now };
    this.vp.camX -= dx / this.vp.zoom;
    this.vp.camY -= dy / this.vp.zoom;
    this.vp.clampCamera();
    this.renderer.request();
  }

  private beginPinch() {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return;
    this.mode = 'pinch';
    this.renderer.gesture = true;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const w = this.vp.toWorld(mx, my);
    this.pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), z0: this.vp.zoom, wx: w.x, wy: w.y };
  }

  private pinchMove() {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return;
    const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    let z = this.pinch.z0 * (d / this.pinch.d0);
    // Gentle snap to 100%.
    if (Math.abs(z - 1) < 0.04) z = 1;
    this.vp.zoom = Math.min(10, Math.max(0.2, z));
    this.vp.camX = this.pinch.wx - mx / this.vp.zoom;
    this.vp.camY = this.pinch.wy - my / this.vp.zoom;
    this.vp.clampCamera();
    this.renderer.request();
    this.emitSoon();
  }

  /** Horizontal layout at "fit" zoom behaves like turning pages. */
  private shouldSnap(): boolean {
    return this.vp.layoutMode === 'horizontal' && this.vp.zoom <= this.vp.fitZoom() * 1.08;
  }

  private snapToPage(direction: number) {
    const cur = this.vp.currentPage();
    const r0 = this.vp.rects[cur];
    if (!r0) return;
    const centre = this.vp.camX + this.vp.width / this.vp.zoom / 2;
    let target = cur;
    if (direction > 0.3 && centre > r0.x + r0.w / 2 - 1) target = Math.min(this.vp.rects.length - 1, cur + 1);
    else if (direction < -0.3 && centre < r0.x + r0.w / 2 + 1) target = Math.max(0, cur - 1);
    const r = this.vp.rects[target];
    const from = this.vp.camX;
    const to = r.x + r.w / 2 - this.vp.width / this.vp.zoom / 2;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 220);
      const e = 1 - Math.pow(1 - k, 3);
      this.vp.camX = from + (to - from) * e;
      this.renderer.request();
      if (k < 1) this.momentumRaf = requestAnimationFrame(step);
      else {
        this.momentumRaf = 0;
        this.renderer.gesture = false;
        this.renderer.request();
        this.emitSoon();
      }
    };
    this.renderer.gesture = true;
    this.momentumRaf = requestAnimationFrame(step);
  }

  private startMomentum() {
    let { x: vx, y: vy } = this.velocity;
    if (this.shouldSnap()) {
      const fresh = performance.now() - this.panLast.t < 80;
      this.snapToPage(fresh ? -vx : 0);
      return;
    }
    if (performance.now() - this.panLast.t > 80 || Math.hypot(vx, vy) < 0.15) {
      this.renderer.gesture = false;
      this.renderer.request();
      return;
    }
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(40, now - last);
      last = now;
      const decay = Math.pow(0.996, dt);
      vx *= decay;
      vy *= decay;
      const before = { x: this.vp.camX, y: this.vp.camY };
      this.vp.camX -= (vx * dt) / this.vp.zoom;
      this.vp.camY -= (vy * dt) / this.vp.zoom;
      this.vp.clampCamera();
      this.renderer.request();
      const stuck = Math.abs(before.x - this.vp.camX) + Math.abs(before.y - this.vp.camY) < 1e-3;
      if (Math.hypot(vx, vy) < 0.03 || stuck) {
        this.momentumRaf = 0;
        this.renderer.gesture = false;
        this.renderer.request();
        this.emitSoon();
        return;
      }
      this.momentumRaf = requestAnimationFrame(step);
    };
    this.momentumRaf = requestAnimationFrame(step);
  }

  private stopMomentum() {
    if (this.momentumRaf) cancelAnimationFrame(this.momentumRaf);
    this.momentumRaf = 0;
  }

  private onWheel(e: WheelEvent) {
    if (!this.doc) return;
    e.preventDefault();
    const rect = this.el.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      this.setZoom(this.vp.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
    } else {
      const k = e.deltaMode === 1 ? 16 : 1;
      this.vp.camX += ((e.shiftKey ? e.deltaY : e.deltaX) * k) / this.vp.zoom;
      this.vp.camY += (e.shiftKey ? 0 : e.deltaY * k) / this.vp.zoom;
      this.vp.clampCamera();
      this.renderer.request();
      this.emitSoon();
    }
  }
}

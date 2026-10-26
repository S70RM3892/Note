import { rectsIntersect, strokeBounds, itemBounds } from '../core/geometry';
import { isDarkColor, paintStroke } from '../core/ink';
import { drawPaper } from '../core/paper';
import type { ImageItem, Item, Page, Rect, TapeItem, TextItem } from '../core/types';
import type { AssetCache } from './assets';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const TEXT_FONT = '"Noto Sans JP", "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", sans-serif';
export const LINE_HEIGHT = 1.4;

export interface PaintOptions {
  /** Device pixels per page unit (used for hairline widths and PDF resolution). */
  scale: number;
  /** Only repaint this page-space region. */
  clip?: Rect | null;
  assets?: AssetCache;
  /** Object ids to leave out (selection being dragged, text being edited). */
  skip?: Set<string>;
  /** Tape display: 'normal' honours each tape, 'hide' forces hidden, 'omit' leaves tapes out. */
  tapes?: 'normal' | 'hide' | 'omit';
}

const MAX_DIM = 4096;
const MAX_AREA = 12e6;

/** Highest bitmap scale (device px per page unit) a page may use. */
export function maxScaleFor(w: number, h: number): number {
  return Math.min(MAX_DIM / w, MAX_DIM / h, Math.sqrt(MAX_AREA / (w * h)));
}

let measureCtx: CanvasRenderingContext2D | null = null;

function mctx(): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')!;
  return measureCtx;
}

/** Wrap text to a maximum width (character-level, works for Japanese). */
export function layoutText(text: string, size: number, maxW: number): { lines: string[]; w: number; h: number } {
  const ctx = mctx();
  ctx.font = `${size}px ${TEXT_FONT}`;
  const lines: string[] = [];
  let w = 0;
  for (const para of text.split('\n')) {
    let line = '';
    for (const ch of Array.from(para)) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxW) {
        lines.push(line);
        w = Math.max(w, ctx.measureText(line).width);
        line = ch;
      } else line = next;
    }
    lines.push(line);
    w = Math.max(w, ctx.measureText(line).width);
  }
  return { lines, w: Math.ceil(w) + 2, h: Math.ceil(lines.length * size * LINE_HEIGHT) };
}

function withItemTransform(ctx: Ctx, it: Item, fn: () => void) {
  ctx.save();
  ctx.translate(it.x + it.w / 2, it.y + it.h / 2);
  if (it.rot) ctx.rotate(it.rot);
  ctx.translate(-it.w / 2, -it.h / 2);
  fn();
  ctx.restore();
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

export function paintTape(ctx: Ctx, t: TapeItem, mode: 'normal' | 'hide', scale: number) {
  const hidden = mode === 'hide' || !t.revealed;
  withItemTransform(ctx, t, () => {
    roundRect(ctx, 0, 0, t.w, t.h, 3);
    if (hidden) {
      ctx.fillStyle = t.color;
      ctx.fill();
      // Subtle stripes so it reads as tape.
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let x = -t.h; x < t.w + t.h; x += 10) {
        ctx.moveTo(x, t.h);
        ctx.lineTo(x + t.h, 0);
      }
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = t.color;
      ctx.fill();
      ctx.restore();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = Math.max(1, 1.2 / scale);
      ctx.strokeStyle = t.color;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });
}

export function paintText(ctx: Ctx, t: TextItem) {
  withItemTransform(ctx, t, () => {
    const { lines } = layoutText(t.text, t.size, Math.max(t.w, t.size));
    ctx.font = `${t.size}px ${TEXT_FONT}`;
    ctx.fillStyle = t.color;
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, 0, i * t.size * LINE_HEIGHT + t.size * (LINE_HEIGHT - 1) * 0.5));
  });
}

function paintImage(ctx: Ctx, it: ImageItem, assets?: AssetCache): boolean {
  const img = assets?.image(it.asset);
  withItemTransform(ctx, it, () => {
    if (img) ctx.drawImage(img, 0, 0, it.w, it.h);
    else {
      ctx.fillStyle = 'rgba(128,128,128,0.15)';
      ctx.fillRect(0, 0, it.w, it.h);
    }
  });
  return !!img;
}

/**
 * Paint a page in page coordinates. The caller sets the transform (page → device).
 * Returns false when some asset was not ready (caller should repaint later).
 */
export function paintPage(ctx: Ctx, page: Page, o: PaintOptions): boolean {
  let complete = true;
  const clip = o.clip ?? null;
  const visible = (r: Rect) => !clip || rectsIntersect(r, clip);
  const skip = o.skip;
  ctx.save();
  ctx.beginPath();
  if (clip) ctx.rect(clip.x, clip.y, clip.w, clip.h);
  else ctx.rect(0, 0, page.w, page.h);
  ctx.clip();

  if (page.pdf) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, page.w, page.h);
    const want = Math.min(o.scale, maxScaleFor(page.w, page.h));
    const bm = o.assets?.pdfPage(page.pdf.asset, page.pdf.index, want);
    if (bm) ctx.drawImage(bm.canvas, 0, 0, page.w, page.h);
    if (!bm || bm.scale < want * 0.92) complete = false;
  } else {
    drawPaper(ctx, page.w, page.h, page.bg, o.scale);
  }
  const dark = !page.pdf && isDarkColor(page.bg.color);

  for (const it of page.items) {
    if (it.type === 'image' && !skip?.has(it.id) && visible(itemBounds(it))) complete = paintImage(ctx, it, o.assets) && complete;
  }
  for (const s of page.strokes) {
    if (s.kind === 'highlighter' && !skip?.has(s.id) && visible(strokeBounds(s))) paintStroke(ctx, s, dark);
  }
  for (const s of page.strokes) {
    if (s.kind === 'pen' && !skip?.has(s.id) && visible(strokeBounds(s))) paintStroke(ctx, s, dark);
  }
  for (const it of page.items) {
    if (it.type === 'text' && !skip?.has(it.id) && visible(itemBounds(it))) paintText(ctx, it);
  }
  if (o.tapes !== 'omit') {
    for (const it of page.items) {
      if (it.type === 'tape' && !skip?.has(it.id) && visible(itemBounds(it))) paintTape(ctx, it, o.tapes === 'hide' ? 'hide' : 'normal', o.scale);
    }
  }
  ctx.restore();
  return complete;
}

/** Paint arbitrary objects (used for a selection being dragged). */
export function paintObjects(ctx: Ctx, page: Page, ids: Set<string>, assets: AssetCache | undefined, scale: number) {
  const dark = !page.pdf && isDarkColor(page.bg.color);
  for (const it of page.items) if (it.type === 'image' && ids.has(it.id)) paintImage(ctx, it, assets);
  for (const s of page.strokes) if (s.kind === 'highlighter' && ids.has(s.id)) paintStroke(ctx, s, dark);
  for (const s of page.strokes) if (s.kind === 'pen' && ids.has(s.id)) paintStroke(ctx, s, dark);
  for (const it of page.items) {
    if (!ids.has(it.id)) continue;
    if (it.type === 'text') paintText(ctx, it);
    else if (it.type === 'tape') paintTape(ctx, it, 'normal', scale);
  }
}

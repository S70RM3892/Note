import { MM } from './geometry';
import { isDarkColor } from './ink';
import type { PageBackground, TemplateId } from './types';

export interface PaperSize {
  id: string;
  label: string;
  w: number;
  h: number;
}

export const PAPER_SIZES: PaperSize[] = [
  { id: 'a4', label: 'A4 縦', w: 794, h: 1123 },
  { id: 'b5', label: 'B5 縦', w: 688, h: 971 },
  { id: 'a4l', label: 'A4 横', w: 1123, h: 794 },
  { id: 'wide', label: '画面比 16:10', w: 1123, h: 702 },
];

export const TEMPLATES: { id: TemplateId; label: string; spacing: number }[] = [
  { id: 'blank', label: '無地', spacing: 7 },
  { id: 'ruled', label: '横罫', spacing: 7 },
  { id: 'grid', label: '方眼', spacing: 5 },
  { id: 'dots', label: 'ドット', spacing: 5 },
  { id: 'cornell', label: 'コーネル', spacing: 7 },
  { id: 'split', label: '左右分割', spacing: 5 },
  { id: 'section', label: '方眼 1cm強調', spacing: 5 },
  { id: 'english', label: '英語4線', spacing: 4 },
  { id: 'genkou', label: '原稿用紙 400字', spacing: 8 },
];

/**
 * 原稿用紙: 20 columns of 20 squares (written top-to-bottom, right-to-left). Columns are separated
 * by a narrow strip (for ruby and corrections) and the two halves by the 柱 (centre gutter).
 * Returns the left edge of each column, the square size and the top edge.
 */
export function genkouGrid(w: number, h: number): { cols: number[]; cell: number; y0: number } {
  const margin = 12 * MM;
  const GAP = 0.3, GUTTER = 1.6; // in squares
  const cell = Math.min((w - 2 * margin) / (20 + 18 * GAP + GUTTER), (h - 2 * margin) / 20);
  const total = cell * (20 + 18 * GAP + GUTTER);
  const cols: number[] = [];
  let x = (w - total) / 2;
  for (let c = 0; c < 20; c++) {
    cols.push(x);
    x += cell + (c === 9 ? GUTTER : GAP) * cell;
  }
  return { cols, cell, y0: (h - 20 * cell) / 2 };
}

export const PAPER_COLORS: { color: string; label: string }[] = [
  { color: '#ffffff', label: '白' },
  { color: '#fbf6e9', label: 'クリーム' },
  { color: '#1f2023', label: 'ダーク' },
  { color: '#20362b', label: '黒板' },
];

export interface TemplateGeometry {
  lines: number[]; // flat x1,y1,x2,y2
  strong: number[]; // emphasized lines
  dots: number[]; // flat x,y
  color: string;
  strongColor: string;
  width: number;
}

export function templateGeometry(w: number, h: number, bg: PageBackground): TemplateGeometry {
  const dark = isDarkColor(bg.color);
  const g: TemplateGeometry = {
    lines: [],
    strong: [],
    dots: [],
    color: dark ? 'rgba(255,255,255,0.13)' : 'rgba(96,125,165,0.28)',
    strongColor: dark ? 'rgba(255,255,255,0.28)' : 'rgba(96,125,165,0.55)',
    width: 0.9,
  };
  const sp = Math.max(2, bg.spacing) * MM;
  const ruled = (x0: number, x1: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1 + 0.01; y += sp) g.lines.push(x0, y, x1, y);
  };
  const grid = (x0: number, x1: number, y0: number, y1: number) => {
    const ox = x0 + ((x1 - x0) % sp) / 2;
    const oy = y0 + ((y1 - y0) % sp) / 2;
    for (let y = oy; y <= y1 + 0.01; y += sp) g.lines.push(x0, y, x1, y);
    for (let x = ox; x <= x1 + 0.01; x += sp) g.lines.push(x, y0, x, y1);
  };
  switch (bg.tpl) {
    case 'blank':
      break;
    case 'ruled':
      ruled(0, w, 18 * MM, h - 8 * MM);
      break;
    case 'grid':
      grid(0, w, 0, h);
      break;
    case 'dots': {
      const ox = (w % sp) / 2, oy = (h % sp) / 2;
      for (let y = oy || sp; y < h; y += sp) for (let x = ox || sp; x < w; x += sp) g.dots.push(x, y);
      break;
    }
    case 'cornell': {
      const top = 22 * MM, bottom = h - 48 * MM, cue = Math.min(62 * MM, w * 0.3);
      ruled(cue, w, top + sp, bottom - 2);
      g.strong.push(0, top, w, top, cue, top, cue, bottom, 0, bottom, w, bottom);
      break;
    }
    case 'split': {
      grid(0, w, 0, h);
      g.strong.push(w / 2, 0, w / 2, h);
      break;
    }
    case 'section': {
      // Minor lines every `spacing`, strong ones every centimetre (or every 5 lines if that doesn't divide).
      const every = Math.max(2, Number.isInteger(10 / bg.spacing) ? 10 / bg.spacing : 5);
      const n = (len: number) => Math.floor(len / sp);
      const ox = (w - n(w) * sp) / 2, oy = (h - n(h) * sp) / 2;
      for (let i = 0; i <= n(h); i++) (i % every ? g.lines : g.strong).push(0, oy + i * sp, w, oy + i * sp);
      for (let i = 0; i <= n(w); i++) (i % every ? g.lines : g.strong).push(ox + i * sp, 0, ox + i * sp, h);
      break;
    }
    case 'english': {
      // Four lines per row (the third is the baseline), rows separated by two intervals.
      const top = 16 * MM, bottom = h - 10 * MM, x0 = 12 * MM, x1 = w - 12 * MM;
      for (let y = top; y + 3 * sp <= bottom; y += 5 * sp) {
        g.lines.push(x0, y, x1, y, x0, y + sp, x1, y + sp, x0, y + 3 * sp, x1, y + 3 * sp);
        g.strong.push(x0, y + 2 * sp, x1, y + 2 * sp);
      }
      break;
    }
    case 'genkou': {
      const { cols, cell, y0 } = genkouGrid(w, h);
      const y1 = y0 + 20 * cell;
      for (const x of cols) {
        g.lines.push(x, y0, x, y1, x + cell, y0, x + cell, y1);
        for (let r = 1; r < 20; r++) g.lines.push(x, y0 + r * cell, x + cell, y0 + r * cell);
      }
      const left = cols[0], right = cols[19] + cell;
      g.strong.push(left, y0, right, y0, left, y1, right, y1, left, y0, left, y1, right, y0, right, y1);
      // 柱: a short mark in the middle of the centre gutter.
      const mx = (cols[9] + cell + cols[10]) / 2;
      g.strong.push(mx - cell * 0.25, y0 + 10 * cell, mx + cell * 0.25, y0 + 10 * cell);
      break;
    }
  }
  return g;
}

/** Draw paper and template in page coordinates. */
export function drawPaper(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number, bg: PageBackground, scale: number, withColor = true) {
  if (withColor) {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, w, h);
  }
  const g = templateGeometry(w, h, bg);
  const lw = Math.max(g.width, 1 / scale);
  if (g.lines.length) {
    ctx.beginPath();
    for (let i = 0; i < g.lines.length; i += 4) {
      ctx.moveTo(g.lines[i], g.lines[i + 1]);
      ctx.lineTo(g.lines[i + 2], g.lines[i + 3]);
    }
    ctx.strokeStyle = g.color;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
  if (g.strong.length) {
    ctx.beginPath();
    for (let i = 0; i < g.strong.length; i += 4) {
      ctx.moveTo(g.strong[i], g.strong[i + 1]);
      ctx.lineTo(g.strong[i + 2], g.strong[i + 3]);
    }
    ctx.strokeStyle = g.strongColor;
    ctx.lineWidth = lw * 1.4;
    ctx.stroke();
  }
  if (g.dots.length) {
    ctx.fillStyle = g.strongColor;
    const r = Math.max(0.9, 1 / scale);
    ctx.beginPath();
    for (let i = 0; i < g.dots.length; i += 2) {
      ctx.moveTo(g.dots[i] + r, g.dots[i + 1]);
      ctx.arc(g.dots[i], g.dots[i + 1], r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}

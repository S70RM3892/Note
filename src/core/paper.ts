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
];

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

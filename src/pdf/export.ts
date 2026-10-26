import { strokeSvgPath, isDarkColor } from '../core/ink';
import { templateGeometry } from '../core/paper';
import type { Item, Page, ScanItem, Stroke } from '../core/types';
import type { AssetCache } from '../editor/assets';
import { maxScaleFor, paintPage, paintText } from '../editor/paint';
import type { Repo } from '../store/repo';

const PT = 0.75; // PDF points per page unit

export type TapeExport = 'omit' | 'hide' | 'normal';

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function parseRgba(css: string): { c: [number, number, number]; a: number } {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return { c: hexToRgb(css), a: 1 };
  const [r, g, b, a] = m[1].split(',').map((v) => parseFloat(v));
  return { c: [r / 255, g / 255, b / 255], a: a ?? 1 };
}

/** Constant-width shapes are exported as filled outlines so joins stay round. */
function exportPath(s: Stroke): string {
  if (!s.shape) return strokeSvgPath(s);
  let pts = s.pts;
  if (s.closed && pts.length >= 6) {
    const c = new Float32Array(pts.length + 3);
    c.set(pts);
    c.set(pts.subarray(0, 3), pts.length);
    pts = c;
  }
  return strokeSvgPath({ ...s, shape: false, closed: false, style: 'marker', pts });
}

/** Bottom-left corner (PDF space) of a rotated item, for pdf-lib's rotate-about-origin drawing. */
function itemPlacement(it: Item, H: number) {
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
  const c = Math.cos(it.rot), s = Math.sin(it.rot);
  const dx = -it.w / 2, dy = it.h / 2;
  const x = cx + dx * c - dy * s, y = cy + dx * s + dy * c;
  return { x: x * PT, y: H - y * PT, w: it.w * PT, h: it.h * PT, deg: (-it.rot * 180) / Math.PI };
}

/** Top-left corner of a rotated item in PDF space (origin for drawSvgPath, which rotates about it). */
function itemOrigin(it: Item, H: number) {
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
  const c = Math.cos(it.rot), s = Math.sin(it.rot);
  const x = cx - (it.w / 2) * c + (it.h / 2) * s, y = cy - (it.w / 2) * s - (it.h / 2) * c;
  return { x: x * PT, y: H - y * PT, deg: (-it.rot * 180) / Math.PI };
}

async function scanDoc(repo: Repo, it: ScanItem) {
  const a = await repo.getAsset(it.vector);
  if (!a) return null;
  return JSON.parse(await a.blob.text()) as import('../core/types').VectorDoc;
}

export async function exportPdf(repo: Repo, pages: Page[], opts: { tapes: TapeExport; title?: string }): Promise<Blob> {
  const { PDFDocument, rgb, degrees, BlendMode, StandardFonts } = await import('pdf-lib');
  const out = await PDFDocument.create();
  let labelFont: Awaited<ReturnType<typeof out.embedFont>> | undefined;
  if (opts.title) out.setTitle(opts.title);
  out.setCreator('Sumi Note');
  const srcDocs = new Map<string, Awaited<ReturnType<typeof PDFDocument.load>>>();
  const images = new Map<string, Awaited<ReturnType<typeof out.embedPng>>>();

  for (const page of pages) {
    const W = page.w * PT, H = page.h * PT;
    const p = out.addPage([W, H]);
    if (page.pdf) {
      let src = srcDocs.get(page.pdf.asset);
      if (!src) {
        const a = await repo.getAsset(page.pdf.asset);
        if (a) {
          src = await PDFDocument.load(await a.blob.arrayBuffer(), { ignoreEncryption: true });
          srcDocs.set(page.pdf.asset, src);
        }
      }
      if (src && page.pdf.index < src.getPageCount()) {
        const sp = src.getPage(page.pdf.index);
        const cb = sp.getCropBox();
        const rot = ((sp.getRotation().angle % 360) + 360) % 360;
        const emb = await out.embedPage(sp, { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height });
        const swap = rot === 90 || rot === 270;
        const dispW = swap ? cb.height : cb.width, dispH = swap ? cb.width : cb.height;
        const kx = W / dispW, ky = H / dispH;
        const w = cb.width * (swap ? ky : kx), h = cb.height * (swap ? kx : ky);
        if (rot === 0) p.drawPage(emb, { x: 0, y: 0, width: w, height: h });
        else if (rot === 90) p.drawPage(emb, { x: 0, y: H, width: w, height: h, rotate: degrees(-90) });
        else if (rot === 180) p.drawPage(emb, { x: W, y: H, width: w, height: h, rotate: degrees(180) });
        else p.drawPage(emb, { x: W, y: 0, width: w, height: h, rotate: degrees(90) });
      }
    } else {
      const [r, g, b] = hexToRgb(page.bg.color);
      p.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(r, g, b) });
      const tg = templateGeometry(page.w, page.h, page.bg);
      const line = parseRgba(tg.color), strong = parseRgba(tg.strongColor);
      const drawLines = (arr: number[], col: typeof line, th: number) => {
        for (let i = 0; i < arr.length; i += 4) {
          p.drawLine({
            start: { x: arr[i] * PT, y: H - arr[i + 1] * PT },
            end: { x: arr[i + 2] * PT, y: H - arr[i + 3] * PT },
            thickness: th,
            color: rgb(...col.c),
            opacity: col.a,
          });
        }
      };
      drawLines(tg.lines, line, tg.width * PT);
      drawLines(tg.strong, strong, tg.width * PT * 1.4);
      for (let i = 0; i < tg.dots.length; i += 2) {
        p.drawCircle({ x: tg.dots[i] * PT, y: H - tg.dots[i + 1] * PT, size: 0.7, color: rgb(...strong.c), opacity: strong.a });
      }
      for (let i = 0; i < tg.rings.length; i += 4) {
        p.drawEllipse({ x: tg.rings[i] * PT, y: H - tg.rings[i + 1] * PT, xScale: tg.rings[i + 2] * PT, yScale: tg.rings[i + 3] * PT, borderColor: rgb(...strong.c), borderOpacity: strong.a, borderWidth: tg.width * PT });
      }
      if (tg.labels.length) {
        // Mark-sheet numbers. The standard PDF font has no Japanese, so the 解答番号 heading is left out.
        const font = (labelFont ??= await out.embedFont(StandardFonts.Helvetica));
        for (const t of tg.labels) {
          if (!/^[0-9]+$/.test(t.text)) continue;
          const size = t.size * PT;
          const tw = font.widthOfTextAtSize(t.text, size);
          const col = t.faint ? line : strong;
          p.drawText(t.text, { x: t.x * PT - tw / 2, y: H - t.y * PT - size * 0.35, size, font, color: rgb(...col.c), opacity: col.a });
        }
      }
    }
    const dark = !page.pdf && isDarkColor(page.bg.color);

    for (const it of page.items) {
      if (it.type === 'scan' && !it.showPhoto) {
        const vd = await scanDoc(repo, it);
        if (!vd) continue;
        const o = itemOrigin(it, H);
        const k = (PT * it.w) / vd.w;
        for (const layer of vd.layers) {
          const col = rgb(...hexToRgb(layer.color));
          for (const t of layer.tiles) p.drawSvgPath(t.d, { x: o.x, y: o.y, scale: k, rotate: degrees(o.deg), color: col });
        }
        continue;
      }
      const assetId = it.type === 'image' ? it.asset : it.type === 'scan' ? it.photo : undefined;
      if (!assetId) continue;
      let img = images.get(assetId);
      if (!img) {
        const a = await repo.getAsset(assetId);
        if (!a) continue;
        const bytes = new Uint8Array(await a.blob.arrayBuffer());
        try {
          img = a.mime.includes('png') ? await out.embedPng(bytes) : a.mime.includes('jp') ? await out.embedJpg(bytes) : await out.embedPng(await toPng(a.blob));
        } catch {
          img = await out.embedPng(await toPng(a.blob));
        }
        images.set(assetId, img);
      }
      const pl = itemPlacement(it, H);
      p.drawImage(img, { x: pl.x, y: pl.y, width: pl.w, height: pl.h, rotate: degrees(pl.deg) });
    }
    const drawStroke = (s: Stroke) => {
      const path = exportPath(s);
      if (!path) return;
      const c = rgb(...hexToRgb(s.color));
      if (s.kind === 'highlighter') {
        p.drawSvgPath(path, dark ? { x: 0, y: H, scale: PT, color: c, opacity: 0.45 } : { x: 0, y: H, scale: PT, color: c, blendMode: BlendMode.Multiply });
      } else p.drawSvgPath(path, { x: 0, y: H, scale: PT, color: c, opacity: s.style === 'pencil' ? 0.82 : 1 });
    };
    page.strokes.filter((s) => s.kind === 'highlighter').forEach(drawStroke);
    page.strokes.filter((s) => s.kind === 'pen').forEach(drawStroke);

    for (const it of page.items) {
      if (it.type !== 'text') continue;
      const k = 3;
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.ceil(it.w * k));
      cv.height = Math.max(1, Math.ceil(it.h * k));
      const ctx = cv.getContext('2d')!;
      ctx.scale(k, k);
      paintText(ctx, { ...it, x: 0, y: 0, rot: 0 });
      const png = await out.embedPng(await canvasPng(cv));
      const pl = itemPlacement(it, H);
      p.drawImage(png, { x: pl.x, y: pl.y, width: pl.w, height: pl.h, rotate: degrees(pl.deg) });
    }
    if (opts.tapes !== 'omit') {
      for (const it of page.items) {
        if (it.type !== 'tape') continue;
        const hidden = opts.tapes === 'hide' || !it.revealed;
        const pl = itemPlacement(it, H);
        p.drawRectangle({ x: pl.x, y: pl.y, width: pl.w, height: pl.h, rotate: degrees(pl.deg), color: rgb(...hexToRgb(it.color)), opacity: hidden ? 1 : 0.15 });
      }
    }
  }
  const bytes = await out.save();
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

async function canvasPng(cv: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((res) => cv.toBlob((b) => res(b!), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

async function toPng(blob: Blob): Promise<Uint8Array> {
  const bmp = await createImageBitmap(blob);
  const cv = document.createElement('canvas');
  cv.width = bmp.width;
  cv.height = bmp.height;
  cv.getContext('2d')!.drawImage(bmp, 0, 0);
  return canvasPng(cv);
}

/** Wait until the page's PDF background and images are decoded at the given scale. */
export async function waitForAssets(page: Page, assets: AssetCache, scale: number, timeoutMs = 15000) {
  const deadline = performance.now() + timeoutMs;
  const ready = () => {
    let ok = true;
    if (page.pdf) {
      const want = Math.min(scale, maxScaleFor(page.w, page.h));
      const bm = assets.pdfPage(page.pdf.asset, page.pdf.index, want);
      if (!bm || bm.scale < want * 0.92) ok = false;
    }
    for (const it of page.items) {
      if (it.type === 'image' && !assets.image(it.asset)) ok = false;
      if (it.type === 'scan' && !(it.showPhoto && it.photo ? assets.image(it.photo) : assets.vector(it.vector))) ok = false;
    }
    return ok;
  };
  while (!ready() && performance.now() < deadline) {
    await new Promise<void>((res) => {
      const t = setTimeout(done, 400);
      const un = assets.subscribe(done);
      function done() {
        clearTimeout(t);
        un();
        res();
      }
    });
  }
}

/** Render one page to a PNG blob. */
export async function exportPng(page: Page, assets: AssetCache, scale = 2, tapes: TapeExport = 'normal'): Promise<Blob> {
  const s = Math.min(scale, maxScaleFor(page.w, page.h));
  await waitForAssets(page, assets, s);
  const cv = document.createElement('canvas');
  cv.width = Math.round(page.w * s);
  cv.height = Math.round(page.h * s);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  paintPage(ctx, page, { scale: s, assets, tapes });
  return new Promise((res) => cv.toBlob((b) => res(b!), 'image/png'));
}

/** Small thumbnail data URL (library cover / page overview). */
export function thumbnail(page: Page, assets: AssetCache | undefined, width: number): HTMLCanvasElement {
  const s = width / page.w;
  const cv = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(width * dpr);
  cv.height = Math.round(page.h * s * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
  paintPage(ctx, page, { scale: s * dpr, assets, tapes: 'normal' });
  return cv;
}

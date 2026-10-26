import { uid } from '../core/id';
import type { ImageItem, Notebook, Page } from '../core/types';
import { COVER_COLORS, type Repo } from '../store/repo';

/** Downscale very large photos so notes stay light (camera shots are often 12MP+). */
export async function normalizeImage(file: Blob, maxDim = 2400): Promise<{ blob: Blob; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  if (k === 1 && file.size < 3e6 && /image\/(png|jpeg|webp)/.test(file.type)) {
    const out = { blob: file, w: bmp.width, h: bmp.height };
    bmp.close();
    return out;
  }
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  cv.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await new Promise<Blob>((res) => cv.toBlob((b) => res(b!), 'image/jpeg', 0.9));
  return { blob, w, h };
}

/** Build an image item that fits inside a box. */
export async function imageItem(repo: Repo, file: Blob, box: { x: number; y: number; w: number; h: number }): Promise<ImageItem> {
  const img = await normalizeImage(file);
  const asset = await repo.putAsset(img.blob, 'image');
  const k = Math.min(box.w / img.w, box.h / img.h, 1);
  const w = img.w * k, h = img.h * k;
  return { id: uid(), type: 'image', x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h, rot: 0, asset: asset.id };
}

/** One page per image, image fitted with a margin. */
export async function importImagesAsNotebook(repo: Repo, files: File[], title: string): Promise<Notebook> {
  const now = Date.now();
  const nb: Notebook = {
    id: uid(),
    title,
    folder: null,
    created: now,
    updated: now,
    opened: now,
    pages: [],
    cover: COVER_COLORS[0],
    paper: { w: 794, h: 1123, bg: { tpl: 'blank', spacing: 5, color: '#ffffff' } },
  };
  const pages: Page[] = [];
  for (const f of files) {
    const item = await imageItem(repo, f, { x: 24, y: 24, w: 794 - 48, h: 1123 - 48 });
    pages.push({ id: uid(), nb: nb.id, w: 794, h: 1123, bg: { ...nb.paper.bg }, strokes: [], items: [item], updated: now });
  }
  nb.pages = pages.map((p) => p.id);
  await repo.db.write({ put: [['notebooks', nb], ...pages.map((p) => ['pages', p] as ['pages', Page])] });
  return nb;
}

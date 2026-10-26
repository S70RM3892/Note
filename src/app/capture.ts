import { itemBounds, rectsIntersect, strokeBounds, transformItem, transformStroke, type Mat } from '../core/geometry';
import { uid } from '../core/id';
import { newReview } from '../core/srs';
import type { ImageItem, Item, Notebook, Page, Rect, Stroke, TextItem } from '../core/types';
import type { AssetCache } from '../editor/assets';
import { paintObjects } from '../editor/paint';
import { setClipboard } from '../editor/selection';
import type { App } from './app';

const SCALE = 3; // ≈ 290 dpi
const MAX_DIM = 4096;

/** Objects on `page` under `rect`, minus `skip`. */
function objectsIn(page: Page, rect: Rect, skip: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const s of page.strokes) if (!skip.has(s.id) && rectsIntersect(strokeBounds(s), rect)) ids.add(s.id);
  for (const it of page.items) if (!skip.has(it.id) && rectsIntersect(itemBounds(it), rect)) ids.add(it.id);
  return ids;
}

/** Wait (briefly) until the images and scan artwork the capture paints are decoded. */
async function assetsReady(assets: AssetCache, items: Item[]) {
  const pending = () =>
    items.some((it) => {
      if (it.type === 'image') return !assets.image(it.asset);
      if (it.type === 'scan') return it.showPhoto && it.photo ? !assets.image(it.photo) : !assets.vector(it.vector);
      return false;
    });
  const until = performance.now() + 5000;
  while (pending() && performance.now() < until) await new Promise((r) => setTimeout(r, 50));
}

/**
 * Raster of what lies under `rect` on `page` — the PDF and every object except `skip` — without
 * the paper template. Null when there is nothing under it.
 */
export async function captureRegion(assets: AssetCache, page: Page, rect: Rect, skip: Set<string> = new Set()): Promise<Blob | null> {
  const ids = objectsIn(page, rect, skip);
  if (!page.pdf && !ids.size) return null;
  const k = Math.min(SCALE, MAX_DIM / Math.max(rect.w, rect.h));
  const W = Math.max(1, Math.round(rect.w * k)), H = Math.max(1, Math.round(rect.h * k));
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = page.pdf ? '#ffffff' : page.bg.color;
  ctx.fillRect(0, 0, W, H);
  if (page.pdf) {
    const doc = await assets.pdfDoc(page.pdf.asset);
    const p = await doc.getPage(page.pdf.index + 1);
    const tmp = document.createElement('canvas');
    tmp.width = W;
    tmp.height = H;
    await p.render({ canvas: tmp, viewport: p.getViewport({ scale: (k * 96) / 72 }), background: '#ffffff', transform: [1, 0, 0, 1, -rect.x * k, -rect.y * k] }).promise;
    ctx.drawImage(tmp, 0, 0);
    tmp.width = 0;
  }
  await assetsReady(assets, page.items.filter((it) => ids.has(it.id)));
  ctx.setTransform(k, 0, 0, k, -rect.x * k, -rect.y * k);
  paintObjects(ctx, page, ids, assets, k);
  return new Promise((res) => cv.toBlob((b) => (cv.width = 0, res(b)), 'image/png'));
}

/** Clamp a rect to the page, with some padding. */
export function padRect(r: Rect, page: Page, pad = 10): Rect {
  const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
  return { x, y, w: Math.min(page.w, r.x + r.w + pad) - x, h: Math.min(page.h, r.y + r.h + pad) - y };
}

/** "画像でコピー": the region as one image on the app clipboard, ready to paste into any notebook. */
export async function copyRegionAsImage(app: App, page: Page, rect: Rect): Promise<boolean> {
  const blob = await captureRegion(app.assets, page, rect);
  if (!blob) return false;
  const asset = await app.repo.putAsset(blob, 'image', 'clip.png');
  const item: ImageItem = { id: uid(), type: 'image', asset: asset.id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, rot: 0 };
  setClipboard({ strokes: [], items: [item], bounds: { ...rect } });
  return true;
}

export const MISTAKES_TITLE = 'まちがいノート';

async function mistakesNotebook(app: App): Promise<Notebook> {
  const repo = app.repo;
  const id = await repo.kvGet<string>('mistakesNb');
  const known = id ? await repo.getNotebook(id) : undefined;
  if (known && !known.trashed) return known;
  const { nb } = await repo.createNotebook({ title: MISTAKES_TITLE, size: 'a4', bg: { tpl: 'grid', spacing: 5, color: '#ffffff' }, pages: 0, cover: '#e8590c' });
  await repo.kvSet('mistakesNb', nb.id);
  return nb;
}

/**
 * 間違いノート: copy what is inside `rect` on `page` onto a new page of the まちがいノート and put
 * that page on the review schedule. `strokes`/`items` (the lasso selection) stay vector; the rest
 * under the region (the problem PDF, photos, locked scans) comes along as one locked image.
 * Room is left below for solving it again.
 */
export async function sendToMistakes(app: App, src: { nb: Notebook; page: Page; pageIndex: number }, rect: Rect, strokes: Stroke[], items: Item[]): Promise<Notebook> {
  const skip = new Set([...strokes.map((s) => s.id), ...items.map((i) => i.id)]);
  const bg = await captureRegion(app.assets, src.page, rect, skip);
  const nb = await mistakesNotebook(app);
  if (nb.id === src.nb.id) throw new Error('まちがいノートの中からは送れない');
  const page = app.repo.newPage(nb);
  const M = 40, TOP = 64;
  const k = Math.min(1.25, (page.w - 2 * M) / rect.w, (page.h * 0.55) / rect.h);
  const m: Mat = [k, 0, 0, k, M - rect.x * k, TOP - rect.y * k];
  const d = new Date();
  const header: TextItem = {
    id: uid(),
    type: 'text',
    x: M,
    y: 22,
    w: page.w - 2 * M,
    h: 24,
    rot: 0,
    text: `${src.nb.title}  p.${src.pageIndex + 1}  ·  ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`,
    size: 14,
    color: '#868e96',
  };
  const below = TOP + rect.h * k + 18;
  const redo: TextItem = { id: uid(), type: 'text', x: M, y: below, w: 200, h: 26, rot: 0, text: '▼ 解き直し', size: 16, color: '#e8590c' };
  const out: Item[] = [header];
  if (bg) {
    const asset = await app.repo.putAsset(bg, 'image', 'problem.png');
    out.push({ id: uid(), type: 'image', asset: asset.id, x: M, y: TOP, w: rect.w * k, h: rect.h * k, rot: 0, locked: true });
  }
  out.push(...items.map((i) => transformItem(i, m, uid())), redo);
  page.items = out;
  page.strokes = strokes.map((s) => transformStroke(s, m, uid()));
  nb.pages.push(page.id);
  nb.updated = Date.now();
  await app.repo.savePages([page], nb);
  await app.repo.saveReview({ id: page.id, nb: nb.id, state: newReview(Date.now()) });
  return nb;
}

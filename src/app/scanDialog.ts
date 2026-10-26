import type { VectorDoc } from '../core/types';
import { nativeScan, native } from '../platform';
import { ScanWorker } from '../scan/client';
import { detectDocument, insetQuad } from '../scan/detect';
import type { P2 } from '../scan/homography';
import { vectorBytes, type ScanMode } from '../scan/pipeline';
import { h } from '../ui/dom';
import { modal, pickFiles, toast } from '../ui/dialogs';
import { icon } from '../ui/icons';
import { chipGroup } from './newNotebook';

export interface ScanResult {
  mode: ScanMode;
  /** Traced artwork (null in photo mode). */
  doc: VectorDoc | null;
  /** Shadow-free, perspective-corrected page. */
  clean: ImageData;
}

export type ScanAction = 'place' | 'notebook' | 'pdf';

const MAX_SOURCE = 4200; // px, long side kept from the camera image
const OUTPUT_LONG = 3000; // px, long side of the corrected page (~260 dpi on A4)

async function loadImage(blob: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, MAX_SOURCE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return ctx.getImageData(0, 0, w, h);
}

function rotateImage(img: ImageData): ImageData {
  const src = document.createElement('canvas');
  src.width = img.width;
  src.height = img.height;
  src.getContext('2d')!.putImageData(img, 0, 0);
  const dst = document.createElement('canvas');
  dst.width = img.height;
  dst.height = img.width;
  const ctx = dst.getContext('2d', { willReadFrequently: true })!;
  ctx.translate(dst.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  return ctx.getImageData(0, 0, dst.width, dst.height);
}

/** Draw a traced doc (or the clean photo) fitted into a canvas. */
export function drawScanPreview(cv: HTMLCanvasElement, res: { doc: VectorDoc | null; clean: ImageData; mode: ScanMode }) {
  const ctx = cv.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.width, H = cv.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#e6e7eb';
  ctx.fillRect(0, 0, W, H);
  const iw = res.clean.width, ih = res.clean.height;
  const k = Math.min((W - 24 * dpr) / iw, (H - 24 * dpr) / ih);
  const ox = (W - iw * k) / 2, oy = (H - ih * k) / 2;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(ox, oy, iw * k, ih * k);
  if (res.mode === 'photo' || !res.doc) {
    const tmp = document.createElement('canvas');
    tmp.width = iw;
    tmp.height = ih;
    tmp.getContext('2d')!.putImageData(res.clean, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, ox, oy, iw * k, ih * k);
    return;
  }
  ctx.setTransform(k, 0, 0, k, ox, oy);
  for (const l of res.doc.layers) {
    ctx.fillStyle = l.color;
    for (const t of l.tiles) ctx.fill(new Path2D(t.d), 'nonzero');
  }
}

/**
 * 写真 → ベクター: capture (or pick) a photo, square up the page, choose how to trace it,
 * then place it / make a notebook / save a PDF.
 */
export function openScanDialog(onDone: (res: ScanResult, action: ScanAction) => Promise<void> | void, opts: { canPlace: boolean }) {
  const worker = new ScanWorker();
  const body = h('div', { class: 'scan' });
  const m = modal('写真をベクターで取り込む', body, { wide: true, onClose: () => worker.dispose() });

  let src: ImageData | null = null;
  let quad: P2[] = [];
  let clean: ImageData | null = null;
  let mode: ScanMode = 'mono';
  let sensitivity = 0.5;
  let result: ScanResult | null = null;

  // ---------- step 1: source ----------
  const chooseSource = () => {
    body.replaceChildren(
      h(
        'div',
        { class: 'scan-sources' },
        native?.hasScanner()
          ? h('button', { class: 'scan-source primary', 'data-testid': 'scan-native', onclick: () => void fromNative() }, icon('scan', 34), h('b', null, 'スキャナーで撮影'), h('span', null, '紙の輪郭を自動検出して台形補正'))
          : null,
        h('button', { class: 'scan-source', 'data-testid': 'scan-camera', onclick: () => void fromFile(true) }, icon('camera', 34), h('b', null, 'カメラで撮影'), h('span', null, '撮影後に四隅を合わせる')),
        h('button', { class: 'scan-source', 'data-testid': 'scan-file', onclick: () => void fromFile(false) }, icon('image', 34), h('b', null, '画像を選ぶ'), h('span', null, '撮影済みの写真から')),
      ),
      h('p', { class: 'muted', style: 'font-size:13px' }, '文字や図を輪郭線（ベクター）に変換するので、拡大しても劣化しない。影や照明ムラは自動で消える。'),
    );
  };

  const fromNative = async () => {
    try {
      const [blob] = await nativeScan(1);
      if (!blob) return;
      src = await loadImage(blob);
      quad = insetQuad(src.width, src.height, 0); // already cropped by the scanner
      await process();
    } catch (e) {
      toast('スキャナーを開けなかった: ' + (e as Error).message, 3000);
    }
  };

  const fromFile = async (camera: boolean) => {
    const [file] = await pickFiles('image/*', camera ? { capture: 'environment' } : {});
    if (!file) return;
    try {
      src = await loadImage(file);
      quad = detectDocument({ w: src.width, h: src.height, data: src.data }).quad;
      crop();
    } catch (e) {
      toast('画像を読めなかった: ' + (e as Error).message, 3000);
    }
  };

  // ---------- step 2: crop ----------
  const crop = () => {
    const img = src!;
    const cv = h('canvas', { class: 'scan-canvas', 'data-testid': 'scan-crop' });
    const bitmap = document.createElement('canvas');
    bitmap.width = img.width;
    bitmap.height = img.height;
    bitmap.getContext('2d')!.putImageData(img, 0, 0);
    let fit = { k: 1, ox: 0, oy: 0 };
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = cv.getBoundingClientRect();
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      const ctx = cv.getContext('2d')!;
      const k = Math.min(cv.width / img.width, cv.height / img.height);
      fit = { k, ox: (cv.width - img.width * k) / 2, oy: (cv.height - img.height * k) / 2 };
      ctx.fillStyle = '#16171b';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(bitmap, fit.ox, fit.oy, img.width * k, img.height * k);
      const S = (p: P2) => [fit.ox + p.x * k, fit.oy + p.y * k];
      // Dim outside the page.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, cv.width, cv.height);
      quad.forEach((p, i) => (i ? ctx.lineTo(...(S(p) as [number, number])) : ctx.moveTo(...(S(p) as [number, number]))));
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill('evenodd');
      ctx.restore();
      ctx.beginPath();
      quad.forEach((p, i) => (i ? ctx.lineTo(...(S(p) as [number, number])) : ctx.moveTo(...(S(p) as [number, number]))));
      ctx.closePath();
      ctx.strokeStyle = '#4f7cff';
      ctx.lineWidth = 2.5 * dpr;
      ctx.stroke();
      for (const p of quad) {
        const [x, y] = S(p);
        ctx.beginPath();
        ctx.arc(x, y, 14 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(79,124,255,0.25)';
        ctx.fill();
        ctx.lineWidth = 3 * dpr;
        ctx.stroke();
      }
    };
    let dragging = -1;
    cv.addEventListener('pointerdown', (e) => {
      const dpr = window.devicePixelRatio || 1;
      const r = cv.getBoundingClientRect();
      const x = (e.clientX - r.left) * dpr, y = (e.clientY - r.top) * dpr;
      let best = -1, bd = 40 * dpr;
      quad.forEach((p, i) => {
        const d = Math.hypot(fit.ox + p.x * fit.k - x, fit.oy + p.y * fit.k - y);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      dragging = best;
      if (best >= 0) cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (dragging < 0) return;
      const dpr = window.devicePixelRatio || 1;
      const r = cv.getBoundingClientRect();
      const x = ((e.clientX - r.left) * dpr - fit.ox) / fit.k, y = ((e.clientY - r.top) * dpr - fit.oy) / fit.k;
      quad[dragging] = { x: Math.min(img.width, Math.max(0, x)), y: Math.min(img.height, Math.max(0, y)) };
      draw();
    });
    cv.addEventListener('pointerup', () => (dragging = -1));
    body.replaceChildren(
      cv,
      h(
        'div',
        { class: 'row scan-actions' },
        h('button', { class: 'btn', onclick: () => ((quad = detectDocument({ w: img.width, h: img.height, data: img.data }).quad), draw()) }, icon('crop', 18), '自動検出'),
        h('button', { class: 'btn', onclick: () => ((quad = insetQuad(img.width, img.height, 0)), draw()) }, '全体'),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              src = rotateImage(img);
              quad = detectDocument({ w: src.width, h: src.height, data: src.data }).quad;
              crop();
            },
          },
          icon('reset', 18),
          '90°回転',
        ),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: chooseSource }, '撮り直す'),
        h('button', { class: 'btn primary', 'data-testid': 'scan-next', onclick: () => void process() }, '次へ'),
      ),
      h('p', { class: 'muted', style: 'font-size:13px;margin:6px 0 0' }, '青い四隅を紙の角に合わせる（ドラッグ）。'),
    );
    requestAnimationFrame(draw);
  };

  // ---------- step 3: trace & preview ----------
  const preview = h('canvas', { class: 'scan-canvas', 'data-testid': 'scan-preview' });
  const info = h('div', { class: 'muted', style: 'font-size:13px', 'data-testid': 'scan-info' });
  let seq = 0;

  const redraw = () => {
    if (!result) return;
    const dpr = window.devicePixelRatio || 1;
    const r = preview.getBoundingClientRect();
    preview.width = Math.max(1, Math.round(r.width * dpr));
    preview.height = Math.max(1, Math.round(r.height * dpr));
    drawScanPreview(preview, result);
  };

  const retrace = async () => {
    if (!clean) return;
    const my = ++seq;
    if (mode === 'photo') {
      result = { mode, doc: null, clean };
      info.textContent = `写真（影除去・台形補正済み） ${clean.width}×${clean.height}px`;
      redraw();
      return;
    }
    info.textContent = 'ベクター化中…';
    const v = await worker.vectorize(mode, sensitivity);
    if (my !== seq) return;
    result = { mode, doc: v.doc, clean };
    info.textContent = `図形 ${v.shapes.toLocaleString()} 個・${(vectorBytes(v.doc) / 1e6).toFixed(1)} MB・${Math.round(v.ms)} ms`;
    redraw();
  };

  const process = async () => {
    const img = src!;
    body.replaceChildren(h('div', { class: 'scan-busy' }, '台形補正・影の除去中…'));
    try {
      clean = await worker.prepare(img, quad, OUTPUT_LONG);
    } catch (e) {
      toast('処理に失敗: ' + (e as Error).message, 3000);
      return crop();
    }
    let t = 0;
    const slider = h('input', {
      type: 'range',
      min: 0,
      max: 1,
      step: 0.05,
      value: String(sensitivity),
      oninput: (e: Event) => {
        sensitivity = Number((e.target as HTMLInputElement).value);
        clearTimeout(t);
        t = window.setTimeout(() => void retrace(), 160);
      },
    });
    const act = (a: ScanAction) => async () => {
      if (!result) return;
      m.close();
      await onDone(result, a);
    };
    body.replaceChildren(
      preview,
      h(
        'div',
        { class: 'row scan-actions', style: 'flex-wrap:wrap' },
        chipGroup<ScanMode>(
          [
            { id: 'mono', label: '白黒ベクター' },
            { id: 'color', label: 'カラーベクター' },
            { id: 'photo', label: '写真のまま' },
          ],
          mode,
          (v) => {
            mode = v;
            void retrace();
          },
        ),
        h('label', { class: 'row', style: 'gap:6px;min-width:220px;flex:1' }, h('span', { class: 'muted', style: 'white-space:nowrap' }, '線の拾い方 薄'), slider, h('span', { class: 'muted' }, '濃')),
      ),
      info,
      h(
        'div',
        { class: 'row scan-actions' },
        h('button', { class: 'btn', onclick: () => (src && quad.length ? crop() : chooseSource()) }, '戻る'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', 'data-testid': 'scan-pdf', onclick: act('pdf') }, icon('download', 18), 'PDFで保存'),
        h('button', { class: 'btn', 'data-testid': 'scan-notebook', onclick: act('notebook') }, icon('book', 18), '新しいノートにする'),
        opts.canPlace ? h('button', { class: 'btn primary', 'data-testid': 'scan-place', onclick: act('place') }, icon('check', 18), 'このページに配置') : null,
      ),
    );
    await retrace();
  };

  chooseSource();
  return m;
}

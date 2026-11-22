import { cropItem, fullItem } from '../core/geometry';
import type { Crop, ImageItem, ScanItem } from '../core/types';
import type { AssetCache } from '../editor/assets';
import { paintImage, paintScan } from '../editor/paint';
import { h } from '../ui/dom';
import { modal } from '../ui/dialogs';

type Picture = ImageItem | ScanItem;
type Grip = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'se' | 'sw';

const MIN = 0.04; // smallest crop, as a fraction of the picture

/**
 * トリミング: choose which part of a placed picture shows. The whole picture is always shown here
 * (also when it is already cropped), so a crop can be widened again later — nothing is thrown away.
 * `apply` gets the item with its new box and crop.
 */
export function cropDialog(it: Picture, assets: AssetCache, apply: (next: Picture) => void) {
  const full = fullItem(it);
  let crop: Crop = it.crop ? { ...it.crop } : { x: 0, y: 0, w: 1, h: 1 };

  // The whole picture, upright, fitted into the dialog.
  const maxW = Math.min(760, window.innerWidth - 72), maxH = Math.max(180, Math.min(520, window.innerHeight - 260));
  const k = Math.min(maxW / full.w, maxH / full.h);
  const W = Math.max(40, Math.round(full.w * k)), H = Math.max(40, Math.round(full.h * k));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cv = h('canvas', { class: 'crop-canvas', width: Math.round(W * dpr), height: Math.round(H * dpr), style: `width:${W}px;height:${H}px` }) as HTMLCanvasElement;
  const upright = { ...full, x: 0, y: 0, rot: 0 };
  const paint = () => {
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform((W / full.w) * dpr, 0, 0, (H / full.h) * dpr, 0, 0);
    if (upright.type === 'image') paintImage(ctx, upright, assets);
    else paintScan(ctx, upright, assets, null);
  };
  paint();
  const unsub = assets.subscribe(paint);

  const box = h('div', { class: 'crop-box', 'data-testid': 'crop-box' });
  const grips: Grip[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  for (const g of grips) box.append(h('i', { class: 'crop-grip g-' + g, 'data-grip': g }));
  const size = h('span', { class: 'crop-size muted' });
  // The dimming outside the frame is clipped to the picture; the grips may stick out of it.
  const shade = h('div', { class: 'crop-shade' });
  const stage = h('div', { class: 'crop-stage', style: `width:${W}px;height:${H}px` }, h('div', { class: 'crop-clip' }, cv, shade), box);

  const layout = () => {
    box.style.left = `${crop.x * W}px`;
    box.style.top = `${crop.y * H}px`;
    box.style.width = `${crop.w * W}px`;
    box.style.height = `${crop.h * H}px`;
    shade.style.cssText = box.style.cssText;
    size.textContent = `${Math.round(crop.w * 100)}% × ${Math.round(crop.h * 100)}%`;
  };
  layout();

  let drag: { grip: Grip; x: number; y: number; c: Crop } | null = null;
  box.addEventListener('pointerdown', (e) => {
    const grip = ((e.target as HTMLElement).dataset.grip as Grip | undefined) ?? 'move';
    drag = { grip, x: e.clientX, y: e.clientY, c: { ...crop } };
    box.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) / W, dy = (e.clientY - drag.y) / H;
    const c = drag.c, g = drag.grip;
    let x0 = c.x, y0 = c.y, x1 = c.x + c.w, y1 = c.y + c.h;
    if (g === 'move') {
      const mx = Math.min(1 - x1, Math.max(-x0, dx)), my = Math.min(1 - y1, Math.max(-y0, dy));
      x0 += mx;
      x1 += mx;
      y0 += my;
      y1 += my;
    } else {
      if (g.includes('w')) x0 = Math.min(x1 - MIN, Math.max(0, x0 + dx));
      if (g.includes('e')) x1 = Math.max(x0 + MIN, Math.min(1, x1 + dx));
      if (g.includes('n')) y0 = Math.min(y1 - MIN, Math.max(0, y0 + dy));
      if (g.includes('s')) y1 = Math.max(y0 + MIN, Math.min(1, y1 + dy));
    }
    crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    layout();
  });
  const end = () => (drag = null);
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);

  const m = modal(
    'トリミング',
    h(
      'div',
      { class: 'crop-dialog' },
      stage,
      h('p', { class: 'muted crop-hint' }, '枠の角・辺をドラッグして残す範囲を決める。元の画像は消えないので、あとでもう一度開けば広げ直せる。 ', size),
    ),
    {
      wide: true,
      onClose: unsub,
      actions: [
        h('button', {
          class: 'btn',
          'data-testid': 'crop-reset',
          onclick: () => {
            crop = { x: 0, y: 0, w: 1, h: 1 };
            layout();
          },
        }, '全体に戻す'),
        h('button', { class: 'btn', onclick: () => m.close() }, 'キャンセル'),
        h('button', {
          class: 'btn primary',
          'data-testid': 'crop-apply',
          onclick: () => {
            m.close();
            apply(cropItem(it, crop));
          },
        }, '切り抜く'),
      ],
    },
  );
}

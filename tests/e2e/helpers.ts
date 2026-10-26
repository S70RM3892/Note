import type { CDPSession, Page } from '@playwright/test';

export type P = [number, number, number?];

const sessions = new WeakMap<Page, CDPSession>();

async function cdp(page: Page): Promise<CDPSession> {
  let s = sessions.get(page);
  if (!s) {
    s = await page.context().newCDPSession(page);
    sessions.set(page, s);
  }
  return s;
}

/** Draw with an emulated stylus (pointerType "pen", with pressure). */
export async function pen(page: Page, points: P[], opts: { buttons?: number; holdMs?: number } = {}) {
  const c = await cdp(page);
  const buttons = opts.buttons ?? 1;
  const [x0, y0, p0] = points[0];
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, buttons: 0, pointerType: 'pen', force: 0 });
  const button = buttons === 2 ? 'right' : 'left';
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button, buttons, clickCount: 1, force: p0 ?? 0.5, pointerType: 'pen' });
  for (const [x, y, p] of points.slice(1)) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button, buttons, force: p ?? 0.5, pointerType: 'pen' });
  }
  if (opts.holdMs) await page.waitForTimeout(opts.holdMs);
  const [x1, y1] = points[points.length - 1];
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button, buttons: 0, clickCount: 1, force: 0, pointerType: 'pen' });
  // Pen leaves: lets palm rejection release touches.
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 790, buttons: 0, pointerType: 'mouse' });
}

/** Hover the pen without touching. */
export async function penHover(page: Page, x: number, y: number) {
  const c = await cdp(page);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'pen', force: 0 });
}

export function line(x0: number, y0: number, x1: number, y1: number, n = 30, p = 0.5): P[] {
  return Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, p] as P);
}

export function wave(x: number, y: number, w: number, n = 60): P[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return [x + t * w, y + Math.sin(t * 10) * 20, 0.3 + 0.5 * Math.sin(t * Math.PI)] as P;
  });
}

/** Multi-finger touch sequence. frames[k] = positions of each finger at step k. */
export async function touch(page: Page, frames: [number, number][][]) {
  const c = await cdp(page);
  const pts = (f: [number, number][]) => f.map(([x, y], id) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 1 }));
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(frames[0]) });
  for (const f of frames.slice(1)) await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(f) });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Low-level touch control for interleaving with pen events. */
export async function touchStep(page: Page, type: 'touchStart' | 'touchMove' | 'touchEnd', pts: [number, number][]) {
  const c = await cdp(page);
  await c.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 1 })) });
}

export async function tapFingers(page: Page, positions: [number, number][]) {
  await touch(page, [positions]);
}

export interface DocInfo {
  pages: { strokes: { kind: string; n: number; shape: boolean; color: string; id: string }[]; items: { type: string; revealed?: boolean; text?: string; x: number; y: number }[] }[];
  tool: string;
  zoom: number;
  canUndo: boolean;
  current: number;
}

export async function docInfo(page: Page): Promise<DocInfo> {
  return page.evaluate(() => {
    const app = (window as unknown as { sumi: Record<string, any> }).sumi;
    const view = app['view'];
    const doc = view['doc'];
    const ed = app['editor'];
    return {
      pages: doc.pages.map((p: any) => ({
        strokes: p.strokes.map((s: any) => ({ kind: s.kind, n: s.pts.length / 3, shape: !!s.shape, color: s.color, id: s.id })),
        items: p.items.map((i: any) => ({ type: i.type, revealed: i.revealed, text: i.text, x: i.x, y: i.y })),
      })),
      tool: ed.tool,
      zoom: ed.vp.zoom,
      canUndo: doc.history.canUndo,
      current: ed.currentPage,
    };
  });
}

/** Screen position of a page-coordinate point on page `i`. */
export async function pageToScreen(page: Page, i: number, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(
    ([i, x, y]) => {
      const ed = (window as unknown as { sumi: Record<string, any> }).sumi['editor'];
      const r = ed.vp.rects[i];
      const box = ed.el.getBoundingClientRect();
      return [box.left + ed.vp.toScreenX(r.x + x), box.top + ed.vp.toScreenY(r.y + y)] as [number, number];
    },
    [i, x, y] as const,
  );
}

export async function newNotebook(page: Page, title = 'テスト') {
  await page.goto('/');
  await page.getByTestId('new-notebook').click();
  await page.getByTestId('nb-title').fill(title);
  await page.getByTestId('create-notebook').click();
  await page.waitForFunction(() => !!(window as unknown as { sumi: Record<string, any> }).sumi?.['view']?.['doc']);
  await page.waitForTimeout(300);
}

export async function flush(page: Page) {
  await page.evaluate(() => (window as unknown as { sumi: { flush(): Promise<void> } }).sumi.flush());
}

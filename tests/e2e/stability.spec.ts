import { expect, test, type Page } from '@playwright/test';
import { docInfo, line, newNotebook, pen, type P } from './helpers';

/** The committed strokes of page 1: shape flag, point count and extent (page units). */
async function strokes(page: Page) {
  return page.evaluate(() =>
    (window as any).sumi.view.doc.pages[0].strokes.map((s: any) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < s.pts.length; i += 3) {
        x0 = Math.min(x0, s.pts[i]);
        x1 = Math.max(x1, s.pts[i]);
        y0 = Math.min(y0, s.pts[i + 1]);
        y1 = Math.max(y1, s.pts[i + 1]);
      }
      return { shape: !!s.shape, n: s.pts.length / 3, w: x1 - x0, h: y1 - y0 };
    }),
  );
}

/** Screen px per page unit at the current zoom. */
const zoom = (page: Page) => page.evaluate(() => (window as any).sumi.editor.vp.zoom as number);

test('a busy moment mid-stroke never turns handwriting into a shape', async ({ page }) => {
  await newNotebook(page);
  const c = await page.context().newCDPSession(page);
  const send = (type: string, x: number, y: number, buttons = 1) =>
    c.send('Input.dispatchMouseEvent', { type: type as 'mouseMoved', x, y, button: 'left', buttons, clickCount: 1, force: 0.5, pointerType: 'pen' });
  await send('mousePressed', 300, 300);
  for (const [x, y] of line(300, 300, 520, 320, 20)) await send('mouseMoved', x, y);
  // The page is busy for 0.7 s (a big save, a redraw) while the pen goes on: its samples queue up
  // behind the busy task, and the hold-to-snap timer expires before they are seen.
  await page.evaluate(() =>
    setTimeout(() => {
      const t = performance.now();
      while (performance.now() - t < 700) {
        /* busy */
      }
    }, 0),
  );
  await page.waitForTimeout(50);
  const rest: P[] = Array.from({ length: 60 }, (_, i) => [520 + i * 6, 320 + 80 * Math.sin(i / 8)]);
  await Promise.all(rest.map(([x, y]) => send('mouseMoved', x, y)));
  await send('mouseReleased', 880, 320 + 80 * Math.sin(59 / 8), 0);
  await expect.poll(async () => (await strokes(page)).length).toBe(1);
  const [s] = await strokes(page);
  const z = await zoom(page);
  // Handwriting, not a snapped line, reaching where the pen lifted. (CDP mouse moves sent while
  // the page is blocked get merged by the browser, so the curve's middle isn't checked here.)
  expect(s.shape).toBe(false);
  expect(s.w * z).toBeGreaterThan(560);
  expect(s.n).toBeGreaterThan(20);
});

test('a pause mid-stroke may snap, but writing on turns it back into handwriting', async ({ page }) => {
  await newNotebook(page);
  // Write, rest 0.7 s (snaps to a line), then carry on in another direction.
  const c = await page.context().newCDPSession(page);
  const send = (type: string, x: number, y: number, buttons = 1) =>
    c.send('Input.dispatchMouseEvent', { type: type as 'mouseMoved', x, y, button: 'left', buttons, clickCount: 1, force: 0.5, pointerType: 'pen' });
  await send('mousePressed', 300, 400);
  for (const [x, y] of line(300, 400, 600, 400, 30)) await send('mouseMoved', x, y);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => !!(window as any).sumi.editor.tools.pen.snapped)).toBe(true);
  for (const [x, y] of line(600, 400, 650, 550, 30)) await send('mouseMoved', x, y);
  await send('mouseReleased', 650, 550, 0);
  const [s] = await strokes(page);
  const z = await zoom(page);
  expect(s.shape).toBe(false);
  expect(s.w * z).toBeGreaterThan(330);
  expect(s.h * z).toBeGreaterThan(130);
  // Resting at the end still snaps (that's the feature).
  await pen(page, line(300, 650, 600, 650), { holdMs: 700 });
  expect((await strokes(page))[1].shape).toBe(true);
});

test('a lost pen-up does not block the strokes after it', async ({ page }) => {
  await newNotebook(page);
  // Synthetic pen events: a stroke whose pointerup never arrives, then the next stroke.
  await page.evaluate(() => {
    const el = (window as any).sumi.editor.el as HTMLElement;
    const r = el.getBoundingClientRect();
    const fire = (type: string, id: number, x: number, y: number, buttons: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'pen', clientX: r.left + x, clientY: r.top + y, pressure: 0.5, buttons, bubbles: true }));
    fire('pointerdown', 41, 200, 200, 1);
    for (let i = 1; i <= 20; i++) fire('pointermove', 41, 200 + i * 10, 200, 1);
    // …no pointerup for 41.
    fire('pointerdown', 42, 200, 300, 1);
    for (let i = 1; i <= 20; i++) fire('pointermove', 42, 200 + i * 10, 300, 1);
    fire('pointerup', 42, 400, 300, 0);
  });
  const s = await strokes(page);
  expect(s).toHaveLength(2);
  expect(s.every((x) => !x.shape)).toBe(true);
  // And the pen keeps working.
  await pen(page, line(300, 500, 600, 520));
  expect(await strokes(page)).toHaveLength(3);
});

test('fast writing: every stroke lands as written; a long stroke stays whole', async ({ page }) => {
  test.setTimeout(150_000);
  await newNotebook(page);
  // 120 quick strokes (kana-sized flicks) back to back, autosaves running in between.
  const c = await page.context().newCDPSession(page);
  const send = (type: string, x: number, y: number, buttons = 1) =>
    c.send('Input.dispatchMouseEvent', { type: type as 'mouseMoved', x, y, button: 'left', buttons, clickCount: 1, force: 0.5, pointerType: 'pen' });
  for (let k = 0; k < 120; k++) {
    const x = 120 + (k % 30) * 35, y = 220 + Math.floor(k / 30) * 60;
    await send('mousePressed', x, y);
    for (let i = 1; i <= 6; i++) await send('mouseMoved', x + i * 3, y + (k % 2 ? i * 4 : -i * 2));
    await send('mouseReleased', x + 18, y + (k % 2 ? 24 : -12), 0);
  }
  // A long line: 2000 samples back and forth over 1000 px.
  await send('mousePressed', 100, 600);
  for (let i = 1; i <= 2000; i++) {
    const row = Math.floor(i / 1000);
    const x = row % 2 ? 1100 - (i % 1000) : 100 + (i % 1000);
    await send('mouseMoved', x, 600 + row * 30 + 10 * Math.sin(i / 40));
  }
  await send('mouseReleased', 1100, 630, 0);
  await expect.poll(async () => (await docInfo(page)).pages[0].strokes.length).toBe(121);
  const s = await strokes(page);
  expect(s.filter((x) => x.shape)).toHaveLength(0);
  const z = await zoom(page);
  const long = s[120];
  expect(long.w * z).toBeGreaterThan(990);
  expect(long.n).toBeGreaterThan(800);
});

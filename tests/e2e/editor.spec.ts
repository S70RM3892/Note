import { expect, test } from '@playwright/test';
import { docInfo, flush, line, newNotebook, pageToScreen, pen, penHold, penHover, penLift, tapFingers, touch, touchStep, wave } from './helpers';

test.describe('ink', () => {
  test('pen strokes are drawn, saved and survive a reload', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await newNotebook(page, '数学');
    await pen(page, wave(300, 250, 400));
    await pen(page, wave(300, 350, 300));
    let info = await docInfo(page);
    expect(info.pages[0].strokes.length).toBe(2);
    expect(info.pages[0].strokes[0].n).toBeGreaterThan(20);
    await flush(page);
    await page.reload();
    await page.waitForFunction(() => !!(window as any).sumi?.view?.doc);
    info = await docInfo(page);
    expect(info.pages[0].strokes.length).toBe(2);
    await page.screenshot({ path: 'test-results/ink.png' });
    expect(errors).toEqual([]);
  });

  for (const style of ['ballpoint', 'pencil'] as const) {
    test(`live ink is continuous while the pen is down (${style})`, async ({ page }) => {
      await newNotebook(page);
      await page.evaluate((st) => (window as any).sumi.settings.update({ pen: { style: st, color: '#222222', width: 3 } }), style);
      await pen(page, wave(300, 250, 300)); // a previous stroke whose delayed clear must not interfere
      const pts = wave(300, 400, 420, 80);
      await penHold(page, pts);
      await page.waitForTimeout(100);
      // Ink under every input sample and every column along the stroke on the live layer.
      const gaps = await page.evaluate((samples) => {
        const ed = (window as any).sumi.editor;
        const live: HTMLCanvasElement = ed.live.canvas;
        const c = document.createElement('canvas');
        c.width = live.width;
        c.height = live.height;
        const x = c.getContext('2d')!;
        x.drawImage(live, 0, 0);
        const box = ed.el.getBoundingClientRect();
        const dpr = ed.vp.dpr;
        const inked = (px: number, py: number, w: number, h: number) => {
          const d = x.getImageData(Math.round((px - box.left) * dpr), Math.round((py - box.top) * dpr), Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr))).data;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 200) return true;
          return false;
        };
        const empty: string[] = [];
        for (const [sx, sy] of samples.slice(2, -2)) if (!inked(sx - 0.5, sy - 0.5, 1, 1)) empty.push(`pt ${sx.toFixed(0)},${sy.toFixed(0)}`);
        for (let cx = 305; cx < 700; cx += 1) if (!inked(cx, 370, 1, 60)) empty.push(`col ${cx}`);
        return empty;
      }, pts);
      expect(gaps).toEqual([]);
      await penLift(page, pts[pts.length - 1][0], pts[pts.length - 1][1]);
      expect((await docInfo(page)).pages[0].strokes.length).toBe(2);
    });
  }

  test('highlighter and shape snapping', async ({ page }) => {
    await newNotebook(page);
    await page.getByTestId('tool-highlighter').click();
    await pen(page, line(300, 300, 700, 300));
    await page.getByTestId('tool-pen').click();
    // Circle + hold → snapped shape.
    const circ = Array.from({ length: 61 }, (_, i) => {
      const a = (i / 60) * Math.PI * 2.04;
      return [800 + 70 * Math.cos(a), 400 + 70 * Math.sin(a), 0.5] as [number, number, number];
    });
    await pen(page, circ, { holdMs: 700 });
    // Quick wobbly line without hold stays freehand.
    await pen(page, wave(300, 500, 300));
    const s = (await docInfo(page)).pages[0].strokes;
    expect(s.map((x) => x.kind)).toEqual(['highlighter', 'pen', 'pen']);
    expect(s[1].shape).toBe(true);
    expect(s[2].shape).toBe(false);
  });

  test('undo/redo with buttons and two/three-finger taps', async ({ page }) => {
    await newNotebook(page);
    await pen(page, wave(300, 300, 300));
    await pen(page, wave(300, 400, 300));
    await page.getByTestId('undo').click();
    expect((await docInfo(page)).pages[0].strokes.length).toBe(1);
    await page.getByTestId('redo').click();
    expect((await docInfo(page)).pages[0].strokes.length).toBe(2);
    await page.waitForTimeout(1000); // palm-rejection window after the pen
    await tapFingers(page, [
      [500, 600],
      [600, 600],
    ]);
    expect((await docInfo(page)).pages[0].strokes.length).toBe(1);
    await tapFingers(page, [
      [500, 600],
      [600, 600],
      [700, 600],
    ]);
    expect((await docInfo(page)).pages[0].strokes.length).toBe(2);
  });

  test('partial eraser splits, stroke eraser removes, eraser end of pen works', async ({ page }) => {
    await newNotebook(page);
    await pen(page, line(300, 300, 700, 300, 60));
    await page.getByTestId('tool-eraser').click();
    await pen(page, line(500, 250, 500, 350, 10));
    let s = (await docInfo(page)).pages[0].strokes;
    expect(s.length).toBe(2);
    // Whole-stroke mode removes both pieces with one swipe.
    await page.evaluate(() => (window as any).sumi.settings.update({ eraserMode: 'stroke' }));
    await pen(page, line(350, 280, 650, 320, 20));
    s = (await docInfo(page)).pages[0].strokes;
    expect(s.length).toBe(0);
    // Pen tool, but the S Pen side button is held (barrel button → buttons=2): erases.
    await page.getByTestId('tool-pen').click();
    await pen(page, line(300, 450, 700, 450, 40));
    await pen(page, line(500, 400, 500, 500, 10), { buttons: 2 });
    expect((await docInfo(page)).pages[0].strokes.length).toBe(0);
    // One undo brings the erased stroke back.
    await page.getByTestId('undo').click();
    expect((await docInfo(page)).pages[0].strokes.length).toBe(1);
  });

  test('palm resting while the pen hovers does not scroll', async ({ page }) => {
    await newNotebook(page);
    const before = await page.evaluate(() => (window as any).sumi.editor.vp.camY);
    await penHover(page, 500, 300);
    await touch(page, [
      [[700, 600]],
      [[700, 500]],
      [[700, 400]],
    ]);
    const after = await page.evaluate(() => (window as any).sumi.editor.vp.camY);
    expect(after).toBe(before);
  });

  test('a palm that lands before the pen stops scrolling once the pen hovers', async ({ page }) => {
    await newNotebook(page);
    await page.waitForTimeout(600);
    const y0 = await page.evaluate(() => (window as any).sumi.editor.vp.camY);
    // (pauses keep Chrome from coalescing the moves into one event)
    await touchStep(page, 'touchStart', [[700, 600]]);
    await page.waitForTimeout(30);
    await touchStep(page, 'touchMove', [[700, 580]]);
    await page.waitForTimeout(30);
    await touchStep(page, 'touchMove', [[700, 540]]);
    await page.waitForTimeout(30);
    const y1 = await page.evaluate(() => (window as any).sumi.editor.vp.camY);
    expect(y1).toBeGreaterThan(y0); // it was scrolling…
    await penHover(page, 400, 300);
    await page.waitForTimeout(30);
    await touchStep(page, 'touchMove', [[700, 450]]);
    await page.waitForTimeout(30);
    await touchStep(page, 'touchMove', [[700, 350]]);
    await page.waitForTimeout(30);
    await touchStep(page, 'touchEnd', []);
    const y2 = await page.evaluate(() => (window as any).sumi.editor.vp.camY);
    expect(y2).toBeCloseTo(y1, 1); // …and stopped when the pen arrived
    // A two-finger "tap" right after writing is a palm, not an undo.
    await pen(page, wave(300, 300, 200));
    await tapFingers(page, [
      [600, 600],
      [700, 620],
    ]);
    expect((await docInfo(page)).pages[0].strokes.length).toBe(1);
  });

  test('pinch zooms and one finger pans', async ({ page }) => {
    await newNotebook(page);
    const z0 = (await docInfo(page)).zoom;
    await touch(page, [
      [
        [600, 400],
        [700, 400],
      ],
      [
        [550, 400],
        [750, 400],
      ],
      [
        [500, 400],
        [800, 400],
      ],
    ]);
    const z1 = (await docInfo(page)).zoom;
    expect(z1).toBeGreaterThan(z0 * 2);
    const y0 = await page.evaluate(() => (window as any).sumi.editor.vp.camY);
    await touch(page, [[[600, 600]], [[600, 560]], [[600, 500]], [[600, 450]]]);
    const y1 = await page.evaluate(() => (window as any).sumi.editor.vp.camY);
    expect(y1).toBeGreaterThan(y0);
    // Fingers never ink by default.
    expect((await docInfo(page)).pages[0].strokes.length).toBe(0);
  });
});

test.describe('selection & items', () => {
  test('lasso select, move to another spot, duplicate, delete', async ({ page }) => {
    await newNotebook(page);
    await pen(page, wave(300, 300, 200));
    await page.getByTestId('tool-lasso').click();
    await pen(page, [
      [250, 230],
      [550, 230],
      [550, 380],
      [250, 380],
      [250, 232],
    ]);
    await expect(page.locator('.sel-menu')).toBeVisible();
    const before = (await docInfo(page)).pages[0].strokes[0];
    // Drag the selection.
    await pen(page, line(400, 300, 400, 500, 10));
    const moved = (await docInfo(page)).pages[0].strokes[0];
    expect(moved.id).toBe(before.id);
    await page.getByTestId('sel-duplicate').click();
    expect((await docInfo(page)).pages[0].strokes.length).toBe(2);
    await page.getByTestId('sel-delete').click();
    expect((await docInfo(page)).pages[0].strokes.length).toBe(1);
    await page.screenshot({ path: 'test-results/lasso.png' });
  });

  test('暗記テープ: lay tape, finger tap peels it, lasso → tape', async ({ page }) => {
    await newNotebook(page);
    await pen(page, wave(300, 300, 200));
    await page.getByTestId('tool-tape').click();
    await pen(page, line(300, 420, 600, 420, 20));
    let items = (await docInfo(page)).pages[0].items;
    expect(items.map((i) => i.type)).toEqual(['tape']);
    expect(items[0].revealed).toBeFalsy();
    await page.waitForTimeout(500);
    await tapFingers(page, [[450, 420]]);
    items = (await docInfo(page)).pages[0].items;
    expect(items[0].revealed).toBe(true);
    // Lasso the writing and cover it.
    await page.getByTestId('tool-lasso').click();
    await pen(page, [
      [250, 230],
      [550, 230],
      [550, 370],
      [250, 370],
      [250, 232],
    ]);
    await page.getByTestId('sel-tape').click();
    items = (await docInfo(page)).pages[0].items;
    expect(items.filter((i) => i.type === 'tape').length).toBe(2);
    await page.screenshot({ path: 'test-results/tape.png' });
  });

  test('text tool adds text', async ({ page }) => {
    await newNotebook(page);
    await page.getByTestId('tool-text').click();
    await pen(page, [
      [400, 300],
      [400, 300],
    ]);
    await page.keyboard.type('f(x)=x^2');
    await page.getByTestId('tool-pen').click();
    const items = (await docInfo(page)).pages[0].items;
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('f(x)=x^2');
  });
});

test.describe('pages', () => {
  test('add, navigate, overview, delete and undo', async ({ page }) => {
    await newNotebook(page);
    await page.getByTestId('add-page').click();
    await page.getByTestId('add-page').click();
    let info = await docInfo(page);
    expect(info.pages.length).toBe(3);
    await expect(page.getByTestId('page-pill')).toHaveText(/3 \/ 3/);
    // Draw on page 3, then open overview and jump to page 1.
    const [x, y] = await pageToScreen(page, 2, 200, 200);
    await pen(page, line(x, y, x + 200, y + 50));
    info = await docInfo(page);
    expect(info.pages[2].strokes.length).toBe(1);
    await page.getByTestId('overview').click();
    await expect(page.locator('.page-thumb')).toHaveCount(3);
    await page.screenshot({ path: 'test-results/overview.png' });
    await page.locator('.page-thumb').first().click();
    await expect(page.getByTestId('page-pill')).toHaveText(/1 \/ 3/);
    await page.evaluate(() => (window as any).sumi.view.deletePage(2));
    expect((await docInfo(page)).pages.length).toBe(2);
    await page.getByTestId('undo').click();
    expect((await docInfo(page)).pages.length).toBe(3);
    expect((await docInfo(page)).pages[2].strokes.length).toBe(1);
  });
});

test('horizontal layout turns pages with a swipe', async ({ page }) => {
  await newNotebook(page);
  await page.getByTestId('add-page').click();
  await page.getByTestId('add-page').click();
  await page.evaluate(() => (window as any).sumi.view.toggleLayout());
  await page.waitForTimeout(300);
  expect((await docInfo(page)).current).toBe(2);
  // Quick swipe to the right → previous page.
  await touch(page, [[[400, 500]], [[480, 500]], [[560, 500]], [[640, 500]]]);
  await page.waitForTimeout(500);
  expect((await docInfo(page)).current).toBe(1);
  // Slow small drag → snaps back to the same page.
  await touch(page, [[[600, 500]], [[590, 500]], [[580, 500]]]);
  await page.waitForTimeout(500);
  expect((await docInfo(page)).current).toBe(1);
  const camX = await page.evaluate(() => {
    const vp = (window as any).sumi.editor.vp;
    const r = vp.rects[1];
    return Math.abs(vp.camX - (r.x + r.w / 2 - vp.width / vp.zoom / 2));
  });
  expect(camX).toBeLessThan(1);
});

test('参照ビュー: read-only notebook beside the one being written, restored on reopen', async ({ page }) => {
  await newNotebook(page, '問題');
  await pen(page, wave(300, 300, 300));
  await flush(page);
  await page.getByTestId('back').click();
  await page.getByTestId('new-notebook').click();
  await page.getByTestId('nb-title').fill('解答');
  await page.getByTestId('create-notebook').click();
  await page.waitForFunction(() => (window as any).sumi?.view?.doc?.nb?.title === '解答');
  // Record every notebook the app writes from here on.
  await page.evaluate(() => {
    const repo = (window as any).sumi.repo;
    const orig = repo.savePages.bind(repo);
    (window as any).__written = [];
    repo.savePages = (pages: any[], nb?: any) => {
      (window as any).__written.push(nb?.title ?? pages[0]?.nb);
      return orig(pages, nb);
    };
  });
  await page.getByTestId('ref-btn').click();
  await page.getByTestId('ref-choice').filter({ hasText: '問題' }).click();
  await expect(page.getByTestId('ref-pane')).toBeVisible();
  const refBox = (await page.getByTestId('ref-pane').boundingBox())!;
  // The pen scrolls the reference instead of writing on it.
  const cam0 = await page.evaluate(() => (window as any).sumi.view.ref.editor.vp.camY);
  await pen(page, [
    [refBox.x + refBox.width / 2, refBox.y + 500],
    [refBox.x + refBox.width / 2, refBox.y + 400],
    [refBox.x + refBox.width / 2, refBox.y + 300],
  ]);
  const cam1 = await page.evaluate(() => (window as any).sumi.view.ref.editor.vp.camY);
  expect(cam1).toBeGreaterThan(cam0);
  expect(await page.evaluate(() => (window as any).sumi.view.ref.doc.pages[0].strokes.length)).toBe(1);
  // Writing on the right still works.
  const mainBox = (await page.locator('.stage-wrap').boundingBox())!;
  await pen(page, wave(mainBox.x + 80, mainBox.y + 200, 200));
  expect((await docInfo(page)).pages[0].strokes.length).toBe(1);
  await page.screenshot({ path: 'test-results/split.png' });
  // Switching the reference closes the old one: it must not be written either.
  await page.getByTestId('ref-btn').click();
  await page.getByText('別のノートを参照').click();
  await page.getByTestId('ref-choice').filter({ hasText: '問題' }).click();
  await flush(page);
  await page.waitForTimeout(800);
  const written: string[] = await page.evaluate(() => (window as any).__written);
  expect(written.length).toBeGreaterThan(0);
  expect(written.every((t) => t === '解答')).toBe(true);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).sumi?.view?.ref?.doc);
  await expect(page.getByTestId('ref-pane')).toBeVisible();
});

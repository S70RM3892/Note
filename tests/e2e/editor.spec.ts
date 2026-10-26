import { expect, test } from '@playwright/test';
import { docInfo, flush, line, newNotebook, pageToScreen, pen, penHover, tapFingers, touch, wave } from './helpers';

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
    await page.waitForTimeout(500); // palm-rejection window after the pen
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

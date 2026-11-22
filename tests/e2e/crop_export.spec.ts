import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { docInfo, flush, newNotebook, pageToScreen, pen } from './helpers';

/** A 64×32 PNG: left half red, right half blue. */
async function twoTone(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() => {
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 32;
    const c = cv.getContext('2d')!;
    c.fillStyle = '#ff0000';
    c.fillRect(0, 0, 32, 32);
    c.fillStyle = '#0000ff';
    c.fillRect(32, 0, 32, 32);
    return cv.toDataURL('image/png');
  });
  return Buffer.from(url.split(',')[1], 'base64');
}

async function insertImage(page: Page) {
  const png = await twoTone(page);
  await page.getByTestId('more').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('画像を挿入').click();
  await (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.sel-menu')).toBeVisible();
}

const item = (page: Page) =>
  page.evaluate(() => {
    const it = (window as any).sumi.view.doc.pages[0].items[0];
    return { x: it.x, y: it.y, w: it.w, h: it.h, crop: it.crop ?? null, locked: !!it.locked };
  });

/** Colour of the main canvas at a page-coordinate point of page 0. */
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  const [sx, sy] = await pageToScreen(page, 0, x, y);
  return page.evaluate(
    ([sx, sy]) => {
      const ed = (window as any).sumi.editor;
      const cv = ed.el.querySelector('canvas') as HTMLCanvasElement;
      const box = cv.getBoundingClientRect();
      const k = cv.width / box.width;
      return Array.from(cv.getContext('2d')!.getImageData(Math.round((sx - box.left) * k), Math.round((sy - box.top) * k), 1, 1).data);
    },
    [sx, sy] as const,
  );
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

test('トリミング: crop a placed image, the rest stays where it was, undo and widening work', async ({ page }) => {
  await newNotebook(page);
  await insertImage(page);
  const before = await item(page);
  expect(before.crop).toBeNull();

  await page.getByTestId('sel-crop').click();
  const box = page.getByTestId('crop-box');
  await expect(box).toBeVisible();
  const r = (await box.boundingBox())!;
  // Pull the left edge to the middle: only the blue half is kept.
  await drag(page, { x: r.x, y: r.y + r.height / 2 }, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
  await page.getByTestId('crop-apply').click();
  await expect(page.getByTestId('crop-box')).toHaveCount(0);

  const after = await item(page);
  expect(after.crop!.x).toBeGreaterThan(0.45);
  expect(after.crop!.x).toBeLessThan(0.55);
  expect(after.crop!.w).toBeCloseTo(1 - after.crop!.x, 5);
  expect(after.w).toBeCloseTo(before.w * after.crop!.w, 3);
  expect(after.h).toBeCloseTo(before.h, 3);
  // The right edge did not move.
  expect(after.x + after.w).toBeCloseTo(before.x + before.w, 3);

  // On the page: where the red half was is paper again, the blue half is still in place.
  await page.waitForTimeout(250);
  const red = await pixel(page, before.x + before.w * 0.25, before.y + before.h / 2);
  const blue = await pixel(page, before.x + before.w * 0.75, before.y + before.h / 2);
  expect(red[0] === 255 && red[1] === 0 && red[2] === 0).toBe(false);
  expect(blue.slice(0, 3)).toEqual([0, 0, 255]);

  // It survives a reload…
  await flush(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).sumi?.view?.doc);
  expect((await item(page)).crop!.x).toBeCloseTo(after.crop!.x, 5);

  // …and can be opened again (the whole picture is still there) and reset.
  await page.getByTestId('tool-lasso').click();
  const [tx, ty] = await pageToScreen(page, 0, after.x + after.w / 2, after.y + after.h / 2);
  await pen(page, [[tx, ty]]);
  // Placed pictures lock themselves: the tap offers トリミング for the locked picture.
  const menuItem = page.getByText('トリミング', { exact: true });
  await menuItem.click();
  await page.getByTestId('crop-reset').click();
  await page.getByTestId('crop-apply').click();
  const reset = await item(page);
  expect(reset.crop).toBeNull();
  expect(reset.w).toBeCloseTo(before.w, 3);
  expect(reset.x).toBeCloseTo(before.x, 3);
  await page.waitForTimeout(250);
  expect((await pixel(page, before.x + before.w * 0.25, before.y + before.h / 2)).slice(0, 3)).toEqual([255, 0, 0]);
});

test('PDF: export a page range, and a lassoed part of a page', async ({ page }) => {
  await newNotebook(page, 'range');
  // Part of a page: lasso an empty area with ink beside it → a PDF the size of the area.
  await pen(page, [
    [500, 300],
    [560, 320],
    [620, 300],
  ]);
  await page.getByTestId('tool-lasso').click();
  const [x0, y0] = await pageToScreen(page, 0, 100, 400);
  const [x1, y1] = await pageToScreen(page, 0, 400, 550);
  await pen(page, [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0 + 2],
  ]);
  let dl = page.waitForEvent('download');
  await page.getByTestId('region-pdf').click();
  let file = await dl;
  expect(file.suggestedFilename()).toBe('range_p1_part.pdf');
  let pdf = await PDFDocument.load(await readFile(await file.path()));
  expect(pdf.getPageCount()).toBe(1);
  const size = pdf.getPage(0).getSize();
  expect(size.width).toBeCloseTo(300 * 0.75, 0);
  expect(size.height).toBeCloseTo(150 * 0.75, 0);

  // Four pages, something on each.
  for (let i = 0; i < 3; i++) await page.getByTestId('add-page').click();
  expect((await docInfo(page)).pages.length).toBe(4);

  await page.getByTestId('more').click();
  await page.getByText('PDFで書き出し / 共有').click();
  await page.getByTestId('export-range').getByText('ページを指定').click();
  const input = page.getByTestId('export-pages');
  await input.fill('ぜんぶ');
  await expect(page.getByTestId('do-export')).toBeDisabled();
  await input.fill('2-3');
  await expect(page.getByTestId('export-note')).toContainText('2ページ');
  dl = page.waitForEvent('download');
  await page.getByTestId('do-export').click();
  file = await dl;
  expect(file.suggestedFilename()).toBe('range_p2-3.pdf');
  pdf = await PDFDocument.load(await readFile(await file.path()));
  expect(pdf.getPageCount()).toBe(2);
});

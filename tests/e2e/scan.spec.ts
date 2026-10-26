import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { docInfo, newNotebook, pen } from './helpers';

/** A "photo" of a sheet lying askew on a dark desk, with a shadow, black text, a ring and a red disc. */
async function fakePhoto(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const cv = document.createElement('canvas');
    cv.width = 1600;
    cv.height = 1200;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#3a342e';
    ctx.fillRect(0, 0, 1600, 1200);
    // Sheet: affine (rotated + slightly skewed) A4-ish rectangle.
    ctx.setTransform(0.98, 0.08, -0.05, 0.99, 230, 110);
    ctx.fillStyle = '#f4f1ea';
    ctx.fillRect(0, 0, 1050, 960);
    ctx.fillStyle = '#16161a';
    ctx.font = 'bold 64px sans-serif';
    ctx.fillText('ABCDEF 123', 90, 170);
    ctx.font = '40px sans-serif';
    for (let i = 0; i < 6; i++) ctx.fillText('x^2 + y^2 = r^2  OQPBR', 90, 270 + i * 70);
    ctx.lineWidth = 18;
    ctx.strokeStyle = '#16161a';
    ctx.beginPath();
    ctx.arc(300, 800, 80, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#d0302c';
    ctx.beginPath();
    ctx.arc(700, 800, 90, 0, Math.PI * 2);
    ctx.fill();
    // Shadow across the right part of the sheet.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const g = ctx.createLinearGradient(700, 0, 1400, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1600, 1200);
    return cv.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

async function scanThroughDialog(page: Page, openButton: string) {
  const png = await fakePhoto(page);
  await page.getByTestId(openButton).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('scan-file').click();
  await (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByTestId('scan-crop')).toBeVisible();
  await page.getByTestId('scan-next').click();
  await expect(page.getByTestId('scan-info')).toContainText('図形', { timeout: 30000 });
}

test('写真 → カラーベクター → 配置 → 自動で固定 → PDF はベクターのまま', async ({ page }) => {
  test.setTimeout(90_000);
  await newNotebook(page);
  await scanThroughDialog(page, 'scan-btn');
  await page.getByText('カラーベクター').click();
  await expect(page.getByTestId('scan-info')).toContainText('図形', { timeout: 30000 });
  await page.screenshot({ path: 'test-results/scan-preview.png' });
  await page.getByTestId('scan-place').click();
  await page.waitForFunction(() => (window as any).sumi.view.doc.pages[0].items.length === 1);
  let info = await docInfo(page);
  expect(info.pages[0].items[0].type).toBe('scan');
  await expect(page.locator('.sel-menu')).toBeVisible();

  // The vector artwork has a red layer under the black one, and plenty of shapes.
  const layers = await page.evaluate(async () => {
    const app = (window as any).sumi;
    const it = app.view.doc.pages[0].items[0];
    const a = await app.repo.getAsset(it.vector);
    const doc = JSON.parse(await a.blob.text());
    return doc.layers.map((l: any) => ({ color: l.color, n: l.tiles.reduce((s: number, t: any) => s + (t.d.match(/M/g) || []).length, 0) }));
  });
  expect(layers.length).toBe(2);
  const red = layers[0].color as string;
  expect(parseInt(red.slice(1, 3), 16)).toBeGreaterThan(parseInt(red.slice(3, 5), 16) + 60);
  expect(layers[1].n).toBeGreaterThan(40); // letters, counters of O/Q/P/B/R, the ring and its hole

  // Tap empty paper: the placed scan locks itself and the lasso can't grab it any more.
  await pen(page, [
    [1200, 760],
    [1200, 760],
  ]);
  expect(await page.evaluate(() => (window as any).sumi.view.doc.pages[0].items[0].locked)).toBe(true);
  await pen(page, [
    [40, 100],
    [1240, 100],
    [1240, 780],
    [40, 780],
    [40, 102],
  ]);
  await expect(page.getByTestId('sel-delete')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).sumi.editor.selection.active)).toBe(false);
  await page.screenshot({ path: 'test-results/scan-placed.png' });

  // Write over it with the pen.
  await page.getByTestId('tool-pen').click();
  await pen(page, [
    [400, 400],
    [500, 420],
    [600, 400],
  ]);
  info = await docInfo(page);
  expect(info.pages[0].strokes.length).toBe(1);

  // Exported PDF: the scan stays vector (no image XObject on the page).
  await page.getByTestId('more').click();
  await page.getByText('PDFで書き出し / 共有').click();
  const dl = page.waitForEvent('download');
  await page.getByTestId('do-export').click();
  const out = await PDFDocument.load(readFileSync(await (await dl).path()));
  expect(out.getPageCount()).toBe(1);
  const xobj = out.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'));
  expect(xobj instanceof PDFDict ? xobj.keys().length : 0).toBe(0);
});

test('スキャン → 新しいノート（ベクターPDF）', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await scanThroughDialog(page, 'lib-scan');
  await page.getByTestId('scan-notebook').click();
  await page.waitForFunction(() => (window as any).sumi?.view?.doc?.pages?.[0]?.pdf, null, { timeout: 30000 });
  const info = await page.evaluate(() => {
    const p = (window as any).sumi.view.doc.pages;
    return { n: p.length, w: Math.round(p[0].w), h: Math.round(p[0].h) };
  });
  expect(info.n).toBe(1);
  expect(info.w).toBe(794); // A4 width
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/scan-notebook.png' });
});

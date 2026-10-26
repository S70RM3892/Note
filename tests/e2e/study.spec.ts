import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, PDFHexString, PDFName, StandardFonts, degrees, rgb } from 'pdf-lib';
import { docInfo, flush, line, newNotebook, pageToScreen, pen, wave } from './helpers';

async function makePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([595, 842]);
  p1.drawText('Problem 1: integrate x^2', { x: 60, y: 760, size: 22, font, color: rgb(0, 0, 0) });
  const p2 = doc.addPage([595, 842]);
  p2.setRotation(degrees(90));
  p2.drawText('Rotated page', { x: 60, y: 760, size: 22, font });
  return Buffer.from(await doc.save());
}

/** Three pages and two bookmarks (chapter 2 → page 3). */
async function makePdfWithOutline(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const pages = [doc.addPage([595, 842]), doc.addPage([595, 842]), doc.addPage([595, 842])];
  const ctx = doc.context;
  const root = ctx.nextRef(), a = ctx.nextRef(), b = ctx.nextRef();
  ctx.assign(a, ctx.obj({ Title: PDFHexString.fromText('第1章 微分'), Parent: root, Next: b, Dest: [pages[0].ref, 'XYZ', null, null, null] }));
  ctx.assign(b, ctx.obj({ Title: PDFHexString.fromText('第2章 積分'), Parent: root, Prev: a, Dest: [pages[2].ref, 'XYZ', null, null, null] }));
  ctx.assign(root, ctx.obj({ Type: 'Outlines', First: a, Last: b, Count: 2 }));
  doc.catalog.set(PDFName.of('Outlines'), root);
  return Buffer.from(await doc.save());
}

async function importPdf(page: Page, bytes: Buffer, pages = 2) {
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-pdf').click();
  await (await chooser).setFiles({ name: 'kakomon.pdf', mimeType: 'application/pdf', buffer: bytes });
  await page.waitForFunction((n) => (window as any).sumi?.view?.doc?.pages?.length === n, pages, { timeout: 20000 });
}

test('PDF bookmarks become a table of contents', async ({ page }) => {
  await importPdf(page, await makePdfWithOutline(), 3);
  await page.getByTestId('page-pill').click();
  const items = page.getByTestId('toc').locator('.toc-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toContainText('第2章 積分');
  await items.nth(1).click();
  await expect(page.getByTestId('page-pill')).toHaveText(/3 \/ 3/);
});

/** Average colour of a small screen region, read back from a screenshot. */
async function sample(page: Page, x: number, y: number, r = 3): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x: x - r, y: y - r, width: r * 2, height: r * 2 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let R = 0, G = 0, B = 0;
    for (let i = 0; i < d.length; i += 4) {
      R += d[i];
      G += d[i + 1];
      B += d[i + 2];
    }
    const n = d.length / 4;
    return [R / n, G / n, B / n] as [number, number, number];
  }, png.toString('base64'));
}

test('PDF import (incl. rotated page), annotate, export keeps pages', async ({ page }) => {
  await importPdf(page, await makePdf());
  const sizes = await page.evaluate(() => (window as any).sumi.view.doc.pages.map((p: any) => [Math.round(p.w), Math.round(p.h)]));
  expect(sizes).toEqual([
    [793, 1123],
    [1123, 793],
  ]);
  await page.waitForTimeout(1500); // pdf.js render
  await page.screenshot({ path: 'test-results/pdf.png' });
  // The PDF text is rendered (dark pixels near the title).
  const [tx, ty] = await pageToScreen(page, 0, 80 * (96 / 72) + 10, (842 - 760) * (96 / 72) - 8);
  const c = await sample(page, tx, ty, 6);
  expect(Math.min(...c)).toBeLessThan(200);
  await pen(page, wave(300, 400, 300));
  expect((await docInfo(page)).pages[0].strokes.length).toBe(1);

  await page.getByTestId('more').click();
  await page.getByText('PDFで書き出し / 共有').click();
  const dl = page.waitForEvent('download');
  await page.getByTestId('do-export').click();
  const file = await (await dl).path();
  const out = await PDFDocument.load(readFileSync(file));
  expect(out.getPageCount()).toBe(2);
  const [w, h] = [out.getPage(1).getWidth(), out.getPage(1).getHeight()];
  expect(Math.round(w)).toBe(842);
  expect(Math.round(h)).toBe(595);

  // Full-text search finds the PDF's own text and jumps to the page.
  await page.getByTestId('back').click();
  await page.getByPlaceholder('ノートを検索').fill('rotated');
  const hit = page.getByTestId('search-results').locator('.search-hit');
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText('p.2');
  await hit.click();
  await page.waitForFunction(() => (window as any).sumi?.view?.doc);
  await expect(page.getByTestId('page-pill')).toHaveText(/2 \/ 2/);
});

test('red sheet hides orange answers but not black ink', async ({ page }) => {
  await newNotebook(page);
  // Black stroke and orange stroke.
  await pen(page, line(300, 420, 600, 420, 40, 0.9));
  await page.locator('[data-testid=color][aria-label="色 #ff6a00"]').click();
  await pen(page, line(300, 480, 600, 480, 40, 0.9));
  await page.waitForTimeout(300);
  await page.getByTestId('red-sheet-btn').click();
  const sheet = page.getByTestId('red-sheet');
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  // Move the sheet over both strokes: drag the grip.
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, 380, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const paper = await sample(page, 450, 450);
  const orange = await sample(page, 450, 480, 1);
  const black = await sample(page, 450, 420, 1);
  await page.screenshot({ path: 'test-results/redsheet.png' });
  const diff = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  expect(diff(orange, paper)).toBeLessThan(40); // vanished
  expect(diff(black, paper)).toBeGreaterThan(120); // still visible
});

test('spaced repetition: add page, review with hidden tapes, grade', async ({ page }) => {
  await newNotebook(page, '英単語');
  await pen(page, wave(300, 300, 200));
  await page.getByTestId('tool-tape').click();
  await pen(page, line(280, 300, 540, 300, 20));
  await page.evaluate(() => (window as any).sumi.editor.setAllTapes(false)); // peeled while studying
  await page.getByTestId('more').click();
  await page.getByText('このページを復習に追加').click();
  await flush(page);
  // Pretend a day has passed.
  await page.evaluate(async () => {
    const repo = (window as any).sumi.repo;
    const all = await repo.listReviews();
    for (const r of all) {
      r.state.due = Date.now() - 1000;
      await repo.saveReview(r);
    }
  });
  await page.getByTestId('back').click();
  await expect(page.getByTestId('due-count')).toContainText('1');
  await page.getByText('復習開始').click();
  await expect(page.getByTestId('grade-3')).toBeVisible();
  // The tape peeled while studying is hidden again for the review.
  expect((await docInfo(page)).pages[0].items[0].revealed).toBe(false);
  await page.screenshot({ path: 'test-results/review.png' });
  await page.getByTestId('grade-3').click();
  await page.waitForURL(/#\/$/);
  await expect(page.getByTestId('due-count')).toContainText('0');
  const due = await page.evaluate(async () => (await (window as any).sumi.repo.listReviews())[0].state);
  expect(due.reps).toBe(1);
  expect(due.due).toBeGreaterThan(Date.now());
});

test('exam timer presets and countdown', async ({ page }) => {
  await page.goto('/');
  await page.getByText('タイマーを出す').click();
  await page.getByText('京大 数学 150′').click();
  await expect(page.getByTestId('timer-time')).toHaveText('2:30:00');
  await page.getByTestId('timer-toggle').click();
  await page.waitForTimeout(2300);
  await expect(page.getByTestId('timer-time')).toHaveText(/2:29:5[6-8]/);
  // Survives a reload (state persisted).
  await page.reload();
  await expect(page.getByTestId('timer-time')).toHaveText(/2:29:5\d/);
});

test('backup round trip restores a deleted notebook', async ({ page }) => {
  await newNotebook(page, 'バックアップ対象');
  await pen(page, wave(300, 300, 300));
  await flush(page);
  await page.getByTestId('back').click();
  await page.getByLabel('メニュー', { exact: true }).click();
  const dl = page.waitForEvent('download');
  await page.getByText('バックアップを書き出す').click();
  const path = await (await dl).path();
  // Delete it for good.
  await page.evaluate(async () => {
    const repo = (window as any).sumi.repo;
    for (const nb of await repo.listNotebooks()) await repo.deleteNotebook(nb.id);
  });
  await page.reload();
  await expect(page.getByTestId('notebook')).toHaveCount(0);
  await page.getByLabel('メニュー', { exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('バックアップ / .sumi を取り込む').click();
  await (await chooser).setFiles(path);
  await expect(page.getByTestId('notebook')).toHaveCount(1);
  await page.getByTestId('notebook').click();
  await page.waitForFunction(() => !!(window as any).sumi?.view?.doc);
  expect((await docInfo(page)).pages[0].strokes.length).toBe(1);
});

test.describe('offline', () => {
  test.use({ serviceWorkers: 'allow' });
  test('works offline after the first visit', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForFunction(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return !!r?.active;
    }, null, { timeout: 30000 });
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('new-notebook')).toBeVisible();
    await page.getByTestId('new-notebook').click();
    await page.getByTestId('create-notebook').click();
    await page.waitForFunction(() => !!(window as any).sumi?.view?.doc);
    await pen(page, wave(300, 300, 300));
    expect((await docInfo(page)).pages[0].strokes.length).toBe(1);
  });
});

test('入試カウントダウン and the 原稿用紙 / 英語4線 templates', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-26T20:00:00+09:00'));
  await page.goto('/');
  const cd = page.getByTestId('countdown');
  await expect(cd).toContainText('共通テスト');
  await expect(cd).toContainText('82日');
  await expect(cd).toContainText('京大 二次');
  await expect(cd).toContainText('122日');
  await page.screenshot({ path: 'test-results/countdown.png' });

  for (const [title, label] of [
    ['作文', '原稿用紙 400字'],
    ['英作文', '英語4線'],
  ]) {
    await page.goto('/');
    await page.getByTestId('new-notebook').click();
    await page.getByTestId('nb-title').fill(title);
    await page.getByText(label, { exact: true }).click();
    if (label.startsWith('原稿')) await page.getByText('A4 横', { exact: true }).click();
    await page.getByTestId('create-notebook').click();
    await page.waitForFunction(() => !!(window as any).sumi?.view?.doc);
    await page.waitForTimeout(500);
    const tpl = await page.evaluate(() => (window as any).sumi.view.doc.pages[0].bg.tpl);
    expect(tpl).toBe(label.startsWith('原稿') ? 'genkou' : 'english');
    await page.screenshot({ path: `test-results/tpl-${tpl}.png` });
  }
});

test('まちがいノート: lasso a problem on a PDF (region) or ink (selection), copy a PDF figure, tape a region', async ({ page }) => {
  test.setTimeout(90_000);
  await importPdf(page, await makePdf());
  await page.waitForTimeout(1200);
  await page.getByTestId('tool-lasso').click();
  // Lasso around the PDF's title: nothing selectable there → region menu.
  const [x0, y0] = await pageToScreen(page, 0, 60, 70);
  const [x1, y1] = await pageToScreen(page, 0, 560, 140);
  await pen(page, [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0 + 2],
  ]);
  await expect(page.getByTestId('region-mistake')).toBeVisible();
  await page.screenshot({ path: 'test-results/region-menu.png' });
  await page.getByTestId('region-mistake').click();
  await expect(page.getByText('まちがいノートに追加した')).toBeVisible({ timeout: 15000 });

  // Then some ink, selected with the lasso → also to the まちがいノート (kept as vectors).
  await page.getByTestId('tool-pen').click();
  await pen(page, wave(300, 400, 300));
  await page.getByTestId('tool-lasso').click();
  await pen(page, [
    [260, 340],
    [660, 340],
    [660, 470],
    [260, 470],
    [260, 342],
  ]);
  await page.getByTestId('sel-mistake').click();
  await expect(page.getByText('まちがいノートに追加した')).toBeVisible({ timeout: 15000 });

  const cards = await page.evaluate(async () => {
    const app = (window as any).sumi;
    const nbs = await app.repo.listNotebooks();
    const nb = nbs.find((n: any) => n.title === 'まちがいノート');
    const pages = await app.repo.loadPages(nb);
    const reviews = await app.repo.listReviews();
    return pages.map((p: any) => ({
      images: p.items.filter((i: any) => i.type === 'image').map((i: any) => ({ locked: !!i.locked, w: Math.round(i.w) })),
      texts: p.items.filter((i: any) => i.type === 'text').map((i: any) => i.text),
      strokes: p.strokes.length,
      review: reviews.some((r: any) => r.id === p.id),
    }));
  });
  expect(cards).toHaveLength(2);
  expect(cards[0].images).toEqual([{ locked: true, w: expect.any(Number) }]);
  expect(cards[0].images[0].w).toBeGreaterThan(500);
  expect(cards[0].texts[0]).toMatch(/^kakomon +p\.1 /);
  expect(cards[0].texts).toContain('▼ 解き直し');
  expect(cards[0].strokes).toBe(0);
  expect(cards[1].strokes).toBe(1);
  expect(cards[1].images).toHaveLength(1); // the PDF under the ink
  expect(cards.every((c) => c.review)).toBe(true);

  // 画像でコピー → paste on page 2.
  await pen(page, [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0 + 2],
  ]);
  await page.getByTestId('region-copy').click();
  await expect(page.getByText('コピーした')).toBeVisible({ timeout: 15000 });
  // テープで隠す on the same area.
  await pen(page, [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0 + 2],
  ]);
  await page.getByTestId('region-tape').click();
  expect((await docInfo(page)).pages[0].items.filter((i) => i.type === 'tape')).toHaveLength(1);

  // Open the まちがいノート and look at the first card.
  await page.getByTestId('back').click();
  await page.getByText('まちがいノート', { exact: true }).first().click();
  await page.waitForFunction(() => (window as any).sumi?.view?.doc?.nb?.title === 'まちがいノート');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/mistake-card.png' });
});

test('大問ラップ: split times per question, saved with the exam log', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-26T19:00:00+09:00') });
  await page.goto('/');
  await page.getByText('タイマーを出す').click();
  await page.getByText('京大 数学 150′').click();
  await page.getByTestId('timer-toggle').click();
  await page.clock.runFor(3 * 60_000);
  await page.getByTestId('timer-lap').click();
  await page.clock.runFor(4 * 60_000 + 30_000);
  await page.getByTestId('timer-lap').click();
  await page.clock.runFor(60_000);
  const rows = page.locator('.timer-laps .lap-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('3:00');
  await expect(rows.nth(1)).toContainText('4:30');
  await expect(rows.nth(2)).toContainText('1:00');
  // Reset logs the exam with its splits.
  await page.locator('.timer button[aria-label="リセット"]').click();
  const log = await page.evaluate(() => (window as any).sumi.stats.data.exams[0]);
  expect(log.label).toBe('京大 数学');
  // The installed clock also moves with real time between the clicks: allow a few seconds.
  expect(log.laps).toHaveLength(3);
  [180, 270, 60].forEach((sec, i) => expect(Math.abs(log.laps[i] - sec)).toBeLessThan(3));
  // Wait until the log is in IndexedDB (a reload right away can abort the write).
  await expect.poll(() => page.evaluate(async () => (await (window as any).sumi.repo.loadStats()).exams[0]?.laps?.length ?? 0)).toBe(3);
  await page.reload();
  await expect(page.getByTestId('exam-log')).toContainText('大問 3/5/1分');
});

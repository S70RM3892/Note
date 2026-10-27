import { expect, test, type Page } from '@playwright/test';
import { line, newNotebook, pageToScreen, pen } from './helpers';

const pages = (page: Page) => page.evaluate(() => (window as any).sumi.view.doc.pages.map((p: any) => ({ problem: p.problem, result: p.result, days: p.days, items: p.items.map((i: any) => i.text) })));

async function newProblemBook(page: Page, title: string, count: number) {
  await page.goto('/');
  await page.getByTestId('new-notebook').click();
  await page.getByTestId('nb-title').fill(title);
  await page.getByTestId('nb-kind').getByRole('button', { name: '問題集（問題ごとにボード）' }).click();
  await page.getByTestId('nb-problems').fill(String(count));
  await page.getByRole('button', { name: '問1', exact: true }).click();
  await expect(page.getByTestId('nb-problem-preview')).toContainText(`問1 〜 問${count}（${count}問`);
  await page.getByTestId('create-notebook').click();
  await page.waitForFunction(() => !!(window as any).sumi?.view?.doc);
}

/** Scroll the bottom of page `i` into view. */
async function toBottomOf(page: Page, i: number) {
  await page.evaluate((i) => {
    const ed = (window as any).sumi.editor;
    const r = ed.vp.rects[i];
    ed.vp.camY = r.y + r.h - ed.vp.height / ed.vp.zoom + 40;
    ed.vp.clampCamera();
    ed.renderer.request();
  }, i);
}

test('問題集: one board per problem, pick a problem, ○△×, more pages for one problem', async ({ page }) => {
  await newProblemBook(page, '新演習 数学', 30);
  let ps = await pages(page);
  expect(ps).toHaveLength(30);
  expect(ps[4]).toMatchObject({ problem: '問5', items: ['問5'] });
  await expect(page.getByTestId('page-pill')).toHaveText('問1（1/30）');
  await expect(page.getByTestId('result-o')).toBeVisible();

  // Pick 問5 from the board picker.
  await page.getByTestId('page-pill').click();
  await expect(page.getByTestId('prob-cell')).toHaveCount(30);
  await page.getByTestId('prob-cell').filter({ hasText: '問5' }).first().click();
  await expect(page.getByTestId('page-pill')).toHaveText('問5（5/30）');
  await pen(page, line(300, 300, 600, 320));

  // × puts it in the review; again clears the mark.
  await page.getByTestId('result-x').click();
  await expect(page.getByTestId('result-x')).toHaveClass(/on/);
  expect(await page.evaluate(() => (window as any).sumi.view.reviewIds.size)).toBe(1);

  // + adds a page to 問5, writing at the bottom of 問5's last page adds another.
  await page.getByTestId('add-page').click();
  await expect(page.getByTestId('page-pill')).toHaveText('問5（5/30）');
  await toBottomOf(page, 5);
  const [x, y] = await pageToScreen(page, 5, 300, 1070);
  await pen(page, line(x, y, x + 120, y));
  ps = await pages(page);
  expect(ps).toHaveLength(32);
  expect(ps.slice(4, 8).map((p: any) => p.problem)).toEqual(['問5', '問5', '問5', '問6']);
  expect(ps[5].items).toEqual([]); // the heading is on the first board only

  // The picker: 3 pages for 問5, filters.
  await page.getByTestId('page-pill').click();
  const p5 = page.getByTestId('prob-cell').filter({ hasText: /^問5/ });
  await expect(p5).toContainText('×');
  await expect(p5).toContainText('3枚');
  await expect(page.getByTestId('prob-summary')).toContainText('× 1');
  await page.getByTestId('prob-filter-x').click();
  await expect(page.getByTestId('prob-cell')).toHaveCount(1);
  await page.getByTestId('prob-filter-todo').click();
  await expect(page.getByTestId('prob-cell')).toHaveCount(29);
  await page.getByTestId('prob-filter-all').click();
  await page.screenshot({ path: 'test-results/problem-picker.png' });
  await page.keyboard.press('Escape');

  // The library card shows the tally.
  await page.getByTestId('back').click();
  await expect(page.getByTestId('nb-results')).toHaveText('○0 △0 ×1');
});

test('日付順: pages under the days they were written, newest or oldest first', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-25T20:00:00+09:00') });
  await newNotebook(page, '数学 ノート');
  await pen(page, line(300, 300, 600, 300)); // p.1 on 10/25
  await page.getByTestId('add-page').click();
  await page.clock.setSystemTime(new Date('2026-10-27T08:00:00+09:00'));
  await pen(page, line(300, 300, 600, 300)); // p.2 on 10/27
  expect((await pages(page)).map((p: any) => p.days)).toEqual([['2026-10-25'], ['2026-10-27']]);
  await page.getByTestId('page-pill').click();
  await page.getByTestId('page-sort-new').click();
  await expect(page.getByTestId('date-head')).toHaveText(['10/27(火) 1ページ', '10/25(日) 1ページ']);
  await page.getByTestId('page-sort-old').click();
  await expect(page.getByTestId('date-head').first()).toContainText('10/25');
  // Tapping a page under a date goes there.
  await page.locator('.page-thumb').last().click();
  await expect(page.getByTestId('page-pill')).toHaveText('2 / 2');
});

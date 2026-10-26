import { expect, test, type Page } from '@playwright/test';
import { docInfo, line, newNotebook, pen, wave } from './helpers';

const strokes = (page: Page) => page.evaluate(() => (window as any).sumi.view.doc.pages[0].strokes.map((s: any) => ({ width: s.width, locked: !!s.locked })));
const texts = (page: Page) => page.evaluate(() => (window as any).sumi.view.doc.pages[0].items.filter((i: any) => i.type === 'text').map((i: any) => i.text as string));

async function more(page: Page, item: string | RegExp) {
  await page.getByTestId('more').click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('解き直し: the page goes blank, the old answer can be laid over it, undo brings it back', async ({ page }) => {
  await newNotebook(page);
  await pen(page, wave(300, 300, 300));
  await pen(page, line(300, 420, 600, 420));
  await more(page, '白紙にして解き直す');
  expect(await strokes(page)).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).sumi.view.doc.pages[0].prev.strokes.length)).toBe(2);
  await pen(page, wave(300, 320, 300)); // the new attempt
  await more(page, '前回の解答を薄く重ねる');
  expect(await page.evaluate(() => (window as any).sumi.editor.showPrev)).toBe(true);
  await page.screenshot({ path: 'test-results/retry-overlay.png' });
  await more(page, '前回の解答を隠す');
  expect(await page.evaluate(() => (window as any).sumi.editor.showPrev)).toBe(false);
  // Undo the new attempt, then the clearing: the first answer is back.
  await page.getByTestId('undo').click();
  await page.getByTestId('undo').click();
  expect(await strokes(page)).toHaveLength(2);
  expect(await page.evaluate(() => (window as any).sumi.view.doc.pages[0].prev)).toBeUndefined();
});

test('しおり from every notebook in the library, one tap to the page', async ({ page }) => {
  await newNotebook(page, '物理 力学');
  await page.getByTestId('add-page').click();
  await page.getByTestId('mark-btn').click(); // page 2
  await page.getByTestId('back').click();
  const card = page.getByTestId('lib-marks');
  await expect(card.getByTestId('lib-mark')).toHaveCount(1);
  await expect(card).toContainText('物理 力学 p.2');
  await card.getByTestId('lib-mark').click();
  await page.waitForFunction(() => (window as any).sumi?.view?.doc?.nb?.title === '物理 力学');
  await expect(page.getByTestId('page-pill')).toHaveText('2 / 2');
  // Removing the bookmark removes it from the library.
  await page.getByTestId('mark-btn').click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('lib-marks')).toHaveCount(0);
});

test('ポモドーロ: 25 minutes of focus, a 5 minute break, then the next round by itself', async ({ page }) => {
  await page.clock.install();
  await newNotebook(page);
  await page.getByTestId('timer-btn').click();
  await page.getByRole('button', { name: 'ポモドーロ 25′' }).click();
  await expect(page.getByTestId('timer-label')).toContainText('集中 第1回');
  await page.getByTestId('timer-toggle').click();
  await page.getByTestId('timer-time').click(); // open the docked timer again
  await page.clock.fastForward('25:01');
  await expect(page.getByText(/集中 第1回 おわり/)).toBeVisible();
  await expect(page.getByTestId('timer-label')).toContainText('休憩');
  await page.clock.fastForward('05:01');
  await expect(page.getByTestId('timer-label')).toContainText('集中 第2回');
  await expect(page.getByTestId('timer-label')).toContainText('今日1回');
});

test('六角方眼 and マークシート templates', async ({ page }) => {
  for (const [label, tpl] of [
    ['六角方眼（構造式）', 'hex'],
    ['マークシート', 'marksheet'],
  ] as const) {
    await page.goto('/');
    await page.getByTestId('new-notebook').click();
    await page.getByTestId('nb-title').fill(label);
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.getByTestId('create-notebook').click();
    await page.waitForFunction(() => !!(window as any).sumi?.view?.doc);
    expect(await page.evaluate(() => (window as any).sumi.view.doc.pages[0].bg.tpl)).toBe(tpl);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/template-${tpl}.png` });
  }
});

test('学習記録 and 過去問ログ as CSV', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).sumi?.stats);
  await page.evaluate(() => {
    const s = (window as any).sumi.stats;
    s.data.days['2026-10-26'] = 3600;
    s.addExam('京大 数学', 9000, 7920, [1500, 1860]);
  });
  await page.reload();
  const read = async (testid: string) => {
    const dl = page.waitForEvent('download');
    await page.getByTestId(testid).click();
    const d = await dl;
    const chunks: Buffer[] = [];
    for await (const c of (await d.createReadStream())!) chunks.push(c as Buffer);
    return { name: d.suggestedFilename(), text: Buffer.concat(chunks).toString('utf8') };
  };
  const study = await read('study-csv');
  expect(study.name).toMatch(/^sumi-study-\d{8}\.csv$/);
  expect(study.text).toContain('2026-10-26,60');
  const exams = await read('exam-csv');
  expect(exams.text).toContain('京大 数学,150,132,25 / 31');
});

test('日付スタンプ, 太さ変更, and the exam result written on the page with its pacing guide', async ({ page }) => {
  await page.clock.install();
  await newNotebook(page);
  // 日付スタンプ
  await more(page, '今日の日付を入れる');
  expect((await texts(page))[0]).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2}\([日月火水木金土]\)$/);
  // 太さ: lasso a stroke, make it thick
  await pen(page, line(300, 400, 600, 400));
  await page.getByTestId('tool-lasso').click();
  await pen(page, [
    [280, 370],
    [620, 370],
    [620, 430],
    [280, 430],
    [280, 370],
  ]);
  await page.getByTestId('sel-width').click();
  await page.getByTestId('sel-widths').getByRole('button', { name: '太', exact: true }).click();
  expect((await strokes(page))[0].width).toBe(3);
  await page.getByTestId('tool-pen').click();
  // 過去問タイマー: 京大 数学 in 6 大問 → 23:20 each (10 minutes kept for checking).
  await page.getByTestId('timer-btn').click();
  await page.getByRole('button', { name: '京大 数学 150′' }).click();
  await page.getByTestId('timer-q6').click();
  await page.getByTestId('timer-toggle').click();
  await page.getByTestId('timer-time').click();
  await expect(page.getByTestId('timer-pace')).toContainText('大問1 目安 23:20');
  await page.clock.fastForward('24:00');
  await expect(page.getByTestId('timer-pace')).toHaveClass(/over/);
  await expect(page.getByTestId('timer-pace')).toContainText('超過');
  await page.getByTestId('timer-lap').click();
  await expect(page.getByTestId('timer-pace')).toContainText('大問2');
  await page.getByTestId('timer-stamp').click();
  const t = await texts(page);
  expect(t.some((x) => /京大 数学 {2}2\d分 \/ 150分 {2}大問 24 \/ 0分/.test(x))).toBe(true);
  expect((await docInfo(page)).pages[0].items.length).toBe(2);
});

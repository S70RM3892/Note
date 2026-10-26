import { expect, test, type Page } from '@playwright/test';
import { line, newNotebook, pen } from './helpers';

const hub = (page: Page) => page.evaluate(() => (window as any).sumi.hub.get());

async function openTool(page: Page, id: string) {
  await page.goto('/#/hub');
  await page.getByTestId(`hub-tile-${id}`).click();
  await expect(page.getByTestId(`hub-${id}`)).toBeVisible();
}

async function answerPrompt(page: Page, value: string) {
  const input = page.locator('.modal input').last();
  await input.fill(value);
  await page.locator('.modal').last().getByRole('button', { name: 'OK' }).click();
}

test('受験ハブ from the library; 合格点シミュレーター converts 共通テスト to 225 and says what 二次 needs', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-hub').click();
  await expect(page.getByTestId('hub')).toBeVisible();
  await expect(page.locator('.hub-tile')).toHaveCount(19); // Android 連携 only in the APK
  await page.getByTestId('hub-tile-score').click();
  const scores: [string, number][] = [
    ['kokugo', 160],
    ['chireki', 80],
    ['mathIA', 95],
    ['mathIIBC', 85],
    ['sci1', 90],
    ['sci2', 80],
    ['engR', 90],
    ['engL', 80],
    ['info', 90],
  ];
  for (const [id, v] of scores) await page.getByTestId(`k-${id}`).fill(String(v));
  await expect(page.getByTestId('kyotsu-total')).toHaveText('191.25 / 225');
  // 令和7年度の最低点 707.52 − 191.25 = 516.27 → 517点
  await expect(page.getByTestId('score-need')).toContainText('517点 / 800');
  await page.getByTestId('n-math').fill('150');
  await expect(page.getByTestId('score-total')).toHaveText('341.25');
  await page.screenshot({ path: 'test-results/hub-score.png' });
  // Saved, and summarised on the tile.
  await page.getByTestId('hub-back').click();
  await expect(page.getByTestId('hub-tile-score')).toContainText('共通 191.3/225');
  await page.reload();
  await page.getByTestId('hub-tile-score').click();
  await expect(page.getByTestId('k-kokugo')).toHaveValue('160');
});

test('プログラム表記: the 例示 program runs with its input, a trace table, and errors point at the line', async ({ page }) => {
  await openTool(page, 'program');
  await page.getByTestId('dncl-run').click();
  await expect(page.getByTestId('dncl-out')).toHaveText('0～99の数字を入力してください\n52は5番目にありました');
  const rows = page.getByTestId('dncl-trace').locator('tr');
  expect(await rows.count()).toBeGreaterThan(10);
  await expect(page.getByTestId('dncl-trace')).toContainText('→ 真（繰り返す）');
  await page.getByTestId('dncl-input').fill('85');
  await page.getByTestId('dncl-run').click();
  await expect(page.getByTestId('dncl-out')).toContainText('85は見つかりませんでした');
  await page.screenshot({ path: 'test-results/hub-program.png', fullPage: true });
  await page.getByTestId('dncl-code').fill('x = 1\ny = z + 1');
  await page.getByTestId('dncl-run').click();
  await expect(page.getByTestId('dncl-result')).toContainText('2行目: 変数 z にまだ値が入っていない');
  await expect(page.locator('.code-gutter .err')).toHaveText('2');
});

test('模試: record two, see the trend, the weakest subject and the 京大換算', async ({ page }) => {
  await openTool(page, 'mocks');
  for (const [name, date, base] of [
    ['第1回 共通テスト模試', '2026-06-14', 60],
    ['第2回 共通テスト模試', '2026-09-20', 80],
  ] as const) {
    await page.getByTestId('mock-add').click();
    await page.getByTestId('mock-name').fill(name);
    await page.locator('.modal input[type=date]').fill(date);
    for (let i = 0; i < 9; i++) await page.getByTestId(`mock-score-${i}`).fill(String(i === 0 ? base * 2 : base));
    await page.getByTestId('mock-save').click();
  }
  await expect(page.getByTestId('mock-row')).toHaveCount(2);
  await expect(page.getByTestId('mock-row').first()).toContainText('第2回');
  await expect(page.getByTestId('mock-row').first()).toContainText('800/1000（80%）');
  await expect(page.getByTestId('mock-row').first()).toContainText('京大換算 180/225');
  await expect(page.locator('.line-chart')).toHaveCount(1);
});

test('入試日程: a slot sets the exam timer to the real length; 持ち物 ticks survive a reload', async ({ page }) => {
  await openTool(page, 'schedule');
  const niji = page.getByTestId('sched-event').filter({ hasText: '京大 個別学力検査 1日目' });
  await niji.getByTestId('slot-timer').nth(1).click();
  await expect(page.getByTestId('timer-label')).toContainText('京大 数学');
  await expect(page.getByTestId('timer-time')).toHaveText('2:30:00');
  await page.locator('.timer').getByRole('button', { name: '閉じる' }).click();

  await openTool(page, 'checklist');
  await page.getByTestId('check-item').nth(0).locator('input').check();
  await page.getByTestId('check-item').nth(2).locator('input').check();
  await page.getByTestId('check-new').fill('予備の時計');
  await page.getByTestId('check-new').press('Tab');
  await page.locator('[data-testid=check-new] + button').click();
  await expect(page.getByTestId('check-count')).toHaveText('2 / 10');
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.getByTestId('check-count')).toHaveText('2 / 10');
  await expect(page.getByTestId('check-item').last()).toContainText('予備の時計');
});

test('参考書: the daily amount for the deadline and the pace; 過去問の表; 振り返り goes to 今日やること', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-26T20:00:00+09:00'));
  await openTool(page, 'books');
  await page.getByTestId('book-add').click();
  await page.getByTestId('book-title').fill('青チャート 数学Ⅲ');
  await page.getByTestId('book-total').fill('300');
  await page.getByTestId('book-done').fill('100');
  await page.getByTestId('book-deadline').fill('2026-11-30');
  await page.getByTestId('book-save').click();
  await expect(page.getByTestId('book-plan')).toContainText('100 / 300問（残り200問）');
  await expect(page.getByTestId('book-plan')).toContainText('11/30(月)まで36日 → 1日 5.6問');
  for (let i = 0; i < 3; i++) await page.getByTestId('book-plus1').click();
  await expect(page.getByTestId('book-plan')).toContainText('103 / 300問');
  await expect(page.getByTestId('book-plan')).toContainText('最近のペース 1日 3問');

  await openTool(page, 'past');
  await page.getByTestId('past-s0-2025').click();
  await answerPrompt(page, '80');
  await expect(page.getByTestId('past-s0-2025')).toHaveText('80');
  await expect(page.getByTestId('past-s0-2025')).toHaveClass(/good/);
  await expect(page.getByTestId('past-grid')).toContainText('80%（1年分）');

  await openTool(page, 'reflect');
  await page.getByTestId('reflect-good').fill('数学 第2問 完答');
  await page.getByTestId('reflect-next').fill('京大 化学 2019 を通しで');
  await page.getByTestId('reflect-save').click();
  await page.getByTestId('hub-back').click();
  await page.getByTestId('hub-back').click();
  await expect(page.getByTestId('todos')).toContainText('京大 化学 2019 を通しで');
});

test('単語帳: import from a spreadsheet paste, study with grades, again cards come back', async ({ page }) => {
  await openTool(page, 'cards');
  await page.getByTestId('deck-add').click();
  await answerPrompt(page, '英単語');
  await page.getByTestId('deck-import').click();
  await page.getByTestId('cards-import').fill('abandon\t捨てる\nbenefit,利益\n"take off",離陸する');
  await page.getByTestId('cards-import-ok').click();
  await expect(page.getByTestId('deck-counts')).toContainText('全3枚');
  await page.getByTestId('deck-study').click();
  await expect(page.getByTestId('flash-front')).toHaveText('abandon');
  await page.getByTestId('flash-show').click();
  await expect(page.getByTestId('flash-back')).toHaveText('捨てる');
  await page.getByTestId('grade-1').click(); // again: comes back at the end
  for (const want of ['benefit', 'take off', 'abandon']) {
    await expect(page.getByTestId('flash-front')).toHaveText(want);
    await page.getByTestId('flash-show').click();
    await page.getByTestId('grade-3').click();
  }
  await expect(page.getByTestId('study-done')).toBeVisible();
  const s = await hub(page);
  expect(Object.values(s.cardLog)).toEqual([4]);
});

test('まちがいノート asks why; ミス分析 counts it. 質問リスト from the page menu', async ({ page }) => {
  await newNotebook(page, '数学 演習');
  await pen(page, line(300, 300, 600, 300));
  await page.getByTestId('tool-lasso').click();
  await pen(page, [
    [280, 270],
    [620, 270],
    [620, 330],
    [280, 330],
    [280, 270],
  ]);
  await page.getByTestId('sel-mistake').click();
  await page.getByTestId('mistake-kind').getByRole('button', { name: '計算ミス' }).click();
  await expect.poll(async () => (await hub(page)).mistakes.length).toBe(1);
  await page.getByTestId('tool-pen').click();
  await page.getByTestId('more').click();
  await page.getByRole('menuitem', { name: '質問リストに入れる' }).click();
  await answerPrompt(page, '(2) の場合分けの理由');
  await openTool(page, 'mistakes');
  await expect(page.getByTestId('mistake-kinds')).toContainText('計算ミス');
  await expect(page.getByTestId('mistake-kinds')).toContainText('1（100%）');
  await openTool(page, 'questions');
  await expect(page.getByTestId('question')).toContainText('(2) の場合分けの理由');
  await expect(page.getByTestId('question')).toContainText('数学 演習 p.1');
  await page.getByTestId('question').getByRole('button', { name: 'ページへ' }).click();
  await page.waitForFunction(() => (window as any).sumi?.view?.doc?.nb?.title === '数学 演習');
});

test('睡眠: the morning question in the library, the week against 8〜10 hours; カフェイン at bedtime', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-26T07:30:00+09:00'));
  await page.goto('/');
  await expect(page.getByTestId('ask-sleep')).toBeVisible();
  await page.getByTestId('ask-bed').fill('00:30');
  await page.getByTestId('ask-wake').fill('06:30');
  await page.getByTestId('ask-sleep-save').click();
  await expect(page.getByTestId('ask-sleep')).toHaveCount(0);
  await expect(page.getByText(/6\.0時間。高校生の目安は8〜10時間/)).toBeVisible();
  await openTool(page, 'sleep');
  await expect(page.getByTestId('sleep-summary')).toContainText('6.0');
  await expect(page.getByTestId('sleep-summary')).toContainText('8〜10時間の夜：0 / 1');

  await openTool(page, 'caffeine');
  await page.getByTestId('caf-add').first().click(); // コーヒー 150ml = 90mg
  await expect(page.getByTestId('caf-now')).toContainText('90');
  // 23:00 is 15.5 hours later: 90 × 0.5^(15.5/5) ≈ 10.5
  await expect(page.getByTestId('caf-bed')).toContainText('約10mg');
});

test('仮眠タイマー rings at the end; 目の休憩 nudges after an hour of writing', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-26T13:00:00+09:00') });
  await openTool(page, 'nap');
  await page.getByTestId('nap-start').click();
  await expect(page.getByTestId('nap-time')).toHaveText(/^1[45]:\d\d$/);
  await page.clock.fastForward('15:01');
  await expect(page.getByTestId('nap-time')).toHaveText('起きろ');
  await page.getByTestId('nap-stop').click();
  await expect(page.getByTestId('nap')).toHaveCount(0);

  await newNotebook(page);
  // Write every 9 minutes or so (never 10 minutes off, which would count as a break).
  let at = 0;
  const writeAt = async (m: number) => {
    await page.clock.fastForward((m - at) * 60_000);
    at = m;
    await pen(page, line(300, 160 + m * 4, 600, 160 + m * 4));
  };
  for (const m of [0, 9, 18, 27, 31]) await writeAt(m);
  await expect(page.getByText('30分続けて書いている')).toBeVisible();
  for (const m of [40, 49, 58, 61]) await writeAt(m);
  await expect(page.getByText('1時間続けて書いた')).toBeVisible();
});

test('基数変換・論理回路 and the weekly report', async ({ page }) => {
  await openTool(page, 'radix');
  await page.getByTestId('radix-in').fill('255');
  await expect(page.getByTestId('radix-2')).toHaveText('1111 1111');
  await expect(page.getByTestId('radix-16')).toHaveText('FF');
  await page.getByTestId('twos-in').fill('-5');
  await expect(page.getByTestId('twos-out')).toHaveText('-5 → 1111 1011');
  await page.getByTestId('truth-in').fill('A and B');
  await expect(page.getByTestId('truth-out').locator('tr')).toHaveCount(5);
  await openTool(page, 'weekly');
  await expect(page.getByTestId('weekly-text')).toContainText('週間レポート');
  await expect(page.getByTestId('weekly-text')).toContainText('振り返り 0/7日');
});

import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { docInfo, line, newNotebook, pen, penHold, penLift } from './helpers';

/**
 * The Android shell (android/) exposes window.SumiNative. These tests stand in a fake
 * bridge with the same contract to check the page's side of it in Chromium.
 */
async function fakeBridge(page: Page, incoming: { url: string; name: string; mime: string }[] = []) {
  await page.addInitScript((initial) => {
    const w = window as any;
    w.__incoming = initial;
    w.__saved = [] as { name: string; mime: string; action: string; b64: string }[];
    const open = new Map<string, { name: string; mime: string; b64: string }>();
    let n = 0;
    w.SumiNative = {
      version: () => 'test',
      hasScanner: () => true,
      scanDocument: () => setTimeout(() => w.__sumiNative.onScan(JSON.stringify({ urls: [w.__scanUrl] })), 30),
      beginFile: (name: string, mime: string) => {
        const id = String(++n);
        open.set(id, { name, mime, b64: '' });
        return id;
      },
      appendFile: (id: string, b64: string) => (open.get(id)!.b64 += b64),
      finishFile: (id: string, action: string) => {
        w.__saved.push({ ...open.get(id)!, action });
        open.delete(id);
        setTimeout(() => w.__sumiNative.onFileDone(JSON.stringify({ ok: true })), 10);
      },
      openUrl: () => {},
      setKeepScreenOn: (on: boolean) => (w.__screenOn = on),
      takeIncoming: () => JSON.stringify(w.__incoming.splice(0)),
      setPenButtonAction: (a: string) => (w.__penAction = a),
      // The shell keeps the chosen folder across launches.
      backupFolder: () => localStorage.getItem('fake.backupFolder') ?? '',
      pickBackupFolder: () =>
        setTimeout(() => {
          localStorage.setItem('fake.backupFolder', 'Drive/Sumi');
          w.__sumiNative.onBackupFolder(JSON.stringify({ ok: true, name: 'Drive/Sumi' }));
        }, 20),
      setFocusLock: (on: boolean) => (w.__focus ??= []).push(on),
      setReminders: (json: string) => (w.__reminders ??= []).push(JSON.parse(json)),
      // 診断ログ: what the shell recorded (a crash from the last run, set by the test).
      diagnostics: () => JSON.stringify(w.__diag ?? []),
      clearDiagnostics: () => (w.__diag = []),
      noteDiagnostic: (kind: string, text: string) => (w.__noted ??= []).push([kind, text]),
      takeShortcut: () => {
        const t = w.__shortcut ?? '';
        w.__shortcut = '';
        return t;
      },
      notificationsAllowed: () => !!w.__notifyOk,
      // Wet ink: the test decides whether the shell "drew" the stroke (default: no).
      setWetInk: (json: string) => (w.__wet ??= []).push(JSON.parse(json)),
      // Ids by claim order; the page says where its pen went down.
      wetClaim: (x: number, y: number) => (w.__wetDraws ? (w.__claims ??= []).push([x, y]) : 0),
      wetDone: (id: number) => ((w.__wetDone = (w.__wetDone ?? 0) + 1), (w.__doneIds ??= []).push(id)),
      wetCancel: (id: number) => ((w.__wetCancel = (w.__wetCancel ?? 0) + 1), (w.__cancelIds ??= []).push(id)),
      // Fake recognizer: names a line by its stroke count ("3画") so tests can check the plumbing.
      inkStatus: () => w.__inkStatus ?? 'ready',
      inkDownload: () => setTimeout(() => ((w.__inkStatus = 'ready'), w.__sumiNative.onInkModel(JSON.stringify({ ok: true }))), 20),
      recognizeInk: (json: string) => {
        const r = JSON.parse(json);
        w.__inkCalls = (w.__inkCalls ?? 0) + 1;
        const n = r.strokes.length;
        setTimeout(() => w.__sumiNative.onInk(JSON.stringify({ id: r.id, candidates: [`${n}画のことば`, `${n}かく`] })), 5);
      },
    };
  }, incoming);
}

const back = (page: Page) => page.evaluate(() => (window as any).__sumiNative.onBack() as boolean);

test('back gesture closes menus, then leaves the notebook, then hands over to Android', async ({ page }) => {
  await fakeBridge(page);
  await newNotebook(page);
  await page.getByTestId('more').click();
  await expect(page.locator('.menu')).toBeVisible();
  expect(await back(page)).toBe(true);
  await expect(page.locator('.menu')).toBeHidden();
  await page.getByTestId('more').click();
  await page.getByText('PDFで書き出し / 共有').click();
  await expect(page.locator('.modal')).toBeVisible();
  expect(await back(page)).toBe(true);
  await expect(page.locator('.modal')).toBeHidden();
  expect(await back(page)).toBe(true);
  await expect(page.getByTestId('new-notebook')).toBeVisible();
  expect(await back(page)).toBe(false);
});

test('exported PDF goes to Android in chunks (save or share)', async ({ page }) => {
  await fakeBridge(page);
  await newNotebook(page);
  await pen(page, line(300, 300, 700, 360));
  await page.getByTestId('more').click();
  await page.getByText('PDFで書き出し / 共有').click();
  await page.getByTestId('do-export').click();
  await page.getByTestId('native-save').click();
  await expect(page.getByText('保存した')).toBeVisible();
  const saved = await page.evaluate(() => (window as any).__saved);
  expect(saved).toHaveLength(1);
  expect(saved[0].action).toBe('save');
  expect(saved[0].name).toBe('テスト.pdf');
  expect(saved[0].mime).toBe('application/pdf');
  const pdf = await PDFDocument.load(Buffer.from(saved[0].b64, 'base64'));
  expect(pdf.getPageCount()).toBe(1);
});

test('a PDF opened with the app becomes a notebook', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  doc.addPage([842, 595]);
  const url = 'data:application/pdf;base64,' + Buffer.from(await doc.save()).toString('base64');
  await fakeBridge(page, [{ url, name: '過去問 2025.pdf', mime: 'application/pdf' }]);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).sumi?.view?.doc?.pages?.length === 2, null, { timeout: 20000 });
  expect(await page.evaluate(() => (window as any).sumi.view.doc.nb.title)).toBe('過去問 2025');

  // Later "open with" while running: Android pokes onIncoming.
  await page.evaluate((u) => {
    const w = window as any;
    w.__incoming.push({ url: u, name: '二つ目.pdf', mime: 'application/pdf' });
    w.__sumiNative.onIncoming();
  }, url);
  await page.waitForFunction(() => (window as any).sumi?.view?.doc?.nb?.title === '二つ目', null, { timeout: 20000 });
});

test('native document scanner skips the crop step', async ({ page }) => {
  await fakeBridge(page);
  await newNotebook(page);
  await page.evaluate(async () => {
    // An already-cropped page, as ML Kit returns it.
    const cv = document.createElement('canvas');
    cv.width = 1000;
    cv.height = 1400;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#f6f4ee';
    ctx.fillRect(0, 0, 1000, 1400);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 90px sans-serif';
    ctx.fillText('SCAN 42', 120, 300);
    const blob: Blob = await new Promise((r) => cv.toBlob((b) => r(b!), 'image/jpeg', 0.92));
    (window as any).__scanUrl = URL.createObjectURL(blob);
  });
  await page.getByTestId('scan-btn').click();
  await page.getByTestId('scan-native').click();
  await expect(page.getByTestId('scan-info')).toContainText('図形', { timeout: 30000 });
  await expect(page.getByTestId('scan-crop')).toHaveCount(0);
  await page.getByTestId('scan-place').click();
  await page.waitForFunction(() => (window as any).sumi.view.doc.pages[0].items[0]?.type === 'scan');
});

test('S Pen side button reported by Android (while hovering) switches the stroke to the eraser', async ({ page }) => {
  await fakeBridge(page);
  await newNotebook(page);
  await pen(page, line(300, 400, 800, 400));
  const before = (await docInfo(page)).pages[0].strokes;
  expect(before).toHaveLength(1);
  await page.evaluate(() => (window as any).__sumiNative.onPenButton(true));
  await pen(page, line(550, 300, 550, 500)); // plain pen events: buttons = 1, no barrel bit
  await page.evaluate(() => (window as any).__sumiNative.onPenButton(false));
  // The (partial) eraser cut the line in two; nothing was drawn.
  let after = (await docInfo(page)).pages[0].strokes;
  expect(after).toHaveLength(2);
  expect(after.every((s) => s.id !== before[0].id)).toBe(true);
  // Button released: the pen draws again.
  await pen(page, line(300, 450, 800, 450));
  after = (await docInfo(page)).pages[0].strokes;
  expect(after).toHaveLength(3);
});

/** What Blink delivers for the APK's rewritten side-button strokes: a pen with the eraser bit. */
async function eraserStroke(page: Page, pts: [number, number][]) {
  await page.evaluate((pts) => {
    const el = (window as any).sumi.editor.el as HTMLElement;
    const ev = (type: string, [x, y]: [number, number], buttons: number, button: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'pen', clientX: x, clientY: y, buttons, button, pressure: buttons ? 0.5 : 0, bubbles: true, isPrimary: true }));
    ev('pointerdown', pts[0], 32, 5);
    for (const p of pts.slice(1)) ev('pointermove', p, 32, -1);
    ev('pointerup', pts[pts.length - 1], 0, 5);
  }, pts);
}

test('side button in the APK: the page asks for the action and erases with eraser-typed pen strokes', async ({ page }) => {
  await fakeBridge(page);
  await newNotebook(page);
  expect(await page.evaluate(() => (window as any).__penAction)).toBe('eraser');
  await pen(page, line(300, 400, 800, 400));
  const before = (await docInfo(page)).pages[0].strokes;
  expect(before).toHaveLength(1);
  await eraserStroke(page, line(550, 300, 550, 500).map(([x, y]) => [x, y] as [number, number]));
  // Partial eraser: the line is cut in two, nothing new is drawn.
  const after = (await docInfo(page)).pages[0].strokes;
  expect(after).toHaveLength(2);
  expect(after.every((s) => s.id !== before[0].id)).toBe(true);

  // Changing the setting is passed on to the shell.
  await page.evaluate(() => (window as any).sumi.settings.update({ sideButton: 'lasso' }));
  expect(await page.evaluate(() => (window as any).__penAction)).toBe('lasso');
});

test('handwriting: read in the background for search, and lasso → テキストに変換', async ({ page }) => {
  test.setTimeout(60_000);
  await fakeBridge(page);
  await newNotebook(page, '手書き');
  // Two lines: three "characters", then two.
  for (const x of [300, 340, 380]) await pen(page, line(x, 300, x + 25, 330, 6));
  for (const x of [300, 340]) await pen(page, line(x, 420, x + 25, 450, 6));
  expect((await docInfo(page)).pages[0].strokes).toHaveLength(5);

  // Library: the background reader stores the text, the search finds it.
  await page.getByTestId('back').click();
  await expect
    .poll(() => page.evaluate(async () => ((await (window as any).sumi.repo.db.getAll('pages')) as any[]).map((p) => p.ink).join('|')), { timeout: 15000 })
    .toBe('3画のことば\n2画のことば');
  await page.getByPlaceholder('ノートを検索').fill('3画のこと');
  const hit = page.getByTestId('search-results').locator('.search-hit');
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText('手書き');
  // Nothing changed → nothing is read again.
  const calls = await page.evaluate(() => (window as any).__inkCalls);
  await page.reload();
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => (window as any).__inkCalls ?? 0)).toBe(0);
  expect(calls).toBe(2);

  // Convert the first line to text.
  await page.getByText('手書き', { exact: true }).first().click();
  await page.waitForFunction(() => (window as any).sumi?.view?.doc?.pages?.[0]?.strokes?.length === 5);
  await page.getByTestId('tool-lasso').click();
  await pen(page, [
    [280, 280],
    [440, 280],
    [440, 350],
    [280, 350],
    [280, 282],
  ]);
  await page.getByTestId('sel-ocr').click();
  await expect(page.getByTestId('ocr-text')).toHaveValue('3画のことば');
  await page.getByText('3かく', { exact: true }).click();
  await expect(page.getByTestId('ocr-text')).toHaveValue('3かく');
  await page.getByTestId('ocr-replace').click();
  let info = await docInfo(page);
  expect(info.pages[0].strokes).toHaveLength(2);
  expect(info.pages[0].items.map((i) => [i.type, i.text])).toEqual([['text', '3かく']]);
  await page.screenshot({ path: 'test-results/ocr-replaced.png' });
  await page.getByTestId('undo').click();
  info = await docInfo(page);
  expect(info.pages[0].strokes).toHaveLength(5);
  expect(info.pages[0].items).toHaveLength(0);
});

test('APK: daily backup into the chosen folder; 集中モード pins the app while the exam timer runs', async ({ page }) => {
  test.setTimeout(60_000);
  await fakeBridge(page);
  await newNotebook(page, 'バックアップ対象');
  await pen(page, line(300, 300, 600, 330));
  await page.getByTestId('back').click();

  // Settings: pick the folder (turns the daily backup on), run it now.
  await page.locator('.lib-head .icon-btn').last().click();
  await page.getByText('設定', { exact: true }).click();
  await expect(page.getByTestId('backup-folder')).toContainText('未設定');
  await page.getByTestId('backup-pick').click();
  await expect(page.getByTestId('backup-folder')).toContainText('Drive/Sumi');
  await page.getByTestId('backup-now').click();
  await expect(page.getByText('バックアップした')).toBeVisible();
  let saved = await page.evaluate(() => (window as any).__saved);
  expect(saved).toHaveLength(1);
  expect(saved[0].action).toBe('backup');
  expect(saved[0].name).toMatch(/^sumi-backup-\d{8}-\d{4}\.sumi$/);
  const files = unzipSync(new Uint8Array(Buffer.from(saved[0].b64, 'base64')));
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString());
  expect(manifest.notebooks.map((n: any) => n.title)).toContain('バックアップ対象');

  // Backed up today → opening the library doesn't do it again; a day later it does.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500); // settings are saved after 300 ms
  await page.reload();
  await page.waitForTimeout(3800);
  expect(await page.evaluate(() => (window as any).sumi.settings.get().autoBackup)).toBe(true);
  expect(await page.evaluate(() => (window as any).__saved.length)).toBe(0);
  await page.evaluate(() => (window as any).sumi.settings.update({ lastAutoBackup: Date.now() - 25 * 3600_000 }));
  await page.waitForTimeout(500);
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).__saved.length), { timeout: 10000 }).toBe(1);
  saved = await page.evaluate(() => (window as any).__saved);
  expect(saved[0].action).toBe('backup');

  // 集中モード: off by default (screen stays on only); on → pinned while running.
  await page.evaluate(() => (window as any).sumi.timer.show());
  await page.getByTestId('timer-toggle').click();
  expect(await page.evaluate(() => [(window as any).__screenOn, (window as any).__focus ?? []])).toEqual([true, []]);
  await page.getByTestId('timer-toggle').click();
  expect(await page.evaluate(() => (window as any).__screenOn)).toBe(false);
  await page.evaluate(() => (window as any).sumi.settings.update({ focusPin: true }));
  await page.getByTestId('timer-toggle').click();
  await page.getByTestId('timer-toggle').click();
  expect(await page.evaluate(() => (window as any).__focus)).toEqual([false, true, false]);
});

test('low-latency wet ink: the page tells the shell where the pen draws and hands each stroke over', async ({ page }) => {
  await fakeBridge(page);
  await newNotebook(page);
  const lastParams = () => page.evaluate(() => (window as any).__wet.at(-1));
  let p = await lastParams();
  expect(p.on).toBe(true);
  expect(p.style).toBe('ballpoint');
  expect(p.dpr).toBe(2);
  const rect = await page.evaluate(() => {
    const r = (window as any).sumi.editor.el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  });
  rect.forEach((v: number, i: number) => expect(p.rect[i]).toBeCloseTo(v, 1));

  // Pixels on the page's own live layer while the pen is down.
  const liveInk = () =>
    page.evaluate(() => {
      const c = (window as any).sumi.editor.live.canvas as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    });

  // The shell drew it: the page draws nothing live, commits the stroke, then reports done.
  await page.evaluate(() => ((window as any).__wetDraws = true));
  await penHold(page, line(300, 300, 600, 330));
  expect(await liveInk()).toBe(0);
  await penLift(page, 600, 330);
  await expect.poll(() => page.evaluate(() => (window as any).__wetDone ?? 0)).toBe(1);
  expect((await docInfo(page)).pages[0].strokes).toHaveLength(1);
  // It claimed by where the pen went down (CSS px in the writing area) and finished that id.
  const claim = await page.evaluate(() => (window as any).__claims[0]);
  expect(claim[0]).toBeCloseTo(300 - rect[0], 0);
  expect(claim[1]).toBeCloseTo(300 - rect[1], 0);
  expect(await page.evaluate(() => (window as any).__doneIds)).toEqual([1]);

  // The shell didn't draw it: the page shows its own live ink and has nothing to report.
  await page.evaluate(() => ((window as any).__wetDraws = false));
  await penHold(page, line(300, 400, 600, 430));
  expect(await liveInk()).toBeGreaterThan(100);
  await penLift(page, 600, 430);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as any).__wetDone)).toBe(1);

  // Snapping to a shape takes the wet stroke away (the shape preview is the page's).
  await page.evaluate(() => ((window as any).__wetDraws = true));
  await pen(page, line(300, 500, 700, 500), { holdMs: 700 });
  expect(await page.evaluate(() => (window as any).__wetCancel)).toBe(1);
  expect(await page.evaluate(() => (window as any).__cancelIds)).toEqual([2]);
  // A pen-down off the paper (on the grey desk) is dropped too.
  const desk = await page.evaluate(() => {
    const ed = (window as any).sumi.editor;
    const r = ed.vp.rects[0];
    return [ed.vp.toScreenX(r.x) / 2 + 4, 400];
  });
  await pen(page, [
    [desk[0], desk[1]],
    [desk[0] + 3, desk[1] + 30],
  ]);
  expect(await page.evaluate(() => (window as any).__wetCancel)).toBe(2);

  // Off while a menu is open and for other tools; follows the zoom.
  await page.getByTestId('more').click();
  await expect.poll(async () => (await lastParams()).on).toBe(false);
  await page.mouse.click(150, 700); // outside the menu: closes it
  await expect(page.locator('.popover-layer')).toHaveCount(0);
  await expect.poll(async () => (await lastParams()).on).toBe(true);
  await page.getByTestId('tool-highlighter').click();
  await expect.poll(async () => (await lastParams()).on).toBe(false);
  await page.getByTestId('tool-pen').click();
  await page.evaluate(() => (window as any).sumi.editor.setZoom(2.5));
  await expect.poll(async () => (await lastParams()).zoom).toBeCloseTo(2.5, 2);
  // The setting turns it off.
  await page.evaluate(() => (window as any).sumi.settings.update({ wetInk: false }));
  await expect.poll(async () => (await lastParams()).on).toBe(false);
});

test('就寝・復習のお知らせ: settings schedule the reminders in the shell, with today\'s review count', async ({ page }) => {
  await fakeBridge(page);
  await page.clock.setFixedTime(new Date('2026-10-26T12:00:00+09:00'));
  await page.goto('/');
  const last = () => page.evaluate(() => (window as any).__reminders?.at(-1) ?? null);
  // Off by default: an empty list is sent once (clears anything left from before).
  await expect.poll(last).toEqual([]);
  await page.getByRole('button', { name: 'メニュー' }).first().click();
  await page.getByText('設定', { exact: true }).click();
  await page.getByText('就寝のお知らせ', { exact: true }).click();
  await expect.poll(async () => (await last())?.map((r: any) => [r.id, r.h, r.m])).toEqual([
    [1, 22, 30],
    [2, 23, 0],
  ]);
  // Notifications not allowed in the shell: the settings say how to fix it.
  await expect(page.getByTestId('notify-status')).toContainText('許可されていない');
  await page.evaluate(() => ((window as any).__notifyOk = true));
  await page.getByText('復習のお知らせ', { exact: true }).click();
  await page.getByTestId('review-time').fill('20:30');
  await page.getByTestId('review-time').dispatchEvent('change');
  await expect.poll(async () => (await last())?.find((r: any) => r.id === 3)).toMatchObject({ h: 20, m: 30, title: '今日の復習' });
  const review = (await last()).find((r: any) => r.id === 3);
  expect(review.text).toContain('0ページ');
  expect(review.text).toContain('共通テストまで82日'); // the nearest exam
  await expect(page.getByTestId('notify-status')).toHaveText('');
});

test('launcher shortcuts: opened with 新しいノート, then 今日の復習 while running', async ({ page }) => {
  await fakeBridge(page);
  await page.addInitScript(() => ((window as any).__shortcut = 'new'));
  await page.goto('/');
  await expect(page.locator('.modal h2')).toHaveText('新しいノート');
  await page.getByTestId('nb-title').fill('ショートカット');
  await page.getByTestId('create-notebook').click();
  await page.waitForFunction(() => !!(window as any).sumi?.view?.doc);
  await page.evaluate(() => {
    const w = window as any;
    w.__shortcut = 'review';
    w.__sumiNative.onShortcut();
  });
  // Nothing due: the review route says so and returns to the library.
  await expect(page.getByText('今日の復習はありません')).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/');
});

test('S Pen button click: undo, or pen ⇄ eraser; press-and-write is not a click', async ({ page }) => {
  await fakeBridge(page);
  await newNotebook(page);
  await pen(page, line(300, 300, 600, 300));
  await pen(page, line(300, 400, 600, 400));
  const button = (down: boolean) => page.evaluate((d) => (window as any).__sumiNative.onPenButton(d), down);
  // Default: nothing.
  await button(true);
  await button(false);
  expect((await docInfo(page)).pages[0].strokes).toHaveLength(2);
  await page.evaluate(() => (window as any).sumi.settings.update({ penButtonClick: 'undo' }));
  await button(true);
  await button(false);
  expect((await docInfo(page)).pages[0].strokes).toHaveLength(1);
  // Held while writing: an eraser stroke, not a click.
  await button(true);
  await pen(page, line(300, 300, 600, 300), { buttons: 32 });
  await button(false);
  expect((await docInfo(page)).pages[0].strokes).toHaveLength(0);
  // Pen ⇄ eraser.
  await page.evaluate(() => (window as any).sumi.settings.update({ penButtonClick: 'eraser' }));
  await button(true);
  await button(false);
  await expect(page.getByTestId('tool-eraser')).toHaveClass(/active/);
  await button(true);
  await button(false);
  await expect(page.getByTestId('tool-pen')).toHaveClass(/active/);
});

test('診断ログ: after a crash the app says so once and shows the record; script errors are kept', async ({ page }) => {
  await fakeBridge(page);
  const crashedAt = Date.now() - 60_000;
  await page.addInitScript((at) => {
    (window as any).__diag = [{ at, kind: 'crash', text: 'thread main\njava.lang.IllegalStateException: surface gone\n\tat WetInk.render' }];
  }, crashedAt);
  await page.goto('/');
  await expect(page.getByText('前回アプリが落ちた')).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: '見る' }).click();
  await expect(page.getByTestId('diag-text')).toHaveValue(/IllegalStateException: surface gone/);
  await page.keyboard.press('Escape');
  // A script error is recorded (and handed to the shell's log).
  await page.evaluate(() => setTimeout(() => (null as any).boom(), 0));
  await expect.poll(() => page.evaluate(() => ((window as any).__noted ?? []).map((x: string[]) => x[0]))).toContain('js-error');
  // Next start: the same crash isn't announced again.
  await page.reload();
  await page.waitForTimeout(2500);
  await expect(page.getByText('前回アプリが落ちた')).toHaveCount(0);
  // Settings → 診断ログ shows both.
  await page.locator('.lib-head .icon-btn').last().click();
  await page.getByText('設定', { exact: true }).click();
  await page.getByTestId('open-diag').click();
  await expect(page.getByTestId('diag-text')).toHaveValue(/surface gone[\s\S]*boom/);
});

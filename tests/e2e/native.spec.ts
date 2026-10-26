import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { docInfo, line, newNotebook, pen } from './helpers';

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
      setKeepScreenOn: () => {},
      takeIncoming: () => JSON.stringify(w.__incoming.splice(0)),
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

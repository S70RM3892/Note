// Render the app icons with the preinstalled Chromium (run once; PNGs are committed).
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const tpl = readFileSync(new URL('./icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, rx, s] of [
  ['icon-192.png', 192, 112, 1],
  ['icon-512.png', 512, 112, 1],
  ['maskable-512.png', 512, 0, 0.72],
]) {
  const svg = tpl.replace('__RX__', String(rx)).replace('__S__', String(s));
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: new URL(`../public/icons/${name}`, import.meta.url).pathname, omitBackground: true });
}
await browser.close();
console.log('icons written');

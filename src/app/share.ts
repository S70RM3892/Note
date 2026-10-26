import { importPdfAsNotebook } from '../pdf/import';
import { toast } from '../ui/dialogs';
import type { App } from './app';
import { importImagesAsNotebook } from './importers';

export const SHARE_CACHE = 'sumi-share-inbox';

/** Turn shared/opened files into notebooks (each PDF its own, all images together). Returns the first notebook id. */
export async function importSharedFiles(app: App, files: File[]): Promise<string | null> {
  let firstNb: string | null = null;
  const images: File[] = [];
  for (const file of files) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const nb = await importPdfAsNotebook(app.repo, file, null);
      firstNb ??= nb.id;
    } else if (file.type.startsWith('image/')) images.push(file);
  }
  if (images.length) {
    const nb = await importImagesAsNotebook(app.repo, images, '共有された画像');
    firstNb ??= nb.id;
  }
  return firstNb;
}

/** Files shared to the installed PWA arrive via the service worker's share-target cache. */
export async function importIncomingShares(app: App) {
  let firstNb: string | null = null;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const files: File[] = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      await cache.delete(req);
      if (!res) continue;
      const name = decodeURIComponent(res.headers.get('x-file-name') ?? 'shared');
      const blob = await res.blob();
      files.push(new File([blob], name, { type: blob.type || res.headers.get('content-type') || '' }));
    }
    firstNb = await importSharedFiles(app, files);
  } catch (e) {
    console.error(e);
    toast('共有ファイルの取り込みに失敗しました');
  }
  history.replaceState(null, '', firstNb ? `#/nb/${firstNb}` : '#/');
  await app.route();
}

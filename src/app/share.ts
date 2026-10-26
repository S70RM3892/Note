import { importPdfAsNotebook } from '../pdf/import';
import { toast } from '../ui/dialogs';
import type { App } from './app';
import { importImagesAsNotebook } from './importers';

export const SHARE_CACHE = 'sumi-share-inbox';

/** Files shared to the installed PWA arrive via the service worker's share-target cache. */
export async function importIncomingShares(app: App) {
  let firstNb: string | null = null;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const keys = await cache.keys();
    const images: File[] = [];
    for (const req of keys) {
      const res = await cache.match(req);
      await cache.delete(req);
      if (!res) continue;
      const name = decodeURIComponent(res.headers.get('x-file-name') ?? 'shared');
      const blob = await res.blob();
      const file = new File([blob], name, { type: blob.type || res.headers.get('content-type') || '' });
      if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) {
        const nb = await importPdfAsNotebook(app.repo, file, null);
        firstNb ??= nb.id;
      } else if (file.type.startsWith('image/')) images.push(file);
    }
    if (images.length) {
      const nb = await importImagesAsNotebook(app.repo, images, '共有された画像');
      firstNb ??= nb.id;
    }
  } catch (e) {
    console.error(e);
    toast('共有ファイルの取り込みに失敗しました');
  }
  history.replaceState(null, '', firstNb ? `#/nb/${firstNb}` : '#/');
  await app.route();
}

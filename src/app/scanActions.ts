import { uid } from '../core/id';
import type { ImageItem, Page, ScanItem } from '../core/types';
import type { EditorDoc } from '../editor/doc';
import type { Editor } from '../editor/editor';
import { importPdfAsNotebook } from '../pdf/import';
import { vectorDocToPdf } from '../scan/pdf';
import { shareOrDownload, toast } from '../ui/dialogs';
import type { App } from './app';
import type { ScanAction, ScanResult } from './scanDialog';

async function imageDataToJpeg(img: ImageData, quality = 0.92): Promise<Blob> {
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  cv.getContext('2d')!.putImageData(img, 0, 0);
  return new Promise((res) => cv.toBlob((b) => res(b!), 'image/jpeg', quality));
}

async function photoPdf(img: ImageData): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setCreator('Sumi Note');
  const jpg = await pdf.embedJpg(new Uint8Array(await (await imageDataToJpeg(img)).arrayBuffer()));
  const W = 595.28, H = (img.height / img.width) * W;
  pdf.addPage([W, H]).drawImage(jpg, { x: 0, y: 0, width: W, height: H });
  return pdf.save();
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export async function scanToPdf(res: ScanResult): Promise<Blob> {
  const bytes = res.doc ? await vectorDocToPdf(res.doc, `スキャン ${stamp()}`) : await photoPdf(res.clean);
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

/** Store the scan's assets and put it on the visible part of the current page, selected for positioning. */
export async function placeScan(app: App, editor: Editor, doc: EditorDoc, res: ScanResult) {
  const i = editor.currentPage;
  const page: Page = doc.pages[i];
  const c = editor.visibleCenterOn(i);
  const v = editor.vp.view, r = editor.vp.rects[i];
  const visW = Math.min(page.w, Math.min(r.x + r.w, v.x + v.w) - Math.max(r.x, v.x));
  const visH = Math.min(page.h, Math.min(r.y + r.h, v.y + v.h) - Math.max(r.y, v.y));
  const aspect = res.clean.height / res.clean.width;
  let w = Math.min(page.w * 0.92, visW * 0.92);
  let hgt = w * aspect;
  if (hgt > visH * 0.92) {
    hgt = visH * 0.92;
    w = hgt / aspect;
  }
  const photo = await app.repo.putAsset(await imageDataToJpeg(res.clean), 'image', 'scan.jpg');
  const base = { id: uid(), x: c.x - w / 2, y: c.y - hgt / 2, w, h: hgt, rot: 0 };
  let item: ScanItem | ImageItem;
  if (res.doc) {
    const vec = await app.repo.putAsset(new Blob([JSON.stringify(res.doc)], { type: 'application/json' }), 'vector', 'scan.json');
    item = { ...base, type: 'scan', vector: vec.id, photo: photo.id };
  } else {
    item = { ...base, type: 'image', asset: photo.id };
  }
  doc.addItems(page.id, [item]);
  editor.setTool('lasso');
  editor.selection.set(page.id, [item.id], { autoLock: true });
  toast('位置と大きさを決めて、外をタップすると固定される', 3000);
}

export async function handleScanResult(app: App, res: ScanResult, action: ScanAction, target?: { editor: Editor; doc: EditorDoc; after?: () => void }) {
  try {
    if (action === 'place' && target) {
      await placeScan(app, target.editor, target.doc, res);
      target.after?.();
      return;
    }
    toast('PDFを作成中…', 4000);
    const blob = await scanToPdf(res);
    if (action === 'pdf') {
      await shareOrDownload(blob, `scan-${stamp()}.pdf`);
      return;
    }
    const nb = await importPdfAsNotebook(app.repo, new File([blob], `スキャン ${stamp()}.pdf`, { type: 'application/pdf' }), null);
    app.go(`#/nb/${nb.id}`);
  } catch (e) {
    console.error(e);
    toast('取り込みに失敗: ' + (e as Error).message, 3000);
  }
}

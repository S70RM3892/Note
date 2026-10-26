import { uid } from '../core/id';
import type { Notebook, Page } from '../core/types';
import type { Repo } from '../store/repo';
import { COVER_COLORS } from '../store/repo';
import { openPdf, pdfOutline, pdfPageSizes, pdfPageTexts } from './pdfjs';

export async function pdfToPages(repo: Repo, file: Blob, name: string, nbId: string): Promise<Page[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await openPdf(bytes.slice());
  try {
    const sizes = await pdfPageSizes(doc);
    const texts = await pdfPageTexts(doc);
    const outline = await pdfOutline(doc);
    const asset = await repo.putAsset(new Blob([bytes], { type: 'application/pdf' }), 'pdf', name, outline.length ? outline : undefined);
    const now = Date.now();
    return sizes.map((s, index) => ({
      id: uid(),
      nb: nbId,
      w: s.w,
      h: s.h,
      bg: { tpl: 'blank', spacing: 5, color: '#ffffff' },
      pdf: { asset: asset.id, index },
      text: texts[index] || undefined,
      strokes: [],
      items: [],
      updated: now,
    }));
  } finally {
    void doc.destroy();
  }
}

/** Create a notebook whose pages are the PDF's pages (for annotating past exams etc.). */
export async function importPdfAsNotebook(repo: Repo, file: File, folder: string | null): Promise<Notebook> {
  const id = uid();
  const pages = await pdfToPages(repo, file, file.name, id);
  const now = Date.now();
  const first = pages[0];
  const nb: Notebook = {
    id,
    title: file.name.replace(/\.pdf$/i, '') || 'PDF',
    folder,
    created: now,
    updated: now,
    opened: now,
    pages: pages.map((p) => p.id),
    cover: COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)],
    paper: { w: first?.w ?? 794, h: first?.h ?? 1123, bg: { tpl: 'grid', spacing: 5, color: '#ffffff' } },
  };
  await repo.db.write({ put: [['notebooks', nb], ...pages.map((p) => ['pages', p] as ['pages', Page])] });
  return nb;
}

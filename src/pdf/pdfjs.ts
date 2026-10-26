import type { PDFDocumentProxy } from 'pdfjs-dist';

/** Lazily loaded pdf.js with offline cmaps / fonts / wasm (copied to ./pdfjs/ at build). */

let lib: Promise<typeof import('pdfjs-dist')> | null = null;

function base(): string {
  return new URL('./pdfjs/', document.baseURI).href;
}

export function pdfjs() {
  if (!lib) {
    lib = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([m, w]) => {
      m.GlobalWorkerOptions.workerSrc = w.default;
      return m;
    });
  }
  return lib;
}

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  const m = await pdfjs();
  const b = base();
  return m.getDocument({
    data,
    cMapUrl: b + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: b + 'standard_fonts/',
    wasmUrl: b + 'wasm/',
    iccUrl: b + 'iccs/',
  }).promise;
}

/** Page sizes in page units (96dpi) taking /Rotate into account. */
export async function pdfPageSizes(doc: PDFDocumentProxy): Promise<{ w: number; h: number }[]> {
  const out: { w: number; h: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 96 / 72 });
    out.push({ w: Math.round(vp.width * 100) / 100, h: Math.round(vp.height * 100) / 100 });
    p.cleanup();
  }
  return out;
}

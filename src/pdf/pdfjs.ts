import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OutlineEntry } from '../core/types';

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

/** Plain text of every page (empty for scanned pages), capped per page. */
export async function pdfPageTexts(doc: PDFDocumentProxy, maxChars = 20000): Promise<string[]> {
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    try {
      const p = await doc.getPage(i);
      const tc = await p.getTextContent();
      let s = '';
      for (const it of tc.items) {
        if (!('str' in it)) continue;
        s += it.str + (it.hasEOL ? '\n' : '');
        if (s.length > maxChars) break;
      }
      out.push(s.slice(0, maxChars));
      p.cleanup();
    } catch {
      out.push('');
    }
  }
  return out;
}

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineNode[];
}

/** Flattened bookmarks with resolved page indices (depth ≤ 3, at most 400 entries). */
export async function pdfOutline(doc: PDFDocumentProxy): Promise<OutlineEntry[]> {
  const out: OutlineEntry[] = [];
  let tree: OutlineNode[] | null = null;
  try {
    tree = (await doc.getOutline()) as unknown as OutlineNode[] | null;
  } catch {
    return out;
  }
  const walk = async (nodes: OutlineNode[], level: number) => {
    for (const n of nodes) {
      if (out.length >= 400) return;
      try {
        const dest = typeof n.dest === 'string' ? await doc.getDestination(n.dest) : n.dest;
        const ref = dest?.[0];
        let index = -1;
        if (typeof ref === 'number') index = ref;
        else if (ref && typeof ref === 'object') index = await doc.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
        if (index >= 0) out.push({ title: (n.title || '').trim() || '（無題）', index, level });
      } catch {
        /* unresolved bookmark */
      }
      if (level < 2 && n.items?.length) await walk(n.items, level + 1);
    }
  };
  if (tree) await walk(tree, 0);
  return out;
}

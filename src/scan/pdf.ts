import type { VectorDoc } from '../core/types';

function rgb01(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** A one-page vector PDF of a traced scan (A4 width, height from the scan's aspect). */
export async function vectorDocToPdf(doc: VectorDoc, title = 'Scan'): Promise<Uint8Array> {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('Sumi Note');
  const W = 595.28;
  const k = W / doc.w;
  const H = doc.h * k;
  const page = pdf.addPage([W, H]);
  for (const layer of doc.layers) {
    const c = rgb(...rgb01(layer.color));
    for (const t of layer.tiles) page.drawSvgPath(t.d, { x: 0, y: H, scale: k, color: c });
  }
  return pdf.save();
}

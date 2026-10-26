import type { Page, Rect, Stroke } from '../core/types';
import { nativeInk } from '../platform';
import type { Repo } from '../store/repo';
import { inkPayload, inkSignature, segmentLines, writingStrokes } from './lines';

export interface RecognizedLine {
  text: string;
  candidates: string[];
  box: Rect;
}

/** Read handwriting line by line (each line gets the previous one as context). */
export async function recognizeStrokes(strokes: Stroke[]): Promise<RecognizedLine[]> {
  const out: RecognizedLine[] = [];
  let pre = '';
  for (const line of segmentLines(strokes)) {
    const pad = line.box.h * 0.3;
    const candidates = await nativeInk.recognize(inkPayload(line, pad), line.box.w + 2 * pad, line.box.h + 2 * pad, pre);
    const text = candidates[0] ?? '';
    out.push({ text, candidates, box: line.box });
    if (text) pre = text;
  }
  return out;
}

const idle = () => new Promise<void>((r) => ('requestIdleCallback' in window ? requestIdleCallback(() => r(), { timeout: 500 }) : setTimeout(r, 30)));

/**
 * Background pass that reads the handwriting of every page whose ink changed since it was last
 * read, newest notebooks first, so the library search finds handwritten words. Writes only the
 * ink fields and only if the page is unchanged since it was read.
 */
export async function indexHandwriting(repo: Repo, signal: AbortSignal, onPage?: () => void): Promise<number> {
  if (!nativeInk.available() || nativeInk.status() !== 'ready') return 0;
  let done = 0;
  const notebooks = (await repo.listNotebooks()).sort((a, b) => b.updated - a.updated);
  for (const nb of notebooks) {
    const pages = await repo.db.getAllByIndex<Page>('pages', 'nb', nb.id);
    for (const p of pages) {
      if (signal.aborted) return done;
      const sig = inkSignature(p);
      if (p.inkSig === sig) continue;
      let text = '';
      if (writingStrokes(p.strokes).length) {
        try {
          text = (await recognizeStrokes(p.strokes)).map((l) => l.text).filter(Boolean).join('\n');
        } catch (e) {
          console.warn('handwriting recognition failed', e);
          return done;
        }
      }
      if (signal.aborted) return done;
      const wrote = await repo.db.update<Page>('pages', p.id, (cur) => (cur && cur.updated === p.updated ? { ...cur, ink: text || undefined, inkSig: sig } : undefined));
      if (wrote) {
        done++;
        onPage?.();
      }
      await idle();
    }
  }
  return done;
}

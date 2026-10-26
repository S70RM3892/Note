import type { Notebook, Page } from '../core/types';
import type { Repo } from './repo';

export interface SearchHit {
  nb: Notebook;
  page: number; // index in the notebook
  snippet: string;
  kind: 'mark' | 'text' | 'pdf' | 'ink';
}

/** Width/case-insensitive form (全角/半角, カナ variants via NFKC). */
export function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

function snippetAround(text: string, at: number, len: number): string {
  const start = Math.max(0, at - 18);
  const end = Math.min(text.length, at + len + 30);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
}

/** Find a query in bookmark names, typed text, PDF text and recognized handwriting of every live notebook. */
export function searchPages(pages: Page[], notebooks: Map<string, Notebook>, query: string, limit = 80): SearchHit[] {
  const q = normalize(query.trim());
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const p of pages) {
    const nb = notebooks.get(p.nb);
    if (!nb) continue;
    const index = nb.pages.indexOf(p.id);
    if (index < 0) continue;
    const sources: [string, SearchHit['kind']][] = [];
    if (p.mark) sources.push([p.mark, 'mark']);
    for (const it of p.items) if (it.type === 'text') sources.push([it.text, 'text']);
    if (p.text) sources.push([p.text, 'pdf']);
    if (p.ink) sources.push([p.ink, 'ink']);
    for (const [raw, kind] of sources) {
      const at = normalize(raw).indexOf(q);
      if (at >= 0) {
        hits.push({ nb, page: index, snippet: snippetAround(raw, at, q.length), kind });
        break;
      }
    }
    if (hits.length >= limit) break;
  }
  return hits.sort((a, b) => b.nb.updated - a.nb.updated || a.page - b.page);
}

export async function searchAll(repo: Repo, query: string): Promise<SearchHit[]> {
  const notebooks = new Map((await repo.listNotebooks()).map((n) => [n.id, n]));
  const pages = await repo.db.getAll<Page>('pages');
  return searchPages(pages, notebooks, query);
}

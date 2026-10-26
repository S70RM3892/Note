import { uid } from '../core/id';
import { PAPER_SIZES } from '../core/paper';
import type { Asset, Folder, Notebook, Page, PageBackground, ReviewRecord, TemplateId } from '../core/types';
import { DB } from './db';
import type { Settings } from './settings';

export const COVER_COLORS = ['#3b5bdb', '#e8590c', '#2f9e44', '#c2255c', '#1098ad', '#7048e8', '#495057', '#f08c00'];

export interface NewNotebookOptions {
  title: string;
  folder?: string | null;
  size?: string; // PAPER_SIZES id
  bg?: PageBackground;
  cover?: string;
  pages?: number;
}

export interface StudyStats {
  /** seconds of active writing per local day (YYYY-MM-DD) */
  days: Record<string, number>;
  exams: { at: number; label: string; planned: number; used: number }[];
}

export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class Repo {
  constructor(public db: DB) {}

  static async open(name?: string): Promise<Repo> {
    return new Repo(await DB.open(name));
  }

  // ---------- notebooks ----------

  async listNotebooks(): Promise<Notebook[]> {
    const all = await this.db.getAll<Notebook>('notebooks');
    return all.filter((n) => !n.trashed);
  }

  async listTrash(): Promise<Notebook[]> {
    const all = await this.db.getAll<Notebook>('notebooks');
    return all.filter((n) => n.trashed);
  }

  getNotebook(id: string) {
    return this.db.get<Notebook>('notebooks', id);
  }

  saveNotebook(nb: Notebook) {
    return this.db.put('notebooks', nb);
  }

  newPage(nb: Notebook, overrides: Partial<Page> = {}): Page {
    return {
      id: uid(),
      nb: nb.id,
      w: nb.paper.w,
      h: nb.paper.h,
      bg: { ...nb.paper.bg },
      strokes: [],
      items: [],
      updated: Date.now(),
      ...overrides,
    };
  }

  async createNotebook(o: NewNotebookOptions): Promise<{ nb: Notebook; pages: Page[] }> {
    const size = PAPER_SIZES.find((s) => s.id === o.size) ?? PAPER_SIZES[0];
    const now = Date.now();
    const nb: Notebook = {
      id: uid(),
      title: o.title || '無題のノート',
      folder: o.folder ?? null,
      created: now,
      updated: now,
      opened: now,
      pages: [],
      cover: o.cover ?? COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)],
      paper: { w: size.w, h: size.h, bg: o.bg ?? { tpl: 'grid', spacing: 5, color: '#ffffff' } },
    };
    const pages: Page[] = [];
    for (let i = 0; i < (o.pages ?? 1); i++) pages.push(this.newPage(nb));
    nb.pages = pages.map((p) => p.id);
    await this.db.write({ put: [['notebooks', nb], ...pages.map((p) => ['pages', p] as ['pages', Page])] });
    return { nb, pages };
  }

  /** Pages of a notebook in order. Also removes orphans left by undone page deletions. */
  async loadPages(nb: Notebook): Promise<Page[]> {
    const all = await this.db.getAllByIndex<Page>('pages', 'nb', nb.id);
    const byId = new Map(all.map((p) => [p.id, p]));
    const ordered: Page[] = [];
    for (const id of nb.pages) {
      const p = byId.get(id);
      if (p) {
        ordered.push(p);
        byId.delete(id);
      }
    }
    if (byId.size) {
      await this.db.write({
        del: [...byId.keys()].flatMap((id) => [['pages', id], ['reviews', id]] as [('pages' | 'reviews'), string][]),
      });
    }
    if (ordered.length !== nb.pages.length) {
      nb.pages = ordered.map((p) => p.id);
      if (!ordered.length) {
        const p = this.newPage(nb);
        ordered.push(p);
        nb.pages = [p.id];
        await this.db.put('pages', p);
      }
      await this.saveNotebook(nb);
    }
    return ordered;
  }

  async getPage(id: string) {
    return this.db.get<Page>('pages', id);
  }

  async savePages(pages: Page[], nb?: Notebook) {
    const put: [('pages' | 'notebooks'), unknown][] = pages.map((p) => ['pages', p]);
    if (nb) put.push(['notebooks', nb]);
    await this.db.write({ put });
  }

  async trashNotebook(nb: Notebook) {
    nb.trashed = Date.now();
    await this.saveNotebook(nb);
  }

  async restoreNotebook(nb: Notebook) {
    delete nb.trashed;
    await this.saveNotebook(nb);
  }

  async deleteNotebook(id: string) {
    const pageIds = await this.db.keysByIndex('pages', 'nb', id);
    const reviewIds = await this.db.keysByIndex('reviews', 'nb', id);
    await this.db.write({
      del: [
        ['notebooks', id],
        ...pageIds.map((k) => ['pages', k] as ['pages', string]),
        ...reviewIds.map((k) => ['reviews', k] as ['reviews', string]),
      ],
    });
    await this.collectAssets();
  }

  async duplicateNotebook(src: Notebook): Promise<Notebook> {
    const pages = await this.loadPages(src);
    const now = Date.now();
    const nb: Notebook = { ...structuredClone(src), id: uid(), title: src.title + ' のコピー', created: now, updated: now, opened: now };
    const copies = pages.map((p) => ({ ...structuredClone(p), id: uid(), nb: nb.id }));
    nb.pages = copies.map((p) => p.id);
    await this.db.write({ put: [['notebooks', nb], ...copies.map((p) => ['pages', p] as ['pages', Page])] });
    return nb;
  }

  // ---------- assets ----------

  async putAsset(blob: Blob, kind: Asset['kind'], name?: string, outline?: Asset['outline']): Promise<Asset> {
    const a: Asset = { id: uid(), kind, mime: blob.type || (kind === 'pdf' ? 'application/pdf' : 'image/png'), name, blob };
    if (outline) a.outline = outline;
    await this.db.put('assets', a);
    return a;
  }

  getAsset(id: string) {
    return this.db.get<Asset>('assets', id);
  }

  /** Delete assets no page references any more. */
  async collectAssets(keep: Set<string> = new Set()) {
    const assetIds = await this.db.keys('assets');
    if (!assetIds.length) return;
    const used = new Set<string>(keep);
    const pages = await this.db.getAll<Page>('pages');
    for (const p of pages) {
      if (p.pdf) used.add(p.pdf.asset);
      for (const it of p.items) {
        if (it.type === 'image') used.add(it.asset);
        else if (it.type === 'scan') {
          used.add(it.vector);
          if (it.photo) used.add(it.photo);
        }
      }
    }
    const unused = assetIds.filter((id) => !used.has(id));
    if (unused.length) await this.db.write({ del: unused.map((id) => ['assets', id] as ['assets', string]) });
  }

  // ---------- folders ----------

  async listFolders(): Promise<Folder[]> {
    const f = await this.db.getAll<Folder>('folders');
    return f.sort((a, b) => a.order - b.order);
  }

  async saveFolder(f: Folder) {
    await this.db.put('folders', f);
  }

  async deleteFolder(id: string) {
    const nbs = await this.db.getAll<Notebook>('notebooks');
    const moved = nbs.filter((n) => n.folder === id).map((n) => ({ ...n, folder: null }));
    await this.db.write({ put: moved.map((n) => ['notebooks', n] as ['notebooks', Notebook]), del: [['folders', id]] });
  }

  // ---------- reviews ----------

  async listReviews(): Promise<ReviewRecord[]> {
    return this.db.getAll<ReviewRecord>('reviews');
  }

  getReview(pageId: string) {
    return this.db.get<ReviewRecord>('reviews', pageId);
  }

  saveReview(r: ReviewRecord) {
    return this.db.put('reviews', r);
  }

  deleteReview(pageId: string) {
    return this.db.delete('reviews', pageId);
  }

  // ---------- key/value ----------

  async kvGet<T>(k: string): Promise<T | undefined> {
    const r = await this.db.get<{ k: string; v: T }>('kv', k);
    return r?.v;
  }

  kvSet<T>(k: string, v: T) {
    return this.db.put('kv', { k, v });
  }

  async loadSettings(): Promise<Partial<Settings> | undefined> {
    return this.kvGet<Partial<Settings>>('settings');
  }

  async loadStats(): Promise<StudyStats> {
    return (await this.kvGet<StudyStats>('stats')) ?? { days: {}, exams: [] };
  }

  saveStats(s: StudyStats) {
    return this.kvSet('stats', s);
  }
}

export function defaultBackground(s: Settings): PageBackground {
  return { tpl: s.defaultPaper.tpl as TemplateId, spacing: s.defaultPaper.spacing, color: s.defaultPaper.color };
}

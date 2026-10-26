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
  /** The same per notebook (教科別): notebook id → day → seconds, last 60 days. */
  byNb?: Record<string, Record<string, number>>;
  /** Total writing time per page (how long each problem took). */
  byPage?: Record<string, number>;
  exams: { at: number; label: string; planned: number; used: number; laps?: number[] }[];
}

/** ページの履歴: an earlier state of a page's content. */
export interface PageVersion {
  /** `${page}:${snapshot time}` – sorts chronologically per page. */
  id: string;
  page: string;
  nb: string;
  /** When the page looked like this (its last edit before the snapshot). */
  at: number;
  strokes: Page['strokes'];
  items: Page['items'];
}

/** What a page held when it was last written (for ページの履歴; the editor keeps it in memory). */
export interface StoredContent {
  strokes: Page['strokes'];
  items: Page['items'];
  updated: number;
}

/** しおり across notebooks (an index kept next to the pages, so the library needn't read every page). */
export interface BookmarkEntry {
  nb: string;
  page: string;
  label: string;
  at: number;
}

/** A page keeps a snapshot at most this often while it is being edited… */
export const SNAPSHOT_EVERY = 10 * 60_000;
/** …and its newest this many. */
export const SNAPSHOT_KEEP = 30;

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

  private snapAt = new Map<string, number>();

  /** Time of the page's newest snapshot (0 = none). */
  private async lastSnapshot(pageId: string): Promise<number> {
    let t = this.snapAt.get(pageId);
    if (t === undefined) {
      const keys = await this.db.keysByIndex('versions', 'page', pageId);
      const last = keys[keys.length - 1];
      t = last ? Number(last.slice(last.lastIndexOf(':') + 1)) || 0 : 0;
      this.snapAt.set(pageId, t);
    }
    return t;
  }

  /**
   * Save pages. ページの履歴: given what each page held when it was last written (`previous`,
   * kept by the editor — never read back from the database, which on a dense page would cost a
   * big deserialisation on every autosave), that state is kept as a version when the last one is
   * older than SNAPSHOT_EVERY (so the first save of a session keeps how the page was before it),
   * and always when the save loses most of the page (cleared, or a big part erased).
   */
  async savePages(pages: Page[], nb?: Notebook, now = Date.now(), previous?: Map<string, StoredContent>) {
    const put: [('pages' | 'notebooks' | 'versions'), unknown][] = pages.map((p) => ['pages', p]);
    if (nb) put.push(['notebooks', nb]);
    const snapped: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      const prev = previous?.get(pages[i].id);
      const o = prev && { id: pages[i].id, nb: pages[i].nb, ...prev };
      if (!o || (!o.strokes.length && !o.items.length)) continue;
      const before = o.strokes.length + o.items.length;
      const after = pages[i].strokes.length + pages[i].items.length;
      const destructive = before >= 3 && after < before / 2;
      let last = await this.lastSnapshot(o.id);
      // Never snapshotted and written just now: this is the session that started it, not older
      // work; count its interval from that first edit.
      if (!last && now - o.updated < SNAPSHOT_EVERY) this.snapAt.set(o.id, (last = o.updated));
      if (!destructive && now - last < SNAPSHOT_EVERY) continue;
      const v: PageVersion = { id: `${o.id}:${now}`, page: o.id, nb: o.nb, at: o.updated || now, strokes: o.strokes, items: o.items };
      put.push(['versions', v]);
      snapped.push(o.id);
    }
    await this.db.write({ put });
    for (const id of snapped) {
      this.snapAt.set(id, now);
      const keys = await this.db.keysByIndex('versions', 'page', id);
      if (keys.length > SNAPSHOT_KEEP) await this.db.write({ del: keys.slice(0, keys.length - SNAPSHOT_KEEP).map((k) => ['versions', k] as ['versions', string]) });
    }
  }

  /** All しおり (built from the pages once, then kept up to date by setBookmark). */
  async listBookmarks(): Promise<BookmarkEntry[]> {
    const known = await this.kvGet<BookmarkEntry[]>('bookmarks');
    if (known) return known;
    const pages = await this.db.getAll<Page>('pages');
    const list = pages
      .filter((p) => p.mark !== undefined)
      .map((p) => ({ nb: p.nb, page: p.id, label: (p.mark || p.ink || p.text || '').replace(/\s+/g, ' ').trim().slice(0, 40), at: p.updated }));
    await this.kvSet('bookmarks', list);
    return list;
  }

  /** Add, rename (label) or remove (undefined) the しおり of a page in the index. */
  async setBookmark(nb: string, page: string, label: string | undefined, now = Date.now()) {
    const list = (await this.listBookmarks()).filter((b) => b.page !== page);
    if (label !== undefined) list.push({ nb, page, label: label.slice(0, 40), at: now });
    await this.kvSet('bookmarks', list);
  }

  /** After pages arrive in bulk (a restore, a copied notebook): the next listBookmarks rebuilds the index. */
  forgetBookmarks() {
    return this.db.delete('kv', 'bookmarks');
  }

  /** ページの履歴, newest first. */
  async listVersions(pageId: string): Promise<PageVersion[]> {
    return (await this.db.getAllByIndex<PageVersion>('versions', 'page', pageId)).sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
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
    const versionIds = await this.db.keysByIndex('versions', 'nb', id);
    await this.db.write({
      del: [
        ['notebooks', id],
        ...pageIds.map((k) => ['pages', k] as ['pages', string]),
        ...reviewIds.map((k) => ['reviews', k] as ['reviews', string]),
        ...versionIds.map((k) => ['versions', k] as ['versions', string]),
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
    if (copies.some((p) => p.mark !== undefined)) await this.forgetBookmarks();
    return nb;
  }

  /** Copy pages to the end of another notebook (new ids; PDF backgrounds and images share their assets). */
  async copyPagesTo(targetId: string, pages: Page[], now = Date.now()): Promise<Notebook | null> {
    const target = await this.getNotebook(targetId);
    if (!target) return null;
    const copies = pages.map((p) => {
      const c: Page = { ...structuredClone(p), id: uid(), nb: target.id, updated: now };
      delete c.mark;
      return c;
    });
    target.pages = [...target.pages, ...copies.map((p) => p.id)];
    target.updated = now;
    await this.db.write({ put: [['notebooks', target], ...copies.map((p) => ['pages', p] as ['pages', Page])] });
    return target;
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

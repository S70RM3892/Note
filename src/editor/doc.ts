import { itemBounds, rectUnion, strokeBounds } from '../core/geometry';
import { History, type Command } from '../core/history';
import type { Item, Notebook, Page, PageBackground, Rect, Stroke } from '../core/types';
import type { Repo, StoredContent } from '../store/repo';

export interface Content {
  strokes: Stroke[];
  items: Item[];
}

export interface ContentChange {
  pageId: string;
  before: Content;
  after: Content;
}

/** Bounds of everything that differs between two content snapshots (objects are immutable). */
export function diffBounds(a: Content, b: Content): Rect | null {
  let r: Rect | null = null;
  const sa = new Set(a.strokes), sb = new Set(b.strokes);
  for (const s of a.strokes) if (!sb.has(s)) r = rectUnion(r, strokeBounds(s));
  for (const s of b.strokes) if (!sa.has(s)) r = rectUnion(r, strokeBounds(s));
  const ia = new Set(a.items), ib = new Set(b.items);
  for (const it of a.items) if (!ib.has(it)) r = rectUnion(r, itemBounds(it));
  for (const it of b.items) if (!ia.has(it)) r = rectUnion(r, itemBounds(it));
  return r;
}

/**
 * In-memory notebook being edited: pages, undo history and debounced persistence.
 * Strokes and items are treated as immutable; every change swaps arrays.
 */
export class EditorDoc {
  pages: Page[];
  readonly history = new History(400);
  private byId = new Map<string, Page>();
  private dirtyPages = new Set<string>();
  private nbDirty = false;
  private saveTimer = 0;
  private saving: Promise<void> = Promise.resolve();
  /** What each page held when last written (content arrays are replaced, never changed in place). */
  private stored = new Map<string, StoredContent>();
  /** Content of a page changed; region in page coordinates (null = whole page). */
  onContent: (pageId: string, region: Rect | null) => void = () => {};
  /** Pages were added, removed, reordered or resized. */
  onStructure: () => void = () => {};
  onSaved: () => void = () => {};

  /** A read-only doc (reference pane) never writes: it may hold a stale snapshot. */
  constructor(public repo: Repo, public nb: Notebook, pages: Page[], readonly readOnly = false) {
    this.pages = pages;
    pages.forEach((p) => {
      this.byId.set(p.id, p);
      this.stored.set(p.id, { strokes: p.strokes, items: p.items, updated: p.updated });
    });
  }

  page(id: string): Page | undefined {
    return this.byId.get(id);
  }

  indexOf(id: string): number {
    return this.pages.findIndex((p) => p.id === id);
  }

  content(pageId: string): Content {
    const p = this.byId.get(pageId)!;
    return { strokes: p.strokes, items: p.items };
  }

  /** Replace page content without recording history. */
  setContent(pageId: string, c: Content, region?: Rect | null) {
    const p = this.byId.get(pageId);
    if (!p) return;
    const before = { strokes: p.strokes, items: p.items };
    p.strokes = c.strokes;
    p.items = c.items;
    p.updated = Date.now();
    this.markDirty(pageId);
    this.onContent(pageId, region === undefined ? diffBounds(before, c) : region);
  }

  /** Record (and apply) a set of content changes as one undo step. */
  commit(changes: ContentChange[]) {
    const real = changes.filter((c) => c.before.strokes !== c.after.strokes || c.before.items !== c.after.items);
    if (!real.length) return;
    for (const c of real) this.setContent(c.pageId, c.after);
    this.history.push({
      undo: () => real.forEach((c) => this.setContent(c.pageId, c.before)),
      redo: () => real.forEach((c) => this.setContent(c.pageId, c.after)),
    });
  }

  /** Push already-applied changes onto the undo stack. */
  record(changes: ContentChange[]) {
    const real = changes.filter((c) => c.before.strokes !== c.after.strokes || c.before.items !== c.after.items);
    if (!real.length) return;
    this.history.push({
      undo: () => real.forEach((c) => this.setContent(c.pageId, c.before)),
      redo: () => real.forEach((c) => this.setContent(c.pageId, c.after)),
    });
  }

  addStroke(pageId: string, s: Stroke) {
    const before = this.content(pageId);
    this.commit([{ pageId, before, after: { strokes: [...before.strokes, s], items: before.items } }]);
  }

  addItems(pageId: string, items: Item[]) {
    const before = this.content(pageId);
    this.commit([{ pageId, before, after: { strokes: before.strokes, items: [...before.items, ...items] } }]);
  }

  replaceItem(pageId: string, oldItem: Item, newItem: Item | null, record = true) {
    const before = this.content(pageId);
    const items = newItem ? before.items.map((i) => (i === oldItem ? newItem : i)) : before.items.filter((i) => i !== oldItem);
    const after = { strokes: before.strokes, items };
    if (record) this.commit([{ pageId, before, after }]);
    else this.setContent(pageId, after);
  }

  // ---------- page structure ----------

  private applyOrder(pages: Page[]) {
    if (this.readOnly) return;
    const known = new Set(this.nb.pages);
    this.pages = pages;
    this.byId.clear();
    pages.forEach((p) => this.byId.set(p.id, p));
    this.nb.pages = pages.map((p) => p.id);
    this.nbDirty = true;
    // Only pages that were not part of the notebook need writing; the order lives in the notebook.
    pages.forEach((p) => {
      if (!known.has(p.id)) this.dirtyPages.add(p.id);
    });
    this.scheduleSave();
    this.onStructure();
  }

  private structureCommand(before: Page[], after: Page[]): Command {
    return { undo: () => this.applyOrder(before), redo: () => this.applyOrder(after) };
  }

  setPages(after: Page[]) {
    const before = this.pages.slice();
    this.applyOrder(after);
    this.history.push(this.structureCommand(before, after));
  }

  insertPages(index: number, pages: Page[]) {
    const after = this.pages.slice();
    after.splice(index, 0, ...pages);
    this.setPages(after);
  }

  /** Append a page as part of the last undo step (added because of the stroke just written). */
  appendPageToLastStep(page: Page) {
    this.insertPageToLastStep(this.pages.length, page);
  }

  /** The same, at `index` (the next page of a problem in a 問題ごとのノート). */
  insertPageToLastStep(index: number, page: Page) {
    const before = this.pages.slice();
    const after = before.slice();
    after.splice(index, 0, page);
    this.applyOrder(after);
    this.history.amend(this.structureCommand(before, after));
  }

  deletePages(ids: string[]) {
    const after = this.pages.filter((p) => !ids.includes(p.id));
    if (!after.length) return false;
    this.setPages(after);
    return true;
  }

  movePage(from: number, to: number) {
    if (from === to) return;
    const after = this.pages.slice();
    const [p] = after.splice(from, 1);
    after.splice(to, 0, p);
    this.setPages(after);
  }

  setBackground(ids: string[], bg: PageBackground) {
    const prev = ids.map((id) => ({ id, bg: this.byId.get(id)!.bg }));
    const apply = (vals: { id: string; bg: PageBackground }[]) => {
      for (const v of vals) {
        const p = this.byId.get(v.id);
        if (!p) continue;
        p.bg = v.bg;
        this.markDirty(p.id);
        this.onContent(p.id, null);
      }
    };
    const next = ids.map((id) => ({ id, bg: { ...bg } }));
    apply(next);
    this.history.push({ undo: () => apply(prev), redo: () => apply(next) });
  }

  /**
   * 解き直し: set the page's handwriting aside as the previous attempt and clear it (fixed ink,
   * images, PDF and text stay). One undo step brings the attempt back.
   */
  startOver(pageId: string): boolean {
    const p = this.byId.get(pageId);
    if (!p || this.readOnly) return false;
    const before = this.content(pageId);
    const keep = before.strokes.filter((s) => s.locked);
    if (keep.length === before.strokes.length) return false;
    const oldPrev = p.prev;
    const prev = { at: Date.now(), strokes: before.strokes.filter((s) => !s.locked) };
    const after = { strokes: keep, items: before.items };
    const apply = (pv: Page['prev'], c: Content) => {
      if (pv) p.prev = pv;
      else delete p.prev;
      this.setContent(pageId, c, null);
    };
    apply(prev, after);
    this.history.push({ undo: () => apply(oldPrev, before), redo: () => apply(prev, after) });
    return true;
  }

  /** しおり: label to bookmark the page, undefined to remove the bookmark. */
  setMark(pageId: string, label: string | undefined) {
    const p = this.byId.get(pageId);
    if (!p) return;
    if (label === undefined) delete p.mark;
    else p.mark = label.trim().slice(0, 60);
    this.markDirty(p.id);
  }

  // ---------- persistence ----------

  markDirty(pageId: string) {
    if (this.readOnly) return;
    this.dirtyPages.add(pageId);
    this.scheduleSave();
  }

  markNotebookDirty() {
    if (this.readOnly) return;
    this.nbDirty = true;
    this.scheduleSave();
  }

  get hasUnsaved() {
    return this.dirtyPages.size > 0 || this.nbDirty;
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), 600);
  }

  /** Write dirty pages now. Safe to call repeatedly. */
  flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (this.readOnly) return Promise.resolve();
    this.saving = this.saving.catch(() => {}).then(async () => {
      if (!this.hasUnsaved) return;
      const pages = [...this.dirtyPages].map((id) => this.byId.get(id)).filter((p): p is Page => !!p);
      this.dirtyPages.clear();
      this.nbDirty = false;
      // "Updated" means the content changed, not that the notebook was merely opened.
      if (pages.length) this.nb.updated = Date.now();
      try {
        const written = pages.map((p) => [p.id, { strokes: p.strokes, items: p.items, updated: p.updated }] as const);
        await this.repo.savePages(pages, this.nb, Date.now(), this.stored);
        for (const [id, c] of written) this.stored.set(id, c);
        this.onSaved();
      } catch (e) {
        pages.forEach((p) => this.dirtyPages.add(p.id));
        this.nbDirty = true;
        console.error('save failed', e);
        throw e;
      }
    });
    return this.saving;
  }
}

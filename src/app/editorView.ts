import { uid } from '../core/id';
import { grade, newReview, nextInterval, formatInterval, type Grade } from '../core/srs';
import type { Notebook, Page, PageBackground, ReviewRecord } from '../core/types';
import { EditorDoc } from '../editor/doc';
import type { Editor } from '../editor/editor';
import { hasClipboard } from '../editor/selection';
import type { ToolName } from '../editor/tool';
import { exportPng, thumbnail } from '../pdf/export';
import { pdfToPages } from '../pdf/import';
import { exportBackup } from '../store/backup';
import { RED_SHEET_ORANGE, type Settings } from '../store/settings';
import { RedSheet } from '../study/redsheet';
import { h } from '../ui/dom';
import { menu, modal, pickFiles, popover, promptDialog, safeFileName, shareOrDownload, toast } from '../ui/dialogs';
import { icon, type IconName } from '../ui/icons';
import type { App, View } from './app';
import { exportNotebookPdfDialog } from './exportDialog';
import { imageItem } from './importers';
import { chipGroup, paperFields, swatchGroup } from './newNotebook';
import { openPageOverview } from './pageOverview';
import { openSettings } from './settingsView';

const TOOLS: { id: ToolName; icon: IconName; label: string; key: string }[] = [
  { id: 'pen', icon: 'pen', label: 'ペン', key: 'p' },
  { id: 'highlighter', icon: 'highlighter', label: 'マーカー', key: 'h' },
  { id: 'eraser', icon: 'eraser', label: '消しゴム', key: 'e' },
  { id: 'lasso', icon: 'lasso', label: '投げ縄', key: 'l' },
  { id: 'text', icon: 'text', label: 'テキスト', key: 't' },
  { id: 'tape', icon: 'tape', label: '暗記テープ', key: 'k' },
];

const PEN_SIZES = [1.2, 2.2, 3.6];
const HL_SIZES = [10, 16, 26];
const ERASER_SIZES = [6, 12, 24];
const TAPE_SIZES = [18, 26, 40];
const TAPE_COLORS = ['#ff9800', '#2f9e44', '#1c7ed6', '#e64980', '#495057'];

export class EditorView implements View {
  readonly el: HTMLElement;
  private editor: Editor;
  private doc: EditorDoc | null = null;
  private toolbar: HTMLElement;
  private palette: HTMLElement;
  private toolBtns = new Map<ToolName, HTMLElement>();
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private pagePill!: HTMLElement;
  private zoomPill!: HTMLElement;
  private titleEl!: HTMLElement;
  private sheetBtn!: HTMLElement;
  private pasteBtn!: HTMLButtonElement;
  private selMenu: HTMLElement;
  private zoomBadge: HTMLElement;
  private stageWrap: HTMLElement;
  private redSheet: RedSheet;
  private unsubs: (() => void)[] = [];
  private lastZoom = 0;
  private zoomTimer = 0;
  private reviewIds = new Set<string>();
  private review: { queue: ReviewRecord[]; index: number; bar: HTMLElement } | null = null;
  private onKey = (e: KeyboardEvent) => this.handleKey(e);

  private constructor(private app: App) {
    this.toolbar = h('div', { class: 'toolbar', role: 'toolbar' });
    this.palette = h('div', { class: 'tb-palette' });
    this.stageWrap = h('div', { class: 'stage-wrap' });
    this.el = h('div', { class: 'editor-view' }, this.toolbar, this.stageWrap);
    this.editor = app.getEditor(this.stageWrap);
    this.selMenu = h('div', { class: 'sel-menu', hidden: true });
    this.zoomBadge = h('div', { class: 'zoom-badge' });
    this.stageWrap.append(this.selMenu, this.zoomBadge);
    this.redSheet = new RedSheet(this.stageWrap);
    this.buildToolbar();
    this.unsubs.push(this.editor.subscribe(() => this.sync()));
    this.unsubs.push(app.settings.subscribe(() => this.renderPalette()));
    document.addEventListener('keydown', this.onKey);
    app.applyTheme();
  }

  static async open(app: App, nbId: string, page?: number): Promise<EditorView | null> {
    const v = new EditorView(app);
    if (!(await v.load(nbId, page))) {
      await v.destroy();
      return null;
    }
    return v;
  }

  static async openReview(app: App, queue: ReviewRecord[]): Promise<EditorView | null> {
    const v = new EditorView(app);
    v.review = { queue, index: 0, bar: h('div', { class: 'review-bar', 'data-testid': 'review-bar' }) };
    v.stageWrap.appendChild(v.review.bar);
    if (!(await v.showReviewItem())) {
      await v.destroy();
      return null;
    }
    return v;
  }

  private async load(nbId: string, page?: number): Promise<boolean> {
    const repo = this.app.repo;
    const nb = await repo.getNotebook(nbId);
    if (!nb || nb.trashed) return false;
    if (this.doc) await this.closeDoc();
    const pages = await repo.loadPages(nb);
    nb.opened = Date.now();
    if (page !== undefined) nb.lastPage = page;
    const doc = new EditorDoc(repo, nb, pages);
    this.doc = doc;
    this.reviewIds = new Set((await repo.db.getAllByIndex<ReviewRecord>('reviews', 'nb', nb.id)).map((r) => r.id));
    this.editor.open(doc);
    this.editor.tapeMode = 'normal';
    doc.markNotebookDirty();
    this.titleEl.textContent = nb.title;
    this.sync();
    return true;
  }

  /** Persist everything now (called on background/close). */
  async save() {
    const doc = this.doc;
    if (!doc) return;
    doc.nb.lastPage = this.editor.currentPage;
    doc.markNotebookDirty();
    await doc.flush();
  }

  private async closeDoc() {
    const doc = this.doc;
    if (!doc) return;
    this.editor.close();
    try {
      const first = doc.pages[0];
      if (first) doc.nb.thumb = thumbnail(first, this.app.assets, 220).toDataURL('image/webp', 0.75);
    } catch {
      /* thumbnail is optional */
    }
    doc.markNotebookDirty();
    await doc.flush();
    this.doc = null;
  }

  async destroy() {
    document.removeEventListener('keydown', this.onKey);
    this.unsubs.forEach((u) => u());
    await this.closeDoc();
    this.redSheet.hide();
    this.app.assets.trim();
    this.editor.el.remove();
  }

  // ---------- toolbar ----------

  private btn(ic: IconName, label: string, onClick: (e: MouseEvent) => void, testid?: string): HTMLButtonElement {
    return h('button', { class: 'icon-btn', 'aria-label': label, title: label, onclick: onClick, 'data-testid': testid }, icon(ic)) as HTMLButtonElement;
  }

  private buildToolbar() {
    const tb = this.toolbar;
    this.titleEl = h('button', { class: 'tb-title', onclick: () => this.rename() });
    this.undoBtn = this.btn('undo', '元に戻す', () => this.editor.undo(), 'undo');
    this.redoBtn = this.btn('redo', 'やり直す', () => this.editor.redo(), 'redo');
    tb.append(this.btn('back', 'ライブラリ', () => this.app.go('#/'), 'back'), this.titleEl, h('div', { class: 'tb-sep' }), this.undoBtn, this.redoBtn, h('div', { class: 'tb-sep' }));
    for (const t of TOOLS) {
      const b = this.btn(t.icon, t.label, (e) => this.onToolClick(t.id, e.currentTarget as HTMLElement), `tool-${t.id}`);
      this.toolBtns.set(t.id, b);
      tb.append(b);
    }
    this.pasteBtn = this.btn('paste', '貼り付け', () => this.paste(), 'paste');
    tb.append(this.pasteBtn, h('div', { class: 'tb-sep tb-palette-sep' }), this.palette, h('span', { class: 'spacer', style: 'min-width:8px' }));
    this.pagePill = h('button', { class: 'tb-pill', onclick: () => this.overview(), 'data-testid': 'page-pill' });
    this.zoomPill = h('button', { class: 'tb-pill', onclick: () => this.editor.fitWidth(), title: '幅に合わせる' });
    this.sheetBtn = this.btn('eyeOff', '赤シート', () => this.toggleSheet(), 'red-sheet-btn');
    tb.append(
      this.pagePill,
      this.zoomPill,
      this.sheetBtn,
      this.btn('timer', '過去問タイマー', () => this.app.timer.show(), 'timer-btn'),
      this.btn('grid', 'ページ一覧', () => this.overview(), 'overview'),
      this.btn('plus', 'ページを追加', () => this.addPage(), 'add-page'),
      this.btn('more', 'メニュー', (e) => this.moreMenu(e.currentTarget as HTMLElement), 'more'),
    );
    this.renderPalette();
  }

  private onToolClick(t: ToolName, anchor: HTMLElement) {
    if (this.editor.tool === t) this.toolOptions(t, anchor);
    else {
      this.editor.setTool(t);
      this.renderPalette();
    }
  }

  private sync() {
    const ed = this.editor;
    const doc = this.doc;
    for (const [id, b] of this.toolBtns) b.classList.toggle('active', ed.tool === id);
    this.undoBtn.disabled = !doc?.history.canUndo;
    this.redoBtn.disabled = !doc?.history.canRedo;
    this.pasteBtn.hidden = !(ed.tool === 'lasso' && hasClipboard());
    if (doc) this.pagePill.textContent = `${ed.currentPage + 1} / ${doc.pages.length}`;
    const z = Math.round(ed.vp.zoom * 100);
    this.zoomPill.textContent = `${z}%`;
    if (this.lastZoom && z !== this.lastZoom) {
      this.zoomBadge.textContent = `${z}%`;
      this.zoomBadge.classList.add('show');
      clearTimeout(this.zoomTimer);
      this.zoomTimer = window.setTimeout(() => this.zoomBadge.classList.remove('show'), 700);
    }
    this.lastZoom = z;
    this.sheetBtn.classList.toggle('active', this.redSheet.visible);
    this.positionSelMenu();
  }

  private renderPalette() {
    const s = this.app.settings.get();
    const set = (p: Partial<Settings>) => this.app.settings.update(p);
    const t = this.editor.tool;
    const colors = (list: string[], cur: string, pick: (c: string) => void) =>
      list.map((c) => h('button', { class: 'tb-color' + (c.toLowerCase() === cur.toLowerCase() ? ' on' : ''), style: `background:${c}`, 'aria-label': `色 ${c}`, 'data-testid': 'color', onclick: () => pick(c) }));
    const sizes = (list: number[], cur: number, pick: (v: number) => void, dot: (v: number) => number) =>
      list.map((v) => h('button', { class: 'tb-size' + (Math.abs(v - cur) < 1e-6 ? ' on' : ''), 'aria-label': `太さ ${v}`, onclick: () => pick(v) }, h('i', { style: `width:${dot(v)}px;height:${dot(v)}px` })));
    let nodes: HTMLElement[] = [];
    if (t === 'pen' || t === 'text') {
      nodes = [
        ...colors(s.penColors, s.pen.color, (c) => set({ pen: { ...s.pen, color: c } })),
        h('div', { class: 'tb-sep' }),
        ...sizes(PEN_SIZES, s.pen.width, (v) => set({ pen: { ...s.pen, width: v } }), (v) => 3 + v * 2.2),
      ];
      if (t === 'text') nodes = nodes.slice(0, s.penColors.length);
    } else if (t === 'highlighter') {
      nodes = [
        ...colors(s.highlighterColors, s.highlighter.color, (c) => set({ highlighter: { ...s.highlighter, color: c } })),
        h('div', { class: 'tb-sep' }),
        ...sizes(HL_SIZES, s.highlighter.width, (v) => set({ highlighter: { ...s.highlighter, width: v } }), (v) => 4 + v * 0.5),
      ];
    } else if (t === 'eraser') {
      nodes = [
        h('button', { class: 'chip' + (s.eraserMode === 'partial' ? ' on' : ''), onclick: () => set({ eraserMode: 'partial' }) }, '部分'),
        h('button', { class: 'chip' + (s.eraserMode === 'stroke' ? ' on' : ''), style: 'margin-left:6px', onclick: () => set({ eraserMode: 'stroke' }) }, '線ごと'),
        h('div', { class: 'tb-sep' }),
        ...sizes(ERASER_SIZES, s.eraserSize, (v) => set({ eraserSize: v }), (v) => 4 + v * 0.6),
      ];
    } else if (t === 'tape') {
      nodes = [
        ...colors(TAPE_COLORS, s.tapeColor, (c) => set({ tapeColor: c })),
        h('div', { class: 'tb-sep' }),
        ...sizes(TAPE_SIZES, s.tapeWidth, (v) => set({ tapeWidth: v }), (v) => 4 + v * 0.35),
        h('div', { class: 'tb-sep' }),
        h('button', { class: 'chip', onclick: () => (this.editor.setAllTapes(true), toast('全部隠した')) }, icon('eyeOff', 15), '全部隠す'),
        h('button', { class: 'chip', style: 'margin-left:6px', onclick: () => (this.editor.setAllTapes(false), toast('全部めくった')) }, icon('eye', 15), '全部めくる'),
      ];
    }
    this.palette.replaceChildren(...nodes);
    this.sync();
  }

  private toolOptions(t: ToolName, anchor: HTMLElement) {
    const st = this.app.settings;
    const s = st.get();
    const set = (p: Partial<Settings>) => st.update(p);
    const wrap = h('div', { class: 'tool-pop' });
    const slider = (min: number, max: number, step: number, value: number, on: (v: number) => void) => h('input', { type: 'range', min, max, step, value: String(value), oninput: (e: Event) => on(Number((e.target as HTMLInputElement).value)) });
    const customColor = (list: 'penColors' | 'highlighterColors') => {
      const input = h('input', {
        type: 'color',
        style: 'width:44px;height:36px;border:0;background:none;padding:0',
        onchange: (e: Event) => {
          const c = (e.target as HTMLInputElement).value;
          const cur = st.get();
          const arr = [...cur[list]];
          arr[arr.length - 1 > 0 ? (list === 'penColors' ? 5 : 4) : 0] = c;
          if (list === 'penColors') set({ penColors: arr, pen: { ...cur.pen, color: c } });
          else set({ highlighterColors: arr, highlighter: { ...cur.highlighter, color: c } });
        },
      });
      return h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'muted', style: 'font-size:13px' }, 'カスタム色（パレットの一部を置換）'), h('span', { class: 'spacer' }), input);
    };
    if (t === 'pen') {
      wrap.append(
        h('h4', null, 'ペンの種類'),
        chipGroup(
          [
            { id: 'ballpoint', label: 'ボールペン' },
            { id: 'fountain', label: '万年筆' },
            { id: 'marker', label: 'サインペン' },
            { id: 'pencil', label: '鉛筆' },
          ],
          s.pen.style,
          (v) => set({ pen: { ...st.get().pen, style: v as Settings['pen']['style'] } }),
        ),
        h('h4', null, '太さ'),
        slider(0.4, 12, 0.1, s.pen.width, (v) => set({ pen: { ...st.get().pen, width: v } })),
        h('h4', null, '色'),
        swatchGroup(s.penColors, s.pen.color, (c) => set({ pen: { ...st.get().pen, color: c } })),
        customColor('penColors'),
        h('p', { class: 'muted', style: 'font-size:12px' }, `オレンジ（${RED_SHEET_ORANGE}）と赤は赤シートで消える。答えはこの色で書け。`),
      );
    } else if (t === 'highlighter') {
      wrap.append(
        h('h4', null, '太さ'),
        slider(4, 40, 1, s.highlighter.width, (v) => set({ highlighter: { ...st.get().highlighter, width: v } })),
        h('h4', null, '色'),
        swatchGroup(s.highlighterColors, s.highlighter.color, (c) => set({ highlighter: { ...st.get().highlighter, color: c } })),
        customColor('highlighterColors'),
        h('p', { class: 'muted', style: 'font-size:12px' }, '一番右の濃い緑は「暗記マーカー」。黒字の上に引くと赤シートで文字が消える。ペンを止めると直線になる。'),
      );
    } else if (t === 'eraser') {
      wrap.append(
        h('h4', null, 'モード'),
        chipGroup(
          [
            { id: 'partial', label: '部分消し' },
            { id: 'stroke', label: '線ごと消す' },
          ],
          s.eraserMode,
          (v) => set({ eraserMode: v as Settings['eraserMode'] }),
        ),
        h('h4', null, '大きさ'),
        slider(3, 60, 1, s.eraserSize, (v) => set({ eraserSize: v })),
        h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn danger', onclick: () => this.clearPage() }, icon('trash', 16), 'このページを全消去')),
      );
    } else if (t === 'tape') {
      wrap.append(
        h('p', { class: 'muted', style: 'font-size:13px;margin-top:0' }, '答えの上をなぞってテープを貼る。テープを指でタップ（またはテープツールでタップ）するとめくれる。投げ縄で囲んで「テープで隠す」もできる。'),
        h('h4', null, '幅'),
        slider(10, 60, 1, s.tapeWidth, (v) => set({ tapeWidth: v })),
      );
    } else if (t === 'lasso') {
      wrap.append(h('p', { class: 'muted', style: 'font-size:13px;margin:0' }, '囲んで選択 / タップで1つ選択。枠をドラッグで移動、角で拡大縮小、上の丸で回転。別のページへドラッグすると移動する。'));
    } else if (t === 'text') {
      wrap.append(h('p', { class: 'muted', style: 'font-size:13px;margin:0' }, 'タップした位置に文字を入力。既存の文字をタップで編集。S ペンの手書き入力（Android の手書き変換）も使える。'));
    }
    popover(anchor, wrap);
  }

  // ---------- selection menu ----------

  private positionSelMenu() {
    const sel = this.editor.selection;
    const show = this.editor.tool === 'lasso' && sel.active && !sel.dragging;
    if (!show) {
      this.selMenu.hidden = true;
      return;
    }
    if (this.selMenu.hidden || !this.selMenu.childElementCount) this.buildSelMenu();
    this.selMenu.hidden = false;
    const { cs } = sel.screenGeometry();
    const xs = cs.map((p) => p.x), ys = cs.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    let y = Math.min(...ys) - 44;
    const below = y < 60;
    if (below) y = Math.max(...ys) + 70;
    const w = this.selMenu.offsetWidth || 400;
    const W = this.stageWrap.clientWidth;
    this.selMenu.style.left = `${Math.min(W - w / 2 - 8, Math.max(w / 2 + 8, cx))}px`;
    this.selMenu.style.top = `${Math.min(this.stageWrap.clientHeight - 8, Math.max(56, y))}px`;
  }

  private buildSelMenu() {
    const sel = this.editor.selection;
    const b = (ic: IconName, label: string, fn: () => void, testid?: string) => h('button', { onclick: fn, 'data-testid': testid }, icon(ic, 18), label);
    this.selMenu.replaceChildren(
      b('trash', '削除', () => sel.delete(), 'sel-delete'),
      b('scissors', '切り取り', () => sel.cut()),
      b('copy', 'コピー', () => (sel.copy(), toast('コピーした'))),
      b('duplicate', '複製', () => sel.duplicate(), 'sel-duplicate'),
      b('palette', '色', () => {
        const s = this.app.settings.get();
        const wrap = swatchGroup([...s.penColors, '#ffffff'], '', (c) => {
          sel.recolor(c);
          close();
        });
        const close = popover(this.selMenu, wrap);
      }),
      b('tape', 'テープで隠す', () => sel.toTape(), 'sel-tape'),
    );
  }

  // ---------- actions ----------

  private async rename() {
    const doc = this.doc;
    if (!doc) return;
    const t = await promptDialog('ノート名', doc.nb.title);
    if (t) {
      doc.nb.title = t;
      this.titleEl.textContent = t;
      doc.markNotebookDirty();
    }
  }

  private toggleSheet() {
    const on = this.redSheet.toggle();
    if (on) toast('赤・オレンジの字と暗記マーカー部分が消える');
    this.sync();
  }

  private paste() {
    const doc = this.doc;
    if (!doc) return;
    const i = this.editor.currentPage;
    const page = doc.pages[i];
    const c = this.editor.visibleCenterOn(i);
    this.editor.selection.pasteInto(page.id);
    // Move the pasted block to the visible centre.
    const sel = this.editor.selection;
    if (sel.active) {
      const b = sel.bounds;
      const r = this.editor.vp.rects[i];
      sel.beginDrag('move', r.x + b.x + b.w / 2, r.y + b.y + b.h / 2);
      sel.dragTo(r.x + c.x, r.y + c.y);
      sel.endDrag();
    }
  }

  private newPageLike(ref: Page | undefined): Page {
    const doc = this.doc!;
    const base: Partial<Page> = ref && !ref.pdf ? { w: ref.w, h: ref.h, bg: { ...ref.bg } } : {};
    return this.app.repo.newPage(doc.nb, base);
  }

  addPage(at?: number) {
    const doc = this.doc;
    if (!doc) return;
    const i = at ?? this.editor.currentPage + 1;
    const p = this.newPageLike(doc.pages[Math.max(0, i - 1)]);
    doc.insertPages(i, [p]);
    this.editor.goToPage(i);
    toast(`${i + 1}ページ目を追加`);
  }

  private duplicatePage(i: number) {
    const doc = this.doc!;
    const src = doc.pages[i];
    const copy: Page = { ...src, id: uid(), strokes: src.strokes.map((s) => ({ ...s, id: uid() })), items: src.items.map((it) => ({ ...it, id: uid() })), updated: Date.now() };
    doc.insertPages(i + 1, [copy]);
  }

  private async deletePage(i: number) {
    const doc = this.doc!;
    if (doc.pages.length <= 1) return;
    doc.deletePages([doc.pages[i].id]);
    toast('ページを削除（元に戻すで復活）');
  }

  private clearPage() {
    const doc = this.doc;
    if (!doc) return;
    const page = doc.pages[this.editor.currentPage];
    const before = doc.content(page.id);
    doc.commit([{ pageId: page.id, before, after: { strokes: [], items: [] } }]);
  }

  private overview() {
    const doc = this.doc;
    if (!doc) return;
    openPageOverview(this.editor, doc, {
      duplicate: (i) => this.duplicatePage(i),
      insert: (i) => {
        const p = this.newPageLike(doc.pages[Math.max(0, i - 1)]);
        doc.insertPages(i, [p]);
      },
      remove: (i) => void this.deletePage(i),
      toggleReview: (p) => this.toggleReview(p),
      isInReview: (p) => this.reviewIds.has(p.id),
    });
  }

  private async toggleReview(page: Page) {
    const repo = this.app.repo;
    if (this.reviewIds.has(page.id)) {
      await repo.deleteReview(page.id);
      this.reviewIds.delete(page.id);
      toast('復習から外した');
    } else {
      await repo.saveReview({ id: page.id, nb: page.nb, state: newReview(Date.now()) });
      this.reviewIds.add(page.id);
      toast('復習に追加。明日出題する。');
    }
  }

  private async insertImage(capture?: boolean) {
    const doc = this.doc;
    if (!doc) return;
    const [file] = await pickFiles('image/*', capture ? { capture: 'environment' } : {});
    if (!file) return;
    const i = this.editor.currentPage;
    const page = doc.pages[i];
    const c = this.editor.visibleCenterOn(i);
    const bw = page.w * 0.6, bh = page.h * 0.5;
    const item = await imageItem(this.app.repo, file, { x: c.x - bw / 2, y: c.y - bh / 2, w: bw, h: bh });
    doc.addItems(page.id, [item]);
    this.editor.setTool('lasso');
    this.renderPalette();
    this.editor.selection.set(page.id, [item.id]);
  }

  private async insertPdf() {
    const doc = this.doc;
    if (!doc) return;
    const [file] = await pickFiles('application/pdf,.pdf');
    if (!file) return;
    toast('PDFを読み込み中…', 4000);
    try {
      const pages = await pdfToPages(this.app.repo, file, file.name, doc.nb.id);
      const at = this.editor.currentPage + 1;
      doc.insertPages(at, pages);
      this.editor.goToPage(at);
      toast(`${pages.length}ページ挿入した`);
    } catch (e) {
      toast('PDFを開けなかった: ' + (e as Error).message);
    }
  }

  private changeTemplate() {
    const doc = this.doc;
    if (!doc) return;
    const page = doc.pages[this.editor.currentPage];
    const bg: PageBackground = { ...page.bg };
    let scope: 'page' | 'all' = 'page';
    const body = h(
      'div',
      null,
      paperFields(bg, () => {}),
      h(
        'div',
        { class: 'field' },
        h('label', null, '適用範囲'),
        chipGroup(
          [
            { id: 'page', label: 'このページ' },
            { id: 'all', label: 'ノートの全ページ' },
          ],
          scope,
          (v) => (scope = v as 'page' | 'all'),
        ),
      ),
    );
    const apply = () => {
      const ids = scope === 'all' ? doc.pages.filter((p) => !p.pdf).map((p) => p.id) : [page.id];
      doc.setBackground(ids, bg);
      if (scope === 'all') {
        doc.nb.paper.bg = { ...bg };
        doc.markNotebookDirty();
      }
      m.close();
    };
    const m = modal('用紙テンプレート', body, { actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'キャンセル'), h('button', { class: 'btn primary', onclick: apply }, '適用')] });
  }

  private toggleLayout() {
    const doc = this.doc;
    if (!doc) return;
    const cur = doc.nb.layout ?? this.app.settings.get().layout;
    doc.nb.layout = cur === 'vertical' ? 'horizontal' : 'vertical';
    doc.markNotebookDirty();
    const page = this.editor.currentPage;
    this.editor.relayout(false);
    this.editor.vp.zoom = this.editor.vp.fitZoom();
    this.editor.goToPage(page);
  }

  private async exportCurrentPng() {
    const doc = this.doc;
    if (!doc) return;
    const i = this.editor.currentPage;
    const blob = await exportPng(doc.pages[i], this.app.assets, 2.5);
    await shareOrDownload(blob, `${safeFileName(doc.nb.title)}-p${i + 1}.png`);
  }

  private moreMenu(anchor: HTMLElement) {
    const doc = this.doc;
    if (!doc) return;
    const page = doc.pages[this.editor.currentPage];
    const layout = doc.nb.layout ?? this.app.settings.get().layout;
    menu(anchor, [
      { label: '画像を挿入', icon: 'image', onClick: () => this.insertImage() },
      { label: 'カメラで撮って挿入', icon: 'camera', onClick: () => this.insertImage(true) },
      { label: 'PDFのページを挿入', icon: 'fileUp', onClick: () => this.insertPdf() },
      null,
      { label: '用紙テンプレートを変更', icon: 'grid', onClick: () => this.changeTemplate() },
      { label: layout === 'vertical' ? '横めくりにする' : '縦スクロールにする', icon: layout === 'vertical' ? 'columns' : 'rows', onClick: () => this.toggleLayout() },
      { label: this.reviewIds.has(page.id) ? 'このページを復習から外す' : 'このページを復習に追加', icon: 'brain', onClick: () => this.toggleReview(page) },
      { label: '全テープを隠す', icon: 'eyeOff', onClick: () => this.editor.setAllTapes(true) },
      { label: '全テープをめくる', icon: 'eye', onClick: () => this.editor.setAllTapes(false) },
      null,
      { label: 'PDFで書き出し / 共有', icon: 'download', onClick: () => exportNotebookPdfDialog(this.app, doc.nb, { all: doc.pages, current: page }) },
      { label: 'このページを画像で共有', icon: 'share', onClick: () => this.exportCurrentPng() },
      {
        label: 'ノートを .sumi で共有',
        icon: 'share',
        onClick: async () => {
          await doc.flush();
          const zip = await exportBackup(this.app.repo, [doc.nb.id]);
          await shareOrDownload(new Blob([zip as BlobPart], { type: 'application/zip' }), `${safeFileName(doc.nb.title)}.sumi`);
        },
      },
      null,
      { label: 'このページを削除', icon: 'trash', danger: true, disabled: doc.pages.length <= 1, onClick: () => this.deletePage(this.editor.currentPage) },
      { label: '設定', icon: 'settings', onClick: () => openSettings(this.app) },
    ]);
  }

  // ---------- review mode ----------

  private async showReviewItem(): Promise<boolean> {
    const r = this.review!;
    while (r.index < r.queue.length) {
      const rec = r.queue[r.index];
      const nb = await this.app.repo.getNotebook(rec.nb);
      if (nb && !nb.trashed && nb.pages.includes(rec.id)) {
        if (this.doc?.nb.id !== nb.id) await this.load(nb.id);
        const i = this.doc!.indexOf(rec.id);
        // Every answer starts hidden.
        this.editor.setAllTapes(true);
        this.editor.goToPage(i);
        this.renderReviewBar(rec, nb);
        return true;
      }
      r.index++;
    }
    return false;
  }

  private renderReviewBar(rec: ReviewRecord, nb: Notebook) {
    const r = this.review!;
    const g = (n: Grade, label: string) =>
      h('button', { class: `grade g${n}`, 'data-testid': `grade-${n}`, onclick: () => this.gradeCurrent(n) }, label, h('small', null, formatInterval(nextInterval(rec.state, n))));
    r.bar.replaceChildren(
      h('div', { style: 'font-size:13px;padding:0 6px' }, h('b', null, `復習 ${r.index + 1}/${r.queue.length}`), h('div', { class: 'muted', style: 'max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, nb.title)),
      h('button', { class: 'btn small', onclick: () => this.editor.setAllTapes(false) }, icon('eye', 16), '答え'),
      g(1, 'もう一回'),
      g(2, '難しい'),
      g(3, '普通'),
      g(4, '簡単'),
      h('button', { class: 'icon-btn', 'aria-label': '復習を終了', onclick: () => this.app.go('#/') }, icon('close')),
    );
  }

  private async gradeCurrent(n: Grade) {
    const r = this.review!;
    const rec = r.queue[r.index];
    const next: ReviewRecord = { ...rec, state: grade(rec.state, n, Date.now()) };
    await this.app.repo.saveReview(next);
    r.index++;
    if (!(await this.showReviewItem())) {
      toast(`今日の復習 ${r.queue.length}ページ完了。`, 2500);
      this.app.go('#/');
    }
  }

  // ---------- keyboard ----------

  private handleKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (document.querySelector('.modal-backdrop')) return;
    const ed = this.editor;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) ed.redo();
      else ed.undo();
    } else if (mod && k === 'y') {
      e.preventDefault();
      ed.redo();
    } else if (mod && k === 'c') ed.selection.copy();
    else if (mod && k === 'x') ed.selection.cut();
    else if (mod && k === 'v') this.paste();
    else if (mod && k === 'd') {
      e.preventDefault();
      ed.selection.duplicate();
    } else if ((k === 'delete' || k === 'backspace') && ed.selection.active) ed.selection.delete();
    else if (k === 'escape') ed.selection.clear();
    else if (!mod && (k === '+' || k === '=')) ed.setZoom(ed.vp.zoom * 1.2);
    else if (!mod && k === '-') ed.setZoom(ed.vp.zoom / 1.2);
    else if (!mod && k === '0') ed.fitWidth();
    else if (!mod && (k === 'pagedown' || k === 'arrowright')) ed.goToPage(Math.min(this.doc!.pages.length - 1, ed.currentPage + 1));
    else if (!mod && (k === 'pageup' || k === 'arrowleft')) ed.goToPage(Math.max(0, ed.currentPage - 1));
    else if (!mod && !e.altKey) {
      const tool = TOOLS.find((x) => x.key === k);
      if (tool) {
        ed.setTool(tool.id);
        this.renderPalette();
      }
    }
  }
}

import type { Notebook } from '../core/types';
import { EditorDoc } from '../editor/doc';
import { Editor } from '../editor/editor';
import { importPdfAsNotebook } from '../pdf/import';
import { formatDate, h } from '../ui/dom';
import { modal, pickFiles, toast } from '../ui/dialogs';
import { icon } from '../ui/icons';
import type { App } from './app';

const WIDTH_KEY = 'sumi.refWidth';

/**
 * 参照ビュー: a read-only second notebook beside the one being written in — the
 * problem PDF on the left, the answer notebook on the right. The pen scrolls here.
 */
export class RefPane {
  readonly el: HTMLElement;
  readonly divider: HTMLElement;
  private editor: Editor;
  private doc: EditorDoc | null = null;
  private title: HTMLElement;
  private pill: HTMLElement;
  private unsub: () => void;
  nbId: string | null = null;

  constructor(private app: App, private body: HTMLElement, private onClose: () => void) {
    this.title = h('div', { class: 'ref-title' });
    this.pill = h('button', { class: 'tb-pill', onclick: () => this.editor.fitWidth() });
    const stage = h('div', { class: 'ref-stage' });
    this.el = h(
      'div',
      { class: 'ref-pane', 'data-testid': 'ref-pane' },
      h(
        'div',
        { class: 'ref-head' },
        icon('book', 16),
        this.title,
        this.pill,
        h('button', { class: 'icon-btn', 'aria-label': '別のノートを参照', title: '別のノートを参照', onclick: () => void this.pick() }, icon('folder', 18)),
        h('button', { class: 'icon-btn', 'aria-label': '参照ビューを閉じる', title: '閉じる', onclick: () => this.onClose() }, icon('close', 18)),
      ),
      stage,
    );
    this.divider = h('div', { class: 'ref-divider', role: 'separator', 'aria-label': '幅を変更' });
    body.prepend(this.el, this.divider);
    this.editor = new Editor(stage, app.settings, app.assets);
    this.editor.readOnly = true;
    const cs = getComputedStyle(document.documentElement);
    this.editor.renderer.desk = cs.getPropertyValue('--desk').trim() || '#e4e5e9';
    this.unsub = this.editor.subscribe(() => {
      if (this.doc) this.pill.textContent = `${this.editor.currentPage + 1} / ${this.doc.pages.length}`;
    });
    this.applyWidth(this.loadWidth());
    this.dragDivider();
  }

  private loadWidth(): number {
    try {
      const v = Number(localStorage.getItem(WIDTH_KEY));
      if (v > 0.15 && v < 0.85) return v;
    } catch {
      /* ignore */
    }
    return 0.46;
  }

  private applyWidth(f: number) {
    this.el.style.flexBasis = `${f * 100}%`;
  }

  private dragDivider() {
    let start: { x: number; w: number; total: number } | null = null;
    let f = this.loadWidth();
    this.divider.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, w: this.el.getBoundingClientRect().width, total: this.body.getBoundingClientRect().width };
      this.divider.setPointerCapture(e.pointerId);
    });
    this.divider.addEventListener('pointermove', (e) => {
      if (!start) return;
      f = Math.min(0.8, Math.max(0.2, (start.w + e.clientX - start.x) / start.total));
      this.applyWidth(f);
    });
    const end = () => {
      if (!start) return;
      start = null;
      try {
        localStorage.setItem(WIDTH_KEY, String(f));
      } catch {
        /* ignore */
      }
    };
    this.divider.addEventListener('pointerup', end);
    this.divider.addEventListener('pointercancel', end);
  }

  async open(nbId: string): Promise<boolean> {
    const nb = await this.app.repo.getNotebook(nbId);
    if (!nb || nb.trashed) return false;
    const pages = await this.app.repo.loadPages(nb);
    this.editor.close();
    this.doc = new EditorDoc(this.app.repo, nb, pages, true);
    this.nbId = nb.id;
    this.title.textContent = nb.title;
    this.editor.open(this.doc);
    return true;
  }

  /** Choose which notebook to show (or import a PDF for it). */
  async pick(excludeId?: string): Promise<boolean> {
    const list = (await this.app.repo.listNotebooks()).filter((n) => n.id !== excludeId).sort((a, b) => Math.max(b.updated, b.opened) - Math.max(a.updated, a.opened));
    return new Promise((resolve) => {
      let done = false;
      const choose = async (nb: Notebook) => {
        done = true;
        m.close();
        resolve(await this.open(nb.id));
      };
      const body = h(
        'div',
        { class: 'menu' },
        h(
          'button',
          {
            class: 'menu-item',
            onclick: async () => {
              const [file] = await pickFiles('application/pdf,.pdf');
              if (!file) return;
              toast('PDFを読み込み中…', 4000);
              const nb = await importPdfAsNotebook(this.app.repo, file, null);
              await choose(nb);
            },
          },
          icon('fileUp', 18),
          h('span', null, 'PDFを取り込んで参照'),
        ),
        h('div', { class: 'menu-sep' }),
        list.map((nb) => h('button', { class: 'menu-item', 'data-testid': 'ref-choice', onclick: () => void choose(nb) }, icon('book', 18), h('span', null, nb.title), h('small', { class: 'muted' }, formatDate(Math.max(nb.updated, nb.opened))))),
      );
      const m = modal('参照するノート', body, {
        onClose: () => {
          if (!done) resolve(false);
        },
      });
    });
  }

  destroy() {
    this.unsub();
    this.editor.close();
    this.editor.destroy();
    this.el.remove();
    this.divider.remove();
  }
}

import type { Page } from '../core/types';
import type { EditorDoc } from '../editor/doc';
import type { Editor } from '../editor/editor';
import { thumbnail } from '../pdf/export';
import { formatDuration, h } from '../ui/dom';
import { menu, modal, promptDialog } from '../ui/dialogs';
import { icon } from '../ui/icons';

export interface PageOverviewActions {
  duplicate(i: number): void;
  insert(i: number): void;
  remove(i: number): void;
  toggleReview(page: Page): Promise<void>;
  isInReview(page: Page): boolean;
  /** Seconds spent writing on the page. */
  spent(page: Page): number;
  /** Copy (or move) the page to the end of another notebook. */
  sendTo(page: Page, move: boolean): void;
  /** ページの履歴: pick an earlier state of the page. */
  history(page: Page): void;
  /** しおり: label to bookmark, undefined to remove. */
  setMark(page: Page, label: string | undefined): void;
}

/** What a bookmark is called in lists: its label, else the start of the page's text. */
export function markLabel(page: Page, index: number): string {
  const text = (page.mark || page.ink || page.text || '').replace(/\s+/g, ' ').trim();
  return text ? (text.length > 28 ? text.slice(0, 28) + '…' : text) : `${index + 1}ページ`;
}

/** Grid of page thumbnails: jump, reorder by dragging, per-page actions. */
export function openPageOverview(editor: Editor, doc: EditorDoc, actions: PageOverviewActions) {
  const grid = h('div', { class: 'pages-grid' });
  const toc = h('div', { class: 'toc', 'data-testid': 'toc' });
  const marks = h('div', { class: 'toc', 'data-testid': 'marks' });
  const m = modal(`ページ一覧（${doc.pages.length}）`, h('div', null, marks, toc, grid), { wide: true });
  const current = editor.currentPage;
  void renderToc(toc, editor, doc, () => m.close());

  const rename = async (page: Page, i: number) => {
    const v = await promptDialog('しおりの名前', page.mark ?? '', markLabel(page, i));
    if (v === null) return;
    actions.setMark(page, v);
    render();
  };

  const renderMarks = () => {
    const marked = doc.pages.map((p, i) => [p, i] as const).filter(([p]) => p.mark !== undefined);
    if (!marked.length) return marks.replaceChildren();
    const list = h(
      'div',
      { class: 'toc-list' },
      marked.map(([p, i]) =>
        h(
          'div',
          { class: 'toc-item mark-item', 'data-testid': 'mark-item' },
          h(
            'button',
            {
              class: 'mark-go',
              onclick: () => {
                m.close();
                editor.goToPage(i);
              },
            },
            icon('bookmark', 15),
            h('span', null, markLabel(p, i)),
            h('span', { class: 'muted' }, `p.${i + 1}`),
          ),
          h('button', { class: 'icon-btn', 'aria-label': 'しおりの名前を変更', onclick: () => void rename(p, i) }, icon('pencil', 15)),
        ),
      ),
    );
    marks.replaceChildren(h('div', { class: 'field-label' }, 'しおり'), list);
  };

  const render = () => {
    renderMarks();
    grid.replaceChildren();
    doc.pages.forEach((page, i) => {
      const cv = thumbnail(page, editor.assets, 150);
      const more = h('button', { class: 'more', 'aria-label': 'ページのメニュー' }, icon('dots', 16));
      const cell = h(
        'div',
        { class: 'page-thumb' + (i === current ? ' current' : ''), 'data-index': i },
        cv,
        h(
          'div',
          { class: 'num' },
          `${i + 1}`,
          actions.isInReview(page) ? h('span', { class: 'badge' }, icon('brain', 11), '復習') : null,
          actions.spent(page) >= 60 ? h('span', { class: 'spent', title: 'このページに書いていた時間' }, icon('timer', 11), formatDuration(actions.spent(page))) : null,
        ),
        page.mark !== undefined ? h('span', { class: 'mark-ribbon', title: markLabel(page, i) }) : null,
        more,
      );
      more.addEventListener('pointerdown', (e) => e.stopPropagation());
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        menu(more, [
          { label: '前にページを挿入', icon: 'filePlus', onClick: () => (actions.insert(i), render()) },
          { label: '後ろにページを挿入', icon: 'filePlus', onClick: () => (actions.insert(i + 1), render()) },
          { label: '複製', icon: 'duplicate', onClick: () => (actions.duplicate(i), render()) },
          { label: actions.isInReview(page) ? '復習から外す' : '復習に追加', icon: 'brain', onClick: async () => (await actions.toggleReview(page), render()) },
          page.mark === undefined
            ? { label: 'しおりを付ける', icon: 'bookmark', onClick: () => (actions.setMark(page, ''), render()) }
            : { label: 'しおりを外す', icon: 'bookmark', onClick: () => (actions.setMark(page, undefined), render()) },
          ...(page.mark !== undefined ? [{ label: 'しおりの名前を変更', icon: 'pencil' as const, onClick: () => void rename(page, i) }] : []),
          { label: '履歴から復元', icon: 'reset', onClick: () => (m.close(), actions.history(page)) },
          { label: 'ほかのノートへコピー', icon: 'copy', onClick: () => (m.close(), actions.sendTo(page, false)) },
          { label: 'ほかのノートへ移動', icon: 'fileUp', disabled: doc.pages.length <= 1, onClick: () => (m.close(), actions.sendTo(page, true)) },
          null,
          { label: '削除', icon: 'trash', danger: true, disabled: doc.pages.length <= 1, onClick: () => (actions.remove(i), render()) },
        ]);
      });
      attachDrag(cell, i);
      grid.appendChild(cell);
    });
  };

  // Long-press-free reordering: drag a thumbnail; tap to jump.
  const attachDrag = (cell: HTMLElement, index: number) => {
    let start: { x: number; y: number } | null = null;
    let dragging = false;
    let target = -1;
    cell.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY };
      dragging = false;
      cell.setPointerCapture(e.pointerId);
    });
    cell.addEventListener('pointermove', (e) => {
      if (!start) return;
      if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12) {
        dragging = true;
        cell.classList.add('dragging');
      }
      if (!dragging) return;
      grid.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.page-thumb') as HTMLElement | null;
      if (el && el !== cell) {
        const r = el.getBoundingClientRect();
        let t = Number(el.dataset.index);
        if (e.clientX > r.left + r.width / 2) t += 1;
        target = t;
        const marker = grid.querySelector(`.page-thumb[data-index="${t}"]`);
        marker?.classList.add('drop-before');
      }
    });
    const end = () => {
      if (!start) return;
      start = null;
      cell.classList.remove('dragging');
      grid.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
      if (!dragging) {
        m.close();
        editor.goToPage(index);
        return;
      }
      if (target >= 0) {
        const to = target > index ? target - 1 : target;
        doc.movePage(index, Math.min(to, doc.pages.length - 1));
        render();
      }
      target = -1;
    };
    cell.addEventListener('pointerup', end);
    cell.addEventListener('pointercancel', () => {
      start = null;
      cell.classList.remove('dragging');
    });
  };

  render();
}

/** Table of contents from the bookmarks of the PDFs in this notebook. */
async function renderToc(host: HTMLElement, editor: Editor, doc: EditorDoc, close: () => void) {
  const assets = [...new Set(doc.pages.map((p) => p.pdf?.asset).filter((a): a is string => !!a))];
  const sections: HTMLElement[] = [];
  for (const id of assets) {
    const a = await doc.repo.getAsset(id);
    if (!a?.outline?.length) continue;
    const list = h('div', { class: 'toc-list' });
    for (const e of a.outline) {
      list.appendChild(
        h(
          'button',
          {
            class: 'toc-item',
            style: `padding-left:${10 + e.level * 18}px`,
            onclick: () => {
              const i = doc.pages.findIndex((p) => p.pdf?.asset === id && p.pdf.index === e.index);
              if (i < 0) return;
              close();
              editor.goToPage(i);
            },
          },
          h('span', null, e.title),
          h('span', { class: 'muted' }, `p.${e.index + 1}`),
        ),
      );
    }
    sections.push(h('div', null, h('div', { class: 'field-label' }, `目次${assets.length > 1 && a.name ? `（${a.name}）` : ''}`), list));
  }
  host.replaceChildren(...sections);
}

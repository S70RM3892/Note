import type { Page } from '../core/types';
import type { EditorDoc } from '../editor/doc';
import type { Editor } from '../editor/editor';
import { thumbnail } from '../pdf/export';
import { h } from '../ui/dom';
import { menu, modal } from '../ui/dialogs';
import { icon } from '../ui/icons';

export interface PageOverviewActions {
  duplicate(i: number): void;
  insert(i: number): void;
  remove(i: number): void;
  toggleReview(page: Page): Promise<void>;
  isInReview(page: Page): boolean;
}

/** Grid of page thumbnails: jump, reorder by dragging, per-page actions. */
export function openPageOverview(editor: Editor, doc: EditorDoc, actions: PageOverviewActions) {
  const grid = h('div', { class: 'pages-grid' });
  const m = modal(`ページ一覧（${doc.pages.length}）`, grid, { wide: true });
  const current = editor.currentPage;

  const render = () => {
    grid.replaceChildren();
    doc.pages.forEach((page, i) => {
      const cv = thumbnail(page, editor.assets, 150);
      const more = h('button', { class: 'more', 'aria-label': 'ページのメニュー' }, icon('dots', 16));
      const cell = h(
        'div',
        { class: 'page-thumb' + (i === current ? ' current' : ''), 'data-index': i },
        cv,
        h('div', { class: 'num' }, `${i + 1}`, actions.isInReview(page) ? h('span', { class: 'badge' }, icon('brain', 11), '復習') : null),
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

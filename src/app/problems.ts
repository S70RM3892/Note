/** 問題ごとのノート: the heading on each board, and the board picker (問題を選ぶ). */
import { uid } from '../core/id';
import { problemGroups, RESULT_MARK, resultCounts, type ProblemGroup } from '../core/problems';
import type { Page, TextItem } from '../core/types';
import { layoutText } from '../editor/paint';
import { formatDuration, h } from '../ui/dom';
import { modal } from '../ui/dialogs';

const MM = 96 / 25.4;

/** The problem's label in the top-left corner (locked: the lasso and eraser leave it alone). */
export function headerItem(page: Page, label: string): TextItem {
  const size = 18;
  const lay = layoutText(label, size, page.w);
  return { id: uid(), type: 'text', x: 10 * MM, y: 6 * MM, w: lay.w, h: lay.h, rot: 0, text: label, size, color: '#3b5bdb', locked: true };
}

type Filter = 'all' | 'todo' | 'o' | 'd' | 'x' | 'review';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'すべて' },
  { id: 'todo', label: '未着手' },
  { id: 'x', label: '×' },
  { id: 'd', label: '△' },
  { id: 'o', label: '○' },
  { id: 'review', label: '復習中' },
];

let lastFilter: Filter = 'all';

export interface PickerOptions {
  pages: Page[];
  current: number;
  inReview(pageId: string): boolean;
  /** Seconds written on a page. */
  spent(pageId: string): number;
  go(pageIndex: number): void;
  /** The page thumbnails instead. */
  overview(): void;
}

/** Every problem as a tile (○△×, 復習中, time spent): tap one to go to its board. */
export function openProblemPicker(o: PickerOptions) {
  const groups = problemGroups(o.pages);
  const c = resultCounts(groups);
  const grid = h('div', { class: 'prob-grid', 'data-testid': 'prob-grid' });
  const inReview = (g: ProblemGroup) => g.pages.some((i) => o.inReview(o.pages[i].id));
  const keep = (g: ProblemGroup, f: Filter) =>
    f === 'all' ? true : f === 'todo' ? !g.result && !g.written : f === 'review' ? inReview(g) : g.result === f;
  const paint = (f: Filter) => {
    lastFilter = f;
    grid.replaceChildren(
      ...groups
        .filter((g) => keep(g, f))
        .map((g) => {
          const sec = g.pages.reduce((s, i) => s + o.spent(o.pages[i].id), 0);
          const here = g.pages.includes(o.current);
          return h(
            'button',
            {
              class: `prob-cell${g.result ? ' ' + g.result : g.written ? ' written' : ''}${here ? ' current' : ''}`,
              'data-testid': 'prob-cell',
              onclick: () => {
                m.close();
                o.go(g.pages[0]);
              },
            },
            h('b', null, g.label),
            h('span', { class: 'prob-mark' }, g.result ? RESULT_MARK[g.result] : ''),
            h('small', null, [g.pages.length > 1 ? `${g.pages.length}枚` : '', sec >= 60 ? formatDuration(sec) : ''].filter(Boolean).join('・')),
            inReview(g) ? h('i', { class: 'prob-review', title: '復習中' }) : null,
          );
        }),
    );
    if (!grid.childElementCount) grid.append(h('p', { class: 'muted' }, '該当する問題はない。'));
  };
  const chips = h(
    'div',
    { class: 'chips' },
    FILTERS.map((f) =>
      h(
        'button',
        {
          class: 'chip' + (f.id === lastFilter ? ' on' : ''),
          'data-testid': `prob-filter-${f.id}`,
          onclick: (e: Event) => {
            chips.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === e.currentTarget));
            paint(f.id);
          },
        },
        f.label,
      ),
    ),
  );
  const m = modal(
    `問題（${c.total}）`,
    h(
      'div',
      null,
      h('div', { class: 'row prob-summary', 'data-testid': 'prob-summary' }, h('span', null, `○ ${c.o}`), h('span', null, `△ ${c.d}`), h('span', null, `× ${c.x}`), h('span', { class: 'muted' }, `未着手 ${c.todo}`), h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: () => (m.close(), o.overview()) }, 'ページ一覧')),
      chips,
      grid,
    ),
    { wide: true },
  );
  paint(lastFilter);
  // Bring the current problem into view.
  setTimeout(() => grid.querySelector('.current')?.scrollIntoView({ block: 'center' }), 0);
}

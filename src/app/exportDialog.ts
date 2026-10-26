import type { Notebook, Page } from '../core/types';
import { exportPdf, type TapeExport } from '../pdf/export';
import { h } from '../ui/dom';
import { modal, safeFileName, shareOrDownload, toast } from '../ui/dialogs';
import type { App } from './app';
import { chipGroup } from './newNotebook';

/** Ask how tapes should appear, then export the notebook (or given pages) as a PDF. */
export function exportNotebookPdfDialog(app: App, nb: Notebook, live?: { all: Page[]; current: Page }) {
  let tapes: TapeExport = 'hide';
  let range: 'all' | 'current' = 'all';
  const body = h(
    'div',
    null,
    h(
      'div',
      { class: 'field' },
      h('label', null, '暗記テープ'),
      chipGroup<TapeExport>(
        [
          { id: 'hide', label: '隠したまま（問題用）' },
          { id: 'omit', label: '外す（解答用）' },
          { id: 'normal', label: '今の状態' },
        ],
        tapes,
        (v) => (tapes = v),
      ),
    ),
    live
      ? h(
          'div',
          { class: 'field' },
          h('label', null, '範囲'),
          chipGroup<'all' | 'current'>(
            [
              { id: 'all', label: 'ノート全体' },
              { id: 'current', label: 'このページ' },
            ],
            range,
            (v) => (range = v),
          ),
        )
      : null,
    h('p', { class: 'muted', style: 'font-size:13px' }, '手書きはベクターのまま、取り込んだPDFは元の画質のまま書き出す。'),
  );
  const go = async () => {
    m.close();
    toast('PDFを作成中…', 6000);
    try {
      const list = live ? (range === 'current' ? [live.current] : live.all) : await app.repo.loadPages(nb);
      const blob = await exportPdf(app.repo, list, { tapes, title: nb.title });
      await shareOrDownload(blob, `${safeFileName(nb.title)}.pdf`);
    } catch (e) {
      console.error(e);
      toast('書き出しに失敗: ' + (e as Error).message, 3000);
    }
  };
  const m = modal('PDFで書き出し', body, {
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'キャンセル'), h('button', { class: 'btn primary', onclick: go, 'data-testid': 'do-export' }, '書き出す')],
  });
}

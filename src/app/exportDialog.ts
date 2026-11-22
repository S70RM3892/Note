import { formatPageRanges, parsePageRanges } from '../core/pages';
import type { Notebook, Page, Rect } from '../core/types';
import { exportPdf, type TapeExport } from '../pdf/export';
import { h } from '../ui/dom';
import { modal, safeFileName, shareOrDownload, toast } from '../ui/dialogs';
import type { App } from './app';
import { chipGroup } from './newNotebook';

/**
 * Ask how tapes should appear and which pages, then export the notebook as a PDF.
 * `live`: the pages as they are in the open editor (and the page being looked at).
 */
export function exportNotebookPdfDialog(app: App, nb: Notebook, live?: { all: Page[]; current: Page }) {
  type Range = 'all' | 'current' | 'pages';
  let tapes: TapeExport = 'hide';
  let range: Range = 'all';
  const total = live ? live.all.length : nb.pages.length;
  const cur = live ? Math.max(0, live.all.indexOf(live.current)) : 0;
  const pagesInput = h('input', {
    class: 'input',
    'data-testid': 'export-pages',
    placeholder: `例: 1-3, 5, 8-（全${total}ページ）`,
    value: live ? `${cur + 1}-${total}` : '',
    inputmode: 'text',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const note = h('p', { class: 'muted export-range-note', 'data-testid': 'export-note' });
  const pagesField = h(
    'div',
    { class: 'field export-pages', hidden: true },
    h('label', null, 'ページ'),
    pagesInput,
    h(
      'div',
      { class: 'chips', style: 'margin-top:8px' },
      live ? h('button', { class: 'chip', onclick: () => preset(`${cur + 1}-`) }, 'このページから最後まで') : null,
      live ? h('button', { class: 'chip', onclick: () => preset(`1-${cur + 1}`) }, '最初からこのページまで') : null,
      h('button', { class: 'chip', onclick: () => preset(`${Math.max(1, total - 4)}-${total}`) }, '最後の5ページ'),
    ),
    note,
  );
  const preset = (v: string) => {
    pagesInput.value = v;
    check();
  };
  const picked = () => (range === 'pages' ? parsePageRanges(pagesInput.value, total) : null);
  const check = () => {
    if (range !== 'pages') return;
    const idx = picked();
    note.textContent = idx ? `${idx.length}ページを書き出す（${formatPageRanges(idx)}）` : `ページ番号を「1-3, 5, 8-」のように書く（1〜${total}）`;
    note.classList.toggle('bad', !idx);
    goBtn.disabled = !idx;
  };
  pagesInput.addEventListener('input', check);
  const options: { id: Range; label: string }[] = [{ id: 'all', label: 'ノート全体' }];
  if (live) options.push({ id: 'current', label: 'このページ' });
  options.push({ id: 'pages', label: 'ページを指定' });
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
    h(
      'div',
      { class: 'field', 'data-testid': 'export-range' },
      h('label', null, '範囲'),
      chipGroup<Range>(options, range, (v) => {
        range = v;
        pagesField.hidden = v !== 'pages';
        goBtn.disabled = false;
        check();
        if (v === 'pages') pagesInput.focus();
      }),
    ),
    pagesField,
    h('p', { class: 'muted', style: 'font-size:13px' }, '手書きはベクターのまま、取り込んだPDFは元の画質のまま書き出す。ページの一部だけなら、投げ縄で囲んで「PDFで書き出す」。'),
  );
  const go = async () => {
    const idx = picked();
    if (range === 'pages' && !idx) return;
    m.close();
    toast('PDFを作成中…', 6000);
    try {
      const all = live ? live.all : await app.repo.loadPages(nb);
      const list = range === 'current' && live ? [live.current] : idx ? idx.map((i) => all[i]).filter(Boolean) : all;
      const blob = await exportPdf(app.repo, list, { tapes, title: nb.title });
      const suffix = range === 'current' ? `_p${cur + 1}` : idx ? `_p${formatPageRanges(idx).replace(/, /g, '_')}` : '';
      await shareOrDownload(blob, `${safeFileName(nb.title)}${suffix}.pdf`);
    } catch (e) {
      console.error(e);
      toast('書き出しに失敗: ' + (e as Error).message, 3000);
    }
  };
  const goBtn = h('button', { class: 'btn primary', onclick: go, 'data-testid': 'do-export' }, '書き出す') as HTMLButtonElement;
  const m = modal('PDFで書き出し', body, {
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'キャンセル'), goBtn],
  });
}

/** Export one part of a page (a lassoed area or the selection's box) as a one-page PDF of that size. */
export async function exportRegionPdf(app: App, nb: Notebook, page: Page, pageNo: number, rect: Rect) {
  toast('PDFを作成中…', 6000);
  try {
    const blob = await exportPdf(app.repo, [page], { tapes: 'normal', title: nb.title, region: rect });
    await shareOrDownload(blob, `${safeFileName(nb.title)}_p${pageNo}_part.pdf`);
  } catch (e) {
    console.error(e);
    toast('書き出しに失敗: ' + (e as Error).message, 3000);
  }
}

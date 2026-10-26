import { PAPER_COLORS, PAPER_SIZES, TEMPLATES } from '../core/paper';
import type { Folder, Notebook, PageBackground, TemplateId } from '../core/types';
import { COVER_COLORS } from '../store/repo';
import { h } from '../ui/dom';
import { modal } from '../ui/dialogs';
import type { App } from './app';

export function chipGroup<T extends string>(options: { id: T; label: string }[], value: T, onChange: (v: T) => void): HTMLElement {
  const wrap = h('div', { class: 'chips' });
  const render = (v: T) => {
    wrap.replaceChildren(
      ...options.map((o) =>
        h(
          'button',
          {
            class: 'chip' + (o.id === v ? ' on' : ''),
            onclick: () => {
              onChange(o.id);
              render(o.id);
            },
          },
          o.label,
        ),
      ),
    );
  };
  render(value);
  return wrap;
}

export function swatchGroup(colors: string[], value: string, onChange: (c: string) => void, testid?: string): HTMLElement {
  const wrap = h('div', { class: 'swatches' });
  const render = (v: string) =>
    wrap.replaceChildren(
      ...colors.map((c) =>
        h('button', {
          class: 'swatch' + (c.toLowerCase() === v.toLowerCase() ? ' on' : ''),
          style: `background:${c}`,
          'aria-label': c,
          'data-testid': testid,
          onclick: () => {
            onChange(c);
            render(c);
          },
        }),
      ),
    );
  render(value);
  return wrap;
}

export function paperFields(bg: PageBackground, onChange: () => void): HTMLElement {
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'field' },
      h('label', null, 'テンプレート'),
      chipGroup(
        TEMPLATES.map((t) => ({ id: t.id, label: t.label })),
        bg.tpl,
        (v: TemplateId) => {
          bg.tpl = v;
          bg.spacing = TEMPLATES.find((t) => t.id === v)!.spacing;
          onChange();
        },
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', null, '罫線・方眼の間隔'),
      chipGroup(
        ['4', '5', '6', '7', '8', '10'].map((s) => ({ id: s, label: `${s}mm` })),
        String(bg.spacing),
        (v) => {
          bg.spacing = Number(v);
          onChange();
        },
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', null, '紙の色'),
      swatchGroup(
        PAPER_COLORS.map((p) => p.color),
        bg.color,
        (c) => {
          bg.color = c;
          onChange();
        },
      ),
    ),
  );
}

export function newNotebookDialog(app: App, folders: Folder[], folder: string | null): Promise<Notebook | null> {
  return new Promise((resolve) => {
    const s = app.settings.get();
    let size = s.defaultPaper.size;
    const bg: PageBackground = { tpl: s.defaultPaper.tpl as TemplateId, spacing: s.defaultPaper.spacing, color: s.defaultPaper.color };
    let cover = COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)];
    let target = folder;
    let result: Notebook | null = null;
    const title = h('input', { class: 'input', placeholder: '例: 数学 微積演習', 'data-testid': 'nb-title' });
    const body = h(
      'div',
      null,
      h('div', { class: 'field' }, h('label', null, 'タイトル'), title),
      folders.length
        ? h(
            'div',
            { class: 'field' },
            h('label', null, 'フォルダ'),
            chipGroup([{ id: '', label: 'なし' }, ...folders.map((f) => ({ id: f.id, label: f.name }))], target ?? '', (v) => (target = v || null)),
          )
        : null,
      h('div', { class: 'field' }, h('label', null, '用紙サイズ'), chipGroup(PAPER_SIZES.map((p) => ({ id: p.id, label: p.label })), size, (v) => (size = v))),
      paperFields(bg, () => {}),
      h('div', { class: 'field' }, h('label', null, '表紙の色'), swatchGroup(COVER_COLORS, cover, (c) => (cover = c))),
    );
    const create = async () => {
      const { nb } = await app.repo.createNotebook({ title: title.value.trim() || '無題のノート', folder: target, size, bg: { ...bg }, cover });
      app.settings.update({ defaultPaper: { size, tpl: bg.tpl, spacing: bg.spacing, color: bg.color } });
      result = nb;
      m.close();
    };
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void create();
    });
    const m = modal('新しいノート', body, {
      actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'キャンセル'), h('button', { class: 'btn primary', onclick: create, 'data-testid': 'create-notebook' }, '作成')],
      onClose: () => resolve(result),
    });
    setTimeout(() => title.focus(), 50);
  });
}

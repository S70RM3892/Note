import { uid } from '../core/id';
import type { Folder, Notebook } from '../core/types';
import { importPdfAsNotebook } from '../pdf/import';
import { exportBackup, importBackup } from '../store/backup';
import { COVER_COLORS } from '../store/repo';
import { append, clear, formatDate, formatDuration, h } from '../ui/dom';
import { confirmDialog, menu, modal, pickFiles, promptDialog, safeFileName, shareOrDownload, toast } from '../ui/dialogs';
import { icon } from '../ui/icons';
import type { App, View } from './app';
import { importImagesAsNotebook } from './importers';
import { newNotebookDialog } from './newNotebook';
import { openSettings } from './settingsView';
import { exportNotebookPdfDialog } from './exportDialog';

type FolderFilter = 'all' | 'fav' | string;

export class LibraryView implements View {
  readonly el: HTMLElement;
  private grid: HTMLElement;
  private folderBar: HTMLElement;
  private strip: HTMLElement;
  private notebooks: Notebook[] = [];
  private folders: Folder[] = [];
  private filter: FolderFilter = 'all';
  private query = '';
  private unsub: () => void;

  constructor(private app: App) {
    try {
      this.filter = localStorage.getItem('sumi.folder') || 'all';
    } catch {
      /* ignore */
    }
    const search = h('input', {
      class: 'input',
      type: 'search',
      placeholder: 'ノートを検索',
      oninput: (e: Event) => {
        this.query = (e.target as HTMLInputElement).value.trim().toLowerCase();
        this.renderGrid();
      },
    });
    this.grid = h('div', { class: 'nb-grid' });
    this.folderBar = h('div', { class: 'folders' });
    this.strip = h('div', { class: 'study-strip' });
    this.el = h(
      'div',
      { class: 'lib' },
      h(
        'header',
        { class: 'lib-head' },
        h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, '墨'), 'Sumi Note'),
        h('div', { class: 'search' }, icon('search', 18), search),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', onclick: () => this.create(), 'data-testid': 'new-notebook' }, icon('plus', 18), h('span', null, '新規ノート')),
        h('button', { class: 'btn', onclick: () => this.importPdf(), 'data-testid': 'import-pdf' }, icon('fileUp', 18), h('span', null, 'PDF取込')),
        h('button', { class: 'icon-btn', 'aria-label': 'メニュー', onclick: (e: Event) => this.mainMenu(e.currentTarget as HTMLElement) }, icon('more')),
      ),
      h('div', { class: 'lib-scroll' }, this.strip, this.folderBar, this.grid),
    );
    this.unsub = app.stats.subscribe(() => void this.renderStrip());
    void this.load();
  }

  destroy() {
    this.unsub();
  }

  private async load() {
    [this.notebooks, this.folders] = await Promise.all([this.app.repo.listNotebooks(), this.app.repo.listFolders()]);
    if (this.filter !== 'all' && this.filter !== 'fav' && !this.folders.some((f) => f.id === this.filter)) this.filter = 'all';
    this.renderFolders();
    this.renderGrid();
    await this.renderStrip();
  }

  private async renderStrip() {
    const { repo, stats, settings } = this.app;
    const now = Date.now();
    const live = new Set(this.notebooks.map((n) => n.id));
    const due = (await repo.listReviews()).filter((r) => r.state.due <= now && live.has(r.nb)).length;
    const days = stats.lastDays(7);
    const max = Math.max(1800, ...days.map((d) => d.sec));
    const s = settings.get();
    const backupAge = s.lastBackup ? Math.floor((now - s.lastBackup) / 86400000) : Infinity;
    clear(this.strip);
    append(this.strip, [
      h(
        'div',
        { class: 'card' },
        h('h3', null, '今日の復習'),
        h('div', { class: 'row' }, h('div', { class: 'big-num', 'data-testid': 'due-count' }, `${due}`, h('small', { class: 'muted', style: 'font-size:14px' }, ' ページ')), h('span', { class: 'spacer' }), h('button', { class: 'btn primary small', disabled: !due, onclick: () => this.app.go('#/review') }, icon('brain', 16), '復習開始')),
        h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, 'ページの ⋯ →「復習に追加」で忘却曲線に沿って出題'),
      ),
      h(
        'div',
        { class: 'card' },
        h('h3', null, '今日の学習時間'),
        h('div', { class: 'big-num' }, formatDuration(stats.today())),
        h(
          'div',
          { class: 'bars' },
          days.map((d, i) => h('div', { class: 'bar' + (i === days.length - 1 ? ' today' : ''), title: formatDuration(d.sec) }, h('i', { style: `height:${Math.max(2, (d.sec / max) * 34)}px` }), d.label)),
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('h3', null, '過去問タイマー'),
        h('div', { class: 'muted', style: 'font-size:13px;margin-bottom:8px' }, '京大工学部の個別試験時間でセット'),
        h('button', { class: 'btn small', onclick: () => this.app.timer.show() }, icon('timer', 16), 'タイマーを出す'),
        stats.data.exams.length
          ? h(
              'div',
              { style: 'margin-top:10px;font-size:12px', 'data-testid': 'exam-log' },
              stats.data.exams.slice(0, 3).map((x) =>
                h(
                  'div',
                  { class: 'row', style: 'gap:6px;padding:2px 0' },
                  h('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, x.label),
                  h('b', { style: x.planned && x.used > x.planned ? 'color:var(--danger)' : '' }, x.planned ? `${Math.round(x.used / 60)}/${Math.round(x.planned / 60)}分` : `${Math.round(x.used / 60)}分`),
                  h('span', { class: 'muted' }, formatDate(x.at)),
                ),
              ),
            )
          : null,
      ),
      backupAge >= s.backupReminderDays
        ? h(
            'div',
            { class: 'card', style: 'border-color:#f08c00' },
            h('h3', null, 'バックアップ'),
            h('div', { style: 'font-size:13px;margin-bottom:8px' }, backupAge === Infinity ? 'まだ一度も取ってない。消えたら全部終わりだ。' : `${backupAge}日間バックアップしていない。`),
            h('button', { class: 'btn small primary', onclick: () => this.backup() }, icon('download', 16), '今すぐ保存'),
          )
        : null,
    ]);
  }

  private renderFolders() {
    clear(this.folderBar);
    const chip = (id: FolderFilter, label: string, ic?: 'star' | 'folder') =>
      h(
        'button',
        {
          class: 'chip' + (this.filter === id ? ' on' : ''),
          onclick: () => {
            this.filter = id;
            try {
              localStorage.setItem('sumi.folder', id);
            } catch {
              /* ignore */
            }
            this.renderFolders();
            this.renderGrid();
          },
          oncontextmenu: (e: Event) => {
            e.preventDefault();
            const f = this.folders.find((x) => x.id === id);
            if (f) this.folderMenu(e.currentTarget as HTMLElement, f);
          },
        },
        ic ? icon(ic, 15) : null,
        label,
      );
    this.folderBar.append(chip('all', 'すべて'), chip('fav', 'お気に入り', 'star'));
    for (const f of this.folders) {
      const c = chip(f.id, f.name, 'folder');
      let t = 0;
      c.addEventListener('pointerdown', () => (t = window.setTimeout(() => this.folderMenu(c, f), 550)));
      c.addEventListener('pointerup', () => clearTimeout(t));
      c.addEventListener('pointerleave', () => clearTimeout(t));
      this.folderBar.append(c);
    }
    this.folderBar.append(h('button', { class: 'chip', onclick: () => this.newFolder() }, icon('folderPlus', 15), 'フォルダ'));
  }

  private folderMenu(anchor: HTMLElement, f: Folder) {
    menu(anchor, [
      {
        label: '名前を変更',
        icon: 'pencil',
        onClick: async () => {
          const name = await promptDialog('フォルダ名', f.name);
          if (name) {
            f.name = name;
            await this.app.repo.saveFolder(f);
            void this.load();
          }
        },
      },
      {
        label: 'フォルダを削除（ノートは残る）',
        icon: 'trash',
        danger: true,
        onClick: async () => {
          if (await confirmDialog('フォルダを削除', `「${f.name}」を削除します。中のノートは「すべて」に残ります。`, '削除', true)) {
            await this.app.repo.deleteFolder(f.id);
            void this.load();
          }
        },
      },
    ]);
  }

  private async newFolder() {
    const name = await promptDialog('新しいフォルダ', '', '例: 数学');
    if (!name) return;
    const f: Folder = { id: uid(), name, color: COVER_COLORS[this.folders.length % COVER_COLORS.length], order: this.folders.length };
    await this.app.repo.saveFolder(f);
    this.filter = f.id;
    void this.load();
  }

  private visible(): Notebook[] {
    let list = this.notebooks;
    if (this.filter === 'fav') list = list.filter((n) => n.fav);
    else if (this.filter !== 'all') list = list.filter((n) => n.folder === this.filter);
    if (this.query) list = list.filter((n) => n.title.toLowerCase().includes(this.query));
    return [...list].sort((a, b) => Math.max(b.updated, b.opened) - Math.max(a.updated, a.opened));
  }

  private renderGrid() {
    clear(this.grid);
    const list = this.visible();
    if (!list.length) {
      this.grid.appendChild(
        h('div', { class: 'empty', style: 'grid-column:1/-1' }, this.notebooks.length ? '該当するノートがない' : h('div', null, h('p', null, 'まだノートがない。'), h('button', { class: 'btn primary', onclick: () => this.create() }, icon('plus', 18), '最初のノートを作る'))),
      );
      return;
    }
    for (const nb of list) {
      const folder = this.folders.find((f) => f.id === nb.folder);
      const cover = h(
        'div',
        { class: 'nb-cover' },
        nb.thumb ? h('img', { src: nb.thumb, alt: '', loading: 'lazy' }) : h('div', { style: `position:absolute;inset:0;background:${nb.cover}` }, h('div', { class: 'cover-title' }, nb.title)),
        h('div', { class: 'spine', style: `background:${nb.cover}` }),
        nb.fav ? h('span', { class: 'nb-fav' }, icon('star', 16)) : null,
      );
      const more = h('span', { class: 'nb-more', role: 'button', 'aria-label': 'ノートのメニュー' }, icon('dots', 18));
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        this.notebookMenu(more, nb);
      });
      cover.appendChild(more);
      this.grid.appendChild(
        h(
          'button',
          { class: 'nb', 'data-testid': 'notebook', onclick: () => this.app.go(`#/nb/${nb.id}`) },
          cover,
          h('div', { class: 'nb-title' }, nb.title),
          h('div', { class: 'nb-meta' }, formatDate(Math.max(nb.updated, nb.opened)), `· ${nb.pages.length}p`, folder ? `· ${folder.name}` : ''),
        ),
      );
    }
  }

  private notebookMenu(anchor: HTMLElement, nb: Notebook) {
    const repo = this.app.repo;
    menu(anchor, [
      {
        label: '名前を変更',
        icon: 'pencil',
        onClick: async () => {
          const t = await promptDialog('ノート名', nb.title);
          if (t) {
            nb.title = t;
            await repo.saveNotebook(nb);
            this.renderGrid();
          }
        },
      },
      {
        label: nb.fav ? 'お気に入りから外す' : 'お気に入り',
        icon: 'star',
        onClick: async () => {
          nb.fav = !nb.fav;
          await repo.saveNotebook(nb);
          this.renderGrid();
        },
      },
      { label: 'フォルダへ移動', icon: 'folder', onClick: () => this.moveToFolder(nb) },
      {
        label: '複製',
        icon: 'duplicate',
        onClick: async () => {
          await repo.duplicateNotebook(nb);
          void this.load();
        },
      },
      null,
      { label: 'PDFで書き出し', icon: 'download', onClick: () => exportNotebookPdfDialog(this.app, nb) },
      {
        label: 'ノートを共有（.sumi）',
        icon: 'share',
        onClick: async () => {
          const zip = await exportBackup(repo, [nb.id]);
          await shareOrDownload(new Blob([zip as BlobPart], { type: 'application/zip' }), `${safeFileName(nb.title)}.sumi`);
        },
      },
      null,
      {
        label: 'ゴミ箱へ',
        icon: 'trash',
        danger: true,
        onClick: async () => {
          await repo.trashNotebook(nb);
          toast('ゴミ箱に移動した');
          void this.load();
        },
      },
    ]);
  }

  private moveToFolder(nb: Notebook) {
    const list = h('div', { class: 'menu' });
    const m = modal('フォルダへ移動', list);
    const pick = async (id: string | null) => {
      nb.folder = id;
      await this.app.repo.saveNotebook(nb);
      m.close();
      this.renderGrid();
    };
    list.append(h('button', { class: 'menu-item', onclick: () => pick(null) }, icon('book', 18), h('span', null, 'フォルダなし')));
    for (const f of this.folders) list.append(h('button', { class: 'menu-item', onclick: () => pick(f.id) }, icon('folder', 18), h('span', null, f.name), nb.folder === f.id ? icon('check', 16) : null));
  }

  private async create() {
    const folder = this.filter !== 'all' && this.filter !== 'fav' ? this.filter : null;
    const nb = await newNotebookDialog(this.app, this.folders, folder);
    if (nb) this.app.go(`#/nb/${nb.id}`);
  }

  private async importPdf() {
    const [file] = await pickFiles('application/pdf,.pdf');
    if (!file) return;
    toast('PDFを読み込み中…', 4000);
    try {
      const folder = this.filter !== 'all' && this.filter !== 'fav' ? this.filter : null;
      const nb = await importPdfAsNotebook(this.app.repo, file, folder);
      this.app.go(`#/nb/${nb.id}`);
    } catch (e) {
      console.error(e);
      toast('PDFを開けなかった: ' + (e as Error).message);
    }
  }

  private async backup() {
    toast('バックアップを作成中…', 4000);
    const zip = await exportBackup(this.app.repo);
    const d = new Date();
    const name = `sumi-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.sumi`;
    await shareOrDownload(new Blob([zip as BlobPart], { type: 'application/zip' }), name);
    this.app.settings.update({ lastBackup: Date.now() });
    void this.renderStrip();
  }

  private async restore() {
    const [file] = await pickFiles('.sumi,.zip,application/zip,application/octet-stream');
    if (!file) return;
    try {
      const r = await importBackup(this.app.repo, new Uint8Array(await file.arrayBuffer()), { restoreSettings: false });
      toast(`${r.notebooks}冊（${r.pages}ページ）を取り込んだ`);
      void this.load();
    } catch (e) {
      toast('取り込めなかった: ' + (e as Error).message, 3000);
    }
  }

  private async importImages() {
    const files = await pickFiles('image/*', { multiple: true });
    if (!files.length) return;
    const nb = await importImagesAsNotebook(this.app.repo, files, '画像ノート');
    this.app.go(`#/nb/${nb.id}`);
  }

  private async trash() {
    const items = await this.app.repo.listTrash();
    const list = h('div', { class: 'menu' });
    const m = modal('ゴミ箱', items.length ? list : h('p', { class: 'muted' }, 'ゴミ箱は空'));
    for (const nb of items) {
      list.append(
        h(
          'div',
          { class: 'row', style: 'padding:6px 4px' },
          h('span', { style: 'flex:1' }, nb.title),
          h(
            'button',
            {
              class: 'btn small',
              onclick: async () => {
                await this.app.repo.restoreNotebook(nb);
                m.close();
                void this.load();
              },
            },
            '戻す',
          ),
          h(
            'button',
            {
              class: 'btn small danger',
              onclick: async () => {
                if (!(await confirmDialog('完全に削除', `「${nb.title}」を完全に削除します。元に戻せません。`, '削除', true))) return;
                await this.app.repo.deleteNotebook(nb.id);
                m.close();
                void this.trash();
              },
            },
            '削除',
          ),
        ),
      );
    }
  }

  private mainMenu(anchor: HTMLElement) {
    menu(anchor, [
      { label: '画像からノートを作る', icon: 'image', onClick: () => this.importImages() },
      null,
      { label: 'バックアップを書き出す', icon: 'download', onClick: () => this.backup() },
      { label: 'バックアップ / .sumi を取り込む', icon: 'upload', onClick: () => this.restore() },
      { label: 'ゴミ箱', icon: 'trash', onClick: () => this.trash() },
      null,
      { label: '設定', icon: 'settings', onClick: () => openSettings(this.app) },
    ]);
  }
}

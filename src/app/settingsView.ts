import type { Settings } from '../store/settings';
import { h } from '../ui/dom';
import { modal } from '../ui/dialogs';
import type { App } from './app';
import { chipGroup } from './newNotebook';

function toggle(label: string, desc: string, value: boolean, on: (v: boolean) => void) {
  const input = h('input', { type: 'checkbox', class: 'switch', checked: value, onchange: (e: Event) => on((e.target as HTMLInputElement).checked) });
  return h('label', { class: 'toggle-row' }, h('div', null, h('div', null, label), desc ? h('div', { class: 'desc' }, desc) : null), input);
}

function slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, on: (v: number) => void) {
  const out = h('span', { class: 'muted' }, fmt(value));
  const input = h('input', {
    type: 'range',
    min,
    max,
    step,
    value: String(value),
    oninput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      out.textContent = fmt(v);
      on(v);
    },
  });
  return h('div', { class: 'field' }, h('div', { class: 'row' }, h('span', { class: 'field-label', style: 'margin:0' }, label), h('span', { class: 'spacer' }), out), input);
}

export function openSettings(app: App) {
  const st = app.settings;
  const s = st.get();
  const set = (p: Partial<Settings>) => st.update(p);
  const time = (value: string, on: (v: string) => void) => h('input', { type: 'time', class: 'input', style: 'width:130px', value, onchange: (e: Event) => on((e.target as HTMLInputElement).value) });

  const storage = h('div', { class: 'muted', style: 'font-size:13px' }, '計算中…');
  void (async () => {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    if (est) storage.textContent = `使用量 ${(((est.usage ?? 0) / 1e6) | 0)} MB / 永続化: ${persisted ? 'ON（自動削除されない）' : 'OFF'}`;
  })();

  const body = h(
    'div',
    null,
    h('h3', null, 'ペン'),
    slider('筆圧の効き', 0.4, 1.4, 0.05, s.pressureGamma, (v) => (v < 0.75 ? '軽いタッチで太く' : v > 1.05 ? '強く押して太く' : '標準'), (v) => set({ pressureGamma: v })),
    slider('手ぶれ補正', 0, 0.8, 0.05, s.stabilization, (v) => (v === 0 ? 'オフ（最速）' : `${Math.round(v * 100)}%`), (v) => set({ stabilization: v })),
    h(
      'div',
      { class: 'field' },
      h('label', null, 'S ペンのボタンを押しながら書くと'),
      chipGroup<Settings['sideButton']>(
        [
          { id: 'eraser', label: '消しゴム' },
          { id: 'lasso', label: '投げ縄' },
          { id: 'none', label: '何もしない' },
        ],
        s.sideButton,
        (v) => set({ sideButton: v }),
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', null, '指で書く'),
      chipGroup<Settings['fingerDrawing']>(
        [
          { id: 'auto', label: '自動（ペン検出で無効）' },
          { id: 'off', label: '指はスクロールだけ' },
          { id: 'on', label: '指でも書く' },
        ],
        s.fingerDrawing,
        (v) => set({ fingerDrawing: v }),
      ),
    ),
    toggle('ペンを止めて図形補正', '書き終わりで0.45秒止めると直線・円・四角に補正', s.shapeHold, (v) => set({ shapeHold: v })),
    toggle('2本指タップで元に戻す', '3本指タップでやり直し', s.twoFingerUndo, (v) => set({ twoFingerUndo: v })),
    toggle('配置した写真・スキャンを自動で固定', '位置を決めて選択を外すと固定。投げ縄・消しゴム・手のひらで動かなくなる', s.autoLockPlaced, (v) => set({ autoLockPlaced: v })),
    h('h3', null, '表示'),
    h(
      'div',
      { class: 'field' },
      h('label', null, 'テーマ'),
      chipGroup<Settings['theme']>(
        [
          { id: 'system', label: '端末に合わせる' },
          { id: 'light', label: 'ライト' },
          { id: 'dark', label: 'ダーク' },
        ],
        s.theme,
        (v) => set({ theme: v }),
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', null, 'ページの並び（新規ノートの既定）'),
      chipGroup<Settings['layout']>(
        [
          { id: 'vertical', label: '縦スクロール' },
          { id: 'horizontal', label: '横めくり' },
        ],
        s.layout,
        (v) => set({ layout: v }),
      ),
    ),
    h('h3', null, '睡眠'),
    toggle('就寝リマインダー', '就寝時刻を過ぎたら上部に表示', s.bedtimeEnabled, (v) => set({ bedtimeEnabled: v })),
    h('div', { class: 'toggle-row' }, h('div', null, '就寝時刻'), time(s.bedtime, (v) => set({ bedtime: v }))),
    h('div', { class: 'toggle-row' }, h('div', null, '起床時刻'), time(s.wakeTime, (v) => set({ wakeTime: v }))),
    toggle('夜間は暖色フィルター', '就寝時刻〜起床時刻の間、画面を暖色にする', s.nightFilter, (v) => set({ nightFilter: v })),
    h('h3', null, 'データ'),
    slider('バックアップ催促の間隔', 1, 30, 1, s.backupReminderDays, (v) => `${v}日`, (v) => set({ backupReminderDays: v })),
    storage,
    h('p', { class: 'muted', style: 'font-size:12px;margin-top:16px' }, 'Sumi Note — データはこの端末内（ブラウザのIndexedDB）にだけ保存される。アンインストールやサイトデータ削除で消えるので、定期的にバックアップを書き出せ。'),
  );
  modal('設定', body);
}

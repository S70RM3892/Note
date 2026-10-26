import type { Settings } from '../store/settings';
import type { ExamDate } from '../study/countdown';
import { native, nativeInk, pickNativeBackupFolder, setNativeCallbacks } from '../platform';
import { maybeAutoBackup } from './autoBackup';
import { formatDate } from '../ui/dom';
import { h } from '../ui/dom';
import { modal, toast } from '../ui/dialogs';
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

/** APK only: daily backups into a folder, and pinning the app during the exam timer. */
function apkSection(app: App, set: (p: Partial<Settings>) => void): HTMLElement[] {
  const s = app.settings.get();
  const folder = h('div', { class: 'muted', style: 'font-size:13px', 'data-testid': 'backup-folder' });
  const autoToggle = toggle('毎日自動でバックアップ', 'ライブラリを開いたときに1日1回。フォルダには最新10個を残す', s.autoBackup, (v) => set({ autoBackup: v }));
  const autoInput = autoToggle.querySelector('input') as HTMLInputElement;
  const now = h('button', { class: 'btn small', 'data-testid': 'backup-now' }, '今すぐ実行');
  const render = () => {
    const name = native?.backupFolder?.() ?? '';
    const last = app.settings.get().lastAutoBackup;
    folder.textContent = name ? `保存先：${name}${last ? `（最終 ${formatDate(last)}）` : ''}` : '保存先のフォルダが未設定（Google ドライブ等の同期フォルダを選ぶと端末が壊れても残る）';
    autoInput.disabled = !name;
    now.disabled = !name;
  };
  const pick = h('button', { class: 'btn small', 'data-testid': 'backup-pick' }, 'フォルダを選ぶ');
  pick.onclick = async () => {
    if (await pickNativeBackupFolder()) {
      set({ autoBackup: true });
      autoInput.checked = true;
    }
    render();
  };
  now.onclick = async () => {
    now.disabled = true;
    await maybeAutoBackup(app, true);
    render();
  };
  render();
  return [
    h('h3', null, '自動バックアップ'),
    h('div', { class: 'toggle-row' }, folder, h('div', { class: 'row', style: 'gap:6px' }, pick, now)),
    autoToggle,
    ...(native?.setReminders ? reminderSection(app, set) : []),
    h('h3', null, '集中モード'),
    toggle('過去問タイマー中はアプリを画面に固定', '開始すると確認が出る。固定中は他のアプリに逃げられない（タイマー終了・一時停止で解除）。画面は常に点けたまま', s.focusPin, (v) => set({ focusPin: v })),
  ];
}

/** APK only: 就寝・復習のお知らせ (scheduled by nativeGlue whenever these settings change). */
function reminderSection(app: App, set: (p: Partial<Settings>) => void): HTMLElement[] {
  const s = app.settings.get();
  const status = h('div', { class: 'muted', style: 'font-size:13px', 'data-testid': 'notify-status' });
  const render = () => {
    const cur = app.settings.get();
    const on = cur.notifyBedtime || cur.notifyReview;
    const ok = native?.notificationsAllowed?.() ?? true;
    status.textContent = !on ? '' : ok ? '' : '通知が許可されていない：設定アプリ → アプリ → Sumi Note → 通知 をオン';
    status.style.color = on && !ok ? 'var(--danger)' : '';
  };
  setNativeCallbacks({ onNotifyPermission: () => render() });
  const time = h('input', {
    class: 'input',
    type: 'time',
    value: s.reviewTime,
    style: 'width:120px',
    'data-testid': 'review-time',
    onchange: (e: Event) => set({ reviewTime: (e.target as HTMLInputElement).value || '19:00' }),
  });
  render();
  return [
    h('h3', null, 'お知らせ'),
    toggle('就寝のお知らせ', `就寝時刻（${s.bedtime}）の30分前と就寝時刻に通知。アプリを閉じていても届く`, s.notifyBedtime, (v) => (set({ notifyBedtime: v }), setTimeout(render, 500))),
    toggle('復習のお知らせ', '毎日決まった時刻に「今日の復習 N ページ」と入試までの日数を通知', s.notifyReview, (v) => (set({ notifyReview: v }), setTimeout(render, 500))),
    h('div', { class: 'toggle-row' }, h('div', null, '復習のお知らせの時刻'), time),
    status,
  ];
}

/** APK only: the Japanese handwriting model and background reading for search. */
function inkSection(s: Settings, set: (p: Partial<Settings>) => void): HTMLElement[] {
  const status = h('div', { class: 'muted', style: 'font-size:13px', 'data-testid': 'ink-status' });
  const btn = h('button', { class: 'btn small', 'data-testid': 'ink-download' }, 'ダウンロード（約20MB）');
  const render = () => {
    const st = nativeInk.status();
    status.textContent = st === 'ready' ? '日本語モデル：準備OK（端末内で認識。ネット不要）' : st === 'downloading' ? 'ダウンロード中…' : '日本語モデルが未ダウンロード（最初に1回だけ必要）';
    btn.hidden = st === 'ready';
    btn.disabled = st === 'downloading';
  };
  btn.onclick = async () => {
    btn.disabled = true;
    status.textContent = 'ダウンロード中…';
    try {
      await nativeInk.download();
      toast('手書き文字認識が使えるようになった');
    } catch (e) {
      toast('ダウンロードできなかった: ' + (e as Error).message, 3000);
    }
    render();
  };
  render();
  return [
    h('h3', null, '手書き文字認識'),
    h('div', { class: 'toggle-row' }, status, btn),
    toggle('手書きも検索できるようにする', 'ライブラリを開いている間に、書いたページを少しずつ読み取る', s.handwritingIndex, (v) => set({ handwritingIndex: v })),
  ];
}

function examEditor(initial: ExamDate[], on: (v: ExamDate[]) => void): HTMLElement {
  let list = initial.map((e) => ({ ...e }));
  const host = h('div', { class: 'exam-editor', 'data-testid': 'exam-editor' });
  const render = () => {
    host.replaceChildren(
      ...list.map((e, i) =>
        h(
          'div',
          { class: 'row', style: 'gap:8px;margin-bottom:6px' },
          h('input', { class: 'input', style: 'flex:1', value: e.name, placeholder: '試験名', onchange: (ev: Event) => ((e.name = (ev.target as HTMLInputElement).value), on(list)) }),
          h('input', { class: 'input', type: 'date', style: 'width:170px', value: e.date, onchange: (ev: Event) => ((e.date = (ev.target as HTMLInputElement).value), on(list)) }),
          h('button', { class: 'btn small', 'aria-label': '削除', onclick: () => ((list = list.filter((_, j) => j !== i)), on(list), render()) }, '削除'),
        ),
      ),
      h('button', { class: 'btn small', onclick: () => (list.push({ name: '', date: '' }), render()) }, '＋ 追加'),
      h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, '初期値は 2027年の共通テスト（1/16）と京大前期（2/25）。毎年の募集要項で確かめて直せ。'),
    );
  };
  render();
  return host;
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
    native?.setWetInk ? toggle('低遅延ペン', '書いている線を Android が直接（フロントバッファで）描く。ペン先への追従が速くなる。表示がおかしいときはオフ', s.wetInk, (v) => set({ wetInk: v })) : null,
    toggle('ペン先のプレビュー', 'S ペンを画面に近づけると、書く位置と太さを色付きの点で表示', s.penCursor, (v) => set({ penCursor: v })),
    toggle('最後のページの下まで書いたら次のページを追加', 'PDF のページには追加しない。元に戻すで書いた線と一緒に消える', s.autoAppendPage, (v) => set({ autoAppendPage: v })),
    toggle('ペンを止めて図形補正', '書き終わりで0.45秒止めると直線・円・四角に補正', s.shapeHold, (v) => set({ shapeHold: v })),
    toggle('2本指タップで元に戻す', '3本指タップでやり直し', s.twoFingerUndo, (v) => set({ twoFingerUndo: v })),
    toggle('配置した写真・スキャンを自動で固定', '位置を決めて選択を外すと固定。投げ縄・消しゴム・手のひらで動かなくなる', s.autoLockPlaced, (v) => set({ autoLockPlaced: v })),
    ...(nativeInk.available() ? inkSection(s, set) : []),
    ...(native?.backupFolder ? apkSection(app, set) : []),
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
    h('h3', null, '入試日（ライブラリにカウントダウン）'),
    examEditor(s.exams, (exams) => set({ exams })),
    h('h3', null, '睡眠'),
    toggle('就寝リマインダー', '就寝時刻を過ぎたら上部に表示', s.bedtimeEnabled, (v) => set({ bedtimeEnabled: v })),
    h('div', { class: 'toggle-row' }, h('div', null, '就寝時刻'), time(s.bedtime, (v) => set({ bedtime: v }))),
    h('div', { class: 'toggle-row' }, h('div', null, '起床時刻'), time(s.wakeTime, (v) => set({ wakeTime: v }))),
    toggle('夜間は暖色フィルター', '就寝時刻〜起床時刻の間、画面を暖色にする', s.nightFilter, (v) => set({ nightFilter: v })),
    h('h3', null, 'データ'),
    slider('バックアップ催促の間隔', 1, 30, 1, s.backupReminderDays, (v) => `${v}日`, (v) => set({ backupReminderDays: v })),
    storage,
    h('p', { class: 'muted', style: 'font-size:12px;margin-top:16px' }, native ? 'Sumi Note — データはこのアプリの中にだけ保存される。アンインストールで消えるので、自動バックアップを設定しておけ。' : 'Sumi Note — データはこの端末内（ブラウザのIndexedDB）にだけ保存される。アンインストールやサイトデータ削除で消えるので、定期的にバックアップを書き出せ。'),
  );
  modal('設定', body);
}

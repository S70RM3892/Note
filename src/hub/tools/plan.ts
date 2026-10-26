/** 計画と振り返り: 参考書の進捗, 過去問の進捗表, 週間レポート, 1日の振り返り. */
import { uid } from '../../core/id';
import { addTodo } from '../../study/todo';
import { formatDuration, h } from '../../ui/dom';
import { confirmDialog, modal, promptDialog, toast } from '../../ui/dialogs';
import { icon } from '../../ui/icons';
import { clock, TEEN_SLEEP } from '../health';
import { band, bookPlan, cellKey, pastStats, setBookDone, type Book, type PastSubject } from '../plan';
import { card, fill, fixed, md, num, pct, progress, text, todayKey } from '../ui';
import { weeklyReport, weeklyText } from '../weekly';
import type { Tool, ToolCtx } from './index';

// ---------- 参考書 ----------

function bookEditor(ctx: ToolCtx, existing?: Book) {
  const b: Book = existing ? structuredClone(existing) : { id: uid(), title: '', unit: '問', total: 100, done: 0, startDone: 0, created: Date.now(), log: [] };
  const save = h('button', { class: 'btn primary', 'data-testid': 'book-save' }, '保存');
  const handle = modal(
    existing ? '参考書を直す' : '参考書を足す',
    h(
      'div',
      { class: 'form' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '名前'), text(b.title, (v) => (b.title = v), { placeholder: '例: 青チャート 数学Ⅲ', 'data-testid': 'book-title' })),
      h(
        'div',
        { class: 'row', style: 'gap:8px' },
        h('label', { class: 'field', style: 'flex:1' }, h('span', { class: 'field-label' }, '全部で'), num(b.total, (v) => (b.total = Math.max(1, Math.round(v ?? 1))), { 'data-testid': 'book-total' })),
        h('label', { class: 'field', style: 'width:110px' }, h('span', { class: 'field-label' }, '単位'), text(b.unit, (v) => (b.unit = v || '問'))),
        h('label', { class: 'field', style: 'flex:1' }, h('span', { class: 'field-label' }, existing ? '終わった数' : 'もう終わっている数'), num(b.done, (v) => (b.done = Math.max(0, Math.round(v ?? 0))), { 'data-testid': 'book-done' })),
      ),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'いつまでに終える'), h('input', { class: 'input', type: 'date', value: b.deadline ?? '', 'data-testid': 'book-deadline', onchange: (e: Event) => (b.deadline = (e.target as HTMLInputElement).value || undefined) })),
    ),
    {
      actions: [
        existing
          ? h('button', {
              class: 'btn danger',
              onclick: async () => {
                if (!(await confirmDialog('参考書を消す', `「${b.title}」を消す？`, '消す', true))) return;
                ctx.hub.update((s) => void (s.books = s.books.filter((x) => x.id !== b.id)));
                handle.close();
                ctx.refresh();
              },
            }, '消す')
          : h('span'),
        save,
      ],
    },
  );
  save.onclick = () => {
    if (!b.title.trim()) return toast('名前を入れて');
    b.done = Math.min(b.done, b.total);
    let saved = b;
    if (!existing) saved = { ...b, startDone: b.done };
    else if (b.done !== existing.done) saved = setBookDone(b, b.done);
    ctx.hub.update((s) => void (s.books = [...s.books.filter((x) => x.id !== b.id), saved]));
    handle.close();
    ctx.refresh();
  };
}

function booksTool(ctx: ToolCtx): HTMLElement {
  const books = ctx.hub.get().books;
  const bump = (b: Book, n: number) => {
    ctx.hub.update((s) => void (s.books = s.books.map((x) => (x.id === b.id ? setBookDone(x, x.done + n) : x))));
    ctx.refresh();
  };
  return h(
    'div',
    null,
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('button', { class: 'btn primary', 'data-testid': 'book-add', onclick: () => bookEditor(ctx) }, icon('plus', 18), '参考書を足す')),
    books.length
      ? books.map((b) => {
          const p = bookPlan(b);
          const lines: (string | HTMLElement)[] = [`${b.done} / ${b.total}${b.unit}（残り${p.remaining}${b.unit}）`];
          if (p.perDay !== null && p.remaining) lines.push(p.daysLeft! > 0 ? `${md(b.deadline!)}まで${p.daysLeft}日 → 1日 ${fixed(p.perDay, 1)}${b.unit}` : `締切（${md(b.deadline!)}）を過ぎた`);
          if (p.pace) lines.push(`最近のペース 1日 ${fixed(p.pace, 1)}${b.unit} → ${p.eta ? md(p.eta) : '—'}に終わる`);
          return h(
            'section',
            { class: 'card hub-card book', 'data-testid': 'book' },
            h('div', { class: 'row' }, h('b', { style: 'flex:1' }, b.title), p.onTrack === null ? null : h('span', { class: 'tag ' + (p.onTrack ? 'good' : 'bad'), 'data-testid': 'book-status' }, p.remaining === 0 ? '完了' : p.onTrack ? '間に合う' : '間に合わない'), h('button', { class: 'icon-btn', 'aria-label': '直す', onclick: () => bookEditor(ctx, b) }, icon('pencil', 16))),
            progress(b.done / b.total, p.onTrack === false ? 'warn' : ''),
            h('div', { class: 'muted small', 'data-testid': 'book-plan' }, lines.map((l) => h('div', null, l))),
            h(
              'div',
              { class: 'row', style: 'gap:6px;margin-top:8px' },
              h('button', { class: 'btn small', 'data-testid': 'book-plus1', onclick: () => bump(b, 1) }, `+1${b.unit}`),
              h('button', { class: 'btn small', onclick: () => bump(b, 5) }, `+5${b.unit}`),
              h('button', { class: 'btn small', onclick: () => bump(b, -1) }, '−1'),
            ),
          );
        })
      : h('p', { class: 'muted' }, '使っている問題集・参考書と締切を入れると、1日に何問やれば間に合うか、今のペースだといつ終わるかが出る。'),
  );
}

// ---------- 過去問の進捗表 ----------

function pastTool(ctx: ToolCtx): HTMLElement {
  const g = ctx.hub.get().past;
  const setCell = async (s: PastSubject, y: number) => {
    const cur = g.cells[cellKey(s.id, y)];
    const v = await promptDialog(`${s.name} ${y}年（${s.max}点満点）`, cur ? String(cur.score) : '', '得点（空で消す）');
    if (v === null) return;
    ctx.hub.update((st) => {
      if (v === '') delete st.past.cells[cellKey(s.id, y)];
      else if (Number.isFinite(Number(v))) st.past.cells[cellKey(s.id, y)] = { score: Math.max(0, Math.min(s.max, Number(v))), at: Date.now() };
    });
    ctx.refresh();
  };
  const editSubject = async (s?: PastSubject) => {
    const name = await promptDialog(s ? '科目名' : '科目を足す', s?.name ?? '', '例: 共通 数学ⅡBC');
    if (!name) return;
    const max = await promptDialog('満点', String(s?.max ?? 100));
    const m = Number(max);
    ctx.hub.update((st) => {
      const subj = { id: s?.id ?? uid(), name, max: Number.isFinite(m) && m > 0 ? m : 100 };
      st.past.subjects = s ? st.past.subjects.map((x) => (x.id === s.id ? subj : x)) : [...st.past.subjects, subj];
    });
    ctx.refresh();
  };
  return h(
    'div',
    null,
    h('p', { class: 'muted' }, 'マスをタップして得点を入れる。色は得点率（緑 70%以上・黄 50%以上・赤 それ未満）。科目名をタップで名前と満点を変更。'),
    h(
      'div',
      { class: 'past-wrap' },
      h(
        'table',
        { class: 'past-grid', 'data-testid': 'past-grid' },
        h('tr', null, h('th', null, '年度'), g.subjects.map((s) => h('th', null, h('button', { class: 'link-btn', onclick: () => void editSubject(s) }, s.name), h('small', { class: 'muted' }, ` /${s.max}`)))),
        g.years.map((y) =>
          h(
            'tr',
            null,
            h('th', null, String(y)),
            g.subjects.map((s) => {
              const c = g.cells[cellKey(s.id, y)];
              return h('td', null, h('button', { class: 'past-cell' + (c ? ' ' + band(c.score / s.max) : ''), 'data-testid': `past-${s.id}-${y}`, onclick: () => void setCell(s, y) }, c ? String(c.score) : ''));
            }),
          ),
        ),
        h(
          'tr',
          { class: 'sum' },
          h('th', null, '平均'),
          g.subjects.map((s) => {
            const st = pastStats(g, s);
            return h('td', null, st.done ? `${pct(st.avg)}（${st.done}年分）` : '—');
          }),
        ),
      ),
    ),
    h(
      'div',
      { class: 'row', style: 'gap:8px;margin-top:10px' },
      h('button', { class: 'btn small', onclick: () => void editSubject() }, icon('plus', 16), '科目'),
      h('button', { class: 'btn small', onclick: () => (ctx.hub.update((st) => void st.past.years.push(Math.min(...st.past.years) - 1)), ctx.refresh()) }, icon('plus', 16), 'さらに前の年'),
    ),
  );
}

// ---------- 週間レポート ----------

function weeklyTool(ctx: ToolCtx): HTMLElement {
  const host = h('div', { 'data-testid': 'weekly' }, h('p', { class: 'muted' }, '集計中…'));
  void Promise.all([ctx.app.repo.listNotebooks(), ctx.app.repo.listFolders()]).then(([nbs, folders]) => {
    const r = weeklyReport(Date.now(), ctx.app.stats.data, nbs, folders, ctx.hub.get());
    const textOut = weeklyText(r);
    const max = Math.max(1800, ...r.days.map((d) => d.sec));
    fill(host, h(
        'div',
        { class: 'hub-cols' },
        card(
          `学習時間 ${md(r.from)}〜${md(r.to)}`,
          h('div', { class: 'big-num' }, formatDuration(r.studySec)),
          h('div', { class: 'muted small' }, `前の週 ${formatDuration(r.prevStudySec)}`),
          h('div', { class: 'bars' }, r.days.map((d) => h('div', { class: 'bar' }, h('i', { style: `height:${Math.max(2, (d.sec / max) * 34)}px` }), md(d.key).replace(/^\d+\//, '')))),
          r.subjects.length ? h('div', { class: 'small', style: 'margin-top:8px' }, r.subjects.map((s) => h('div', null, `${s.name} ${formatDuration(s.sec)}`))) : null,
        ),
        card(
          '演習',
          h('div', null, `過去問 ${r.exams.length}回`, r.exams.length ? h('small', { class: 'muted' }, '（' + r.exams.map((x) => `${x.label} ${x.usedMin}分`).join('、') + '）') : null),
          h('div', null, `模試 ${r.mocks.length}回`),
          h('div', null, `単語帳 ${r.cards}枚`),
          r.books.length ? h('div', null, '参考書 ' + r.books.map((b) => `${b.title} +${b.gained}${b.unit}`).join('、')) : null,
          r.mistakes.length ? h('div', null, 'ミス ' + r.mistakes.map((m) => `${m.label} ${m.count}`).join('・')) : null,
        ),
        card(
          '生活',
          h('div', null, r.sleep.avg !== null ? `睡眠 平均 ${r.sleep.avg.toFixed(1)}時間（${r.sleep.nights}晩の記録、${TEEN_SLEEP.min}〜${TEEN_SLEEP.max}時間は ${r.sleep.inRange}晩）` : '睡眠の記録なし'),
          r.sleep.weekdayWake !== null && r.sleep.weekendWake !== null ? h('div', null, `起床 平日 ${clock(r.sleep.weekdayWake)}・休日 ${clock(r.sleep.weekendWake)}`) : null,
          h('div', null, `振り返り ${r.reflections}/7日`),
          r.questionsOpen ? h('div', null, `未解決の質問 ${r.questionsOpen}件`) : null,
        ),
      ),
      card(
        'テキストで送る',
        h('pre', { class: 'weekly-text', 'data-testid': 'weekly-text' }, textOut),
        h(
          'button',
          {
            class: 'btn small',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(textOut);
                toast('コピーした');
              } catch {
                toast('コピーできなかった。長押しで選んでコピー');
              }
            },
          },
          icon('copy', 16),
          'コピー',
        ),
      ),
    );
  });
  return host;
}

// ---------- 1日の振り返り ----------

function reflectTool(ctx: ToolCtx): HTMLElement {
  const today = todayKey();
  const cur = ctx.hub.get().reflections[today] ?? { good: '', bad: '', next: '', at: 0 };
  const draft = { ...cur };
  const area = (label: string, key: 'good' | 'bad' | 'next', ph: string) =>
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('textarea', { class: 'input', rows: 2, placeholder: ph, 'data-testid': `reflect-${key}`, oninput: (e: Event) => (draft[key] = (e.target as HTMLTextAreaElement).value) }, cur[key]));
  const toTodo = h('input', { type: 'checkbox', checked: true });
  const past = Object.entries(ctx.hub.get().reflections)
    .filter(([k]) => k !== today)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 14);
  return h(
    'div',
    null,
    card(
      `今日（${md(today)}）`,
      area('うまくいったこと', 'good', '例: 数学の第2問を時間内に完答'),
      area('うまくいかなかったこと・原因', 'bad', '例: 英作文で時制を3回まちがえた → 書いた後に動詞だけ見直す'),
      area('明日の最優先', 'next', '例: 京大 化学 2019 を通しで'),
      h('label', { class: 'toggle-row' }, h('div', null, '「明日の最優先」を「今日やること」に入れる'), toTodo),
      h(
        'button',
        {
          class: 'btn primary',
          'data-testid': 'reflect-save',
          onclick: () => {
            if (!draft.good.trim() && !draft.bad.trim() && !draft.next.trim()) return toast('何か書いてから');
            ctx.hub.update((s) => void (s.reflections[today] = { ...draft, at: Date.now() }));
            if (toTodo.checked && draft.next.trim() && draft.next.trim() !== cur.next.trim()) {
              ctx.app.settings.update({ todos: addTodo(ctx.app.settings.get().todos, draft.next.trim()) });
            }
            toast('保存した。寝ろ。', 2000);
            ctx.refresh();
          },
        },
        '保存',
      ),
    ),
    past.length
      ? card(
          'これまで',
          past.map(([k, r]) => h('div', { class: 'reflect-past' }, h('b', null, md(k)), r.good ? h('div', null, '○ ' + r.good) : null, r.bad ? h('div', null, '△ ' + r.bad) : null, r.next ? h('div', { class: 'muted' }, '→ ' + r.next) : null)),
        )
      : null,
  );
}

export const PLAN_TOOLS: Tool[] = [
  {
    id: 'books',
    group: 'plan',
    title: '参考書の進捗',
    blurb: '締切から逆算した1日の量と、今のペースで終わる日',
    icon: 'bookMarked',
    summary: (ctx) => {
      const late = ctx.hub.get().books.filter((b) => bookPlan(b).onTrack === false).length;
      const n = ctx.hub.get().books.length;
      return n ? (late ? `${n}冊・${late}冊が間に合わないペース` : `${n}冊・全部間に合うペース`) : null;
    },
    render: booksTool,
  },
  {
    id: 'past',
    group: 'plan',
    title: '過去問の進捗表',
    blurb: '年度×科目の表に得点。どこまで解いたかが一目でわかる',
    icon: 'table',
    summary: (ctx) => {
      const n = Object.keys(ctx.hub.get().past.cells).length;
      return n ? `${n}回分を記録` : null;
    },
    render: pastTool,
  },
  {
    id: 'weekly',
    group: 'plan',
    title: '週間レポート',
    blurb: '1週間の学習・演習・睡眠をまとめて、テキストで送れる',
    icon: 'notebookPen',
    render: weeklyTool,
  },
  {
    id: 'reflect',
    group: 'plan',
    title: '1日の振り返り',
    blurb: '寝る前に3行。明日の最優先は「今日やること」へ',
    icon: 'squarePen',
    summary: (ctx) => (ctx.hub.get().reflections[todayKey()] ? '今日の分は書いた' : null),
    render: reflectTool,
  },
];

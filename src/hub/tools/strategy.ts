/** 合格戦略: 合格点シミュレーター, 模試の記録, 入試日程・時間割, 持ち物チェック. */
import { uid } from '../../core/id';
import { daysUntil } from '../../study/countdown';
import { h } from '../../ui/dom';
import { confirmDialog, modal, toast } from '../../ui/dialogs';
import { icon } from '../../ui/icons';
import {
  CHECK_KYOTSU,
  CHECK_NIJI,
  KYOTSU_FORBIDDEN,
  KYOTSU_FULL,
  KYOTSU_SUBJECTS,
  NIJI_FULL,
  NIJI_SUBJECTS,
  PAST_RESULTS,
  SCHEDULE_R9,
  SOURCES,
  TOTAL_FULL,
  convertKyotsu,
  nijiNeeded,
  nijiTotal,
  type CheckItem,
} from '../exam';
import { MOCK_KINDS, mockKyodai, mockPreset, mockSeries, mockTotal, weakestSubject, type MockExam, type MockKind } from '../plan';
import { card, fill, fixed, lineChart, md, num, pct, source, text, todayKey } from '../ui';
import type { Tool, ToolCtx } from './index';

const RECENT = PAST_RESULTS.filter((r) => r.full === TOTAL_FULL);

// ---------- 合格点シミュレーター ----------

function scoreTool(ctx: ToolCtx): HTMLElement {
  const st = () => ctx.hub.get().score;
  const result = h('div', { 'data-testid': 'score-result' });
  const paint = () => {
    const c = convertKyotsu(st().kyotsu);
    const niji = nijiTotal(st().niji);
    const total = c.total + niji;
    fill(result, h(
        'table',
        { class: 'tbl' },
        h('tr', null, h('th', null, '共通テスト'), h('th', null, '素点'), h('th', null, '換算')),
        c.groups.map((g) => h('tr', null, h('td', null, g.label), h('td', null, `${fixed(g.raw, 1)} / ${g.rawMax}`), h('td', null, `${fixed(g.converted)} / ${g.points}`))),
        h('tr', { class: 'sum' }, h('td', null, '計'), h('td'), h('td', { 'data-testid': 'kyotsu-total' }, `${fixed(c.total)} / ${KYOTSU_FULL}`)),
      ),
      h(
        'div',
        { class: 'big-line' },
        h('span', null, '合計 '),
        h('b', { 'data-testid': 'score-total' }, fixed(total)),
        h('span', { class: 'muted' }, ` / ${TOTAL_FULL}（二次 ${fixed(niji)} / ${NIJI_FULL}）`),
      ),
      h(
        'table',
        { class: 'tbl' },
        h('tr', null, h('th', null, '情報学科の合格者'), h('th', null, '最低点'), h('th', null, '平均点'), h('th', null, 'いまの合計との差')),
        PAST_RESULTS.map((r) =>
          h(
            'tr',
            null,
            h('td', null, r.year, r.full !== TOTAL_FULL ? h('small', { class: 'muted' }, `（満点${r.full}）`) : null),
            h('td', null, fixed(r.min)),
            h('td', null, fixed(r.avg)),
            h('td', { class: r.full !== TOTAL_FULL ? 'muted' : total >= r.min ? 'good' : 'bad' }, r.full !== TOTAL_FULL ? '満点が違う' : `${total >= r.min ? '+' : ''}${fixed(total - r.min)}`),
          ),
        ),
      ),
      c.complete
        ? h(
            'div',
            { class: 'need', 'data-testid': 'score-need' },
            RECENT.map((r) => {
              const n = nijiNeeded(c.total, r.min);
              return h('div', null, `${r.year}の最低点 ${fixed(r.min)} に届くには、二次で `, n ? h('b', null, `${Math.ceil(n.points)}点 / 800（${pct(n.pct)}）`) : h('b', null, '800点でも足りない'));
            }),
          )
        : h('p', { class: 'muted' }, '共通テストの9科目を全部入れると、二次で何点要るかが出る。'),
    );
  };
  const setK = (id: string, v: number | null) =>
    ctx.hub.update((s) => {
      if (v === null) delete s.score.kyotsu[id as keyof typeof s.score.kyotsu];
      else s.score.kyotsu[id as keyof typeof s.score.kyotsu] = v;
    });
  const setN = (id: string, v: number | null) =>
    ctx.hub.update((s) => {
      if (v === null) delete s.score.niji[id as keyof typeof s.score.niji];
      else s.score.niji[id as keyof typeof s.score.niji] = v;
    });
  paint();
  return h(
    'div',
    { class: 'hub-cols' },
    card(
      '共通テスト（素点）',
      h(
        'div',
        { class: 'score-grid' },
        KYOTSU_SUBJECTS.map((s) =>
          h('label', null, h('span', null, s.label), num(st().kyotsu[s.id], (v) => (setK(s.id, v), paint()), { min: 0, max: s.max, 'data-testid': `k-${s.id}` }), h('small', { class: 'muted' }, `/ ${s.max}`)),
        ),
      ),
      h('h3', { class: 'card-head', style: 'margin-top:14px' }, '二次（目標点か模試の点）'),
      h(
        'div',
        { class: 'score-grid' },
        NIJI_SUBJECTS.map((s) => h('label', null, h('span', null, s.label), num(st().niji[s.id], (v) => (setN(s.id, v), paint()), { min: 0, max: s.max, 'data-testid': `n-${s.id}` }), h('small', { class: 'muted' }, `/ ${s.max}`))),
      ),
    ),
    card(
      '京大 工学部 情報学科',
      result,
      h(
        'p',
        { class: 'muted small' },
        '配点は共通テスト225（国語25・地歴公民50・数学25・理科25・外国語50・情報50。英語はR100+L100の200点で利用）＋ 二次800（国語100・数学250・理科250・外国語200）。換算は各教科の素点を配点に比例させた計算（端数の扱いは公表されていない）。',
      ),
      h('div', { class: 'src-row' }, source('令和9年度 京都大学入学者選抜要項', SOURCES.yoko), source('京都大学 入学者選抜実施状況', SOURCES.jisshi)),
    ),
  );
}

// ---------- 模試の記録 ----------

function mockEditor(ctx: ToolCtx, existing?: MockExam) {
  const m: MockExam = existing ? structuredClone(existing) : { id: uid(), name: '', date: todayKey(), kind: 'kyotsu', subjects: mockPreset('kyotsu') };
  const rows = h('div', { class: 'mock-rows' });
  const paintRows = () =>
    fill(rows, h('div', { class: 'mock-row head' }, h('span', null, '科目'), h('span', null, '得点'), h('span', null, '満点'), h('span', null, '偏差値'), h('span')),
      m.subjects.map((s, i) =>
        h(
          'div',
          { class: 'mock-row' },
          text(s.name, (v) => (s.name = v)),
          num(s.score, (v) => (s.score = v), { 'data-testid': `mock-score-${i}` }),
          num(s.max, (v) => (s.max = v ?? 0)),
          num(s.dev ?? null, (v) => (s.dev = v)),
          h('button', { class: 'icon-btn', 'aria-label': '科目を消す', onclick: () => (m.subjects.splice(i, 1), paintRows()) }, icon('close', 16)),
        ),
      ),
      h('button', { class: 'btn small', onclick: () => (m.subjects.push({ name: '', score: null, max: 100 }), paintRows()) }, icon('plus', 16), '科目を足す'),
    );
  paintRows();
  const kinds = h(
    'div',
    { class: 'chips' },
    MOCK_KINDS.map((k) =>
      h(
        'button',
        {
          class: 'chip' + (m.kind === k.id ? ' on' : ''),
          onclick: (e: Event) => {
            m.kind = k.id as MockKind;
            if (!m.subjects.some((s) => s.score !== null)) m.subjects = mockPreset(m.kind);
            kinds.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
            paintRows();
          },
        },
        k.label,
      ),
    ),
  );
  const judge = h('select', { class: 'input' }, ['', 'A', 'B', 'C', 'D', 'E'].map((j) => h('option', { value: j, selected: (m.judge ?? '') === j }, j || '判定なし')));
  const save = h('button', { class: 'btn primary', 'data-testid': 'mock-save' }, '保存');
  const handle = modal(
    existing ? '模試を直す' : '模試を記録',
    h(
      'div',
      { class: 'form' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '名前'), text(m.name, (v) => (m.name = v), { placeholder: '例: 第2回 京大オープン', 'data-testid': 'mock-name' })),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '受けた日'), h('input', { class: 'input', type: 'date', value: m.date, onchange: (e: Event) => (m.date = (e.target as HTMLInputElement).value || m.date) })),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, '形式'), kinds),
      m.kind === 'niji' ? h('p', { class: 'muted small' }, '京大型の満点は工学部の個別試験の配点で入れてある。模試の満点に合わせて直せ。') : null,
      rows,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '判定'), judge),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'メモ'), text(m.note ?? '', (v) => (m.note = v), { placeholder: '例: 数学の第3問で時間を使いすぎた' })),
    ),
    {
      wide: true,
      actions: [
        existing
          ? h('button', {
              class: 'btn danger',
              onclick: async () => {
                if (!(await confirmDialog('模試を消す', `「${m.name}」を消す？`, '消す', true))) return;
                ctx.hub.update((s) => void (s.mocks = s.mocks.filter((x) => x.id !== m.id)));
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
    if (!m.name.trim()) m.name = `${md(m.date)} の模試`;
    m.judge = judge.value || undefined;
    m.subjects = m.subjects.filter((s) => s.name.trim());
    ctx.hub.update((s) => {
      s.mocks = [...s.mocks.filter((x) => x.id !== m.id), m];
    });
    handle.close();
    ctx.refresh();
  };
}

function mocksTool(ctx: ToolCtx): HTMLElement {
  const list = [...ctx.hub.get().mocks].sort((a, b) => (a.date < b.date ? 1 : -1));
  const charts = MOCK_KINDS.map((k) => ({ k, s: mockSeries(list, k.id) })).filter((x) => x.s.length >= 2);
  return h(
    'div',
    null,
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('button', { class: 'btn primary', 'data-testid': 'mock-add', onclick: () => mockEditor(ctx) }, icon('plus', 18), '模試を記録')),
    charts.map(({ k, s }) => card(`${k.label}の推移（得点率）`, lineChart(s.map((x) => ({ label: x.date.slice(5).replace('-', '/'), y: x.pct }))))),
    list.length
      ? card(
          '記録',
          list.map((m) => {
            const t = mockTotal(m);
            const w = weakestSubject(m);
            const kyodai = mockKyodai(m);
            return h(
              'button',
              { class: 'list-row', 'data-testid': 'mock-row', onclick: () => mockEditor(ctx, m) },
              h('span', { class: 'list-main' }, h('b', null, m.name), h('small', { class: 'muted' }, ` ${md(m.date)}・${MOCK_KINDS.find((k) => k.id === m.kind)?.label}`), w ? h('small', { class: 'muted' }, `　いちばん低い: ${w.name} ${pct(w.score! / w.max)}`) : null),
              kyodai !== null ? h('small', null, `京大換算 ${fixed(kyodai)}/225`) : null,
              m.judge ? h('b', { class: 'judge' }, m.judge) : null,
              h('b', null, t.pct === null ? '—' : `${t.score}/${t.max}（${pct(t.pct)}）`),
            );
          }),
        )
      : h('p', { class: 'muted' }, '模試を受けたら得点を入れておけ。得点率の推移と、いちばん低い科目が出る。共通テスト型は京大工学部の換算点も出る。'),
  );
}

// ---------- 入試日程・時間割 ----------

function scheduleTool(ctx: ToolCtx): HTMLElement {
  const next = SCHEDULE_R9.find((e) => daysUntil(e.until ?? e.date) >= 0);
  return h(
    'div',
    null,
    h('p', { class: 'muted' }, '令和9年度（2027年）入試の公式日程。共通テストの時間割は工学部の受験者（地歴・公民1科目、理科2科目）のもの。「タイマー」で本番と同じ時間の過去問タイマーになる。'),
    SCHEDULE_R9.map((e) => {
      const d = daysUntil(e.date);
      const end = e.until ? daysUntil(e.until) : d;
      const past = end < 0;
      return h(
        'section',
        { class: 'card hub-card sched' + (e === next ? ' next' : '') + (past ? ' past' : ''), 'data-testid': 'sched-event' },
        h(
          'div',
          { class: 'row' },
          h('b', { class: 'sched-date' }, md(e.date), e.until ? `〜${md(e.until)}` : ''),
          h('span', { class: 'sched-title' }, e.title),
          h('span', { class: 'spacer' }),
          h('b', { class: 'sched-days' }, past ? '済' : d <= 0 ? '期間中' : `あと${d}日`),
        ),
        e.detail ? h('div', { class: 'muted small' }, e.detail) : null,
        e.slots
          ? h(
              'div',
              { class: 'slots' },
              e.slots.map((s) =>
                h(
                  'div',
                  { class: 'slot' },
                  h('span', { class: 'slot-time' }, `${s.start}〜${s.end}`),
                  h('span', null, s.subject),
                  h('small', { class: 'muted' }, `${s.minutes}分`),
                  h(
                    'button',
                    {
                      class: 'btn small',
                      'data-testid': 'slot-timer',
                      onclick: () => {
                        const who = e.title.startsWith('京大') ? '京大' : '共通';
                        ctx.app.timer.preset(`${who} ${s.subject}`, s.minutes);
                        toast(`タイマーを「${who} ${s.subject} ${s.minutes}分」にした。ノートを開いて開始`, 2600);
                      },
                    },
                    icon('timer', 14),
                    'タイマー',
                  ),
                ),
              ),
            )
          : null,
      );
    }),
    h('div', { class: 'src-row' }, source('令和9年度 京都大学入学者選抜要項', SOURCES.yoko), source('大学入試センター 令和9年度 受験案内', SOURCES.annai)),
  );
}

// ---------- 持ち物チェック ----------

function checklistTool(ctx: ToolCtx): HTMLElement {
  let which: 'kyotsu' | 'niji' = 'kyotsu';
  const body = h('div');
  const paint = () => {
    const s = ctx.hub.get();
    const items: (CheckItem & { custom?: boolean })[] = [...(which === 'kyotsu' ? CHECK_KYOTSU : CHECK_NIJI), ...s.customChecks[which].map((c) => ({ ...c, custom: true }))];
    const done = items.filter((i) => s.checks[i.id]).length;
    const input = text('', () => {}, { placeholder: '自分で足す（例: 予備の時計）', 'data-testid': 'check-new' });
    fill(body, h('div', { class: 'row', style: 'gap:8px;margin-bottom:10px' }, h('b', { 'data-testid': 'check-count' }, `${done} / ${items.length}`), h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: () => (ctx.hub.update((st) => items.forEach((i) => delete st.checks[i.id])), paint()) }, '全部外す')),
      items.map((i) =>
        h(
          'label',
          { class: 'check-row' + (s.checks[i.id] ? ' done' : ''), 'data-testid': 'check-item' },
          h('input', {
            type: 'checkbox',
            checked: !!s.checks[i.id],
            onchange: (e: Event) => {
              const on = (e.target as HTMLInputElement).checked;
              ctx.hub.update((st) => {
                if (on) st.checks[i.id] = true;
                else delete st.checks[i.id];
              });
              paint();
            },
          }),
          h('span', null, h('span', null, i.text), i.note ? h('small', { class: 'muted' }, i.note) : null),
          i.custom
            ? h('button', { class: 'icon-btn', 'aria-label': '消す', onclick: (e: Event) => (e.preventDefault(), ctx.hub.update((st) => void (st.customChecks[which] = st.customChecks[which].filter((c) => c.id !== i.id))), paint()) }, icon('close', 14))
            : null,
        ),
      ),
      h(
        'div',
        { class: 'row', style: 'gap:6px;margin-top:8px' },
        input,
        h(
          'button',
          {
            class: 'btn small',
            onclick: () => {
              const t = input.value.trim();
              if (!t) return;
              ctx.hub.update((st) => void st.customChecks[which].push({ id: uid(), text: t }));
              paint();
            },
          },
          icon('plus', 16),
        ),
      ),
      which === 'kyotsu'
        ? card('試験中に使えないもの', h('ul', { class: 'plain' }, KYOTSU_FORBIDDEN.map((t) => h('li', null, t))), source('大学入試センター 令和9年度 受験案内', SOURCES.annai))
        : h('p', { class: 'muted small' }, '京大の試験での注意は、受験票と一緒に案内される京大の「受験上の注意」で必ず確認しろ。ここは自分で足していく用。'),
    );
  };
  paint();
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'chips', style: 'margin-bottom:12px' },
      (
        [
          ['kyotsu', '共通テスト'],
          ['niji', '京大 二次'],
        ] as const
      ).map(([id, label]) =>
        h(
          'button',
          {
            class: 'chip' + (which === id ? ' on' : ''),
            onclick: (e: Event) => {
              which = id;
              (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
              paint();
            },
          },
          label,
        ),
      ),
    ),
    body,
  );
}

export const STRATEGY_TOOLS: Tool[] = [
  {
    id: 'score',
    group: 'strategy',
    title: '合格点シミュレーター',
    blurb: '共通テストの点 → 京大工学部の換算点と、二次で要る点',
    icon: 'trophy',
    summary: (ctx) => {
      const c = convertKyotsu(ctx.hub.get().score.kyotsu);
      if (!c.complete) return null;
      const n = nijiNeeded(c.total, Math.max(...RECENT.map((r) => r.min)));
      return `共通 ${fixed(c.total, 1)}/225 → 二次で ${n ? Math.ceil(n.points) + '点' : '届かない'}（過去2年の高い方の最低点）`;
    },
    render: scoreTool,
  },
  {
    id: 'mocks',
    group: 'strategy',
    title: '模試の記録',
    blurb: '得点率の推移、いちばん低い科目、京大換算',
    icon: 'chart',
    summary: (ctx) => {
      const m = [...ctx.hub.get().mocks].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      if (!m) return null;
      const t = mockTotal(m);
      return `最新: ${m.name} ${pct(t.pct)}${m.judge ? `・${m.judge}判定` : ''}`;
    },
    render: mocksTool,
  },
  {
    id: 'schedule',
    group: 'strategy',
    title: '入試日程・時間割',
    blurb: '出願〜合格発表、本番の時間割でタイマー',
    icon: 'calendar',
    summary: () => {
      const e = SCHEDULE_R9.find((x) => daysUntil(x.until ?? x.date) >= 0);
      if (!e) return null;
      const d = daysUntil(e.date);
      return `次: ${e.title}（${d <= 0 ? '期間中' : `あと${d}日`}）`;
    },
    render: scheduleTool,
  },
  {
    id: 'checklist',
    group: 'strategy',
    title: '持ち物チェック',
    blurb: '共通テストの持ち物（受験案内どおり）と二次',
    icon: 'checklist',
    summary: (ctx) => {
      const s = ctx.hub.get();
      const all = [...CHECK_KYOTSU, ...s.customChecks.kyotsu];
      const n = all.filter((i) => s.checks[i.id]).length;
      return n ? `共通テスト ${n}/${all.length}` : null;
    },
    render: checklistTool,
  },
];

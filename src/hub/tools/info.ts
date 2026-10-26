/** 情報Ⅰ: 共通テスト用プログラム表記の実行環境（トレース表つき）, 基数変換・ビット演算・文字コード・論理回路. */
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { runDncl, truthTable, type RunResult } from '../dncl';
import { bitOp, charCodes, fromTwos, parseBase, toBase, twosComplement, type Base, type BitOp } from '../radix';
import { card, fill, source, text } from '../ui';
import type { Tool } from './index';

const DNC_SOURCE = 'https://www.dnc.ac.jp/albums/abm.php?d=744&f=abm00003141.pdf';

const EXAMPLES: { label: string; code: string; input?: string }[] = [
  {
    label: '二分探索（センターの例示）',
    code: `Data=[3,18,29,33,48,52,62,77,89,97]
kazu=要素数(Data)
表示する("0～99の数字を入力してください")
atai=【外部からの入力】
hidari=0 , migi=kazu-1
owari=0
hidari <= migi and owari==0 の間繰り返す:
｜ aida=(hidari+migi)÷2 # 演算子÷は商の整数値を返す
｜ もし Data[aida]==atai ならば:
｜ ｜表示する(atai,"は",aida,"番目にありました")
｜ ｜owari=1
｜ そうでなくもし Data[aida]<atai ならば:
｜ ｜hidari=aida+1
｜ そうでなければ:
⎿ ⎿migi=aida-1
もし owari==0 ならば:
⎿ 表示する(atai,"は見つかりませんでした")`,
    input: '52',
  },
  {
    label: '最大値',
    code: `Tokuten = [62, 85, 47, 91, 73]
saidai = Tokuten[0]
i を 1 から 要素数(Tokuten) - 1 まで 1 ずつ増やしながら繰り返す:
｜ もし Tokuten[i] > saidai ならば:
⎿ ⎿ saidai = Tokuten[i]
表示する("最高点は", saidai)`,
  },
  {
    label: '2進数に変換',
    code: `n = 13
kekka = ""
n > 0 の間繰り返す:
｜ kekka = (n % 2) + kekka
⎿ n = n ÷ 2
表示する(kekka)`,
  },
];

const SNIPPETS = ['｜ ', '⎿ ', 'もし  ならば:', 'そうでなくもし  ならば:', 'そうでなければ:', ' の間繰り返す:', 'i を 0 から  まで 1 ずつ増やしながら繰り返す:', '表示する()', '要素数()', '【外部からの入力】', '÷', '%', '!=', 'and', 'or', 'not'];

function programTool(): HTMLElement {
  let code = '';
  let input = '';
  try {
    code = localStorage.getItem('sumi.dncl') ?? EXAMPLES[0].code;
    input = localStorage.getItem('sumi.dncl.in') ?? EXAMPLES[0].input ?? '';
  } catch {
    code = EXAMPLES[0].code;
  }
  const keep = () => {
    try {
      localStorage.setItem('sumi.dncl', editor.value);
      localStorage.setItem('sumi.dncl.in', inputs.value);
    } catch {
      /* ignore */
    }
  };
  const gutter = h('div', { class: 'code-gutter' });
  const editor = h('textarea', { class: 'input mono code', rows: 16, spellcheck: false, 'data-testid': 'dncl-code', oninput: () => (keep(), paintGutter()), onscroll: () => (gutter.scrollTop = editor.scrollTop) });
  editor.value = code;
  const inputs = h('textarea', { class: 'input mono', rows: 3, placeholder: '【外部からの入力】に渡す値（1行に1つ）', 'data-testid': 'dncl-input', oninput: keep });
  inputs.value = input;
  const paintGutter = (errLine = 0) => {
    const n = editor.value.split('\n').length;
    fill(gutter, ...Array.from({ length: n }, (_, i) => h('div', { class: i + 1 === errLine ? 'err' : '' }, String(i + 1))));
  };
  paintGutter();
  const out = h('div', { 'data-testid': 'dncl-result' });
  const insert = (s: string) => {
    const a = editor.selectionStart, b = editor.selectionEnd;
    editor.value = editor.value.slice(0, a) + s + editor.value.slice(b);
    const caret = a + (s.includes('  ') ? s.indexOf('  ') + 1 : s.endsWith('()') ? s.length - 1 : s.length);
    editor.focus();
    editor.setSelectionRange(caret, caret);
    keep();
    paintGutter();
  };
  const run = () => {
    const r = runDncl(editor.value, { inputs: inputs.value.split('\n').filter((l) => l.trim() !== '') });
    paintGutter(r.error?.line ?? 0);
    fill(out, ...result(r));
  };
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-bottom:8px' },
      h('span', { class: 'muted small' }, '例：'),
      EXAMPLES.map((e) => h('button', { class: 'chip', onclick: () => ((editor.value = e.code), (inputs.value = e.input ?? ''), keep(), paintGutter(), run()) }, e.label)),
    ),
    h('div', { class: 'snippets' }, SNIPPETS.map((s) => h('button', { class: 'chip mono', onmousedown: (e: Event) => e.preventDefault(), onclick: () => insert(s) }, s.trim() || s))),
    h('div', { class: 'code-wrap' }, gutter, editor),
    h('div', { class: 'row', style: 'gap:8px;margin:8px 0;align-items:flex-start' }, inputs, h('button', { class: 'btn primary', 'data-testid': 'dncl-run', onclick: run }, icon('play', 18), '実行')),
    out,
    h(
      'p',
      { class: 'muted small' },
      '大学入試センターの「共通テスト用プログラム表記の例示」の書き方で動く：変数・配列（Data[2,4] も）・文字列の +・1行に複数の文（カンマ区切り）・「Xのすべての値を0にする」・【外部からの入力】・+ - * / ÷（商）%（余り）**・比較・and/or/not・要素数()・整数()・乱数()・表示する()・もし/そうでなくもし/そうでなければ・〜の間繰り返す・〜ずつ増やしながら/減らしながら繰り返す・#コメント。ブロックは ｜ と ⎿（または字下げ）。問題文の行番号「( 1 )」はそのまま貼っても無視する。問題で説明される独自の関数は使えない。',
    ),
    source('大学入試センター 試作問題「情報」の概要（共通テスト用プログラム表記の例示）', DNC_SOURCE),
  );
}

function result(r: RunResult): HTMLElement[] {
  // Plain values first (they change every step), arrays after.
  const last = r.trace.length ? r.trace[r.trace.length - 1].vars : {};
  const names = [...new Set(r.trace.flatMap((t) => Object.keys(t.vars)))].sort((a, b) => Number(last[a]?.startsWith('[') ?? false) - Number(last[b]?.startsWith('[') ?? false));
  return [
    card(
      r.error ? h('span', { class: 'bad' }, `${r.error.line ? `${r.error.line}行目: ` : ''}${r.error.message}`) : `実行結果（${r.steps}ステップ）`,
      h('pre', { class: 'dncl-out', 'data-testid': 'dncl-out' }, r.output.join('\n') || '（表示なし）'),
    ),
    r.trace.length
      ? card(
          `トレース表${r.traceCut ? `（最初の${r.trace.length}ステップ）` : ''}`,
          h(
            'div',
            { class: 'trace-wrap' },
            h(
              'table',
              { class: 'tbl trace', 'data-testid': 'dncl-trace' },
              h('tr', null, h('th', null, '#'), h('th', null, '行'), h('th', null, '文'), h('th', null, ''), names.map((n) => h('th', { class: 'mono' }, n))),
              r.trace.map((t, i) => {
                const prev = i ? r.trace[i - 1].vars : {};
                return h(
                  'tr',
                  null,
                  h('td', { class: 'muted' }, String(i + 1)),
                  h('td', null, String(t.line)),
                  h('td', { class: 'mono' }, t.text),
                  h('td', { class: 'small' }, t.note ?? ''),
                  names.map((n) => h('td', { class: 'mono val' + (t.vars[n] !== prev[n] ? ' changed' : ''), title: t.vars[n] ?? '' }, t.vars[n] ?? '')),
                );
              }),
            ),
          ),
        )
      : h('span'),
  ];
}

function radixTool(): HTMLElement {
  // 基数変換
  let base: Base = 10;
  const conv = h('div', { class: 'radix-out', 'data-testid': 'radix-out' });
  const numIn = text('', () => paintConv(), { placeholder: '数を入れる', 'data-testid': 'radix-in' });
  const paintConv = () => {
    const n = parseBase(numIn.value, base);
    fill(conv, ...(n === null
        ? [h('span', { class: 'muted' }, numIn.value ? `${base}進数として読めない` : '')]
        : ([2, 8, 10, 16] as Base[]).map((b) => h('div', null, h('small', { class: 'muted' }, `${b}進 `), h('b', { class: 'mono', 'data-testid': `radix-${b}` }, toBase(n, b))))),
    );
  };
  const baseChips = h(
    'div',
    { class: 'chips' },
    ([2, 8, 10, 16] as Base[]).map((b) =>
      h(
        'button',
        {
          class: 'chip' + (b === base ? ' on' : ''),
          'data-testid': `base-${b}`,
          onclick: (e: Event) => {
            base = b;
            baseChips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
            paintConv();
          },
        },
        `${b}進数`,
      ),
    ),
  );
  // 2の補数
  let bits = 8;
  const twoOut = h('div', { class: 'mono', 'data-testid': 'twos-out' });
  const twoIn = text('', () => paintTwo(), { placeholder: '10進数（負も可）か 0/1 の並び', 'data-testid': 'twos-in' });
  const paintTwo = () => {
    const v = twoIn.value.trim();
    if (!v) return fill(twoOut);
    if (/^[01\s]+$/.test(v) && v.replace(/\s/g, '').length > 1) {
      const n = fromTwos(v);
      twoOut.textContent = n === null ? '' : `${v.replace(/\s/g, '')} → ${n}（2の補数として）`;
    } else {
      const n = Number(v);
      const t = Number.isInteger(n) ? twosComplement(n, bits) : null;
      twoOut.textContent = t === null ? `${bits}ビットでは表せない（${-(2 ** (bits - 1))}〜${2 ** (bits - 1) - 1}）` : `${n} → ${t.replace(/(.{4})(?=.)/g, '$1 ')}`;
    }
  };
  const bitChips = h(
    'div',
    { class: 'chips' },
    [4, 8, 16].map((b) =>
      h(
        'button',
        {
          class: 'chip' + (b === bits ? ' on' : ''),
          onclick: (e: Event) => {
            bits = b;
            bitChips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
            paintTwo();
          },
        },
        `${b}ビット`,
      ),
    ),
  );
  // ビット演算
  let op: BitOp = 'AND';
  const aIn = text('1100', () => paintOp(), { class: 'input mono' });
  const bIn = text('1010', () => paintOp(), { class: 'input mono' });
  const opOut = h('b', { class: 'mono', 'data-testid': 'bitop-out' });
  const paintOp = () => {
    const a = parseBase(aIn.value, 2), b = parseBase(bIn.value, 2);
    const w = Math.max(aIn.value.replace(/\s/g, '').length, bIn.value.replace(/\s/g, '').length);
    opOut.textContent = a === null || b === null ? '' : bitOp(a, b, op, Math.min(32, w));
  };
  paintOp();
  const opChips = h(
    'div',
    { class: 'chips' },
    (['AND', 'OR', 'XOR'] as BitOp[]).map((o) =>
      h(
        'button',
        {
          class: 'chip' + (o === op ? ' on' : ''),
          onclick: (e: Event) => {
            op = o;
            opChips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
            paintOp();
          },
        },
        o,
      ),
    ),
  );
  // 文字コード
  const chOut = h('div', { class: 'mono' });
  const chIn = text('', () => fill(chOut, ...charCodes(chIn.value).map((c) => h('div', null, `${c.char}  ${c.codePoint}  UTF-8: ${c.utf8.join(' ')}`))), { placeholder: '文字（例: あA）' });
  // 論理回路
  const ttOut = h('div', { 'data-testid': 'truth-out' });
  const ttIn = text('A and not B', () => paintTT(), { class: 'input mono', 'data-testid': 'truth-in' });
  const paintTT = () => {
    try {
      const t = truthTable(ttIn.value);
      fill(ttOut, h('table', { class: 'tbl truth' }, h('tr', null, t.vars.map((v) => h('th', null, v)), h('th', null, '出力')), t.rows.map((r) => h('tr', null, r.inputs.map((x) => h('td', null, String(x))), h('td', { class: r.out ? 'good' : '' }, String(r.out))))));
    } catch (e) {
      fill(ttOut, h('span', { class: 'muted' }, (e as Error).message));
    }
  };
  paintTT();
  return h(
    'div',
    { class: 'hub-cols' },
    card('基数変換', baseChips, numIn, conv),
    card('2の補数', bitChips, twoIn, twoOut),
    card('ビット演算', h('div', { class: 'row', style: 'gap:6px' }, aIn, opChips, bIn), h('div', { style: 'margin-top:6px' }, '= ', opOut)),
    card('文字コード（Unicode・UTF-8）', chIn, chOut),
    card('論理回路の真理値表', h('p', { class: 'muted small' }, 'and / or / not（∧ ∨ ¬ も可）と ( ) で書く。変数は6個まで。'), ttIn, ttOut),
  );
}

export const INFO_TOOLS: Tool[] = [
  { id: 'program', group: 'info', title: 'プログラム表記の実行', blurb: '共通テスト用プログラム表記をそのまま実行。トレース表つき', icon: 'code', render: () => programTool() },
  { id: 'radix', group: 'info', title: '基数変換・論理回路', blurb: '2・8・10・16進、2の補数、ビット演算、文字コード、真理値表', icon: 'binary', render: () => radixTool() },
];

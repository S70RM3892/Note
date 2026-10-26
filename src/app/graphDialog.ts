import { parseNumber } from '../core/expr';
import { buildGraph, type Graph, type GraphSpec } from '../core/graph';
import { LINE_HEIGHT, TEXT_FONT, layoutText } from '../editor/paint';
import { h } from '../ui/dom';
import { modal } from '../ui/dialogs';
import { chipGroup } from './newNotebook';

const MM = 96 / 25.4;
const SIZES = [
  { id: 's', label: '小 6cm', mm: 60 },
  { id: 'm', label: '中 9cm', mm: 90 },
  { id: 'l', label: '大 13cm', mm: 130 },
] as const;
type SizeId = (typeof SIZES)[number]['id'];

interface Form {
  exprs: string;
  xmin: string;
  xmax: string;
  ymin: string;
  ymax: string;
  size: SizeId;
  equal: boolean;
  grid: boolean;
  numbers: boolean;
  piTicks: boolean;
}

const PRESETS: { label: string; form: Partial<Form> }[] = [
  { label: '放物線', form: { exprs: 'y = x^2 - 2x - 3', xmin: '-3', xmax: '5', ymin: '', ymax: '', equal: false, piTicks: false } },
  { label: '三角関数', form: { exprs: 'y = sin x\ny = cos x', xmin: '-2π', xmax: '2π', ymin: '-1.5', ymax: '1.5', equal: true, piTicks: true } },
  { label: '指数・対数', form: { exprs: 'y = 2^x\ny = log_2 x', xmin: '-3', xmax: '5', ymin: '-3', ymax: '5', equal: true, piTicks: false } },
  { label: '分数関数', form: { exprs: 'y = 1/(x-1) + 2', xmin: '-4', xmax: '6', ymin: '-3', ymax: '7', equal: true, piTicks: false } },
  { label: '座標軸だけ', form: { exprs: '', xmin: '-5', xmax: '5', ymin: '-5', ymax: '5', equal: true, piTicks: false } },
];

// Remembered for the next graph in this session.
let last: Form = { exprs: 'y = x^2 - 2x - 3', xmin: '-3', xmax: '5', ymin: '', ymax: '', size: 'm', equal: false, grid: false, numbers: true, piTicks: false };

const measure = (text: string, size: number) => {
  const m = layoutText(text, size, 1e4);
  return { w: m.w, h: m.h };
};

function toSpec(f: Form): { spec: GraphSpec | null; error: string | null } {
  try {
    const xmin = parseNumber(f.xmin || '-5'), xmax = parseNumber(f.xmax || '5');
    if (xmin === xmax) return { spec: null, error: 'x の範囲が幅 0' };
    const y = f.ymin.trim() && f.ymax.trim() ? { ymin: parseNumber(f.ymin), ymax: parseNumber(f.ymax) } : {};
    const exprs = f.exprs
      .split(/\n|;/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 4);
    const mm = SIZES.find((s) => s.id === f.size)?.mm ?? 90;
    return { spec: { exprs, xmin, xmax, ...y, width: mm * MM, equal: f.equal, grid: f.grid, numbers: f.numbers, piTicks: f.piTicks }, error: null };
  } catch (e) {
    return { spec: null, error: `範囲: ${e instanceof Error ? e.message : e}` };
  }
}

/** Draw a built graph onto a canvas (preview). */
export function drawGraph(cv: HTMLCanvasElement, g: Graph, cssW: number, cssH: number) {
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  cv.style.width = cssW + 'px';
  cv.style.height = cssH + 'px';
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cssW, cssH);
  const k = Math.min((cssW - 16) / g.w, (cssH - 16) / g.h);
  ctx.translate((cssW - g.w * k) / 2, (cssH - g.h * k) / 2);
  ctx.scale(k, k);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const l of g.lines) {
    ctx.strokeStyle = l.color;
    ctx.lineWidth = l.width;
    ctx.beginPath();
    ctx.moveTo(l.pts[0], l.pts[1]);
    for (let i = 2; i < l.pts.length; i += 2) ctx.lineTo(l.pts[i], l.pts[i + 1]);
    ctx.stroke();
  }
  // Same placement as paintText, so the preview matches the page.
  ctx.textBaseline = 'top';
  for (const t of g.labels) {
    ctx.fillStyle = t.color;
    ctx.font = `${t.size}px ${TEXT_FONT}`;
    ctx.fillText(t.text, t.x, t.y + t.size * (LINE_HEIGHT - 1) * 0.5);
  }
}

/** 関数グラフを挿入: expressions, ranges and options with a live preview. */
export function openGraphDialog(onInsert: (g: Graph) => void) {
  const f: Form = { ...last };
  const input = (key: 'xmin' | 'xmax' | 'ymin' | 'ymax', placeholder: string) =>
    h('input', { class: 'input graph-num', value: f[key], placeholder, inputmode: 'text', 'data-testid': `graph-${key}`, oninput: (e: Event) => ((f[key] = (e.target as HTMLInputElement).value), schedule()) });
  const exprs = h('textarea', {
    class: 'input graph-exprs',
    rows: 3,
    placeholder: 'y = x^2 - 2x - 3\ny = sin x\n（1行に1つ・最大4本）',
    'data-testid': 'graph-exprs',
    spellcheck: false,
    autocapitalize: 'off',
    oninput: () => ((f.exprs = exprs.value), schedule()),
  });
  exprs.value = f.exprs;
  const fields = { xmin: input('xmin', '-5'), xmax: input('xmax', '5'), ymin: input('ymin', '自動'), ymax: input('ymax', '自動') };
  const check = (key: 'equal' | 'grid' | 'numbers' | 'piTicks', label: string) =>
    h('label', { class: 'graph-check' }, h('input', { type: 'checkbox', checked: f[key], 'data-testid': `graph-${key}`, onchange: (e: Event) => ((f[key] = (e.target as HTMLInputElement).checked), schedule()) }), label);
  const checks = h('div', { class: 'graph-checks' });
  const renderChecks = () => checks.replaceChildren(check('equal', '縦横同じ縮尺'), check('grid', '方眼'), check('numbers', '目盛りの数字'), check('piTicks', 'x 軸を π 単位'));
  renderChecks();
  const cv = h('canvas', { class: 'graph-preview', 'data-testid': 'graph-preview' });
  const err = h('div', { class: 'graph-error', 'data-testid': 'graph-error' });
  let graph: Graph | null = null;
  const insert = h('button', { class: 'btn primary', 'data-testid': 'graph-insert', onclick: () => graph && (m.close(), onInsert(graph)) }, '挿入');

  const update = () => {
    const { spec, error } = toSpec(f);
    graph = spec ? buildGraph(spec, measure) : null;
    const msgs = error ? [error] : [];
    graph?.errors.forEach((e, i) => e && msgs.push(`${i + 1}本目: ${e}`));
    err.textContent = msgs.join(' / ');
    insert.disabled = !graph || !!graph.errors.some(Boolean);
    if (graph) drawGraph(cv, graph, 420, 300);
  };
  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(update, 120);
  };

  const presets = h(
    'div',
    { class: 'chips' },
    PRESETS.map((p) =>
      h(
        'button',
        {
          class: 'chip',
          onclick: () => {
            Object.assign(f, p.form);
            exprs.value = f.exprs;
            for (const k of ['xmin', 'xmax', 'ymin', 'ymax'] as const) fields[k].value = f[k];
            renderChecks();
            update();
          },
        },
        p.label,
      ),
    ),
  );

  const body = h(
    'div',
    { class: 'graph-dialog' },
    h(
      'div',
      { class: 'graph-form' },
      presets,
      h('div', { class: 'field' }, h('label', null, '関数'), exprs, err),
      h('div', { class: 'field' }, h('label', null, '範囲（π, 2π, 1/2 も可）'), h('div', { class: 'graph-range' }, h('span', null, 'x'), fields.xmin, '〜', fields.xmax), h('div', { class: 'graph-range' }, h('span', null, 'y'), fields.ymin, '〜', fields.ymax)),
      h(
        'div',
        { class: 'field' },
        h('label', null, '大きさ'),
        chipGroup(
          SIZES.map((s) => ({ id: s.id, label: s.label })),
          f.size,
          (v) => ((f.size = v), schedule()),
        ),
      ),
      checks,
    ),
    cv,
  );
  const cancel = h('button', { class: 'btn', onclick: () => m.close() }, 'キャンセル');
  const m = modal('関数グラフを挿入', body, { wide: true, actions: [cancel, insert], onClose: () => ((last = { ...f }), clearTimeout(timer)) });
  update();
}

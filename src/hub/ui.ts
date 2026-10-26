/** Small building blocks shared by the 受験ハブ's pages. */
import { native } from '../platform';
import { append, clear, h } from '../ui/dom';

/** Replace an element's children (arrays and null/false allowed, as in h()). */
export function fill(el: Element, ...children: Parameters<typeof append>[1]) {
  clear(el);
  append(el, children);
}

export function card(title: string | Node | null, ...children: (Node | string | null | false | undefined | (Node | null)[])[]): HTMLElement {
  return h('section', { class: 'card hub-card' }, title ? h('h3', { class: 'card-head' }, title) : null, ...children);
}

export function num(value: number | null | undefined, on: (v: number | null) => void, attrs: Record<string, unknown> = {}): HTMLInputElement {
  return h('input', {
    class: 'input num-input',
    type: 'number',
    inputmode: 'decimal',
    value: value ?? '',
    oninput: (e: Event) => {
      const t = (e.target as HTMLInputElement).value;
      on(t === '' ? null : Number(t));
    },
    ...attrs,
  });
}

export function text(value: string, on: (v: string) => void, attrs: Record<string, unknown> = {}): HTMLInputElement {
  return h('input', { class: 'input', value, oninput: (e: Event) => on((e.target as HTMLInputElement).value), ...attrs });
}

export function pct(x: number | null | undefined, digits = 0): string {
  return x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(digits)}%`;
}

export function fixed(x: number, digits = 2): string {
  return Number.isFinite(x) ? x.toFixed(digits).replace(/\.?0+$/, '') : '—';
}

/** "10/26(月)" from YYYY-MM-DD. */
export function md(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}/${d}(${'日月火水木金土'[dt.getDay()]})`;
}

/** A link to an official source (opens outside the app in the APK). */
export function source(label: string, url: string): HTMLElement {
  return h(
    'a',
    {
      class: 'src-link',
      href: url,
      target: '_blank',
      rel: 'noopener',
      onclick: (e: Event) => {
        if (native) {
          e.preventDefault();
          native.openUrl(url);
        }
      },
    },
    '出典：' + label,
  );
}

export function progress(frac: number, cls = ''): HTMLElement {
  return h('div', { class: 'prog ' + cls }, h('i', { style: `width:${Math.max(0, Math.min(1, frac)) * 100}%` }));
}

/** A small line chart of values 0..1 (percentages) with their labels underneath. */
export function lineChart(points: { label: string; y: number }[], height = 120): SVGElement {
  const W = 320, H = height, P = 18;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 16}`);
  svg.setAttribute('class', 'line-chart');
  const x = (i: number) => (points.length === 1 ? W / 2 : P + (i * (W - 2 * P)) / (points.length - 1));
  const y = (v: number) => P / 2 + (1 - v) * (H - P);
  for (const g of [0.5, 0.7, 0.9]) {
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('x1', '0');
    l.setAttribute('x2', String(W));
    l.setAttribute('y1', String(y(g)));
    l.setAttribute('y2', String(y(g)));
    l.setAttribute('class', 'grid');
    svg.append(l);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', '2');
    t.setAttribute('y', String(y(g) - 2));
    t.textContent = `${g * 100}%`;
    svg.append(t);
  }
  const path = document.createElementNS(NS, 'polyline');
  path.setAttribute('points', points.map((p, i) => `${x(i)},${y(p.y)}`).join(' '));
  path.setAttribute('class', 'series');
  svg.append(path);
  points.forEach((p, i) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(x(i)));
    c.setAttribute('cy', String(y(p.y)));
    c.setAttribute('r', '3.5');
    svg.append(c);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', String(x(i)));
    t.setAttribute('y', String(H + 12));
    t.setAttribute('text-anchor', 'middle');
    t.textContent = p.label;
    svg.append(t);
  });
  return svg;
}

export function todayKey(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 問題ごとのノート (one board per problem of a 問題集) and the dates each page was written. */
import type { Page, ProblemResult } from './types';

export const LABEL_FORMATS = [
  { id: 'n', label: '1, 2, 3', make: (n: number) => String(n) },
  { id: 'mon', label: '問1', make: (n: number) => `問${n}` },
  { id: 'dai', label: '第1問', make: (n: number) => `第${n}問` },
  { id: 'rei', label: '例題1', make: (n: number) => `例題${n}` },
  { id: 'en', label: '演習1', make: (n: number) => `演習${n}` },
] as const;

export type LabelFormat = (typeof LABEL_FORMATS)[number]['id'];

export const MAX_PROBLEMS = 1000;

export function problemLabels(format: LabelFormat, start: number, count: number): string[] {
  const f = LABEL_FORMATS.find((x) => x.id === format) ?? LABEL_FORMATS[0];
  const n = Math.max(1, Math.min(MAX_PROBLEMS, Math.floor(count)));
  const s = Math.max(0, Math.floor(start));
  return Array.from({ length: n }, (_, i) => f.make(s + i));
}

export interface ProblemGroup {
  label: string;
  /** Page indices, in order. */
  pages: number[];
  result?: ProblemResult;
  /** Something has been written on it. */
  written: boolean;
}

/** Consecutive pages with the same label form one problem; pages without a label stand alone. */
export function problemGroups(pages: Page[]): ProblemGroup[] {
  const out: ProblemGroup[] = [];
  pages.forEach((p, i) => {
    const last = out[out.length - 1];
    if (last && p.problem !== undefined && last.label === p.problem && pages[i - 1]?.problem === p.problem) last.pages.push(i);
    else out.push({ label: p.problem ?? `p.${i + 1}`, pages: [i], written: false });
  });
  for (const g of out) {
    g.result = g.pages.map((i) => pages[i].result).find((r) => r);
    g.written = g.pages.some((i) => pages[i].strokes.some((s) => !s.locked));
  }
  return out;
}

/** The problem a page belongs to. */
export function groupAt(groups: ProblemGroup[], pageIndex: number): ProblemGroup | undefined {
  return groups.find((g) => g.pages.includes(pageIndex));
}

export function resultCounts(groups: ProblemGroup[]) {
  return {
    o: groups.filter((g) => g.result === 'o').length,
    d: groups.filter((g) => g.result === 'd').length,
    x: groups.filter((g) => g.result === 'x').length,
    todo: groups.filter((g) => !g.result && !g.written).length,
    total: groups.length,
  };
}

export const RESULT_MARK: Record<ProblemResult, string> = { o: '○', d: '△', x: '×' };

function key(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Days a page was written on (pages from before this was kept: the day of its last change). */
export function pageDays(p: Page): string[] {
  return p.days?.length ? p.days : p.strokes.length || p.items.length ? [key(p.updated)] : [];
}

/** Note that the page was written on `day`; false when it already was. */
export function addDay(p: Page, day: string): boolean {
  const days = p.days ?? [];
  if (days.includes(day)) return false;
  p.days = [...days, day].sort().slice(-60);
  return true;
}

/** Date → pages written that day (a page shows under every day it was written), newest or oldest day first. */
export function pagesByDate(pages: Page[], order: 'new' | 'old' = 'new'): { day: string; pages: number[] }[] {
  const m = new Map<string, number[]>();
  pages.forEach((p, i) => {
    for (const d of pageDays(p)) m.set(d, [...(m.get(d) ?? []), i]);
  });
  const days = [...m.keys()].sort();
  if (order === 'new') days.reverse();
  return days.map((day) => ({ day, pages: m.get(day)! }));
}

/** The problem around page `i` without looking at strokes (cheap enough for every toolbar update). */
export function problemAt(pages: Page[], i: number): { label: string; index: number; total: number; first: number; last: number; result?: ProblemResult } | null {
  const p = pages[i];
  if (!p || p.problem === undefined) return null;
  let index = -1, total = 0;
  for (let k = 0; k < pages.length; k++) {
    const starts = k === 0 || pages[k].problem === undefined || pages[k].problem !== pages[k - 1].problem;
    if (starts) total++;
    if (k === i) index = total - 1;
  }
  let first = i, last = i;
  while (first > 0 && pages[first - 1].problem === p.problem) first--;
  while (last < pages.length - 1 && pages[last + 1].problem === p.problem) last++;
  let result: ProblemResult | undefined;
  for (let k = first; k <= last && !result; k++) result = pages[k].result;
  return { label: p.problem, index, total, first, last, result };
}

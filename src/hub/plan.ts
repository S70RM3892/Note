/** 模試の記録, 参考書の進捗, 過去問の進捗表, 1日の振り返り, 質問リスト. */
import { dayKey } from '../store/repo';
import { KYOTSU_SUBJECTS, NIJI_SUBJECTS, convertKyotsu, type KyotsuId } from './exam';

// ---------- 模試 ----------

export type MockKind = 'kyotsu' | 'niji' | 'other';

export interface MockSubject {
  /** Preset subjects carry the 共通テスト科目 id (for the 京大換算). */
  id?: string;
  name: string;
  score: number | null;
  max: number;
  dev?: number | null;
}

export interface MockExam {
  id: string;
  name: string;
  /** YYYY-MM-DD */
  date: string;
  kind: MockKind;
  subjects: MockSubject[];
  /** 判定 (A〜E) */
  judge?: string;
  note?: string;
}

export const MOCK_KINDS: { id: MockKind; label: string }[] = [
  { id: 'kyotsu', label: '共通テスト型' },
  { id: 'niji', label: '京大型（記述）' },
  { id: 'other', label: 'その他' },
];

/** Subjects a new mock starts with. 京大型 uses 工学部の個別試験の配点: set them to the 模試's own full marks. */
export function mockPreset(kind: MockKind): MockSubject[] {
  if (kind === 'kyotsu') return KYOTSU_SUBJECTS.map((s) => ({ id: s.id, name: s.label, score: null, max: s.max }));
  if (kind === 'niji') return NIJI_SUBJECTS.map((s) => ({ name: s.label, score: null, max: s.max }));
  return [{ name: '合計', score: null, max: 100 }];
}

export function mockTotal(m: MockExam): { score: number; max: number; pct: number | null } {
  const done = m.subjects.filter((s) => typeof s.score === 'number' && s.max > 0);
  const score = done.reduce((a, s) => a + s.score!, 0);
  const max = done.reduce((a, s) => a + s.max, 0);
  return { score, max, pct: max ? score / max : null };
}

/** 共通テスト型: what the scores come to in 京大工学部's 225 points (only when every subject is in). */
export function mockKyodai(m: MockExam): number | null {
  if (m.kind !== 'kyotsu') return null;
  const raw: Partial<Record<KyotsuId, number>> = {};
  for (const s of m.subjects) if (s.id && typeof s.score === 'number') raw[s.id as KyotsuId] = s.score;
  const c = convertKyotsu(raw);
  return c.complete ? c.total : null;
}

/** The subject furthest below its full marks. */
export function weakestSubject(m: MockExam): MockSubject | null {
  let best: MockSubject | null = null;
  for (const s of m.subjects) {
    if (typeof s.score !== 'number' || !s.max) continue;
    if (!best || s.score / s.max < best.score! / best.max) best = s;
  }
  return best;
}

/** Mocks of one kind, oldest first, with their total percentage (for the chart). */
export function mockSeries(list: MockExam[], kind: MockKind): { date: string; name: string; pct: number }[] {
  return list
    .filter((m) => m.kind === kind)
    .map((m) => ({ date: m.date, name: m.name, pct: mockTotal(m).pct }))
    .filter((x): x is { date: string; name: string; pct: number } => x.pct !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------- 参考書 ----------

export interface Book {
  id: string;
  title: string;
  subject?: string;
  /** 問 / ページ / 章 … */
  unit: string;
  total: number;
  done: number;
  /** Progress already made when the book was added. */
  startDone: number;
  /** Finish by (YYYY-MM-DD). */
  deadline?: string;
  created: number;
  /** Progress over time: units done at the end of each day it changed. */
  log: { day: string; done: number }[];
}

function dateOf(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Whole days from a to b (local dates). */
export function daysBetween(a: string, b: string): number {
  return Math.round((dateOf(b).getTime() - dateOf(a).getTime()) / 86400000);
}

export function addDaysKey(key: string, n: number): string {
  const d = dateOf(key);
  d.setDate(d.getDate() + n);
  return dayKey(d.getTime());
}

/** Record progress (today's entry replaces an earlier one from today). */
export function setBookDone(b: Book, done: number, now = Date.now()): Book {
  const day = dayKey(now);
  const v = Math.max(0, Math.min(b.total, Math.round(done)));
  const log = [...b.log.filter((l) => l.day !== day), { day, done: v }].sort((x, y) => (x.day < y.day ? -1 : 1));
  return { ...b, done: v, log };
}

export interface BookPlan {
  remaining: number;
  /** Days left including today (null without a deadline). */
  daysLeft: number | null;
  /** Units a day needed to finish by the deadline. */
  perDay: number | null;
  /** Units a day over the last `window` days (or since the book was added). */
  pace: number | null;
  /** When it ends at that pace. */
  eta: string | null;
  onTrack: boolean | null;
}

export function bookPlan(b: Book, now = Date.now(), window = 14): BookPlan {
  const today = dayKey(now);
  const remaining = Math.max(0, b.total - b.done);
  const daysLeft = b.deadline ? daysBetween(today, b.deadline) + 1 : null;
  const perDay = daysLeft === null ? null : daysLeft > 0 ? remaining / daysLeft : remaining > 0 ? Infinity : 0;
  const from = addDaysKey(today, -window);
  const before = [...b.log].reverse().find((l) => l.day < from);
  const base = before ? before.done : b.startDone;
  const span = before ? window : daysBetween(dayKey(b.created), today) + 1;
  const pace = b.done > base ? (b.done - base) / Math.max(1, span) : null;
  const eta = remaining === 0 ? today : pace ? addDaysKey(today, Math.ceil(remaining / pace)) : null;
  const onTrack = !b.deadline ? null : remaining === 0 ? true : eta ? eta <= b.deadline : false;
  return { remaining, daysLeft, perDay, pace, eta, onTrack };
}

// ---------- 過去問の進捗表 ----------

export interface PastSubject {
  id: string;
  name: string;
  max: number;
}

export interface PastGrid {
  subjects: PastSubject[];
  years: number[];
  /** `${subject}|${year}` → result. */
  cells: Record<string, { score: number; at: number }>;
}

export function defaultPastGrid(thisYear = 2026): PastGrid {
  return {
    subjects: ['京大 数学', '京大 英語', '京大 物理', '京大 化学', '京大 国語'].map((name, i) => ({ id: `s${i}`, name, max: 100 })),
    years: Array.from({ length: 15 }, (_, i) => thisYear - i),
    cells: {},
  };
}

export const cellKey = (subject: string, year: number) => `${subject}|${year}`;

export function pastStats(g: PastGrid, subject: PastSubject): { done: number; avg: number | null; last: { year: number; pct: number } | null } {
  const rows = g.years
    .map((y) => ({ year: y, c: g.cells[cellKey(subject.id, y)] }))
    .filter((x): x is { year: number; c: { score: number; at: number } } => !!x.c);
  if (!rows.length) return { done: 0, avg: null, last: null };
  const pcts = rows.map((r) => r.c.score / subject.max);
  const last = rows.reduce((a, b) => (b.c.at > a.c.at ? b : a));
  return { done: rows.length, avg: pcts.reduce((a, b) => a + b, 0) / pcts.length, last: { year: last.year, pct: last.c.score / subject.max } };
}

/** Colour band of a score (for the grid). */
export function band(pct: number): 'good' | 'mid' | 'low' {
  return pct >= 0.7 ? 'good' : pct >= 0.5 ? 'mid' : 'low';
}

// ---------- 振り返り・質問 ----------

export interface Reflection {
  good: string;
  bad: string;
  next: string;
  at: number;
}

export interface Question {
  id: string;
  text: string;
  at: number;
  nb?: string;
  page?: string;
  /** Label of where it came from (ノート名 p.3). */
  where?: string;
  done?: number;
}

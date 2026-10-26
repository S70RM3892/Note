/** 週間レポート: the last seven days in one place, also as text to send someone. */
import type { Folder, Notebook } from '../core/types';
import { dayKey, type StudyStats } from '../store/repo';
import { subjectBreakdown, type SubjectRow } from '../study/subjects';
import type { HubState } from './data';
import { sleepSummary, type SleepSummary } from './health';
import { mistakeStats } from './mistakes';
import { mockTotal } from './plan';

export interface WeeklyReport {
  from: string;
  to: string;
  studySec: number;
  prevStudySec: number;
  days: { key: string; sec: number }[];
  subjects: SubjectRow[];
  exams: { label: string; usedMin: number; plannedMin: number }[];
  mocks: { name: string; pct: number | null }[];
  cards: number;
  mistakes: { label: string; count: number }[];
  sleep: SleepSummary;
  books: { title: string; gained: number; unit: string }[];
  reflections: number;
  questionsOpen: number;
}

function keysBack(now: number, from: number, n: number): string[] {
  const d = new Date(now);
  return Array.from({ length: n }, (_, i) => dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - from - (n - 1 - i)).getTime()));
}

export function weeklyReport(now: number, stats: StudyStats, notebooks: Notebook[], folders: Folder[], hub: HubState): WeeklyReport {
  const keys = keysBack(now, 0, 7);
  const prev = keysBack(now, 7, 7);
  const from = keys[0], to = keys[6];
  const inWeek = (t: number) => {
    const k = dayKey(t);
    return k >= from && k <= to;
  };
  const sum = (ks: string[]) => ks.reduce((s, k) => s + (stats.days[k] ?? 0), 0);
  const books = hub.books
    .map((b) => {
      const before = [...b.log].reverse().find((l) => l.day < from);
      const base = before ? before.done : dayKey(b.created) >= from ? b.startDone : b.done;
      return { title: b.title, gained: b.done - base, unit: b.unit };
    })
    .filter((b) => b.gained > 0);
  return {
    from,
    to,
    studySec: sum(keys),
    prevStudySec: sum(prev),
    days: keys.map((key) => ({ key, sec: stats.days[key] ?? 0 })),
    subjects: subjectBreakdown(stats.byNb ?? {}, notebooks, folders, 7, now),
    exams: stats.exams.filter((x) => inWeek(x.at)).map((x) => ({ label: x.label, usedMin: Math.round(x.used / 60), plannedMin: Math.round(x.planned / 60) })),
    mocks: hub.mocks.filter((m) => m.date >= from && m.date <= to).map((m) => ({ name: m.name, pct: mockTotal(m).pct })),
    cards: keys.reduce((s, k) => s + (hub.cardLog[k] ?? 0), 0),
    mistakes: mistakeStats(hub.mistakes, now, 7).byKind.map((k) => ({ label: k.label, count: k.count })),
    sleep: sleepSummary(hub.sleep, now, 7),
    books,
    reflections: keys.filter((k) => hub.reflections[k]).length,
    questionsOpen: hub.questions.filter((q) => !q.done).length,
  };
}

function hm(sec: number) {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}`;
}

export function weeklyText(r: WeeklyReport): string {
  const lines = [`週間レポート ${r.from.slice(5).replace('-', '/')}〜${r.to.slice(5).replace('-', '/')}`];
  lines.push(`学習時間 ${hm(r.studySec)}（前の週 ${hm(r.prevStudySec)}）`);
  if (r.subjects.length) lines.push('教科別 ' + r.subjects.map((s) => `${s.name} ${hm(s.sec)}`).join('・'));
  if (r.exams.length) lines.push(`過去問 ${r.exams.length}回：` + r.exams.map((x) => `${x.label} ${x.usedMin}分`).join('、'));
  if (r.mocks.length) lines.push('模試 ' + r.mocks.map((m) => `${m.name}${m.pct !== null ? ` ${Math.round(m.pct * 100)}%` : ''}`).join('、'));
  if (r.books.length) lines.push('参考書 ' + r.books.map((b) => `${b.title} +${b.gained}${b.unit}`).join('、'));
  if (r.cards) lines.push(`単語帳 ${r.cards}枚`);
  if (r.mistakes.length) lines.push('ミス ' + r.mistakes.map((m) => `${m.label}${m.count}`).join('・'));
  if (r.sleep.avg !== null) lines.push(`睡眠 平均${r.sleep.avg.toFixed(1)}時間（${r.sleep.nights}晩、8〜10時間は${r.sleep.inRange}晩）`);
  lines.push(`振り返り ${r.reflections}/7日`);
  if (r.questionsOpen) lines.push(`未解決の質問 ${r.questionsOpen}件`);
  return lines.join('\n');
}

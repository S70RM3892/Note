import type { Folder, Notebook } from '../core/types';
import { subjectBreakdown, type NotebookDays } from './subjects';

/** A UTF-8 BOM, so spreadsheet apps read the Japanese correctly. */
const BOM = '﻿';

function cell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function row(values: (string | number)[]): string {
  return values.map(cell).join(',');
}

/**
 * 学習記録: one row per day with writing time in minutes, the total and per subject (folder, or
 * notebook outside folders) for the days the per-notebook log still covers.
 */
export function studyCsv(days: Record<string, number>, byNb: NotebookDays, notebooks: Notebook[], folders: Folder[]): string {
  const keys = Object.keys(days).sort();
  const subjects = new Set<string>();
  const perDay = new Map<string, Map<string, number>>();
  for (const k of keys) {
    const d = new Date(`${k}T12:00:00`);
    const rows = subjectBreakdown(byNb, notebooks, folders, 1, d.getTime(), 1000);
    const m = new Map(rows.map((r) => [r.name, r.sec]));
    rows.forEach((r) => subjects.add(r.name));
    perDay.set(k, m);
  }
  const names = [...subjects];
  const out = [row(['日付', '合計(分)', ...names.map((n) => `${n}(分)`)])];
  for (const k of keys) {
    const m = perDay.get(k)!;
    out.push(row([k, Math.round(days[k] / 60), ...names.map((n) => (m.has(n) ? Math.round(m.get(n)! / 60) : ''))]));
  }
  return BOM + out.join('\n') + '\n';
}

export interface ExamLog {
  at: number;
  label: string;
  planned: number;
  used: number;
  laps?: number[];
}

/** 過去問ログ: date and time, paper, minutes allowed and used, minutes per 大問. */
export function examCsv(exams: ExamLog[]): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const out = [row(['日時', '科目', '予定(分)', '実際(分)', '大問ごと(分)'])];
  for (const x of [...exams].sort((a, b) => a.at - b.at)) {
    const d = new Date(x.at);
    out.push(
      row([
        `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
        x.label,
        x.planned ? Math.round(x.planned / 60) : '',
        Math.round(x.used / 60),
        (x.laps ?? []).map((l) => Math.round(l / 60)).join(' / '),
      ]),
    );
  }
  return BOM + out.join('\n') + '\n';
}

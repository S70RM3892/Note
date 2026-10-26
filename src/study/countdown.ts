export interface ExamDate {
  name: string;
  /** Local date, YYYY-MM-DD. */
  date: string;
}

/**
 * Defaults for 2027 entrance: 共通テスト本試験 2027-01-16/17 (大学入試センター),
 * 京都大学 一般選抜 前期日程 2027-02-25/26 (令和9年度 京都大学入学者選抜要項).
 */
export const DEFAULT_EXAMS: ExamDate[] = [
  { name: '共通テスト', date: '2027-01-16' },
  { name: '京大 二次', date: '2027-02-25' },
];

function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Whole calendar days from today to the exam (0 = today, negative = past); NaN for a bad date. */
export function daysUntil(date: string, now = new Date()): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return NaN;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Math.round((target - localMidnight(now)) / 86400000);
}

/** Exams still ahead (or today), soonest first. */
export function upcomingExams(list: ExamDate[], now = new Date()): (ExamDate & { days: number })[] {
  return list
    .map((e) => ({ ...e, days: daysUntil(e.date, now) }))
    .filter((e) => e.days >= 0)
    .sort((a, b) => a.days - b.days);
}

export function formatExamDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]})`;
}

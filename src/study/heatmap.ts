import { dayKey } from '../store/repo';

export interface HeatCell {
  key: string;
  sec: number;
  /** 0 = nothing … 4 = a long day. */
  level: 0 | 1 | 2 | 3 | 4;
  future: boolean;
}

/** Minutes thresholds for the colour levels. */
const LEVELS = [1, 30, 90, 180];

export function levelOf(sec: number): HeatCell['level'] {
  const m = sec / 60;
  let l = 0;
  for (const t of LEVELS) if (m >= t) l++;
  return l as HeatCell['level'];
}

/**
 * The last `weeks` weeks as columns of 7 days (Monday first), the current week last, so the
 * grid reads like a calendar. Days after today are marked `future`.
 */
export function heatmap(days: Record<string, number>, now = new Date(), weeks = 16): HeatCell[][] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = (today.getDay() + 6) % 7; // Monday = 0
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow - (weeks - 1) * 7);
  const cols: HeatCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: HeatCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
      const key = dayKey(date.getTime());
      const sec = days[key] ?? 0;
      col.push({ key, sec, level: levelOf(sec), future: date > today });
    }
    cols.push(col);
  }
  return cols;
}

/**
 * 連続日数: days in a row with at least `minSec` of study, ending today — or yesterday, so the
 * streak isn't shown as broken in the morning before studying.
 */
export function streak(days: Record<string, number>, now = new Date(), minSec = 600): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if ((days[dayKey(d.getTime())] ?? 0) < minSec) d.setDate(d.getDate() - 1);
  let n = 0;
  while ((days[dayKey(d.getTime())] ?? 0) >= minSec) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/** Total seconds over the last `n` days including today. */
export function lastNDays(days: Record<string, number>, n: number, now = new Date()): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += days[dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i).getTime())] ?? 0;
  return s;
}

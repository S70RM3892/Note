/**
 * 体調: 睡眠記録, 目の休憩.
 *  - 睡眠: 厚生労働省「健康づくりのための睡眠ガイド 2023」— 中学・高校生は8〜10時間、週末も普段と同じ時刻に起きる
 *  - 目の休憩: 厚生労働省「情報機器作業における労働衛生管理のためのガイドライン」— 一連続作業は1時間以内、
 *    次の作業までに10〜15分の休止、途中に1〜2回の小休止
 */
import { dayKey } from '../store/repo';

export const HEALTH_SOURCES = {
  sleepGuide: 'https://www.mhlw.go.jp/content/001305530.pdf',
  vdt: 'https://www.mhlw.go.jp/content/000539604.pdf',
};

/** 中学・高校生の推奨睡眠時間（時間）. */
export const TEEN_SLEEP = { min: 8, max: 10 };

// ---------- 睡眠 ----------

export interface SleepEntry {
  /** The morning it ended (YYYY-MM-DD). */
  day: string;
  bed: number;
  wake: number;
}

export function sleepHours(e: SleepEntry): number {
  return (e.wake - e.bed) / 3_600_000;
}

/** A night from "HH:MM" bed and wake times, ending on the morning of `day`. */
export function nightFrom(day: string, bed: string, wake: string): SleepEntry | null {
  const [y, m, d] = day.split('-').map(Number);
  const [bh, bm] = bed.split(':').map(Number);
  const [wh, wm] = wake.split(':').map(Number);
  if ([y, m, d, bh, bm, wh, wm].some((v) => !Number.isFinite(v))) return null;
  const w = new Date(y, m - 1, d, wh, wm).getTime();
  let b = new Date(y, m - 1, d, bh, bm).getTime();
  if (b >= w) b -= 86_400_000; // went to bed the evening before
  if (w - b > 16 * 3_600_000) return null;
  return { day, bed: b, wake: w };
}

function sd(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

function minutesOfDay(t: number) {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}

export interface SleepSummary {
  nights: number;
  avg: number | null;
  /** Nights within 8〜10 hours. */
  inRange: number;
  /** Spread of bedtimes / wake times (minutes, standard deviation). */
  bedSpread: number | null;
  wakeSpread: number | null;
  /** Average wake time on weekdays / weekends (minutes after midnight). */
  weekdayWake: number | null;
  weekendWake: number | null;
}

/** The last `n` mornings up to today. */
export function sleepSummary(entries: SleepEntry[], now = Date.now(), n = 7): SleepSummary {
  const today = dayKey(now);
  const from = dayKey(now - (n - 1) * 86_400_000);
  const recent = entries.filter((e) => e.day >= from && e.day <= today);
  const hours = recent.map(sleepHours);
  // Bedtimes measured from noon, so 23:30 and 0:30 are an hour apart, not 23.
  const beds = recent.map((e) => (minutesOfDay(e.bed) - 720 + 1440) % 1440);
  const wakes = recent.map((e) => minutesOfDay(e.wake));
  const weekend = (e: SleepEntry) => {
    const g = new Date(e.wake).getDay();
    return g === 0 || g === 6;
  };
  const avgOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    nights: recent.length,
    avg: avgOf(hours),
    inRange: hours.filter((h) => h >= TEEN_SLEEP.min && h <= TEEN_SLEEP.max).length,
    bedSpread: sd(beds),
    wakeSpread: sd(wakes),
    weekdayWake: avgOf(recent.filter((e) => !weekend(e)).map((e) => minutesOfDay(e.wake))),
    weekendWake: avgOf(recent.filter(weekend).map((e) => minutesOfDay(e.wake))),
  };
}

export function clock(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

// ---------- 目の休憩 ----------

export type BreakNudge = 'micro' | 'rest' | null;

/**
 * 連続作業の見張り: writing counts as work; a pause of `restMin` ends the stretch. Nudges a 小休止
 * halfway and a real break after `workMin`, then again every `againMin` while writing goes on.
 */
export class BreakWatch {
  start = 0;
  last = 0;
  private microDone = false;
  private nextRest = 0;

  constructor(
    private workMin = 60,
    private restMin = 10,
    private againMin = 15,
  ) {}

  activity(now: number): BreakNudge {
    if (!this.start || now - this.last >= this.restMin * 60_000) {
      this.start = now;
      this.microDone = false;
      this.nextRest = now + this.workMin * 60_000;
    }
    this.last = now;
    if (now >= this.nextRest) {
      this.nextRest = now + this.againMin * 60_000;
      return 'rest';
    }
    if (!this.microDone && now - this.start >= (this.workMin / 2) * 60_000) {
      this.microDone = true;
      return 'micro';
    }
    return null;
  }

  /** Minutes written without a break. */
  stretch(now: number): number {
    return this.start && now - this.last < this.restMin * 60_000 ? (now - this.start) / 60_000 : 0;
  }
}

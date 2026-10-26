import type { ReviewState } from './types';

/** Spaced-repetition scheduling for pages (SM-2 style, day granularity). */

export type Grade = 1 | 2 | 3 | 4; // again, hard, good, easy

export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(t: number, n: number): number {
  const d = new Date(startOfDay(t));
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function newReview(now: number): ReviewState {
  return { due: addDays(now, 1), interval: 0, ease: 2.5, reps: 0, lapses: 0 };
}

export function nextInterval(r: ReviewState, g: Grade): number {
  switch (g) {
    case 1:
      return 1;
    case 2:
      return r.reps === 0 ? 1 : Math.max(r.interval + 1, Math.round(r.interval * 1.2));
    case 3:
      return r.reps === 0 ? 1 : r.reps === 1 ? 3 : Math.max(r.interval + 1, Math.round(r.interval * r.ease));
    case 4:
      return r.reps === 0 ? 3 : r.reps === 1 ? 6 : Math.max(r.interval + 2, Math.round(r.interval * r.ease * 1.3));
  }
}

export function grade(r: ReviewState, g: Grade, now: number): ReviewState {
  const interval = nextInterval(r, g);
  let ease = r.ease;
  if (g === 1) ease -= 0.2;
  else if (g === 2) ease -= 0.15;
  else if (g === 4) ease += 0.15;
  ease = Math.min(3.2, Math.max(1.3, ease));
  return {
    due: addDays(now, interval),
    interval,
    ease,
    reps: g === 1 ? 0 : r.reps + 1,
    lapses: r.lapses + (g === 1 ? 1 : 0),
    last: now,
  };
}

export function isDue(r: ReviewState | undefined, now: number): boolean {
  return !!r && r.due <= now;
}

export function formatInterval(days: number): string {
  if (days < 1) return '今日';
  if (days < 30) return `${days}日`;
  if (days < 365) return `${Math.round(days / 30)}か月`;
  return `${(days / 365).toFixed(1)}年`;
}

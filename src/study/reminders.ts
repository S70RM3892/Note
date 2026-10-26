import { upcomingExams, type ExamDate } from './countdown';

/** One daily notification, as the APK's Reminders.parse reads it. */
export interface ReminderSpec {
  id: number;
  h: number;
  m: number;
  title: string;
  text: string;
  repeatText: string;
}

export interface ReminderSettings {
  notifyBedtime: boolean;
  notifyReview: boolean;
  reviewTime: string;
  bedtime: string;
  exams: ExamDate[];
}

export const BEDTIME_SOON = 1;
export const BEDTIME = 2;
export const REVIEW = 3;
/** How long before bedtime the wind-down notice comes. */
export const WIND_DOWN_MIN = 30;

function hm(s: string): [number, number] {
  const [h, m] = s.split(':').map((v) => parseInt(v, 10));
  return [Math.min(23, Math.max(0, h || 0)), Math.min(59, Math.max(0, m || 0))];
}

/**
 * The reminders to schedule now. `dueBy(t)` = review pages due by time t; the review reminder's
 * count is for the day it fires next (today if its time is still ahead).
 */
export function buildReminders(s: ReminderSettings, dueBy: (t: number) => number, now = Date.now()): ReminderSpec[] {
  const out: ReminderSpec[] = [];
  if (s.notifyBedtime) {
    const [bh, bm] = hm(s.bedtime);
    const soon = (bh * 60 + bm - WIND_DOWN_MIN + 1440) % 1440;
    const text = `あと${WIND_DOWN_MIN}分で ${s.bedtime}。今の問題で区切りをつけて、明日やることを「今日やること」に書いておけ。`;
    out.push({ id: BEDTIME_SOON, h: Math.floor(soon / 60), m: soon % 60, title: '就寝30分前', text, repeatText: text });
    const bed = `${s.bedtime}。ノートは自動保存済み。画面を閉じて寝ろ。覚えたことは寝ている間に定着する。`;
    out.push({ id: BEDTIME, h: bh, m: bm, title: '寝る時間', text: bed, repeatText: bed });
  }
  if (s.notifyReview) {
    const [rh, rm] = hm(s.reviewTime);
    const d = new Date(now);
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), rh, rm);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    const dayEnd = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1).getTime() - 1;
    const n = dueBy(dayEnd);
    const exam = upcomingExams(s.exams, at)[0];
    const tail = exam ? `（${exam.name}まで${exam.days}日）` : '';
    out.push({
      id: REVIEW,
      h: rh,
      m: rm,
      title: '今日の復習',
      text: n > 0 ? `今日の復習が ${n} ページある。忘れる前にやれ${tail}` : `今日の復習は0ページ。間違えた問題は「まちがいノート」へ${tail}`,
      repeatText: `今日の復習をやろう。ライブラリの「今日の復習」から${tail}`,
    });
  }
  return out;
}

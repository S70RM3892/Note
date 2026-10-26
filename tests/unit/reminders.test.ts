import { describe, expect, it } from 'vitest';
import { BEDTIME, BEDTIME_SOON, REVIEW, buildReminders, type ReminderSettings } from '../../src/study/reminders';

const base: ReminderSettings = { notifyBedtime: false, notifyReview: false, reviewTime: '19:00', bedtime: '23:00', exams: [{ name: '京大 二次', date: '2027-02-25' }] };
const t = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

describe('就寝・復習のお知らせ', () => {
  it('nothing unless turned on', () => {
    expect(buildReminders(base, () => 3, t(26, 12))).toEqual([]);
  });
  it('bedtime: a wind-down notice 30 minutes before, and bedtime itself (across midnight too)', () => {
    const r = buildReminders({ ...base, notifyBedtime: true }, () => 0, t(26, 12));
    expect(r.map((x) => [x.id, x.h, x.m])).toEqual([
      [BEDTIME_SOON, 22, 30],
      [BEDTIME, 23, 0],
    ]);
    const late = buildReminders({ ...base, notifyBedtime: true, bedtime: '00:15' }, () => 0, t(26, 12));
    expect(late.map((x) => [x.h, x.m])).toEqual([
      [23, 45],
      [0, 15],
    ]);
  });
  it('review: counts pages due on the day it fires next, with the exam countdown', () => {
    const asked: number[] = [];
    const dueBy = (ts: number) => (asked.push(ts), ts >= t(27, 0) ? 7 : 4);
    const today = buildReminders({ ...base, notifyReview: true }, dueBy, t(26, 12));
    expect(today[0]).toMatchObject({ id: REVIEW, h: 19, m: 0 });
    expect(today[0].text).toContain('4 ページ');
    expect(today[0].text).toContain('京大 二次まで122日');
    expect(asked[0]).toBe(t(27, 0) - 1); // end of today
    // After 19:00 it is tomorrow's count.
    const tomorrow = buildReminders({ ...base, notifyReview: true }, dueBy, t(26, 20));
    expect(tomorrow[0].text).toContain('7 ページ');
    expect(tomorrow[0].text).toContain('京大 二次まで121日');
    expect(buildReminders({ ...base, notifyReview: true }, () => 0, t(26, 12))[0].text).toContain('0ページ');
  });
});

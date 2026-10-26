import { describe, expect, it } from 'vitest';
import { cardsCsv, deckCounts, gradeCard, looksEnglish, parseCards, studyQueue, type Card } from '../../src/hub/cards';
import { emptyHub, mergeHub, normalizeHub } from '../../src/hub/data';
import { convertKyotsu, KYOTSU_FULL, nijiNeeded, nijiTotal, PAST_RESULTS, SCHEDULE_R9, TOTAL_FULL } from '../../src/hub/exam';
import { BreakWatch, caffeineAt, caffeineToday, nightFrom, sleepSummary } from '../../src/hub/health';
import { mistakeStats } from '../../src/hub/mistakes';
import { bookPlan, mockKyodai, mockPreset, mockSeries, mockTotal, pastStats, setBookDone, weakestSubject, type Book, type MockExam } from '../../src/hub/plan';
import { bitOp, charCodes, fromTwos, parseBase, toBase, twosComplement } from '../../src/hub/radix';
import { weeklyReport, weeklyText } from '../../src/hub/weekly';

const at = (s: string) => new Date(s).getTime();

describe('合格点シミュレーター (京大工学部, 令和9年度要項)', () => {
  it('scales each 共通テスト group to its 配点: 225 in all, 1025 with 二次', () => {
    expect(KYOTSU_FULL).toBe(225);
    expect(TOTAL_FULL).toBe(1025);
    const full = convertKyotsu({ kokugo: 200, chireki: 100, mathIA: 100, mathIIBC: 100, sci1: 100, sci2: 100, engR: 100, engL: 100, info: 100 });
    expect(full.total).toBeCloseTo(225);
    expect(full.complete).toBe(true);
    // 国語160/200→20, 地歴80→40, 数学180/200→22.5, 理科170/200→21.25, 英語(90+80)/200→42.5, 情報90→45
    const c = convertKyotsu({ kokugo: 160, chireki: 80, mathIA: 95, mathIIBC: 85, sci1: 90, sci2: 80, engR: 90, engL: 80, info: 90 });
    expect(c.groups.map((g) => g.converted)).toEqual([20, 40, 22.5, 21.25, 42.5, 45]);
    expect(c.total).toBeCloseTo(191.25);
    expect(convertKyotsu({ kokugo: 160 }).complete).toBe(false);
    expect(nijiTotal({ kokugo: 60, math: 150, sci: 160, eng: 130, ...{ extra: 1 } })).toBe(500);
    // 令和7年度の最低点 707.52 に 191.25 を足すと二次で 516.27 / 800
    const need = nijiNeeded(191.25, PAST_RESULTS[1].min)!;
    expect(need.points).toBeCloseTo(516.27);
    expect(nijiNeeded(0, 1025)).toBeNull();
  });

  it('the 令和9年度 schedule is in date order with the 京大 exam days', () => {
    const dates = SCHEDULE_R9.map((e) => e.date);
    expect([...dates].sort()).toEqual(dates);
    expect(SCHEDULE_R9.find((e) => e.date === '2027-02-25')!.slots!.map((s) => s.minutes)).toEqual([90, 150]);
    expect(SCHEDULE_R9.find((e) => e.date === '2027-02-26')!.slots!.map((s) => s.minutes)).toEqual([120, 180]);
  });
});

describe('模試・参考書・過去問', () => {
  it('a 共通テスト型 mock gives its total, its weakest subject and the 京大換算', () => {
    const m: MockExam = { id: 'a', name: '第2回', date: '2026-10-04', kind: 'kyotsu', subjects: mockPreset('kyotsu') };
    expect(mockTotal(m).pct).toBeNull();
    const scores = [160, 80, 95, 85, 90, 80, 90, 80, 90];
    m.subjects.forEach((s, i) => (s.score = scores[i]));
    expect(mockTotal(m)).toMatchObject({ score: 850, max: 1000 });
    expect(weakestSubject(m)!.name).toBe('国語');
    expect(mockKyodai(m)).toBeCloseTo(191.25);
    const older: MockExam = { ...m, id: 'b', date: '2026-06-01', subjects: [{ name: '合計', score: 600, max: 1000 }] };
    expect(mockSeries([m, older], 'kyotsu').map((x) => x.pct)).toEqual([0.6, 0.85]);
  });

  it('a book: units a day needed for the deadline, the recent pace and when it ends at that pace', () => {
    let b: Book = { id: 'b', title: '青チャート', unit: '問', total: 300, done: 0, startDone: 0, deadline: '2026-11-30', created: at('2026-10-01T09:00'), log: [] };
    b = setBookDone(b, 60, at('2026-10-10T20:00'));
    b = setBookDone(b, 100, at('2026-10-20T20:00'));
    b = setBookDone(b, 110, at('2026-10-20T22:00')); // same day: replaces
    expect(b.log).toEqual([
      { day: '2026-10-10', done: 60 },
      { day: '2026-10-20', done: 110 },
    ]);
    const p = bookPlan(b, at('2026-10-26T12:00'));
    expect(p.remaining).toBe(190);
    expect(p.daysLeft).toBe(36);
    expect(p.perDay).toBeCloseTo(190 / 36);
    // last 14 days: since 10/12 the last entry before is 60 (10/10) → +50 in 14 days
    expect(p.pace).toBeCloseTo(50 / 14);
    expect(p.eta).toBe('2026-12-19'); // 190 ÷ (50/14) = 53.2 → 54 days
    expect(p.onTrack).toBe(false);
    expect(bookPlan({ ...b, done: 300 }, at('2026-10-26T12:00')).onTrack).toBe(true);
  });

  it('past papers: count, average and the latest one per subject', () => {
    const g = { subjects: [{ id: 'm', name: '京大 数学', max: 150 }], years: [2026, 2025, 2024], cells: { 'm|2025': { score: 90, at: 2 }, 'm|2024': { score: 120, at: 1 } } };
    expect(pastStats(g, g.subjects[0])).toEqual({ done: 2, avg: 0.7, last: { year: 2025, pct: 0.6 } });
  });
});

describe('睡眠・カフェイン・目の休憩', () => {
  it('a night across midnight, and the week compared with 8〜10 hours', () => {
    const n = nightFrom('2026-10-26', '23:30', '06:30')!;
    expect((n.wake - n.bed) / 3_600_000).toBe(7);
    expect(nightFrom('2026-10-26', '01:00', '07:00')!.bed).toBe(at('2026-10-26T01:00'));
    const nights = [
      nightFrom('2026-10-22', '23:00', '07:00')!, // Thu 8h
      nightFrom('2026-10-23', '00:00', '07:00')!, // Fri 7h
      nightFrom('2026-10-24', '23:30', '09:30')!, // Sat 10h, late
      nightFrom('2026-10-25', '23:00', '09:00')!, // Sun 10h
      nightFrom('2026-10-26', '23:00', '07:00')!, // Mon 8h
    ];
    const s = sleepSummary(nights, at('2026-10-26T12:00'));
    expect(s.nights).toBe(5);
    expect(s.avg).toBeCloseTo(8.6);
    expect(s.inRange).toBe(4);
    expect(s.weekdayWake).toBe(7 * 60);
    expect(s.weekendWake).toBe(9 * 60 + 15);
    // bedtimes 23:00, 0:00, 23:30, 23:00, 23:00 measured from noon: spread well under an hour
    expect(s.bedSpread!).toBeGreaterThan(20);
    expect(s.bedSpread!).toBeLessThan(30);
  });

  it('caffeine halves every 5 hours: 100mg at 19:00 is 50mg at midnight (睡眠ガイド2023の例)', () => {
    const e = [{ at: at('2026-10-26T19:00'), mg: 100, label: 'コーヒー' }];
    expect(caffeineAt(e, at('2026-10-27T00:00'))).toBeCloseTo(50);
    expect(caffeineAt(e, at('2026-10-26T18:00'))).toBe(0);
    const day = [...e, { at: at('2026-10-26T09:00'), mg: 400, label: 'x' }];
    expect(caffeineAt(day, at('2026-10-26T14:00'))).toBeCloseTo(200);
    expect(caffeineToday(day, at('2026-10-26T20:00'))).toEqual({ total: 500, evening: 100 });
  });

  it('nudges a short pause halfway through an hour of writing, a real break at the hour, and starts over after 10 minutes off', () => {
    const w = new BreakWatch();
    const t0 = at('2026-10-26T09:00');
    const min = 60_000;
    const seen: string[] = [];
    for (let m = 0; m <= 76; m++) {
      const r = w.activity(t0 + m * min);
      if (r) seen.push(`${m}:${r}`);
    }
    expect(seen).toEqual(['30:micro', '60:rest', '75:rest']);
    expect(w.activity(t0 + 90 * min)).toBeNull(); // 14 minutes off: a new stretch
    expect(w.stretch(t0 + 91 * min)).toBe(1);
  });
});

describe('単語帳', () => {
  it('reads tab, CSV and 「：」 lines, and writes CSV back', () => {
    expect(parseCards('apple\tりんご\n"run, ran",走る\n漸化式：recurrence\n\njust text')).toEqual([
      { front: 'apple', back: 'りんご' },
      { front: 'run, ran', back: '走る' },
      { front: '漸化式', back: 'recurrence' },
    ]);
    expect(cardsCsv([{ id: '1', deck: 'd', front: 'run, ran', back: '走る', added: 0 }])).toBe('﻿"run, ran",走る\n');
  });

  it('due cards first, then at most 20 new cards a day', () => {
    const now = at('2026-10-26T10:00');
    const cards: Card[] = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, deck: 'd', front: `w${i}`, back: 'x', added: i }));
    cards.push({ id: 'due', deck: 'd', front: 'old', back: 'x', added: -1, state: { due: now - 1, interval: 3, ease: 2.5, reps: 2, lapses: 0 } });
    const q = studyQueue(cards, 'd', now);
    expect(q[0].id).toBe('due');
    expect(q).toHaveLength(21);
    const studied = gradeCard(cards[0], 3, now);
    expect(studied.firstDay).toBe('2026-10-26');
    expect(studied.state!.due).toBeGreaterThan(now);
    const after = cards.map((c) => (c.id === 'n0' ? studied : c));
    expect(studyQueue(after, 'd', now)).toHaveLength(20); // 19 new left today + the due card
    expect(deckCounts(after, 'd', now)).toMatchObject({ total: 31, due: 1, fresh: 29 });
    expect(looksEnglish('take off')).toBe(true);
    expect(looksEnglish('離陸する')).toBe(false);
  });
});

describe('ミス分析', () => {
  it('counts the kinds of mistakes and the commonest one per subject', () => {
    const now = at('2026-10-26T10:00');
    const m = (kind: 'calc' | 'read' | 'plan', subject: string, daysAgo = 1) => ({ id: Math.random().toString(), at: now - daysAgo * 86_400_000, kind, subject });
    const s = mistakeStats([m('calc', '数学'), m('calc', '数学'), m('plan', '数学'), m('read', '物理'), m('calc', '数学', 40)], now);
    expect(s.total).toBe(4);
    expect(s.byKind.map((k) => [k.label, k.count])).toEqual([
      ['計算ミス', 2],
      ['問題の読み違い', 1],
      ['方針が立たなかった', 1],
    ]);
    expect(s.bySubject[0]).toEqual({ subject: '数学', count: 3, top: '計算ミス' });
  });
});

describe('情報Ⅰ 基数変換', () => {
  it('converts between bases, two’s complement both ways, bit operations and UTF-8', () => {
    expect(parseBase('1010 1100', 2)).toBe(172);
    expect(parseBase('ff', 16)).toBe(255);
    expect(parseBase('19', 8)).toBeNull();
    expect(toBase(172, 2)).toBe('1010 1100');
    expect(toBase(5, 2)).toBe('0101');
    expect(toBase(255, 16)).toBe('FF');
    expect(twosComplement(-5, 8)).toBe('11111011');
    expect(twosComplement(128, 8)).toBeNull();
    expect(fromTwos('1111 1011')).toBe(-5);
    expect(bitOp(0b1100, 0b1010, 'XOR', 4)).toBe('0110');
    expect(bitOp(0b1100, 0b1010, 'AND', 4)).toBe('1000');
    expect(charCodes('あA')).toEqual([
      { char: 'あ', codePoint: 'U+3042', utf8: ['E3', '81', '82'] },
      { char: 'A', codePoint: 'U+0041', utf8: ['41'] },
    ]);
  });
});

describe('ハブのデータ', () => {
  it('a restore adds what is missing and keeps what this device has', () => {
    const local = emptyHub();
    local.mocks = [{ id: 'm1', name: '手元', date: '2026-10-01', kind: 'other', subjects: [] }];
    local.reflections = { '2026-10-25': { good: '手元', bad: '', next: '', at: 1 } };
    const backup = emptyHub();
    backup.mocks = [
      { id: 'm1', name: 'バックアップ', date: '2026-10-01', kind: 'other', subjects: [] },
      { id: 'm2', name: '別の模試', date: '2026-09-01', kind: 'other', subjects: [] },
    ];
    backup.reflections = { '2026-10-25': { good: '古い', bad: '', next: '', at: 0 }, '2026-10-24': { good: '前日', bad: '', next: '', at: 0 } };
    const merged = mergeHub(local, backup);
    expect(merged.mocks.map((m) => m.name)).toEqual(['手元', '別の模試']);
    expect(merged.reflections['2026-10-25'].good).toBe('手元');
    expect(merged.reflections['2026-10-24'].good).toBe('前日');
    expect(normalizeHub({ prefs: { dnd: true } }).prefs).toMatchObject({ dnd: true, eyeBreaks: true });
  });

  it('the weekly report sums the last seven days and reads as text', () => {
    const now = at('2026-10-26T21:00');
    const hub = emptyHub();
    hub.cardLog = { '2026-10-26': 30, '2026-10-20': 20, '2026-10-19': 99 };
    hub.reflections = { '2026-10-26': { good: 'a', bad: '', next: '', at: 0 } };
    hub.sleep = [nightFrom('2026-10-26', '23:00', '07:00')!];
    const r = weeklyReport(now, { days: { '2026-10-26': 3600, '2026-10-20': 1800, '2026-10-19': 7200 }, exams: [{ at: now - 3600_000, label: '京大 数学', planned: 9000, used: 8400 }] }, [], [], hub);
    expect(r.from).toBe('2026-10-20');
    expect(r.studySec).toBe(5400);
    expect(r.prevStudySec).toBe(7200);
    expect(r.cards).toBe(50);
    const text = weeklyText(r);
    expect(text).toContain('学習時間 1時間30分（前の週 2時間）');
    expect(text).toContain('過去問 1回：京大 数学 140分');
    expect(text).toContain('睡眠 平均8.0時間');
    expect(text).toContain('振り返り 1/7日');
  });
});

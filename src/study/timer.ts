import { h } from '../ui/dom';
import { toast } from '../ui/dialogs';
import { icon } from '../ui/icons';

/**
 * 過去問タイマー. Presets follow the 京都大学 工学部 個別学力検査 timetable
 * (令和7年度 一般選抜 学生募集要項: 国語 90分, 数学 150分, 外国語 120分, 理科 180分).
 * Check the latest 募集要項 each year.
 */
export const KYODAI_PRESETS = [
  { label: '京大 国語', min: 90 },
  { label: '京大 数学', min: 150 },
  { label: '京大 英語', min: 120 },
  { label: '京大 理科', min: 180 },
  { label: '大問1つ', min: 30 },
  { label: 'ポモドーロ', min: 25 },
];

interface TimerState {
  label: string;
  duration: number; // ms; 0 = stopwatch
  startedAt: number | null;
  elapsed: number; // ms accumulated before startedAt
  visible: boolean;
  min: boolean;
  x?: number;
  y?: number;
  warned?: boolean;
  ended?: boolean;
  /** 大問の区切り: elapsed ms at each split. */
  laps?: number[];
  /** 時間配分: the number of 大問 (the budget per 大問 is shown and over-runs are flagged). */
  questions?: number;
  /** 大問 (0-based) already flagged as over budget. */
  overWarned?: number[];
  /** ポモドーロ: the phase and round of the cycle. */
  pomo?: { phase: 'focus' | 'break'; round: number };
  /** ポモドーロ rounds finished today. */
  pomoDone?: { day: string; n: number };
}

export const POMO_FOCUS = 25;
export const POMO_BREAK = 5;
export const POMO_LONG_BREAK = 15;

/**
 * 時間配分: the time per 大問 when `questions` share `durationMs`, keeping 10 minutes back for
 * checking on papers of an hour or more (as the 残り10分 warning suggests).
 */
export function questionBudget(durationMs: number, questions: number): number {
  const reserve = durationMs >= 60 * 60_000 ? 10 * 60_000 : 0;
  return Math.max(60_000, (durationMs - reserve) / Math.max(1, questions));
}

/** One line for the page: date, paper, time used of time allowed, and the time per 大問. */
export function resultText(label: string, durationMs: number, usedMs: number, splitsMs: number[], now = new Date()): string {
  const d = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}(${'日月火水木金土'[now.getDay()]})`;
  const min = (ms: number) => Math.round(ms / 60_000);
  const used = durationMs ? `${min(usedMs)}分 / ${min(durationMs)}分` : `${min(usedMs)}分`;
  const laps = splitsMs.length ? `  大問 ${splitsMs.map(min).join(' / ')}分` : '';
  return `${d} ${label}  ${used}${laps}`;
}

const KEY = 'sumi.timer';

function load(): TimerState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s) return s;
  } catch {
    /* ignore */
  }
  return { label: '京大 数学', duration: 150 * 60_000, startedAt: null, elapsed: 0, visible: false, min: false };
}

function fmt(ms: number): string {
  const neg = ms < 0;
  const t = Math.floor(Math.abs(ms) / 1000);
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  const body = hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return (neg ? '+' : '') + body;
}

function beep() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ac = new AC();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ac.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.3, ac.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.28);
      o.connect(g).connect(ac.destination);
      o.start(ac.currentTime + t);
      o.stop(ac.currentTime + t + 0.3);
    });
    setTimeout(() => void ac.close(), 1500);
  } catch {
    /* audio unavailable */
  }
}

export interface TimerHost {
  stats: { addExam(label: string, plannedSec: number, usedSec: number, lapsSec?: number[]): void };
  /** Write a line at the top of the page being worked on; false when no notebook is open. */
  stampResult?(text: string): boolean;
  /** The clock started (true) or stopped / ran out (false): 集中モード hooks in here. */
  onTimerRunning?(running: boolean): void;
}

export class TimerWidget {
  private s: TimerState = load();
  private el: HTMLElement | null = null;
  private tick = 0;
  private timeEl!: HTMLElement;
  private lapEl: HTMLElement | null = null;
  private paceEl: HTMLElement | null = null;
  private lapBtn: HTMLElement | null = null;
  /** Toolbar slot: the minimised timer lives there so it never covers the ink canvas. */
  private dock: HTMLElement | null = null;

  constructor(private host: TimerHost) {
    if (this.s.visible) this.mount();
  }

  /** Tell the host whether the exam clock is counting (not after it ran out). */
  private notify() {
    this.host.onTimerRunning?.(!!this.s.startedAt && !this.s.ended);
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.s));
    } catch {
      /* ignore */
    }
  }

  private elapsed(): number {
    return this.s.elapsed + (this.s.startedAt ? Date.now() - this.s.startedAt : 0);
  }

  get running() {
    return !!this.s.startedAt;
  }

  setDock(el: HTMLElement | null) {
    this.dock = el;
    if (this.s.visible) this.mount();
  }

  show() {
    this.s.visible = true;
    this.s.min = false;
    this.save();
    this.mount();
  }

  hide() {
    this.s.visible = false;
    this.save();
    this.unmount();
  }

  private unmount() {
    clearInterval(this.tick);
    this.el?.remove();
    this.el = null;
    this.dock?.replaceChildren();
  }

  private set(label: string, minutes: number) {
    this.logIfUsed();
    const pomo = label === 'ポモドーロ' ? { phase: 'focus' as const, round: 1 } : undefined;
    this.s = { ...this.s, label, duration: minutes * 60_000, startedAt: null, elapsed: 0, warned: false, ended: false, laps: [], overWarned: [], pomo, questions: pomo ? undefined : this.s.questions };
    this.save();
    this.mount();
    this.notify();
  }

  private logIfUsed() {
    if (this.s.pomo) return; // focus sessions aren't past papers
    const used = this.elapsed();
    if (used > 60_000) this.host.stats.addExam(this.s.label, this.s.duration / 1000, used / 1000, this.splits(used).filter((ms) => ms > 0).map((ms) => ms / 1000));
  }

  /** Time spent on each 大問: between splits, plus the one in progress (if any split was made). */
  private splits(now = this.elapsed()): number[] {
    const laps = this.s.laps ?? [];
    if (!laps.length) return [];
    return [...laps, now].map((t, i) => Math.max(0, t - (i ? laps[i - 1] : 0)));
  }

  private lap() {
    const e = this.elapsed();
    if (e <= 0) return;
    this.s.laps = [...(this.s.laps ?? []), e];
    this.save();
    toast(`大問${this.s.laps.length} ${fmt(this.splits(e)[this.s.laps.length - 1])}`, 1500);
    this.mount();
  }

  private toggle() {
    if (this.s.startedAt) {
      this.s.elapsed = this.elapsed();
      this.s.startedAt = null;
    } else {
      this.s.startedAt = Date.now();
      // Get out of the way of the writing area once it runs.
      if (this.dock) this.s.min = true;
    }
    this.save();
    this.mount();
    this.notify();
  }

  private reset() {
    this.logIfUsed();
    this.s.startedAt = null;
    this.s.elapsed = 0;
    this.s.warned = this.s.ended = false;
    this.s.laps = [];
    this.s.overWarned = [];
    if (this.s.pomo) {
      this.s.pomo = { phase: 'focus', round: 1 };
      this.s.duration = POMO_FOCUS * 60_000;
    }
    this.save();
    this.mount();
    this.notify();
  }

  /** ポモドーロ: one phase ran out; the next one starts by itself. */
  private nextPomoPhase() {
    const p = this.s.pomo!;
    beep();
    navigator.vibrate?.([300, 120, 300]);
    if (p.phase === 'focus') {
      const today = new Date().toDateString();
      const done = this.s.pomoDone?.day === today ? this.s.pomoDone.n + 1 : 1;
      this.s.pomoDone = { day: today, n: done };
      const long = p.round % 4 === 0;
      this.s.pomo = { phase: 'break', round: p.round };
      this.s.duration = (long ? POMO_LONG_BREAK : POMO_BREAK) * 60_000;
      toast(`集中 第${p.round}回 おわり（今日${done}回目）。${long ? 15 : 5}分休憩。画面から目を離せ。`, 4000);
    } else {
      this.s.pomo = { phase: 'focus', round: p.round + 1 };
      this.s.duration = POMO_FOCUS * 60_000;
      toast(`休憩おわり。集中 第${p.round + 1}回 ${POMO_FOCUS}分。`, 3000);
    }
    this.s.startedAt = Date.now();
    this.s.elapsed = 0;
    this.s.warned = this.s.ended = false;
    this.save();
    this.mount();
  }

  /** 時間配分: the 大問 in progress, the time spent on it and its budget (null when off). */
  private pace(e = this.elapsed()): { index: number; spent: number; budget: number } | null {
    const q = this.s.questions;
    if (!q || !this.s.duration || this.s.pomo) return null;
    const laps = this.s.laps ?? [];
    if (laps.length >= q) return null;
    return { index: laps.length, spent: e - (laps.at(-1) ?? 0), budget: questionBudget(this.s.duration, q) };
  }

  /** Write the result (date, time used, time per 大問) on the page being worked on. */
  private stamp() {
    const e = this.elapsed();
    const text = resultText(this.s.label, this.s.duration, e, this.splits(e).filter((ms) => ms > 0));
    if (this.host.stampResult?.(text)) toast('ページの上に結果を書いた', 2000);
    else toast('ノートを開いてから押して', 2000);
  }

  private update() {
    if (!this.el) return;
    const e = this.elapsed();
    const d = this.s.duration;
    const remain = d ? d - e : e;
    this.timeEl.textContent = fmt(d ? remain : e);
    if (this.lapEl) this.lapEl.textContent = fmt(this.splits(e).at(-1) ?? 0);
    const pace = this.pace(e);
    if (this.paceEl) {
      this.paceEl.hidden = !pace;
      if (pace) {
        const over = pace.spent > pace.budget;
        this.paceEl.textContent = `大問${pace.index + 1} 目安 ${fmt(pace.budget)}・${over ? `超過 ${fmt(pace.spent - pace.budget)}` : `あと ${fmt(pace.budget - pace.spent)}`}`;
        this.paceEl.classList.toggle('over', over);
      }
    }
    this.lapBtn?.classList.toggle('over', !!pace && pace.spent > pace.budget);
    if (pace && this.s.startedAt && pace.spent > pace.budget && !(this.s.overWarned ?? []).includes(pace.index)) {
      this.s.overWarned = [...(this.s.overWarned ?? []), pace.index];
      this.save();
      navigator.vibrate?.(150);
      toast(`大問${pace.index + 1}が目安の${Math.round(pace.budget / 60_000)}分を超えた。次へ進むか決めろ。`, 3000);
    }
    this.el.classList.toggle('warn', !!d && remain > 0 && remain <= 10 * 60_000);
    this.el.classList.toggle('over', !!d && remain <= 0);
    if (d && this.s.startedAt) {
      if (this.s.pomo && remain <= 0) {
        this.nextPomoPhase();
        return;
      }
      if (!this.s.pomo && !this.s.warned && remain <= 10 * 60_000 && remain > 0 && d > 15 * 60_000) {
        this.s.warned = true;
        this.save();
        navigator.vibrate?.(200);
        toast('残り10分。見直しの時間を確保しろ。', 3000);
      }
      if (!this.s.ended && remain <= 0) {
        this.s.ended = true;
        this.save();
        navigator.vibrate?.([400, 150, 400, 150, 400]);
        beep();
        toast(`${this.s.label} 終了。ペンを置け。`, 4000);
        this.notify();
      }
    }
  }

  private mount() {
    this.unmount();
    this.lapEl = null;
    this.paceEl = null;
    this.lapBtn = null;
    if (!this.s.visible) return;
    const s = this.s;
    if (s.min && this.dock) {
      this.timeEl = h('span', { 'data-testid': 'timer-time' });
      this.el = h(
        'button',
        {
          class: 'tb-pill timer-dock',
          title: 'タイマーを開く',
          onclick: () => {
            this.s.min = false;
            this.save();
            this.mount();
          },
        },
        icon(s.startedAt ? 'timer' : 'pause', 15),
        this.timeEl,
      );
      this.dock.appendChild(this.el);
      if (s.startedAt && !s.pomo) {
        this.lapBtn = h('button', { class: 'tb-pill timer-lap', title: '大問の区切り（ここまでの時間を記録）', 'data-testid': 'timer-lap', onclick: () => this.lap() }, `大問${(s.laps?.length ?? 0) + 1}✓`);
        this.dock.appendChild(this.lapBtn);
      }
      this.update();
      this.tick = window.setInterval(() => this.update(), 250);
      return;
    }
    this.timeEl = h('div', { class: 'timer-time', 'data-testid': 'timer-time' });
    const head = h(
      'div',
      { class: 'timer-head' },
      icon('timer', 16),
      h('span', { style: 'flex:1', 'data-testid': 'timer-label' }, s.pomo ? `ポモドーロ ${s.pomo.phase === 'focus' ? `集中 第${s.pomo.round}回` : '休憩'}${s.pomoDone?.day === new Date().toDateString() ? `・今日${s.pomoDone.n}回` : ''}` : s.duration ? s.label : 'ストップウォッチ'),
      h(
        'button',
        {
          class: 'icon-btn',
          style: 'width:32px;height:32px',
          'aria-label': '最小化',
          onclick: () => {
            this.s.min = !this.s.min;
            this.save();
            this.mount();
          },
        },
        icon(s.min ? 'right' : 'left', 16),
      ),
      h('button', { class: 'icon-btn', style: 'width:32px;height:32px', 'aria-label': '閉じる', onclick: () => this.hide() }, icon('close', 16)),
    );
    const custom = h('input', { class: 'input', type: 'number', min: 1, max: 600, placeholder: '分', style: 'height:30px;width:64px;padding:0 8px' });
    const body = s.min
      ? null
      : h(
          'div',
          null,
          h(
            'div',
            { class: 'timer-presets' },
            KYODAI_PRESETS.map((p) => h('button', { class: 'chip' + (s.label === p.label && s.duration === p.min * 60000 ? ' on' : ''), onclick: () => this.set(p.label, p.min) }, `${p.label} ${p.min}′`)),
            h('button', { class: 'chip' + (!s.duration ? ' on' : ''), onclick: () => this.set('ストップウォッチ', 0) }, '計測'),
            custom,
            h(
              'button',
              {
                class: 'chip',
                onclick: () => {
                  const m = Number(custom.value);
                  if (m > 0) this.set(`${m}分`, m);
                },
              },
              'セット',
            ),
          ),
          s.duration && !s.pomo
            ? h(
                'div',
                { class: 'timer-questions' },
                h('span', { class: 'muted' }, '大問の数'),
                [0, 3, 4, 5, 6].map((n) =>
                  h(
                    'button',
                    {
                      class: 'chip' + ((s.questions ?? 0) === n ? ' on' : ''),
                      'data-testid': `timer-q${n}`,
                      onclick: () => {
                        this.s.questions = n || undefined;
                        this.s.overWarned = [];
                        this.save();
                        this.mount();
                      },
                    },
                    n ? `${n}` : 'なし',
                  ),
                ),
              )
            : null,
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn primary', style: 'flex:1', onclick: () => this.toggle(), 'data-testid': 'timer-toggle' }, icon(s.startedAt ? 'pause' : 'play', 18), s.startedAt ? '一時停止' : this.elapsed() ? '再開' : '開始'),
            h('button', { class: 'btn', onclick: () => this.reset(), 'aria-label': 'リセット' }, icon('reset', 18)),
          ),
          s.startedAt || this.elapsed() > 0
            ? h(
                'div',
                { class: 'timer-laps' },
                s.pomo ? null : h('button', { class: 'btn small', 'data-testid': 'timer-lap', onclick: () => this.lap() }, `大問${(s.laps?.length ?? 0) + 1} 終わり`),
                s.pomo ? null : h('button', { class: 'btn small', 'data-testid': 'timer-stamp', onclick: () => this.stamp() }, '結果をページに記入'),
                this.splits().map((d, i, all) => {
                  const b = h('b', null, fmt(d));
                  if (i === all.length - 1) this.lapEl = b; // the 大問 in progress ticks with the clock
                  return h('div', { class: 'lap-row' + (i === all.length - 1 ? ' current' : '') }, h('span', null, `大問${i + 1}`), b);
                }),
              )
            : null,
        );
    this.paceEl = h('div', { class: 'timer-pace', 'data-testid': 'timer-pace', hidden: true });
    this.el = h('div', { class: 'timer' + (s.min ? ' min' : '') + (s.pomo?.phase === 'break' ? ' pomo-break' : '') }, head, this.timeEl, this.paceEl, body);
    if (s.x !== undefined && s.y !== undefined) {
      this.el.style.left = `${Math.min(window.innerWidth - 120, Math.max(0, s.x))}px`;
      this.el.style.top = `${Math.min(window.innerHeight - 60, Math.max(0, s.y))}px`;
      this.el.style.right = this.el.style.bottom = 'auto';
    }
    this.makeDraggable(head);
    document.body.appendChild(this.el);
    this.update();
    this.tick = window.setInterval(() => this.update(), 250);
  }

  private makeDraggable(handle: HTMLElement) {
    let start: { x: number; y: number; ex: number; ey: number } | null = null;
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const r = this.el!.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, ex: r.left, ey: r.top };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start || !this.el) return;
      const x = start.ex + e.clientX - start.x, y = start.ey + e.clientY - start.y;
      Object.assign(this.el.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
      this.s.x = x;
      this.s.y = y;
    });
    handle.addEventListener('pointerup', () => {
      if (start) this.save();
      start = null;
    });
  }
}

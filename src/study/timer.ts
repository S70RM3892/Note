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
  stats: { addExam(label: string, plannedSec: number, usedSec: number): void };
}

export class TimerWidget {
  private s: TimerState = load();
  private el: HTMLElement | null = null;
  private tick = 0;
  private timeEl!: HTMLElement;

  constructor(private host: TimerHost) {
    if (this.s.visible) this.mount();
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
  }

  private set(label: string, minutes: number) {
    this.logIfUsed();
    this.s = { ...this.s, label, duration: minutes * 60_000, startedAt: null, elapsed: 0, warned: false, ended: false };
    this.save();
    this.mount();
  }

  private logIfUsed() {
    const used = this.elapsed();
    if (used > 60_000) this.host.stats.addExam(this.s.label, this.s.duration / 1000, used / 1000);
  }

  private toggle() {
    if (this.s.startedAt) {
      this.s.elapsed = this.elapsed();
      this.s.startedAt = null;
    } else this.s.startedAt = Date.now();
    this.save();
    this.mount();
  }

  private reset() {
    this.logIfUsed();
    this.s.startedAt = null;
    this.s.elapsed = 0;
    this.s.warned = this.s.ended = false;
    this.save();
    this.mount();
  }

  private update() {
    if (!this.el) return;
    const e = this.elapsed();
    const d = this.s.duration;
    const remain = d ? d - e : e;
    this.timeEl.textContent = fmt(d ? remain : e);
    this.el.classList.toggle('warn', !!d && remain > 0 && remain <= 10 * 60_000);
    this.el.classList.toggle('over', !!d && remain <= 0);
    if (d && this.s.startedAt) {
      if (!this.s.warned && remain <= 10 * 60_000 && remain > 0 && d > 15 * 60_000) {
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
      }
    }
  }

  private mount() {
    this.unmount();
    if (!this.s.visible) return;
    const s = this.s;
    this.timeEl = h('div', { class: 'timer-time', 'data-testid': 'timer-time' });
    const head = h(
      'div',
      { class: 'timer-head' },
      icon('timer', 16),
      h('span', { style: 'flex:1' }, s.duration ? s.label : 'ストップウォッチ'),
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
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn primary', style: 'flex:1', onclick: () => this.toggle(), 'data-testid': 'timer-toggle' }, icon(s.startedAt ? 'pause' : 'play', 18), s.startedAt ? '一時停止' : this.elapsed() ? '再開' : '開始'),
            h('button', { class: 'btn', onclick: () => this.reset(), 'aria-label': 'リセット' }, icon('reset', 18)),
          ),
        );
    this.el = h('div', { class: 'timer' + (s.min ? ' min' : '') }, head, this.timeEl, body);
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

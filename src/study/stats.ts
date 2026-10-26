import { dayKey, type Repo, type StudyStats } from '../store/repo';

const CONTINUOUS_GAP = 90_000; // writing again within 90 s counts as continuous study
const MIN_CREDIT = 4_000;

/** Accumulates active writing time per day. */
export class StatsTracker {
  private last = 0;
  private timer = 0;
  private listeners = new Set<() => void>();

  constructor(private repo: Repo, public data: StudyStats) {}

  activity(now = Date.now()) {
    const gap = now - this.last;
    const add = gap > 0 && gap < CONTINUOUS_GAP ? gap : MIN_CREDIT;
    this.last = now;
    const k = dayKey(now);
    this.data.days[k] = (this.data.days[k] ?? 0) + add / 1000;
    this.save();
  }

  addExam(label: string, plannedSec: number, usedSec: number) {
    this.data.exams.unshift({ at: Date.now(), label, planned: plannedSec, used: usedSec });
    this.data.exams = this.data.exams.slice(0, 200);
    this.save(true);
  }

  today(): number {
    return this.data.days[dayKey(Date.now())] ?? 0;
  }

  lastDays(n: number): { key: string; label: string; sec: number }[] {
    const out = [];
    const d = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
      const k = dayKey(t.getTime());
      out.push({ key: k, label: '日月火水木金土'[t.getDay()], sec: this.data.days[k] ?? 0 });
    }
    return out;
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private save(now = false) {
    clearTimeout(this.timer);
    const run = () => {
      void this.repo.saveStats(this.data);
      this.listeners.forEach((l) => l());
    };
    if (now) run();
    else this.timer = window.setTimeout(run, 3000);
  }

  flush() {
    clearTimeout(this.timer);
    void this.repo.saveStats(this.data);
  }
}

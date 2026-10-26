import { sleepLocked } from '../store/settings';
import { h } from '../ui/dom';
import type { App } from './app';

const HOLD_MS = 5000;
const GRANT_MS = 15 * 60_000;
const MAX_GRANTS = 2;
const RELEASE_PHRASE = '今夜だけ解除';

/**
 * 就寝ロック: from 15 minutes after bedtime until wake time the whole app sits behind this screen
 * (nothing can be written). "15 more minutes" needs a 5-second hold, twice a night at most; after
 * that only typing a phrase unlocks the rest of the night. Not while the exam timer runs.
 */
export class SleepLock {
  private el: HTMLElement | null = null;
  private grantUntil = 0;
  private grants = 0;
  private wasNight = false;
  private timer = 0;

  constructor(private app: App) {}

  get locked(): boolean {
    return !!this.el;
  }

  check() {
    const s = this.app.settings.get();
    const now = new Date();
    const lockTime = sleepLocked(s, now);
    // A new night starts with fresh overrides.
    if (lockTime && !this.wasNight) {
      this.grants = 0;
      this.grantUntil = 0;
    }
    this.wasNight = lockTime;
    const lock = lockTime && Date.now() >= this.grantUntil && !this.app.timer.running;
    if (lock && !this.el) this.show();
    else if (!lock && this.el) this.hide();
  }

  private grant(ms: number) {
    this.grantUntil = Date.now() + ms;
    this.hide();
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.check(), ms + 500);
  }

  private hide() {
    this.el?.remove();
    this.el = null;
  }

  private show() {
    void this.app.flush();
    (document.activeElement as HTMLElement | null)?.blur?.();
    const s = this.app.settings.get();
    const left = MAX_GRANTS - this.grants;
    const hold = h('button', { class: 'btn hold-btn', 'data-testid': 'sleep-more' }, h('span', { class: 'hold-fill' }), h('span', { class: 'hold-label' }, `あと15分だけ（5秒長押し・今夜あと${left}回）`));
    let holdTimer = 0;
    const release = () => {
      clearTimeout(holdTimer);
      hold.classList.remove('holding');
    };
    hold.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      hold.classList.add('holding');
      holdTimer = window.setTimeout(() => {
        this.grants++;
        this.grant(GRANT_MS);
      }, HOLD_MS);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) hold.addEventListener(ev, release);

    const phrase = h('input', { class: 'input', placeholder: `「${RELEASE_PHRASE}」と入力`, 'data-testid': 'sleep-phrase', autocomplete: 'off' });
    phrase.addEventListener('input', () => {
      if (phrase.value.trim() === RELEASE_PHRASE) this.grant(12 * 3600_000);
    });

    this.el = h(
      'div',
      { class: 'sleep-lock', role: 'dialog', 'aria-label': '就寝ロック', 'data-testid': 'sleep-lock' },
      h(
        'div',
        { class: 'sleep-card' },
        h('div', { class: 'sleep-moon' }, '🌙'),
        h('h2', null, '寝る時間だ'),
        h('p', null, `${s.bedtime} を過ぎた。ノートは保存済み。起床 ${s.wakeTime} までここで終わり。`),
        h('p', { class: 'muted' }, 'その日に覚えたことは寝ている間に定着する。削った睡眠は、翌日の集中力と記憶で払うことになる。'),
        left > 0 ? hold : h('div', { class: 'sleep-phrase' }, h('p', { class: 'muted' }, '延長は使い切った。どうしても必要なら：'), phrase),
      ),
    );
    document.body.appendChild(this.el);
  }
}

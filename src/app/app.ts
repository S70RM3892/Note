import { AssetCache } from '../editor/assets';
import { Editor } from '../editor/editor';
import { Repo } from '../store/repo';
import { SettingsStore, isNight } from '../store/settings';
import { StatsTracker } from '../study/stats';
import { TimerWidget } from '../study/timer';
import { h } from '../ui/dom';
import { toast } from '../ui/dialogs';
import { native } from '../platform';
import { EditorView } from './editorView';
import { LibraryView } from './library';
import { startReview } from './review';
import { SleepLock } from './sleepLock';
import { HubStore } from '../hub/data';
import { BreakWatch } from '../hub/health';
import { HubView } from '../hub/view';
import { upcomingExams } from '../study/countdown';
import { dayKey } from '../store/repo';

export interface View {
  el: HTMLElement;
  destroy(): void | Promise<void>;
}

/** Application shell: storage, settings, routing between library and editor. */
export class App {
  readonly root: HTMLElement;
  readonly main: HTMLElement;
  private bannerHost: HTMLElement;
  private view: View | null = null;
  private editor: Editor | null = null;
  private nightEl: HTMLElement | null = null;
  private snoozeUntil = 0;
  private bannerKey = '';
  readonly timer: TimerWidget;
  readonly sleepLock = new SleepLock(this);
  /** 受験ハブ: 模試・単語帳・睡眠… (everything outside the notebooks). */
  readonly hub: HubStore;
  /** 目の休憩: how long writing has gone on without a break. */
  readonly breaks = new BreakWatch();

  constructor(
    public repo: Repo,
    public settings: SettingsStore,
    public assets: AssetCache,
    public stats: StatsTracker,
  ) {
    this.root = document.getElementById('app')!;
    this.bannerHost = h('div');
    this.main = h('div', { style: 'flex:1;display:flex;flex-direction:column;min-height:0' });
    this.root.append(this.bannerHost, this.main);
    this.hub = new HubStore(repo);
    this.timer = new TimerWidget(this);
    window.addEventListener('hashchange', () => void this.route());
    settings.subscribe(() => {
      this.applyTheme();
      this.checkNight();
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    this.applyTheme();
    this.checkNight();
    setInterval(() => this.checkNight(), 60_000);
    // Persist on background / close.
    const flush = () => {
      void this.flush();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
      // The screen wake lock is dropped whenever the page is hidden.
      else if (this.timer.running && !native) void this.requestWakeLock();
    });
    window.addEventListener('pagehide', flush);
  }

  async flush() {
    this.stats.flush();
    void this.hub.flush();
    this.pushWidget();
    if (this.view instanceof EditorView) await this.view.save();
  }

  /** APK home screen widget: next exam, today's writing time, pages due for review. */
  pushWidget(due?: number) {
    if (!native?.setWidget) return;
    if (due !== undefined) this.widgetDue = due;
    const exam = upcomingExams(this.settings.get().exams)[0];
    native.setWidget(JSON.stringify({ exam: exam?.name ?? '', examDate: exam?.date ?? '', todaySec: Math.round(this.stats.today()), day: dayKey(Date.now()), due: this.widgetDue }));
  }

  private widgetDue = 0;

  /** Writing happened: count it, and nudge a break after an hour without one (目の休憩). */
  private onWriting(pageId?: string) {
    const now = Date.now();
    this.stats.activity(now, this.editor?.doc?.nb.id, pageId);
    if (pageId && this.view instanceof EditorView) this.view.noteWritten(pageId);
    const nudge = this.breaks.activity(now);
    if (!nudge || !this.hub.get().prefs.eyeBreaks || this.timer.running) return;
    if (nudge === 'micro') toast('30分続けて書いている。1〜2分、画面から目を離して遠くを見ろ。', 4000);
    else toast('1時間続けて書いた。10〜15分休め（目を休め、体を動かす）。', 6000);
  }

  private editorHooks: ((ed: Editor) => void)[] = [];

  /** Run `fn` with the shared editor as soon as it exists. */
  withEditor(fn: (ed: Editor) => void) {
    if (this.editor) fn(this.editor);
    else this.editorHooks.push(fn);
  }

  /** Shared editor canvas (created on first use, moved between views). */
  getEditor(host: HTMLElement): Editor {
    if (!this.editor) {
      this.editor = new Editor(host, this.settings, this.assets);
      this.editor.toast = (m) => toast(m, 900);
      this.editor.onActivity = (_ms, pageId) => this.onWriting(pageId);
      this.editorHooks.splice(0).forEach((fn) => fn(this.editor!));
    } else host.appendChild(this.editor.el);
    return this.editor;
  }

  private wakeLock: WakeLockSentinel | null = null;

  /** 集中モード while the exam clock runs: keep the screen on, and in the APK optionally pin the app. */
  /** 過去問タイマー → the page: the result line at the top of the page being worked on. */
  stampResult(text: string): boolean {
    return this.view instanceof EditorView && this.view.stampText(text, 'left');
  }

  onTimerRunning(running: boolean) {
    if (!running) this.sleepLock.check();
    // おやすみモード while the clock runs (only if the user turned it on and Android allows it).
    if (native?.setDnd && (this.hub.get().prefs.dnd || !running) && (native.dndAllowed?.() ?? false)) native.setDnd(running && this.hub.get().prefs.dnd);
    if (native) {
      native.setKeepScreenOn(running);
      if (this.settings.get().focusPin || !running) native.setFocusLock?.(running);
      return;
    }
    if (running) void this.requestWakeLock();
    else {
      void this.wakeLock?.release().catch(() => {});
      this.wakeLock = null;
    }
  }

  private async requestWakeLock() {
    try {
      this.wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      /* not allowed (e.g. hidden page); retried when the page is visible again */
    }
  }

  /** S Pen side button reported by the Android shell (also covers hovering, which pointer events don't). */
  private penButtonAt = 0;
  private penButtonDowns = 0;

  /** S Pen side button (APK). A click — pressed and released within 0.4 s without writing — runs the chosen action. */
  setPenButton(down: boolean) {
    const ed = this.editor;
    if (!ed) return;
    ed.sideButtonHeld = down;
    if (down) {
      this.penButtonAt = performance.now();
      this.penButtonDowns = ed.penDowns;
      return;
    }
    const click = performance.now() - this.penButtonAt < 400 && ed.penDowns === this.penButtonDowns;
    if (!click || !ed.doc || !ed.el.isConnected || document.querySelector('.modal-backdrop, .sleep-lock')) return;
    const action = this.settings.get().penButtonClick;
    if (action === 'undo') ed.undo();
    else if (action === 'highlighter' || action === 'eraser') {
      ed.setTool(ed.tool === action ? 'pen' : action);
      ed.toast?.(ed.tool === 'pen' ? 'ペン' : action === 'eraser' ? '消しゴム' : 'マーカー');
    }
  }

  go(hash: string) {
    if (location.hash === hash) void this.route();
    else location.hash = hash;
  }

  async route() {
    const hash = location.hash || '#/';
    const prev = this.view;
    this.view = null;
    if (prev) await prev.destroy();
    this.main.replaceChildren();
    let next: View;
    const nb = hash.match(/^#\/nb\/([^/?]+)(?:\/(\d+))?/);
    if (nb) {
      const v = await EditorView.open(this, nb[1], nb[2] ? parseInt(nb[2], 10) : undefined);
      if (!v) {
        toast('ノートが見つかりません');
        this.go('#/');
        return;
      }
      next = v;
    } else if (hash.startsWith('#/hub')) {
      next = new HubView(this, hash.match(/^#\/hub\/([\w-]+)/)?.[1]);
    } else if (hash.startsWith('#/review')) {
      const v = await startReview(this);
      if (!v) {
        toast('今日の復習はありません。えらい。');
        this.go('#/');
        return;
      }
      next = v;
    } else {
      next = new LibraryView(this);
    }
    this.view = next;
    this.main.appendChild(next.el);
  }

  applyTheme() {
    const t = this.settings.get().theme;
    const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1c1d22' : '#ffffff');
    if (this.editor) {
      const cs = getComputedStyle(document.documentElement);
      this.editor.renderer.desk = cs.getPropertyValue('--desk').trim() || '#e4e5e9';
      this.editor.renderer.shadow = dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.16)';
      this.editor.renderer.request();
    }
  }

  /** Bedtime: banner + warm filter. Sleep is part of the plan. */
  checkNight() {
    const s = this.settings.get();
    const night = s.bedtimeEnabled && isNight(s, new Date());
    const filterOn = night && s.nightFilter;
    if (filterOn && !this.nightEl) {
      this.nightEl = h('div', { class: 'night-filter' });
      document.body.appendChild(this.nightEl);
    } else if (!filterOn && this.nightEl) {
      this.nightEl.remove();
      this.nightEl = null;
    }
    this.sleepLock.check();
    const show = night && Date.now() > this.snoozeUntil;
    const key = show ? s.bedtime : '';
    if (key === this.bannerKey) return; // no DOM churn every minute
    this.bannerKey = key;
    this.bannerHost.replaceChildren();
    if (show) {
      this.bannerHost.appendChild(
        h(
          'div',
          { class: 'banner', role: 'alert' },
          h('span', null, `🌙 ${s.bedtime} を過ぎた。ノートは自動保存済み。今日はここまでにして寝ろ。記憶は寝てる間に定着する。`),
          h('button', { class: 'btn', 'data-testid': 'banner-reflect', onclick: () => this.go('#/hub/reflect') }, '振り返り'),
          h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                this.snoozeUntil = Date.now() + 20 * 60_000;
                this.checkNight();
              },
            },
            'あと20分',
          ),
        ),
      );
    }
  }
}

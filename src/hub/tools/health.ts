/** 体調・睡眠: 睡眠記録, 仮眠タイマー, 目の休憩, and the APK's widget / おやすみモード. */
import { native } from '../../platform';
import { h } from '../../ui/dom';
import { toast } from '../../ui/dialogs';
import { icon } from '../../ui/icons';
import { HEALTH_SOURCES, TEEN_SLEEP, clock, nightFrom, sleepHours, sleepSummary } from '../health';
import { card, md, source, todayKey } from '../ui';
import type { Tool, ToolCtx } from './index';

// ---------- 睡眠記録 ----------

function sleepTool(ctx: ToolCtx): HTMLElement {
  const s = ctx.hub.get();
  const set = ctx.app.settings.get();
  const today = todayKey();
  const cur = s.sleep.find((e) => e.day === today);
  const hhmm = (t: number) => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const bed = h('input', { class: 'input', type: 'time', value: cur ? hhmm(cur.bed) : set.bedtime, 'data-testid': 'sleep-bed' });
  const wake = h('input', { class: 'input', type: 'time', value: cur ? hhmm(cur.wake) : set.wakeTime, 'data-testid': 'sleep-wake' });
  const sum = sleepSummary(s.sleep);
  const nights = [...s.sleep].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 14);
  const shift = sum.weekdayWake !== null && sum.weekendWake !== null ? Math.round(sum.weekendWake - sum.weekdayWake) : null;
  return h(
    'div',
    null,
    card(
      `昨夜（${md(today)}の朝まで）`,
      h('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, '寝た'), bed), h('label', { class: 'field' }, h('span', { class: 'field-label' }, '起きた'), wake)),
      h(
        'button',
        {
          class: 'btn primary',
          'data-testid': 'sleep-save',
          onclick: () => {
            const e = nightFrom(today, bed.value, wake.value);
            if (!e) return toast('時刻がおかしい');
            ctx.hub.update((st) => {
              st.sleep = [...st.sleep.filter((x) => x.day !== today), e].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-400);
              st.sleepAsked = today;
            });
            toast(`${sleepHours(e).toFixed(1)}時間`);
            ctx.refresh();
          },
        },
        '記録',
      ),
    ),
    card(
      '直近7日',
      sum.nights
        ? h(
            'div',
            { 'data-testid': 'sleep-summary' },
            h('div', { class: 'big-num' }, `${sum.avg!.toFixed(1)}`, h('small', { class: 'muted', style: 'font-size:14px' }, ` 時間（平均・${sum.nights}晩）`)),
            h('div', null, `${TEEN_SLEEP.min}〜${TEEN_SLEEP.max}時間の夜：${sum.inRange} / ${sum.nights}`),
            sum.bedSpread !== null ? h('div', null, `寝る時刻のばらつき ±${Math.round(sum.bedSpread)}分・起きる時刻 ±${Math.round(sum.wakeSpread!)}分`) : null,
            shift !== null ? h('div', { class: Math.abs(shift) >= 60 ? 'bad' : '' }, `休日の起床は平日より ${shift >= 0 ? `${shift}分遅い` : `${-shift}分早い`}`) : null,
          )
        : h('p', { class: 'muted' }, 'まだ記録がない。'),
      h(
        'ul',
        { class: 'plain small' },
        h('li', null, `高校生は${TEEN_SLEEP.min}〜${TEEN_SLEEP.max}時間を目安に寝る時間を確保する。`),
        h('li', null, '週末も普段と同じ時刻に起きて朝の光を浴びる（休日の寝坊でリズムが後ろにずれる）。'),
        h('li', null, '睡眠は学んだ内容を定着させる。削って勉強時間を作るのは逆効果。'),
        h('li', null, '寝室にスマホ・タブレットを持ち込まず、暗くして寝る。'),
      ),
      source('厚生労働省 健康づくりのための睡眠ガイド 2023', HEALTH_SOURCES.sleepGuide),
    ),
    nights.length
      ? card(
          '記録',
          h(
            'div',
            { class: 'sleep-bars' },
            nights.map((n) => {
              const hrs = sleepHours(n);
              return h(
                'div',
                { class: 'sleep-bar' },
                h('span', null, md(n.day)),
                h('div', { class: 'sleep-track' }, h('i', { class: hrs >= TEEN_SLEEP.min && hrs <= TEEN_SLEEP.max ? 'ok' : 'short', style: `width:${Math.min(100, (hrs / 12) * 100)}%` }), h('b', { class: 'band', style: `left:${(TEEN_SLEEP.min / 12) * 100}%;width:${((TEEN_SLEEP.max - TEEN_SLEEP.min) / 12) * 100}%` })),
                h('small', null, `${hrs.toFixed(1)}h ${clock(new Date(n.bed).getHours() * 60 + new Date(n.bed).getMinutes())}→${clock(new Date(n.wake).getHours() * 60 + new Date(n.wake).getMinutes())}`),
              );
            }),
          ),
        )
      : null,
    h(
      'label',
      { class: 'toggle-row' },
      h('div', null, h('div', null, '朝、ライブラリで昨夜の睡眠を聞く'), h('div', { class: 'desc' }, '設定の就寝・起床時刻が初期値。1タップで記録')),
      h('input', { type: 'checkbox', class: 'switch', checked: s.prefs.askSleep, onchange: (e: Event) => ctx.hub.update((st) => void (st.prefs.askSleep = (e.target as HTMLInputElement).checked)) }),
    ),
  );
}

// ---------- 仮眠タイマー ----------

function chime() {
  try {
    const ac = new AudioContext();
    [0, 0.4, 0.8, 1.2].forEach((t) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = 660;
      g.gain.setValueAtTime(0.0001, ac.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.35, ac.currentTime + t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.35);
      o.connect(g).connect(ac.destination);
      o.start(ac.currentTime + t);
      o.stop(ac.currentTime + t + 0.4);
    });
    setTimeout(() => void ac.close(), 2000);
  } catch {
    /* no audio */
  }
}

function napTool(ctx: ToolCtx): HTMLElement {
  const choices = [10, 15, 20];
  const start = () => {
    const min = ctx.hub.get().prefs.napMin;
    const end = Date.now() + min * 60_000;
    native?.setKeepScreenOn(true);
    const time = h('div', { class: 'nap-time', 'data-testid': 'nap-time' });
    let ring = 0;
    const done = () => {
      clearInterval(tick);
      clearInterval(ring);
      native?.setKeepScreenOn(ctx.app.timer.running);
      overlay.remove();
    };
    const overlay = h('div', { class: 'nap-overlay', 'data-testid': 'nap' }, h('div', { class: 'nap-moon' }, icon('moon', 40)), time, h('div', { class: 'muted' }, '目を閉じろ。時間になったら鳴る'), h('button', { class: 'btn', 'data-testid': 'nap-stop', onclick: done }, '起きた'));
    document.body.append(overlay);
    const tick = window.setInterval(() => {
      const left = end - Date.now();
      if (left <= 0) {
        time.textContent = '起きろ';
        overlay.classList.add('ringing');
        if (!ring) {
          const buzz = () => {
            chime();
            navigator.vibrate?.([500, 200, 500]);
          };
          buzz();
          ring = window.setInterval(buzz, 4000);
        }
        return;
      }
      const s = Math.ceil(left / 1000);
      time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 250);
    ctx.onLeave(done);
  };
  return h(
    'div',
    null,
    card(
      '短い昼寝',
      h(
        'div',
        { class: 'chips' },
        choices.map((m) =>
          h(
            'button',
            {
              class: 'chip' + (ctx.hub.get().prefs.napMin === m ? ' on' : ''),
              onclick: (e: Event) => {
                ctx.hub.update((s) => void (s.prefs.napMin = m));
                (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
              },
            },
            `${m}分`,
          ),
        ),
      ),
      h('button', { class: 'btn primary', style: 'margin-top:10px', 'data-testid': 'nap-start', onclick: start }, icon('moon', 18), '寝る'),
      h(
        'ul',
        { class: 'plain small' },
        h('li', null, '午後の昼寝は、眠った時間が10分程度のものが最もすっきりし、30分になると起きた直後にかえってぼんやりした（Brooks & Lack, Sleep 2006）。寝つくまでの数分を足して15分が初期値。'),
        h('li', null, '長い昼寝は夜の睡眠を妨げる（厚生労働省 睡眠ガイド 2023）。夕方以降は寝ない。'),
        h('li', null, '時間まで画面は点けたまま。アプリを閉じると鳴らない。'),
      ),
    ),
  );
}

// ---------- 目の休憩 ----------

function breaksTool(ctx: ToolCtx): HTMLElement {
  const s = ctx.hub.get();
  const stretch = Math.round(ctx.app.breaks.stretch(Date.now()));
  return h(
    'div',
    null,
    card(
      '連続して書いた時間',
      h('div', { class: 'big-num', 'data-testid': 'break-stretch' }, `${stretch}`, h('small', { class: 'muted', style: 'font-size:14px' }, ' 分')),
      h(
        'label',
        { class: 'toggle-row' },
        h('div', null, h('div', null, '休憩を知らせる'), h('div', { class: 'desc' }, '30分で「小休止」、60分で「10〜15分休め」。10分書かなければリセット。過去問タイマー中は出さない')),
        h('input', { type: 'checkbox', class: 'switch', checked: s.prefs.eyeBreaks, 'data-testid': 'break-toggle', onchange: (e: Event) => ctx.hub.update((st) => void (st.prefs.eyeBreaks = (e.target as HTMLInputElement).checked)) }),
      ),
      h('p', { class: 'muted small' }, '画面を見る作業は、一続きを1時間以内にして次までに10〜15分休み、その間にも1〜2回の小休止（1〜2分）を入れる（厚生労働省のガイドライン）。休憩中は画面から目を離して遠くを見る。'),
      source('厚生労働省 情報機器作業における労働衛生管理のためのガイドライン', HEALTH_SOURCES.vdt),
    ),
  );
}

// ---------- Android 連携 ----------

function deviceTool(ctx: ToolCtx): HTMLElement {
  const s = ctx.hub.get();
  const status = h('div', { class: 'muted small', 'data-testid': 'dnd-status' });
  const paint = () => {
    const ok = native?.dndAllowed?.() ?? false;
    status.textContent = ok ? 'おやすみモードの変更は許可済み' : 'まだ許可されていない：「許可する」→ Sumi Note をオン';
    grant.hidden = ok;
  };
  const grant = h('button', { class: 'btn small', onclick: () => native?.requestDnd?.() }, '許可する');
  const onVis = () => document.visibilityState === 'visible' && paint();
  document.addEventListener('visibilitychange', onVis);
  ctx.onLeave(() => document.removeEventListener('visibilitychange', onVis));
  paint();
  return h(
    'div',
    null,
    card(
      'タイマー中はおやすみモード',
      h(
        'label',
        { class: 'toggle-row' },
        h('div', null, h('div', null, '過去問タイマー・ポモドーロの間は通知を止める'), h('div', { class: 'desc' }, 'Android のおやすみモード（アラームだけ鳴る）。止めると元の設定に戻す')),
        h('input', {
          type: 'checkbox',
          class: 'switch',
          checked: s.prefs.dnd,
          'data-testid': 'dnd-toggle',
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            ctx.hub.update((st) => void (st.prefs.dnd = on));
            if (on && !native?.dndAllowed?.()) native?.requestDnd?.();
          },
        }),
      ),
      h('div', { class: 'row', style: 'gap:8px' }, status, grant),
    ),
    card(
      'ホーム画面のウィジェット',
      h('p', null, '入試までの日数・今日の学習時間・今日の復習ページ数をホーム画面に出す。'),
      h('p', { class: 'muted small' }, 'ホーム画面の何もない所を長押し →「ウィジェット」→ Sumi Note →「入試カウントダウン」を置く。タップでアプリが開く。数字はライブラリを開くたびに更新され、日数は日付が変わると自動で減る。'),
    ),
  );
}

export const HEALTH_TOOLS: Tool[] = [
  {
    id: 'sleep',
    group: 'health',
    title: '睡眠記録',
    blurb: '高校生の目安 8〜10時間と比べる。休日の寝坊も見える',
    icon: 'bed',
    summary: (ctx) => {
      const s = sleepSummary(ctx.hub.get().sleep);
      return s.avg !== null ? `7日平均 ${s.avg.toFixed(1)}時間（${s.nights}晩）` : null;
    },
    render: sleepTool,
  },
  { id: 'nap', group: 'health', title: '仮眠タイマー', blurb: '10〜20分で起こす。暗い画面で待つ', icon: 'alarm', render: napTool },
  {
    id: 'breaks',
    group: 'health',
    title: '目の休憩',
    blurb: '1時間書き続けたら休めと知らせる',
    icon: 'eye',
    summary: (ctx) => (ctx.hub.get().prefs.eyeBreaks ? 'オン' : 'オフ'),
    render: breaksTool,
  },
  { id: 'device', group: 'health', title: 'Android 連携', blurb: 'タイマー中のおやすみモード、ホーム画面のウィジェット', icon: 'phone', render: deviceTool, available: () => !!native?.setDnd },
];

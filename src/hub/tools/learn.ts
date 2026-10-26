/** 覚える・解く: ミス分析, 単語帳, 英文の読み上げ, リスニング, 質問リスト. */
import { uid } from '../../core/id';
import type { Grade } from '../../core/srs';
import { formatDate, h } from '../../ui/dom';
import { confirmDialog, modal, pickFiles, promptDialog, shareOrDownload, toast } from '../../ui/dialogs';
import { icon } from '../../ui/icons';
import { cardsCsv, deckCounts, gradeCard, looksEnglish, parseCards, studyQueue, type Card } from '../cards';
import { MISTAKE_KINDS, mistakeStats } from '../mistakes';
import { canSpeak, sentences, speak, stopSpeaking } from '../speech';
import { card, fill, md, pct, progress, text, todayKey } from '../ui';
import type { Tool, ToolCtx } from './index';

// ---------- ミス分析 ----------

function mistakesTool(ctx: ToolCtx): HTMLElement {
  let days = 30;
  const body = h('div');
  const paint = () => {
    const all = ctx.hub.get().mistakes;
    const s = mistakeStats(all, Date.now(), days);
    fill(body, s.total
        ? h(
            'div',
            { class: 'hub-cols' },
            card(
              `ミスの種類（${s.total}件）`,
              h(
                'div',
                { 'data-testid': 'mistake-kinds' },
                s.byKind.map((k) => h('div', { class: 'bar-row' }, h('span', null, k.label), progress(k.pct), h('b', null, `${k.count}（${pct(k.pct)}）`))),
              ),
              s.byKind[0] ? h('p', { class: 'small' }, `いちばん多いのは「${s.byKind[0].label}」。次の演習ではこれを1つだけ意識しろ。`) : null,
            ),
            card(
              '科目別',
              s.bySubject.map((x) => h('div', { class: 'bar-row' }, h('span', null, x.subject), h('b', null, `${x.count}件`), x.top ? h('small', { class: 'muted' }, `多いのは ${x.top}`) : null)),
            ),
          )
        : h('p', { class: 'muted' }, 'まだ記録がない。投げ縄で問題を囲んで「まちがいノートへ」を押すと、ミスの種類を聞かれる。'),
      all.length
        ? card(
            '最近のミス',
            [...all]
              .sort((a, b) => b.at - a.at)
              .slice(0, 20)
              .map((m) =>
                h(
                  'button',
                  { class: 'list-row', onclick: () => m.nb && ctx.app.go(`#/nb/${m.nb}`) },
                  h('span', { class: 'list-main' }, h('b', null, MISTAKE_KINDS.find((k) => k.id === m.kind)?.label ?? m.kind), h('small', { class: 'muted' }, ` ${m.subject}`)),
                  h('small', { class: 'muted' }, formatDate(m.at)),
                ),
              ),
          )
        : null,
    );
  };
  paint();
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'chips', style: 'margin-bottom:12px' },
      (
        [
          [7, '7日'],
          [30, '30日'],
          [0, 'すべて'],
        ] as const
      ).map(([d, label]) =>
        h(
          'button',
          {
            class: 'chip' + (days === d ? ' on' : ''),
            onclick: (e: Event) => {
              days = d;
              (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
              paint();
            },
          },
          label,
        ),
      ),
    ),
    body,
  );
}

// ---------- 単語帳 ----------

function importCards(ctx: ToolCtx, deck: string) {
  const area = h('textarea', { class: 'input mono', rows: 10, placeholder: 'apple\tりんご\n"take off",離陸する\n漸化式：recurrence relation', 'data-testid': 'cards-import' });
  const save = h('button', { class: 'btn primary', 'data-testid': 'cards-import-ok' }, '追加');
  const handle = modal('カードを追加', h('div', null, h('p', { class: 'muted small' }, '1行に1枚。「表<タブ>裏」「表,裏」（CSV）「表：裏」のどれか。Excel やスプレッドシートの2列をそのまま貼れる。'), area), { wide: true, actions: [save] });
  save.onclick = () => {
    const rows = parseCards(area.value);
    if (!rows.length) return toast('読めるカードがない');
    const now = Date.now();
    ctx.hub.update((s) => void s.cards.push(...rows.map((r, i) => ({ id: uid(), deck, front: r.front, back: r.back, added: now + i }))));
    toast(`${rows.length}枚追加した`);
    handle.close();
    ctx.refresh();
  };
}

function study(ctx: ToolCtx, deck: string, host: HTMLElement) {
  const queue = studyQueue(ctx.hub.get().cards, deck);
  let shown = false;
  const rate = () => ctx.hub.get().prefs.ttsRate;
  const next = () => {
    const c = queue[0];
    if (!c) {
      fill(host, card(null, h('p', { 'data-testid': 'study-done' }, '今日の分は終わり。'), h('button', { class: 'btn', onclick: () => ctx.refresh() }, '単語帳に戻る')));
      return;
    }
    const say = (s: string) => () => void speak(s, rate());
    const answer = (g: Grade) => {
      queue.shift();
      const graded = gradeCard(c, g);
      ctx.hub.update((s) => {
        s.cards = s.cards.map((x) => (x.id === c.id ? graded : x));
        s.cardLog[todayKey()] = (s.cardLog[todayKey()] ?? 0) + 1;
      });
      if (g === 1) queue.push(graded); // again later in this session
      shown = false;
      next();
    };
    fill(host, h(
        'section',
        { class: 'card flash', 'data-testid': 'flash' },
        h('div', { class: 'muted small' }, `残り ${queue.length}枚`),
        h('div', { class: 'flash-front', 'data-testid': 'flash-front' }, c.front, canSpeak() && looksEnglish(c.front) ? h('button', { class: 'icon-btn', 'aria-label': '読み上げ', onclick: say(c.front) }, icon('speaker', 18)) : null),
        shown
          ? h('div', { class: 'flash-back', 'data-testid': 'flash-back' }, c.back, canSpeak() && looksEnglish(c.back) ? h('button', { class: 'icon-btn', 'aria-label': '読み上げ', onclick: say(c.back) }, icon('speaker', 18)) : null)
          : null,
        shown
          ? h(
              'div',
              { class: 'grade-bar' },
              (
                [
                  [1, 'もう一回'],
                  [2, '難しい'],
                  [3, '普通'],
                  [4, '簡単'],
                ] as const
              ).map(([g, label]) => h('button', { class: 'btn' + (g === 3 ? ' primary' : ''), 'data-testid': `grade-${g}`, onclick: () => answer(g) }, label)),
            )
          : h('button', { class: 'btn primary', 'data-testid': 'flash-show', onclick: () => ((shown = true), next()) }, '答えを見る'),
      ),
    );
  };
  next();
}

function cardsTool(ctx: ToolCtx): HTMLElement {
  const host = h('div');
  const s = ctx.hub.get();
  const addDeck = async () => {
    const name = await promptDialog('単語帳の名前', '', '例: 英単語 ターゲット1900');
    if (!name) return;
    ctx.hub.update((st) => void st.decks.push({ id: uid(), name, created: Date.now() }));
    ctx.refresh();
  };
  const addOne = async (deck: string) => {
    const front = await promptDialog('表', '', '例: abandon');
    if (!front) return;
    const back = await promptDialog('裏', '', '例: 捨てる、断念する');
    if (!back) return;
    ctx.hub.update((st) => void st.cards.push({ id: uid(), deck, front, back, added: Date.now() }));
    ctx.refresh();
  };
  host.append(
    h('div', { class: 'row', style: 'margin-bottom:12px;gap:8px' }, h('button', { class: 'btn primary', 'data-testid': 'deck-add', onclick: () => void addDeck() }, icon('plus', 18), '単語帳を作る')),
    s.decks.length
      ? h(
          'div',
          null,
          s.decks.map((d) => {
            const c = deckCounts(s.cards, d.id);
            const todo = studyQueue(s.cards, d.id).length;
            return h(
              'section',
              { class: 'card hub-card', 'data-testid': 'deck' },
              h('div', { class: 'row' }, h('b', { style: 'flex:1' }, d.name), h('small', { class: 'muted', 'data-testid': 'deck-counts' }, `全${c.total}枚・覚えた${c.learned}・復習${c.due}・未学習${c.fresh}`)),
              c.total ? progress(c.learned / c.total) : null,
              h(
                'div',
                { class: 'row', style: 'gap:6px;margin-top:8px;flex-wrap:wrap' },
                h('button', { class: 'btn small primary', disabled: !todo, 'data-testid': 'deck-study', onclick: () => study(ctx, d.id, host) }, icon('brain', 16), `今日の${todo}枚`),
                h('button', { class: 'btn small', 'data-testid': 'deck-import', onclick: () => importCards(ctx, d.id) }, icon('upload', 16), 'まとめて追加'),
                h('button', { class: 'btn small', onclick: () => void addOne(d.id) }, icon('plus', 16), '1枚'),
                h('button', { class: 'btn small', disabled: !c.total, onclick: () => void shareOrDownload(new Blob([cardsCsv(s.cards.filter((x) => x.deck === d.id))], { type: 'text/csv' }), `sumi-cards-${todayKey().replace(/-/g, '')}.csv`) }, icon('download', 16), 'CSV'),
                h(
                  'button',
                  {
                    class: 'btn small danger',
                    onclick: async () => {
                      if (!(await confirmDialog('単語帳を消す', `「${d.name}」と${c.total}枚のカードを消す？`, '消す', true))) return;
                      ctx.hub.update((st) => {
                        st.decks = st.decks.filter((x) => x.id !== d.id);
                        st.cards = st.cards.filter((x: Card) => x.deck !== d.id);
                      });
                      ctx.refresh();
                    },
                  },
                  '消す',
                ),
              ),
            );
          }),
        )
      : h('p', { class: 'muted' }, '英単語・古文単語・化学の反応などをカードにして、忘れかけた頃に出す（ページの復習と同じ間隔の伸ばし方）。新しいカードは1日20枚まで。英語は読み上げる。'),
  );
  return host;
}

// ---------- 英文の読み上げ ----------

function readerTool(ctx: ToolCtx): HTMLElement {
  let saved = '';
  try {
    saved = localStorage.getItem('sumi.reader') ?? '';
  } catch {
    /* ignore */
  }
  const list = h('div', { class: 'sent-list' });
  const area = h('textarea', {
    class: 'input',
    rows: 6,
    placeholder: '英文を貼る（長文の音読・シャドーイング用）',
    'data-testid': 'reader-text',
    oninput: () => {
      try {
        localStorage.setItem('sumi.reader', area.value);
      } catch {
        /* ignore */
      }
      paint();
    },
  });
  area.value = saved;
  const rate = () => ctx.hub.get().prefs.ttsRate;
  const paint = () =>
    fill(list, ...sentences(area.value).map((s, i) => h('div', { class: 'sent' }, h('button', { class: 'icon-btn', 'aria-label': `${i + 1}文目を読む`, 'data-testid': 'reader-sentence', onclick: () => speak(s, rate()) }, icon('play', 16)), h('span', null, s))),
    );
  paint();
  const rates = [0.6, 0.8, 1, 1.2];
  ctx.onLeave(stopSpeaking);
  return h(
    'div',
    null,
    canSpeak() ? null : h('p', { class: 'bad' }, 'この環境では読み上げが使えない。'),
    card(
      null,
      area,
      h(
        'div',
        { class: 'row', style: 'gap:6px;margin-top:8px;flex-wrap:wrap' },
        h('button', { class: 'btn primary small', 'data-testid': 'reader-all', onclick: () => speak(area.value, rate(), looksEnglish(area.value) ? 'en' : 'ja') }, icon('play', 16), '全部読む'),
        h('button', { class: 'btn small', onclick: stopSpeaking }, icon('pause', 16), '止める'),
        h('span', { class: 'spacer' }),
        h(
          'div',
          { class: 'chips' },
          rates.map((r) =>
            h(
              'button',
              {
                class: 'chip' + (rate() === r ? ' on' : ''),
                onclick: (e: Event) => {
                  ctx.hub.update((s) => void (s.prefs.ttsRate = r));
                  (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
                },
              },
              `×${r}`,
            ),
          ),
        ),
      ),
    ),
    card('1文ずつ', list),
  );
}

// ---------- リスニング ----------

function fmtTime(s: number) {
  if (!Number.isFinite(s)) return '--:--';
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function listenTool(ctx: ToolCtx): HTMLElement {
  const audio = h('audio', { preload: 'metadata' });
  audio.preservesPitch = true;
  let current: string | null = null;
  let url = '';
  let a: number | null = null;
  let b: number | null = null;
  const pos = h('span', { class: 'mono', 'data-testid': 'listen-pos' }, '0:00 / --:--');
  const abEl = h('span', { class: 'muted small', 'data-testid': 'listen-ab' });
  const playBtn = h('button', { class: 'btn primary', 'data-testid': 'listen-play', disabled: true, onclick: () => (audio.paused ? void audio.play() : audio.pause()) }, icon('play', 18));
  const seek = h('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'seek', oninput: () => audio.duration && (audio.currentTime = (Number(seek.value) / 1000) * audio.duration) });
  const paintAb = () => (abEl.textContent = a === null ? '' : b === null ? `A ${fmtTime(a)} から` : `A ${fmtTime(a)} 〜 B ${fmtTime(b)} を繰り返し`);
  let lastSave = 0;
  audio.addEventListener('timeupdate', () => {
    if (b !== null && a !== null && audio.currentTime >= b) audio.currentTime = a;
    pos.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;
    if (audio.duration) seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    if (current && Date.now() - lastSave > 5000) {
      lastSave = Date.now();
      const id = current, p = audio.currentTime;
      ctx.hub.update((s) => void (s.tracks = s.tracks.map((t) => (t.id === id ? { ...t, pos: p } : t))));
    }
  });
  audio.addEventListener('play', () => fill(playBtn, icon('pause', 18)));
  audio.addEventListener('pause', () => fill(playBtn, icon('play', 18)));
  ctx.onLeave(() => {
    audio.pause();
    if (url) URL.revokeObjectURL(url);
  });
  const load = async (id: string) => {
    const blob = await ctx.hub.getAudio(id);
    if (!blob) return toast('音声が見つからない');
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(blob);
    current = id;
    a = b = null;
    paintAb();
    audio.src = url;
    const t = ctx.hub.get().tracks.find((x) => x.id === id);
    audio.addEventListener('loadedmetadata', () => (audio.currentTime = t?.pos ?? 0), { once: true });
    audio.playbackRate = rate;
    playBtn.disabled = false;
    list.querySelectorAll('.list-row').forEach((r) => r.classList.toggle('on', (r as HTMLElement).dataset.id === id));
  };
  let rate = 1;
  const list = h('div');
  const paintList = () =>
    fill(list, ...ctx.hub.get().tracks.map((t) =>
        h(
          'div',
          { class: 'list-row' + (t.id === current ? ' on' : ''), 'data-id': t.id, 'data-testid': 'track' },
          h('button', { class: 'list-main link-btn', onclick: () => void load(t.id) }, t.name),
          h(
            'button',
            {
              class: 'icon-btn',
              'aria-label': '消す',
              onclick: async () => {
                if (!(await confirmDialog('音声を消す', `「${t.name}」を消す？`, '消す', true))) return;
                await ctx.hub.deleteAudio(t.id);
                ctx.hub.update((s) => void (s.tracks = s.tracks.filter((x) => x.id !== t.id)));
                paintList();
              },
            },
            icon('trash', 16),
          ),
        ),
      ),
    );
  paintList();
  const add = async () => {
    const files = await pickFiles('audio/*', { multiple: true });
    for (const f of files) {
      const id = uid();
      await ctx.hub.putAudio(id, f);
      ctx.hub.update((s) => void s.tracks.push({ id, name: f.name.replace(/\.[^.]+$/, ''), added: Date.now() }));
    }
    paintList();
  };
  const skip = (d: number) => (audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + d)));
  return h(
    'div',
    null,
    card(
      null,
      h('div', { class: 'player' }, h('button', { class: 'btn', 'aria-label': '5秒戻る', onclick: () => skip(-5) }, icon('rewind', 18), '5'), playBtn, h('button', { class: 'btn', 'aria-label': '5秒進む', onclick: () => skip(5) }, '5', icon('forward', 18)), pos),
      seek,
      h(
        'div',
        { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-top:8px' },
        h(
          'div',
          { class: 'chips' },
          [0.75, 0.9, 1, 1.1, 1.25, 1.5].map((r) =>
            h(
              'button',
              {
                class: 'chip' + (r === 1 ? ' on' : ''),
                'data-testid': `rate-${r}`,
                onclick: (e: Event) => {
                  rate = r;
                  audio.playbackRate = r;
                  (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
                },
              },
              `×${r}`,
            ),
          ),
        ),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', 'data-testid': 'ab-a', onclick: () => ((a = audio.currentTime), (b = null), paintAb()) }, 'A'),
        h('button', { class: 'btn small', 'data-testid': 'ab-b', onclick: () => (a !== null && audio.currentTime > a ? ((b = audio.currentTime), (audio.currentTime = a), paintAb()) : toast('先にA（始まり）を押す')) }, 'B'),
        h('button', { class: 'btn small', onclick: () => ((a = b = null), paintAb()) }, '解除'),
      ),
      abEl,
    ),
    card(h('span', null, '音声', h('button', { class: 'link-btn', 'data-testid': 'track-add', onclick: () => void add() }, '＋ ファイルを追加')), list, h('p', { class: 'muted small' }, '共通テストのリスニングや教材の音声ファイル（mp3・m4a など）。速さを変えても声の高さは変わらない。A→B で区間を繰り返す。端末の中にだけ保存（バックアップには入らない）。')),
  );
}

// ---------- 質問リスト ----------

function questionsTool(ctx: ToolCtx): HTMLElement {
  const qs = [...ctx.hub.get().questions].sort((a, b) => Number(!!a.done) - Number(!!b.done) || b.at - a.at);
  const input = text('', () => {}, { placeholder: '先生に聞くこと（例: 2018 第3問の(2)、なぜ相加相乗？）', 'data-testid': 'q-new' });
  const add = () => {
    const t = input.value.trim();
    if (!t) return;
    ctx.hub.update((s) => void s.questions.push({ id: uid(), text: t, at: Date.now() }));
    ctx.refresh();
  };
  return h(
    'div',
    null,
    h('div', { class: 'row', style: 'gap:6px;margin-bottom:12px' }, input, h('button', { class: 'btn primary small', onclick: add }, icon('plus', 16))),
    qs.length
      ? card(
          `未解決 ${qs.filter((q) => !q.done).length}件`,
          qs.map((q) =>
            h(
              'div',
              { class: 'check-row' + (q.done ? ' done' : ''), 'data-testid': 'question' },
              h('input', { type: 'checkbox', checked: !!q.done, onchange: (e: Event) => (ctx.hub.update((s) => void (s.questions = s.questions.map((x) => (x.id === q.id ? { ...x, done: (e.target as HTMLInputElement).checked ? Date.now() : undefined } : x)))), ctx.refresh()) }),
              h('span', null, h('span', null, q.text), h('small', { class: 'muted' }, `${md(todayKey(q.at))}${q.where ? '・' + q.where : ''}`)),
              q.nb
                ? h(
                    'button',
                    {
                      class: 'btn small',
                      onclick: async () => {
                        // By the page's id: it may have moved since.
                        const nb = await ctx.app.repo.getNotebook(q.nb!);
                        if (!nb) return toast('ノートが見つからない');
                        const i = q.page ? nb.pages.indexOf(q.page) : -1;
                        ctx.app.go(`#/nb/${nb.id}${i >= 0 ? '/' + i : ''}`);
                      },
                    },
                    'ページへ',
                  )
                : null,
              h('button', { class: 'icon-btn', 'aria-label': '消す', onclick: () => (ctx.hub.update((s) => void (s.questions = s.questions.filter((x) => x.id !== q.id))), ctx.refresh()) }, icon('close', 14)),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'わからなかったことを溜めておき、先生や友達に聞く。ノートの ⋯ →「質問リストに入れる」でページごと入る。'),
  );
}

export const LEARN_TOOLS: Tool[] = [
  {
    id: 'mistakes',
    group: 'learn',
    title: 'ミス分析',
    blurb: 'まちがいノートに送るときにミスの種類を記録し、傾向を出す',
    icon: 'alert',
    summary: (ctx) => {
      const s = mistakeStats(ctx.hub.get().mistakes);
      return s.byKind[0] ? `30日で${s.total}件・最多は${s.byKind[0].label}` : null;
    },
    render: mistakesTool,
  },
  {
    id: 'cards',
    group: 'learn',
    title: '単語帳',
    blurb: '忘れかけた頃に出るカード。CSV・表計算から貼り付け',
    icon: 'brain',
    summary: (ctx) => {
      const s = ctx.hub.get();
      const n = s.decks.reduce((a, d) => a + studyQueue(s.cards, d.id).length, 0);
      return s.decks.length ? `今日 ${n}枚・全${s.cards.length}枚` : null;
    },
    render: cardsTool,
  },
  { id: 'reader', group: 'learn', title: '英文の読み上げ', blurb: '貼った英文を1文ずつ・速さを変えて読み上げ', icon: 'speaker', render: readerTool },
  {
    id: 'listen',
    group: 'learn',
    title: 'リスニング',
    blurb: '音声ファイルを速さ変更・5秒戻し・区間リピートで',
    icon: 'headphones',
    summary: (ctx) => (ctx.hub.get().tracks.length ? `${ctx.hub.get().tracks.length}本` : null),
    render: listenTool,
  },
  {
    id: 'questions',
    group: 'learn',
    title: '質問リスト',
    blurb: '先生に聞くことを溜める。ページから直接入れられる',
    icon: 'question',
    summary: (ctx) => {
      const n = ctx.hub.get().questions.filter((q) => !q.done).length;
      return n ? `未解決 ${n}件` : null;
    },
    render: questionsTool,
  },
];

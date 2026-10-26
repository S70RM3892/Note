import { native } from '../platform';
import { h } from '../ui/dom';
import { confirmDialog, modal, shareOrDownload, toast } from '../ui/dialogs';

/**
 * 診断ログ: script errors kept on the device (and, in the APK, next to the shell's crash
 * reports), so "it crashed / it went wrong" comes with a stack trace that can be sent along.
 */
const KEY = 'sumi.errors';
const SEEN = 'sumi.diagSeen';
const KEEP = 40;

interface Entry {
  at: number;
  kind: string;
  text: string;
}

function loadJs(): Entry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]') as Entry[];
  } catch {
    return [];
  }
}

let lastText = '';
let lastAt = 0;

export function recordError(kind: string, text: string) {
  const now = Date.now();
  // The same error every frame is one entry, not a flood.
  if (text === lastText && now - lastAt < 10_000) return;
  lastText = text;
  lastAt = now;
  try {
    const list = loadJs();
    list.push({ at: now, kind, text: text.slice(0, 4000) });
    localStorage.setItem(KEY, JSON.stringify(list.slice(-KEEP)));
  } catch {
    /* storage unavailable */
  }
  try {
    native?.noteDiagnostic?.(`js-${kind}`, text.slice(0, 4000));
  } catch {
    /* the shell may not have it */
  }
}

export function installErrorLog() {
  window.addEventListener('error', (e) => {
    recordError('error', `${e.message}\n${e.filename}:${e.lineno}:${e.colno}\n${(e.error as Error | undefined)?.stack ?? ''}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as Error | undefined;
    recordError('rejection', String(r?.stack ?? r));
  });
}

function nativeEntries(): Entry[] {
  try {
    return (JSON.parse(native?.diagnostics?.() || '[]') as Entry[]).filter((x) => !x.kind.startsWith('js-'));
  } catch {
    return [];
  }
}

function stamp(t: number) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function diagnosticsText(): string {
  const all = [...nativeEntries(), ...loadJs()].sort((a, b) => a.at - b.at);
  const head = [
    `Sumi Note 診断ログ ${stamp(Date.now())}`,
    `UA: ${navigator.userAgent}`,
    `画面: ${screen.width}×${screen.height} @${window.devicePixelRatio}`,
    native ? `APK: ${native.version()}` : 'ブラウザ版',
    '',
  ];
  if (!all.length) return head.join('\n') + '記録なし（落ちたりエラーが起きたりしていない）';
  return head.join('\n') + all.map((e) => `── ${stamp(e.at)} [${e.kind}]\n${e.text}`).join('\n\n');
}

export function openDiagnostics() {
  const text = diagnosticsText();
  const area = h('textarea', { class: 'input diag-text', readOnly: true, rows: 16, 'data-testid': 'diag-text' }) as HTMLTextAreaElement;
  area.value = text;
  const copy = h(
    'button',
    {
      class: 'btn',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast('コピーした');
        } catch {
          area.select();
          toast('全体を選択した。コピーして送って');
        }
      },
    },
    'コピー',
  );
  const share = h('button', { class: 'btn', onclick: () => void shareOrDownload(new Blob([text], { type: 'text/plain' }), `sumi-diagnostics-${Date.now()}.txt`) }, '共有');
  const clear = h(
    'button',
    {
      class: 'btn danger',
      onclick: async () => {
        if (!(await confirmDialog('診断ログを消す', '記録を全部消す。', '消す', true))) return;
        try {
          localStorage.removeItem(KEY);
        } catch {
          /* ignore */
        }
        native?.clearDiagnostics?.();
        m.close();
        toast('消した');
      },
    },
    '消去',
  );
  const m = modal(
    '診断ログ',
    h('div', null, h('p', { class: 'muted', style: 'margin:0 0 8px;font-size:13px' }, '落ちたとき・エラーが起きたときの記録。不具合を伝えるときはこれをそのまま送れ（ノートの中身は入っていない）。'), area),
    { wide: true, actions: [clear, share, copy] },
  );
}

/** After a crash (or the page engine dying): say so once and offer the log. */
export async function noticeCrashes() {
  if (!native?.diagnostics) return;
  let seen = 0;
  try {
    seen = Number(localStorage.getItem(SEEN)) || 0;
  } catch {
    /* ignore */
  }
  const fresh = nativeEntries().filter((e) => e.at > seen && (e.kind === 'crash' || e.kind === 'renderer'));
  const newest = Math.max(seen, ...nativeEntries().map((e) => e.at));
  try {
    localStorage.setItem(SEEN, String(newest));
  } catch {
    /* ignore */
  }
  if (!fresh.length) return;
  const crash = fresh.some((e) => e.kind === 'crash');
  if (await confirmDialog(crash ? '前回アプリが落ちた' : '表示エンジンが落ちて読み込み直した', 'ノートは自動保存されている。原因の記録（診断ログ）を見る？ 送ってもらえれば直せる。', '見る')) openDiagnostics();
}

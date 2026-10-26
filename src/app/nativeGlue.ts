import type { Editor } from '../editor/editor';
import { native, nativeIncoming, setNativeCallbacks, type SumiNativeBridge } from '../platform';
import { toast } from '../ui/dialogs';
import type { App } from './app';
import { importSharedFiles } from './share';
import { buildReminders } from '../study/reminders';

/** Close the topmost popover/menu or modal, as the Escape key or a tap outside would. */
function closeTopLayer(): boolean {
  const layers = document.querySelectorAll<HTMLElement>('.popover-layer, .modal-backdrop');
  const top = layers[layers.length - 1];
  if (!top) return false;
  if (top.classList.contains('popover-layer')) {
    top.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    return true;
  }
  top.querySelector<HTMLButtonElement>('.modal-head .icon-btn')?.click();
  return true;
}

/** Hooks for the Android shell: back gesture, S Pen side button, files opened with the app. */
export function installNativeGlue(app: App) {
  const bridge = native;
  if (!bridge) return;
  let importing = false;
  const takeIncoming = async () => {
    if (importing) return;
    importing = true;
    try {
      const files = await nativeIncoming();
      if (!files.length) return;
      toast('取り込み中…', 4000);
      await app.flush();
      const nb = await importSharedFiles(app, files);
      if (nb) app.go(`#/nb/${nb}`);
    } catch (e) {
      console.error(e);
      toast('ファイルの取り込みに失敗: ' + (e as Error).message, 3000);
    } finally {
      importing = false;
    }
  };
  // Chromium swallows touches that start with the side button held; the shell rewrites them
  // (eraser → an eraser pointer, `buttons & 32`) and needs to know what the button is for.
  let penAction = '';
  const syncPenButton = () => {
    const a = app.settings.get().sideButton;
    if (a === penAction) return;
    penAction = a;
    bridge.setPenButtonAction?.(a);
  };
  syncPenButton();
  installReminders(app, bridge);
  app.settings.subscribe(syncPenButton);
  installWetInk(app, bridge);
  setNativeCallbacks({
    onPenButton: (down) => app.setPenButton(down),
    onBack: () => {
      if (closeTopLayer()) return true;
      if (!/^#?\/?$/.test(location.hash)) {
        app.go('#/');
        return true;
      }
      return false;
    },
    onIncoming: () => void takeIncoming(),
    onShortcut: () => void runShortcut(app, bridge),
  });
  void takeIncoming();
  void runShortcut(app, bridge);
}

/**
 * Low-latency wet ink: the shell draws pen strokes natively in a front-buffered overlay over the
 * writing area. It needs to know where that area is and how the pen draws; the editor's pen
 * tool claims / confirms / cancels each wet stroke (Editor.wet).
 */
/** Launcher shortcuts (long-press the app icon): 新しいノート / スキャン / 今日の復習. */
async function runShortcut(app: App, bridge: SumiNativeBridge) {
  const target = bridge.takeShortcut?.() ?? '';
  if (!target) return;
  if (target === 'review') return app.go('#/review');
  const testid = target === 'scan' ? 'lib-scan' : 'new-notebook';
  if (!/^#?\/?$/.test(location.hash)) app.go('#/');
  // The library builds its header synchronously once routed; give the route a moment.
  for (let i = 0; i < 40; i++) {
    const b = document.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
    if (b) return b.click();
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 就寝・復習のお知らせ: (re)schedule whenever the settings change or the app comes back to the library. */
function installReminders(app: App, bridge: SumiNativeBridge) {
  if (!bridge.setReminders) return;
  let sent = '';
  let timer = 0;
  const sync = async () => {
    const reviews = await app.repo.listReviews();
    const live = new Set((await app.repo.listNotebooks()).filter((n) => !n.trashed).map((n) => n.id));
    const specs = buildReminders(app.settings.get(), (t) => reviews.filter((r) => r.state.due <= t && live.has(r.nb)).length);
    const json = JSON.stringify(specs);
    if (json === sent) return;
    sent = json;
    bridge.setReminders!(json);
  };
  const soon = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void sync().catch((e) => console.warn('reminders', e)), 400);
  };
  soon();
  // Only the settings the reminders are made of (the pen colour changes far more often).
  const relevant = () => {
    const x = app.settings.get();
    return JSON.stringify([x.notifyBedtime, x.notifyReview, x.reviewTime, x.bedtime, x.exams]);
  };
  let seen = relevant();
  app.settings.subscribe(() => {
    const r = relevant();
    if (r === seen) return;
    seen = r;
    soon();
  });
  // Back from a review session or the editor: due counts may have changed.
  window.addEventListener('hashchange', soon);
}

function installWetInk(app: App, bridge: SumiNativeBridge) {
  if (!bridge.setWetInk || !bridge.wetClaim) return;
  app.withEditor((ed: Editor) => {
    ed.wet = {
      claim: () => !!bridge.wetClaim?.(),
      done: () => bridge.wetDone?.(),
      cancel: () => bridge.wetCancel?.(),
    };
    let last = '';
    const sync = () => {
      const s = app.settings.get();
      const r = ed.el.getBoundingClientRect();
      // Off when anything floats over the page (menus, dialogs) or the pen isn't the tool.
      const covered = !!document.querySelector('.modal-backdrop, .popover-layer, .sleep-lock');
      const on = s.wetInk && !!ed.doc && ed.el.isConnected && ed.tool === 'pen' && !ed.readOnly && !covered && r.width > 0 && r.height > 0;
      const json = JSON.stringify({
        on,
        rect: on ? [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 100) / 100) : [0, 0, 0, 0],
        dpr: window.devicePixelRatio || 1,
        zoom: ed.vp.zoom,
        color: s.pen.color,
        style: s.pen.style,
        width: s.pen.width,
        gamma: s.pressureGamma,
        stab: s.stabilization,
      });
      if (json === last) return;
      last = json;
      bridge.setWetInk!(json);
    };
    ed.subscribe(sync);
    app.settings.subscribe(sync);
    window.addEventListener('resize', sync);
    window.addEventListener('hashchange', () => setTimeout(sync, 0));
    new MutationObserver(sync).observe(document.body, { childList: true });
    sync();
  });
}

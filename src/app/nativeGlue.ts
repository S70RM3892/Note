import { native, nativeIncoming, setNativeCallbacks } from '../platform';
import { toast } from '../ui/dialogs';
import type { App } from './app';
import { importSharedFiles } from './share';

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
  if (!native) return;
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
  });
  void takeIncoming();
}

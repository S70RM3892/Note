/**
 * Native (Android APK) bridge. In the browser/PWA build `native` is undefined and every
 * helper falls back to web APIs.
 */

export interface SumiNativeBridge {
  version(): string;
  /** Google ML Kit document scanner available (edge detection + perspective correction). */
  hasScanner(): boolean;
  /** Start the scanner; the result arrives via window.__sumiNative.onScan(json). */
  scanDocument(pageLimit: number): void;
  /** Chunked file hand-off: begin → append base64 chunks → finish('save' | 'share'). */
  beginFile(name: string, mime: string): string;
  appendFile(id: string, base64: string): void;
  finishFile(id: string, action: string): void;
  openUrl(url: string): void;
  setKeepScreenOn(on: boolean): void;
  /** Files opened/shared into the app since the last call: JSON [{url, name, mime}]. */
  takeIncoming(): string;
  /** The launcher shortcut the app was opened with: 'new' | 'scan' | 'review' | '' (then cleared). */
  takeShortcut?(): string;
  /** What the S Pen side button does ('eraser' | 'lasso' | 'none'); the shell rewrites the pen's touches to match. */
  setPenButtonAction?(action: string): void;
  /** Name of the folder automatic backups go to ("" = none chosen). */
  backupFolder?(): string;
  /** Let the user pick that folder; result via onBackupFolder(json {ok, name}). */
  pickBackupFolder?(): void;
  /** 集中モード: pin the app to the screen (true) or release it. */
  setFocusLock?(on: boolean): void;
  /** Low-latency wet ink: where and how the pen draws (JSON {on, rect, dpr, zoom, color, style, width, gamma, stab}). */
  setWetInk?(json: string): void;
  /** The page's pen stroke started: true if the shell already shows it as wet ink. */
  wetClaim?(): boolean;
  /** The committed stroke is on screen: the shell erases its wet copy. */
  wetDone?(): void;
  /** The page dropped the stroke (no page under the pen, or it snapped to a shape). */
  wetCancel?(): void;
  /** Handwriting recognition (ML Kit Digital Ink, Japanese): 'ready' | 'missing' | 'downloading' | 'unsupported'. */
  inkStatus?(): string;
  /** Download the recognition model; result via onInkModel(json {ok, error?}). */
  inkDownload?(): void;
  /** Recognize one line: json {id, strokes: [[x,y,t,…],…], w, h, pre}; result via onInk(json {id, candidates?, error?}). */
  recognizeInk?(json: string): void;
  /** 就寝・復習のお知らせ: replace the daily notifications (JSON [{id, h, m, title, text, repeatText}]). */
  setReminders?(json: string): void;
  /** Notifications are allowed (Android 13+ asks; the user can also turn them off). */
  notificationsAllowed?(): boolean;
}

export interface IncomingFile {
  url: string;
  name: string;
  mime: string;
}

interface NativeCallbacks {
  onScan?: (json: string) => void;
  onFileDone?: (json: string) => void;
  onPenButton?: (down: boolean) => void;
  /** Android back gesture; return true when handled (otherwise the app goes to the background). */
  onBack?: () => boolean;
  /** New files are waiting in takeIncoming(). */
  onIncoming?: () => void;
  onInk?: (json: string) => void;
  onInkModel?: (json: string) => void;
  onBackupFolder?: (json: string) => void;
  /** A launcher shortcut was used while the app was running (read it with takeShortcut()). */
  onShortcut?: () => void;
  /** Answer to the notification permission prompt. */
  onNotifyPermission?: (granted: boolean) => void;
}

declare global {
  interface Window {
    SumiNative?: SumiNativeBridge;
    __sumiNative?: NativeCallbacks;
  }
}

export const native: SumiNativeBridge | undefined = typeof window !== 'undefined' ? window.SumiNative : undefined;

export function isNativeApp(): boolean {
  return !!native;
}

function callbacks(): NativeCallbacks {
  window.__sumiNative ??= {};
  return window.__sumiNative;
}

/** Scan pages with the native document scanner. Resolves with JPEG blobs ([] if cancelled). */
export function nativeScan(pageLimit = 1): Promise<Blob[]> {
  if (!native?.hasScanner()) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    callbacks().onScan = async (json: string) => {
      callbacks().onScan = undefined;
      try {
        const r = JSON.parse(json) as { urls?: string[]; error?: string };
        if (r.error) return reject(new Error(r.error));
        const blobs = await Promise.all((r.urls ?? []).map((u) => fetch(u).then((res) => res.blob())));
        resolve(blobs);
      } catch (e) {
        reject(e as Error);
      }
    };
    native.scanDocument(pageLimit);
  });
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Hand a file to Android: save dialog, share sheet, or the automatic-backup folder. */
export async function nativeFile(blob: Blob, name: string, action: 'save' | 'share' | 'backup'): Promise<boolean> {
  if (!native) return false;
  const id = native.beginFile(name, blob.type || 'application/octet-stream');
  const CHUNK = 768 * 1024; // multiple of 3 → clean base64 chunks
  for (let off = 0; off < blob.size; off += CHUNK) {
    const part = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
    native.appendFile(id, toBase64(part));
  }
  return new Promise((resolve) => {
    callbacks().onFileDone = (json: string) => {
      callbacks().onFileDone = undefined;
      try {
        resolve(!!(JSON.parse(json) as { ok: boolean }).ok);
      } catch {
        resolve(false);
      }
    };
    native.finishFile(id, action);
  });
}

export function setNativeCallbacks(cb: Pick<NativeCallbacks, 'onPenButton' | 'onBack' | 'onIncoming' | 'onNotifyPermission' | 'onShortcut'>) {
  Object.assign(callbacks(), cb);
}

/** Fetch the files Android handed us (served by the app's own asset loader) as File objects. */
export async function nativeIncoming(): Promise<File[]> {
  if (!native) return [];
  let list: IncomingFile[] = [];
  try {
    list = JSON.parse(native.takeIncoming() || '[]') as IncomingFile[];
  } catch {
    return [];
  }
  const out: File[] = [];
  for (const f of list) {
    try {
      const blob = await (await fetch(f.url)).blob();
      out.push(new File([blob], f.name, { type: f.mime || blob.type }));
    } catch (e) {
      console.error(e);
    }
  }
  return out;
}

export type InkStatus = 'ready' | 'missing' | 'downloading' | 'unsupported';

/** On-device handwriting recognition, available in the APK only. */
export const nativeInk = {
  available(): boolean {
    return !!native?.recognizeInk;
  },
  status(): InkStatus {
    const s = native?.inkStatus?.();
    return s === 'ready' || s === 'missing' || s === 'downloading' ? s : 'unsupported';
  },
  /** Download the model (≈20 MB, once). */
  download(): Promise<void> {
    const bridge = native;
    if (!bridge?.inkDownload) return Promise.reject(new Error('この環境では使えない'));
    return new Promise((resolve, reject) => {
      callbacks().onInkModel = (json: string) => {
        callbacks().onInkModel = undefined;
        const r = JSON.parse(json) as { ok: boolean; error?: string };
        if (r.ok) resolve();
        else reject(new Error(r.error || 'ダウンロードできなかった'));
      };
      bridge.inkDownload!();
    });
  },
  /** Candidates for one line of handwriting, best first. */
  recognize(strokes: number[][], w: number, h: number, pre = ''): Promise<string[]> {
    const bridge = native;
    if (!bridge?.recognizeInk) return Promise.reject(new Error('この環境では使えない'));
    const id = String(++inkSeq);
    return new Promise((resolve, reject) => {
      inkWaiting.set(id, { resolve, reject });
      const cb = callbacks();
      cb.onInk ??= (json: string) => {
        const r = JSON.parse(json) as { id: string; candidates?: string[]; error?: string };
        const p = inkWaiting.get(r.id);
        if (!p) return;
        inkWaiting.delete(r.id);
        if (r.error) p.reject(new Error(r.error));
        else p.resolve(r.candidates ?? []);
      };
      bridge.recognizeInk!(JSON.stringify({ id, strokes, w, h, pre: pre.slice(-20) }));
    });
  },
};

let inkSeq = 0;
const inkWaiting = new Map<string, { resolve: (c: string[]) => void; reject: (e: Error) => void }>();

/** Ask Android for the backup folder. Resolves with its name, or '' if cancelled. */
export function pickNativeBackupFolder(): Promise<string> {
  const bridge = native;
  if (!bridge?.pickBackupFolder) return Promise.resolve('');
  return new Promise((resolve) => {
    callbacks().onBackupFolder = (json: string) => {
      callbacks().onBackupFolder = undefined;
      const r = JSON.parse(json) as { ok: boolean; name?: string };
      resolve(r.ok ? r.name || 'フォルダ' : '');
    };
    bridge.pickBackupFolder!();
  });
}

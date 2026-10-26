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
}

interface NativeCallbacks {
  onScan?: (json: string) => void;
  onFileDone?: (json: string) => void;
  onPenButton?: (down: boolean) => void;
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

/** Hand a file to Android (save dialog or share sheet). */
export async function nativeFile(blob: Blob, name: string, action: 'save' | 'share'): Promise<boolean> {
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

export function onNativePenButton(fn: (down: boolean) => void) {
  callbacks().onPenButton = fn;
}

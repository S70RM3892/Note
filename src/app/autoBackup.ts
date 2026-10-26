import { native, nativeFile } from '../platform';
import { exportBackup } from '../store/backup';
import { toast } from '../ui/dialogs';
import type { App } from './app';

const DAY = 20 * 3600_000; // "once a day", with slack for irregular hours

export function backupFileName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `sumi-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.sumi`;
}

let running = false;

/**
 * APK: write a full backup into the chosen folder when the last one is a day old (or `force`).
 * The shell keeps the newest ten. Returns whether a backup was written.
 */
export async function maybeAutoBackup(app: App, force = false): Promise<boolean> {
  const s = app.settings.get();
  if (running || !native?.backupFolder || !s.autoBackup || !native.backupFolder()) return false;
  if (!force && Date.now() - s.lastAutoBackup < DAY) return false;
  running = true;
  try {
    await app.flush();
    const zip = await exportBackup(app.repo);
    const ok = await nativeFile(new Blob([zip as BlobPart], { type: 'application/zip' }), backupFileName(), 'backup');
    if (ok) {
      const now = Date.now();
      app.settings.update({ lastAutoBackup: now, lastBackup: now });
      if (force) toast('バックアップした');
    }
    return ok;
  } catch (e) {
    console.error(e);
    toast('自動バックアップに失敗: ' + (e as Error).message, 3000);
    return false;
  } finally {
    running = false;
  }
}

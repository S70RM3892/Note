import type { Folder, Notebook } from '../core/types';
import { dayKey } from '../store/repo';

export interface SubjectRow {
  name: string;
  color: string;
  sec: number;
}

/** Writing time per notebook and day: notebook id → YYYY-MM-DD → seconds. */
export type NotebookDays = Record<string, Record<string, number>>;

function recentKeys(n: number, now: number): string[] {
  const d = new Date(now);
  return Array.from({ length: n }, (_, i) => dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i).getTime()));
}

/**
 * Study time of the last `n` days by subject: a notebook counts towards its folder (数学, 英語 …),
 * a notebook outside folders by its own title. The biggest `top` rows, the rest as その他.
 */
export function subjectBreakdown(byNb: NotebookDays, notebooks: Notebook[], folders: Folder[], n = 7, now = Date.now(), top = 5): SubjectRow[] {
  const keys = recentKeys(n, now);
  const nbs = new Map(notebooks.map((x) => [x.id, x]));
  const fs = new Map(folders.map((x) => [x.id, x]));
  const rows = new Map<string, SubjectRow>();
  for (const [id, days] of Object.entries(byNb)) {
    const sec = keys.reduce((s, k) => s + (days[k] ?? 0), 0);
    if (sec <= 0) continue;
    const nb = nbs.get(id);
    const f = nb?.folder ? fs.get(nb.folder) : undefined;
    const key = f ? 'f:' + f.id : nb ? 'n:' + nb.id : 'other';
    const row = rows.get(key) ?? { name: f?.name ?? nb?.title ?? 'その他', color: f?.color ?? nb?.cover ?? '#9e9e9e', sec: 0 };
    row.sec += sec;
    rows.set(key, row);
  }
  const sorted = [...rows.values()].sort((a, b) => b.sec - a.sec);
  if (sorted.length <= top + 1) return sorted;
  const rest = sorted.slice(top).reduce((s, r) => s + r.sec, 0);
  return [...sorted.slice(0, top), { name: 'その他', color: '#9e9e9e', sec: rest }];
}

/** Keep the per-notebook log to the last `keep` days. */
export function pruneNotebookDays(byNb: NotebookDays, now = Date.now(), keep = 60): NotebookDays {
  const limit = dayKey(now - keep * 86400000);
  const out: NotebookDays = {};
  for (const [id, days] of Object.entries(byNb)) {
    const kept = Object.fromEntries(Object.entries(days).filter(([k]) => k >= limit));
    if (Object.keys(kept).length) out[id] = kept;
  }
  return out;
}

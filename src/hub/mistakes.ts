/** ミス分析: why each problem in まちがいノート went wrong, and which kind of mistake keeps coming back. */

export const MISTAKE_KINDS = [
  { id: 'calc', label: '計算ミス' },
  { id: 'careless', label: '写し間違い・ケアレス' },
  { id: 'read', label: '問題の読み違い' },
  { id: 'know', label: '知識・公式があやふや' },
  { id: 'plan', label: '方針が立たなかった' },
  { id: 'time', label: '時間が足りなかった' },
] as const;

export type MistakeKind = (typeof MISTAKE_KINDS)[number]['id'];

export interface MistakeEntry {
  id: string;
  at: number;
  kind: MistakeKind;
  subject: string;
  /** The まちがいノート page made for it. */
  nb?: string;
  page?: string;
}

export interface MistakeStats {
  total: number;
  byKind: { kind: MistakeKind; label: string; count: number; pct: number }[];
  bySubject: { subject: string; count: number; top: string | null }[];
}

/** Mistakes of the last `days` days (all when 0). */
export function mistakeStats(list: MistakeEntry[], now = Date.now(), days = 30): MistakeStats {
  const from = days ? now - days * 86_400_000 : -Infinity;
  const recent = list.filter((m) => m.at >= from);
  const total = recent.length;
  const byKind = MISTAKE_KINDS.map((k) => {
    const count = recent.filter((m) => m.kind === k.id).length;
    return { kind: k.id as MistakeKind, label: k.label, count, pct: total ? count / total : 0 };
  })
    .filter((k) => k.count)
    .sort((a, b) => b.count - a.count);
  const subjects = new Map<string, MistakeEntry[]>();
  for (const m of recent) subjects.set(m.subject, [...(subjects.get(m.subject) ?? []), m]);
  const bySubject = [...subjects.entries()]
    .map(([subject, ms]) => {
      const counts = new Map<string, number>();
      for (const m of ms) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
      const topKind = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      return { subject, count: ms.length, top: MISTAKE_KINDS.find((k) => k.id === topKind)?.label ?? null };
    })
    .sort((a, b) => b.count - a.count);
  return { total, byKind, bySubject };
}

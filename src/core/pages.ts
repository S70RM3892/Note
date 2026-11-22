/**
 * Page ranges as typed by hand: "3", "2-5", "1,4,8-10", "7-" (to the end), "-3" (from the start).
 * Full-width digits, 、 and 〜 are accepted. Returns 0-based page indexes in ascending order
 * without repeats, or null when the text isn't a range or names no existing page.
 */
export function parsePageRanges(text: string, total: number): number[] | null {
  const norm = text
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/(ページ|頁|p\.?|\s)/gi, '')
    .replace(/[、，;；]/g, ',')
    .replace(/[〜～~ー−–—]/g, '-');
  if (!norm) return null;
  const set = new Set<number>();
  for (const part of norm.split(',')) {
    if (!part) continue;
    const m = /^(\d*)(-?)(\d*)$/.exec(part);
    if (!m || (!m[1] && !m[3])) return null;
    let a = m[1] ? parseInt(m[1], 10) : 1;
    let b = m[2] ? (m[3] ? parseInt(m[3], 10) : total) : a;
    if (a > b) [a, b] = [b, a];
    if (a < 1) return null;
    for (let i = a; i <= Math.min(b, total); i++) set.add(i - 1);
  }
  return set.size ? [...set].sort((x, y) => x - y) : null;
}

/** "1-3, 5" for 0-based indexes (the inverse of parsePageRanges). */
export function formatPageRanges(indexes: number[]): string {
  const s = [...new Set(indexes)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i] + 1}` : `${s[i] + 1}-${s[j] + 1}`);
    i = j + 1;
  }
  return out.join(', ');
}

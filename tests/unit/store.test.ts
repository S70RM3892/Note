import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Repo, SNAPSHOT_EVERY, SNAPSHOT_KEEP, type StoredContent } from '../../src/store/repo';
import { exportBackup, importBackup, pageFromJSON, pageToJSON } from '../../src/store/backup';
import { isNight, sleepLocked } from '../../src/store/settings';
import { mkStroke } from './helpers';

let n = 0;
const fresh = () => Repo.open('test-' + n++ + '-' + Math.random());

describe('repo', () => {
  it('creates notebooks with pages and keeps order', async () => {
    const repo = await fresh();
    const { nb, pages } = await repo.createNotebook({ title: '数学', pages: 3 });
    expect(pages.length).toBe(3);
    const loaded = await repo.loadPages(nb);
    expect(loaded.map((p) => p.id)).toEqual(nb.pages);
    const list = await repo.listNotebooks();
    expect(list.map((x) => x.title)).toEqual(['数学']);
  });

  it('removes orphan pages on load', async () => {
    const repo = await fresh();
    const { nb, pages } = await repo.createNotebook({ title: 'x', pages: 2 });
    nb.pages = [pages[0].id];
    await repo.saveNotebook(nb);
    const loaded = await repo.loadPages(nb);
    expect(loaded.length).toBe(1);
    expect(await repo.getPage(pages[1].id)).toBeUndefined();
  });

  it('stores Float32 strokes and collects unused assets', async () => {
    const repo = await fresh();
    const { nb, pages } = await repo.createNotebook({ title: 'x' });
    const s = mkStroke([[1.5, 2.25, 0.3], [4, 5, 0.9]]);
    const a = await repo.putAsset(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'image');
    const b = await repo.putAsset(new Blob([new Uint8Array([4])], { type: 'image/png' }), 'image');
    pages[0].strokes.push(s);
    pages[0].items.push({ id: 'i', type: 'image', x: 0, y: 0, w: 10, h: 10, rot: 0, asset: a.id });
    await repo.savePages(pages, nb);
    const p = (await repo.getPage(pages[0].id))!;
    expect(p.strokes[0].pts).toBeInstanceOf(Float32Array);
    expect(Array.from(p.strokes[0].pts)).toEqual(Array.from(s.pts));
    await repo.collectAssets();
    expect(await repo.getAsset(a.id)).toBeDefined();
    expect(await repo.getAsset(b.id)).toBeUndefined();
  });

  it('backup round trip', async () => {
    const src = await fresh();
    const { nb, pages } = await src.createNotebook({ title: '英語', pages: 2 });
    pages[1].strokes.push(mkStroke([[10, 10, 0.5], [20, 20, 0.6]]));
    const a = await src.putAsset(new Blob([new Uint8Array([9, 8, 7])], { type: 'application/pdf' }), 'pdf', 'k.pdf');
    pages[0].pdf = { asset: a.id, index: 0 };
    await src.savePages(pages, nb);
    await src.saveReview({ id: pages[1].id, nb: nb.id, state: { due: 1, interval: 1, ease: 2.5, reps: 1, lapses: 0 } });
    const zip = await exportBackup(src);

    const dst = await fresh();
    const r = await importBackup(dst, zip, { restoreSettings: true });
    expect(r).toEqual({ notebooks: 1, pages: 2 });
    const nb2 = (await dst.getNotebook(nb.id))!;
    const p2 = await dst.loadPages(nb2);
    expect(p2[1].strokes[0].pts[3]).toBeCloseTo(20);
    const asset = (await dst.getAsset(a.id))!;
    expect(new Uint8Array(await asset.blob.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    expect((await dst.listReviews()).length).toBe(1);
  });

  it('page json keeps exact floats', () => {
    const s = mkStroke([[1 / 3, 2 / 7, 0.123]]);
    const p = { id: 'p', nb: 'n', w: 1, h: 1, bg: { tpl: 'blank' as const, spacing: 5, color: '#fff' }, strokes: [s], items: [], updated: 0 };
    expect(Array.from(pageFromJSON(pageToJSON(p)).strokes[0].pts)).toEqual(Array.from(s.pts));
  });
});

describe('night window', () => {
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);
  it('handles midnight crossing', () => {
    const s = { bedtime: '23:00', wakeTime: '06:00' };
    expect(isNight(s, at(23, 30))).toBe(true);
    expect(isNight(s, at(2))).toBe(true);
    expect(isNight(s, at(6))).toBe(false);
    expect(isNight(s, at(12))).toBe(false);
  });
});

describe('就寝ロック', () => {
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);
  it('locks from 15 minutes after bedtime until wake time, only when turned on', () => {
    const s = { bedtimeLock: true, bedtime: '23:00', wakeTime: '06:00' };
    expect(sleepLocked(s, at(22, 59))).toBe(false);
    expect(sleepLocked(s, at(23, 10))).toBe(false); // grace: wrap up
    expect(sleepLocked(s, at(23, 15))).toBe(true);
    expect(sleepLocked(s, at(3))).toBe(true);
    expect(sleepLocked(s, at(6))).toBe(false);
    expect(sleepLocked({ ...s, bedtimeLock: false }, at(1))).toBe(false);
    // Bedtime after midnight.
    expect(sleepLocked({ ...s, bedtime: '00:30' }, at(0, 50))).toBe(true);
    expect(sleepLocked({ ...s, bedtime: '00:30' }, at(23, 50))).toBe(false);
  });
});

describe('ページの履歴', () => {
  it('keeps the state before each editing session (at most every 10 minutes), newest 30', async () => {
    const repo = await fresh();
    const { nb, pages } = await repo.createNotebook({ title: 'x' });
    const p = pages[0];
    const t0 = 1_800_000_000_000;
    // What the editor keeps: the content as last written (no read-back from the database).
    const stored = new Map<string, StoredContent>();
    const save = async (at: number) => {
      const written = { strokes: p.strokes, items: p.items, updated: p.updated };
      await repo.savePages([p], nb, at, stored);
      stored.set(p.id, written);
    };
    // An empty page has nothing worth keeping.
    p.strokes = [mkStroke([[1, 1, 0.5], [2, 2, 0.5]])];
    p.updated = t0;
    await save(t0);
    expect(await repo.listVersions(p.id)).toHaveLength(0);
    // Next session: the one-stroke state is kept before it is overwritten.
    p.strokes = [...p.strokes, mkStroke([[3, 3, 0.5], [4, 4, 0.5]])];
    p.updated = t0 + SNAPSHOT_EVERY;
    await save(t0 + SNAPSHOT_EVERY);
    let v = await repo.listVersions(p.id);
    expect(v.map((x) => [x.strokes.length, x.at])).toEqual([[1, t0]]);
    // Saves within 10 minutes don't add versions…
    p.strokes = [...p.strokes, mkStroke([[7, 7, 0.5], [8, 8, 0.5]])];
    p.updated = t0 + SNAPSHOT_EVERY + 30_000;
    await save(t0 + SNAPSHOT_EVERY + 30_000);
    expect(await repo.listVersions(p.id)).toHaveLength(1);
    // …unless the save loses most of the page: clearing it keeps the 3 strokes just before.
    p.strokes = [];
    await save(t0 + SNAPSHOT_EVERY + 60_000);
    v = await repo.listVersions(p.id);
    expect(v.map((x) => x.strokes.length)).toEqual([3, 1]);
    // An empty stored page has nothing to keep.
    p.strokes = [mkStroke([[5, 5, 0.5], [6, 6, 0.5]])];
    p.updated = t0 + 3 * SNAPSHOT_EVERY;
    await save(t0 + 3 * SNAPSHOT_EVERY);
    expect(await repo.listVersions(p.id)).toHaveLength(2);
    // Many sessions: only the newest SNAPSHOT_KEEP stay; a fresh Repo finds the last snapshot time.
    for (let i = 4; i < 4 + SNAPSHOT_KEEP + 5; i++) {
      p.strokes = [mkStroke([[i, i, 0.5], [i + 1, i + 1, 0.5]])];
      p.updated = t0 + i * SNAPSHOT_EVERY;
      await save(t0 + i * SNAPSHOT_EVERY);
    }
    v = await repo.listVersions(p.id);
    expect(v).toHaveLength(SNAPSHOT_KEEP);
    expect(v[0].at).toBeGreaterThan(v[1].at);
    // Deleting the notebook drops its history.
    await repo.deleteNotebook(nb.id);
    expect(await repo.listVersions(p.id)).toHaveLength(0);
  });
});

describe('ページをほかのノートへ', () => {
  it('copies pages to the end of another notebook with new ids, without the bookmark', async () => {
    const repo = await fresh();
    const a = await repo.createNotebook({ title: 'A', pages: 2 });
    const b = await repo.createNotebook({ title: 'B', pages: 1 });
    const src = a.pages[1];
    src.strokes = [mkStroke([[1, 1, 0.5], [2, 2, 0.5]])];
    src.mark = '漸化式';
    const target = await repo.copyPagesTo(b.nb.id, [src]);
    expect(target!.pages).toHaveLength(2);
    const loaded = await repo.loadPages(target!);
    expect(loaded[1].id).not.toBe(src.id);
    expect(loaded[1].nb).toBe(b.nb.id);
    expect(loaded[1].strokes).toHaveLength(1);
    expect(loaded[1].mark).toBeUndefined();
    expect(await repo.copyPagesTo('nope', [src])).toBeNull();
  });
});

describe('ライナー', () => {
  it('the pen is a uniform-width liner, also for settings and favourites saved before', async () => {
    const { mergeSettings } = await import('../../src/store/settings');
    const s = mergeSettings({ pen: { style: 'fountain', color: '#123456', width: 3 }, penFavorites: [{ style: 'pencil', color: '#ff0000', width: 1.2 }] });
    expect(s.pen).toEqual({ style: 'marker', color: '#123456', width: 3 });
    expect(s.penFavorites.map((f) => f.style)).toEqual(['marker']);
    const { radiusFor } = await import('../../src/core/ink');
    expect(radiusFor('pen', 'marker', 2, 0.05)).toBe(radiusFor('pen', 'marker', 2, 1));
  });
});

describe('しおり一覧', () => {
  it('is built from the pages once, follows setBookmark, and stays whole after a restore or a copied notebook', async () => {
    const src = await fresh();
    const { nb, pages } = await src.createNotebook({ title: '数学', pages: 2 });
    pages[1].mark = '漸化式';
    await src.savePages(pages, nb);
    expect((await src.listBookmarks()).map((b) => b.label)).toEqual(['漸化式']);
    await src.setBookmark(nb.id, pages[0].id, '', 5);
    await src.setBookmark(nb.id, pages[1].id, '特性方程式', 6);
    expect((await src.listBookmarks()).map((b) => b.label).sort()).toEqual(['', '特性方程式']);
    await src.setBookmark(nb.id, pages[0].id, undefined);
    expect(await src.listBookmarks()).toHaveLength(1);

    // A notebook copied whole keeps its しおり, and so does the list.
    const copy = await src.duplicateNotebook(nb);
    expect((await src.listBookmarks()).filter((b) => b.nb === copy.id).map((b) => b.label)).toEqual(['漸化式']);

    // Restoring a backup into an app whose list already exists (the library was opened first).
    const zip = await exportBackup(src);
    const dst = await fresh();
    expect(await dst.listBookmarks()).toEqual([]);
    await importBackup(dst, zip);
    expect((await dst.listBookmarks()).map((b) => b.page).sort()).toEqual([pages[1].id, (await dst.getNotebook(copy.id))!.pages[1]].sort());
  });
});

describe('受験ハブ in backups', () => {
  it('a backup carries the hub data; restoring adds it to what the device already has', async () => {
    const src = await fresh();
    await src.createNotebook({ title: 'x' });
    await src.kvSet('hub', { mocks: [{ id: 'm1', name: '第1回', date: '2026-06-01', kind: 'other', subjects: [] }], sleep: [{ day: '2026-10-25', bed: 1, wake: 2 }] });
    const zip = await exportBackup(src);
    const dst = await fresh();
    await dst.kvSet('hub', { mocks: [{ id: 'm2', name: '手元', date: '2026-10-01', kind: 'other', subjects: [] }] });
    await importBackup(dst, zip);
    const hub = await dst.kvGet<{ mocks: { id: string }[]; sleep: unknown[] }>('hub');
    expect(hub!.mocks.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(hub!.sleep).toHaveLength(1);
  });
});

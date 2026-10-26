import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Repo, SNAPSHOT_EVERY, SNAPSHOT_KEEP } from '../../src/store/repo';
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
    // An empty page has nothing worth keeping.
    p.strokes = [mkStroke([[1, 1, 0.5], [2, 2, 0.5]])];
    p.updated = t0;
    await repo.savePages([p], nb, t0);
    expect(await repo.listVersions(p.id)).toHaveLength(0);
    // Next session: the one-stroke state is kept before it is overwritten.
    p.strokes = [...p.strokes, mkStroke([[3, 3, 0.5], [4, 4, 0.5]])];
    p.updated = t0 + SNAPSHOT_EVERY;
    await repo.savePages([p], nb, t0 + SNAPSHOT_EVERY);
    let v = await repo.listVersions(p.id);
    expect(v.map((x) => [x.strokes.length, x.at])).toEqual([[1, t0]]);
    // Saves within 10 minutes don't add versions…
    p.strokes = [...p.strokes, mkStroke([[7, 7, 0.5], [8, 8, 0.5]])];
    p.updated = t0 + SNAPSHOT_EVERY + 30_000;
    await repo.savePages([p], nb, t0 + SNAPSHOT_EVERY + 30_000);
    expect(await repo.listVersions(p.id)).toHaveLength(1);
    // …unless the save loses most of the page: clearing it keeps the 3 strokes just before.
    p.strokes = [];
    await repo.savePages([p], nb, t0 + SNAPSHOT_EVERY + 60_000);
    v = await repo.listVersions(p.id);
    expect(v.map((x) => x.strokes.length)).toEqual([3, 1]);
    // An empty stored page has nothing to keep.
    p.strokes = [mkStroke([[5, 5, 0.5], [6, 6, 0.5]])];
    p.updated = t0 + 3 * SNAPSHOT_EVERY;
    await repo.savePages([p], nb, t0 + 3 * SNAPSHOT_EVERY);
    expect(await repo.listVersions(p.id)).toHaveLength(2);
    // Many sessions: only the newest SNAPSHOT_KEEP stay; a fresh Repo finds the last snapshot time.
    const again = repo;
    for (let i = 4; i < 4 + SNAPSHOT_KEEP + 5; i++) {
      p.strokes = [mkStroke([[i, i, 0.5], [i + 1, i + 1, 0.5]])];
      p.updated = t0 + i * SNAPSHOT_EVERY;
      await again.savePages([p], nb, t0 + i * SNAPSHOT_EVERY);
    }
    v = await repo.listVersions(p.id);
    expect(v).toHaveLength(SNAPSHOT_KEEP);
    expect(v[0].at).toBeGreaterThan(v[1].at);
    // Deleting the notebook drops its history.
    await repo.deleteNotebook(nb.id);
    expect(await repo.listVersions(p.id)).toHaveLength(0);
  });
});

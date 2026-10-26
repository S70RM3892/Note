import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Repo } from '../../src/store/repo';
import { exportBackup, importBackup, pageFromJSON, pageToJSON } from '../../src/store/backup';
import { isNight } from '../../src/store/settings';
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

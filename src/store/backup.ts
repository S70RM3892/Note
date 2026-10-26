import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { Asset, Folder, Notebook, Page, ReviewRecord, Stroke } from '../core/types';
import type { Repo } from './repo';

/**
 * Backup file (.sumi): a zip with
 *   manifest.json  – notebooks, folders, reviews, settings, asset metadata
 *   pages/<id>.json
 *   assets/<id>    – raw bytes
 */

const FORMAT = 'sumi-backup';
const VERSION = 1;

interface Manifest {
  format: string;
  version: number;
  exported: number;
  notebooks: Notebook[];
  folders: Folder[];
  reviews: ReviewRecord[];
  assets: { id: string; kind: Asset['kind']; mime: string; name?: string; outline?: Asset['outline'] }[];
  settings?: unknown;
  stats?: unknown;
}

function f32ToB64(a: Float32Array): string {
  const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToF32(b: string): Float32Array {
  const s = atob(b);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return new Float32Array(u8.buffer);
}

export function pageToJSON(p: Page): string {
  return JSON.stringify({ ...p, strokes: p.strokes.map((s) => ({ ...s, pts: f32ToB64(s.pts) })) });
}

export function pageFromJSON(json: string): Page {
  const raw = JSON.parse(json);
  raw.strokes = (raw.strokes as (Omit<Stroke, 'pts'> & { pts: string | number[] })[]).map((s) => ({
    ...s,
    pts: typeof s.pts === 'string' ? b64ToF32(s.pts) : new Float32Array(s.pts),
  }));
  return raw as Page;
}

async function blobBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

/** Build a backup of everything, or of the given notebooks only. */
export async function exportBackup(repo: Repo, notebookIds?: string[]): Promise<Uint8Array> {
  const all = await repo.db.getAll<Notebook>('notebooks');
  const notebooks = notebookIds ? all.filter((n) => notebookIds.includes(n.id)) : all;
  const files: Zippable = {};
  const assetIds = new Set<string>();
  const nbSet = new Set(notebooks.map((n) => n.id));
  for (const nb of notebooks) {
    const pages = await repo.db.getAllByIndex<Page>('pages', 'nb', nb.id);
    for (const p of pages) {
      if (!nb.pages.includes(p.id)) continue;
      files[`pages/${p.id}.json`] = strToU8(pageToJSON(p));
      if (p.pdf) assetIds.add(p.pdf.asset);
      for (const it of p.items) {
        if (it.type === 'image') assetIds.add(it.asset);
        else if (it.type === 'scan') {
          assetIds.add(it.vector);
          if (it.photo) assetIds.add(it.photo);
        }
      }
    }
  }
  const assets: Manifest['assets'] = [];
  for (const id of assetIds) {
    const a = await repo.getAsset(id);
    if (!a) continue;
    assets.push({ id: a.id, kind: a.kind, mime: a.mime, name: a.name, outline: a.outline });
    // Already-compressed formats are stored without deflate.
    files[`assets/${a.id}`] = [await blobBytes(a.blob), { level: 0 }];
  }
  const reviews = (await repo.listReviews()).filter((r) => nbSet.has(r.nb));
  const manifest: Manifest = {
    format: FORMAT,
    version: VERSION,
    exported: Date.now(),
    notebooks,
    folders: notebookIds ? [] : await repo.listFolders(),
    reviews,
    assets,
    settings: notebookIds ? undefined : await repo.kvGet('settings'),
    stats: notebookIds ? undefined : await repo.kvGet('stats'),
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  return zipSync(files, { level: 6 });
}

export interface ImportResult {
  notebooks: number;
  pages: number;
}

/** Restore a backup. Records with the same id are replaced. */
export async function importBackup(repo: Repo, data: Uint8Array, opts: { restoreSettings?: boolean } = {}): Promise<ImportResult> {
  const files = unzipSync(data);
  const mf = files['manifest.json'];
  if (!mf) throw new Error('バックアップファイルではありません');
  const manifest = JSON.parse(strFromU8(mf)) as Manifest;
  if (manifest.format !== FORMAT) throw new Error('バックアップ形式が不明です');
  if (manifest.version > VERSION) throw new Error('新しいバージョンのアプリで作られたバックアップです');

  let pageCount = 0;
  for (const a of manifest.assets) {
    const bytes = files[`assets/${a.id}`];
    if (!bytes) continue;
    const asset: Asset = { ...a, blob: new Blob([bytes as BlobPart], { type: a.mime }) };
    await repo.db.put('assets', asset);
  }
  for (const nb of manifest.notebooks) {
    const pages: Page[] = [];
    for (const pid of nb.pages) {
      const f = files[`pages/${pid}.json`];
      if (f) pages.push(pageFromJSON(strFromU8(f)));
    }
    nb.pages = pages.map((p) => p.id);
    pageCount += pages.length;
    await repo.db.write({ put: [['notebooks', nb], ...pages.map((p) => ['pages', p] as ['pages', Page])] });
  }
  if (manifest.folders.length) await repo.db.write({ put: manifest.folders.map((f) => ['folders', f] as ['folders', Folder]) });
  if (manifest.reviews.length) await repo.db.write({ put: manifest.reviews.map((r) => ['reviews', r] as ['reviews', ReviewRecord]) });
  if (opts.restoreSettings && manifest.settings) await repo.kvSet('settings', manifest.settings);
  if (opts.restoreSettings && manifest.stats) await repo.kvSet('stats', manifest.stats);
  return { notebooks: manifest.notebooks.length, pages: pageCount };
}

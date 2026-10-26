// Data model. Page coordinates are "page units": CSS px at 96dpi (A4 = 794 x 1123).

export type PenStyle = 'ballpoint' | 'fountain' | 'marker' | 'pencil';
export type StrokeKind = 'pen' | 'highlighter';

export interface Stroke {
  id: string;
  kind: StrokeKind;
  style: PenStyle;
  color: string; // #rrggbb
  width: number; // base diameter in page units
  /** Flat [x, y, pressure, x, y, pressure, ...]. Pressure already has the user's curve applied. */
  pts: Float32Array;
  /** Recognized shape: rendered as a constant-width polyline. */
  shape?: boolean;
  closed?: boolean;
  /** 固定: ignored by the lasso and the eraser until unlocked. */
  locked?: boolean;
}

export interface ItemBase {
  id: string;
  /** Top-left of the unrotated box. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rotation in radians around the box center. */
  rot: number;
  /** 固定: ignored by the lasso and the eraser until unlocked. */
  locked?: boolean;
}

export interface TapeItem extends ItemBase {
  type: 'tape';
  color: string;
  revealed?: boolean;
}

export interface TextItem extends ItemBase {
  type: 'text';
  text: string;
  size: number; // font size in page units
  color: string;
}

export interface ImageItem extends ItemBase {
  type: 'image';
  asset: string;
}

/** A photographed document traced into vector paths (crisp at any zoom). */
export interface ScanItem extends ItemBase {
  type: 'scan';
  /** Asset (kind 'vector') holding the VectorDoc JSON. */
  vector: string;
  /** Perspective-corrected photo the vectors were traced from. */
  photo?: string;
  /** Show the photo instead of the vectors. */
  showPhoto?: boolean;
}

export type Item = TapeItem | TextItem | ImageItem | ScanItem;

/** Traced vector artwork. Coordinates are scan pixels (0..w, 0..h). */
export interface VectorDoc {
  w: number;
  h: number;
  /** Tile size the paths are grouped by (for culling while zoomed in). */
  tile: number;
  /** Painted in order; each tile holds whole shapes (outline + holes) so nonzero filling works. */
  layers: { color: string; tiles: { b: [number, number, number, number]; d: string }[] }[];
}

export type TemplateId = 'blank' | 'ruled' | 'grid' | 'dots' | 'cornell' | 'split';

export interface PageBackground {
  tpl: TemplateId;
  /** Line spacing in mm. */
  spacing: number;
  /** Paper color. */
  color: string;
}

export interface ReviewState {
  due: number; // epoch ms (local midnight of the due day)
  interval: number; // days
  ease: number;
  reps: number;
  lapses: number;
  last?: number;
}

export interface Page {
  id: string;
  nb: string;
  w: number;
  h: number;
  bg: PageBackground;
  pdf?: { asset: string; index: number };
  /** Text extracted from the PDF page (for search). */
  text?: string;
  strokes: Stroke[];
  items: Item[];
  updated: number;
}

/** Review schedule of one page (kept outside the page so due pages can be listed cheaply). */
export interface ReviewRecord {
  id: string; // page id
  nb: string;
  state: ReviewState;
}

export type Layout = 'vertical' | 'horizontal';

export interface Notebook {
  id: string;
  title: string;
  folder: string | null;
  created: number;
  updated: number;
  opened: number;
  pages: string[];
  cover: string;
  thumb?: string;
  fav?: boolean;
  lastPage?: number;
  layout?: Layout;
  /** Defaults for newly added pages. */
  paper: { w: number; h: number; bg: PageBackground };
  trashed?: number;
}

export interface Folder {
  id: string;
  name: string;
  color: string;
  order: number;
}

export interface OutlineEntry {
  title: string;
  index: number; // 0-based PDF page index
  level: number;
}

export interface Asset {
  id: string;
  kind: 'pdf' | 'image' | 'vector';
  mime: string;
  name?: string;
  blob: Blob;
  /** PDF bookmarks (table of contents). */
  outline?: OutlineEntry[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

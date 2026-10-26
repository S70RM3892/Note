import type { PenStyle } from '../core/types';
import { DEFAULT_EXAMS, type ExamDate } from '../study/countdown';

export interface PenPreset {
  style: PenStyle;
  color: string;
  width: number;
}

export interface Settings {
  // Pen & input
  pen: PenPreset;
  /** お気に入りペン: saved pen type + colour + width, one tap away in the toolbar. */
  penFavorites: PenPreset[];
  highlighter: { color: string; width: number };
  penColors: string[];
  highlighterColors: string[];
  pressureGamma: number; // <1: lighter touch gives more width
  stabilization: number; // 0..0.9
  fingerDrawing: 'auto' | 'on' | 'off';
  sideButton: 'eraser' | 'lasso' | 'none';
  shapeHold: boolean;
  eraserMode: 'stroke' | 'partial';
  eraserSize: number; // screen px radius
  twoFingerUndo: boolean;
  tapeColor: string;
  tapeWidth: number;
  /** Lock a placed photo/scan when its selection is dismissed. */
  autoLockPlaced: boolean;
  // Display
  theme: 'system' | 'light' | 'dark';
  layout: 'vertical' | 'horizontal';
  // Study / life
  bedtimeEnabled: boolean;
  bedtime: string; // HH:MM
  wakeTime: string; // HH:MM
  nightFilter: boolean;
  backupReminderDays: number;
  lastBackup: number;
  /** Countdown targets shown in the library. */
  exams: ExamDate[];
  /** APK: read handwriting in the background so the search finds it. */
  handwritingIndex: boolean;
  /** APK: back everything up once a day into the chosen folder. */
  autoBackup: boolean;
  lastAutoBackup: number;
  /** APK: pin the app to the screen while the exam timer runs. */
  focusPin: boolean;
  /** APK: draw the stroke being written natively (front-buffered, lowest latency). */
  wetInk: boolean;
  // Notebook defaults
  defaultPaper: { size: string; tpl: string; spacing: number; color: string };
}

export const RED_SHEET_ORANGE = '#ff6a00';
export const MEMORY_GREEN = '#00c853';

export const DEFAULT_SETTINGS: Settings = {
  pen: { style: 'ballpoint', color: '#1a1a1a', width: 2.2 },
  penFavorites: [],
  highlighter: { color: '#fff176', width: 16 },
  penColors: ['#1a1a1a', '#1e4fd8', '#d32f2f', RED_SHEET_ORANGE, '#2e7d32', '#7b1fa2'],
  highlighterColors: ['#fff176', '#f8bbd0', '#b3e5fc', '#c5e1a5', '#ffcc80', MEMORY_GREEN],
  pressureGamma: 0.8,
  stabilization: 0.25,
  fingerDrawing: 'off',
  sideButton: 'eraser',
  shapeHold: true,
  eraserMode: 'partial',
  eraserSize: 12,
  twoFingerUndo: true,
  tapeColor: '#ff9800',
  tapeWidth: 26,
  autoLockPlaced: true,
  theme: 'system',
  layout: 'vertical',
  bedtimeEnabled: true,
  bedtime: '23:00',
  wakeTime: '06:00',
  nightFilter: true,
  backupReminderDays: 7,
  lastBackup: 0,
  exams: DEFAULT_EXAMS,
  handwritingIndex: true,
  autoBackup: false,
  lastAutoBackup: 0,
  focusPin: false,
  wetInk: true,
  defaultPaper: { size: 'a4', tpl: 'grid', spacing: 5, color: '#ffffff' },
};

type Listener = (s: Settings) => void;

export class SettingsStore {
  private value: Settings;
  private listeners = new Set<Listener>();

  constructor(initial: Partial<Settings> | undefined, private persist: (s: Settings) => void) {
    this.value = mergeSettings(initial);
  }

  get(): Settings {
    return this.value;
  }

  update(patch: Partial<Settings>) {
    this.value = { ...this.value, ...patch };
    this.persist(this.value);
    this.listeners.forEach((l) => l(this.value));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export function mergeSettings(initial: Partial<Settings> | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(initial ?? {}) };
  s.pen = { ...DEFAULT_SETTINGS.pen, ...(initial?.pen ?? {}) };
  s.highlighter = { ...DEFAULT_SETTINGS.highlighter, ...(initial?.highlighter ?? {}) };
  s.defaultPaper = { ...DEFAULT_SETTINGS.defaultPaper, ...(initial?.defaultPaper ?? {}) };
  return s;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => parseInt(v, 10));
  return (h || 0) * 60 + (m || 0);
}

/** Is `now` inside the night window [bedtime, wakeTime)? Handles windows across midnight. */
export function isNight(s: Pick<Settings, 'bedtime' | 'wakeTime'>, now: Date): boolean {
  const t = now.getHours() * 60 + now.getMinutes();
  const b = minutes(s.bedtime), w = minutes(s.wakeTime);
  if (b === w) return false;
  return b < w ? t >= b && t < w : t >= b || t < w;
}

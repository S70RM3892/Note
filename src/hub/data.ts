/** Everything the 受験ハブ keeps, in one kv record ('hub'); audio files sit next to it as 'hub.audio.<id>'. */
import type { Repo } from '../store/repo';
import type { Card, Deck } from './cards';
import type { CheckItem, KyotsuId, NijiId } from './exam';
import type { CaffeineEntry, SleepEntry } from './health';
import type { MistakeEntry } from './mistakes';
import { defaultPastGrid, type Book, type MockExam, type PastGrid, type Question, type Reflection } from './plan';

export interface Track {
  id: string;
  name: string;
  /** Where playback stopped (s). */
  pos?: number;
  added: number;
}

export interface HubPrefs {
  /** 目の休憩: nudge after an hour of writing without a break. */
  eyeBreaks: boolean;
  /** APK: おやすみモード while the exam timer runs. */
  dnd: boolean;
  /** 読み上げの速さ (1 = normal). */
  ttsRate: number;
  napMin: number;
  /** Morning question about last night's sleep. */
  askSleep: boolean;
}

export interface HubState {
  score: { kyotsu: Partial<Record<KyotsuId, number>>; niji: Partial<Record<NijiId, number>> };
  mocks: MockExam[];
  books: Book[];
  past: PastGrid;
  reflections: Record<string, Reflection>;
  questions: Question[];
  mistakes: MistakeEntry[];
  decks: Deck[];
  cards: Card[];
  /** Cards studied per day. */
  cardLog: Record<string, number>;
  sleep: SleepEntry[];
  /** The morning the sleep question was answered or dismissed. */
  sleepAsked?: string;
  caffeine: CaffeineEntry[];
  checks: Record<string, boolean>;
  customChecks: { kyotsu: CheckItem[]; niji: CheckItem[] };
  tracks: Track[];
  prefs: HubPrefs;
}

export function emptyHub(): HubState {
  return {
    score: { kyotsu: {}, niji: {} },
    mocks: [],
    books: [],
    past: defaultPastGrid(),
    reflections: {},
    questions: [],
    mistakes: [],
    decks: [],
    cards: [],
    cardLog: {},
    sleep: [],
    caffeine: [],
    checks: {},
    customChecks: { kyotsu: [], niji: [] },
    tracks: [],
    prefs: { eyeBreaks: true, dnd: false, ttsRate: 1, napMin: 15, askSleep: true },
  };
}

/** Fill in whatever an older (or partial) record lacks. */
export function normalizeHub(raw: unknown): HubState {
  const base = emptyHub();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<HubState>;
  return {
    ...base,
    ...r,
    score: { kyotsu: { ...r.score?.kyotsu }, niji: { ...r.score?.niji } },
    past: r.past?.subjects && r.past.years && r.past.cells ? r.past : base.past,
    customChecks: { kyotsu: r.customChecks?.kyotsu ?? [], niji: r.customChecks?.niji ?? [] },
    prefs: { ...base.prefs, ...r.prefs },
  };
}

function unionBy<T>(local: T[], incoming: T[], key: (x: T) => string): T[] {
  const have = new Set(local.map(key));
  return [...local, ...incoming.filter((x) => !have.has(key(x)))];
}

/** Restoring a backup: add what this device lacks, never overwrite what it has. */
export function mergeHub(localRaw: unknown, incomingRaw: unknown): HubState {
  const a = normalizeHub(localRaw);
  const b = normalizeHub(incomingRaw);
  const id = (x: { id: string }) => x.id;
  return {
    ...a,
    score: { kyotsu: { ...b.score.kyotsu, ...a.score.kyotsu }, niji: { ...b.score.niji, ...a.score.niji } },
    mocks: unionBy(a.mocks, b.mocks, id),
    books: unionBy(a.books, b.books, id),
    past: {
      subjects: unionBy(a.past.subjects, b.past.subjects, id),
      years: [...new Set([...a.past.years, ...b.past.years])].sort((x, y) => y - x),
      cells: { ...b.past.cells, ...a.past.cells },
    },
    reflections: { ...b.reflections, ...a.reflections },
    questions: unionBy(a.questions, b.questions, id),
    mistakes: unionBy(a.mistakes, b.mistakes, id),
    decks: unionBy(a.decks, b.decks, id),
    cards: unionBy(a.cards, b.cards, id),
    cardLog: { ...b.cardLog, ...a.cardLog },
    sleep: unionBy(a.sleep, b.sleep, (s) => s.day).sort((x, y) => (x.day < y.day ? -1 : 1)),
    caffeine: unionBy(a.caffeine, b.caffeine, (c) => String(c.at)),
    checks: { ...b.checks, ...a.checks },
    customChecks: { kyotsu: unionBy(a.customChecks.kyotsu, b.customChecks.kyotsu, id), niji: unionBy(a.customChecks.niji, b.customChecks.niji, id) },
    tracks: a.tracks, // audio isn't in backups
  };
}

/** The 受験ハブ's state, saved shortly after each change. */
export class HubStore {
  private state: HubState = emptyHub();
  private timer = 0;
  private listeners = new Set<() => void>();
  readonly ready: Promise<void>;

  constructor(private repo: Repo) {
    this.ready = this.reload();
  }

  async reload() {
    this.state = normalizeHub(await this.repo.kvGet('hub'));
    this.listeners.forEach((l) => l());
  }

  get(): HubState {
    return this.state;
  }

  /** Change the state (mutate the draft or return a new one). */
  update(fn: (s: HubState) => HubState | void) {
    this.state = fn(this.state) ?? this.state;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 400);
    this.listeners.forEach((l) => l());
  }

  async flush() {
    clearTimeout(this.timer);
    await this.repo.kvSet('hub', this.state);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Audio for the listening player (kept out of the JSON record).
  async putAudio(id: string, blob: Blob) {
    await this.repo.kvSet(`hub.audio.${id}`, blob);
  }

  getAudio(id: string): Promise<Blob | undefined> {
    return this.repo.kvGet<Blob>(`hub.audio.${id}`);
  }

  async deleteAudio(id: string) {
    await this.repo.db.delete('kv', `hub.audio.${id}`);
  }
}

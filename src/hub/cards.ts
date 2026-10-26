/** 単語帳: flashcards on the same spaced-repetition schedule as the review pages. */
import { grade, newReview, type Grade } from '../core/srs';
import type { ReviewState } from '../core/types';
import { dayKey } from '../store/repo';

export interface Deck {
  id: string;
  name: string;
  created: number;
}

export interface Card {
  id: string;
  deck: string;
  front: string;
  back: string;
  added: number;
  /** Undefined until first studied. */
  state?: ReviewState;
  /** The day it was first studied (new cards per day are limited). */
  firstDay?: string;
}

export const NEW_PER_DAY = 20;

/** Lines of "表<TAB>裏", "表,裏" (CSV, quotes allowed) or "表：裏". */
export function parseCards(text: string): { front: string; back: string }[] {
  const out: { front: string; back: string }[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/^﻿/, '').trim();
    if (!line) continue;
    let parts: string[];
    if (line.includes('\t')) parts = line.split('\t');
    else if (line.includes(',') || line.startsWith('"')) parts = csvRow(line);
    else if (line.includes('：')) parts = line.split('：');
    else continue;
    const [front, ...rest] = parts.map((p) => p.trim());
    const back = rest.join(' / ').trim();
    if (front && back) out.push({ front, back });
  }
  return out;
}

function csvRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      cells.push(cur);
      cur = '';
    } else cur += c;
  }
  cells.push(cur);
  return cells;
}

export function cardsCsv(cards: Card[]): string {
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return '﻿' + cards.map((c) => `${cell(c.front)},${cell(c.back)}`).join('\n') + '\n';
}

/** Today's study queue for a deck: due reviews first (most overdue first), then new cards up to the daily limit. */
export function studyQueue(cards: Card[], deck: string, now = Date.now(), newPerDay = NEW_PER_DAY): Card[] {
  const today = dayKey(now);
  const mine = cards.filter((c) => c.deck === deck);
  const due = mine.filter((c) => c.state && c.state.due <= now).sort((a, b) => a.state!.due - b.state!.due);
  const newToday = mine.filter((c) => c.firstDay === today).length;
  const fresh = mine.filter((c) => !c.state).sort((a, b) => a.added - b.added).slice(0, Math.max(0, newPerDay - newToday));
  return [...due, ...fresh];
}

export function gradeCard(c: Card, g: Grade, now = Date.now()): Card {
  return { ...c, state: grade(c.state ?? newReview(now), g, now), firstDay: c.firstDay ?? dayKey(now) };
}

export function deckCounts(cards: Card[], deck: string, now = Date.now()) {
  const mine = cards.filter((c) => c.deck === deck);
  return {
    total: mine.length,
    due: mine.filter((c) => c.state && c.state.due <= now).length,
    fresh: mine.filter((c) => !c.state).length,
    /** Seen at least twice in a row without forgetting. */
    learned: mine.filter((c) => c.state && c.state.reps >= 2).length,
  };
}

/** English (or mostly Latin letters): read aloud in English. */
export function looksEnglish(s: string): boolean {
  const letters = s.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (!letters) return false;
  const latin = letters.replace(/[^A-Za-z]/g, '').length;
  return latin / letters.length > 0.6;
}

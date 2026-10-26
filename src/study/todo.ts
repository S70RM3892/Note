import { uid } from '../core/id';
import { dayKey } from '../store/repo';

export interface Todo {
  id: string;
  text: string;
  /** Day (YYYY-MM-DD) it was finished on; undefined while open. */
  doneOn?: string;
  created: number;
}

/** Open items (whenever they were added — they roll over) and the ones finished today. */
export function visibleTodos(list: Todo[], now = Date.now()): Todo[] {
  const today = dayKey(now);
  return list.filter((t) => !t.doneOn || t.doneOn === today).sort((a, b) => Number(!!a.doneOn) - Number(!!b.doneOn) || a.created - b.created);
}

export function addTodo(list: Todo[], text: string, now = Date.now()): Todo[] {
  const t = text.trim();
  return t ? [...list, { id: uid(), text: t.slice(0, 200), created: now }] : list;
}

export function toggleTodo(list: Todo[], id: string, now = Date.now()): Todo[] {
  return list.map((t) => (t.id === id ? { ...t, doneOn: t.doneOn ? undefined : dayKey(now) } : t));
}

export function removeTodo(list: Todo[], id: string): Todo[] {
  return list.filter((t) => t.id !== id);
}

/** Finished items are kept 30 days (a record of what got done), then dropped. */
export function pruneTodos(list: Todo[], now = Date.now()): Todo[] {
  const limit = dayKey(now - 30 * 86400000);
  return list.filter((t) => !t.doneOn || t.doneOn >= limit);
}

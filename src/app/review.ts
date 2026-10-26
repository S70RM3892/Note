import type { ReviewRecord } from '../core/types';
import type { App } from './app';
import { EditorView } from './editorView';

/** Build today's queue (oldest due first) and open the first page in review mode. */
export async function startReview(app: App): Promise<EditorView | null> {
  const now = Date.now();
  const notebooks = new Set((await app.repo.listNotebooks()).map((n) => n.id));
  const queue: ReviewRecord[] = (await app.repo.listReviews()).filter((r) => r.state.due <= now && notebooks.has(r.nb)).sort((a, b) => a.state.due - b.state.due);
  if (!queue.length) return null;
  return EditorView.openReview(app, queue);
}

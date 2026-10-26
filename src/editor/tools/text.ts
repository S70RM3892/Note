import { itemContains } from '../../core/geometry';
import { uid } from '../../core/id';
import type { Page, TextItem } from '../../core/types';
import type { Editor } from '../editor';
import { LINE_HEIGHT, TEXT_FONT, layoutText } from '../paint';
import type { Sample, Tool } from '../tool';

/** Tap to place or edit typed text (keyboard / IME / S Pen handwriting input). */
export class TextTool implements Tool {
  private start: Sample | null = null;

  constructor(private ed: Editor) {}

  down(s: Sample) {
    this.start = s;
  }

  move() {}

  up(s: Sample) {
    const a = this.start;
    this.start = null;
    if (!a || Math.hypot(s.sx - a.sx, s.sy - a.sy) > 10) return;
    const hit = this.ed.pageAt(s.wx, s.wy);
    if (!hit) return;
    const x = s.wx - hit.ox, y = s.wy - hit.oy;
    const existing = [...hit.page.items].reverse().find((i): i is TextItem => i.type === 'text' && !i.locked && itemContains(i, x, y, 4));
    if (existing) this.ed.textEditor.edit(hit.page, existing);
    else this.ed.textEditor.create(hit.page, x, y);
  }

  cancel() {
    this.start = null;
  }

  deactivate() {
    this.ed.textEditor.commit();
  }
}

/** HTML textarea floated over the canvas while a text item is edited. */
/** One tap while typing: what math and science answers need that a keyboard hides. */
export const SYMBOLS = ['√', 'π', 'θ', 'α', 'β', 'γ', 'λ', 'ω', 'Σ', '∫', '∞', '±', '×', '÷', '≠', '≦', '≧', '≒', '→', '⇔', '⇒', '∴', '∵', '∈', '⊂', '∩', '∪', '∠', '△', '⊥', '∥', '°', '²', '³', '′'];

export class TextEditor {
  readonly el: HTMLTextAreaElement;
  /** 記号パレット under the box being edited. */
  readonly bar: HTMLElement;
  private page: Page | null = null;
  private item: TextItem | null = null;
  private isNew = false;

  constructor(private ed: Editor, host: HTMLElement) {
    this.el = document.createElement('textarea');
    this.el.className = 'ed-textedit';
    this.el.spellcheck = false;
    this.el.hidden = true;
    this.el.addEventListener('blur', () => this.commit());
    this.el.addEventListener('input', () => this.layout());
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.el.blur();
      e.stopPropagation();
    });
    host.appendChild(this.el);
    this.bar = document.createElement('div');
    this.bar.className = 'ed-symbols';
    this.bar.hidden = true;
    this.bar.dataset.testid = 'symbols';
    for (const sym of SYMBOLS) {
      const b = document.createElement('button');
      b.textContent = sym;
      // Keep the focus (and the caret) in the text box.
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => this.insert(sym));
      this.bar.appendChild(b);
    }
    host.appendChild(this.bar);
  }

  private insert(sym: string) {
    if (!this.item) return;
    const t = this.el;
    t.setRangeText(sym, t.selectionStart, t.selectionEnd, 'end');
    t.focus();
    this.layout();
  }

  get editingId(): string | null {
    return this.item?.id ?? null;
  }

  create(page: Page, x: number, y: number) {
    const st = this.ed.settings.get();
    const size = 18;
    const item: TextItem = { id: uid(), type: 'text', x, y: y - size * 0.7, w: Math.min(360, page.w - x - 8), h: size * LINE_HEIGHT, rot: 0, text: '', size, color: st.pen.color };
    this.open(page, item, true);
  }

  edit(page: Page, item: TextItem) {
    this.open(page, item, false);
  }

  private open(page: Page, item: TextItem, isNew: boolean) {
    this.commit();
    this.page = page;
    this.item = item;
    this.isNew = isNew;
    this.el.value = item.text;
    this.el.hidden = false;
    this.ed.renderer.invalidate(page.id, { x: item.x, y: item.y, w: item.w, h: item.h });
    this.layout();
    this.el.focus();
  }

  /** Keep the textarea glued to the item as the view moves. */
  layout() {
    const it = this.item, page = this.page;
    if (!it || !page) return;
    const vp = this.ed.vp;
    const i = this.ed.doc!.indexOf(page.id);
    const r = vp.rects[i];
    if (!r) return;
    const z = vp.zoom;
    const maxW = Math.max(it.size * 2, page.w - it.x - 4);
    const lay = layoutText(this.el.value || ' ', it.size, maxW);
    this.el.style.left = `${vp.toScreenX(r.x + it.x)}px`;
    this.el.style.top = `${vp.toScreenY(r.y + it.y)}px`;
    this.el.style.width = `${(Math.max(lay.w, it.size * 4) + it.size) * z}px`;
    this.el.style.height = `${(lay.h + it.size * 0.4) * z}px`;
    this.el.style.font = `${it.size * z}px/${LINE_HEIGHT} ${TEXT_FONT}`;
    this.el.style.color = it.color;
    this.bar.hidden = false;
    const top = vp.toScreenY(r.y + it.y) + (lay.h + it.size * 0.4) * z + 6;
    this.bar.style.left = `${Math.max(4, Math.min(vp.width - this.bar.offsetWidth - 4, vp.toScreenX(r.x + it.x)))}px`;
    this.bar.style.top = `${Math.min(vp.height - 48, top)}px`;
  }

  commit() {
    const it = this.item, page = this.page;
    if (!it || !page) return;
    this.item = null;
    this.page = null;
    this.el.hidden = true;
    this.bar.hidden = true;
    const text = this.el.value.replace(/\s+$/, '');
    const doc = this.ed.doc!;
    if (!doc.page(page.id)) return;
    if (!text) {
      if (!this.isNew) doc.replaceItem(page.id, it, null);
      else this.ed.renderer.invalidate(page.id, { x: it.x, y: it.y, w: it.w, h: it.h });
      return;
    }
    const maxW = Math.max(it.size * 2, page.w - it.x - 4);
    const lay = layoutText(text, it.size, maxW);
    const next: TextItem = { ...it, text, w: lay.w, h: lay.h };
    if (this.isNew) doc.addItems(page.id, [next]);
    else if (text !== it.text) doc.replaceItem(page.id, it, next);
    else this.ed.renderer.invalidate(page.id, { x: it.x, y: it.y, w: it.w, h: it.h });
  }
}

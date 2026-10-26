export interface Command {
  undo(): void;
  redo(): void;
}

/** Linear undo/redo stack. */
export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  onChange: () => void = () => {};

  constructor(private limit = 500) {}

  push(cmd: Command) {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.onChange();
  }

  undo(): boolean {
    const c = this.undoStack.pop();
    if (!c) return false;
    c.undo();
    this.redoStack.push(c);
    this.onChange();
    return true;
  }

  redo(): boolean {
    const c = this.redoStack.pop();
    if (!c) return false;
    c.redo();
    this.undoStack.push(c);
    this.onChange();
    return true;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.onChange();
  }
}

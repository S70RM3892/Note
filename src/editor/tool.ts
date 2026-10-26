export type ToolName = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text' | 'tape';

/** One input sample. s* = CSS px relative to the stage, w* = world units. */
export interface Sample {
  sx: number;
  sy: number;
  wx: number;
  wy: number;
  /** Pressure after the user's curve (0..1). */
  p: number;
  t: number;
  pointerType: string;
}

export interface Tool {
  down(s: Sample): void;
  move(samples: Sample[], predicted: Sample[]): void;
  up(s: Sample): void;
  cancel(): void;
  /** Discard the interaction entirely (e.g. a finger stroke that turned into a pinch). */
  abort?(): void;
  hover?(s: Sample | null): void;
  /** Paint tool UI on the ui canvas (CSS px coordinates, dpr already applied). */
  drawUI?(ctx: CanvasRenderingContext2D): void;
  /** Redraw the live ink layer from scratch (after a delayed clear). */
  repaintLive?(): void;
  /** Called when the tool is deselected. */
  deactivate?(): void;
}

/**
 * Stroke modeling for handwriting, after Google's Ink Stroke Modeler
 * (github.com/google/ink-stroke-modeler, Apache-2.0):
 *
 *  1. Wobble smoothing — a time-window moving average of the input, blended back towards the
 *     raw position as the pen speeds up, so slow strokes lose digitizer jitter and fast ones
 *     keep their shape.
 *  2. Resampling — anchors are interpolated to at least `minRate` (480 per second).
 *  3. Position modeling — the pen tip is a mass pulled towards the anchor by a spring, with
 *     drag (fixed-step Euler integration). This gives smooth, natural curves at any speed.
 *     (Stiffer than the library's preset, see DEFAULT_MODELER.)
 *  4. End of stroke — the tip keeps following the spring to the final raw position (halving
 *     the step when it would overshoot) instead of jumping there in a straight line, so fast
 *     はね・はらい end the way they were written.
 *  5. Pressure — each modeled point takes the pressure of the nearest point on the recent
 *     raw polyline, so the end taper follows the real lift-off.
 *
 * The spring model is linear, so it is unit-free; only the speed thresholds and the stop
 * distance depend on units (pass them in the same units as the positions). Time is in ms.
 * The Android shell runs the same algorithm (Modeler.kt) for its low-latency wet ink, so the
 * two must stay in step — tests/unit/modeler.test.ts checks shared vectors.
 */

export interface ModelerParams {
  /** Moving-average window of the wobble smoother (ms). */
  wobbleWindow: number;
  /** Below this speed (units/ms) the full moving average is used… */
  speedFloor: number;
  /** …above this one, the raw position. */
  speedCeiling: number;
  /** Mass over spring constant (ms²) and drag (1/ms) of the tip model. */
  springMass: number;
  drag: number;
  /** Minimum modeled points per ms. */
  minRate: number;
  /** End-of-stroke stops within this distance of the final input (units). */
  stopDistance: number;
  endIterations: number;
  /**
   * If the tip still hasn't reached the final input after the iterations, a last point is put
   * there only when the gap is bigger than this (a closer jump would just add a kink).
   */
  landDistance: number;
  /** Raw inputs kept for the pressure projection. */
  pressureSamples: number;
}

/**
 * Defaults in ms and CSS px *on screen*: callers modeling in page units divide the speeds and
 * the stop distance by the zoom (see `modelerParams`).
 *
 * The spring is stiffer than the library's handwriting preset (mass ×0.15 of 11/32400 s², same
 * damping ratio 0.66): measured on a zigzag at 750 px/s (~15 cm/s on the Tab S11), corners are
 * missed by 2.6 px instead of 6.6 px, so a quickly written く or レ stays sharp, while a sparse
 * 120 Hz loop still turns ≤ 5° per step instead of 20° — and the tip trails the pen less.
 */
const SPRING_MASS = (11 / 32400) * 1e6 * 0.15; // ms²
const DAMPING = 0.66;
export const DEFAULT_MODELER: ModelerParams = {
  wobbleWindow: 40,
  speedFloor: 0.03, // 30 px/s
  speedCeiling: 0.09, // 90 px/s
  springMass: SPRING_MASS,
  drag: 2 * DAMPING / Math.sqrt(SPRING_MASS),
  minRate: 480 / 1000, // 2 ms steps: smooth even on tight, fast loops
  stopDistance: 0.05,
  endIterations: 40,
  landDistance: 1.5, // well inside the pen width
  pressureSamples: 20,
};

/** Parameters for modeling in page units at a given zoom (screen px per page unit). */
export function modelerParams(zoom: number): ModelerParams {
  const z = Math.max(0.05, zoom);
  const D = DEFAULT_MODELER;
  return { ...D, speedFloor: D.speedFloor / z, speedCeiling: D.speedCeiling / z, stopDistance: D.stopDistance / z, landDistance: D.landDistance / z };
}

export interface ModelPoint {
  x: number;
  y: number;
  p: number;
  t: number;
}

interface Tip {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
}

interface WobbleSample {
  x: number;
  y: number;
  t: number;
  dist: number;
  dur: number;
}

interface Raw {
  x: number;
  y: number;
  p: number;
}

const MAX_STEPS = 400;

export class StrokeModeler {
  private wob: WobbleSample[] = [];
  private wsx = 0;
  private wsy = 0;
  private wdist = 0;
  private wdur = 0;
  private tip: Tip = { x: 0, y: 0, vx: 0, vy: 0, t: 0 };
  private anchor = { x: 0, y: 0, t: 0 };
  private raw: Raw[] = [];
  private last: Raw & { t: number } = { x: 0, y: 0, p: 0.5, t: 0 };

  constructor(public params: ModelerParams = DEFAULT_MODELER) {}

  /** Start a stroke; returns the first point (the pen-down position). */
  reset(x: number, y: number, p: number, t: number): ModelPoint {
    this.wob = [{ x, y, t, dist: 0, dur: 0 }];
    this.wsx = this.wsy = this.wdist = this.wdur = 0;
    this.tip = { x, y, vx: 0, vy: 0, t };
    this.anchor = { x, y, t };
    this.raw = [{ x, y, p }];
    this.last = { x, y, p, t };
    return { x, y, p, t };
  }

  /** Feed one raw input; returns the modeled points it produces (possibly none). */
  update(x: number, y: number, p: number, t: number): ModelPoint[] {
    // Inputs must move forward in time; equal stamps are nudged so they still count.
    if (t <= this.last.t) t = this.last.t + 0.25;
    this.last = { x, y, p, t };
    this.raw.push({ x, y, p });
    if (this.raw.length > this.params.pressureSamples) this.raw.shift();
    const s = this.smooth(x, y, t);
    const a0 = this.anchor;
    const n = Math.min(MAX_STEPS, Math.max(1, Math.ceil((t - a0.t) * this.params.minRate)));
    const out: ModelPoint[] = [];
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      this.step(a0.x + (s.x - a0.x) * k, a0.y + (s.y - a0.y) * k, a0.t + (t - a0.t) * k);
      out.push(this.point());
    }
    this.anchor = { x: s.x, y: s.y, t };
    return out;
  }

  /** Where the stroke would end if the pen lifted now (does not change the model). */
  predict(): ModelPoint[] {
    const tip = { ...this.tip };
    const out = this.endOfStroke();
    this.tip = tip;
    return out;
  }

  /** Pen lifted: follow the spring to the last input. */
  finish(): ModelPoint[] {
    return this.endOfStroke();
  }

  // ---------- internals ----------

  private smooth(x: number, y: number, t: number): { x: number; y: number } {
    const P = this.params;
    const prev = this.wob[this.wob.length - 1];
    const dur = t - prev.t;
    const s: WobbleSample = { x, y, t, dist: Math.hypot(x - prev.x, y - prev.y), dur };
    this.wob.push(s);
    this.wsx += x * dur;
    this.wsy += y * dur;
    this.wdist += s.dist;
    this.wdur += dur;
    while (this.wob[0].t < t - P.wobbleWindow) {
      const f = this.wob.shift()!;
      this.wsx -= f.x * f.dur;
      this.wsy -= f.y * f.dur;
      this.wdist -= f.dist;
      this.wdur -= f.dur;
    }
    if (this.wdur <= 1e-9) return { x, y };
    const ax = this.wsx / this.wdur, ay = this.wsy / this.wdur;
    const speed = this.wdist / this.wdur;
    const k = Math.min(1, Math.max(0, (speed - P.speedFloor) / Math.max(1e-9, P.speedCeiling - P.speedFloor)));
    return { x: ax + (x - ax) * k, y: ay + (y - ay) * k };
  }

  /** One Euler step of the spring-mass tip towards the anchor. */
  private step(ax: number, ay: number, t: number) {
    const P = this.params, s = this.tip;
    const dt = t - s.t;
    const accx = (ax - s.x) / P.springMass - P.drag * s.vx;
    const accy = (ay - s.y) / P.springMass - P.drag * s.vy;
    s.vx += dt * accx;
    s.vy += dt * accy;
    s.x += dt * s.vx;
    s.y += dt * s.vy;
    s.t = t;
  }

  private endOfStroke(): ModelPoint[] {
    const P = this.params;
    const target = this.last;
    const out: ModelPoint[] = [];
    let dt = 1 / P.minRate;
    for (let i = 0; i < P.endIterations; i++) {
      const prev = { ...this.tip };
      this.step(target.x, target.y, prev.t + dt);
      const c = this.tip;
      const moved = Math.hypot(c.x - prev.x, c.y - prev.y);
      if (moved < P.stopDistance) {
        this.tip = prev;
        break;
      }
      // Overshot the target (the closest point of this step lies before its end): retry smaller.
      const dx = c.x - prev.x, dy = c.y - prev.y;
      const u = ((target.x - prev.x) * dx + (target.y - prev.y) * dy) / (moved * moved);
      if (u < 1) {
        this.tip = prev;
        dt *= 0.5;
        continue;
      }
      out.push(this.point());
      if (Math.hypot(c.x - target.x, c.y - target.y) < P.stopDistance) break;
    }
    // Still visibly short of where the pen lifted: finish there.
    const end = out[out.length - 1] ?? this.point();
    if (Math.hypot(end.x - target.x, end.y - target.y) > P.landDistance) out.push({ x: target.x, y: target.y, p: target.p, t: Math.max(end.t, target.t) });
    return out;
  }

  /** The tip as an output point, with pressure projected from the raw polyline. */
  private point(): ModelPoint {
    const s = this.tip;
    return { x: s.x, y: s.y, p: this.pressureAt(s.x, s.y), t: s.t };
  }

  private pressureAt(x: number, y: number): number {
    const r = this.raw;
    if (r.length === 1) return r[0].p;
    let best = Infinity, p = r[r.length - 1].p;
    for (let i = 0; i + 1 < r.length; i++) {
      const a = r[i], b = r[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = dx * dx + dy * dy;
      const u = L > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / L)) : 0;
      const qx = a.x + dx * u, qy = a.y + dy * u;
      const d = (x - qx) ** 2 + (y - qy) ** 2;
      // Ties go to the newer segment (the tip trails the input).
      if (d <= best) {
        best = d;
        p = a.p + (b.p - a.p) * u;
      }
    }
    return p;
  }
}

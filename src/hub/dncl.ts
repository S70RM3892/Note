/**
 * 共通テスト用プログラム表記 (大学入試センター「令和７年度大学入学共通テスト 試作問題『情報』の概要」
 * ５．共通テスト用プログラム表記の例示) — a small interpreter for practising 情報Ⅰ.
 *
 * Covered, as in the 例示: variables and arrays (Data[2,4] too), strings joined with +, several
 * statements on one line separated by commas, 「Xのすべての値を0にする」,【外部からの入力】,
 * + - * / ÷ (integer quotient) % ** == != > < >= <= and or not, 要素数() 整数() 乱数() 表示する(),
 * もし…ならば: / そうでなくもし…ならば: / そうでなければ:, …の間繰り返す:,
 * xを…から…まで…ずつ増やしながら(減らしながら)繰り返す:, # comments, and blocks drawn with ｜ and ⎿
 * (or plain indentation). Line numbers like "( 1 )" copied from a problem are ignored.
 */

export type Value = number | string | boolean | Value[];

export interface TraceRow {
  /** 1-based line in the source. */
  line: number;
  /** The statement as written (without the block marks). */
  text: string;
  /** What happened: a condition's result, the loop variable, a printed line. */
  note?: string;
  /** Every variable after this step, formatted. */
  vars: Record<string, string>;
}

export interface RunResult {
  output: string[];
  trace: TraceRow[];
  /** True when the trace was cut short (it keeps the first `maxTrace` steps). */
  traceCut: boolean;
  steps: number;
  vars: Record<string, string>;
  error?: { line: number; message: string };
}

export interface RunOptions {
  /** Values handed to 【外部からの入力】, in order. */
  inputs?: string[];
  /** 乱数() — Math.random by default (tests pass a fixed sequence). */
  random?: () => number;
  maxSteps?: number;
  maxTrace?: number;
}

export class DnclError extends Error {
  constructor(
    public line: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- lexing ----------

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'input' };

const OPS = ['**', '==', '!=', '>=', '<=', '>', '<', '=', '+', '-', '*', '/', '÷', '%', '(', ')', '[', ']', ','];

/** Full-width and look-alike characters outside string literals, to their ASCII form. */
function normalizeCode(s: string): string {
  let out = '';
  let inStr = false;
  for (const ch of s) {
    if (ch === '"' || ch === '“' || ch === '”' || ch === '＂') {
      inStr = !inStr;
      out += '"';
      continue;
    }
    if (inStr) {
      out += ch;
      continue;
    }
    switch (ch) {
      case '≧':
      case '≥':
        out += '>=';
        break;
      case '≦':
      case '≤':
        out += '<=';
        break;
      case '≠':
        out += '!=';
        break;
      case '×':
        out += '*';
        break;
      case '–':
      case '−':
      case '—':
        out += '-';
        break;
      case '　':
        out += ' ';
        break;
      default:
        out += /[！-～]/.test(ch) ? ch.normalize('NFKC') : ch;
    }
  }
  return out;
}

/** Drop a # comment (outside strings). */
function stripComment(s: string): string {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') inStr = !inStr;
    else if (s[i] === '#' && !inStr) return s.slice(0, i);
  }
  return s;
}

function tokenize(s: string, line: number): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (s.startsWith('【外部からの入力】', i)) {
      out.push({ t: 'input' });
      i += '【外部からの入力】'.length;
      continue;
    }
    if (c === '"') {
      const j = s.indexOf('"', i + 1);
      if (j < 0) throw new DnclError(line, '文字列の " が閉じていない');
      out.push({ t: 'str', v: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const op = OPS.find((o) => s.startsWith(o, i));
    if (op) {
      out.push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i)) ?? /^[^\x00-\x7f\s÷【】]+/.exec(s.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new DnclError(line, `「${c}」が読めない`);
  }
  return out;
}

// ---------- expressions ----------

type Expr =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'arr'; items: Expr[] }
  | { k: 'var'; name: string }
  | { k: 'index'; target: Expr; idx: Expr[] }
  | { k: 'call'; name: string; args: Expr[] }
  | { k: 'un'; op: string; a: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'input' };

class ExprParser {
  private i = 0;
  constructor(
    private toks: Tok[],
    private line: number,
  ) {}

  done() {
    return this.i >= this.toks.length;
  }

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }

  private isOp(v: string) {
    const t = this.peek();
    return t?.t === 'op' && t.v === v;
  }

  private isWord(v: string) {
    const t = this.peek();
    return t?.t === 'id' && t.v === v;
  }

  private expect(v: string) {
    if (!this.isOp(v)) throw new DnclError(this.line, `「${v}」がない`);
    this.i++;
  }

  parse(): Expr {
    const e = this.or();
    if (!this.done()) throw new DnclError(this.line, `式の後ろに余分なもの「${show(this.peek()!)}」がある`);
    return e;
  }

  or(): Expr {
    let a = this.and();
    while (this.isWord('or')) {
      this.i++;
      a = { k: 'bin', op: 'or', a, b: this.and() };
    }
    return a;
  }

  private and(): Expr {
    let a = this.not();
    while (this.isWord('and')) {
      this.i++;
      a = { k: 'bin', op: 'and', a, b: this.not() };
    }
    return a;
  }

  private not(): Expr {
    if (this.isWord('not')) {
      this.i++;
      return { k: 'un', op: 'not', a: this.not() };
    }
    return this.cmp();
  }

  private cmp(): Expr {
    let a = this.add();
    for (;;) {
      const t = this.peek();
      if (t?.t === 'op' && ['==', '!=', '>', '<', '>=', '<='].includes(t.v)) {
        this.i++;
        a = { k: 'bin', op: t.v, a, b: this.add() };
      } else return a;
    }
  }

  private add(): Expr {
    let a = this.mul();
    for (;;) {
      const t = this.peek();
      if (t?.t === 'op' && (t.v === '+' || t.v === '-')) {
        this.i++;
        a = { k: 'bin', op: t.v, a, b: this.mul() };
      } else return a;
    }
  }

  private mul(): Expr {
    let a = this.unary();
    for (;;) {
      const t = this.peek();
      if (t?.t === 'op' && ['*', '/', '÷', '%'].includes(t.v)) {
        this.i++;
        a = { k: 'bin', op: t.v, a, b: this.unary() };
      } else return a;
    }
  }

  private unary(): Expr {
    if (this.isOp('-')) {
      this.i++;
      return { k: 'un', op: '-', a: this.unary() };
    }
    if (this.isOp('+')) {
      this.i++;
      return this.unary();
    }
    return this.pow();
  }

  private pow(): Expr {
    const a = this.postfix();
    if (this.isOp('**')) {
      this.i++;
      return { k: 'bin', op: '**', a, b: this.unary() };
    }
    return a;
  }

  private postfix(): Expr {
    let e = this.primary();
    while (this.isOp('[')) {
      this.i++;
      const idx = [this.or()];
      while (this.isOp(',')) {
        this.i++;
        idx.push(this.or());
      }
      this.expect(']');
      e = { k: 'index', target: e, idx };
    }
    return e;
  }

  private primary(): Expr {
    const t = this.peek();
    if (!t) throw new DnclError(this.line, '式が途中で終わっている');
    this.i++;
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'input') return { k: 'input' };
    if (t.t === 'op' && t.v === '(') {
      const e = this.or();
      this.expect(')');
      return e;
    }
    if (t.t === 'op' && t.v === '[') {
      const items: Expr[] = [];
      if (!this.isOp(']')) {
        items.push(this.or());
        while (this.isOp(',')) {
          this.i++;
          items.push(this.or());
        }
      }
      this.expect(']');
      return { k: 'arr', items };
    }
    if (t.t === 'id') {
      if (this.isOp('(')) {
        this.i++;
        const args: Expr[] = [];
        if (!this.isOp(')')) {
          args.push(this.or());
          while (this.isOp(',')) {
            this.i++;
            args.push(this.or());
          }
        }
        this.expect(')');
        return { k: 'call', name: t.v, args };
      }
      if (t.v === 'and' || t.v === 'or' || t.v === 'not') throw new DnclError(this.line, `「${t.v}」の前に式がない`);
      return { k: 'var', name: t.v };
    }
    throw new DnclError(this.line, `「${show(t)}」がここでは使えない`);
  }
}

function show(t: Tok): string {
  return t.t === 'num' ? String(t.v) : t.t === 'str' ? `"${t.v}"` : t.t === 'input' ? '【外部からの入力】' : t.v;
}

export function parseExpr(src: string, line = 1): Expr {
  return new ExprParser(tokenize(normalizeCode(src), line), line).parse();
}

// ---------- statements ----------

type Target = { k: 'var'; name: string } | { k: 'index'; target: Expr; idx: Expr[] };

type Simple = { k: 'assign'; target: Target; value: Expr } | { k: 'expr'; e: Expr };

type Stmt =
  | { k: 'simple'; line: number; text: string; parts: Simple[] }
  | { k: 'fill'; line: number; text: string; name: string; value: Expr }
  | { k: 'if'; line: number; text: string; branches: { line: number; text: string; cond: Expr | null; body: Stmt[] }[] }
  | { k: 'while'; line: number; text: string; cond: Expr; body: Stmt[] }
  | { k: 'for'; line: number; text: string; v: string; from: Expr; to: Expr; step: Expr; down: boolean; body: Stmt[] };

interface SrcLine {
  line: number;
  depth: number;
  /** Normalized code. */
  code: string;
  /** As written, without the block marks. */
  text: string;
}

const MARKS = /^[\s｜|│┃⎿└┗]*/;

function splitLines(src: string): SrcLine[] {
  const raw = src.replace(/\r\n?/g, '\n').split('\n');
  // "( 1 )" from a problem's listing is not part of the code.
  const lines = raw.map((l, i) => ({ line: i + 1, s: stripComment(l.replace(/^\s*[（(]\s*\d+\s*[)）]\s?/, '')) })).filter((l) => l.s.trim());
  const marked = lines.some((l) => /^\s*[｜|│┃⎿└┗]/.test(l.s));
  const width = (lead: string) => [...lead].reduce((n, c) => n + (c === '\t' ? 4 : c === '　' ? 2 : 1), 0);
  const base = marked ? 0 : Math.min(...lines.map((l) => width(/^[ \t　]*/.exec(l.s)![0])));
  const indents: number[] = [base];
  return lines.map(({ line, s }) => {
    let depth: number;
    if (marked) {
      const lead = MARKS.exec(s)![0];
      depth = [...lead].filter((c) => !/\s/.test(c)).length;
      s = s.slice(lead.length);
    } else {
      const lead = /^[ \t　]*/.exec(s)![0];
      const w = width(lead);
      if (w > indents[indents.length - 1]) indents.push(w);
      else while (w < indents[indents.length - 1]) indents.pop();
      if (w !== indents[indents.length - 1]) throw new DnclError(line, '字下げがそろっていない');
      depth = indents.length - 1;
      s = s.slice(lead.length);
    }
    const text = s.trim();
    return { line, depth, code: normalizeCode(text).trim(), text };
  });
}

const RE_IF = /^もし\s*(.+?)\s*ならば\s*:?$/;
const RE_ELIF = /^そうでなくもし\s*(.+?)\s*ならば\s*:?$/;
const RE_ELSE = /^そうでなければ\s*:?$/;
const RE_WHILE = /^(.+?)\s*の間繰り返す\s*:?$/;
const RE_FOR = /^([A-Za-z_]\w*)\s*を\s*(.+?)\s*から\s*(.+?)\s*まで\s*(.+?)\s*ずつ\s*(増やし|減らし)ながら繰り返す\s*:?$/;
const RE_FILL = /^([A-Za-z_]\w*)\s*のすべての(?:値|要素)を\s*(.+?)\s*にする$/;

function splitTop(toks: Tok[], sep: string): Tok[][] {
  const parts: Tok[][] = [[]];
  let depth = 0;
  for (const t of toks) {
    if (t.t === 'op' && (t.v === '(' || t.v === '[')) depth++;
    if (t.t === 'op' && (t.v === ')' || t.v === ']')) depth--;
    if (depth === 0 && t.t === 'op' && t.v === sep) parts.push([]);
    else parts[parts.length - 1].push(t);
  }
  return parts;
}

function parseSimple(code: string, line: number): Simple[] {
  return splitTop(tokenize(code, line), ',').map((part) => {
    if (!part.length) throw new DnclError(line, 'カンマの間に文がない');
    const eq = part.findIndex((t) => t.t === 'op' && t.v === '=');
    if (eq < 0) {
      const e = new ExprParser(part, line).parse();
      if (e.k !== 'call') throw new DnclError(line, '値を何に入れるのか（= ）がない');
      return { k: 'expr', e };
    }
    if (eq === 0) throw new DnclError(line, '= の左に変数がない');
    const lhs = new ExprParser(part.slice(0, eq), line).parse();
    if (lhs.k !== 'var' && lhs.k !== 'index') throw new DnclError(line, '= の左には変数か配列の要素を書く');
    if (eq === part.length - 1) throw new DnclError(line, '= の右に値がない');
    return { k: 'assign', target: lhs, value: new ExprParser(part.slice(eq + 1), line).parse() };
  });
}

class StmtParser {
  private i = 0;
  constructor(private lines: SrcLine[]) {}

  program(): Stmt[] {
    const body = this.block(0);
    if (this.i < this.lines.length) {
      const l = this.lines[this.i];
      throw new DnclError(l.line, 'この行の ｜（字下げ）が多い。何の中なのかわからない');
    }
    return body;
  }

  private block(depth: number): Stmt[] {
    const out: Stmt[] = [];
    while (this.i < this.lines.length && this.lines[this.i].depth === depth) {
      const l = this.lines[this.i];
      // A そうでなくもし / そうでなければ that its もし didn't take (that one consumes its own).
      if (RE_ELIF.test(l.code) || RE_ELSE.test(l.code)) throw new DnclError(l.line, `「${l.text}」に対応する「もし…ならば:」がない（｜ の数を確かめる）`);
      out.push(this.stmt(depth));
    }
    return out;
  }

  private body(depth: number, header: SrcLine): Stmt[] {
    if (this.i >= this.lines.length || this.lines[this.i].depth !== depth + 1) throw new DnclError(header.line, `「${header.text}」の中身がない（次の行の先頭に ｜ か ⎿ をつける）`);
    return this.block(depth + 1);
  }

  private expr(src: string, line: number) {
    return new ExprParser(tokenize(src, line), line).parse();
  }

  private stmt(depth: number): Stmt {
    const l = this.lines[this.i++];
    const { line, code, text } = l;
    let m: RegExpExecArray | null;
    if ((m = RE_IF.exec(code))) {
      const branches = [{ line, text, cond: this.expr(m[1], line) as Expr | null, body: this.body(depth, l) }];
      for (;;) {
        const n = this.lines[this.i];
        if (!n || n.depth !== depth) break;
        if ((m = RE_ELIF.exec(n.code))) {
          if (branches[branches.length - 1].cond === null) throw new DnclError(n.line, '「そうでなければ」の後に「そうでなくもし」は書けない');
          this.i++;
          branches.push({ line: n.line, text: n.text, cond: this.expr(m[1], n.line), body: this.body(depth, n) });
        } else if (RE_ELSE.test(n.code)) {
          if (branches[branches.length - 1].cond === null) throw new DnclError(n.line, '「そうでなければ」が2回ある');
          this.i++;
          branches.push({ line: n.line, text: n.text, cond: null, body: this.body(depth, n) });
        } else break;
      }
      return { k: 'if', line, text, branches };
    }
    if ((m = RE_FOR.exec(code))) {
      return { k: 'for', line, text, v: m[1], from: this.expr(m[2], line), to: this.expr(m[3], line), step: this.expr(m[4], line), down: m[5] === '減らし', body: this.body(depth, l) };
    }
    if ((m = RE_WHILE.exec(code))) return { k: 'while', line, text, cond: this.expr(m[1], line), body: this.body(depth, l) };
    if ((m = RE_FILL.exec(code))) return { k: 'fill', line, text, name: m[1], value: this.expr(m[2], line) };
    if (code.endsWith(':')) throw new DnclError(line, `「${text}」の書き方がわからない（もし…ならば: / …の間繰り返す: / …ずつ増やしながら繰り返す:）`);
    return { k: 'simple', line, text, parts: parseSimple(code, line) };
  }
}

export function compile(src: string): Stmt[] {
  return new StmtParser(splitLines(src)).program();
}

// ---------- values ----------

export function formatValue(v: Value, nested = false): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
  if (typeof v === 'boolean') return v ? '真' : '偽';
  if (typeof v === 'string') return nested ? `"${v}"` : v;
  return `[${v.map((x) => formatValue(x, true)).join(', ')}]`;
}

function clip(s: string, n = 80) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function truthy(v: Value, line: number): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  throw new DnclError(line, `条件が「${formatValue(v)}」になっている（比較の式を書く）`);
}

function num(v: Value, line: number, what: string): number {
  if (typeof v !== 'number') throw new DnclError(line, `${what}に数ではないもの「${formatValue(v, true)}」がある`);
  return v;
}

function intIndex(v: Value, line: number): number {
  const n = num(v, line, '添字');
  if (!Number.isInteger(n) || n < 0) throw new DnclError(line, `添字「${formatValue(n)}」は 0 以上の整数でないといけない`);
  return n;
}

function fill(a: Value[], v: Value) {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (Array.isArray(x)) fill(x, v);
    else a[i] = v;
  }
}

// ---------- running ----------

class Interp {
  vars = new Map<string, Value>();
  output: string[] = [];
  trace: TraceRow[] = [];
  traceCut = false;
  steps = 0;
  private inputs: string[];
  private random: () => number;
  private maxSteps: number;
  private maxTrace: number;

  constructor(o: RunOptions) {
    this.inputs = [...(o.inputs ?? [])];
    this.random = o.random ?? Math.random;
    this.maxSteps = o.maxSteps ?? 100_000;
    this.maxTrace = o.maxTrace ?? 3000;
  }

  snapshot(): Record<string, string> {
    const o: Record<string, string> = {};
    for (const [k, v] of this.vars) o[k] = clip(formatValue(v, true));
    return o;
  }

  private step(line: number, text: string, note?: string) {
    if (++this.steps > this.maxSteps) throw new DnclError(line, `${this.maxSteps.toLocaleString()} ステップを超えた。終わらないループになっていないか`);
    if (this.trace.length < this.maxTrace) this.trace.push({ line, text, note, vars: this.snapshot() });
    else this.traceCut = true;
  }

  block(stmts: Stmt[]) {
    for (const s of stmts) this.stmt(s);
  }

  private stmt(s: Stmt) {
    switch (s.k) {
      case 'simple': {
        const printed: string[] = [];
        for (const p of s.parts) {
          if (p.k === 'assign') this.assign(p.target, this.eval(p.value, s.line), s.line);
          else {
            const before = this.output.length;
            this.eval(p.e, s.line);
            printed.push(...this.output.slice(before));
          }
        }
        this.step(s.line, s.text, printed.length ? `表示: ${printed.join(' / ')}` : undefined);
        return;
      }
      case 'fill': {
        const a = this.vars.get(s.name);
        if (!Array.isArray(a)) throw new DnclError(s.line, `配列 ${s.name} がまだない（要素数がわからない）`);
        fill(a, this.eval(s.value, s.line));
        this.step(s.line, s.text);
        return;
      }
      case 'if': {
        for (const b of s.branches) {
          if (b.cond === null) {
            this.step(b.line, b.text);
            this.block(b.body);
            return;
          }
          const ok = truthy(this.eval(b.cond, b.line), b.line);
          this.step(b.line, b.text, ok ? '→ 真' : '→ 偽');
          if (ok) {
            this.block(b.body);
            return;
          }
        }
        return;
      }
      case 'while': {
        for (;;) {
          const ok = truthy(this.eval(s.cond, s.line), s.line);
          this.step(s.line, s.text, ok ? '→ 真（繰り返す）' : '→ 偽（抜ける）');
          if (!ok) return;
          this.block(s.body);
        }
      }
      case 'for': {
        const from = num(this.eval(s.from, s.line), s.line, '繰り返しの始め');
        const to = num(this.eval(s.to, s.line), s.line, '繰り返しの終わり');
        const step = num(this.eval(s.step, s.line), s.line, '増やす量');
        if (step <= 0) throw new DnclError(s.line, `「${formatValue(step)}ずつ」では終わらない（正の数にする）`);
        let v = from;
        for (;;) {
          if (s.down ? v < to : v > to) {
            this.step(s.line, s.text, `${s.v} = ${formatValue(v)}（終わり）`);
            return;
          }
          this.vars.set(s.v, v);
          this.step(s.line, s.text, `${s.v} = ${formatValue(v)}`);
          this.block(s.body);
          const cur = this.vars.get(s.v);
          v = (typeof cur === 'number' ? cur : v) + (s.down ? -step : step);
        }
      }
    }
  }

  private assign(t: Target, v: Value, line: number) {
    // Arrays are shared, not copied (as in Python and JavaScript).
    if (t.k === 'var') {
      this.vars.set(t.name, v);
      return;
    }
    // Data[i] = … (Data[i, j] for two dimensions): the array grows as needed.
    let base: Value[];
    if (t.target.k === 'var') {
      const cur = this.vars.get(t.target.name);
      if (cur === undefined) {
        base = [];
        this.vars.set(t.target.name, base);
      } else if (!Array.isArray(cur)) throw new DnclError(line, `${t.target.name} は配列ではない`);
      else base = cur;
    } else {
      const cur = this.eval(t.target, line);
      if (!Array.isArray(cur)) throw new DnclError(line, '配列ではないものに [ ] をつけている');
      base = cur;
    }
    const idx = t.idx.map((e) => intIndex(this.eval(e, line), line));
    let a = base;
    for (let k = 0; k < idx.length - 1; k++) {
      while (a.length <= idx[k]) a.push([]);
      if (!Array.isArray(a[idx[k]])) a[idx[k]] = [];
      a = a[idx[k]] as Value[];
    }
    const last = idx[idx.length - 1];
    while (a.length < last) a.push(0);
    a[last] = v;
  }

  eval(e: Expr, line: number): Value {
    switch (e.k) {
      case 'num':
        return e.v;
      case 'str':
        return e.v;
      case 'arr':
        return e.items.map((x) => this.eval(x, line));
      case 'input': {
        if (!this.inputs.length) throw new DnclError(line, '【外部からの入力】に渡す値が足りない（「入力」欄に1行に1つ書く）');
        const s = this.inputs.shift()!.trim();
        return s !== '' && Number.isFinite(Number(s)) ? Number(s) : s;
      }
      case 'var': {
        const v = this.vars.get(e.name);
        if (v === undefined) throw new DnclError(line, `変数 ${e.name} にまだ値が入っていない`);
        return v;
      }
      case 'index': {
        let v = this.eval(e.target, line);
        for (const ix of e.idx) {
          if (!Array.isArray(v)) throw new DnclError(line, '配列ではないものに [ ] をつけている');
          const i = intIndex(this.eval(ix, line), line);
          if (i >= v.length) throw new DnclError(line, `添字 ${i} が範囲外（要素数は ${v.length}）`);
          v = v[i];
        }
        return v;
      }
      case 'call':
        return this.call(e.name, e.args, line);
      case 'un': {
        const a = this.eval(e.a, line);
        if (e.op === 'not') return !truthy(a, line);
        return -num(a, line, '- の後ろ');
      }
      case 'bin': {
        if (e.op === 'and') return truthy(this.eval(e.a, line), line) ? truthy(this.eval(e.b, line), line) : false;
        if (e.op === 'or') return truthy(this.eval(e.a, line), line) ? true : truthy(this.eval(e.b, line), line);
        const a = this.eval(e.a, line);
        const b = this.eval(e.b, line);
        switch (e.op) {
          case '+':
            if (typeof a === 'string' || typeof b === 'string') return formatValue(a) + formatValue(b);
            return num(a, line, '足し算') + num(b, line, '足し算');
          case '-':
            return num(a, line, '引き算') - num(b, line, '引き算');
          case '*':
            return num(a, line, 'かけ算') * num(b, line, 'かけ算');
          case '/': {
            const d = num(b, line, '割り算');
            if (d === 0) throw new DnclError(line, '0 で割った');
            return num(a, line, '割り算') / d;
          }
          case '÷': {
            const d = num(b, line, '÷');
            if (d === 0) throw new DnclError(line, '0 で割った');
            return Math.floor(num(a, line, '÷') / d);
          }
          case '%': {
            const d = num(b, line, '%');
            if (d === 0) throw new DnclError(line, '0 で割った余りは求められない');
            const x = num(a, line, '%');
            return x - d * Math.floor(x / d);
          }
          case '**':
            return num(a, line, 'べき乗') ** num(b, line, 'べき乗');
          case '==':
            return a === b;
          case '!=':
            return a !== b;
          default: {
            if (typeof a !== typeof b || Array.isArray(a) || typeof a === 'boolean') throw new DnclError(line, `「${formatValue(a, true)}」と「${formatValue(b, true)}」は大小を比べられない`);
            const x = a as number | string, y = b as number | string;
            return e.op === '>' ? x > y : e.op === '<' ? x < y : e.op === '>=' ? x >= y : x <= y;
          }
        }
      }
    }
  }

  private call(name: string, args: Expr[], line: number): Value {
    const vals = () => args.map((a) => this.eval(a, line));
    switch (name) {
      case '表示する':
        this.output.push(vals().map((v) => formatValue(v)).join(''));
        return 0;
      case '要素数': {
        const [a] = vals();
        if (!Array.isArray(a)) throw new DnclError(line, '要素数() には配列を渡す');
        return a.length;
      }
      case '整数': {
        const [a] = vals();
        return Math.trunc(num(a, line, '整数()'));
      }
      case '乱数':
        return this.random();
      default:
        throw new DnclError(line, `関数「${name}」はこの実行環境にない（使えるのは 表示する・要素数・整数・乱数。ほかは問題文の説明どおりに自分で書き換える）`);
    }
  }
}

/** Run a program written in 共通テスト用プログラム表記. */
export function runDncl(src: string, opts: RunOptions = {}): RunResult {
  const it = new Interp(opts);
  let error: RunResult['error'];
  try {
    it.block(compile(src));
  } catch (e) {
    if (e instanceof DnclError) error = { line: e.line, message: e.message };
    else if (e instanceof RangeError) error = { line: 0, message: '入れ子が深すぎる' };
    else throw e;
  }
  return { output: it.output, trace: it.trace, traceCut: it.traceCut, steps: it.steps, vars: it.snapshot(), error };
}

/** 論理回路: the truth table of an expression in and / or / not (also ∧ ∨ ¬ and AND OR NOT). */
export function truthTable(src: string): { vars: string[]; rows: { inputs: number[]; out: number }[] } {
  const code = src
    .replace(/∧|・|&&?/g, ' and ')
    .replace(/∨|\|\|?/g, ' or ')
    .replace(/¬|￢|!(?!=)/g, ' not ')
    .replace(/\b(AND|OR|NOT)\b/g, (m) => ` ${m.toLowerCase()} `);
  const e = parseExpr(code);
  const names = new Set<string>();
  const walk = (x: Expr) => {
    if (x.k === 'var') names.add(x.name);
    else if (x.k === 'un') walk(x.a);
    else if (x.k === 'bin') {
      walk(x.a);
      walk(x.b);
    } else if (x.k !== 'num') throw new DnclError(1, '論理式に使えるのは変数・0・1・and・or・not と ( ) だけ');
  };
  walk(e);
  const vars = [...names].sort();
  if (vars.length > 6) throw new DnclError(1, '変数は6個まで');
  const rows: { inputs: number[]; out: number }[] = [];
  for (let m = 0; m < 1 << vars.length; m++) {
    const inputs = vars.map((_, i) => (m >> (vars.length - 1 - i)) & 1);
    const it = new Interp({});
    vars.forEach((v, i) => it.vars.set(v, inputs[i]));
    const out = truthy(it.eval(e, 1), 1) ? 1 : 0;
    rows.push({ inputs, out });
  }
  return { vars, rows };
}

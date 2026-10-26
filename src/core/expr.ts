// A small math expression parser for y = f(x) as students write it: implicit products
// (2x, 3sin x, (x+1)(x-2)), sin x without parentheses, sin^2 x, |x|, √x, x², π, log_2 x.
// Compiled to closures; nothing is ever passed to eval.

export type Fn = (x: number) => number;

export class ExprError extends Error {}

const FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sec: (v) => 1 / Math.cos(v),
  csc: (v) => 1 / Math.sin(v),
  cot: (v) => 1 / Math.tan(v),
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  // 数III: log without a base is the natural logarithm.
  log: Math.log,
  floor: Math.floor,
  ceil: Math.ceil,
  sign: Math.sign,
};
const CONSTS: Record<string, number> = { pi: Math.PI, π: Math.PI, e: Math.E };
/** Longest first, so "sinh" wins over "sin" and "arcsin" over "a…". */
const NAMES = [...Object.keys(FUNCS), ...Object.keys(CONSTS), 'x'].sort((a, b) => b.length - a.length);

type Tok =
  | { t: 'num'; v: number }
  | { t: 'x' }
  | { t: 'const'; v: number }
  | { t: 'fn'; f: (v: number) => number; base?: number }
  | { t: 'op'; v: string };

/** Unicode the way people type math on a tablet keyboard → plain ASCII-ish. */
export function normalizeExpr(src: string): string {
  return src
    .replace(/[²]/g, '^2')
    .replace(/[³]/g, '^3')
    .replace(/[×·∙⋅]/g, '*')
    .replace(/÷/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/√/g, 'sqrt')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^\s*(y|[a-z]\s*\(\s*x\s*\))\s*=/, '');
}

function tokenize(src: string): Tok[] {
  const s = normalizeExpr(src);
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (num) {
      out.push({ t: 'num', v: parseFloat(num[1]) });
      i += num[1].length;
      continue;
    }
    if ('+-*/^(),|'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    const word = /^[a-zπ]+/.exec(s.slice(i));
    if (!word) throw new ExprError(`「${c}」は使えない`);
    // Split a run of letters into known names ("xsinx" → x sin x).
    let w = word[0];
    i += w.length;
    while (w) {
      const name = NAMES.find((n) => w.startsWith(n));
      if (!name) throw new ExprError(`「${w}」が読めない`);
      w = w.slice(name.length);
      if (name === 'x') out.push({ t: 'x' });
      else if (name in CONSTS) out.push({ t: 'const', v: CONSTS[name] });
      else {
        const tok: Tok = { t: 'fn', f: FUNCS[name] };
        // log_2 x / log_{10}(x)
        if (name === 'log' && !w && s[i] === '_') {
          const b = /^_\{?(\d+\.?\d*)\}?/.exec(s.slice(i));
          if (!b) throw new ExprError('log_ の後に底を書く（例: log_2 x）');
          tok.base = parseFloat(b[1]);
          i += b[0].length;
        }
        out.push(tok);
      }
    }
  }
  return out;
}

class Parser {
  private i = 0;
  private absDepth = 0;
  constructor(private toks: Tok[]) {}

  parse(): Fn {
    if (!this.toks.length) throw new ExprError('式が空');
    const f = this.expr();
    if (this.i < this.toks.length) throw new ExprError(this.describe(this.toks[this.i]) + ' の位置がおかしい');
    return f;
  }

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === 'op' && t.v === v;
  }
  private expect(v: string) {
    if (!this.isOp(v)) throw new ExprError(`「${v}」が足りない`);
    this.i++;
  }
  private describe(t: Tok): string {
    return t.t === 'op' ? `「${t.v}」` : t.t === 'num' ? `「${t.v}」` : '記号';
  }

  /** Can the next token begin an implicitly multiplied factor? */
  private startsFactor(): boolean {
    const t = this.peek();
    if (!t) return false;
    if (t.t !== 'op') return true;
    return t.v === '(' || (t.v === '|' && this.absDepth === 0);
  }

  private expr(): Fn {
    let f = this.term();
    for (;;) {
      if (this.isOp('+')) {
        this.i++;
        const a = f, b = this.term();
        f = (x) => a(x) + b(x);
      } else if (this.isOp('-')) {
        this.i++;
        const a = f, b = this.term();
        f = (x) => a(x) - b(x);
      } else return f;
    }
  }

  private term(): Fn {
    let f = this.unary();
    for (;;) {
      if (this.isOp('*')) {
        this.i++;
        const a = f, b = this.unary();
        f = (x) => a(x) * b(x);
      } else if (this.isOp('/')) {
        this.i++;
        const a = f, b = this.unary();
        f = (x) => a(x) / b(x);
      } else if (this.startsFactor()) {
        const a = f, b = this.power();
        f = (x) => a(x) * b(x);
      } else return f;
    }
  }

  private unary(): Fn {
    if (this.isOp('-')) {
      this.i++;
      const a = this.unary();
      return (x) => -a(x);
    }
    if (this.isOp('+')) {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  private power(): Fn {
    const base = this.primary();
    if (!this.isOp('^')) return base;
    this.i++;
    const e = this.unary();
    return (x) => Math.pow(base(x), e(x));
  }

  private primary(): Fn {
    const t = this.peek();
    if (!t) throw new ExprError('式が途中で終わっている');
    this.i++;
    switch (t.t) {
      case 'num':
      case 'const': {
        const v = t.v;
        return () => v;
      }
      case 'x':
        return (x) => x;
      case 'fn':
        return this.call(t.f, t.base);
      case 'op':
        if (t.v === '(') {
          const f = this.expr();
          this.expect(')');
          return f;
        }
        if (t.v === '|') {
          this.absDepth++;
          const f = this.expr();
          this.absDepth--;
          this.expect('|');
          return (x) => Math.abs(f(x));
        }
        throw new ExprError(`${this.describe(t)} の位置がおかしい`);
    }
  }

  /** sin x, sin(x), sin 2x, sin^2 x, log_2 x. */
  private call(fn: (v: number) => number, base?: number): Fn {
    let pow: Fn | null = null;
    if (this.isOp('^')) {
      this.i++;
      pow = this.primary();
    }
    let arg: Fn;
    if (this.isOp('(')) {
      this.i++;
      arg = this.expr();
      this.expect(')');
    } else {
      // Without parentheses the argument runs over the following product, up to the next
      // function: sin 2x cos x = sin(2x)·cos(x).
      arg = this.power();
      for (;;) {
        const t = this.peek();
        if (!t || t.t === 'fn' || t.t === 'op') break;
        const a = arg, b = this.power();
        arg = (x) => a(x) * b(x);
      }
    }
    const lb = base ? Math.log(base) : 1;
    const f: Fn = base ? (x) => Math.log(arg(x)) / lb : (x) => fn(arg(x));
    if (!pow) return f;
    const p = pow;
    return (x) => Math.pow(f(x), p(x));
  }
}

/** Parse y = f(x). Throws ExprError with a message meant for the user. */
export function parseExpr(src: string): Fn {
  return new Parser(tokenize(src)).parse();
}

/** A constant like "-2π" or "3/2" (range fields). */
export function parseNumber(src: string): number {
  const v = parseExpr(src)(0);
  if (!Number.isFinite(v)) throw new ExprError('数になっていない');
  return v;
}

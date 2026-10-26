/** 情報Ⅰ: 基数変換, 2の補数, ビット演算, 文字コード. */

export type Base = 2 | 8 | 10 | 16;

const DIGITS = { 2: /^[01]+$/, 8: /^[0-7]+$/, 10: /^\d+$/, 16: /^[0-9a-f]+$/i } as const;

/** A non-negative whole number written in `base` (spaces and underscores ignored); null if it isn't one. */
export function parseBase(s: string, base: Base): number | null {
  const t = s.replace(/[\s_]/g, '').normalize('NFKC');
  if (!t || !DIGITS[base].test(t)) return null;
  const n = parseInt(t, base);
  return Number.isSafeInteger(n) ? n : null;
}

/** `n` in `base`, binary grouped by 4 bits. */
export function toBase(n: number, base: Base): string {
  const s = n.toString(base).toUpperCase();
  if (base !== 2) return s;
  const padded = s.padStart(Math.ceil(s.length / 4) * 4, '0');
  return padded.replace(/(.{4})(?=.)/g, '$1 ');
}

/** `n` as a `bits`-bit two's complement pattern; null when it doesn't fit. */
export function twosComplement(n: number, bits: number): string | null {
  const min = -(2 ** (bits - 1)), max = 2 ** (bits - 1) - 1;
  if (!Number.isInteger(n) || n < min || n > max) return null;
  const u = n < 0 ? 2 ** bits + n : n;
  return u.toString(2).padStart(bits, '0');
}

/** The signed value of a two's complement bit pattern. */
export function fromTwos(bitsStr: string): number | null {
  const b = bitsStr.replace(/\s/g, '');
  if (!/^[01]+$/.test(b) || b.length > 32) return null;
  const u = parseInt(b, 2);
  return b[0] === '1' ? u - 2 ** b.length : u;
}

export type BitOp = 'AND' | 'OR' | 'XOR';

export function bitOp(a: number, b: number, op: BitOp, bits: number): string {
  const r = op === 'AND' ? a & b : op === 'OR' ? a | b : a ^ b;
  const mask = bits >= 32 ? 0xffffffff : 2 ** bits - 1;
  return (((r >>> 0) & mask) >>> 0).toString(2).padStart(bits, '0');
}

/** A character's Unicode code point and UTF-8 bytes (hex). */
export function charCodes(ch: string): { char: string; codePoint: string; utf8: string[] }[] {
  const enc = new TextEncoder();
  return [...ch].slice(0, 12).map((c) => ({
    char: c,
    codePoint: 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'),
    utf8: [...enc.encode(c)].map((b) => b.toString(16).toUpperCase().padStart(2, '0')),
  }));
}

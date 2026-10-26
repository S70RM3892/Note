import { describe, expect, it } from 'vitest';
import { runDncl, truthTable } from '../../src/hub/dncl';

// 大学入試センター「試作問題『情報』の概要」５．共通テスト用プログラム表記の例示 (二分探索), as printed.
const BINARY_SEARCH = `( 1 ) Data=[3,18,29,33,48,52,62,77,89,97]
( 2 ) kazu=要素数(Data)
( 3 ) 表示する("0～99の数字を入力してください")
( 4 ) atai=【外部からの入力】
( 5 ) hidari=0 , migi=kazu-1
( 6 ) owari=0
( 7 ) hidari <= migi and owari==0 の間繰り返す:
( 8 ) ｜ aida=(hidari+migi)÷2 # 演算子÷は商の整数値を返す
( 9 ) ｜ もし Data[aida]==atai ならば:
(10) ｜ ｜表示する(atai,"は",aida,"番目にありました")
(11) ｜ ｜owari=1
(12) ｜ そうでなくもし Data[aida]<atai ならば:
(13) ｜ ｜hidari=aida+1
(14) ｜ そうでなければ:
(15) ⎿ ⎿migi=aida-1
(16) もし owari==0 ならば:
(17) ⎿ 表示する(atai,"は見つかりませんでした")
(18) 表示する("添字"," ","要素")
(19) iを0からkazu-1まで1ずつ増やしながら繰り返す:
(20) ⎿ 表示する(i," ",Data[ i])`;

describe('共通テスト用プログラム表記', () => {
  it('runs the 二分探索 example of the 例示 as printed, found and not found', () => {
    const found = runDncl(BINARY_SEARCH, { inputs: ['52'] });
    expect(found.error).toBeUndefined();
    expect(found.output.slice(0, 2)).toEqual(['0～99の数字を入力してください', '52は5番目にありました']);
    expect(found.output[2]).toBe('添字 要素');
    expect(found.output.slice(3)).toEqual(['0 3', '1 18', '2 29', '3 33', '4 48', '5 52', '6 62', '7 77', '8 89', '9 97']);

    const missing = runDncl(BINARY_SEARCH, { inputs: ['85'] });
    expect(missing.output[1]).toBe('85は見つかりませんでした');
    // The trace shows each comparison of the search.
    const conds = missing.trace.filter((r) => r.line === 7).map((r) => r.note);
    expect(conds[conds.length - 1]).toBe('→ 偽（抜ける）');
    expect(missing.vars.owari).toBe('0');
  });

  it('the other examples of the 例示: strings, several statements on a line, fill, ÷ % **, else-if, counting down', () => {
    const r = runDncl(`moji = "I'll be back."
message = "祇園精舎の" + "鐘の声"
kosu = 3 , kingaku = 300
kingaku_goukei = kingaku * kosu
Tokuten = [5, 6, 7]
Tokutenのすべての値を0にする
表示する(message, kingaku_goukei, Tokuten)
表示する(7 ÷ 2, " ", 7 % 2, " ", 2 ** 10, " ", 7 / 2, " ", -7 ÷ 2)
x = 5
もし x < 3 ならば:
｜ x = x + 1
そうでなくもし x < 0 ならば:
｜ x = x * 2
そうでなければ:
⎿ x = x – 1
goukei = 0
n を 3 から 1 まで 1 ずつ減らしながら繰り返す:
⎿ goukei = goukei * 10 + n
表示する(x, " ", goukei)`);
    expect(r.error).toBeUndefined();
    expect(r.output).toEqual(['祇園精舎の鐘の声900[0, 0, 0]', '3 1 1024 3.5 -4', '4 321']);
  });

  it('two-dimensional arrays, arrays that grow, 整数(乱数()), plain indentation and full-width symbols', () => {
    const r = runDncl(
      `Data[1, 2] = 7
表示する(要素数(Data), " ", 要素数(Data[1]), " ", Data[1,2])
saikoro = 整数(乱数()*6)+1
i ＝ 0
i ≦ 2 の間繰り返す:
    表示する(i)
    i = i + 1
表示する(saikoro)`,
      { random: () => 0.99 },
    );
    expect(r.error).toBeUndefined();
    expect(r.output).toEqual(['2 3 7', '0', '1', '2', '6']);
  });

  it('says what is wrong and where, in Japanese', () => {
    expect(runDncl('x = y + 1').error).toEqual({ line: 1, message: '変数 y にまだ値が入っていない' });
    expect(runDncl('A = [1, 2]\n表示する(A[2])').error?.message).toContain('範囲外');
    expect(runDncl('もし 1 == 1 ならば:\nx = 1').error).toMatchObject({ line: 1 });
    expect(runDncl('x = 1\n｜ y = 2').error?.message).toContain('多い');
    expect(runDncl('x = 0\nx < 1 の間繰り返す:\n⎿ y = 1', { maxSteps: 500 }).error?.message).toContain('終わらないループ');
    expect(runDncl('a = 【外部からの入力】').error?.message).toContain('足りない');
    expect(runDncl('表示する(1 ÷ 0)').error?.message).toContain('0 で割った');
    expect(runDncl('x = 二進(5)').error?.message).toContain('関数「二進」');
    expect(runDncl('そうでなければ:\n⎿ x = 1').error?.message).toContain('もし');
  });

  it('keeps a trace row per step with the variables after it', () => {
    const r = runDncl('a = 1\nb = a + 1\n表示する(a + b)');
    expect(r.trace.map((t) => [t.line, t.vars])).toEqual([
      [1, { a: '1' }],
      [2, { a: '1', b: '2' }],
      [3, { a: '1', b: '2' }],
    ]);
    expect(r.trace[2].note).toBe('表示: 3');
  });
});

describe('論理回路の真理値表', () => {
  it('evaluates and / or / not over every input, also written with symbols', () => {
    expect(truthTable('A and not B').rows.map((r) => r.out)).toEqual([0, 0, 1, 0]);
    const t = truthTable('(A ∨ B) ∧ ¬C');
    expect(t.vars).toEqual(['A', 'B', 'C']);
    expect(t.rows.filter((r) => r.out).map((r) => r.inputs.join(''))).toEqual(['010', '100', '110']);
  });
});

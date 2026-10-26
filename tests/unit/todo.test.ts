import { describe, expect, it } from 'vitest';
import { addTodo, pruneTodos, removeTodo, toggleTodo, visibleTodos } from '../../src/study/todo';

const day = (d: number, h = 10) => new Date(2026, 9, d, h).getTime();

describe('今日やること', () => {
  it('open items roll over, finished ones show only on the day they were finished', () => {
    let l = addTodo([], ' 数学 2015 第3問 ', day(26));
    l = addTodo(l, '英単語 100', day(26, 11));
    l = addTodo(l, '   ', day(26));
    expect(l.map((t) => t.text)).toEqual(['数学 2015 第3問', '英単語 100']);
    l = toggleTodo(l, l[1].id, day(26, 20));
    expect(visibleTodos(l, day(26, 21)).map((t) => [t.text, !!t.doneOn])).toEqual([
      ['数学 2015 第3問', false],
      ['英単語 100', true],
    ]);
    // Next day: the open one is still there, the finished one is gone.
    expect(visibleTodos(l, day(27)).map((t) => t.text)).toEqual(['数学 2015 第3問']);
    l = toggleTodo(l, l[1].id, day(27)); // reopen
    expect(visibleTodos(l, day(27))).toHaveLength(2);
    expect(removeTodo(l, l[0].id)).toHaveLength(1);
  });
  it('drops finished items after 30 days', () => {
    let l = addTodo([], 'a', day(1));
    l = toggleTodo(l, l[0].id, day(1));
    l = addTodo(l, 'b', day(1));
    expect(pruneTodos(l, day(30)).map((t) => t.text)).toEqual(['a', 'b']);
    expect(pruneTodos(l, new Date(2026, 10, 5).getTime()).map((t) => t.text)).toEqual(['b']);
  });
});

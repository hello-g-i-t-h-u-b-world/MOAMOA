import { describe, expect, it } from 'vitest';
import { emptyRows, rowsFromStrings } from '../src/core/board';
import { boardsAfterMoves, checkProgress } from '../src/core/progress';
import { solve } from '../src/core/search';

describe('추천 단계 진행 추적', () => {
  const base = rowsFromStrings(Array(16).fill('').map((_, r) => (r === 15 ? '#########.' : '..........')));
  const plan = solve({ rows: base, hand: ['ㅣ', 'ㅡ', null], items: [], inventory: { dot: 0, swap: 0 } })!;
  const usedAtPlan = [false, false, true];
  const afters = boardsAfterMoves(base, plan.moves);
  const slotOf = (k: number) => (plan.moves[k] as { slot: number }).slot;
  const usedAfter = (k: number) => {
    const u = usedAtPlan.slice();
    for (let i = 0; i <= k; i++) u[slotOf(i)] = true;
    return u;
  };

  it('아직 아무것도 안 놓았으면 그대로', () => {
    expect(checkProgress(base, plan.moves, usedAtPlan, 0, base, usedAtPlan)).toEqual({ kind: 'same' });
  });

  it('1단계대로 놓으면 2단계로', () => {
    expect(checkProgress(base, plan.moves, usedAtPlan, 0, afters[0], usedAfter(0))).toEqual({ kind: 'advanced', step: 1 });
  });

  it('인식 오차 1~2칸은 허용', () => {
    const noisy = afters[0].slice();
    noisy[3] ^= 1 << 4;
    expect(checkProgress(base, plan.moves, usedAtPlan, 0, noisy, usedAfter(0))).toEqual({ kind: 'advanced', step: 1 });
  });

  it('두 단계를 빠르게 연달아 놓아도 따라간다', () => {
    expect(checkProgress(base, plan.moves, usedAtPlan, 0, afters[1], usedAfter(1))).toEqual({ kind: 'advanced', step: 2 });
  });

  it('조각은 썼는데 다른 자리에 놓으면 벗어남', () => {
    const wrong = base.slice();
    wrong[0] = 0b11111; // 엉뚱한 곳에 5칸
    const r = checkProgress(base, plan.moves, usedAtPlan, 0, wrong, usedAfter(0));
    expect(r.kind).toBe('deviated');
  });

  it('다른 조각을 먼저 놓으면 벗어남', () => {
    const other = slotOf(1);
    const used = usedAtPlan.slice();
    used[other] = true;
    const r = checkProgress(base, plan.moves, usedAtPlan, 0, afters[0], used);
    expect(r.kind).toBe('deviated');
  });

  it('점 찍기 단계도 그 칸이 채워지면 넘어간다', () => {
    const rows = emptyRows();
    rows[0] = 0b0111111111;
    const p = solve({ rows, hand: [null, null, 'ㅡ'], items: [], inventory: { dot: 1, swap: 0 }, maxDots: 1 })!;
    const dotStep = p.moves.findIndex((m) => m.kind === 'dot');
    if (dotStep < 0) return; // 점 찍기를 추천하지 않은 경우는 건너뜀
    const af = boardsAfterMoves(rows, p.moves);
    const used = [true, true, false];
    for (let i = 0; i <= dotStep; i++) if (p.moves[i].kind === 'piece') used[2] = true;
    expect(checkProgress(rows, p.moves, [true, true, false], dotStep, af[dotStep], used)).toMatchObject({ kind: 'advanced' });
  });
});

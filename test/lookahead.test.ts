import { describe, expect, it } from 'vitest';
import { emptyRows, rowsFromStrings } from '../src/core/board';
import { chooseByLookahead, sampleHands, solveWithLookahead, stateAfter } from '../src/core/lookahead';
import { solve, solveTop, type Plan } from '../src/core/search';

const input = { rows: emptyRows(), hand: ['ㅂ', 'ㅎ', 'ㅑ'] as const, items: [], inventory: { dot: 0, swap: 0 } };

describe('다음 손패 미리 보기', () => {
  it('solveTop: 점수 내림차순이고 1등은 solve와 같다', () => {
    const plans = solveTop({ ...input, hand: [...input.hand] }, 5);
    expect(plans.length).toBe(5);
    for (let i = 1; i < plans.length; i++) expect(plans[i - 1].score).toBeGreaterThanOrEqual(plans[i].score);
    expect(plans[0].finalRows).toEqual(solve({ ...input, hand: [...input.hand] })!.finalRows);
  });

  it('같은 시드면 같은 다음 손패를 뽑는다', () => {
    expect(sampleHands(10, 7)).toEqual(sampleHands(10, 7));
    expect(sampleHands(10, 7)).not.toEqual(sampleHands(10, 8));
    expect(sampleHands(3, 1).every((h) => h.length === 3)).toBe(true);
  });

  it('계획 뒤 상태: 점 찍기 사용과 아이템 획득을 반영 (보유 한도 7)', () => {
    const plan = { finalRows: emptyRows(), finalItems: [], dotsUsed: 1, itemsGained: [{ r: 0, c: 0, type: 'swap' }, { r: 0, c: 1, type: 'swap' }] } as unknown as Plan;
    expect(stateAfter({ ...input, hand: [], inventory: { dot: 2, swap: 0 } }, plan).inventory).toEqual({ dot: 1, swap: 2 });
    expect(stateAfter({ ...input, hand: [], inventory: { dot: 1, swap: 6 } }, plan).inventory).toEqual({ dot: 0, swap: 7 });
  });

  it('다음 손패 점수 평균이 가장 높은 후보를 고른다', () => {
    const plans = solveTop({ ...input, hand: [...input.hand] }, 3);
    const picked = chooseByLookahead({ ...input, hand: [] }, plans, { totals: [10, 50, 20], completes: [10, 9, 10] }, 10);
    expect(picked.finalRows).toEqual(plans[1].finalRows);
    expect(picked.outlook).toEqual({ samples: 10, completeRate: 0.9, candidates: 3 });
  });

  it('미리 보기를 해도 손패를 모두 놓는 계획을 낸다', () => {
    const rows = rowsFromStrings(['####..####', '###.....##', '#...#.#.#.', '#.#.#.#.##']);
    const plan = solveWithLookahead({ rows, hand: ['ㄱ', 'ㅡ', 'ㅏ'], items: [], inventory: { dot: 0, swap: 0 } }, { candidates: 4, samples: 6, beam: 10, finalists: 4 });
    expect(plan?.complete).toBe(true);
    expect(plan?.moves.filter((m) => m.kind === 'piece')).toHaveLength(3);
    expect(plan?.outlook?.samples).toBe(6);
  });
});

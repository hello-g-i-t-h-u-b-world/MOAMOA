import { describe, expect, it } from 'vitest';
import { emptyRows, rowsFromStrings } from '../src/core/board';
import { localRunner, runLookahead, sampleHands, solveWithLookahead, stateAfter, type LookaheadRunner } from '../src/core/lookahead';
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
    expect(stateAfter({ inventory: { dot: 2, swap: 0 } }, plan).inventory).toEqual({ dot: 1, swap: 2 });
    expect(stateAfter({ inventory: { dot: 1, swap: 6 } }, plan).inventory).toEqual({ dot: 0, swap: 7 });
  });

  it('다음 손패 점수 평균이 가장 높은 후보를 고른다', async () => {
    const plans = solveTop({ ...input, hand: [...input.hand] }, 3);
    const fake: LookaheadRunner = {
      totals: async (states, hands) => ({
        totals: states.map((_, i) => [10, 50, 20][i] * hands.length),
        completes: states.map((_, i) => (i === 1 ? hands.length - 1 : hands.length)),
      }),
      totals2: localRunner.totals2,
    };
    const picked = await runLookahead({ ...input, hand: [] }, plans, { candidates: 3, samples: 10, beam: 8, finalists: 3 }, fake);
    expect(picked.finalRows).toEqual(plans[1].finalRows);
    expect(picked.outlook).toEqual({ samples: 10, completeRate: 0.9, candidates: 3 });
  });

  it('단계별 압축: 걸러진 후보에는 더 계산하지 않고, 남은 후보에 표본을 몰아준다', async () => {
    const plans = solveTop({ ...input, hand: [...input.hand] }, 6);
    const calls: number[] = [];
    const fake: LookaheadRunner = {
      totals: async (states, hands) => {
        calls.push(states.length);
        return { totals: states.map((s) => -s.rows.reduce((a, r) => a + r, 0) * hands.length), completes: states.map(() => hands.length) };
      },
      totals2: localRunner.totals2,
    };
    const picked = await runLookahead({ ...input, hand: [] }, plans, {
      candidates: 6, samples: 4, beam: 8, finalists: 3, stages: [{ keep: 3, samples: 8 }, { keep: 2, samples: 16 }],
    }, fake);
    expect(calls).toEqual([6, 3, 2]);
    expect(picked.outlook?.samples).toBe(4 + 8 + 16);
  });

  it('위기 보강: 1등도 다음 손패를 다 놓을 확률이 낮으면 표본을 더 뽑는다', async () => {
    const plans = solveTop({ ...input, hand: [...input.hand] }, 3);
    const calls: number[] = [];
    const fake: LookaheadRunner = {
      totals: async (states, hands) => {
        calls.push(hands.length);
        return { totals: states.map(() => 0), completes: states.map(() => Math.floor(hands.length / 2)) };
      },
      totals2: localRunner.totals2,
    };
    await runLookahead({ ...input, hand: [] }, plans, { candidates: 3, samples: 10, beam: 8, finalists: 3, crisis: { below: 0.9, samples: 30 } }, fake);
    expect(calls).toEqual([10, 30]);
  });

  it('두 손패 앞까지 보면 연달아 놓을 확률도 알려준다', async () => {
    const rows = rowsFromStrings(['####..####', '###.....##', '#...#.#.#.']);
    const plan = await solveWithLookahead(
      { rows, hand: ['ㄱ', 'ㅡ', 'ㅏ'], items: [], inventory: { dot: 0, swap: 0 } },
      { candidates: 4, samples: 4, beam: 8, finalists: 3, twoStep: { keep: 2, samples: 3, inner: 2 } },
    );
    expect(plan?.complete).toBe(true);
    expect(plan?.outlook?.twoStepRate).toBeGreaterThanOrEqual(0);
    expect(plan?.outlook?.twoStepRate).toBeLessThanOrEqual(1);
  });

  it('미리 보기를 해도 손패를 모두 놓는 계획을 낸다', async () => {
    const rows = rowsFromStrings(['####..####', '###.....##', '#...#.#.#.', '#.#.#.#.##']);
    const plan = await solveWithLookahead({ rows, hand: ['ㄱ', 'ㅡ', 'ㅏ'], items: [], inventory: { dot: 0, swap: 0 } }, { candidates: 4, samples: 6, beam: 10, finalists: 4 });
    expect(plan?.complete).toBe(true);
    expect(plan?.moves.filter((m) => m.kind === 'piece')).toHaveLength(3);
    expect(plan?.outlook?.samples).toBe(6);
  });
});

// 다음 손패 미리 보기 (몬테카를로)
//   1) 이번 손패의 계획 후보 상위 N개를 구하고
//   2) 무작위 다음 손패 K개를 뽑아, 후보마다 그 손패를 가볍게 계산해 본 뒤
//   3) (이번 아이템 가치 + 다음 손패 평균 점수)가 가장 높은 후보를 고른다.
// 모든 후보가 같은 다음 손패로 비교되므로(공통 난수) 표본이 적어도 순위가 안정적이다.
// 다음 손패 계산은 여러 Worker에 나눠 맡길 수 있게 순수 함수로 둔다.
import { INVENTORY_CAP, type Inventory, type Item, type Rows } from './board';
import { PIECE_TYPES, type PieceType } from './pieces';
import { itemValue, solveTop, type Plan, type SolveInput } from './search';
import { DEFAULT_WEIGHTS } from './eval';

export interface LookaheadOptions {
  /** 비교할 후보 수 (1 이하면 미리 보기 안 함) */
  candidates: number;
  /** 뽑아 볼 다음 손패 수 */
  samples: number;
  /** 다음 손패 계산의 빔 폭 / 정밀 평가 수 */
  beam: number;
  finalists: number;
  /** 다음 손패를 뽑는 난수 시드 */
  seed?: number;
}

export const LOOKAHEAD_PRESETS = {
  fast: { candidates: 6, samples: 24, beam: 20, finalists: 6 },
  normal: { candidates: 12, samples: 48, beam: 24, finalists: 8 },
  deep: { candidates: 20, samples: 96, beam: 32, finalists: 10 },
} as const satisfies Record<string, LookaheadOptions>;

/** 계획대로 놓은 뒤의 상태 (다음 손패 계산의 시작점) */
export interface NextState {
  rows: Rows;
  items: Item[];
  inventory: Inventory;
}

export function stateAfter(input: SolveInput, plan: Plan): NextState {
  const inventory = { ...input.inventory };
  inventory.dot -= plan.dotsUsed;
  for (const it of plan.itemsGained) if (inventory.dot + inventory.swap < INVENTORY_CAP) inventory[it.type]++;
  return { rows: plan.finalRows, items: plan.finalItems, inventory };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 블록 등장 확률이 균등하다고 보고 다음 손패를 뽑는다 */
export function sampleHands(count: number, seed: number): PieceType[][] {
  const rand = rng(seed);
  const pick = () => PIECE_TYPES[Math.floor(rand() * PIECE_TYPES.length)];
  return Array.from({ length: count }, () => [pick(), pick(), pick()]);
}

/** 다 놓지 못한 경우의 점수 하한 (search.ts의 UNPLACED_PENALTY × 3) */
const FAIL_SCORE = -3000;

export interface LookaheadTotals {
  /** 후보별 다음 손패 점수 합 */
  totals: number[];
  /** 후보별 다음 손패를 다 놓은 횟수 */
  completes: number[];
}

/** 후보 상태마다 주어진 다음 손패들을 계산해 점수를 더한다 (Worker 하나가 맡는 몫) */
export function lookaheadTotals(
  states: readonly NextState[],
  hands: readonly PieceType[][],
  base: Pick<SolveInput, 'weights' | 'maxDots'>,
  opts: Pick<LookaheadOptions, 'beam' | 'finalists'>,
): LookaheadTotals {
  const totals = states.map(() => 0);
  const completes = states.map(() => 0);
  states.forEach((st, i) => {
    for (const hand of hands) {
      const [plan] = solveTop(
        {
          rows: st.rows,
          hand,
          items: st.items,
          inventory: st.inventory,
          weights: base.weights,
          // 다음 손패에서도 점 찍기는 1번까지만 고려 (속도)
          maxDots: Math.min(base.maxDots ?? 1, 1),
          beam: opts.beam,
          finalists: opts.finalists,
        },
        1,
      );
      totals[i] += plan ? Math.max(plan.score, FAIL_SCORE) : FAIL_SCORE;
      if (plan?.complete) completes[i]++;
    }
  });
  return { totals, completes };
}

/** 미리 보기 결과로 후보 중 하나를 고른다 */
export function chooseByLookahead(
  input: SolveInput,
  plans: readonly Plan[],
  result: LookaheadTotals,
  samples: number,
): Plan {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  let best = 0;
  let bestValue = -Infinity;
  plans.forEach((p, i) => {
    const value = itemValue(p.itemsGained.length, p.dotsUsed, input.inventory, w) + result.totals[i] / samples;
    if (value > bestValue) {
      bestValue = value;
      best = i;
    }
  });
  return {
    ...plans[best],
    outlook: { samples, completeRate: result.completes[best] / samples, candidates: plans.length },
  };
}

/** 미리 보기할 후보 (다 놓을 수 있는 계획만 비교한다) */
export function lookaheadCandidates(input: SolveInput, opts: LookaheadOptions): Plan[] {
  const plans = solveTop(input, Math.max(1, opts.candidates));
  const complete = plans.filter((p) => p.complete);
  return complete.length ? complete : plans.slice(0, 1);
}

/** 한 스레드에서 전부 계산 (시뮬레이터·테스트용). Worker 여러 개로 나누는 건 pool.ts */
export function solveWithLookahead(input: SolveInput, opts: LookaheadOptions): Plan | null {
  const plans = lookaheadCandidates(input, opts);
  if (plans.length <= 1 || opts.candidates <= 1 || opts.samples <= 0) return plans[0] ?? null;
  const hands = sampleHands(opts.samples, opts.seed ?? 1);
  const states = plans.map((p) => stateAfter(input, p));
  return chooseByLookahead(input, plans, lookaheadTotals(states, hands, input, opts), opts.samples);
}

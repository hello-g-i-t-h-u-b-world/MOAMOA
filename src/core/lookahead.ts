// 다음 손패 미리 보기 (몬테카를로)
//   1) 이번 손패의 계획 후보 상위 N개를 구하고
//   2) 무작위 다음 손패 K개를 뽑아, 후보마다 그 손패를 가볍게 계산해 본 뒤
//   3) (이번 아이템 가치 + 다음 손패 평균 점수)가 가장 높은 후보를 고른다.
// 모든 후보가 같은 다음 손패로 비교되므로(공통 난수) 표본이 적어도 순위가 안정적이다.
//
// '최고' 설정은 여기에 더해
//   - 단계별 압축: 적은 표본으로 후보를 걸러 가며 남은 후보에 표본을 몰아준다
//   - 위기 보강: 다음 손패를 다 놓을 확률이 낮으면 표본을 더 뽑는다
//   - 두 손패 앞: 최종 후보는 다음 손패를 놓은 뒤 그다음 손패까지 놓아 본다
// 실제 계산(lookaheadTotals / lookahead2Totals)은 순수 함수라 여러 Worker에 나눠 맡길 수 있다.
import { DROP_EVERY, INVENTORY_CAP, type Inventory, type Item, type Rows } from './board';
import { PIECE_TYPES, type PieceType } from './pieces';
import { itemValue, solveTop, type Plan, type SolveInput } from './search';
import { DEFAULT_WEIGHTS } from './eval';

export interface LookaheadOptions {
  /** 비교할 후보 수 (1 이하면 미리 보기 안 함) */
  candidates: number;
  /** 첫 단계에서 모든 후보에 뽑아 볼 다음 손패 수 */
  samples: number;
  /** 다음 손패 계산의 빔 폭 / 정밀 평가 수 */
  beam: number;
  finalists: number;
  /** 다음 손패를 뽑는 난수 시드 (없으면 보드·손패로 정함) */
  seed?: number;
  /** 이후 단계: 상위 keep개만 남겨 samples개를 더 본다 */
  stages?: readonly { keep: number; samples: number }[];
  /** 1등 후보도 다음 손패를 다 놓을 확률이 below 미만이면 남은 후보에 samples개를 더 본다 */
  crisis?: { below: number; samples: number };
  /** 최종 keep개 후보는 다음 손패 samples개 × 그다음 손패 inner개까지 놓아 본다 */
  twoStep?: { keep: number; samples: number; inner: number };
  /** CPU 코어를 (하나 빼고) 전부 쓴다 */
  allCores?: boolean;
}

export const LOOKAHEAD_PRESETS = {
  fast: { candidates: 6, samples: 24, beam: 20, finalists: 6 },
  normal: { candidates: 12, samples: 48, beam: 24, finalists: 8 },
  deep: { candidates: 20, samples: 96, beam: 32, finalists: 10 },
  max: {
    candidates: 30,
    samples: 48,
    beam: 32,
    finalists: 10,
    stages: [
      { keep: 10, samples: 96 },
      { keep: 4, samples: 192 },
    ],
    crisis: { below: 0.9, samples: 192 },
    twoStep: { keep: 3, samples: 32, inner: 16 },
    allCores: true,
  },
} as const satisfies Record<string, LookaheadOptions>;

/** 계획대로 놓은 뒤의 상태 (다음 손패 계산의 시작점) */
export interface NextState {
  rows: Rows;
  /** 떨어진 순서대로 (새로 떨어진 아이템은 자리를 몰라 넣지 않는다) */
  items: Item[];
  inventory: Inventory;
  dropIn?: number;
}

export function stateAfter(input: Pick<SolveInput, 'inventory' | 'dropIn'>, plan: Plan): NextState {
  const inventory = { ...input.inventory };
  inventory.dot -= plan.dotsUsed;
  for (const it of plan.itemsGained) if (inventory.dot + inventory.swap < INVENTORY_CAP) inventory[it.type]++;
  let dropIn = input.dropIn;
  if (dropIn !== undefined) {
    dropIn -= plan.moves.filter((m) => m.kind === 'piece').length;
    if (dropIn <= 0) dropIn += DROP_EVERY;
  }
  return { rows: plan.finalRows, items: plan.finalItems, inventory, ...(dropIn !== undefined ? { dropIn } : {}) };
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

/** 같은 보드·손패면 같은 다음 손패를 뽑아 '다시 계산'해도 같은 결과가 나오게 한다 */
export function seedOf(rows: Rows, hand: SolveInput['hand']): number {
  let h = 0x811c9dc5;
  for (const r of rows) h = Math.imul(h ^ r, 0x01000193);
  for (const p of hand) h = Math.imul(h ^ (p ? p.charCodeAt(0) : 0), 0x01000193);
  return h >>> 0;
}

/** 다 놓지 못한 경우의 점수 하한 (search.ts의 UNPLACED_PENALTY × 3) */
const FAIL_SCORE = -3000;
/** 두 손패 앞 계산에서 바로 다음 손패부터 못 놓는 경우 (그다음에 막히는 것보다 나쁘다) */
const FAIL_FIRST = FAIL_SCORE - 1000;

export type LookaheadBase = Pick<SolveInput, 'weights' | 'maxDots'>;
export type InnerOptions = Pick<LookaheadOptions, 'beam' | 'finalists'>;

export interface LookaheadTotals {
  /** 후보별 다음 손패 점수 합 */
  totals: number[];
  /** 후보별 다음 손패를 다 놓은 횟수 */
  completes: number[];
}

export interface Lookahead2Totals extends LookaheadTotals {
  /** 후보별 (다음 손패, 그다음 손패)를 둘 다 놓은 쌍의 수 */
  pairCompletes: number[];
}

/** 다음 손패 하나를 가볍게 계산 */
function innerSolve(st: NextState, hand: PieceType[], base: LookaheadBase, opts: InnerOptions): Plan | undefined {
  return solveTop(
    {
      rows: st.rows,
      hand,
      items: st.items,
      inventory: st.inventory,
      dropIn: st.dropIn,
      weights: base.weights,
      // 다음 손패에서도 점 찍기는 1번까지만 고려 (속도)
      maxDots: Math.min(base.maxDots ?? 1, 1),
      beam: opts.beam,
      finalists: opts.finalists,
    },
    1,
  )[0];
}

/** 후보 상태마다 주어진 다음 손패들을 계산해 점수를 더한다 (Worker 하나가 맡는 몫) */
export function lookaheadTotals(
  states: readonly NextState[],
  hands: readonly PieceType[][],
  base: LookaheadBase,
  opts: InnerOptions,
): LookaheadTotals {
  const totals = states.map(() => 0);
  const completes = states.map(() => 0);
  states.forEach((st, i) => {
    for (const hand of hands) {
      const plan = innerSolve(st, hand, base, opts);
      totals[i] += plan ? Math.max(plan.score, FAIL_SCORE) : FAIL_SCORE;
      if (plan?.complete) completes[i]++;
    }
  });
  return { totals, completes };
}

/**
 * 두 손패 앞까지: 다음 손패(hands1)마다 최선으로 놓은 뒤, 그 보드에 그다음 손패(hands2)를 모두 놓아 본다.
 * 다음 손패 하나의 값 = 그 손패의 아이템 가치 + 그다음 손패 평균 점수
 */
export function lookahead2Totals(
  states: readonly NextState[],
  hands1: readonly PieceType[][],
  hands2: readonly PieceType[][],
  base: LookaheadBase,
  opts: InnerOptions,
): Lookahead2Totals {
  const w = base.weights ?? DEFAULT_WEIGHTS;
  const totals = states.map(() => 0);
  const completes = states.map(() => 0);
  const pairCompletes = states.map(() => 0);
  states.forEach((st, i) => {
    for (const h1 of hands1) {
      const p1 = innerSolve(st, h1, base, opts);
      if (!p1?.complete) {
        totals[i] += FAIL_FIRST;
        continue;
      }
      completes[i]++;
      const st1 = stateAfter(st, p1);
      let sub = 0;
      for (const h2 of hands2) {
        const p2 = innerSolve(st1, h2, base, opts);
        sub += p2 ? Math.max(p2.score, FAIL_SCORE) : FAIL_SCORE;
        if (p2?.complete) pairCompletes[i]++;
      }
      totals[i] += itemValue(p1.itemsGained.length, p1.dotsUsed, st.inventory, w) + sub / hands2.length;
    }
  });
  return { totals, completes, pairCompletes };
}

/** 미리 보기할 후보 (다 놓을 수 있는 계획만 비교한다) */
export function lookaheadCandidates(input: SolveInput, opts: LookaheadOptions): Plan[] {
  const plans = solveTop(input, Math.max(1, opts.candidates));
  const complete = plans.filter((p) => p.complete);
  return complete.length ? complete : plans.slice(0, 1);
}

/** 미리 보기 계산을 실제로 수행하는 쪽 (한 스레드 / Worker 여러 개) */
export interface LookaheadRunner {
  totals(states: NextState[], hands: PieceType[][], base: LookaheadBase, opts: InnerOptions): Promise<LookaheadTotals>;
  totals2(
    states: NextState[],
    hands1: PieceType[][],
    hands2: PieceType[][],
    base: LookaheadBase,
    opts: InnerOptions,
  ): Promise<Lookahead2Totals>;
}

/** 한 스레드에서 바로 계산 (시뮬레이터·테스트용) */
export const localRunner: LookaheadRunner = {
  totals: async (s, h, b, o) => lookaheadTotals(s, h, b, o),
  totals2: async (s, h1, h2, b, o) => lookahead2Totals(s, h1, h2, b, o),
};

export type LookaheadPhase = { stage: string; candidates: number; samples: number };

/** 후보 중 미리 보기 결과가 가장 좋은 것을 고른다 (단계별 압축·위기 보강·두 손패 앞 포함) */
export async function runLookahead(
  input: SolveInput,
  plans: readonly Plan[],
  look: LookaheadOptions,
  runner: LookaheadRunner,
  onPhase?: (p: LookaheadPhase) => void,
): Promise<Plan> {
  if (plans.length <= 1 || look.candidates <= 1 || look.samples <= 0) return plans[0];
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const base: LookaheadBase = { weights: input.weights, maxDots: input.maxDots };
  const inner: InnerOptions = { beam: look.beam, finalists: look.finalists };
  const seed = look.seed ?? seedOf(input.rows, input.hand);
  const seedFor = (k: number) => (seed ^ Math.imul(k + 1, 0x9e3779b9)) >>> 0;
  const states = plans.map((p) => stateAfter(input, p));
  const totals = plans.map(() => 0);
  const completes = plans.map(() => 0);
  const counts = plans.map(() => 0);
  const mean = (i: number) => totals[i] / Math.max(1, counts[i]);
  const value = (i: number) => itemValue(plans[i].itemsGained.length, plans[i].dotsUsed, input.inventory, w) + mean(i);
  const topBy = (ids: number[], f: (i: number) => number, k: number) =>
    ids
      .slice()
      .sort((a, b) => f(b) - f(a))
      .slice(0, Math.max(1, k));

  const evaluate = async (ids: number[], samples: number, k: number, stage: string) => {
    onPhase?.({ stage, candidates: ids.length, samples });
    const hands = sampleHands(samples, seedFor(k));
    const r = await runner.totals(
      ids.map((i) => states[i]),
      hands,
      base,
      inner,
    );
    ids.forEach((i, j) => {
      totals[i] += r.totals[j];
      completes[i] += r.completes[j];
      counts[i] += samples;
    });
  };

  // 1단계: 모든 후보 / 이후: 남은 후보에 표본을 더한다 (남은 후보는 모두 같은 손패를 봤으므로 평균끼리 비교 가능)
  let ids = plans.map((_, i) => i);
  await evaluate(ids, look.samples, 0, '1차');
  for (const [k, st] of (look.stages ?? []).entries()) {
    ids = topBy(ids, value, st.keep);
    if (ids.length <= 1) break;
    await evaluate(ids, st.samples, k + 1, `${k + 2}차`);
  }
  if (look.crisis && ids.length > 1) {
    const best = topBy(ids, value, 1)[0];
    if (completes[best] / counts[best] < look.crisis.below) await evaluate(ids, look.crisis.samples, 99, '위기 보강');
  }

  let best = topBy(ids, value, 1)[0];
  let twoStepRate: number | undefined;
  if (look.twoStep && ids.length > 1) {
    const fin = topBy(ids, value, look.twoStep.keep);
    const { samples, inner: n } = look.twoStep;
    onPhase?.({ stage: '두 손패 앞', candidates: fin.length, samples: samples * n });
    const r = await runner.totals2(
      fin.map((i) => states[i]),
      sampleHands(samples, seedFor(200)),
      sampleHands(n, seedFor(201)),
      base,
      inner,
    );
    const v2 = (j: number) =>
      itemValue(plans[fin[j]].itemsGained.length, plans[fin[j]].dotsUsed, input.inventory, w) + r.totals[j] / samples;
    const j = topBy(
      fin.map((_, k) => k),
      v2,
      1,
    )[0];
    best = fin[j];
    twoStepRate = r.pairCompletes[j] / (samples * n);
  }
  return {
    ...plans[best],
    outlook: {
      samples: counts[best],
      completeRate: completes[best] / counts[best],
      candidates: plans.length,
      ...(twoStepRate !== undefined ? { twoStepRate } : {}),
    },
  };
}

/** 한 스레드에서 전부 계산 (시뮬레이터·테스트용). Worker 여러 개로 나누는 건 pool.ts */
export async function solveWithLookahead(input: SolveInput, opts: LookaheadOptions): Promise<Plan | null> {
  const plans = lookaheadCandidates(input, opts);
  if (!plans.length) return null;
  return runLookahead(input, plans, opts, localRunner);
}

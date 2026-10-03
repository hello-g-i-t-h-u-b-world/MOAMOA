import {
  FULL,
  H,
  INVENTORY_CAP,
  W,
  canPlace,
  collectItems,
  placeDot,
  popcount,
  type Inventory,
  type Item,
  type Rows,
} from './board';
import { DEFAULT_WEIGHTS, cheapFeatures, cheapScore, fitFeatures, fitScore, type Weights } from './eval';
import { PIECES, PIECE_TYPES, type PieceType } from './pieces';

export type Move =
  | { kind: 'piece'; slot: number; type: PieceType; orient: number; r: number; c: number; cleared: number[] }
  | { kind: 'dot'; r: number; c: number; cleared: number[] };

export interface Plan {
  moves: Move[];
  score: number;
  /** 손패를 전부 놓았는가 (false면 이 손패로는 게임오버) */
  complete: boolean;
  lines: number;
  itemsGained: Item[];
  dotsUsed: number;
  finalRows: Rows;
  finalItems: Item[];
  /** 다음 손패 미리 보기 결과 (했을 때만) */
  outlook?: Outlook;
}

export interface Outlook {
  /** 무작위로 뽑아 본 다음 손패 수 */
  samples: number;
  /** 그중 다 놓을 수 있었던 비율 */
  completeRate: number;
  /** 비교한 후보 수 */
  candidates: number;
  /** 두 손패 앞까지 본 경우: 다음 손패와 그다음 손패를 연달아 다 놓을 수 있었던 비율 */
  twoStepRate?: number;
}

export interface SolveInput {
  rows: Rows;
  /** 보유 조각 3칸. null = 이미 사용함 */
  hand: (PieceType | null)[];
  items: Item[];
  inventory: Inventory;
  weights?: Weights;
  /** 단계별로 남길 상태 수 */
  beam?: number;
  /** 정밀 평가할 최종 후보 수 */
  finalists?: number;
  /** 한 턴에 고려할 점 찍기 최대 사용 횟수 */
  maxDots?: number;
}

/** 다 놓지 못한 블록 1개당 벌점 */
const UNPLACED_PENALTY = 1000;

interface Node {
  rows: Rows;
  items: Item[];
  remaining: number;
  dotsUsed: number;
  gained: Item[];
  lines: number;
  parent: Node | null;
  move: Move | null;
  score: number;
}

function hashNode(rows: Rows, remaining: number, dotsUsed: number, gained: number): number {
  let h1 = 0x811c9dc5 ^ (remaining * 31 + dotsUsed * 7 + gained);
  let h2 = 0x01000193 + remaining;
  for (let r = 0; r < H; r++) {
    h1 = Math.imul(h1 ^ rows[r], 0x01000193);
    h2 = Math.imul(h2 + rows[r] + r, 0x5bd1e995) ^ (h2 >>> 15);
  }
  return (h1 >>> 0) * 0x100000 + ((h2 >>> 0) & 0xfffff);
}

function movesOf(n: Node): Move[] {
  const out: Move[] = [];
  for (let cur: Node | null = n; cur && cur.move; cur = cur.parent) out.push(cur.move);
  return out.reverse();
}

export function itemValue(gained: number, dotsUsed: number, inv: Inventory, w: Weights): number {
  // 보유 한도를 넘는 아이템은 획득해도 소용없다
  const room = INVENTORY_CAP - (inv.dot + inv.swap) + dotsUsed;
  return Math.min(gained, Math.max(0, room)) * w.itemGain - dotsUsed * w.dotCost;
}

/** 점 찍기 후보 칸: 한 칸만 비어 있는 줄의 빈칸, 사방이 막힌 1칸 구멍 */
function dotCandidates(rows: Rows): [number, number][] {
  const out: [number, number][] = [];
  for (let r = 0; r < H; r++) {
    const x = rows[r];
    const empty = ~x & FULL;
    if (empty === 0) continue;
    if (popcount(x) === W - 1) {
      out.push([r, 31 - Math.clz32(empty)]);
      continue;
    }
    const up = r > 0 ? rows[r - 1] : FULL;
    const down = r + 1 < H ? rows[r + 1] : FULL;
    const holes = empty & up & down & (((x << 1) | 1) & FULL) & ((x >> 1) | (1 << (W - 1)));
    for (let c = 0; c < W; c++) if ((holes >> c) & 1) out.push([r, c]);
  }
  return out;
}

export function solve(input: SolveInput): Plan | null {
  return solveTop(input, 1)[0] ?? null;
}

/**
 * 최종 점수 상위 count개의 계획 (점수 내림차순).
 * 다음 손패 미리 보기(lookahead.ts)에서 후보로 쓴다.
 */
export function solveTop(input: SolveInput, count: number): Plan[] {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const beam = input.beam ?? 150;
  const finalists = input.finalists ?? 60;
  const maxDots = Math.min(input.maxDots ?? 1, input.inventory.dot);
  const hand = input.hand;

  let fullMask = 0;
  hand.forEach((p, i) => {
    if (p) fullMask |= 1 << i;
  });

  const root: Node = {
    rows: input.rows.slice(),
    items: input.items.slice(),
    remaining: fullMask,
    dotsUsed: 0,
    gained: [],
    lines: 0,
    parent: null,
    move: null,
    score: 0,
  };

  const finals = new Map<number, Node>();
  let frontier: Node[] = [root];
  let deepest: Node[] = [root];
  if (fullMask === 0) finals.set(0, root);

  const maxSteps = popcount(fullMask) + maxDots;
  // 단계마다 남길 수 있는 최대 수: 이보다 점수가 낮은 자식은 보드를 복사하지도 않고 버린다
  const keep = Math.max(beam, finalists, count);
  const scratch = new Array<number>(H).fill(0);
  for (let step = 0; step < maxSteps && frontier.length > 0; step++) {
    let children = new Map<number, Node>();
    let cut = -Infinity;
    const prune = () => {
      const top = [...children.values()].sort((a, b) => b.score - a.score).slice(0, keep);
      children = new Map(top.map((n) => [hashNode(n.rows, n.remaining, n.dotsUsed, n.gained.length), n]));
      cut = top[top.length - 1].score;
    };
    /** scratch에 만든 보드를 평가해 남길 만하면 자식으로 추가 */
    const push = (parent: Node, cleared: number[], remaining: number, dotsUsed: number, makeMove: () => Move) => {
      const nGained =
        parent.gained.length +
        (cleared.length && parent.items.length ? parent.items.filter((it) => cleared.includes(it.r)).length : 0);
      const score = cheapScore(cheapFeatures(scratch), w) + itemValue(nGained, dotsUsed, input.inventory, w);
      if (score <= cut) return;
      const key = hashNode(scratch, remaining, dotsUsed, nGained);
      const prev = children.get(key);
      if (prev && prev.score >= score) return;
      const { remaining: items, collected } = collectItems(parent.items, cleared);
      children.set(key, {
        rows: scratch.slice(),
        items,
        remaining,
        dotsUsed,
        gained: collected.length ? parent.gained.concat(collected) : parent.gained,
        lines: parent.lines + cleared.length,
        parent,
        move: makeMove(),
        score,
      });
      if (children.size >= keep * 4) prune();
    };
    const NO_CLEAR: number[] = [];

    for (const node of frontier) {
      const base = node.rows;
      // 블록 배치 (같은 종류가 여러 개면 한 번만 시도)
      const triedTypes = new Set<PieceType>();
      for (let slot = 0; slot < hand.length; slot++) {
        if (!((node.remaining >> slot) & 1)) continue;
        const type = hand[slot]!;
        if (triedTypes.has(type)) continue;
        triedTypes.add(type);
        const orients = PIECES[type].orientations;
        const remaining = node.remaining & ~(1 << slot);
        for (let oi = 0; oi < orients.length; oi++) {
          const o = orients[oi];
          for (let r = 0; r <= H - o.h; r++) {
            for (let c = 0; c <= W - o.w; c++) {
              if (!canPlace(base, o, r, c)) continue;
              // place()와 같지만 보드를 새로 만들지 않고 scratch에 쓴다
              for (let i = 0; i < H; i++) scratch[i] = base[i];
              let cleared = NO_CLEAR;
              for (let i = 0; i < o.h; i++) {
                const v = scratch[r + i] | (o.rows[i] << c);
                if (v === FULL) {
                  scratch[r + i] = 0;
                  if (cleared === NO_CLEAR) cleared = [];
                  cleared.push(r + i);
                } else scratch[r + i] = v;
              }
              push(node, cleared, remaining, node.dotsUsed, () => ({
                kind: 'piece',
                slot,
                type,
                orient: oi,
                r,
                c,
                cleared,
              }));
            }
          }
        }
      }
      // 점 찍기
      if (node.dotsUsed < maxDots) {
        for (const [r, c] of dotCandidates(base)) {
          const res = placeDot(base, r, c);
          for (let i = 0; i < H; i++) scratch[i] = res.rows[i];
          push(node, res.cleared, node.remaining, node.dotsUsed + 1, () => ({
            kind: 'dot',
            r,
            c,
            cleared: res.cleared,
          }));
        }
      }
    }

    const all = [...children.values()];
    for (const n of all) {
      if (n.remaining === 0) {
        const key = hashNode(n.rows, 0, n.dotsUsed, n.gained.length);
        const prev = finals.get(key);
        if (!prev || prev.score < n.score) finals.set(key, n);
      }
    }
    all.sort((a, b) => b.score - a.score);
    frontier = all.slice(0, beam);
    if (frontier.length > 0) {
      const placedNow = (n: Node) => popcount(fullMask & ~n.remaining);
      const bestDepth = Math.max(...frontier.map(placedNow));
      const curDepth = deepest.length ? placedNow(deepest[0]) : 0;
      if (bestDepth >= curDepth) deepest = frontier.filter((n) => placedNow(n) === bestDepth);
    }
  }

  const complete = finals.size > 0;
  const pool = complete ? [...finals.values()] : deepest;
  pool.sort((a, b) => b.score - a.score);
  const scored = pool
    .slice(0, Math.max(finalists, count))
    .map((n) => ({ n, s: n.score + fitScore(fitFeatures(n.rows), w) - popcount(n.remaining) * UNPLACED_PENALTY }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, count).map(({ n, s }) => ({
    moves: movesOf(n),
    score: s,
    complete: n.remaining === 0,
    lines: n.lines,
    itemsGained: n.gained,
    dotsUsed: n.dotsUsed,
    finalRows: n.rows,
    finalItems: n.items,
  }));
}

export interface SwapAdvice {
  slot: number;
  type: PieceType;
  /** 교체 시 기대 점수 - 현재 점수 */
  gain: number;
  /** 교체 후 손패를 다 놓을 수 있는 확률 (근사) */
  completeRate: number;
}

/**
 * 바꿔 뽑기 분석: 각 칸을 무작위 블록으로 바꿨을 때의 기대 점수를 계산한다.
 * 블록 등장 확률은 균등하다고 가정한다.
 */
export function analyzeSwaps(input: SolveInput): SwapAdvice[] {
  if (input.inventory.swap <= 0) return [];
  const out: SwapAdvice[] = [];
  const fast = { ...input, beam: Math.min(input.beam ?? 150, 40), finalists: Math.min(input.finalists ?? 60, 15) };
  // 같은 탐색 설정으로 비교해야 공정하다
  const basePlan = solve(fast);
  const baseScore = basePlan ? basePlan.score : -UNPLACED_PENALTY * 3;
  input.hand.forEach((type, slot) => {
    if (!type) return;
    let sum = 0;
    let completeCount = 0;
    for (const t of PIECE_TYPES) {
      const hand = input.hand.slice();
      hand[slot] = t;
      const plan = solve({ ...fast, hand });
      sum += plan ? plan.score : -UNPLACED_PENALTY * 3;
      if (plan?.complete) completeCount++;
    }
    out.push({
      slot,
      type,
      gain: sum / PIECE_TYPES.length - baseScore,
      completeRate: completeCount / PIECE_TYPES.length,
    });
  });
  return out.sort((a, b) => b.gain - a.gain);
}

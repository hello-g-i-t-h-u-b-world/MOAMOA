import {
  FULL,
  H,
  INVENTORY_CAP,
  W,
  canPlace,
  collectItems,
  place,
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

function itemValue(gained: number, dotsUsed: number, inv: Inventory, w: Weights): number {
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
  for (let step = 0; step < maxSteps && frontier.length > 0; step++) {
    const children = new Map<number, Node>();
    const push = (parent: Node, rows: Rows, cleared: number[], remaining: number, dotsUsed: number, move: Move) => {
      const { remaining: items, collected } = collectItems(parent.items, cleared);
      const gained = collected.length ? parent.gained.concat(collected) : parent.gained;
      const key = hashNode(rows, remaining, dotsUsed, gained.length);
      const score =
        cheapScore(cheapFeatures(rows), w) + itemValue(gained.length, dotsUsed, input.inventory, w);
      const prev = children.get(key);
      if (prev && prev.score >= score) return;
      children.set(key, {
        rows,
        items,
        remaining,
        dotsUsed,
        gained,
        lines: parent.lines + cleared.length,
        parent,
        move,
        score,
      });
    };

    for (const node of frontier) {
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
              if (!canPlace(node.rows, o, r, c)) continue;
              const res = place(node.rows, o, r, c);
              push(node, res.rows, res.cleared, remaining, node.dotsUsed, {
                kind: 'piece',
                slot,
                type,
                orient: oi,
                r,
                c,
                cleared: res.cleared,
              });
            }
          }
        }
      }
      // 점 찍기
      if (node.dotsUsed < maxDots) {
        for (const [r, c] of dotCandidates(node.rows)) {
          const res = placeDot(node.rows, r, c);
          push(node, res.rows, res.cleared, node.remaining, node.dotsUsed + 1, {
            kind: 'dot',
            r,
            c,
            cleared: res.cleared,
          });
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
  let best: Node | null = null;
  let bestScore = -Infinity;
  for (const n of pool.slice(0, finalists)) {
    const s = n.score + fitScore(fitFeatures(n.rows), w) - popcount(n.remaining) * UNPLACED_PENALTY;
    if (s > bestScore) {
      bestScore = s;
      best = n;
    }
  }
  if (!best) return null;
  return {
    moves: movesOf(best),
    score: bestScore,
    complete: best.remaining === 0,
    lines: best.lines,
    itemsGained: best.gained,
    dotsUsed: best.dotsUsed,
    finalRows: best.rows,
    finalItems: best.items,
  };
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

// 게임 규칙 (게임 안내 화면 기준): 단계별 조각 등장 확률, 능력 등장 확률, 점수
import { PIECE_TYPES, type PieceType } from './pieces';
import pieceStats from './piece-stats.json';

// ───────────── 단계 ─────────────

/** 제거한 가로줄 누적 개수 → 단계 (1: 0~30줄, 2: 31~60, 3: 61~100, 4: 101~150, 5: 151줄~) */
export function stageOf(lines: number): number {
  if (lines <= 30) return 1;
  if (lines <= 60) return 2;
  if (lines <= 100) return 3;
  if (lines <= 150) return 4;
  return 5;
}

export const STAGE_RANGES = ['0~30줄', '31~60줄', '61~100줄', '101~150줄', '151줄~'] as const;

/**
 * 단계별 조각 등장 확률 — 실제 플레이에서 받은 조각을 센 통계(piece-stats.json)로 추정한다.
 * 게임 안내는 "단계가 오를수록 칸 수가 적은 조각이 덜 나온다"고만 하고 값은 공개하지 않는다.
 * 관측 결과 같은 칸 수끼리도 빈도가 크게 달라(예: 5단계 ㄹ 13%, ㅁ 8%, ㅂ 2%) 조각마다 따로 추정한다.
 *
 * 단계마다 표본 수가 달라서(5단계가 대부분) 표본이 적은 단계는 전체 단계를 합친 분포 쪽으로 당긴다:
 *   p(조각) ∝ 그 단계에서 센 수 + PRIOR_WEIGHT × 전체 합친 비율 + 0.5
 * 통계가 더 모이면 scripts/merge-digits.ts --write로 piece-stats.json에 더하기만 하면 된다.
 */
const PRIOR_WEIGHT = 30;

export type PieceProbs = Record<PieceType, number>;
type Counts = Record<string, Record<string, number>>;

function estimate(stats: Counts): PieceProbs[] {
  const pooled = PIECE_TYPES.map((t) => Object.values(stats).reduce((a, st) => a + (st[t] ?? 0), 0));
  const pooledSum = pooled.reduce((a, b) => a + b, 0);
  const out: PieceProbs[] = [];
  for (let s = 1; s <= 5; s++) {
    const st = stats[String(s)] ?? {};
    const w = PIECE_TYPES.map(
      (t, i) => (st[t] ?? 0) + (pooledSum ? (PRIOR_WEIGHT * pooled[i]) / pooledSum : PRIOR_WEIGHT / PIECE_TYPES.length) + 0.5,
    );
    const sum = w.reduce((a, b) => a + b, 0);
    out.push(Object.fromEntries(PIECE_TYPES.map((t, i) => [t, w[i] / sum])) as PieceProbs);
  }
  return out;
}

let table = estimate(pieceStats as Counts);

/** 시뮬레이터 실험용: 다른 통계(또는 {} = 모든 조각 균등)로 바꾼다 */
export function setPieceStats(stats: Counts) {
  table = estimate(stats);
}

export function pieceProbs(stage = 1): PieceProbs {
  return table[Math.max(1, Math.min(5, Math.round(stage))) - 1];
}

/** 0~1 난수로 조각 하나를 뽑는다 */
export function pickPiece(rand: () => number, probs: PieceProbs): PieceType {
  let x = rand();
  for (const t of PIECE_TYPES) {
    x -= probs[t];
    if (x < 0) return t;
  }
  return PIECE_TYPES[PIECE_TYPES.length - 1];
}

// ───────────── 능력 ─────────────

/** 능력 아이콘 종류 확률: 점 찍기 40%, 바꿔 뽑기 60% */
export const DOT_PROB = 0.4;

// ───────────── 점수 ─────────────

/** 동시에 제거한 줄 수에 따른 점수: 1줄 300 · 2줄 1,200 · 3줄 2,700 · 4줄 4,800 · 5줄 7,500 (= 300 × 줄²) */
export function linePoints(lines: number): number {
  return 300 * lines * lines;
}

/** 능력 1개 획득 점수 */
export const ITEM_POINTS = 50;

/** 조각 배치 점수 = 칸 수 (점 찍기 1칸 포함) */

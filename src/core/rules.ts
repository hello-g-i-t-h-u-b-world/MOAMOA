// 게임 규칙 (게임 안내 화면 기준): 단계별 조각 등장 확률, 능력 등장 확률, 점수
import { PIECES, PIECE_TYPES, type PieceType } from './pieces';

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
 * 단계별 조각 등장 확률.
 * 게임 안내: "단계가 올라갈수록 칸수가 적은 조각이 덜 등장한다" — 정확한 값은 공개되지 않아
 * 가정값을 쓴다: 1단계는 균등, 이후 단계는 (칸 수)^γ에 비례 (γ = 0, 0.25, 0.5, 0.75, 1).
 * 실제 플레이에서 관측한 조각 통계가 모이면 이 표를 실제 값으로 바꾼다.
 */
let STAGE_GAMMA = [0, 0.25, 0.5, 0.75, 1];

/** 시뮬레이터 실험용: 단계별 γ를 바꾼다 */
export function setStageGamma(g: number[]) {
  STAGE_GAMMA = g.slice(0, 5);
  probCache.clear();
}

export type PieceProbs = Record<PieceType, number>;
const probCache = new Map<number, PieceProbs>();

export function pieceProbs(stage = 1): PieceProbs {
  const s = Math.max(1, Math.min(5, Math.round(stage)));
  let p = probCache.get(s);
  if (!p) {
    const g = STAGE_GAMMA[s - 1];
    const raw = PIECE_TYPES.map((t) => Math.pow(PIECES[t].size, g));
    const sum = raw.reduce((a, b) => a + b, 0);
    p = Object.fromEntries(PIECE_TYPES.map((t, i) => [t, raw[i] / sum])) as PieceProbs;
    probCache.set(s, p);
  }
  return p;
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

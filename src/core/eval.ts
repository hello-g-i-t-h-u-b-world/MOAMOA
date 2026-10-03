import { FULL, H, W, popcount, type Rows } from './board';
import { PIECES, PIECE_TYPES, type Orientation } from './pieces';

/**
 * 평가 가중치. 값이 클수록 좋은 보드.
 * scripts/sim.ts 의 자가 대국으로 조정한다.
 */
export interface Weights {
  /** 채워진 칸 1개당 */
  filled: number;
  /** 가로 방향 빈칸/채움 경계 1개당 (울퉁불퉁함) */
  rowTrans: number;
  /** 세로 방향 경계 1개당 */
  colTrans: number;
  /** 사방이 막힌 1칸 구멍 1개당 */
  hole1: number;
  /** Σ(행의 채운 칸 수)² / 10 — 한 줄에 몰아 채울수록 지우기 쉽다 */
  rowFillSq: number;
  /** 어디에도 놓을 수 없는 블록 종류 1개당 */
  noFit: number;
  /** Σ log2(1 + 블록별 놓을 수 있는 자리 수) */
  mobility: number;
  /** 아래아(·)/점 찍기로만 채울 수 있는 칸 1개당 */
  dead: number;
  /** 아이템 1개 획득 가치 */
  itemGain: number;
  /** 점 찍기 1회 사용 비용 */
  dotCost: number;
  /** 바꿔 뽑기 1회 사용 비용 (기대값 이득이 이보다 커야 추천) */
  swapCost: number;
  /**
   * 게임 점수 1점의 가치. 줄 제거 점수가 300×(동시에 지운 줄)²이라 여러 줄을 한 번에 지울수록 크게 이득.
   * 너무 크면 점수를 노리다 막혀 죽고, 작으면 한 줄씩만 지운다 (scripts/sim.ts로 조정)
   */
  points: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  filled: -1,
  rowTrans: -0.79,
  colTrans: -0.425,
  hole1: -2.55,
  rowFillSq: 0.212,
  noFit: -31.6,
  mobility: 0.67,
  dead: -2.49,
  itemGain: 14.75,
  dotCost: 8.2,
  swapCost: 5.8,
  points: 0.02,
};

const POP12 = new Uint8Array(1 << 12);
for (let i = 1; i < POP12.length; i++) POP12[i] = POP12[i >> 1] + (i & 1);

export interface CheapFeatures {
  filled: number;
  rowTrans: number;
  colTrans: number;
  hole1: number;
  rowFillSq: number;
}

export function cheapFeatures(rows: Rows): CheapFeatures {
  let filled = 0;
  let rowTrans = 0;
  let colTrans = 0;
  let hole1 = 0;
  let rowFillSq = 0;
  let prev = FULL; // 위쪽 벽
  for (let r = 0; r < H; r++) {
    const x = rows[r];
    const p = popcount(x);
    filled += p;
    rowFillSq += p * p;
    // 좌우 벽을 채워진 칸으로 보고 경계 개수를 센다
    const y = (x << 1) | 1 | (1 << (W + 1));
    rowTrans += POP12[(y ^ (y >> 1)) & ((1 << (W + 1)) - 1)];
    colTrans += popcount(x ^ prev);
    const up = prev;
    const down = r + 1 < H ? rows[r + 1] : FULL;
    const left = ((x << 1) | 1) & FULL;
    const right = (x >> 1) | (1 << (W - 1));
    hole1 += popcount(~x & FULL & up & down & left & right);
    prev = x;
  }
  colTrans += popcount(prev ^ FULL); // 아래쪽 벽
  return { filled, rowTrans, colTrans, hole1, rowFillSq: rowFillSq / 10 };
}

export function cheapScore(f: CheapFeatures, w: Weights): number {
  return (
    f.filled * w.filled +
    f.rowTrans * w.rowTrans +
    f.colTrans * w.colTrans +
    f.hole1 * w.hole1 +
    f.rowFillSq * w.rowFillSq
  );
}

/** 아래아(·)를 제외한 블록들 — 생존성 평가에 쓴다 */
const FIT_TYPES = PIECE_TYPES.filter((t) => t !== '·');
const FIT_ORIENTS: Orientation[][] = FIT_TYPES.map((t) => PIECES[t].orientations);

export interface FitFeatures {
  /** 놓을 자리가 하나도 없는 블록 종류 수 */
  noFit: number;
  mobility: number;
  /** 2칸 이상 블록으로는 덮을 수 없는 빈칸 수 */
  dead: number;
  /** 종류별 놓을 수 있는 자리 수 */
  counts: number[];
}

export function fitFeatures(rows: Rows): FitFeatures {
  const cover = new Array<number>(H).fill(0);
  const counts: number[] = [];
  let noFit = 0;
  let mobility = 0;
  for (const orients of FIT_ORIENTS) {
    let n = 0;
    for (const o of orients) {
      const maxR = H - o.h;
      const maxC = W - o.w;
      for (let r = 0; r <= maxR; r++) {
        for (let c = 0; c <= maxC; c++) {
          let ok = true;
          for (let i = 0; i < o.h; i++) {
            if (rows[r + i] & (o.rows[i] << c)) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          n++;
          for (let i = 0; i < o.h; i++) cover[r + i] |= o.rows[i] << c;
        }
      }
    }
    counts.push(n);
    if (n === 0) noFit++;
    mobility += Math.log2(1 + n);
  }
  let dead = 0;
  for (let r = 0; r < H; r++) dead += popcount(~(rows[r] | cover[r]) & FULL);
  return { noFit, mobility, dead, counts };
}

export function fitScore(f: FitFeatures, w: Weights): number {
  return f.noFit * w.noFit + f.mobility * w.mobility + f.dead * w.dead;
}

export function fullScore(rows: Rows, w: Weights): number {
  return cheapScore(cheapFeatures(rows), w) + fitScore(fitFeatures(rows), w);
}

// 추천 단계 진행 추적: 사용자가 안내대로 놓았는지 화면 인식 결과로 판단한다.
import { FULL, H, W, place, placeDot, popcount, type Rows } from './board';
import { PIECES } from './pieces';
import type { Move } from './search';

/** 각 단계를 마친 뒤의 보드 (afters[k] = k번째 단계까지 마친 보드) */
export function boardsAfterMoves(base: Rows, moves: readonly Move[]): Rows[] {
  const out: Rows[] = [];
  let rows = base;
  for (const m of moves) {
    rows =
      m.kind === 'dot' ? placeDot(rows, m.r, m.c).rows : place(rows, PIECES[m.type].orientations[m.orient], m.r, m.c).rows;
    out.push(rows);
  }
  return out;
}

/** 두 보드에서 상태가 다른 칸 수 */
export function boardDiff(a: Rows, b: Rows): number {
  let n = 0;
  for (let r = 0; r < H; r++) n += popcount((a[r] ^ b[r]) & FULL);
  return n;
}

/** 인식 오차로 볼 수 있는 칸 수 (이 이하로 다르면 같은 보드로 본다) */
export const PROGRESS_TOLERANCE = 2;

export type ProgressResult =
  | { kind: 'same' }
  | { kind: 'advanced'; step: number }
  | { kind: 'deviated'; reason: string };

/**
 * @param base 계산할 때의 보드
 * @param moves 추천 단계
 * @param usedAtPlan 계산할 때 이미 사용한 조각 칸
 * @param step 지금 안내 중인 단계 (0부터)
 * @param liveRows 지금 화면의 보드
 * @param liveUsed 지금 화면에서 사용 완료인 조각 칸
 */
export function checkProgress(
  base: Rows,
  moves: readonly Move[],
  usedAtPlan: readonly boolean[],
  step: number,
  liveRows: Rows,
  liveUsed: readonly boolean[],
): ProgressResult {
  const afters = boardsAfterMoves(base, moves);
  const usedAfter = (k: number) => {
    // k번째 단계까지 마쳤을 때 사용 완료여야 하는 칸
    const used = usedAtPlan.slice();
    for (let i = 0; i <= k; i++) {
      const m = moves[i];
      if (m && m.kind === 'piece') used[m.slot] = true;
    }
    return used;
  };
  const sameUsed = (a: readonly boolean[], b: readonly boolean[]) => a.every((v, i) => v === !!b[i]);

  // 안내한 단계를 마쳤는지. 빠르게 여러 단계를 놓았을 수도 있으니, 화면과 맞는 가장 먼 단계를 찾는다
  for (let k = moves.length - 1; k >= step; k--)
    if (sameUsed(usedAfter(k), liveUsed) && boardDiff(liveRows, afters[k]) <= PROGRESS_TOLERANCE)
      return { kind: 'advanced', step: k + 1 };

  if (step >= moves.length) return { kind: 'same' };
  const before = step === 0 ? base : afters[step - 1];
  const expectedUsed = usedAfter(step - 1);
  // 아직 쓰면 안 되는 조각을 썼다 → 다른 조각을 먼저 놓았거나 다른 자리에 놓음
  const extra = liveUsed.findIndex((u, i) => u && !expectedUsed[i]);
  if (extra >= 0) return { kind: 'deviated', reason: `${extra + 1}번 조각을 안내와 다르게 놓음` };
  // 조각은 그대로인데 보드가 달라졌다 (점 찍기를 다른 곳에 썼거나 다른 변화)
  if (boardDiff(liveRows, before) > PROGRESS_TOLERANCE) return { kind: 'deviated', reason: '보드가 안내와 다르게 바뀜' };
  return { kind: 'same' };
}

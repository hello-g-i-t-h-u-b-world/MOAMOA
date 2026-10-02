// 연속된 화면 인식 결과를 비교해 아이템 획득/사용을 추적한다.
import { H, INVENTORY_CAP, W, popcount, type Inventory, type Item, type Rows } from '../core/board';
import type { PieceType } from '../core/pieces';

export interface SlotState {
  type: PieceType | null;
  used: boolean;
}

export interface Snapshot {
  rows: Rows;
  /** 이번 프레임에서 보인 아이템 */
  items: Item[];
  hand: SlotState[];
}

export interface TrackResult {
  /** 보드 위에 남아 있는 아이템 (블록에 가려진 것 포함) */
  items: Item[];
  inventory: Inventory;
  events: string[];
}

const ITEM_NAME = { dot: '점 찍기', swap: '바꿔 뽑기' } as const;
const slotKey = (s: SlotState) => (s.used ? 'U' : (s.type ?? '?'));

export function track(prev: Snapshot | null, cur: Snapshot, tracked: Item[], inv: Inventory): TrackResult {
  const inventory = { ...inv };
  const events: string[] = [];
  if (!prev) return { items: cur.items.slice(), inventory, events };

  const filled = (rows: Rows, r: number, c: number) => ((rows[r] >> c) & 1) === 1;
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const it of cur.items) {
    items.push(it);
    seen.add(`${it.r},${it.c}`);
  }
  for (const it of tracked) {
    if (seen.has(`${it.r},${it.c}`)) continue;
    if (filled(cur.rows, it.r, it.c)) {
      // 블록 위 아이콘을 한 프레임 놓친 경우 등: 줄이 지워지기 전까지 계속 추적
      items.push(it);
      continue;
    }
    // 그 줄에서 칸이 사라졌다 = 줄이 지워졌다 → 아이템 획득
    const lost = prev.rows[it.r] & ~cur.rows[it.r];
    if (lost !== 0) {
      if (inventory.dot + inventory.swap < INVENTORY_CAP) {
        inventory[it.type]++;
        events.push(`${ITEM_NAME[it.type]} 획득`);
      } else {
        events.push(`${ITEM_NAME[it.type]} 획득 실패 (보유 한도)`);
      }
    }
  }

  const sameHand = prev.hand.length === cur.hand.length && prev.hand.every((s, i) => slotKey(s) === slotKey(cur.hand[i]));
  let added = 0;
  let clearedNine = false;
  let sameBoard = true;
  for (let r = 0; r < H; r++) {
    added += popcount(cur.rows[r] & ~prev.rows[r]);
    if (cur.rows[r] !== prev.rows[r]) sameBoard = false;
    if (popcount(prev.rows[r]) === W - 1 && cur.rows[r] === 0) clearedNine = true;
  }

  // 손패 변화 없이 한 칸만 채워짐 → 점 찍기 사용
  if (sameHand && (added === 1 || (added === 0 && clearedNine)) && inventory.dot > 0) {
    inventory.dot--;
    events.push('점 찍기 사용');
  }

  // 보드 변화 없이 조각 하나만 다른 종류로 바뀜 → 바꿔 뽑기 사용
  if (sameBoard && !sameHand && inventory.swap > 0) {
    const changed = cur.hand.filter((s, i) => slotKey(s) !== slotKey(prev.hand[i]));
    const i = cur.hand.findIndex((s, i) => slotKey(s) !== slotKey(prev.hand[i]));
    if (changed.length === 1 && !cur.hand[i].used && !prev.hand[i].used && cur.hand[i].type && prev.hand[i].type) {
      inventory.swap--;
      events.push('바꿔 뽑기 사용');
    }
  }

  return { items, inventory, events };
}

/**
 * 새 블록을 받았는가 (추천 고정을 풀고 다시 계산할 때).
 * - 사용 완료였던 칸에 블록이 다시 생김 → 다음 손패 3개
 * - 칸의 블록 종류가 바뀜 → 바꿔 뽑기 (또는 인식 못 하던 칸을 인식)
 * 블록을 놓아 칸이 '사용 완료'가 되는 것은 해당하지 않는다.
 */
export function receivedNewBlocks(prev: Snapshot, cur: Snapshot): boolean {
  return cur.hand.some((s, i) => {
    const p = prev.hand[i];
    if (!p || s.used || !s.type) return false;
    return p.used || p.type !== s.type;
  });
}

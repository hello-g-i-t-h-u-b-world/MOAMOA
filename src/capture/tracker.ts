// 연속된 화면 인식 결과를 비교해 아이템 획득/사용을 추적한다.
import { FULL, H, INVENTORY_CAP, W, popcount, type Inventory, type Item, type Rows } from '../core/board';
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

/**
 * 새로 보인 아이템은 일정 시간 같은 자리에 계속 보여야 인정한다.
 * 줄 제거 번쩍임처럼 잠깐 나타났다 사라지는 것을 걸러낸다.
 */
export class ItemConfirmer {
  private seen = new Map<string, { item: Item; since: number; last: number }>();

  constructor(
    /** 인정까지 계속 보여야 하는 시간 */
    private readonly holdMs = 1000,
    /** 이 시간 안의 잠깐 끊김은 연속으로 본다 (아이콘 반짝임) */
    private readonly gapMs = 600,
  ) {}

  /** 이번 프레임에 감지된 아이템을 넣고, 인정된 아이템 목록을 받는다 */
  update(detected: readonly Item[], now: number): Item[] {
    for (const it of detected) {
      const key = `${it.r},${it.c},${it.type}`;
      const prev = this.seen.get(key);
      if (prev && now - prev.last <= this.gapMs) prev.last = now;
      else this.seen.set(key, { item: it, since: now, last: now });
    }
    const out: Item[] = [];
    for (const [key, e] of this.seen) {
      if (now - e.last > this.gapMs) this.seen.delete(key);
      else if (e.last - e.since >= this.holdMs) out.push(e.item);
    }
    return out.sort((a, b) => a.r - b.r || a.c - b.c);
  }

  reset(): void {
    this.seen.clear();
  }
}

/**
 * 게임 규칙상 칸은 줄 전체가 지워질 때만 비워진다.
 * 지워지지 않은 줄에서 한두 칸만 갑자기 빈칸으로 읽히면 (아이템 아이콘의 빛 등으로 인한) 오인식으로 보고
 * 이전 상태(채워짐)를 유지한다. 여러 칸이 한꺼번에 비면 줄 제거로 보고 그대로 받아들인다.
 */
export const MAX_FLICKER_CELLS = 2;

export function stabilizeRows(prev: Rows | null, cur: Rows): Rows {
  if (!prev) return cur.slice();
  return cur.map((row, r) => {
    const lost = prev[r] & ~row;
    if (lost === 0 || row === 0) return row;
    // 복원 결과가 꽉 찬 줄이면 있을 수 없는 상태(꽉 찬 줄은 지워진다)이므로 그대로 둔다
    return popcount(lost) <= MAX_FLICKER_CELLS && (row | lost) !== FULL ? row | lost : row;
  });
}

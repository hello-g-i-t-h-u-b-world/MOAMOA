// 연속된 화면 인식 결과를 비교해 아이템 획득/사용을 추적한다.
import { BOARD_ITEM_CAP, FULL, H, INVENTORY_CAP, W, popcount, type Inventory, type Item, type Rows } from '../core/board';
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
  const key = (it: Item) => `${it.r},${it.c}`;
  const seen = new Set(cur.items.map(key));
  // 아이템은 떨어진 순서대로 기억한다 (가장 오래된 것이 먼저). 기존 아이템은 순서를 유지하고 새로 보인 것은 뒤에 붙인다.
  const kept: { it: Item; visible: boolean }[] = [];
  for (const it of tracked) {
    if (seen.has(key(it))) {
      kept.push({ it, visible: true });
      continue;
    }
    if (filled(cur.rows, it.r, it.c)) {
      // 블록 위 아이콘을 한 프레임 놓친 경우 등: 줄이 지워지기 전까지 계속 추적
      kept.push({ it, visible: false });
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
    } else {
      // 줄을 지우지 않았는데 빈 칸의 아이템이 없어졌다 = 새 아이템이 떨어져 가장 오래된 것이 사라짐
      events.push(`${ITEM_NAME[it.type]} 사라짐 (${it.r + 1}행 ${it.c + 1}열, 오래된 순)`);
    }
  }
  const trackedKeys = new Set(tracked.map(key));
  for (const it of cur.items) if (!trackedKeys.has(key(it))) kept.push({ it, visible: true });
  // 보드 위 아이템은 최대 3개: 새로 떨어져 넘치면 가장 오래된 것이 사라진 것이다.
  // (안 보이는데 기억만 하던 아이템부터 지운다. 그대로 두면 없는 아이템을 얻으려는 추천이 나온다)
  while (kept.length > BOARD_ITEM_CAP) {
    const hidden = kept.findIndex((k) => !k.visible);
    const [gone] = kept.splice(hidden >= 0 ? hidden : 0, 1);
    events.push(`${ITEM_NAME[gone.it.type]} 사라짐 (${gone.it.r + 1}행 ${gone.it.c + 1}열, 오래된 순)`);
  }
  const items = kept.map((k) => k.it);

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

  /** 화면을 보지 않은 시간(조각 선택 중 등)만큼 기록을 미뤄, 그동안 아이템이 사라진 것으로 보지 않게 한다 */
  shift(ms: number): void {
    for (const e of this.seen.values()) {
      e.since += ms;
      e.last += ms;
    }
  }
}

/**
 * 보드 칸 상태 필터.
 * 인식 결과가 한 순간 튀어도 바로 반영하지 않고, 같은 상태가 일정 시간 이어질 때만 칸을 바꾼다.
 * - 빈칸 → 블록: fillMs 이상 계속 블록으로 보일 때
 * - 블록 → 빈칸: 줄 제거(한 줄에서 clearCells칸 이상이 함께 빔)면 clearMs, 한두 칸만 비면 emptyMs
 *   (게임에서 칸은 줄이 지워질 때만 비므로, 한두 칸만 비어 보이는 건 아이콘 빛 등에 의한 오인식일 가능성이 크다)
 * 꽉 찬 줄은 게임에서 바로 지워지므로 결과에 남기지 않는다.
 */
export interface BoardFilterOptions {
  fillMs: number;
  emptyMs: number;
  clearMs: number;
  clearCells: number;
}

export const DEFAULT_BOARD_FILTER: BoardFilterOptions = { fillMs: 500, emptyMs: 1500, clearMs: 500, clearCells: 3 };

export class BoardFilter {
  private stable: Rows | null = null;
  /** 칸 번호 → 인식 결과가 확정 상태와 달라지기 시작한 시각 */
  private since = new Map<number, number>();

  constructor(private readonly opt: BoardFilterOptions = DEFAULT_BOARD_FILTER) {}

  /** 확정 상태와 다르게 보이는 칸이 남아 있는가 (아직 화면이 안정되지 않음) */
  get pending(): boolean {
    return this.since.size > 0;
  }

  /**
   * @param unsure 판단이 안 서는 칸 (아이템 빛·애니메이션에 가려짐). 이 칸은 확정 상태를 그대로 둔다.
   */
  update(rawIn: Rows, now: number, unsure?: Rows): Rows {
    if (!this.stable) {
      this.stable = withoutFullRows(rawIn);
      return this.stable.slice();
    }
    const stable = this.stable;
    const raw = unsure ? rawIn.map((x, r) => (x & ~unsure[r]) | (stable[r] & unsure[r])) : rawIn;
    const next = this.stable.slice();
    for (let r = 0; r < H; r++) {
      const diff = (raw[r] ^ this.stable[r]) & FULL;
      const lost = this.stable[r] & ~raw[r];
      const clearing = popcount(lost) >= this.opt.clearCells;
      for (let c = 0; c < W; c++) {
        const idx = r * W + c;
        const bit = 1 << c;
        if (!(diff & bit)) {
          this.since.delete(idx);
          continue;
        }
        const t0 = this.since.get(idx) ?? now;
        this.since.set(idx, t0);
        const need = raw[r] & bit ? this.opt.fillMs : clearing ? this.opt.clearMs : this.opt.emptyMs;
        if (now - t0 >= need) {
          next[r] ^= bit;
          this.since.delete(idx);
        }
      }
    }
    this.stable = withoutFullRows(next);
    return this.stable.slice();
  }

  reset(): void {
    this.stable = null;
    this.since.clear();
  }

  /** 화면을 보지 않은 시간만큼 대기 중인 칸의 시작 시각을 미룬다 */
  shift(ms: number): void {
    for (const [k, t] of this.since) this.since.set(k, t + ms);
  }
}

/** 꽉 찬 줄은 게임에서 바로 지워지므로 빈 줄로 본다 */
export function withoutFullRows(rows: Rows): Rows {
  return rows.map((row) => (row === FULL ? 0 : row));
}

/**
 * 보유 능력 숫자 읽기 결과를 시간에 따라 안정화한다.
 * - 새 값은 confirmMs 동안 같은 값으로 읽혀야 바꾼다 (버튼 애니메이션·마우스 올림 등으로 잠깐 튀는 값 무시)
 * - 숫자가 안 보이면(null) 마지막 값을 유지한다
 * - 처음 보는 모양은 unknownMs 동안 계속될 때만 사용자에게 물어본다
 */
export class CountSmoother {
  value: number | null = null;
  private cand: { v: number | '?'; since: number } | null = null;

  constructor(
    private readonly confirmMs = 600,
    private readonly unknownMs = 1500,
  ) {}

  update(read: { sig: string; value: number | null } | null, now: number): { value: number | null; unknownSig: string | null } {
    if (!read) {
      this.cand = null;
      return { value: this.value, unknownSig: null };
    }
    const v: number | '?' = read.value ?? '?';
    if (v === this.value) {
      this.cand = null;
      return { value: this.value, unknownSig: null };
    }
    if (!this.cand || this.cand.v !== v) {
      this.cand = { v, since: now };
      return { value: this.value, unknownSig: null };
    }
    if (v === '?') return { value: this.value, unknownSig: now - this.cand.since >= this.unknownMs ? read.sig : null };
    if (now - this.cand.since >= this.confirmMs) {
      this.value = v;
      this.cand = null;
    }
    return { value: this.value, unknownSig: null };
  }

  /** 사용자가 알려준 값으로 바로 확정 */
  set(v: number): void {
    this.value = v;
    this.cand = null;
  }

  reset(): void {
    this.value = null;
    this.cand = null;
  }
}

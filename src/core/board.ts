import type { Orientation } from './pieces';

export const W = 10;
export const H = 16;
export const FULL = (1 << W) - 1;

/** 보드: 길이 16 배열, 각 원소는 10비트 행 마스크 (bit c = c열이 채워짐) */
export type Rows = number[];

export type ItemType = 'dot' | 'swap';
export interface Item {
  r: number;
  c: number;
  type: ItemType;
}

export interface Inventory {
  dot: number;
  swap: number;
}
/** 보유 가능한 아이템 총 개수 */
export const INVENTORY_CAP = 7;
/** 블록을 이만큼 놓을 때마다 빈 칸에 아이템이 하나 떨어진다 ('다음 능력 획득까지' 7 → 1) */
export const DROP_EVERY = 7;
/** 보드 위 아이템 최대 개수. 넘으면 가장 오래된 것이 사라진다 */
export const BOARD_ITEM_CAP = 3;

export function emptyRows(): Rows {
  return new Array<number>(H).fill(0);
}

const POP = new Uint8Array(1 << W);
for (let i = 1; i < POP.length; i++) POP[i] = POP[i >> 1] + (i & 1);
export function popcount(row: number): number {
  return POP[row];
}

export function filledCount(rows: Rows): number {
  let n = 0;
  for (let r = 0; r < H; r++) n += POP[rows[r]];
  return n;
}

export function isFilled(rows: Rows, r: number, c: number): boolean {
  return ((rows[r] >> c) & 1) === 1;
}

export function canPlace(rows: Rows, o: Orientation, r: number, c: number): boolean {
  if (r < 0 || c < 0 || r + o.h > H || c + o.w > W) return false;
  for (let i = 0; i < o.h; i++) if (rows[r + i] & (o.rows[i] << c)) return false;
  return true;
}

export interface PlaceResult {
  rows: Rows;
  /** 지워진 행 번호 */
  cleared: number[];
}

/** 배치 후 꽉 찬 가로줄을 지운다. 중력 없음: 지워진 칸만 빈칸이 된다. */
export function place(rows: Rows, o: Orientation, r: number, c: number): PlaceResult {
  const next = rows.slice();
  for (let i = 0; i < o.h; i++) next[r + i] |= o.rows[i] << c;
  const cleared: number[] = [];
  for (let i = 0; i < o.h; i++) {
    if (next[r + i] === FULL) {
      next[r + i] = 0;
      cleared.push(r + i);
    }
  }
  return { rows: next, cleared };
}

/** 한 칸 채우기 (점 찍기 아이템) */
export function placeDot(rows: Rows, r: number, c: number): PlaceResult {
  const next = rows.slice();
  next[r] |= 1 << c;
  const cleared: number[] = [];
  if (next[r] === FULL) {
    next[r] = 0;
    cleared.push(r);
  }
  return { rows: next, cleared };
}

/** 지워진 행에 있던 아이템을 획득 처리한다. */
export function collectItems(
  items: readonly Item[],
  cleared: readonly number[],
): { remaining: Item[]; collected: Item[] } {
  if (cleared.length === 0 || items.length === 0) return { remaining: items as Item[], collected: [] };
  const remaining: Item[] = [];
  const collected: Item[] = [];
  for (const it of items) (cleared.includes(it.r) ? collected : remaining).push(it);
  return { remaining, collected };
}

export function rowsFromStrings(lines: readonly string[]): Rows {
  const rows = emptyRows();
  lines.forEach((line, r) => {
    for (let c = 0; c < W; c++) if (line[c] === '#' || line[c] === 'X') rows[r] |= 1 << c;
  });
  return rows;
}

export function rowsToStrings(rows: Rows): string[] {
  return rows.map((row) => {
    let s = '';
    for (let c = 0; c < W; c++) s += (row >> c) & 1 ? '#' : '.';
    return s;
  });
}

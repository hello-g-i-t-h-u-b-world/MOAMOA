// 한글 모아모아 블록 정의.
// '#' = 칸, '.' = 빈칸. 칸끼리 이어져 있지 않아도 된다(ㅅ, ㅈ, ㅇ 등).
// 게임 화면 스크린샷에서 칸 단위로 추출한 모양이다.

export const PIECE_DEFS = {
  '·': ['#'],
  ㄱ: ['##', '.#', '.#'],
  ㄴ: ['#.', '##'],
  ㄷ: ['##', '#.', '##'],
  ㄹ: ['##', '.#', '##', '#.', '##'],
  ㅁ: ['###', '#.#', '###'],
  ㅂ: ['#.#', '###', '#.#', '###'],
  ㅅ: ['.#.', '#.#'],
  ㅇ: ['.#.', '#.#', '.#.'],
  ㅈ: ['###', '.#.', '#.#'],
  ㅊ: ['.#.', '###', '.#.', '#.#'],
  ㅋ: ['##', '.#', '##', '.#'],
  ㅌ: ['##', '#.', '##', '#.', '##'],
  ㅍ: ['####', '.##.', '####'],
  ㅎ: ['..#..', '#####', '.#.#.', '..#..'],
  ㅏ: ['#.', '##', '#.'],
  ㅑ: ['#.', '##', '#.', '##', '#.'],
  ㅡ: ['###'],
  ㅣ: ['#', '#', '#', '#', '#'],
} as const satisfies Record<string, readonly string[]>;

export type PieceType = keyof typeof PIECE_DEFS;
export const PIECE_TYPES = Object.keys(PIECE_DEFS) as PieceType[];

export type Cell = readonly [r: number, c: number];

export interface Orientation {
  /** 정규화된 칸 좌표 (좌상단 bbox 기준) */
  cells: Cell[];
  h: number;
  w: number;
  /** 행별 비트마스크 (bit c = c열) */
  rows: number[];
  /** 모양 비교용 키 */
  key: string;
}

export interface PieceInfo {
  type: PieceType;
  size: number;
  /** 회전/반전으로 만들 수 있는 서로 다른 모양들 */
  orientations: Orientation[];
}

function parse(grid: readonly string[]): Cell[] {
  const cells: Cell[] = [];
  grid.forEach((line, r) => {
    for (let c = 0; c < line.length; c++) if (line[c] === '#') cells.push([r, c]);
  });
  return cells;
}

export function normalize(cells: readonly Cell[]): Orientation {
  const minR = Math.min(...cells.map((x) => x[0]));
  const minC = Math.min(...cells.map((x) => x[1]));
  const norm = cells
    .map(([r, c]) => [r - minR, c - minC] as Cell)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const h = Math.max(...norm.map((x) => x[0])) + 1;
  const w = Math.max(...norm.map((x) => x[1])) + 1;
  const rows = new Array<number>(h).fill(0);
  for (const [r, c] of norm) rows[r] |= 1 << c;
  return { cells: norm, h, w, rows, key: `${h}x${w}:${rows.join(',')}` };
}

/** 시계방향 90도 회전 */
export function rotateCW(cells: readonly Cell[]): Cell[] {
  return cells.map(([r, c]) => [c, -r] as Cell);
}

/** 좌우 반전 */
export function flipH(cells: readonly Cell[]): Cell[] {
  return cells.map(([r, c]) => [r, -c] as Cell);
}

function buildPiece(type: PieceType): PieceInfo {
  const base = parse(PIECE_DEFS[type]);
  const seen = new Map<string, Orientation>();
  let cur: Cell[] = base;
  for (let f = 0; f < 2; f++) {
    for (let k = 0; k < 4; k++) {
      const o = normalize(cur);
      if (!seen.has(o.key)) seen.set(o.key, o);
      cur = rotateCW(cur);
    }
    cur = flipH(base);
  }
  return { type, size: base.length, orientations: [...seen.values()] };
}

export const PIECES: Record<PieceType, PieceInfo> = Object.fromEntries(
  PIECE_TYPES.map((t) => [t, buildPiece(t)]),
) as Record<PieceType, PieceInfo>;

export interface TransformStep {
  flip: boolean;
  rotations: number;
}

/**
 * 화면에 표시된 모양(from)을 목표 모양(to)으로 만드는 최소 버튼 조작.
 * 게임의 '회전' = 시계방향 90도, '반전' = 좌우 반전으로 가정한다.
 * 반전을 먼저 누르고 회전을 누르는 순서로 안내한다.
 */
export function transformSteps(from: Orientation, to: Orientation): TransformStep | null {
  let best: TransformStep | null = null;
  for (const flip of [false, true]) {
    let cur: Cell[] = flip ? flipH(from.cells) : [...from.cells];
    for (let k = 0; k < 4; k++) {
      if (normalize(cur).key === to.key) {
        const cost = k + (flip ? 1 : 0);
        if (!best || cost < best.rotations + (best.flip ? 1 : 0)) best = { flip, rotations: k };
        break;
      }
      cur = rotateCW(cur);
    }
  }
  return best;
}

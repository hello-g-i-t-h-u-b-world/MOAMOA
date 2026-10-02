// 캡처한 화면에서 보드/보유 조각을 읽어낸다.
// DOM에 의존하지 않는 순수 함수라 node 테스트에서도 쓸 수 있다.
import { H, W, emptyRows, type Item, type Rows } from '../core/board';
import { PIECES, PIECE_TYPES, normalize, type Cell, type PieceType } from '../core/pieces';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Frame {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export type RGB = [number, number, number];

function pixel(f: Frame, x: number, y: number): RGB {
  const i = (Math.round(y) * f.width + Math.round(x)) * 4;
  return [f.data[i], f.data[i + 1], f.data[i + 2]];
}

function dist(a: RGB, b: RGB): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function sat([r, g, b]: RGB): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function patch(f: Frame, x0: number, y0: number, x1: number, y1: number): RGB[] {
  const out: RGB[] = [];
  const step = Math.max(1, Math.floor((x1 - x0) / 8));
  for (let y = Math.ceil(y0); y < y1; y += step)
    for (let x = Math.ceil(x0); x < x1; x += step) {
      if (x >= 0 && y >= 0 && x < f.width && y < f.height) out.push(pixel(f, x, y));
    }
  return out;
}

function median(px: RGB[]): RGB {
  const ch = (k: number) => {
    const v = px.map((p) => p[k]).sort((a, b) => a - b);
    return v[v.length >> 1] ?? 0;
  };
  return [ch(0), ch(1), ch(2)];
}

/** 바꿔 뽑기 아이콘의 보라색 화살표 */
function isPurple([r, g, b]: RGB): boolean {
  return r > 120 && r < 230 && b > 170 && g < 140;
}

/** 점 찍기 아이콘의 진한 남색 테두리 / 형광 하늘색 고리 (빨강 성분이 거의 없다) */
function isDotIcon([r, g, b]: RGB): boolean {
  return r < 50 && b > 110 && (g > 170 || g < 110);
}

export interface CellRead {
  filled: boolean;
  color: string | null;
  item: Item['type'] | null;
}

/** 칸 영역(0~1 비율 좌표)의 픽셀들 */
function cellPatch(f: Frame, board: Rect, r: number, c: number, x0: number, y0: number, x1: number, y1: number) {
  const pw = board.w / W;
  const ph = board.h / H;
  const x = board.x + c * pw;
  const y = board.y + r * ph;
  return patch(f, x + pw * x0, y + ph * y0, x + pw * x1, y + ph * y1);
}

/** 칸 중앙의 아이템 아이콘. 아이콘은 블록 위에도 계속 보인다. */
export function detectItem(px: RGB[]): Item['type'] | null {
  if (px.length === 0) return null;
  if (px.filter(isDotIcon).length / px.length > 0.08) return 'dot';
  if (px.filter(isPurple).length / px.length > 0.06) return 'swap';
  return null;
}

/** 픽셀 하나를 블록 색 / 빈칸 / 기타(아이콘·광택 등)로 분류 */
/**
 * 픽셀 하나를 블록 색 / 빈칸 / 기타(아이콘·반짝임 등)로 분류.
 * 블록은 위→아래 그라데이션이 커서 고정 색 대신 채널 범위로 판별한다 (스크린샷 측정값 기준).
 *  - 파랑: B≈255 (빈칸·반짝임은 B ≤ 235)
 *  - 노랑/초록: B가 매우 낮음, R로 구분
 *  - 분홍: R, B 모두 높고 G는 중간
 */
function classify([r, g, b]: RGB): string | 'empty' | null {
  if (b >= 245 && r < 170 && g > 155 && g < 215) return 'blue';
  if (b < 120 && g > 160 && r > 235) return 'yellow';
  if (b < 90 && g > 170 && r < 190) return 'green';
  if (r > 228 && b > 185 && g > 70 && g < 180) return 'pink';
  if (r < 105 && g >= 150 && g <= 215 && b >= 185 && b <= 235) return 'empty';
  return null;
}

export function readCell(f: Frame, board: Rect, r: number, c: number): CellRead {
  // 채움 여부는 칸의 세 모서리 픽셀 투표로 정한다.
  // 가운데는 아이템 아이콘이 덮을 수 있고, 좌상단은 블록 광택이 있다.
  const corners = [
    ...cellPatch(f, board, r, c, 0.75, 0.1, 0.92, 0.27),
    ...cellPatch(f, board, r, c, 0.1, 0.73, 0.27, 0.9),
    ...cellPatch(f, board, r, c, 0.73, 0.73, 0.9, 0.9),
  ];
  const votes = new Map<string, number>();
  for (const p of corners) {
    const k = classify(p);
    if (k) votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  let color: string | null = null;
  let blockVotes = 0;
  for (const [k, n] of votes)
    if (k !== 'empty' && n > blockVotes) {
      blockVotes = n;
      color = k;
    }
  const filled = blockVotes > (votes.get('empty') ?? 0) && blockVotes >= corners.length * 0.1;
  const item = detectItem(cellPatch(f, board, r, c, 0.15, 0.15, 0.85, 0.85));
  return { filled, color: filled ? color : null, item };
}

export interface BoardRead {
  rows: Rows;
  items: Item[];
  colors: (string | null)[][];
}

export function readBoard(f: Frame, board: Rect): BoardRead {
  const rows = emptyRows();
  const items: Item[] = [];
  const colors: (string | null)[][] = [];
  for (let r = 0; r < H; r++) {
    colors.push([]);
    for (let c = 0; c < W; c++) {
      const cell = readCell(f, board, r, c);
      if (cell.filled) rows[r] |= 1 << c;
      if (cell.item) items.push({ r, c, type: cell.item });
      colors[r].push(cell.color);
    }
  }
  return { rows, items, colors };
}

export interface HandRead {
  /** null = 사용 완료 또는 인식 실패 */
  type: PieceType | null;
  /** 화면에 표시된 방향 (PIECES[type].orientations 인덱스) */
  orient: number;
  used: boolean;
  /** 인식했지만 목록에 없는 모양 */
  unknown: boolean;
}

function isWhite([r, g, b]: RGB): boolean {
  return r > 215 && g > 215 && b > 215 && sat([r, g, b]) < 30;
}

function isPieceColor(p: RGB): boolean {
  return sat(p) > 70 && !isWhite(p);
}

/**
 * 보유 조각 칸 읽기. rect는 조각이 그려지는 흰 영역만 감싸야 한다
 * (글자 라벨·버튼 제외).
 */
export function readHandSlot(f: Frame, rect: Rect): HandRead {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(f.width, Math.round(rect.x + rect.w));
  const y1 = Math.min(f.height, Math.round(rect.y + rect.h));
  const colHist = new Array<number>(x1 - x0).fill(0);
  const rowHist = new Array<number>(y1 - y0).fill(0);
  let white = 0;
  let total = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const p = pixel(f, x, y);
      total++;
      if (isWhite(p)) white++;
      else if (isPieceColor(p)) {
        colHist[x - x0]++;
        rowHist[y - y0]++;
      }
    }
  const none: HandRead = { type: null, orient: -1, used: false, unknown: false };
  if (total === 0) return none;
  // '사용 완료' 상태면 흰 배경이 사라진다
  if (white / total < 0.3) return { ...none, used: true };

  // 블록의 가로/세로 투영은 항상 끊김이 없으므로, 가장 긴 연속 구간을 블록으로 본다
  // (영역 가장자리에 걸린 패널 테두리 등을 걸러낸다)
  const run = (h: number[]): [number, number] | null => {
    let best: [number, number] | null = null;
    let start = -1;
    for (let i = 0; i <= h.length; i++) {
      if (i < h.length && h[i] >= 2) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        if (!best || i - start > best[1] - best[0]) best = [start, i];
        start = -1;
      }
    }
    return best;
  };
  const xs = run(colHist);
  const ys = run(rowHist);
  if (!xs || !ys) return { ...none, used: true };
  const [bx0, bx1] = xs;
  const [by0, by1] = ys;
  const bw = bx1 - bx0;
  const bh = by1 - by0;

  let best: { type: PieceType; orient: number; miss: number; area: number } | null = null;
  for (const type of PIECE_TYPES) {
    PIECES[type].orientations.forEach((o, oi) => {
      const px = bw / o.w;
      const py = bh / o.h;
      if (Math.abs(px - py) > 0.22 * Math.max(px, py)) return;
      let miss = 0;
      for (let r = 0; r < o.h && miss <= 1; r++)
        for (let c = 0; c < o.w; c++) {
          const cx = x0 + bx0 + (c + 0.5) * px;
          const cy = y0 + by0 + (r + 0.5) * py;
          const s = patch(f, cx - px * 0.2, cy - py * 0.2, cx + px * 0.2, cy + py * 0.2);
          const on = s.filter(isPieceColor).length > s.length / 2;
          if (on !== (((o.rows[r] >> c) & 1) === 1)) miss++;
        }
      // 오차가 적은 것, 같으면 더 촘촘한 격자(칸 수가 많은 것)를 고른다.
      // 예: 가운데가 찬 모양은 1×1 격자(·)로도 일치하므로 큰 격자를 우선해야 한다.
      const area = o.h * o.w;
      if (miss <= 1 && (!best || miss < best.miss || (miss === best.miss && area > best.area)))
        best = { type, orient: oi, miss, area };
    });
  }
  if (!best) return { ...none, unknown: true };
  const b = best as { type: PieceType; orient: number; miss: number; area: number };
  return { type: b.type, orient: b.orient, used: false, unknown: false };
}

/** 셀 목록을 해당 블록 방향 인덱스로 변환 (수동 입력용) */
export function orientIndexOf(type: PieceType, cells: Cell[]): number {
  const key = normalize(cells).key;
  return PIECES[type].orientations.findIndex((o) => o.key === key);
}

// ───────────── 보유 능력 개수 (버튼 오른쪽 동그라미 안의 노란 숫자) ─────────────

/** 숫자 픽셀 (노란색) */
function isDigitPixel([r, g, b]: RGB): boolean {
  return r > 170 && g > 140 && b < 170 && r - b > 60;
}

/** 픽셀 폰트 숫자 모양. 숫자 높이를 8칸으로 보고 칸 단위로 샘플링한다. 예: "6:.####./##..##/…" */
export type DigitSig = string;

export function readDigitSig(f: Frame, rect: Rect): DigitSig | null {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(f.width, Math.round(rect.x + rect.w));
  const y1 = Math.min(f.height, Math.round(rect.y + rect.h));
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -1;
  let by1 = -1;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (isDigitPixel(pixel(f, x, y))) {
        bx0 = Math.min(bx0, x);
        by0 = Math.min(by0, y);
        bx1 = Math.max(bx1, x + 1);
        by1 = Math.max(by1, y + 1);
      }
  if (bx1 < 0 || by1 - by0 < 4) return null;
  const unit = (by1 - by0) / 8;
  const cols = Math.max(1, Math.round((bx1 - bx0) / unit));
  const ux = (bx1 - bx0) / cols;
  const rows: string[] = [];
  for (let r = 0; r < 8; r++) {
    let s = '';
    for (let c = 0; c < cols; c++) {
      const cx = bx0 + (c + 0.5) * ux;
      const cy = by0 + (r + 0.5) * unit;
      // 픽셀 x는 [x, x+1) 구간이므로 floor로 해당 픽셀을 고른다
      let on = 0;
      let n = 0;
      for (let y = Math.floor(cy - unit * 0.3); y <= Math.floor(cy + unit * 0.3); y++)
        for (let x = Math.floor(cx - ux * 0.3); x <= Math.floor(cx + ux * 0.3); x++) {
          n++;
          if (isDigitPixel(pixel(f, x, y))) on++;
        }
      s += on * 2 > n ? '#' : '.';
    }
    rows.push(s);
  }
  return `${cols}:${rows.join('/')}`;
}

/** 숫자 → 학습된 모양들 */
export type DigitTemplates = Record<string, DigitSig[]>;

/** 게임 스크린샷에서 얻은 기본 템플릿 */
export const DEFAULT_DIGITS: DigitTemplates = {
  '0': ['6:.####./##..##/##..##/##..##/##..##/##..##/##..##/.####.'],
};

function sigDistance(a: DigitSig, b: DigitSig): number {
  const [ac, ab] = a.split(':');
  const [bc, bb] = b.split(':');
  if (ac !== bc || ab.length !== bb.length) return Infinity;
  let d = 0;
  for (let i = 0; i < ab.length; i++) if (ab[i] !== bb[i]) d++;
  return d;
}

/** 가장 가까운 숫자. 충분히 비슷한 템플릿이 없으면 null */
export function matchDigit(sig: DigitSig, templates: DigitTemplates, maxDist = 3): number | null {
  let best: number | null = null;
  let bestD = maxDist + 1;
  for (const [digit, sigs] of Object.entries(templates))
    for (const t of sigs) {
      const d = sigDistance(sig, t);
      if (d < bestD) {
        bestD = d;
        best = Number(digit);
      }
    }
  return best;
}

// 캡처한 화면에서 보드/보유 조각을 읽어낸다.
// DOM에 의존하지 않는 순수 함수라 node 테스트에서도 쓸 수 있다.
import { H, W, emptyRows, type Item, type Rows } from '../core/board';
import { PIECES, PIECE_TYPES, normalize, type Cell, type PieceType } from '../core/pieces';
import builtinDigits from './digits.json';

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

/**
 * 점 찍기 아이콘의 진한 남색 테두리.
 * 화면 배율 때문에 하늘색 고리와 섞여 (16,142,184) 정도로 보이기도 해서 G를 넉넉히 둔다.
 * (파랑 블록 테두리 (37,163,246)·빈칸 배경은 R 또는 G로 걸러진다)
 */
function isDotNavy([r, g, b]: RGB): boolean {
  return r < 50 && g < 150 && b > 100;
}

/** 점 찍기 아이콘의 형광 하늘색 고리 */
function isDotCyan([r, g, b]: RGB): boolean {
  return r < 60 && g > 170 && b > 200;
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
  // 점 찍기: 남색 테두리와 하늘색 고리가 함께 있어야 한다.
  // (줄 제거 때의 번쩍임은 밝은 색 위주라 남색이 거의 없다)
  const navy = px.filter(isDotNavy).length / px.length;
  const cyan = px.filter(isDotCyan).length / px.length;
  if (navy > 0.02 && cyan > 0.05) return 'dot';
  if (px.filter(isPurple).length / px.length > 0.06) return 'swap';
  return null;
}

/** 한 줄에서 이 개수 이상 아이템처럼 보이면 아이템이 아니라 줄 제거 이펙트로 본다 */
export const EFFECT_ROW_ITEMS = 3;

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
  const vote = (px: RGB[]) => {
    for (const p of px) {
      const k = classify(p);
      if (k) votes.set(k, (votes.get(k) ?? 0) + 1);
    }
  };
  vote(corners);
  const item = detectItem(cellPatch(f, board, r, c, 0.15, 0.15, 0.85, 0.85));
  // 아이템 아이콘의 빛이 모서리를 덮어 판단이 안 서면, 칸 바깥 테두리 쪽도 본다
  let decided = 0;
  for (const n of votes.values()) decided += n;
  if (item && decided < corners.length * 0.25) {
    vote(cellPatch(f, board, r, c, 0.03, 0.03, 0.97, 0.12));
    vote(cellPatch(f, board, r, c, 0.03, 0.88, 0.97, 0.97));
    vote(cellPatch(f, board, r, c, 0.03, 0.12, 0.12, 0.88));
    vote(cellPatch(f, board, r, c, 0.88, 0.12, 0.97, 0.88));
  }
  let color: string | null = null;
  let blockVotes = 0;
  for (const [k, n] of votes)
    if (k !== 'empty' && n > blockVotes) {
      blockVotes = n;
      color = k;
    }
  const filled = blockVotes > (votes.get('empty') ?? 0) && blockVotes >= corners.length * 0.1;
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
    const rowItems: Item[] = [];
    for (let c = 0; c < W; c++) {
      const cell = readCell(f, board, r, c);
      if (cell.filled) rows[r] |= 1 << c;
      if (cell.item) rowItems.push({ r, c, type: cell.item });
      colors[r].push(cell.color);
    }
    // 아이템은 한 칸씩 떨어진다. 한 줄 여러 칸이 동시에 아이템처럼 보이면 줄 제거 이펙트다.
    if (rowItems.length < EFFECT_ROW_ITEMS) items.push(...rowItems);
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
  /** 블록 색 (blue / pink / yellow / green) */
  color: string | null;
  /** 사용자가 클릭해 선택한 상태 (카드 배경이 연노랑) */
  selected: boolean;
}

function isWhite([r, g, b]: RGB): boolean {
  return r > 215 && g > 215 && b > 215 && sat([r, g, b]) < 30;
}

/** 조각을 클릭했을 때의 연노랑 카드 배경. 노랑 블록(B ≤ 120)과는 B로 구분된다. */
function isSelectedBg([r, g, b]: RGB): boolean {
  return r > 235 && g > 215 && b >= 130 && b <= 225;
}

function isPieceColor(p: RGB): boolean {
  return sat(p) > 70 && !isWhite(p) && !isSelectedBg(p);
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
  let selectedBg = 0;
  let total = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const p = pixel(f, x, y);
      total++;
      if (isWhite(p)) white++;
      else if (isSelectedBg(p)) selectedBg++;
      else if (isPieceColor(p)) {
        colHist[x - x0]++;
        rowHist[y - y0]++;
      }
    }
  const selected = selectedBg > white;
  const none: HandRead = { type: null, orient: -1, used: false, unknown: false, color: null, selected };
  if (total === 0) return none;
  // '사용 완료' 상태면 흰(또는 선택된 연노랑) 배경이 사라진다
  if ((white + selectedBg) / total < 0.3) return { ...none, used: true, selected: false };

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

  // 색: 블록 칸 중심 픽셀들의 다수결
  const o = PIECES[b.type].orientations[b.orient];
  const px = bw / o.w;
  const py = bh / o.h;
  const votes = new Map<string, number>();
  for (const [r, c] of o.cells) {
    const cx = x0 + bx0 + (c + 0.5) * px;
    const cy = y0 + by0 + (r + 0.5) * py;
    for (const p of patch(f, cx - px * 0.3, cy - py * 0.3, cx + px * 0.3, cy + py * 0.3)) {
      const k = classify(p);
      if (k && k !== 'empty') votes.set(k, (votes.get(k) ?? 0) + 1);
    }
  }
  const color = [...votes].sort((a, c) => c[1] - a[1])[0]?.[0] ?? null;
  return { type: b.type, orient: b.orient, used: false, unknown: false, color, selected };
}

/** 셀 목록을 해당 블록 방향 인덱스로 변환 (수동 입력용) */
export function orientIndexOf(type: PieceType, cells: Cell[]): number {
  const key = normalize(cells).key;
  return PIECES[type].orientations.findIndex((o) => o.key === key);
}

// ───────────── 보유 능력 개수 (버튼 오른쪽 동그라미 안의 노란 숫자) ─────────────

/**
 * 숫자 픽셀일 정도 (0~1). 숫자는 연노랑/흰색이라 R·G가 모두 높고,
 * 동그라미(파랑·보라)·버튼 배경·버튼 글자는 R 또는 G가 낮다. 경계의 섞인 색은 중간 값이 된다.
 */
function digitWeight([r, g]: RGB): number {
  return Math.max(0, Math.min(1, (Math.min(r, g) - 130) / 80));
}

const DIGIT_ROWS = 8;

/**
 * 숫자 모양 특징. "가로 칸 수|칸별 채움 정도(0~9)" 형식.
 * 게임 숫자는 높이 8칸짜리 픽셀 폰트라, 숫자를 감싸는 영역을 폰트 칸 단위로 나눠
 * 칸마다 숫자 픽셀이 덮는 비율을 잰다. 화면 배율·위치가 조금 달라도 같은 숫자는 거의 같은 값이 나온다.
 */
export type DigitSig = string;

export function readDigitSig(f: Frame, rect: Rect): DigitSig | null {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(f.width, Math.round(rect.x + rect.w));
  const y1 = Math.min(f.height, Math.round(rect.y + rect.h));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const rough = new Float32Array(w * h);
  let strong = 0;
  let rx0 = w, ry0 = h, rx1 = -1, ry1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = digitWeight(pixel(f, x0 + x, y0 + y));
      rough[y * w + x] = v;
      if (v >= 0.5) {
        strong++;
        rx0 = Math.min(rx0, x);
        ry0 = Math.min(ry0, y);
        rx1 = Math.max(rx1, x);
        ry1 = Math.max(ry1, y);
      }
    }
  // 영역 대부분이 밝으면 숫자가 아니라 버튼이 빛나거나 선택된 상태 → 읽지 않음
  if (strong === 0 || strong > w * h * 0.5) return null;

  // 숫자 가장자리 픽셀은 숫자색과 동그라미색이 섞여 있다. 두 색 사이 어디쯤인지로
  // '숫자가 덮은 비율'을 구하면 배율과 상관없이 비례한다.
  const bgPx: RGB[] = [];
  const fgPx: RGB[] = [];
  for (let y = Math.max(0, ry0 - 2); y <= Math.min(h - 1, ry1 + 2); y++)
    for (let x = Math.max(0, rx0 - 2); x <= Math.min(w - 1, rx1 + 2); x++) {
      const v = rough[y * w + x];
      if (v < 0.02) bgPx.push(pixel(f, x0 + x, y0 + y));
      else if (v >= 0.9) fgPx.push(pixel(f, x0 + x, y0 + y));
    }
  const bg = bgPx.length ? median(bgPx) : ([39, 115, 203] as RGB);
  const fg = fgPx.length ? median(fgPx) : ([255, 230, 163] as RGB);
  const dv = [fg[0] - bg[0], fg[1] - bg[1], fg[2] - bg[2]];
  const dd = dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2] || 1;
  const weight = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // 숫자 후보 근처가 아니면 0 (버튼 글자·다른 영역 제외)
      if (rough[y * w + x] <= 0 && (x < rx0 - 1 || x > rx1 + 1 || y < ry0 - 1 || y > ry1 + 1)) continue;
      const p = pixel(f, x0 + x, y0 + y);
      const a = ((p[0] - bg[0]) * dv[0] + (p[1] - bg[1]) * dv[1] + (p[2] - bg[2]) * dv[2]) / dd;
      weight[y * w + x] = Math.max(0, Math.min(1, a));
    }

  // 열/행마다 가장 진한 값. 숫자 가장자리 픽셀은 배경과 섞여 '덮인 비율'만큼 옅어진다.
  const colMax = new Float32Array(w);
  const rowMax = new Float32Array(h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = weight[y * w + x];
      if (v > colMax[x]) colMax[x] = v;
      if (v > rowMax[y]) rowMax[y] = v;
    }
  // 가장 긴 연속 구간 = 숫자 (1픽셀 끊김은 허용, 주변의 작은 반짝임 무시)
  const run = (prof: Float32Array): [number, number] | null => {
    let best: [number, number] | null = null;
    let start = -1;
    let last = -1;
    for (let i = 0; i <= prof.length; i++) {
      const on = i < prof.length && prof[i] >= 0.15;
      if (on) {
        if (start < 0) start = i;
        last = i;
      } else if (start >= 0 && (i === prof.length || i - last > 1)) {
        if (!best || last + 1 - start > best[1] - best[0]) best = [start, last + 1];
        start = -1;
      }
    }
    return best;
  };
  const xs = run(colMax);
  const ys = run(rowMax);
  if (!xs || !ys) return null;
  // 가장자리를 픽셀보다 세밀하게: 가장자리 픽셀이 덮인 비율만큼만 숫자 영역에 넣는다
  const bx0 = xs[0] + 1 - colMax[xs[0]];
  const bx1 = xs[1] - 1 + colMax[xs[1] - 1];
  const by0 = ys[0] + 1 - rowMax[ys[0]];
  const by1 = ys[1] - 1 + rowMax[ys[1] - 1];
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  if (bh < 4 || bw <= 0) return null;
  // 픽셀 폰트 한 칸 = 숫자 높이의 1/8. 칸마다 실제로 덮는 면적만큼 가중 평균한다 (배율이 달라도 같은 값)
  const unit = bh / DIGIT_ROWS;
  const cols = Math.max(1, Math.round(bw / unit));
  const ux = bw / cols;
  let levels = '';
  for (let r = 0; r < DIGIT_ROWS; r++)
    for (let c = 0; c < cols; c++) {
      const cx0 = bx0 + c * ux;
      const cx1 = cx0 + ux;
      const cy0 = by0 + r * unit;
      const cy1 = cy0 + unit;
      let sum = 0;
      let area = 0;
      for (let y = Math.floor(cy0); y < Math.ceil(cy1); y++) {
        const oy = Math.min(cy1, y + 1) - Math.max(cy0, y);
        if (oy <= 0 || y < 0 || y >= h) continue;
        for (let x = Math.floor(cx0); x < Math.ceil(cx1); x++) {
          const ox = Math.min(cx1, x + 1) - Math.max(cx0, x);
          if (ox <= 0 || x < 0 || x >= w) continue;
          sum += weight[y * w + x] * ox * oy;
          area += ox * oy;
        }
      }
      levels += Math.min(9, Math.round((area ? sum / area : 0) * 9));
    }
  return `${cols}|${levels}`;
}

/** 숫자 → 학습된 모양들 */
export type DigitTemplates = Record<string, DigitSig[]>;

/**
 * 기본 내장 숫자 모양 (src/capture/digits.json).
 * 사용자들이 학습시켜 보내준 데이터를 scripts/merge-digits.ts로 검사해 합친다.
 */
export const DEFAULT_DIGITS: DigitTemplates = builtinDigits;

/** 두 숫자 모양이 '확실히 다른' 칸 수. 가로 칸 수가 다르면 무한대 */
export function digitDistance(a: DigitSig, b: DigitSig): number {
  const [ac, al] = a.split('|');
  const [bc, bl] = b.split('|');
  if (!al || !bl || ac !== bc || al.length !== bl.length) return Infinity;
  let d = 0;
  for (let i = 0; i < al.length; i++) if (Math.abs(Number(al[i]) - Number(bl[i])) >= 5) d++;
  return d;
}

/**
 * 가장 가까운 숫자. 차이 나는 칸이 maxDist 이하일 때만 인정한다.
 * (예: 0과 8은 가운데 줄 4칸이 다르다)
 */
export function matchDigit(sig: DigitSig, templates: DigitTemplates, maxDist = 2): number | null {
  let best: number | null = null;
  let bestD = maxDist + 1;
  for (const [digit, sigs] of Object.entries(templates))
    for (const t of sigs) {
      const d = digitDistance(sig, t);
      if (d < bestD) {
        bestD = d;
        best = Number(digit);
      }
    }
  return best;
}

// ───────────── 보드 영역 자동 맞춤 ─────────────

function lum([r, g, b]: RGB): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 한 축 방향 평균 밝기 (x축이면 열마다, y축이면 행마다 평균) */
function brightnessProfile(f: Frame, rect: Rect, axis: 'x' | 'y', margin: number) {
  const along0 = Math.max(0, Math.floor((axis === 'x' ? rect.x : rect.y) - margin));
  const along1 = Math.min(axis === 'x' ? f.width : f.height, Math.ceil((axis === 'x' ? rect.x + rect.w : rect.y + rect.h) + margin));
  // 직교 방향은 영역 안쪽 90%만 평균 (바깥 액자 영향 줄이기)
  const across0 = Math.max(0, Math.round(axis === 'x' ? rect.y + rect.h * 0.05 : rect.x + rect.w * 0.05));
  const across1 = Math.min(axis === 'x' ? f.height : f.width, Math.round(axis === 'x' ? rect.y + rect.h * 0.95 : rect.x + rect.w * 0.95));
  const values = new Float64Array(Math.max(0, along1 - along0));
  const step = Math.max(1, Math.floor((across1 - across0) / 200));
  for (let a = along0; a < along1; a++) {
    let sum = 0;
    let n = 0;
    for (let b = across0; b < across1; b += step) {
      sum += lum(axis === 'x' ? pixel(f, a, b) : pixel(f, b, a));
      n++;
    }
    values[a - along0] = n ? sum / n : 0;
  }
  return { start: along0, values };
}

/**
 * 칸 사이 경계선은 칸 가운데보다 어둡다. 경계선 위치(pos + k·pitch)가 가장 어둡게 맞는 pos, pitch를 찾는다.
 * pos는 사용자가 지정한 위치에서 반 칸 이내, pitch는 ±8% 이내에서 찾는다.
 */
function fitAxis(prof: { start: number; values: Float64Array }, pos0: number, len0: number, n: number) {
  const P = (x: number) => {
    const i = x - prof.start;
    const i0 = Math.floor(i);
    if (i0 < 0 || i0 + 1 >= prof.values.length) return NaN;
    return prof.values[i0] * (1 - (i - i0)) + prof.values[i0 + 1] * (i - i0);
  };
  const score = (pos: number, pitch: number) => {
    let s = 0;
    for (let k = 1; k < n; k++) {
      const x = pos + k * pitch;
      const v = (P(x - pitch / 2) + P(x + pitch / 2)) / 2 - P(x);
      if (Number.isNaN(v)) return -Infinity;
      s += v;
    }
    return s;
  };
  const pitch0 = len0 / n;
  let best = { pos: pos0, pitch: pitch0, score: score(pos0, pitch0) };
  const base = best.score;
  for (let pitch = pitch0 * 0.92; pitch <= pitch0 * 1.08; pitch += 0.02)
    for (let pos = pos0 - pitch0 / 2; pos <= pos0 + pitch0 / 2; pos += 0.25) {
      const s = score(pos, pitch);
      if (s > best.score) best = { pos, pitch, score: s };
    }
  return { ...best, base };
}

export interface SnapResult {
  rect: Rect;
  /** 맞춤 전/후 경계선 대비 점수 (클수록 격자에 잘 맞음) */
  before: number;
  after: number;
}

/** 대충 지정한 보드 영역을 실제 격자선에 맞춘다 */
export function snapBoardRect(f: Frame, rect: Rect): SnapResult {
  const margin = Math.max(rect.w / W, rect.h / H);
  const fx = fitAxis(brightnessProfile(f, rect, 'x', margin), rect.x, rect.w, W);
  const fy = fitAxis(brightnessProfile(f, rect, 'y', margin), rect.y, rect.h, H);
  return {
    rect: { x: fx.pos, y: fy.pos, w: fx.pitch * W, h: fy.pitch * H },
    before: fx.base + fy.base,
    after: fx.score + fy.score,
  };
}

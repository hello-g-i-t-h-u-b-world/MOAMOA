import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { rowsToStrings } from '../src/core/board';
import { readBoard, readHandSlot, type Frame } from '../src/capture/recognize';
import { DEFAULT_DIGITS, matchDigit, readCell, readDigitSig } from '../src/capture/recognize';
import type { PieceType } from '../src/core/pieces';

const load = (name: string): Frame => {
  const png = PNG.sync.read(readFileSync(join(__dirname, 'fixtures', name)));
  return { data: png.data, width: png.width, height: png.height };
};

describe('보드 인식 (실제 게임 스크린샷)', () => {
  const f = load('board.png');
  const read = readBoard(f, { x: 33, y: 127, w: 260, h: 416 });

  it('칸 채움 상태', () => {
    expect(rowsToStrings(read.rows)).toEqual([
      '####..####',
      '####....##',
      '####.#.##.',
      '##.##.#.##',
      '##.###..#.',
      '.##.#.#.##',
      '##.#.####.', // (6,6)은 아이템이 올라간 분홍 블록
      '##..##..##',
      '.#..#...#.',
      '###.##....',
      '#.####....',
      '####.##.#.',
      '#.########',
      '####.##.#.',
      '#..##.....',
      '##.######.',
    ]);
  });

  it('바꿔 뽑기 아이템 위치', () => {
    expect(read.items).toEqual([
      { r: 0, c: 5, type: 'swap' },
      { r: 6, c: 6, type: 'swap' },
      { r: 14, c: 5, type: 'swap' },
    ]);
  });

  it('보유 조각: ㅣ / 사용 완료 / ㅋ', () => {
    expect(readHandSlot(f, { x: 312, y: 155, w: 50, h: 60 })).toMatchObject({ type: 'ㅣ', used: false });
    expect(readHandSlot(f, { x: 312, y: 230, w: 50, h: 60 })).toMatchObject({ type: null, used: true });
    expect(readHandSlot(f, { x: 312, y: 305, w: 50, h: 60 })).toMatchObject({ type: 'ㅋ', used: false });
  });
});

describe('보유 능력 개수', () => {
  const f = load('board.png');
  it('점 찍기 / 바꿔 뽑기 버튼의 숫자 0', () => {
    for (const rect of [{ x: 392, y: 486, w: 22, h: 22 }, { x: 395, y: 522, w: 22, h: 22 }]) {
      const sig = readDigitSig(f, rect);
      expect(sig).toBe(DEFAULT_DIGITS['0'][0]);
      expect(matchDigit(sig!, DEFAULT_DIGITS)).toBe(0);
    }
  });
  it('모르는 모양이면 null', () => {
    expect(matchDigit('2:##/##/##/##/##/##/##/##', DEFAULT_DIGITS)).toBeNull();
  });
});

describe('아이템 아이콘', () => {
  const BOARD = { x: 33, y: 127, w: 260, h: 416 };
  // 보드 스크린샷의 (r,c) 칸에 아이콘을 덧그린다 (아이콘 배경은 제외)
  const withIcon = (name: string, ox: number, oy: number, cells: [number, number][]): Frame => {
    const f = load('board.png');
    const icon = load(name);
    const bg = [icon.data[0], icon.data[1], icon.data[2]];
    const data = Uint8Array.from(f.data);
    for (const [r, c] of cells) {
      for (let y = 0; y < 26; y++)
        for (let x = 0; x < 26; x++) {
          const si = ((y + oy) * icon.width + (x + ox)) * 4;
          const [ir, ig, ib] = [icon.data[si], icon.data[si + 1], icon.data[si + 2]];
          if (Math.hypot(ir - bg[0], ig - bg[1], ib - bg[2]) < 45) continue;
          const di = ((127 + r * 26 + y) * f.width + (33 + c * 26 + x)) * 4;
          data[di] = ir;
          data[di + 1] = ig;
          data[di + 2] = ib;
        }
    }
    return { ...f, data };
  };
  const withDot = (cells: [number, number][]) => withIcon('item-dot.png', 3, 6, cells);
  const withSwap = (cells: [number, number][]) => withIcon('item-swap.png', 4, 2, cells);

  it('점 찍기: 빈칸 위 / 블록 위 모두 인식하고 채움 상태는 유지', () => {
    const f = withDot([[8, 0], [9, 0], [1, 3]]); // 빈칸, 초록 블록, 분홍 블록
    expect(readCell(f, BOARD, 8, 0)).toMatchObject({ filled: false, item: 'dot' });
    expect(readCell(f, BOARD, 9, 0)).toMatchObject({ filled: true, item: 'dot' });
    expect(readCell(f, BOARD, 1, 3)).toMatchObject({ filled: true, item: 'dot' });
    const items = readBoard(f, BOARD).items;
    expect(items.filter((it) => it.type === 'dot')).toHaveLength(3);
    expect(items.filter((it) => it.type === 'swap')).toHaveLength(3);
  });

  it('바꿔 뽑기: 빈칸 위 / 블록 위', () => {
    const f = withSwap([[8, 2], [9, 1]]);
    expect(readCell(f, BOARD, 8, 2)).toMatchObject({ filled: false, item: 'swap' });
    expect(readCell(f, BOARD, 9, 1)).toMatchObject({ filled: true, item: 'swap' });
  });

  it('한 줄 여러 칸이 동시에 아이템처럼 보이면 줄 제거 이펙트로 보고 무시', () => {
    const f = withDot([[10, 5], [10, 6], [10, 7], [10, 8]]);
    expect(readBoard(f, BOARD).items.filter((it) => it.r === 10)).toEqual([]);
  });

  it('하얗게 번쩍이는 줄은 아이템이 아니다', () => {
    const f = load('board.png');
    const data = Uint8Array.from(f.data);
    // 9행 전체를 흰색~하늘색 빛으로 덮는다
    for (let y = 127 + 9 * 26; y < 127 + 10 * 26; y++)
      for (let x = 33; x < 293; x++) {
        const i = (y * f.width + x) * 4;
        const t = ((x + y) % 7) / 7;
        data[i] = Math.round(180 + 75 * t);
        data[i + 1] = 245;
        data[i + 2] = 255;
      }
    expect(readBoard({ ...f, data }, BOARD).items.filter((it) => it.r === 9)).toEqual([]);
  });
});

describe('보유 조각 인식 (조각별 스크린샷)', () => {
  const cases: [number, PieceType][] = [
    [2, '·'], [3, 'ㅈ'], [4, 'ㄷ'], [5, 'ㅣ'], [6, 'ㅌ'], [7, 'ㅅ'], [8, 'ㄹ'], [9, 'ㅇ'],
    [10, 'ㄴ'], [11, 'ㅡ'], [12, 'ㅎ'], [13, 'ㄱ'], [14, 'ㅋ'], [15, 'ㅁ'], [16, 'ㅑ'],
    [18, 'ㅅ'], [19, 'ㅈ'], [20, 'ㅎ'], [21, 'ㅂ'], [22, 'ㅊ'], [23, 'ㅍ'], [24, 'ㅏ'],
  ];
  for (const [n, type] of cases) {
    it(`${n}번 → ${type}`, () => {
      const f = load(`piece-${String(n).padStart(2, '0')}.png`);
      const rect = { x: 12, y: 10, w: Math.round(f.width * 0.48) - 12, h: f.height - 22 };
      expect(readHandSlot(f, rect).type).toBe(type);
    });
  }
});

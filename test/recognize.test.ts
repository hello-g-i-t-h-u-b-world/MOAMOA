import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { rowsToStrings } from '../src/core/board';
import { readBoard, readHandSlot, type Frame } from '../src/capture/recognize';
import { DEFAULT_DIGITS, matchDigit, readCell, readDigitSig, snapBoardRect } from '../src/capture/recognize';
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
    expect(readHandSlot(f, { x: 312, y: 155, w: 50, h: 60 })).toMatchObject({ type: 'ㅣ', color: 'blue', used: false, selected: false });
    expect(readHandSlot(f, { x: 312, y: 230, w: 50, h: 60 })).toMatchObject({ type: null, used: true });
    expect(readHandSlot(f, { x: 312, y: 305, w: 50, h: 60 })).toMatchObject({ type: 'ㅋ', color: 'yellow', used: false });
  });
});

describe('보드 영역 자동 맞춤', () => {
  const f = load('board.png');
  const truth = readBoard(f, { x: 33, y: 127, w: 260, h: 416 }).rows;
  const cases = [
    { x: 23, y: 117, w: 280, h: 436 }, // 바깥 액자에 맞춰 크게 잡음
    { x: 40, y: 133, w: 250, h: 400 }, // 안쪽으로 작게 잡음
    { x: 28, y: 135, w: 270, h: 420 },
    { x: 38, y: 120, w: 255, h: 430 },
  ];
  for (const rect of cases) {
    it(`(${rect.x},${rect.y},${rect.w}×${rect.h}) → 격자에 맞춰 160칸 모두 정확`, () => {
      const snapped = snapBoardRect(f, rect);
      expect(Math.abs(snapped.rect.x - 33)).toBeLessThanOrEqual(2);
      expect(Math.abs(snapped.rect.y - 127)).toBeLessThanOrEqual(2);
      expect(Math.abs(snapped.rect.w - 260)).toBeLessThanOrEqual(3);
      expect(Math.abs(snapped.rect.h - 416)).toBeLessThanOrEqual(4);
      expect(readBoard(f, snapped.rect).rows).toEqual(truth);
    });
  }
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
    expect(matchDigit('2|9999999999999999', DEFAULT_DIGITS)).toBeNull();
    expect(matchDigit('6|' + '9'.repeat(48), DEFAULT_DIGITS)).toBeNull();
  });

  // 실제 동그라미 위에 픽셀 숫자를 그려 넣는다 (게임 0과 같은 스타일로 가정한 0~8)
  const FONT: Record<string, string[]> = {
    '0': ['.####.', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '.####.'],
    '1': ['..##', '.###', '####', '..##', '..##', '..##', '..##', '..##'],
    '2': ['.####.', '##..##', '....##', '...##.', '..##..', '.##...', '##....', '######'],
    '3': ['.####.', '##..##', '....##', '..###.', '....##', '....##', '##..##', '.####.'],
    '4': ['...##.', '..###.', '.####.', '##.##.', '######', '...##.', '...##.', '...##.'],
    '5': ['######', '##....', '#####.', '....##', '....##', '....##', '##..##', '.####.'],
    '6': ['.####.', '##....', '##....', '#####.', '##..##', '##..##', '##..##', '.####.'],
    '7': ['######', '....##', '...##.', '...##.', '..##..', '..##..', '.##...', '.##...'],
    '8': ['.####.', '##..##', '##..##', '.####.', '##..##', '##..##', '##..##', '.####.'],
  };
  const withDigit = (d: string, color: [number, number, number] = [255, 230, 163]): Frame => {
    const data = Uint8Array.from(f.data);
    for (let y = 492; y < 504; y++)
      for (let x = 398; x < 410; x++) data.set([39, 115, 203], (y * f.width + x) * 4);
    const g = FONT[d];
    g.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) if (row[c] === '#') data.set(color, ((494 + r) * f.width + 400 + 6 - g[0].length + c) * 4);
    });
    return { ...f, data };
  };
  const upscale = (src: Frame, s: number): Frame => {
    const w = Math.round(src.width * s), h = Math.round(src.height * s);
    const d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const sx = Math.min(src.width - 1.001, Math.max(0, (x + 0.5) / s - 0.5));
        const sy = Math.min(src.height - 1.001, Math.max(0, (y + 0.5) / s - 0.5));
        const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
        for (let k = 0; k < 4; k++) {
          const g = (xx: number, yy: number) => src.data[(yy * src.width + xx) * 4 + k];
          d[(y * w + x) * 4 + k] = Math.round(g(x0, y0) * (1 - fx) * (1 - fy) + g(x0 + 1, y0) * fx * (1 - fy) + g(x0, y0 + 1) * (1 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy);
        }
      }
    return { data: d, width: w, height: h };
  };
  const R = { x: 392, y: 486, w: 22, h: 22 };

  it('1배에서 배운 0~8을 1·1.25·1.5·2배 화면에서도 정확히 읽고, 서로 헷갈리지 않는다', () => {
    const tmpl: Record<string, string[]> = {};
    for (const d of Object.keys(FONT)) tmpl[d] = [readDigitSig(withDigit(d), R)!];
    for (const d of Object.keys(FONT))
      for (const s of [1, 1.25, 1.5, 2]) {
        const frame = s === 1 ? withDigit(d) : upscale(withDigit(d), s);
        const sig = readDigitSig(frame, { x: R.x * s, y: R.y * s, w: R.w * s, h: R.h * s })!;
        expect(matchDigit(sig, tmpl), `${d} ×${s}`).toBe(Number(d));
      }
  });

  it('버튼이 밝아져 숫자가 더 하얗게 보여도 읽는다', () => {
    expect(matchDigit(readDigitSig(withDigit('0', [255, 248, 215]), R)!, DEFAULT_DIGITS)).toBe(0);
  });

  it('영역 전체가 밝으면(버튼 강조) 숫자를 읽지 않는다', () => {
    const data = Uint8Array.from(f.data);
    for (let y = R.y; y < R.y + R.h; y++) for (let x = R.x; x < R.x + R.w; x++) data.set([255, 240, 170], (y * f.width + x) * 4);
    expect(readDigitSig({ ...f, data }, R)).toBeNull();
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

  // 실제 게임의 줄 제거 이펙트 스크린샷(261×33)을 r행 중심에 덮는다
  const withLineClear = (r: number, tint?: (rgb: [number, number, number]) => [number, number, number]): Frame => {
    const f = load('board.png');
    const fx = load('line-clear-effect.png');
    const data = Uint8Array.from(f.data);
    const oy = 127 + r * 26 + 13 - Math.floor(fx.height / 2);
    for (let y = 0; y < fx.height; y++)
      for (let x = 0; x < Math.min(fx.width, 260); x++) {
        const ty = oy + y;
        if (ty < 0 || ty >= f.height) continue;
        const si = (y * fx.width + x) * 4;
        const di = (ty * f.width + 33 + x) * 4;
        let rgb: [number, number, number] = [fx.data[si], fx.data[si + 1], fx.data[si + 2]];
        if (tint) rgb = tint(rgb);
        [data[di], data[di + 1], data[di + 2]] = rgb;
      }
    return { ...f, data };
  };

  it('줄 제거 이펙트는 아이템이 아니고, 위아래 줄 인식에도 영향이 없다', () => {
    const before = readBoard(load('board.png'), BOARD);
    for (const r of [0, 5, 9, 12, 15]) {
      const res = readBoard(withLineClear(r), BOARD);
      // 원래 있던 아이템(이펙트가 덮은 줄 제외) 외에 새 아이템이 없어야 한다
      expect(res.items).toEqual(before.items.filter((it) => it.r !== r));
      for (let k = 0; k < 16; k++) if (k !== r) expect(res.rows[k]).toBe(before.rows[k]);
    }
  });

  it('하늘색이 강한 이펙트 프레임도 아이템이 아니다', () => {
    const before = readBoard(load('board.png'), BOARD);
    // 다른 프레임을 가정: 빨강을 빼서 하늘색 반짝임으로 만든다
    const cyan = ([r, g, b]: [number, number, number]): [number, number, number] =>
      r > 150 && g > 150 ? [20, Math.max(g, 200), 255] : [r, g, b];
    for (const r of [5, 9]) {
      const res = readBoard(withLineClear(r, cyan), BOARD);
      expect(res.items).toEqual(before.items.filter((it) => it.r !== r));
    }
  });
});

describe('파란 블록 위의 점 찍기 (실제 스크린샷)', () => {
  const f = load('dot-on-blue.png'); // 2배 확대 화면, 칸 52px, 가운데 칸에 아이콘
  const B = { x: 20, y: 28, w: 520, h: 832 };
  it('가운데 칸: 파랑 블록 + 점 찍기', () => {
    expect(readCell(f, B, 0, 1)).toMatchObject({ filled: true, color: 'blue', item: 'dot' });
    expect(readCell(f, B, 0, 0)).toMatchObject({ filled: true, color: 'blue', item: null });
    expect(readCell(f, B, 0, 2)).toMatchObject({ filled: true, color: 'blue', item: null });
  });
  it('절반 크기로 줄여도 (색이 섞여도) 인식', () => {
    const w = f.width >> 1;
    const h = f.height >> 1;
    const d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let k = 0; k < 4; k++) {
          let acc = 0;
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) acc += f.data[((y * 2 + dy) * f.width + x * 2 + dx) * 4 + k];
          d[(y * w + x) * 4 + k] = acc / 4;
        }
    const half = { data: d, width: w, height: h };
    expect(readCell(half, { x: 10, y: 14, w: 260, h: 416 }, 0, 1)).toMatchObject({ filled: true, item: 'dot' });
  });
});

describe('분홍 블록 위의 바꿔 뽑기 (실제 스크린샷 7행 7열)', () => {
  const f = load('board.png');
  const B = { x: 33, y: 127, w: 260, h: 416 };
  const pinks: [number, number][] = [];
  const base = readBoard(f, B);
  for (let r = 0; r < 16; r++)
    for (let c = 0; c < 10; c++) if (base.colors[r][c] === 'pink' && !(r === 6 && c === 6)) pinks.push([r, c]);

  it('원본: 분홍 블록 + 바꿔 뽑기', () => {
    expect(readCell(f, B, 6, 6)).toMatchObject({ filled: true, color: 'pink', item: 'swap' });
  });

  it('그 칸을 다른 분홍 블록 칸들에 옮겨 붙여도 똑같이 인식', () => {
    expect(pinks.length).toBeGreaterThan(10);
    for (const [r, c] of pinks) {
      const data = Uint8Array.from(f.data);
      for (let y = 0; y < 26; y++)
        for (let x = 0; x < 26; x++) {
          const si = ((127 + 6 * 26 + y) * f.width + 33 + 6 * 26 + x) * 4;
          const di = ((127 + r * 26 + y) * f.width + 33 + c * 26 + x) * 4;
          data[di] = f.data[si];
          data[di + 1] = f.data[si + 1];
          data[di + 2] = f.data[si + 2];
        }
      expect(readCell({ ...f, data }, B, r, c)).toMatchObject({ filled: true, color: 'pink', item: 'swap' });
    }
  });

  it('아이콘 없는 분홍 블록은 바꿔 뽑기로 오인식하지 않는다', () => {
    for (const [r, c] of pinks) expect(readCell(f, B, r, c).item).toBeNull();
  });
});

describe('보유 조각 인식 (조각별 스크린샷)', () => {
  const cases: [number, PieceType, string][] = [
    [2, '·', 'pink'], [3, 'ㅈ', 'green'], [4, 'ㄷ', 'pink'], [5, 'ㅣ', 'blue'], [6, 'ㅌ', 'yellow'],
    [7, 'ㅅ', 'green'], [8, 'ㄹ', 'pink'], [9, 'ㅇ', 'green'], [10, 'ㄴ', 'pink'], [11, 'ㅡ', 'blue'],
    [12, 'ㅎ', 'yellow'], [13, 'ㄱ', 'pink'], [14, 'ㅋ', 'yellow'], [15, 'ㅁ', 'green'], [16, 'ㅑ', 'blue'],
    [18, 'ㅅ', 'green'], [19, 'ㅈ', 'green'], [20, 'ㅎ', 'yellow'], [21, 'ㅂ', 'green'], [22, 'ㅊ', 'yellow'],
    [23, 'ㅍ', 'yellow'], [24, 'ㅏ', 'blue'],
  ];
  for (const [n, type, color] of cases) {
    it(`${n}번 → ${type} (${color})`, () => {
      const f = load(`piece-${String(n).padStart(2, '0')}.png`);
      const rect = { x: 12, y: 10, w: Math.round(f.width * 0.48) - 12, h: f.height - 22 };
      expect(readHandSlot(f, rect)).toMatchObject({ type, color, used: false });
    });
  }

  it('클릭해서 노랗게 선택된 조각도 그대로 인식 (사용 완료로 보지 않음)', () => {
    const f = load('hand-selected.png');
    const rect = { x: 12, y: 10, w: Math.round(f.width * 0.48) - 12, h: f.height - 22 };
    expect(readHandSlot(f, rect)).toMatchObject({ type: 'ㅡ', color: 'blue', used: false, selected: true });
  });
});

// 인식 견고성 실험: 정답을 아는 스크린샷을 여러 조건으로 변형해 오인식 칸 수를 센다.
//   npx tsx scripts/robustness.ts
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { readBoard, type Frame, type Rect } from '../src/capture/recognize';
import { H, W, rowsFromStrings } from '../src/core/board';

const TRUTH = rowsFromStrings([
  '####..####', '####....##', '####.#.##.', '##.##.#.##', '##.###..#.', '.##.#.#.##',
  '##.#.####.', '##..##..##', '.#..#...#.', '###.##....', '#.####....', '####.##.#.',
  '#.########', '####.##.#.', '#..##.....', '##.######.',
]);
const BOARD: Rect = { x: 33, y: 127, w: 260, h: 416 };

const png = PNG.sync.read(readFileSync('test/fixtures/board.png'));
const base: Frame = { data: png.data, width: png.width, height: png.height };

function errors(f: Frame, rect: Rect): number {
  const rows = readBoard(f, rect).rows;
  let n = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (((rows[r] ^ TRUTH[r]) >> c) & 1) n++;
  return n;
}

/** 쌍선형 크기 변경 */
function resize(f: Frame, s: number): Frame {
  const w = Math.round(f.width * s), h = Math.round(f.height * s);
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(f.width - 1.001, Math.max(0, (x + 0.5) / s - 0.5));
      const sy = Math.min(f.height - 1.001, Math.max(0, (y + 0.5) / s - 0.5));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      for (let k = 0; k < 4; k++) {
        const g = (xx: number, yy: number) => f.data[(yy * f.width + xx) * 4 + k];
        d[(y * w + x) * 4 + k] = Math.round(
          g(x0, y0) * (1 - fx) * (1 - fy) + g(x0 + 1, y0) * fx * (1 - fy) + g(x0, y0 + 1) * (1 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy,
        );
      }
    }
  return { data: d, width: w, height: h };
}

/** 화면 공유 영상 변환 흉내: BT.709 제한 범위 YUV 4:2:0 왕복 (+ 선택적 밝기/색 편차) */
function yuv420(f: Frame, gain = 1, chromaShift = 0): Frame {
  const { width: w, height: h } = f;
  const Y = new Float64Array(w * h), U = new Float64Array(w * h), V = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = f.data[i * 4] / 255, g = f.data[i * 4 + 1] / 255, b = f.data[i * 4 + 2] / 255;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    Y[i] = Math.round(16 + 219 * y * gain);
    U[i] = 128 + 224 * ((b - y) / 1.8556) + chromaShift;
    V[i] = 128 + 224 * ((r - y) / 1.5748) + chromaShift;
  }
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // 2×2 블록 평균 크로마
      const bx = x & ~1, by = y & ~1;
      let u = 0, v = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const xx = Math.min(w - 1, bx + dx), yy = Math.min(h - 1, by + dy);
        u += U[yy * w + xx]; v += V[yy * w + xx]; n++;
      }
      u = Math.round(u / n); v = Math.round(v / n);
      const yy = (Y[y * w + x] - 16) / 219, pb = (u - 128) / 224, pr = (v - 128) / 224;
      const r = yy + 1.5748 * pr, b = yy + 1.8556 * pb, g = (yy - 0.2126 * r - 0.0722 * b) / 0.7152;
      const i = (y * w + x) * 4;
      d[i] = Math.max(0, Math.min(255, Math.round(r * 255)));
      d[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
      d[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      d[i + 3] = 255;
    }
  return { data: d, width: w, height: h };
}

const scaleRect = (r: Rect, s: number): Rect => ({ x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s });

console.log('기준 (원본, 정확한 영역):', errors(base, BOARD), '칸 오류 / 160');

console.log('\n[1] 영역 지정이 어긋났을 때 (dx, dy 픽셀)');
for (const d of [1, 2, 3, 4, 5]) {
  const cases = [[d, 0], [-d, 0], [0, d], [0, -d], [d, d]];
  console.log(`  ±${d}px:`, cases.map(([dx, dy]) => errors(base, { ...BOARD, x: BOARD.x + dx, y: BOARD.y + dy })).join(' '));
}
for (const k of [-6, -3, 3, 6]) console.log(`  크기 ${k > 0 ? '+' : ''}${k}px:`, errors(base, { ...BOARD, w: BOARD.w + k, h: BOARD.h + k * 1.6 }));

console.log('\n[2] 화면 배율이 다를 때 (공유 영상 해상도)');
for (const s of [0.75, 1.25, 1.5, 2]) {
  const f = resize(base, s);
  console.log(`  ×${s}:`, errors(f, scaleRect(BOARD, s)));
}

console.log('\n[3] 화면 공유 영상 변환 (YUV 4:2:0)');
console.log('  색 변환만:', errors(yuv420(base), BOARD));
console.log('  + 밝기 -3%:', errors(yuv420(base, 0.97), BOARD), ' + 밝기 +3%:', errors(yuv420(base, 1.03), BOARD));
console.log('  + 색 편차 ±3:', errors(yuv420(base, 1, 3), BOARD), errors(yuv420(base, 1, -3), BOARD));
console.log('  + ×1.25 배율:', errors(yuv420(resize(base, 1.25)), scaleRect(BOARD, 1.25)));

console.log('\n[4] 조합: 영상 변환 + 영역 2px 어긋남');
console.log('  ', [[2, 0], [0, 2], [2, 2], [-2, -2]].map(([dx, dy]) => errors(yuv420(base), { ...BOARD, x: BOARD.x + dx, y: BOARD.y + dy })).join(' '));

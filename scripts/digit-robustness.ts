// 보유 능력 숫자 인식 견고성 실험:  npx tsx scripts/digit-robustness.ts
// 실제 게임 스크린샷의 점 찍기 동그라미에 0~8 픽셀 숫자를 그려 넣고, 여러 화면 배율로 읽어 본다.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { DEFAULT_DIGITS, digitDistance, matchDigit, readDigitSig, type Frame } from '../src/capture/recognize';

const png = PNG.sync.read(readFileSync('test/fixtures/board.png'));
// 게임의 0과 같은 스타일로 가정한 6×8 픽셀 숫자 (1은 4칸 폭)
export const FONT: Record<string, string[]> = {
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

function withDigit(d: string): Frame {
  const data = Uint8Array.from(png.data);
  const W = png.width;
  for (let y = 492; y < 504; y++)
    for (let x = 398; x < 410; x++) {
      const i = (y * W + x) * 4;
      data[i] = 39;
      data[i + 1] = 115;
      data[i + 2] = 203;
    }
  const g = FONT[d];
  const ox = 400 + (6 - g[0].length);
  g.forEach((row, r) => {
    for (let c = 0; c < row.length; c++)
      if (row[c] === '#') {
        const i = ((494 + r) * W + ox + c) * 4;
        data[i] = 255;
        data[i + 1] = 230;
        data[i + 2] = 163;
      }
  });
  return { data, width: W, height: png.height };
}

function resize(f: Frame, s: number): Frame {
  const w = Math.round(f.width * s), h = Math.round(f.height * s);
  const d = new Uint8Array(w * h * 4);
  // 축소는 면적 평균(실제 화면 축소처럼), 확대는 쌍선형
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let k = 0; k < 4; k++) {
        if (s < 1) {
          const sx0 = x / s, sx1 = (x + 1) / s, sy0 = y / s, sy1 = (y + 1) / s;
          let sum = 0, area = 0;
          for (let yy = Math.floor(sy0); yy < Math.ceil(sy1); yy++)
            for (let xx = Math.floor(sx0); xx < Math.ceil(sx1); xx++) {
              const a = (Math.min(sx1, xx + 1) - Math.max(sx0, xx)) * (Math.min(sy1, yy + 1) - Math.max(sy0, yy));
              if (a <= 0 || xx >= f.width || yy >= f.height) continue;
              sum += f.data[(yy * f.width + xx) * 4 + k] * a;
              area += a;
            }
          d[(y * w + x) * 4 + k] = Math.round(sum / area);
        } else {
          const sx = Math.min(f.width - 1.001, Math.max(0, (x + 0.5) / s - 0.5));
          const sy = Math.min(f.height - 1.001, Math.max(0, (y + 0.5) / s - 0.5));
          const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
          const g = (xx: number, yy: number) => f.data[(yy * f.width + xx) * 4 + k];
          d[(y * w + x) * 4 + k] = Math.round(
            g(x0, y0) * (1 - fx) * (1 - fy) + g(x0 + 1, y0) * fx * (1 - fy) + g(x0, y0 + 1) * (1 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy,
          );
        }
      }
  return { data: d, width: w, height: h };
}

const R = { x: 392, y: 486, w: 22, h: 22 };
const scales = [1, 0.8, 0.9, 1.1, 1.25, 1.33, 1.5, 1.75, 2];
const read = (d: string, s: number) => {
  const f = s === 1 ? withDigit(d) : resize(withDigit(d), s);
  return readDigitSig(f, { x: R.x * s, y: R.y * s, w: R.w * s, h: R.h * s });
};

// 1배 화면에서 0~8을 학습했다고 가정
const tmpl: Record<string, string[]> = {};
for (const d of Object.keys(FONT)) tmpl[d] = [read(d, 1)!];
console.log('기본 내장 0과 1배 0 일치:', tmpl['0'][0] === DEFAULT_DIGITS['0'][0]);
let worstSame = 0, bestCross = 99, crossPair = '';
const fails: string[] = [];
for (const d of Object.keys(FONT))
  for (const s of scales) {
    const sig = read(d, s);
    if (!sig) { fails.push(`${d}@×${s}:숫자 못 찾음`); continue; }
    worstSame = Math.max(worstSame, digitDistance(sig, tmpl[d][0]) === Infinity ? 99 : digitDistance(sig, tmpl[d][0]));
    for (const e of Object.keys(FONT))
      if (e !== d) {
        const x = digitDistance(sig, tmpl[e][0]);
        if (x < bestCross) { bestCross = x; crossPair = `${d}@×${s} vs ${e}`; }
      }
    const m = matchDigit(sig, tmpl);
    if (m !== Number(d)) fails.push(`${d}@×${s}→${m}`);
  }
console.log(`같은 숫자: 최대 ${worstSame}칸 차이 / 다른 숫자: 최소 ${bestCross}칸 차이 (${crossPair})`);
console.log(`잘못 읽음: ${fails.join(', ') || '없음'} (${Object.keys(FONT).length * scales.length}회 중)`);

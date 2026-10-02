// 탐색 속도 측정: npx tsx scripts/bench.ts
import { emptyRows, rowsFromStrings } from '../src/core/board';
import { solve, analyzeSwaps } from '../src/core/search';

const mid = rowsFromStrings([
  '####..####',
  '###.....##',
  '#...#.#.#.',
  '#.#.#.#.##',
  '##.###..#.',
  '.##.#.#.##',
  '.....#....',
  '..........',
  '..........',
  '..........',
  '..........',
  '##.##.#.#.',
  '#.#####.##',
  '##..#.#.#.',
  '#..##.....',
  '##.####.#.',
]);

for (const [name, rows] of [
  ['empty', emptyRows()],
  ['mid', mid],
] as const) {
  for (const beam of [50, 150, 300]) {
    const t = performance.now();
    const plan = solve({ rows, hand: ['ㅂ', 'ㅎ', 'ㅑ'], items: [], inventory: { dot: 1, swap: 0 }, beam });
    console.log(name, 'beam', beam, (performance.now() - t).toFixed(0) + 'ms', plan?.score.toFixed(1), plan?.complete);
  }
}
const t = performance.now();
const adv = analyzeSwaps({ rows: mid, hand: ['ㅂ', 'ㅎ', 'ㅑ'], items: [], inventory: { dot: 0, swap: 1 } });
console.log('swap', (performance.now() - t).toFixed(0) + 'ms', adv.map((a) => `${a.type}:${a.gain.toFixed(1)}`).join(' '));

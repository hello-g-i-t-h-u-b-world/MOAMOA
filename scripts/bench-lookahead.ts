// 다음 손패 미리 보기 속도 측정: npx tsx scripts/bench-lookahead.ts
import { emptyRows, rowsFromStrings } from '../src/core/board';
import { LOOKAHEAD_PRESETS, solveWithLookahead } from '../src/core/lookahead';
import { solve } from '../src/core/search';

const mid = rowsFromStrings([
  '####..####', '###.....##', '#...#.#.#.', '#.#.#.#.##', '##.###..#.', '.##.#.#.##', '.....#....', '..........',
  '..........', '..........', '..........', '##.##.#.#.', '#.#####.##', '##..#.#.#.', '#..##.....', '##.####.#.',
]);
for (const [name, rows] of [['empty', emptyRows()], ['mid', mid]] as const) {
  const input = { rows, hand: ['ㅂ', 'ㅎ', 'ㅑ'] as const, items: [], inventory: { dot: 1, swap: 0 }, maxDots: 2 };
  let t = performance.now();
  const base = solve({ ...input, hand: [...input.hand] });
  console.log(name, 'base', (performance.now() - t).toFixed(0) + 'ms', base?.score.toFixed(1));
  for (const [preset, opts] of Object.entries(LOOKAHEAD_PRESETS)) {
    t = performance.now();
    const plan = solveWithLookahead({ ...input, hand: [...input.hand] }, opts);
    const same = JSON.stringify(plan?.finalRows) === JSON.stringify(base?.finalRows);
    console.log(name, preset, (performance.now() - t).toFixed(0) + 'ms', plan?.outlook, same ? '(같은 수)' : '(다른 수)');
  }
}

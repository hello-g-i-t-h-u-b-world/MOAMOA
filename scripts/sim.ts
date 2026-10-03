// 자가 대국 시뮬레이터 / 가중치 튜너
//   npm run sim -- --games 20 --beam 60
//   npm run sim -- --games 24 --look normal --jobs 8   (다음 손패 미리 보기, 8개 프로세스로 나눠 실행)
//   npm run sim -- --tune 30 --games 12
import { fork } from 'node:child_process';
import { H, INVENTORY_CAP, W, emptyRows, isFilled, type Inventory, type Item, type Rows } from '../src/core/board';
import { DEFAULT_WEIGHTS, type Weights } from '../src/core/eval';
import { PIECE_TYPES, type PieceType } from '../src/core/pieces';
import { LOOKAHEAD_PRESETS, solveWithLookahead } from '../src/core/lookahead';
import { analyzeSwaps, solve, type SolveInput } from '../src/core/search';

const args = process.argv.slice(2);
const arg = (name: string, def: number) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const GAMES = arg('games', 10);
const BEAM = arg('beam', 60);
const MAX_TURNS = arg('turns', 300);
const DROP_EVERY = arg('drop', 5);
const TUNE = arg('tune', 0);
const USE_SWAP = arg('swap', 1) === 1;
const FINALISTS = arg('finalists', 60);
const JOBS = arg('jobs', 1);
const strArg = (name: string, def: string) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
/** 다음 손패 미리 보기: off | fast | normal | deep */
const LOOK = strArg('look', 'off');
if (LOOK !== 'off' && !(LOOK in LOOKAHEAD_PRESETS)) throw new Error(`--look ${LOOK}?`);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GameResult {
  seed: number;
  turns: number;
  lines: number;
  dotsUsed: number;
  swapsUsed: number;
}

function playGame(seed: number, w: Weights): GameResult {
  const rand = rng(seed);
  const pick = (): PieceType => PIECE_TYPES[Math.floor(rand() * PIECE_TYPES.length)];
  let rows: Rows = emptyRows();
  let items: Item[] = [];
  const inv: Inventory = { dot: 0, swap: 0 };
  let placements = 0;
  let lines = 0;
  let dotsUsed = 0;
  let swapsUsed = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const hand: PieceType[] = [pick(), pick(), pick()];
    const choose = (input: SolveInput) =>
      LOOK === 'off'
        ? solve(input)
        : solveWithLookahead(input, {
            ...LOOKAHEAD_PRESETS[LOOK as keyof typeof LOOKAHEAD_PRESETS],
            seed: seed * 7919 + turn,
          });
    const input = () => ({ rows, hand, items, inventory: inv, weights: w, beam: BEAM, finalists: FINALISTS, maxDots: 2 });
    let plan = choose(input());
    // 바꿔 뽑기: 기대 이득이 비용보다 크면 사용 (여러 번 가능)
    while (USE_SWAP && inv.swap > 0 && plan) {
      const adv = analyzeSwaps(input());
      const top = adv[0];
      if (!top || (plan.complete && top.gain < w.swapCost)) break;
      hand[top.slot] = pick();
      inv.swap--;
      swapsUsed++;
      plan = choose(input());
    }
    if (!plan || !plan.complete) return { seed, turns: turn, lines, dotsUsed, swapsUsed };

    rows = plan.finalRows;
    items = plan.finalItems;
    lines += plan.lines;
    inv.dot -= plan.dotsUsed;
    dotsUsed += plan.dotsUsed;
    for (const it of plan.itemsGained) if (inv.dot + inv.swap < INVENTORY_CAP) inv[it.type]++;

    // 아이템 드롭 (근사: 턴 종료 시 처리)
    const before = placements;
    placements += hand.length;
    const drops = Math.floor(placements / DROP_EVERY) - Math.floor(before / DROP_EVERY);
    for (let d = 0; d < drops; d++) {
      const empties: [number, number][] = [];
      for (let r = 0; r < H; r++)
        for (let c = 0; c < W; c++)
          if (!isFilled(rows, r, c) && !items.some((it) => it.r === r && it.c === c)) empties.push([r, c]);
      if (!empties.length) break;
      const [r, c] = empties[Math.floor(rand() * empties.length)];
      items = items.concat({ r, c, type: rand() < 0.5 ? 'dot' : 'swap' });
    }
  }
  return { seed, turns: MAX_TURNS, lines, dotsUsed, swapsUsed };
}

function evaluate(w: Weights, seeds: number[]): { mean: number; results: GameResult[] } {
  const results = seeds.map((s) => playGame(s, w));
  return { mean: results.reduce((a, r) => a + r.turns, 0) / results.length, results };
}

const seedList = strArg('seeds', '');
const seeds = seedList ? seedList.split(',').map(Number) : Array.from({ length: GAMES }, (_, i) => 1000 + i);

/** 판들을 여러 자식 프로세스에 나눠 실행한다 */
async function runParallel(): Promise<GameResult[]> {
  const base = args.filter((a, i) => !['--jobs', '--seeds', '--games'].includes(a) && !['--jobs', '--seeds', '--games'].includes(args[i - 1]));
  const groups = Array.from({ length: JOBS }, (_, j) => seeds.filter((_, i) => i % JOBS === j)).filter((g) => g.length);
  const parts = await Promise.all(
    groups.map(
      (g) =>
        new Promise<GameResult[]>((resolve, reject) => {
          const out: GameResult[] = [];
          const child = fork(process.argv[1], [...base, '--seeds', g.join(','), '--child', '1'], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
          child.on('message', (m) => {
            const r = m as GameResult;
            out.push(r);
            console.log(JSON.stringify(r));
          });
          child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`child exit ${code}`))));
        }),
    ),
  );
  return parts.flat().sort((a, b) => a.seed - b.seed);
}

if (arg('child', 0)) {
  for (const s of seeds) process.send!(playGame(s, DEFAULT_WEIGHTS));
} else if (!TUNE) {
  const t = performance.now();
  const results = JOBS > 1 ? await runParallel() : evaluate(DEFAULT_WEIGHTS, seeds).results;
  if (JOBS <= 1) for (const r of results) console.log(JSON.stringify(r));
  const mean = results.reduce((a, r) => a + r.turns, 0) / results.length;
  const died = results.filter((r) => r.turns < MAX_TURNS).length;
  const turnsTotal = results.reduce((a, r) => a + r.turns, 0);
  console.log(
    `[look=${LOOK} beam=${BEAM}] 평균 생존 턴: ${mean.toFixed(1)} (최대 ${MAX_TURNS}), ` +
      `게임오버 ${died}/${results.length}판, 1000턴당 게임오버 ${((died / turnsTotal) * 1000).toFixed(2)}회, ` +
      `${((performance.now() - t) / 1000).toFixed(1)}s`,
  );
} else {
  // 간단한 무작위 언덕 오르기
  const rand = rng(42);
  let best: Weights = { ...DEFAULT_WEIGHTS };
  let bestMean = evaluate(best, seeds).mean;
  console.log('start', bestMean);
  const keys = Object.keys(best) as (keyof Weights)[];
  for (let it = 0; it < TUNE; it++) {
    const cand = { ...best };
    for (const k of keys) if (rand() < 0.4) cand[k] = +(cand[k] * (0.6 + rand() * 0.8)).toFixed(3);
    const m = evaluate(cand, seeds).mean;
    console.log(it, m.toFixed(1), m > bestMean ? '★' : '');
    if (m > bestMean) {
      bestMean = m;
      best = cand;
      console.log(JSON.stringify(best));
    }
  }
  console.log('best', bestMean, JSON.stringify(best, null, 2));
}

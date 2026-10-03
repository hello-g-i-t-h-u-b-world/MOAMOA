// 자가 대국 시뮬레이터 / 가중치 튜너
//   npm run sim -- --games 20 --beam 60
//   npm run sim -- --games 24 --look normal --jobs 8   (다음 손패 미리 보기, 8개 프로세스로 나눠 실행)
//   npm run sim -- --tune 30 --games 12
import { fork } from 'node:child_process';
import { BOARD_ITEM_CAP, DROP_EVERY, H, INVENTORY_CAP, W, emptyRows, isFilled, type Inventory, type Item, type Rows } from '../src/core/board';
import { DEFAULT_WEIGHTS, type Weights } from '../src/core/eval';
import type { PieceType } from '../src/core/pieces';
import { DOT_PROB, pickPiece, pieceProbs, setPieceStats, stageOf } from '../src/core/rules';
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
/** 조각 확률을 모든 조각 균등으로 (--uniform 1). 기본은 실제 플레이 통계(piece-stats.json) */
if (arg('uniform', 0)) setPieceStats({});
/** 게임 점수 가중치 덮어쓰기 (--points 0.02) */
const SIM_W: Weights = { ...DEFAULT_WEIGHTS, points: Number(strArg('points', String(DEFAULT_WEIGHTS.points))) };
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
  /** 게임 점수 (배치 칸 수 + 줄 제거 300×줄² + 능력 획득 50) */
  score: number;
  lines: number;
  /** 동시에 지운 줄 수별 횟수 [1줄, 2줄, 3줄, 4줄, 5줄] */
  combos: number[];
  dotsUsed: number;
  swapsUsed: number;
}

async function playGame(seed: number, w: Weights): Promise<GameResult> {
  const rand = rng(seed);
  // 조각 등장 확률은 제거한 줄 누적(단계)에 따라 바뀐다
  const pick = (): PieceType => pickPiece(rand, pieceProbs(stageOf(lines)));
  let rows: Rows = emptyRows();
  let items: Item[] = [];
  const inv: Inventory = { dot: 0, swap: 0 };
  /** 다음 아이템이 떨어질 때까지 남은 블록 수 (게임의 '다음 능력 획득까지') */
  let dropIn = DROP_EVERY;
  let lines = 0;
  let score = 0;
  const combos = [0, 0, 0, 0, 0];
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
    const input = () => ({
      rows,
      hand,
      items,
      inventory: inv,
      dropIn,
      stage: stageOf(lines),
      weights: w,
      beam: BEAM,
      finalists: FINALISTS,
      maxDots: 2,
    });
    let plan = await choose(input());
    // 바꿔 뽑기: 기대 이득이 비용보다 크면 사용 (여러 번 가능)
    while (USE_SWAP && inv.swap > 0 && plan) {
      const adv = analyzeSwaps(input());
      const top = adv[0];
      if (!top || (plan.complete && top.gain < w.swapCost)) break;
      hand[top.slot] = pick();
      inv.swap--;
      swapsUsed++;
      plan = await choose(input());
    }
    if (!plan || !plan.complete) return { seed, turns: turn, score, lines, combos, dotsUsed, swapsUsed };

    rows = plan.finalRows;
    items = plan.finalItems;
    lines += plan.lines;
    score += plan.points;
    for (const m of plan.moves) if (m.cleared.length) combos[Math.min(5, m.cleared.length) - 1]++;
    inv.dot -= plan.dotsUsed;
    dotsUsed += plan.dotsUsed;
    for (const it of plan.itemsGained) if (inv.dot + inv.swap < INVENTORY_CAP) inv[it.type]++;

    // 아이템 드롭: 블록 7개마다 빈 칸에 하나. 보드 위에 3개가 넘으면 가장 오래된 것이 사라진다.
    // (사라지는 것은 계획(finalItems)에 이미 반영됨. 새 아이템 자리는 근사로 턴 끝에 정한다)
    const placed = plan.moves.filter((m) => m.kind === 'piece').length;
    // 능력을 7개 보유 중이면 생기지 않는다
    if (placed >= dropIn && inv.dot + inv.swap < INVENTORY_CAP) {
      const empties: [number, number][] = [];
      for (let r = 0; r < H; r++)
        for (let c = 0; c < W; c++)
          if (!isFilled(rows, r, c) && !items.some((it) => it.r === r && it.c === c)) empties.push([r, c]);
      if (empties.length) {
        const [r, c] = empties[Math.floor(rand() * empties.length)];
        items = items.concat({ r, c, type: rand() < DOT_PROB ? 'dot' : 'swap' });
        if (items.length > BOARD_ITEM_CAP) items = items.slice(items.length - BOARD_ITEM_CAP);
      }
    }
    if (placed >= dropIn) dropIn += DROP_EVERY;
    dropIn -= placed;
  }
  return { seed, turns: MAX_TURNS, score, lines, combos, dotsUsed, swapsUsed };
}

async function evaluate(w: Weights, seeds: number[]): Promise<{ mean: number; results: GameResult[] }> {
  const results: GameResult[] = [];
  for (const s of seeds) results.push(await playGame(s, w));
  // 목표는 점수 (튜닝도 평균 점수 기준)
  return { mean: results.reduce((a, r) => a + r.score, 0) / results.length, results };
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
  for (const s of seeds) process.send!(await playGame(s, SIM_W));
} else if (!TUNE) {
  const t = performance.now();
  const results = JOBS > 1 ? await runParallel() : (await evaluate(SIM_W, seeds)).results;
  if (JOBS <= 1) for (const r of results) console.log(JSON.stringify(r));
  const mean = results.reduce((a, r) => a + r.turns, 0) / results.length;
  const meanScore = results.reduce((a, r) => a + r.score, 0) / results.length;
  const combos = [0, 1, 2, 3, 4].map((k) => results.reduce((a, r) => a + r.combos[k], 0));
  const clears = combos.reduce((a, b) => a + b, 0) || 1;
  const died = results.filter((r) => r.turns < MAX_TURNS).length;
  const turnsTotal = results.reduce((a, r) => a + r.turns, 0);
  console.log(
    `[look=${LOOK} beam=${BEAM} points=${SIM_W.points}] 평균 점수 ${Math.round(meanScore).toLocaleString()} ` +
      `(턴당 ${Math.round(meanScore / Math.max(1, mean))}) · 동시 제거 비율 ${combos.map((n, k) => `${k + 1}줄 ${((n / clears) * 100).toFixed(0)}%`).join(' ')} · ` +
      `평균 생존 턴: ${mean.toFixed(1)} (최대 ${MAX_TURNS}), ` +
      `게임오버 ${died}/${results.length}판, 1000턴당 게임오버 ${((died / turnsTotal) * 1000).toFixed(2)}회, ` +
      `${((performance.now() - t) / 1000).toFixed(1)}s`,
  );
} else {
  // 간단한 무작위 언덕 오르기
  const rand = rng(42);
  let best: Weights = { ...SIM_W };
  let bestMean = (await evaluate(best, seeds)).mean;
  console.log('start', bestMean);
  const keys = Object.keys(best) as (keyof Weights)[];
  for (let it = 0; it < TUNE; it++) {
    const cand = { ...best };
    for (const k of keys) if (rand() < 0.4) cand[k] = +(cand[k] * (0.6 + rand() * 0.8)).toFixed(3);
    const m = (await evaluate(cand, seeds)).mean;
    console.log(it, m.toFixed(1), m > bestMean ? '★' : '');
    if (m > bestMean) {
      bestMean = m;
      best = cand;
      console.log(JSON.stringify(best));
    }
  }
  console.log('best', bestMean, JSON.stringify(best, null, 2));
}

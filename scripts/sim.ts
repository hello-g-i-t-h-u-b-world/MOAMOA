// 자가 대국 시뮬레이터 / 가중치 튜너
//   npm run sim -- --games 20 --beam 60
//   npm run sim -- --games 24 --look normal --jobs 8   (다음 손패 미리 보기, 8개 프로세스로 나눠 실행)
//   npm run sim -- --tune 60 --games 48 --jobs 16   (가중치 튜닝: 매번 새 시드로 지금 가중치와 후보를 짝지어 비교)
//   npm run sim -- --weights '{"hole1":-3}'          (가중치 일부 덮어쓰기)
import { fork, type ChildProcess } from 'node:child_process';
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
/** 게임 점수 가중치 덮어쓰기 (--points 0.02), 가중치 일부 덮어쓰기 (--weights '{"hole1":-3}') */
const SIM_W: Weights = {
  ...DEFAULT_WEIGHTS,
  points: Number(strArg('points', String(DEFAULT_WEIGHTS.points))),
  ...(JSON.parse(strArg('weights', '{}')) as Partial<Weights>),
};
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

/** 계속 살아 있는 자식 프로세스 풀. 먼저 끝난 프로세스가 다음 판을 받는다 (튜닝용) */
class GamePool {
  private idle: ChildProcess[] = [];
  private all: ChildProcess[] = [];
  private queue: { seed: number; w: Weights; done: (r: GameResult) => void }[] = [];
  constructor(n: number) {
    const drop = ['--jobs', '--tune', '--seeds', '--games'];
    const base = args.filter((a, i) => !drop.includes(a) && !drop.includes(args[i - 1]));
    for (let i = 0; i < n; i++) {
      const child = fork(process.argv[1], [...base, '--worker', '1'], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
      this.all.push(child);
      this.idle.push(child);
    }
  }
  run(seed: number, w: Weights): Promise<GameResult> {
    return new Promise((done) => {
      this.queue.push({ seed, w, done });
      this.pump();
    });
  }
  runAll(w: Weights, seeds: number[]): Promise<GameResult[]> {
    return Promise.all(seeds.map((s) => this.run(s, w)));
  }
  private pump() {
    while (this.idle.length && this.queue.length) {
      const child = this.idle.pop()!;
      const job = this.queue.shift()!;
      child.once('message', (m) => {
        this.idle.push(child);
        job.done(m as GameResult);
        this.pump();
      });
      child.send({ seed: job.seed, w: job.w });
    }
  }
  close() {
    for (const c of this.all) c.kill();
  }
}

if (arg('worker', 0)) {
  // GamePool 작업자: { seed, w } 를 받아 한 판 두고 결과를 돌려준다
  process.on('message', async (m) => {
    const { seed, w } = m as { seed: number; w: Weights };
    process.send!(await playGame(seed, w));
  });
} else if (arg('child', 0)) {
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
  // 무작위 언덕 오르기. 판마다 점수 편차가 커서 같은 시드 묶음으로 평균만 비교하면 우연히 좋게 나온 후보가 뽑힌다.
  // → 매 회 새 시드 묶음으로 지금 가중치와 후보를 함께 돌려, 짝지은 점수 차이의 t값이 --tune-t 를 넘을 때만 바꾼다.
  const TUNE_T = arg('tune-t', 1);
  const pool = new GamePool(Math.max(1, JOBS));
  const rand = rng(arg('tune-seed', 42));
  let best: Weights = { ...SIM_W };
  // filled 는 척도 기준으로 고정 (모든 가중치를 같은 배수로 바꾸면 결과가 같다)
  const keys = (Object.keys(best) as (keyof Weights)[]).filter((k) => k !== 'filled');
  const start = arg('tune-start', 0);
  for (let it = start; it < start + TUNE; it++) {
    const cand = { ...best };
    const changed: string[] = [];
    while (!changed.length)
      for (const k of keys)
        if (rand() < 0.25) {
          cand[k] = +(cand[k] * Math.exp((rand() - 0.5) * 0.8)).toPrecision(3); // ×0.67 ~ ×1.49
          changed.push(`${k} ${best[k]}→${cand[k]}`);
        }
    const batch = Array.from({ length: GAMES }, (_, i) => 100000 + it * GAMES + i);
    const t0 = performance.now();
    const [a, b] = await Promise.all([pool.runAll(best, batch), pool.runAll(cand, batch)]);
    const mean = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length;
    const d = a.map((r, i) => b[i].score - r.score);
    const md = mean(d);
    const sd = Math.sqrt(d.reduce((x, y) => x + (y - md) ** 2, 0) / (d.length - 1));
    const tv = md / (sd / Math.sqrt(d.length));
    const ok = tv > TUNE_T;
    console.log(
      `[${it}] 지금 ${Math.round(mean(a.map((r) => r.score)))} vs 후보 ${Math.round(mean(b.map((r) => r.score)))} ` +
        `(차이 ${Math.round(md)}, t=${tv.toFixed(2)})${ok ? ' ★ 채택' : ''} · ${changed.join(', ')} · ${((performance.now() - t0) / 1000).toFixed(0)}s`,
    );
    if (ok) {
      best = cand;
      console.log('best ' + JSON.stringify(best));
    }
  }
  pool.close();
  console.log('최종 ' + JSON.stringify(best, null, 2));
}

// 탐색 Worker 여러 개에 작업을 나눠 맡긴다 (CPU 코어를 여러 개 쓰기 위해).
//   계획: 후보 구하기(Worker 1개) → 다음 손패 미리 보기(손패를 나눠 Worker 여럿) → 합쳐서 고르기
// Worker는 필요할 때 만들고, 동시에 일하는 수는 설정(보통: 코어 수 - 2 / 최고: 코어 수 - 1)으로 제한한다.
import {
  runLookahead,
  type InnerOptions,
  type Lookahead2Totals,
  type LookaheadBase,
  type LookaheadOptions,
  type LookaheadPhase,
  type LookaheadRunner,
  type LookaheadTotals,
  type NextState,
} from './lookahead';
import type { PieceType } from './pieces';
import type { Plan, SolveInput, SwapAdvice } from './search';
import type { WorkerRequest, WorkerResponse, WorkerResult, WorkerTask } from './solver.worker';

/** 새 요청이 들어와 취소된 작업 */
export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

function cores(): number {
  return typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
}

/** 기본: 화면을 그리고 게임을 돌릴 코어는 남겨 둔다 */
export function defaultPoolSize(): number {
  return Math.max(1, Math.min(8, cores() - 2));
}

/** '최고' 설정: 코어를 하나만 남기고 전부 */
export function maxPoolSize(): number {
  return Math.max(1, Math.min(32, cores() - 1));
}

type Tag = 'plan' | 'swaps';

interface Job {
  taskId: number;
  task: WorkerTask;
  tag: Tag;
  resolve: (r: WorkerResult) => void;
  reject: (e: Error) => void;
}

interface Slot {
  w: Worker;
  job: Job | null;
}

/** 배열을 k개로 고르게 나눈다 */
function split<T>(items: readonly T[], k: number): T[][] {
  const n = Math.max(1, Math.min(items.length, k));
  return Array.from({ length: n }, (_, i) => items.filter((_, j) => j % n === i));
}

export class SolverPool {
  private readonly workers: Slot[] = [];
  private queue: Job[] = [];
  private nextTaskId = 1;
  /** 동시에 일하는 Worker 수 상한 */
  private limit = defaultPoolSize();

  constructor(private readonly maxSize = maxPoolSize()) {}

  /** 지금 설정에서 동시에 쓰는 Worker(코어) 수 */
  get size(): number {
    return Math.min(this.limit, this.maxSize);
  }

  private spawn(): Slot {
    const slot: Slot = {
      w: new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' }),
      job: null,
    };
    slot.w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const job = slot.job;
      slot.job = null;
      if (job && job.taskId === e.data.taskId) {
        if (e.data.result) job.resolve(e.data.result);
        else job.reject(new Error(e.data.error ?? 'worker error'));
      }
      this.pump();
    };
    this.workers.push(slot);
    return slot;
  }

  /** 아직 시작하지 않은 작업을 취소한다 (이미 계산 중인 작업은 끝까지 돈다) */
  cancel(tag: Tag) {
    const dropped = this.queue.filter((j) => j.tag === tag);
    this.queue = this.queue.filter((j) => j.tag !== tag);
    for (const j of dropped) j.reject(new Cancelled());
  }

  private run(task: WorkerTask, tag: Tag): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ taskId: this.nextTaskId++, task, tag, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    while (this.queue.length) {
      const busy = this.workers.filter((s) => s.job).length;
      if (busy >= this.size) return;
      const slot = this.workers.find((s) => !s.job) ?? (this.workers.length < this.maxSize ? this.spawn() : null);
      if (!slot) return;
      const job = this.queue.shift()!;
      slot.job = job;
      slot.w.postMessage({ taskId: job.taskId, task: job.task } satisfies WorkerRequest);
    }
  }

  /** 미리 보기 계산을 Worker들에 나눠 맡기는 runner (코어마다 속도가 달라도 고르게 끝나도록 잘게 나눈다) */
  private runner(): LookaheadRunner {
    const sum = <T extends LookaheadTotals>(parts: WorkerResult[], kind: 'lookahead' | 'lookahead2', n: number): T => {
      const acc = { totals: Array(n).fill(0), completes: Array(n).fill(0), pairCompletes: Array(n).fill(0) };
      for (const p of parts) {
        if (p.kind !== kind) continue;
        const r = p.result as Partial<Lookahead2Totals> & LookaheadTotals;
        r.totals.forEach((v, i) => (acc.totals[i] += v));
        r.completes.forEach((v, i) => (acc.completes[i] += v));
        r.pairCompletes?.forEach((v, i) => (acc.pairCompletes[i] += v));
      }
      return acc as unknown as T;
    };
    return {
      totals: async (states: NextState[], hands: PieceType[][], base: LookaheadBase, opts: InnerOptions) => {
        const parts = await Promise.all(
          split(hands, this.size * 3).map((h) => this.run({ kind: 'lookahead', states, hands: h, base, opts }, 'plan')),
        );
        return sum<LookaheadTotals>(parts, 'lookahead', states.length);
      },
      totals2: async (states, hands1, hands2, base, opts) => {
        const parts = await Promise.all(
          split(hands1, this.size * 3).map((h) =>
            this.run({ kind: 'lookahead2', states, hands1: h, hands2, base, opts }, 'plan'),
          ),
        );
        return sum<Lookahead2Totals>(parts, 'lookahead2', states.length);
      },
    };
  }

  /**
   * 최적 계획. look이 있으면 다음 손패를 미리 보고 고른다.
   * onPhase: 미리 보기 단계가 바뀔 때 알림
   */
  async plan(input: SolveInput, look: LookaheadOptions | null, onPhase?: (p: LookaheadPhase) => void): Promise<Plan | null> {
    this.cancel('plan');
    this.limit = look?.allCores ? this.maxSize : defaultPoolSize();
    const res = await this.run({ kind: 'candidates', input, look }, 'plan');
    if (res.kind !== 'candidates') throw new Error('unexpected result');
    const plans = res.plans;
    if (!look || plans.length <= 1) return plans[0] ?? null;
    return runLookahead(input, plans, look, this.runner(), onPhase);
  }

  async swaps(input: SolveInput): Promise<SwapAdvice[]> {
    this.cancel('swaps');
    const res = await this.run({ kind: 'swaps', input }, 'swaps');
    if (res.kind !== 'swaps') throw new Error('unexpected result');
    return res.swaps;
  }
}

// 탐색 Worker 여러 개에 작업을 나눠 맡긴다 (CPU 코어를 여러 개 쓰기 위해).
//   계획: 후보 구하기(Worker 1개) → 다음 손패 미리 보기(손패를 나눠 Worker 전부) → 합쳐서 고르기
import { chooseByLookahead, sampleHands, stateAfter, type LookaheadOptions, type LookaheadTotals } from './lookahead';
import type { Rows } from './board';
import type { Plan, SolveInput, SwapAdvice } from './search';
import type { WorkerRequest, WorkerResponse, WorkerResult, WorkerTask } from './solver.worker';

/** 새 요청이 들어와 취소된 작업 */
export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/** 화면을 그리고 게임을 돌릴 코어는 남겨 둔다 */
export function defaultPoolSize(): number {
  const n = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(8, n - 2));
}

type Tag = 'plan' | 'swaps';

interface Job {
  taskId: number;
  task: WorkerTask;
  tag: Tag;
  resolve: (r: WorkerResult) => void;
  reject: (e: Error) => void;
}

/** 같은 보드·손패면 같은 다음 손패를 뽑아 '다시 계산'해도 같은 결과가 나오게 한다 */
function seedOf(rows: Rows, hand: SolveInput['hand']): number {
  let h = 0x811c9dc5;
  for (const r of rows) h = Math.imul(h ^ r, 0x01000193);
  for (const p of hand) h = Math.imul(h ^ (p ? p.charCodeAt(0) : 0), 0x01000193);
  return h >>> 0;
}

export class SolverPool {
  private readonly workers: { w: Worker; job: Job | null }[];
  private queue: Job[] = [];
  private nextTaskId = 1;

  constructor(size = defaultPoolSize()) {
    this.workers = Array.from({ length: size }, () => {
      const slot = {
        w: new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' }),
        job: null as Job | null,
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
      return slot;
    });
  }

  get size(): number {
    return this.workers.length;
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
    for (const slot of this.workers) {
      if (slot.job || !this.queue.length) continue;
      const job = this.queue.shift()!;
      slot.job = job;
      slot.w.postMessage({ taskId: job.taskId, task: job.task } satisfies WorkerRequest);
    }
  }

  /**
   * 최적 계획. look이 있으면 다음 손패를 미리 보고 고른다.
   * onPhase: 미리 보기를 시작할 때 (후보 수, 다음 손패 수) 알림
   */
  async plan(
    input: SolveInput,
    look: LookaheadOptions | null,
    onPhase?: (candidates: number, samples: number) => void,
  ): Promise<Plan | null> {
    this.cancel('plan');
    const res = await this.run({ kind: 'candidates', input, look }, 'plan');
    if (res.kind !== 'candidates') throw new Error('unexpected result');
    const plans = res.plans;
    if (!look || look.candidates <= 1 || look.samples <= 0 || plans.length <= 1) return plans[0] ?? null;

    onPhase?.(plans.length, look.samples);
    const hands = sampleHands(look.samples, look.seed ?? seedOf(input.rows, input.hand));
    const states = plans.map((p) => stateAfter(input, p));
    // 코어마다 속도가 달라도 고르게 끝나도록 Worker 수보다 잘게 나눈다
    const chunks = Math.min(hands.length, this.size * 3);
    const parts = await Promise.all(
      Array.from({ length: chunks }, (_, i) =>
        this.run(
          {
            kind: 'lookahead',
            states,
            hands: hands.filter((_, k) => k % chunks === i),
            base: { weights: input.weights, maxDots: input.maxDots },
            opts: { beam: look.beam, finalists: look.finalists },
          },
          'plan',
        ),
      ),
    );
    const sum: LookaheadTotals = { totals: plans.map(() => 0), completes: plans.map(() => 0) };
    for (const p of parts) {
      if (p.kind !== 'lookahead') continue;
      p.result.totals.forEach((v, i) => (sum.totals[i] += v));
      p.result.completes.forEach((v, i) => (sum.completes[i] += v));
    }
    return chooseByLookahead(input, plans, sum, hands.length);
  }

  async swaps(input: SolveInput): Promise<SwapAdvice[]> {
    this.cancel('swaps');
    const res = await this.run({ kind: 'swaps', input }, 'swaps');
    if (res.kind !== 'swaps') throw new Error('unexpected result');
    return res.swaps;
  }
}

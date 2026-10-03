/// <reference lib="webworker" />
// 탐색 Worker. pool.ts가 여러 개를 띄워 작업을 나눠 맡긴다.
import { lookaheadCandidates, lookaheadTotals, type LookaheadOptions, type LookaheadTotals, type NextState } from './lookahead';
import type { PieceType } from './pieces';
import { analyzeSwaps, solveTop, type Plan, type SolveInput, type SwapAdvice } from './search';

export type WorkerTask =
  /** 이번 손패의 계획 후보 (look이 없으면 1등 하나만) */
  | { kind: 'candidates'; input: SolveInput; look: LookaheadOptions | null }
  /** 후보 상태들에 다음 손패 일부를 계산해 점수 합을 낸다 */
  | {
      kind: 'lookahead';
      states: NextState[];
      hands: PieceType[][];
      base: Pick<SolveInput, 'weights' | 'maxDots'>;
      opts: Pick<LookaheadOptions, 'beam' | 'finalists'>;
    }
  /** 바꿔 뽑기 분석 */
  | { kind: 'swaps'; input: SolveInput };

export type WorkerResult =
  | { kind: 'candidates'; plans: Plan[] }
  | { kind: 'lookahead'; result: LookaheadTotals }
  | { kind: 'swaps'; swaps: SwapAdvice[] };

export interface WorkerRequest {
  taskId: number;
  task: WorkerTask;
}

export interface WorkerResponse {
  taskId: number;
  result?: WorkerResult;
  error?: string;
}

function run(task: WorkerTask): WorkerResult {
  switch (task.kind) {
    case 'candidates':
      return {
        kind: 'candidates',
        plans: task.look ? lookaheadCandidates(task.input, task.look) : solveTop(task.input, 1),
      };
    case 'lookahead':
      return { kind: 'lookahead', result: lookaheadTotals(task.states, task.hands, task.base, task.opts) };
    case 'swaps':
      return { kind: 'swaps', swaps: analyzeSwaps(task.input) };
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { taskId, task } = e.data;
  try {
    self.postMessage({ taskId, result: run(task) } satisfies WorkerResponse);
  } catch (err) {
    self.postMessage({ taskId, error: String(err) } satisfies WorkerResponse);
  }
};

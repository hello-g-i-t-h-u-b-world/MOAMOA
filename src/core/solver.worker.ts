/// <reference lib="webworker" />
import { analyzeSwaps, solve, type Plan, type SolveInput, type SwapAdvice } from './search';

export interface SolveRequest {
  id: number;
  input: SolveInput;
}

export type SolveResponse =
  | { id: number; kind: 'plan'; plan: Plan | null; ms: number }
  | { id: number; kind: 'swaps'; swaps: SwapAdvice[]; ms: number };

let latest = 0;

self.onmessage = (e: MessageEvent<SolveRequest>) => {
  const { id, input } = e.data;
  latest = id;
  const t0 = performance.now();
  const plan = solve(input);
  self.postMessage({ id, kind: 'plan', plan, ms: performance.now() - t0 } satisfies SolveResponse);
  // 바꿔 뽑기 분석은 오래 걸리므로 계획을 먼저 보낸 뒤 이어서 계산한다
  if (input.inventory.swap > 0) {
    setTimeout(() => {
      if (id !== latest) return; // 새 요청이 들어왔으면 생략
      const t1 = performance.now();
      const swaps = analyzeSwaps(input);
      self.postMessage({ id, kind: 'swaps', swaps, ms: performance.now() - t1 } satisfies SolveResponse);
    }, 0);
  }
};

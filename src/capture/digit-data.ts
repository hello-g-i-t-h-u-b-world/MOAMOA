// 숫자 학습 데이터 내보내기 / 검사·합치기
import { INVENTORY_CAP } from '../core/board';
import { digitDistance, type DigitSig, type DigitTemplates } from './recognize';

export interface DigitExport {
  app: 'moamoa-digits';
  version: 2;
  exportedAt: string;
  /** 기본 내장값을 뺀, 사용자가 학습시킨 숫자 (보유 능력 개수) */
  digits: DigitTemplates;
  /** '다음 능력 획득까지' 숫자 (글꼴이 달라 따로 학습) */
  dropDigits?: DigitTemplates;
  /** 점수·제거한 줄 수의 숫자 (0~9) */
  numDigits?: DigitTemplates;
}

/** 기본 내장값에 없는(사용자가 학습시킨) 것만 */
export function learnedOnly(all: DigitTemplates, defaults: DigitTemplates): DigitTemplates {
  const out: DigitTemplates = {};
  for (const [d, sigs] of Object.entries(all)) {
    const extra = sigs.filter((s) => !defaults[d]?.includes(s));
    if (extra.length) out[d] = extra;
  }
  return out;
}

export function makeExport(
  all: DigitTemplates,
  defaults: DigitTemplates,
  dropAll: DigitTemplates = {},
  dropDefaults: DigitTemplates = {},
  numAll: DigitTemplates = {},
  numDefaults: DigitTemplates = {},
): DigitExport {
  const dropDigits = learnedOnly(dropAll, dropDefaults);
  const numDigits = learnedOnly(numAll, numDefaults);
  return {
    app: 'moamoa-digits',
    version: 2,
    exportedAt: new Date().toISOString(),
    digits: learnedOnly(all, defaults),
    ...(Object.keys(dropDigits).length ? { dropDigits } : {}),
    ...(Object.keys(numDigits).length ? { numDigits } : {}),
  };
}

/** 이 칸 수 이하로만 다르면 같은 숫자로 읽힌다 (matchDigit 기준과 같게) */
const SAME_DIST = 2;

export interface MergeReport {
  added: { digit: string; sig: DigitSig }[];
  duplicates: number;
  /** 다른 숫자와 헷갈릴 만큼 비슷해서 넣지 않은 것 */
  conflicts: { digit: string; sig: DigitSig; looksLike: string; dist: number }[];
  invalid: string[];
}

export function isValidSig(sig: unknown): sig is DigitSig {
  if (typeof sig !== 'string') return false;
  const m = /^(\d+)\|([0-9]+)$/.exec(sig);
  return !!m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && m[2].length === Number(m[1]) * 8;
}

/**
 * 받은 학습 데이터를 기존 데이터에 합친다.
 * - 형식이 틀리거나 0~7이 아닌 숫자는 버림
 * - 이미 있는 모양은 건너뜀
 * - 다른 숫자로 학습된 모양과 거의 같으면(잘못 답했을 가능성) 넣지 않고 보고
 */
export function mergeDigits(
  base: DigitTemplates,
  incoming: DigitTemplates,
  maxDigit = INVENTORY_CAP,
): { merged: DigitTemplates; report: MergeReport } {
  const merged: DigitTemplates = structuredClone(base);
  const report: MergeReport = { added: [], duplicates: 0, conflicts: [], invalid: [] };
  for (const [digit, sigs] of Object.entries(incoming ?? {})) {
    if (!/^\d$/.test(digit) || Number(digit) > maxDigit) {
      report.invalid.push(`숫자 ${digit}`);
      continue;
    }
    for (const sig of Array.isArray(sigs) ? sigs : []) {
      if (!isValidSig(sig)) {
        report.invalid.push(`${digit}: ${String(sig).slice(0, 20)}`);
        continue;
      }
      if (merged[digit]?.includes(sig)) {
        report.duplicates++;
        continue;
      }
      let conflict: MergeReport['conflicts'][number] | null = null;
      for (const [other, otherSigs] of Object.entries(merged)) {
        if (other === digit) continue;
        for (const o of otherSigs) {
          const dist = digitDistance(sig, o);
          if (dist <= SAME_DIST && (!conflict || dist < conflict.dist)) conflict = { digit, sig, looksLike: other, dist };
        }
      }
      if (conflict) {
        report.conflicts.push(conflict);
        continue;
      }
      (merged[digit] ??= []).push(sig);
      report.added.push({ digit, sig });
    }
  }
  return { merged, report };
}

// ───────────── 받은 조각 통계 합치기 ─────────────
// 앱의 조각 통계는 브라우저에 계속 누적되므로, 같은 브라우저에서 다시 내보낸 파일에는 이미 합친 수가 또 들어 있다.
// 브라우저(통계 출처)별로 마지막으로 받은 누적값을 기억해 두고, 그보다 늘어난 만큼만 더한다.

export type StageCounts = Record<string, Record<string, number>>;

export interface StatsSource {
  exportedAt: string;
  counts: StageCounts;
}

export interface StatsIncoming {
  /** 앱이 브라우저마다 만든 고유 ID (예전 파일에는 없음) */
  statsId?: string;
  exportedAt?: string;
  pieceStats?: StageCounts;
}

function cleanCounts(c: StageCounts | undefined): StageCounts {
  const out: StageCounts = {};
  for (const [stage, counts] of Object.entries(c ?? {})) {
    if (!/^[1-5]$/.test(stage)) continue;
    for (const [type, n] of Object.entries(counts ?? {})) if (Number.isInteger(n) && n > 0) (out[stage] ??= {})[type] = n;
  }
  return out;
}

const countOf = (c: StageCounts, s: string, t: string) => c[s]?.[t] ?? 0;
const keysOf = (a: StageCounts, b: StageCounts) => {
  const out: [string, string][] = [];
  for (const s of new Set([...Object.keys(a), ...Object.keys(b)]))
    for (const t of new Set([...Object.keys(a[s] ?? {}), ...Object.keys(b[s] ?? {})])) out.push([s, t]);
  return out;
};
/** a의 모든 칸이 b 이하인가 (b가 a에서 더 쌓인 누적값인가) */
const dominated = (a: StageCounts, b: StageCounts) => keysOf(a, b).every(([s, t]) => countOf(a, s, t) <= countOf(b, s, t));
const totalOf = (c: StageCounts) => Object.values(c).reduce((a, st) => a + Object.values(st).reduce((x, y) => x + y, 0), 0);

export interface StatsMergeResult {
  total: StageCounts;
  sources: Record<string, StatsSource>;
  added: number;
  status: 'none' | 'duplicate' | 'new' | 'update' | 'reset';
  source: string | null;
}

export function mergePieceStats(
  total: StageCounts,
  sources: Record<string, StatsSource>,
  incoming: StatsIncoming,
): StatsMergeResult {
  const inc = cleanCounts(incoming.pieceStats);
  const exportedAt = incoming.exportedAt ?? '';
  const nextTotal: StageCounts = structuredClone(total);
  const nextSources: Record<string, StatsSource> = structuredClone(sources);
  if (!totalOf(inc)) return { total: nextTotal, sources: nextSources, added: 0, status: 'none', source: null };

  // 같은 브라우저의 지난 값: ID가 같으면 그것, 아니면 ID 없이 받은 예전 값 중 이번 값에 다 포함되는 것(가장 큰 것)
  let key: string | null = incoming.statsId && nextSources[incoming.statsId] ? incoming.statsId : null;
  if (!key) {
    const legacy = Object.entries(nextSources)
      .filter(([k, src]) => k.startsWith('legacy:') && dominated(src.counts, inc))
      .sort((a, b) => totalOf(b[1].counts) - totalOf(a[1].counts))[0];
    if (legacy) key = legacy[0];
  }
  const prev = key ? nextSources[key] : null;
  if (prev && prev.exportedAt === exportedAt && totalOf(prev.counts) === totalOf(inc))
    return { total: nextTotal, sources: nextSources, added: 0, status: 'duplicate', source: key };

  // 앱에서 통계가 줄었다면(초기화 등) 이번 값은 모두 새 기록이다
  const reset = !!prev && !dominated(prev.counts, inc);
  let added = 0;
  for (const [s, t] of keysOf(inc, {})) {
    const d = countOf(inc, s, t) - (prev && !reset ? countOf(prev.counts, s, t) : 0);
    if (d <= 0) continue;
    (nextTotal[s] ??= {})[t] = countOf(nextTotal, s, t) + d;
    added += d;
  }
  const newKey = incoming.statsId ?? key ?? `legacy:${exportedAt || 'unknown'}`;
  if (key && key !== newKey) delete nextSources[key]; // 예전 값에 ID가 생겼다
  nextSources[newKey] = { exportedAt, counts: inc };
  return { total: nextTotal, sources: nextSources, added, status: !prev ? 'new' : reset ? 'reset' : 'update', source: newKey };
}

// 숫자 학습 데이터 내보내기 / 검사·합치기
import { INVENTORY_CAP } from '../core/board';
import { digitDistance, type DigitSig, type DigitTemplates } from './recognize';

export interface DigitExport {
  app: 'moamoa-digits';
  version: 2;
  exportedAt: string;
  /** 기본 내장값을 뺀, 사용자가 학습시킨 숫자 */
  digits: DigitTemplates;
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

export function makeExport(all: DigitTemplates, defaults: DigitTemplates): DigitExport {
  return { app: 'moamoa-digits', version: 2, exportedAt: new Date().toISOString(), digits: learnedOnly(all, defaults) };
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
export function mergeDigits(base: DigitTemplates, incoming: DigitTemplates): { merged: DigitTemplates; report: MergeReport } {
  const merged: DigitTemplates = structuredClone(base);
  const report: MergeReport = { added: [], duplicates: 0, conflicts: [], invalid: [] };
  for (const [digit, sigs] of Object.entries(incoming ?? {})) {
    if (!/^\d$/.test(digit) || Number(digit) > INVENTORY_CAP) {
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

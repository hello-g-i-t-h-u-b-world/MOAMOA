import { describe, expect, it } from 'vitest';
import { learnedOnly, makeExport, mergeDigits } from '../src/capture/digit-data';
import { DEFAULT_DIGITS } from '../src/capture/recognize';

const ZERO = DEFAULT_DIGITS['0'][0];
// 6×8 픽셀 숫자를 특징 문자열로 (칸이 차면 9, 비면 0)
const sig = (rows: string[]) => `${rows[0].length}|${rows.join('').replace(/#/g, '9').replace(/\./g, '0')}`;
const THREE = sig(['.####.', '##..##', '....##', '..###.', '....##', '....##', '##..##', '.####.']);
// 합치기 테스트는 내장 데이터(학습이 쌓이면 바뀜)와 상관없이 0만 있는 상태에서 시작한다
const BASE = { '0': [ZERO] };
const SIX = sig(['.####.', '##....', '##....', '#####.', '##..##', '##..##', '##..##', '.####.']);

describe('숫자 학습 데이터 내보내기·합치기', () => {
  it('내보내기에는 기본 내장값을 빼고 학습한 것만 담는다', () => {
    const all = { '0': [ZERO], '3': [THREE] };
    expect(learnedOnly(all, DEFAULT_DIGITS)).toEqual({ '3': [THREE] });
    expect(makeExport(all, DEFAULT_DIGITS)).toMatchObject({ app: 'moamoa-digits', version: 2, digits: { '3': [THREE] } });
  });

  it('새 숫자는 추가, 이미 있는 건 건너뜀', () => {
    const { merged, report } = mergeDigits(BASE, { '3': [THREE], '0': [ZERO] });
    expect(merged['3']).toEqual([THREE]);
    expect(report.added).toHaveLength(1);
    expect(report.duplicates).toBe(1);
  });

  it('다른 숫자와 거의 같은 모양(잘못 답한 것)은 넣지 않고 보고', () => {
    // 0 모양에 '5'라고 답한 경우
    const { merged, report } = mergeDigits(BASE, { '5': [ZERO] });
    expect(merged['5']).toBeUndefined();
    expect(report.conflicts[0]).toMatchObject({ digit: '5', looksLike: '0', dist: 0 });
  });

  it('기존 숫자와 충분히 다른 모양은 받아들인다 (0과 6은 6칸 차이)', () => {
    const { report } = mergeDigits(BASE, { '6': [SIX] });
    expect(report.added).toHaveLength(1);
  });

  it('형식이 틀리거나 0~7이 아닌 것은 버림', () => {
    const { report } = mergeDigits(BASE, { '9': [THREE], '2': ['abc', '6|123'] } as never);
    expect(report.added).toHaveLength(0);
    expect(report.invalid).toHaveLength(3);
  });
});

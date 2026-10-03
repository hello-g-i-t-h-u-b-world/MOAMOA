import { describe, expect, it } from 'vitest';
import { learnedOnly, makeExport, mergeDigits, mergePieceStats } from '../src/capture/digit-data';
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

  it("'다음 능력 획득까지' 숫자도 따로 내보낸다", () => {
    const data = makeExport({ '0': [ZERO] }, DEFAULT_DIGITS, { '4': [SIX] }, {});
    expect(data.dropDigits).toEqual({ '4': [SIX] });
    expect(makeExport({ '0': [ZERO] }, DEFAULT_DIGITS).dropDigits).toBeUndefined();
  });
});

describe('받은 조각 통계 합치기 (같은 브라우저의 누적값 중복 방지)', () => {
  const first = { exportedAt: 't1', pieceStats: { '5': { ㄹ: 10, ㅁ: 5 } } };
  it('처음 받은 통계는 그대로 더한다', () => {
    const r = mergePieceStats({}, {}, first);
    expect(r.total).toEqual({ '5': { ㄹ: 10, ㅁ: 5 } });
    expect(r.status).toBe('new');
  });
  it('같은 파일을 다시 받으면 건너뛴다', () => {
    const a = mergePieceStats({}, {}, first);
    const b = mergePieceStats(a.total, a.sources, first);
    expect(b.added).toBe(0);
    expect(b.status).toBe('duplicate');
    expect(b.total).toEqual(a.total);
  });
  it('같은 브라우저에서 더 쌓아 다시 내보내면(ID 없는 예전 파일 → ID 있는 새 파일) 늘어난 만큼만 더한다', () => {
    const a = mergePieceStats({}, {}, first);
    const b = mergePieceStats(a.total, a.sources, { statsId: 'b-1', exportedAt: 't2', pieceStats: { '5': { ㄹ: 14, ㅁ: 5, ㅂ: 2 } } });
    expect(b.added).toBe(6);
    expect(b.total).toEqual({ '5': { ㄹ: 14, ㅁ: 5, ㅂ: 2 } });
    const c = mergePieceStats(b.total, b.sources, { statsId: 'b-1', exportedAt: 't3', pieceStats: { '5': { ㄹ: 15, ㅁ: 5, ㅂ: 2 } } });
    expect(c.added).toBe(1);
    expect(c.status).toBe('update');
  });
  it('다른 브라우저의 통계는 따로 더한다', () => {
    const a = mergePieceStats({}, {}, { statsId: 'b-1', exportedAt: 't1', pieceStats: { '5': { ㄹ: 10 } } });
    const b = mergePieceStats(a.total, a.sources, { statsId: 'b-2', exportedAt: 't1', pieceStats: { '5': { ㄹ: 3 } } });
    expect(b.total).toEqual({ '5': { ㄹ: 13 } });
  });
});

import { describe, expect, it } from 'vitest';
import { emptyRows, rowsFromStrings } from '../src/core/board';
import { PIECE_TYPES } from '../src/core/pieces';
import { linePoints, pieceProbs, stageOf } from '../src/core/rules';
import { solve } from '../src/core/search';
import { track } from '../src/capture/tracker';

describe('게임 규칙', () => {
  it('단계: 0~30 / 31~60 / 61~100 / 101~150 / 151~', () => {
    expect([0, 30, 31, 60, 61, 100, 101, 150, 151, 999].map(stageOf)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it('줄 제거 점수: 300 / 1,200 / 2,700 / 4,800 / 7,500', () => {
    expect([1, 2, 3, 4, 5].map(linePoints)).toEqual([300, 1200, 2700, 4800, 7500]);
  });

  it('조각 확률: 합이 1, 단계가 오를수록 작은 조각이 덜 나온다', () => {
    for (let s = 1; s <= 5; s++) expect(PIECE_TYPES.reduce((a, t) => a + pieceProbs(s)[t], 0)).toBeCloseTo(1);
    expect(pieceProbs(1)['·']).toBeCloseTo(pieceProbs(1)['ㅂ']);
    expect(pieceProbs(5)['·']).toBeLessThan(pieceProbs(1)['·']);
    expect(pieceProbs(5)['ㅂ']).toBeGreaterThan(pieceProbs(5)['·']);
  });
});

describe('게임 점수 계산', () => {
  it('배치 칸 수 + 동시에 지운 줄 점수', () => {
    // 두 줄이 9칸씩 차 있고 ㅣ를 세워 넣으면 2줄 동시 제거
    const rows = rowsFromStrings([...Array(14).fill('..........'), '#########.', '#########.']);
    const plan = solve({ rows, hand: ['ㅣ', null, null], items: [], inventory: { dot: 0, swap: 0 } })!;
    expect(plan.lines).toBe(2);
    expect(plan.points).toBe(5 + 1200);
  });

  it('능력을 7개 보유 중이면 아이콘 줄을 지워도 획득하지 못하고 아이콘은 남는다', () => {
    const rows = rowsFromStrings(['#######...']);
    const it = { r: 0, c: 8, type: 'dot' as const };
    const plan = solve({ rows, hand: ['ㅡ', null, null], items: [it], inventory: { dot: 3, swap: 4 } })!;
    expect(plan.lines).toBe(1);
    expect(plan.itemsGained).toEqual([]);
    expect(plan.finalItems).toEqual([it]);
    expect(plan.points).toBe(3 + 300);
  });

  it('보유 여유가 있으면 획득하고 50점', () => {
    const rows = rowsFromStrings(['#######...']);
    const plan = solve({ rows, hand: ['ㅡ', null, null], items: [{ r: 0, c: 8, type: 'dot' }], inventory: { dot: 0, swap: 0 } })!;
    expect(plan.points).toBe(3 + 300 + 50);
  });

  it('능력 7개 보유 중이면 드롭 차례여도 생기지 않는다 (가장 오래된 아이템도 사라지지 않음)', () => {
    const items = [
      { r: 0, c: 0, type: 'dot' as const },
      { r: 1, c: 0, type: 'dot' as const },
      { r: 2, c: 0, type: 'swap' as const },
    ];
    const plan = solve({ rows: emptyRows(), hand: ['ㅇ', null, null], items, inventory: { dot: 3, swap: 4 }, dropIn: 1 })!;
    expect(plan.moves[0]).toMatchObject({ drop: { expired: null, blocked: true } });
    expect(plan.finalItems).toEqual(items);
  });

  it('다 놓을 수 없으면 점 찍기를 가진 만큼 써 본다', () => {
    // 3줄이 한 칸씩 비어 있고, ㅁ은 어디에도 안 들어간다. 점 찍기 3번으로 3줄을 지우면 놓을 자리가 생긴다
    const rows = rowsFromStrings(Array(16).fill('#.#.#.#.#.').map((r, i) => (i >= 13 ? '#########.' : r)));
    const plan = solve({ rows, hand: ['ㅁ', null, null], items: [], inventory: { dot: 3, swap: 0 }, maxDots: 2 })!;
    expect(plan.complete).toBe(true);
    expect(plan.dotsUsed).toBe(3);
  });
});

describe('화면에서 본 진행 (줄 수·점수 추정)', () => {
  it('지워진 줄 수와 점수를 센다', () => {
    const before = rowsFromStrings([...Array(14).fill('..........'), '#########.', '#########.']);
    const prev = { rows: before, items: [], hand: [{ type: 'ㅣ' as const, used: false }] };
    const cur = { rows: emptyRows(), items: [], hand: [{ type: null, used: true }] };
    const res = track(prev, cur, [], { dot: 0, swap: 0 });
    expect(res.cleared).toBe(2);
    expect(res.points).toBe(5 + 1200);
  });
});

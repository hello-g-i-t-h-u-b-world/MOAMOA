import { describe, expect, it } from 'vitest';
import { emptyRows, place, rowsFromStrings, rowsToStrings } from '../src/core/board';
import { PIECES, PIECE_TYPES, transformSteps } from '../src/core/pieces';
import { solve } from '../src/core/search';
import { BoardFilter, CountSmoother, ItemConfirmer, receivedNewBlocks, track, withoutFullRows } from '../src/capture/tracker';

describe('블록 정의', () => {
  it('19종, 칸 수가 게임 표기와 같다', () => {
    const sizes = Object.fromEntries(PIECE_TYPES.map((t) => [t, PIECES[t].size]));
    expect(sizes).toEqual({
      '·': 1, ㄱ: 4, ㄴ: 3, ㄷ: 5, ㄹ: 8, ㅁ: 8, ㅂ: 10, ㅅ: 3, ㅇ: 4, ㅈ: 6,
      ㅊ: 7, ㅋ: 6, ㅌ: 8, ㅍ: 10, ㅎ: 9, ㅏ: 4, ㅑ: 7, ㅡ: 3, ㅣ: 5,
    });
  });

  it('회전/반전 방향 수', () => {
    expect(PIECES['·'].orientations).toHaveLength(1);
    expect(PIECES['ㅁ'].orientations).toHaveLength(1);
    expect(PIECES['ㅣ'].orientations).toHaveLength(2);
    expect(PIECES['ㄱ'].orientations).toHaveLength(8);
  });

  it('조작 안내: ㅡ → ㅣ 는 회전 1번', () => {
    const [a, b] = PIECES['ㅣ'].orientations;
    expect(transformSteps(a, b)).toEqual({ flip: false, rotations: 1 });
    expect(transformSteps(a, a)).toEqual({ flip: false, rotations: 0 });
  });
});

describe('보드', () => {
  it('가로줄만 지워지고 중력이 없다', () => {
    const rows = rowsFromStrings(['#########.', '.........#', '.........#']);
    const res = place(rows, PIECES['ㅣ'].orientations.find((o) => o.h === 5)!, 0, 9);
    expect(res.cleared).toEqual([0]);
    expect(rowsToStrings(res.rows).slice(0, 6)).toEqual([
      '..........',
      '.........#',
      '.........#',
      '.........#',
      '.........#',
      '..........',
    ]);
  });
});

describe('탐색', () => {
  it('빈 보드에서 손패를 모두 놓는다', () => {
    const plan = solve({ rows: emptyRows(), hand: ['ㅂ', 'ㅎ', 'ㅑ'], items: [], inventory: { dot: 0, swap: 0 } });
    expect(plan?.complete).toBe(true);
    expect(plan?.moves.filter((m) => m.kind === 'piece')).toHaveLength(3);
  });

  it('줄을 완성할 수 있으면 지운다', () => {
    const rows = rowsFromStrings(Array(16).fill('#####.....'));
    rows[15] = 0b1111111110 >> 1; // 마지막 줄: 9칸
    const plan = solve({ rows, hand: ['ㅣ', null, null], items: [], inventory: { dot: 0, swap: 0 } });
    expect(plan?.lines).toBeGreaterThan(0);
  });

  it('놓을 수 없으면 complete=false', () => {
    const rows = rowsFromStrings(Array(16).fill('#.#.#.#.#.'));
    const plan = solve({ rows, hand: ['ㅁ', null, null], items: [], inventory: { dot: 0, swap: 0 } });
    expect(plan?.complete).toBe(false);
  });

  it('사용한 칸(null)은 건너뛴다', () => {
    const plan = solve({ rows: emptyRows(), hand: [null, 'ㅡ', null], items: [], inventory: { dot: 0, swap: 0 } });
    expect(plan?.moves).toHaveLength(1);
    expect(plan?.moves[0]).toMatchObject({ kind: 'piece', slot: 1 });
  });

  it('아이템이 있는 줄을 지우면 획득한다', () => {
    const rows = rowsFromStrings(['#######...']);
    const plan = solve({
      rows,
      hand: ['ㅡ', null, null],
      items: [{ r: 0, c: 8, type: 'dot' }],
      inventory: { dot: 0, swap: 0 },
    });
    expect(plan?.itemsGained).toEqual([{ r: 0, c: 8, type: 'dot' }]);
  });
});

describe('아이템 추적', () => {
  const hand = [{ type: 'ㅣ' as const, used: false }];
  it('아이템 줄이 지워지면 획득', () => {
    const prev = { rows: rowsFromStrings(['#########.']), items: [{ r: 0, c: 3, type: 'swap' as const }], hand };
    const cur = { rows: emptyRows(), items: [], hand: [{ type: null, used: true }] };
    const res = track(prev, cur, prev.items, { dot: 0, swap: 0 });
    expect(res.inventory).toEqual({ dot: 0, swap: 1 });
    expect(res.items).toEqual([]);
  });

  it('손패 그대로 한 칸 늘면 점 찍기 사용', () => {
    const prev = { rows: emptyRows(), items: [], hand };
    const cur = { rows: rowsFromStrings(['#.........']), items: [], hand };
    expect(track(prev, cur, [], { dot: 2, swap: 0 }).inventory.dot).toBe(1);
  });

  it('보드 그대로 조각만 바뀌면 바꿔 뽑기 사용', () => {
    const prev = { rows: emptyRows(), items: [], hand };
    const cur = { rows: emptyRows(), items: [], hand: [{ type: 'ㅎ' as const, used: false }] };
    expect(track(prev, cur, [], { dot: 0, swap: 1 }).inventory.swap).toBe(0);
  });
});

describe('추천 고정 해제 조건', () => {
  const snap = (hand: [string | null, boolean][]) => ({
    rows: emptyRows(),
    items: [],
    hand: hand.map(([type, used]) => ({ type: type as never, used })),
  });
  it('블록을 놓아 사용 완료가 되면 유지', () => {
    expect(receivedNewBlocks(snap([['ㅣ', false], ['ㅋ', false], ['ㅎ', false]]), snap([['ㅣ', false], [null, true], ['ㅎ', false]]))).toBe(false);
  });
  it('사용 완료 칸에 새 블록이 생기면 해제', () => {
    expect(receivedNewBlocks(snap([[null, true], [null, true], [null, true]]), snap([['ㅂ', false], ['ㅅ', false], ['ㅡ', false]]))).toBe(true);
  });
  it('바꿔 뽑기로 종류가 바뀌면 해제', () => {
    expect(receivedNewBlocks(snap([['ㅣ', false], [null, true], ['ㅎ', false]]), snap([['ㅣ', false], [null, true], ['ㅏ', false]]))).toBe(true);
  });
});

describe('아이템 확인 (깜빡 나타나는 이펙트 거르기)', () => {
  const dot = { r: 3, c: 4, type: 'dot' as const };
  it('0.5초만 보이고 사라지면 인정하지 않는다', () => {
    const ic = new ItemConfirmer();
    for (let t = 0; t <= 500; t += 250) expect(ic.update([dot], t)).toEqual([]);
    expect(ic.update([], 750)).toEqual([]);
    expect(ic.update([], 1500)).toEqual([]);
  });
  it('1초 이상 계속 보이면 인정', () => {
    const ic = new ItemConfirmer();
    let out: unknown[] = [];
    for (let t = 0; t <= 1000; t += 250) out = ic.update([dot], t);
    expect(out).toEqual([dot]);
  });
  it('화면을 보지 않은 시간(조각 선택 중)만큼 미루면 아이템이 유지된다', () => {
    const ic = new ItemConfirmer();
    for (let t = 0; t <= 1000; t += 250) ic.update([dot], t);
    // 1000ms에 선택 시작, 4000ms에 선택 끝
    ic.shift(3000);
    expect(ic.update([dot], 4250)).toEqual([dot]);
  });
  it('잠깐 한 프레임 놓쳐도 유지', () => {
    const ic = new ItemConfirmer();
    for (let t = 0; t <= 1000; t += 250) ic.update([dot], t);
    expect(ic.update([], 1250)).toEqual([dot]);
    expect(ic.update([dot], 1500)).toEqual([dot]);
    expect(ic.update([], 2500)).toEqual([]); // 오래 안 보이면 제거
  });
});

describe('보드 칸 필터 (순간적인 오인식 거르기)', () => {
  const base = rowsFromStrings(['####.#####', '##.....###', '..........']);
  const run = (frames: [number, string[]][]) => {
    const f = new BoardFilter();
    let out = base;
    for (const [t, rows] of frames) out = f.update(rowsFromStrings(rows), t);
    return { rows: rowsToStrings(out).slice(0, 3), filter: f };
  };
  const B = ['####.#####', '##.....###', '..........'];

  it('한 순간 보인 가짜 블록은 반영하지 않고, 사라지면 남지도 않는다', () => {
    const glitch = ['####.#####', '##.....###', '...#......'];
    const { rows, filter } = run([[0, B], [250, glitch], [500, B], [750, B], [1000, B]]);
    expect(rows).toEqual(B);
    expect(filter.pending).toBe(false);
  });

  it('0.5초 이상 계속 보이는 새 블록은 반영', () => {
    const placed = ['####.#####', '##.....###', '..###.....'];
    expect(run([[0, B], [250, placed], [500, placed], [750, placed]]).rows).toEqual(placed);
  });

  it('한두 칸만 잠깐 비어 보이면 유지 (아이콘 빛), 1.5초 넘게 계속되면 반영', () => {
    const hidden = ['####.###.#', '##.....###', '..........'];
    expect(run([[0, B], [250, hidden], [500, hidden], [1000, hidden]]).rows).toEqual(B);
    expect(run([[0, B], [250, hidden], [1000, hidden], [1800, hidden]]).rows).toEqual(hidden);
  });

  it('줄 제거(여러 칸이 함께 빔)는 0.5초 뒤 반영', () => {
    const cleared = ['..........', '##.....###', '..........'];
    expect(run([[0, B], [250, cleared], [500, cleared], [800, cleared]]).rows).toEqual(cleared);
  });

  it('판단 불가 칸(아이템 빛에 가려짐)은 오래 이어져도 확정 상태를 유지', () => {
    const f = new BoardFilter();
    f.update(rowsFromStrings(B), 0);
    const hidden = rowsFromStrings(['####.###.#', '##.....###', '..........']); // (0,8)이 빈칸처럼 보임
    const unsure = rowsFromStrings(['........#.']);
    let out = rowsFromStrings(B);
    for (let t = 250; t <= 5000; t += 250) out = f.update(hidden, t, unsure);
    expect(rowsToStrings(out).slice(0, 3)).toEqual(B);
    expect(f.pending).toBe(false);
  });

  it('꽉 찬 줄은 빈 줄로 본다', () => {
    expect(rowsToStrings(withoutFullRows(rowsFromStrings(['##########', '#.........'])).slice(0, 2))).toEqual([
      '..........',
      '#.........',
    ]);
  });
});

describe('보유 능력 숫자 안정화', () => {
  const r = (value: number | null, sig = 's') => ({ sig, value });
  it('같은 값이 0.6초 이어져야 바꾼다 (잠깐 튀는 값 무시)', () => {
    const c = new CountSmoother();
    c.update(r(2), 0);
    expect(c.update(r(2), 700).value).toBe(2);
    expect(c.update(r(5), 900).value).toBe(2); // 한 번 튐
    expect(c.update(r(2), 1100).value).toBe(2);
    expect(c.update(r(3), 1300).value).toBe(2);
    expect(c.update(r(3), 2000).value).toBe(3);
  });
  it('숫자가 안 보이면 마지막 값을 유지', () => {
    const c = new CountSmoother();
    c.update(r(4), 0);
    c.update(r(4), 700);
    expect(c.update(null, 900).value).toBe(4);
  });
  it('처음 보는 모양은 1.5초 계속될 때만 물어본다', () => {
    const c = new CountSmoother();
    expect(c.update(r(null, 'x'), 0).unknownSig).toBeNull();
    expect(c.update(r(null, 'x'), 1000).unknownSig).toBeNull();
    expect(c.update(r(null, 'x'), 1600).unknownSig).toBe('x');
  });
});

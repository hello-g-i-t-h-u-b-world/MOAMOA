import '../style.css';
import {
  BOARD_ITEM_CAP,
  DROP_EVERY,
  H,
  INVENTORY_CAP,
  W,
  emptyRows,
  place,
  placeDot,
  rowsToStrings,
  type Inventory,
  type Item,
  type Rows,
} from '../core/board';
import { PIECES, PIECE_TYPES, transformSteps, type Orientation, type PieceType } from '../core/pieces';
import { DEFAULT_WEIGHTS } from '../core/eval';
import type { Move, Plan, SolveInput, SwapAdvice } from '../core/search';
import { LOOKAHEAD_PRESETS } from '../core/lookahead';
import { Cancelled, SolverPool } from '../core/pool';
import { ScreenCapture } from '../capture/capture';
import { learnedOnly, makeExport } from '../capture/digit-data';
import { checkProgress, type ProgressResult } from '../core/progress';
import { STAGE_RANGES, linePoints, stageOf } from '../core/rules';
import {
  DEFAULT_DIGITS,
  DEFAULT_DROP_DIGITS,
  DEFAULT_NUM_DIGITS,
  matchDigit,
  matchNumber,
  readNumberSigs,
  readBoard,
  readDigitSig,
  readHandSlot,
  snapBoardRect,
  type DigitSig,
  type DigitTemplates,
  type Frame,
  type Rect,
} from '../capture/recognize';
import { BoardFilter, CountSmoother, ItemConfirmer, receivedNewBlocks, track, withoutFullRows, type Snapshot } from '../capture/tracker';

// ───────────── 상태 ─────────────

interface Slot {
  type: PieceType | null;
  /** 화면에 보이는 방향 (-1 = 모름) */
  orient: number;
  used: boolean;
  /** 화면에서 읽은 블록 색 (blue / pink / yellow / green / purple=점 찍기), 수동 입력이면 null */
  color?: string | null;
}

/** 추천 단계 i(이동 m)의 색 클래스: 조각 색을 알면 그 색, 아니면 단계별 기본 색 */
function moveColorClass(m: Move, i: number): string {
  if (m.kind === 'dot') return 'ghost-dot';
  const color = state.hand[m.slot]?.color;
  return color ? `gc-${color}` : `ghost-${i % 4}`;
}

/** 숫자 색 클래스: 보유 조각 칸(1~3번)마다 다른 색. 보드 칸과 추천 순서 배지에 똑같이 쓴다. */
function moveNumberClass(m: Move): string {
  return m.kind === 'dot' ? 'num-dot' : `num-${m.slot}`;
}

interface Calib {
  board: Rect | null;
  slots: (Rect | null)[];
  /** 보유 능력 버튼의 숫자 영역 / '다음 능력 획득까지' 숫자 영역 (선택) */
  counters: Record<CounterKey, Rect | null>;
  /** 점수 / 제거한 줄 수 영역 (선택, 여러 자리 숫자) */
  numbers: Record<NumberKey, Rect | null>;
  /** 영역을 지정할 때의 공유 화면 크기 */
  frame?: { w: number; h: number };
}

type ItemKey = 'dot' | 'swap';
const ITEM_KEYS: ItemKey[] = ['dot', 'swap'];
/** 화면에서 읽는 숫자: 점 찍기 개수 / 바꿔 뽑기 개수 / 다음 능력 획득까지 */
type CounterKey = ItemKey | 'drop';
const COUNTER_KEYS: CounterKey[] = ['dot', 'swap', 'drop'];
const NO_COUNTERS: Record<CounterKey, Rect | null> = { dot: null, swap: null, drop: null };
/** 화면에서 읽는 여러 자리 숫자: 점수 / 제거한 줄 수 */
type NumberKey = 'score' | 'lines';
const NUMBER_KEYS: NumberKey[] = ['score', 'lines'];
const NO_NUMBERS: Record<NumberKey, Rect | null> = { score: null, lines: null };
const NUMBER_NAME: Record<NumberKey, string> = { score: '점수', lines: '제거한 줄' };

const CALIB_KEY = 'moamoa.calib.v1';
const DIGITS_KEY = 'moamoa.digits.v2';
/** '다음 능력 획득까지' 숫자 (글꼴이 달라 따로 학습) */
const DROP_DIGITS_KEY = 'moamoa.dropdigits.v1';
/** 점수·제거한 줄 수 숫자 (0~9) */
const NUM_DIGITS_KEY = 'moamoa.numdigits.v1';
/** 게임 진행 (제거한 줄 누적 → 단계, 추정 점수) */
const GAME_KEY = 'moamoa.game.v1';
/** 실제로 받은 조각 통계 (단계별). 공개되지 않은 등장 확률을 추정하는 데 쓴다 */
const PIECE_STATS_KEY = 'moamoa.piecestats.v1';
/** 목표 점수 */
const TARGET_SCORE = 500_000;
/** 숫자 인식 방식이 바뀌기 전의 학습 데이터 (호환 안 됨) */
const OLD_DIGITS_KEY = 'moamoa.digits.v1';
let oldDigitsDropped = false;
const EFFORT = {
  fast: { beam: 60, finalists: 30 },
  normal: { beam: 150, finalists: 60 },
  deep: { beam: 400, finalists: 150 },
  max: { beam: 400, finalists: 150 },
} as const;

const state = {
  rows: emptyRows() as Rows,
  colors: [] as (string | null)[][],
  items: [] as Item[],
  hand: [0, 1, 2].map(() => ({ type: null, orient: -1, used: false }) as Slot),
  inventory: { dot: 0, swap: 0 } as Inventory,
  calib: loadCalib(),
  paused: false,
  /** 손패 3개를 받아 계산한 추천을 고정할지 */
  lockEnabled: true,
  /** 추천 고정 중 (다음 손패를 받을 때까지 화면·계산 멈춤) */
  locked: false,
  plan: null as Plan | null,
  swaps: null as SwapAdvice[] | null,
  solveMs: 0,
  /** 보드에 보여줄 단계 ('all' = 전체, plan.moves.length = 모두 마침) */
  view: 'all' as 'all' | number,
  /** 지금 안내 중인 단계 (사용자가 놓은 것을 확인하면 자동으로 넘어감) */
  step: 0,
  /** 지금 계획을 세울 때의 보드와 사용 완료 칸 (단계 진행 판단 기준) */
  planBase: null as { rows: Rows; used: boolean[] } | null,
  log: [] as string[],
  digits: loadDigits(),
  dropDigits: loadDigitStore(DROP_DIGITS_KEY, DEFAULT_DROP_DIGITS),
  /** 다음 아이템이 떨어질 때까지 남은 블록 수 (1~7, 모르면 null) */
  dropIn: null as number | null,
  /** 제거한 가로줄 누적 / 점수 (화면에서 읽는다. 줄 수 영역이 없으면 직접 입력) */
  game: loadJson(GAME_KEY, { lines: 0, score: 0 }),
  numDigits: loadDigitStore(NUM_DIGITS_KEY, DEFAULT_NUM_DIGITS),
  /** 계산 중이면 계산을 시작할 때의 판 (계산이 끝날 때까지 판 화면을 이 상태로 멈춘다) */
  computing: null as { rows: Rows; colors: (string | null)[][]; items: Item[]; phase: string } | null,
  numFromScreen: { score: false, lines: false } as Record<NumberKey, boolean>,
  /** 처음 보는 글자가 있는 숫자 → 화면의 숫자를 그대로 입력받아 글자마다 배운다 */
  numPrompt: { score: null, lines: null } as Record<NumberKey, { sigs: DigitSig[]; url: string } | null>,
  /** 단계 → 조각 → 받은 횟수 */
  pieceStats: loadJson(PIECE_STATS_KEY, {} as Record<string, Record<string, number>>),
  /** 화면에서 개수를 읽고 있는가 */
  countFromScreen: { dot: false, swap: false, drop: false } as Record<CounterKey, boolean>,
  /** 처음 보는 숫자 모양 → 사용자에게 값을 물어본다 */
  digitPrompt: { dot: null, swap: null, drop: null } as Record<CounterKey, { sig: DigitSig; url: string } | null>,
};

function loadCalib(): Calib {
  try {
    const raw = localStorage.getItem(CALIB_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Calib>;
      return {
        ...saved,
        counters: { ...NO_COUNTERS, ...saved.counters },
        numbers: { ...NO_NUMBERS, ...saved.numbers },
      } as Calib;
    }
  } catch {
    /* 저장소 사용 불가 */
  }
  return { board: null, slots: [null, null, null], counters: { ...NO_COUNTERS }, numbers: { ...NO_NUMBERS } };
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    /* 저장소 사용 불가 */
  }
  return structuredClone(fallback);
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 무시 */
  }
}

/** 이 브라우저의 조각 통계 출처 ID (처음 한 번 만든다) */
function statsId(): string {
  const KEY = 'moamoa.statsid';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return 'b-unknown';
  }
}

function currentStage(): number {
  return stageOf(state.game.lines);
}

/** 화면에서 읽은 제거한 줄 수·점수를 반영한다 */
function setGameNumber(key: NumberKey, value: number) {
  if (state.game[key] === value && state.numFromScreen[key]) return;
  const before = currentStage();
  state.game[key] = value;
  state.numFromScreen[key] = true;
  saveJson(GAME_KEY, state.game);
  const after = currentStage();
  if (key === 'lines' && after !== before) {
    addLog(`▲ ${after}단계 (누적 ${value}줄) · ${after > before ? '칸 수가 적은 조각이 덜 나옵니다' : ''}`);
    if (!state.locked && state.plan) requestSolve(!!source);
  }
}

/** 처음 보는 글자가 있던 숫자를 사용자가 알려준 값으로 배운다 */
function learnNumber(key: NumberKey, sigs: DigitSig[], text: string): string | null {
  const digits = text.replace(/[^0-9]/g, '');
  if (digits.length !== sigs.length)
    return `숫자 ${sigs.length}자리로 읽혔는데 ${digits.length}자리를 입력했습니다. 화면의 숫자를 그대로 입력하세요 (쉼표는 빼도 됩니다).`;
  sigs.forEach((sig, i) => {
    // 숫자가 바뀌는 애니메이션 중에 읽은 흐릿한 모양(꽉 찬 칸이 하나도 없음)은 다른 숫자와 헷갈리므로 배우지 않는다
    if (!sig.split('|')[1]?.includes('9')) return;
    const list = (state.numDigits[digits[i]] ??= []);
    if (!list.includes(sig)) list.push(sig);
  });
  saveJson(NUM_DIGITS_KEY, state.numDigits);
  numSmoothers[key].set(Number(digits));
  state.numPrompt[key] = null;
  setGameNumber(key, Number(digits));
  addLog(`${NUMBER_NAME[key]} 숫자 학습: ${Number(digits).toLocaleString()}`);
  return null;
}

/** 새로 받은 조각을 단계별로 센다 (바꿔 뽑기로 받은 조각 포함) */
function countPieces(prev: Snapshot, cur: Snapshot) {
  const stage = String(currentStage());
  const st = (state.pieceStats[stage] ??= {});
  cur.hand.forEach((s, i) => {
    const p = prev.hand[i];
    if (s.type && !s.used && (!p || p.used || p.type !== s.type)) st[s.type] = (st[s.type] ?? 0) + 1;
  });
  saveJson(PIECE_STATS_KEY, state.pieceStats);
}

function loadDigits(): DigitTemplates {
  try {
    if (localStorage.getItem(OLD_DIGITS_KEY)) {
      localStorage.removeItem(OLD_DIGITS_KEY);
      oldDigitsDropped = true;
    }
  } catch {
    /* 저장소 사용 불가 */
  }
  return loadDigitStore(DIGITS_KEY, DEFAULT_DIGITS);
}

/** 기본 내장 숫자 + 이 브라우저에서 학습한 숫자 */
function loadDigitStore(key: string, defaults: DigitTemplates): DigitTemplates {
  const out: DigitTemplates = structuredClone(defaults);
  try {
    const raw = localStorage.getItem(key);
    if (raw) for (const [d, sigs] of Object.entries(JSON.parse(raw) as DigitTemplates)) out[d] = [...new Set([...(out[d] ?? []), ...sigs])];
  } catch {
    /* 저장소 사용 불가 */
  }
  return out;
}

function learnDigit(key: CounterKey, sig: DigitSig, value: number) {
  const store = key === 'drop' ? state.dropDigits : state.digits;
  const list = (store[value] ??= []);
  if (!list.includes(sig)) list.push(sig);
  try {
    localStorage.setItem(key === 'drop' ? DROP_DIGITS_KEY : DIGITS_KEY, JSON.stringify(store));
  } catch {
    /* 무시 */
  }
}

/** 학습한(기본 내장이 아닌) 숫자 목록 */
function learnedDigits(store: DigitTemplates, defaults: DigitTemplates): string[] {
  return Object.keys(store)
    .filter((d) => store[d].some((sig) => !defaults[d]?.includes(sig)))
    .sort();
}

/** 파일 내려받기 */
function downloadJson(data: unknown, name: string) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function timestamp(): string {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
}

/** 학습한 숫자(기본 내장 제외)를 파일로 내보낸다 */
function exportDigits() {
  const data = {
    ...makeExport(state.digits, DEFAULT_DIGITS, state.dropDigits, DEFAULT_DROP_DIGITS, state.numDigits, DEFAULT_NUM_DIGITS),
    // 같은 브라우저에서 다시 내보내도 통계가 두 번 더해지지 않게, 브라우저마다 고유 ID를 함께 보낸다
    statsId: statsId(),
    pieceStats: state.pieceStats,
  };
  const name = `moamoa-digits-${timestamp()}.json`;
  downloadJson(data, name);
  const drop = Object.keys(data.dropDigits ?? {}).sort();
  addLog(
    `학습 데이터 내보내기: 보유 개수 ${Object.keys(data.digits).sort().join(', ') || '-'} · 획득까지 ${drop.join(', ') || '-'} (${name})`,
  );
}

/** 학습한 숫자를 지우고 기본 템플릿만 남긴다 */
function resetDigits() {
  state.digits = structuredClone(DEFAULT_DIGITS);
  state.dropDigits = structuredClone(DEFAULT_DROP_DIGITS);
  state.numDigits = structuredClone(DEFAULT_NUM_DIGITS);
  try {
    localStorage.removeItem(DIGITS_KEY);
    localStorage.removeItem(DROP_DIGITS_KEY);
    localStorage.removeItem(NUM_DIGITS_KEY);
  } catch {
    /* 무시 */
  }
  addLog('숫자 학습 초기화');
  appliedSig = ''; // 현재 화면의 숫자를 다시 읽는다
  renderInventory();
}

function saveCalib() {
  try {
    localStorage.setItem(CALIB_KEY, JSON.stringify(state.calib));
  } catch {
    /* 무시 */
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function addLog(msg: string) {
  const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  state.log.unshift(`${t} ${msg}`);
  state.log.length = Math.min(state.log.length, 30);
  renderLog();
}

/** 게임에서 조각을 선택(노란 카드)하거나 바꿔 뽑기를 누른(보라 카드) 동안 화면 반영·계산을 멈춘 상태 */
let selectionPaused = false;
let statusBeforeSelection: { text: string; kind: string } | null = null;

function setStatus(msg: string, kind: 'idle' | 'busy' | 'ok' | 'warn' = 'idle') {
  // 조각 선택 중에는 '선택 중' 표시를 유지하고, 다른 상태는 선택이 끝난 뒤 보여준다
  if (selectionPaused) {
    statusBeforeSelection = { text: msg, kind };
    return;
  }
  const el = $('status');
  el.textContent = msg;
  el.dataset.kind = kind;
}

// ───────────── 탐색 (Web Worker 여러 개) ─────────────

const pool = new SolverPool();
let reqId = 0;

let lockAfterSolve = false;
/** 능력 드롭을 기다리는 중: 이 시각까지 새 아이템이 확인되지 않으면 포기 (아래 '능력 드롭 확인' 참고) */
let dropWatch: { since: number; until: number } | null = null;
/** 추천 고정 중에 능력이 떨어져 다시 계산해야 함 */
let dropRecompute = false;

function effortSetting() {
  const key = ($('effort') as HTMLSelectElement).value as keyof typeof EFFORT;
  return { search: EFFORT[key], look: LOOKAHEAD_PRESETS[key] };
}

function requestSolve(fromScreen = false) {
  dropRecompute = false; // 지금 화면 기준으로 계산하므로 떨어진 능력도 반영된다
  lockAfterSolve = fromScreen && state.lockEnabled;
  state.locked = false;
  const effort = effortSetting();
  const input: SolveInput = {
    // 꽉 찬 줄은 게임에서 바로 지워지므로 빈 줄로 넘긴다
    rows: withoutFullRows(state.rows),
    hand: state.hand.map((s) => (s.used ? null : s.type)),
    items: state.items.slice(),
    inventory: { ...state.inventory },
    ...(state.dropIn ? { dropIn: state.dropIn } : {}),
    stage: currentStage(),
    weights: DEFAULT_WEIGHTS,
    maxDots: 2,
    ...effort.search,
  };
  state.swaps = null;
  if (input.hand.every((h) => h === null)) {
    state.plan = null;
    state.computing = null;
    renderAll();
    setStatus('보유 조각 없음', 'idle');
    return;
  }
  setStatus('계산 중…', 'busy');
  state.computing = { rows: state.rows.slice(), colors: state.colors.map((r) => r.slice()), items: state.items.slice(), phase: '' };
  renderBoard();
  renderMoves();
  const id = ++reqId;
  planReqId = id;
  swapReqId = id;
  const base = { rows: input.rows.slice(), used: state.hand.map((s) => s.used) };
  const t0 = performance.now();
  pool
    .plan(input, effort.look, (p) => {
      if (id !== planReqId) return;
      setStatus(`계산 중… [${p.stage}] 후보 ${p.candidates}개 × 다음 손패 ${p.samples}가지 미리 보는 중 (코어 ${pool.size}개)`, 'busy');
      if (state.computing) {
        state.computing.phase = `${p.stage} · 후보 ${p.candidates}개 × 다음 손패 ${p.samples}가지`;
        renderOverlay();
      }
    })
    .then((plan) => {
      if (id !== planReqId) return;
      onPlan(plan, performance.now() - t0, base);
    })
    .catch(onSolveError);
  if (input.inventory.swap > 0) runSwapAnalysis(id, input);
}

let planReqId = 0;
let swapReqId = 0;

function onSolveError(err: unknown) {
  if (err instanceof Cancelled) return;
  state.computing = null;
  renderAll();
  console.error(err);
  setStatus(`계산 오류: ${String(err)}`, 'warn');
}

function onPlan(plan: Plan | null, ms: number, base: { rows: Rows; used: boolean[] }) {
  state.computing = null;
  state.plan = plan;
  state.solveMs = ms;
  state.planBase = base;
  // 1단계부터 바로 보여준다
  state.step = 0;
  state.view = plan?.moves.length ? 0 : 'all';
  state.locked = lockAfterSolve && !!plan;
  newDrops.clear();
  if (state.locked) setStatus(`🔒 추천 고정 (${ms.toFixed(0)}ms) · 다음 블록을 받으면 다시 계산`, 'ok');
  else setStatus(`계산 완료 (${ms.toFixed(0)}ms)`, plan?.complete === false ? 'warn' : 'ok');
  renderAll();
}

function runSwapAnalysis(id: number, input: SolveInput) {
  pool
    .swaps(input)
    .then((swaps) => {
      if (id !== swapReqId) return;
      state.swaps = swaps;
      renderAll();
    })
    .catch(onSolveError);
}

/**
 * 계획은 그대로 두고 바꿔 뽑기 분석만 다시 한다 (추천 고정 중 바꿔 뽑기를 얻은 경우 등).
 * 화면 공유 중이면 지금 화면(놓고 남은 조각) 기준으로 분석한다.
 */
function requestSwapAnalysis() {
  state.swaps = null;
  if (!state.plan || state.inventory.swap <= 0) {
    renderSwapAdvice();
    renderHand();
    return;
  }
  const src = source && live.hand.length ? live : state;
  const input: SolveInput = {
    rows: withoutFullRows(src.rows),
    hand: src.hand.map((s) => (s.used ? null : s.type)),
    items: src.items.slice(),
    inventory: { ...state.inventory },
    ...(state.dropIn ? { dropIn: state.dropIn } : {}),
    stage: currentStage(),
    weights: DEFAULT_WEIGHTS,
    maxDots: 2,
    ...effortSetting().search,
  };
  if (input.hand.every((h) => h === null)) return;
  const id = ++reqId;
  swapReqId = id;
  renderSwapAdvice();
  runSwapAnalysis(id, input);
}

// ───────────── 렌더링 ─────────────

function shapeEl(o: Orientation, cls = ''): HTMLElement {
  const el = document.createElement('div');
  el.className = `shape ${cls}`;
  el.style.gridTemplateColumns = `repeat(${o.w}, 1fr)`;
  for (let r = 0; r < o.h; r++)
    for (let c = 0; c < o.w; c++) {
      const d = document.createElement('i');
      if ((o.rows[r] >> c) & 1) d.className = 'on';
      el.appendChild(d);
    }
  return el;
}

function moveCells(m: Move): [number, number][] {
  if (m.kind === 'dot') return [[m.r, m.c]];
  return PIECES[m.type].orientations[m.orient].cells.map(([r, c]) => [m.r + r, m.c + c]);
}

/** 각 단계 직전의 보드 */
/** 안내 단계를 바꾼다 (자동 진행·수동 버튼 공용) */
function goToStep(step: number, auto = false) {
  const plan = state.plan;
  if (!plan) return;
  const n = plan.moves.length;
  const next = Math.max(0, Math.min(n, step));
  if (auto && next > state.step) {
    for (let k = state.step; k < next; k++) addLog(`✓ ${k + 1}단계 완료`);
  }
  state.step = next;
  state.view = next;
  renderBoard();
  renderMoves();
}

/** 각 단계 직전의 보드 + 마지막에 모두 마친 보드 */
function boardsBeforeMoves(plan: Plan): Rows[] {
  const out: Rows[] = [];
  let rows = state.planBase?.rows ?? state.rows;
  for (const m of plan.moves) {
    out.push(rows);
    rows =
      m.kind === 'dot'
        ? placeDot(rows, m.r, m.c).rows
        : place(rows, PIECES[m.type].orientations[m.orient], m.r, m.c).rows;
  }
  out.push(rows);
  return out;
}

const boardEl = $('board');
const cellEls: HTMLElement[][] = [];
for (let r = 0; r < H; r++) {
  cellEls.push([]);
  for (let c = 0; c < W; c++) {
    const d = document.createElement('div');
    d.className = 'cell';
    d.dataset.r = String(r);
    d.dataset.c = String(c);
    boardEl.appendChild(d);
    cellEls[r].push(d);
  }
}

boardEl.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('.cell') as HTMLElement | null;
  if (!t) return;
  const r = Number(t.dataset.r);
  const c = Number(t.dataset.c);
  state.rows = state.rows.slice();
  state.rows[r] ^= 1 << c;
  requestSolve();
});

boardEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const t = (e.target as HTMLElement).closest('.cell') as HTMLElement | null;
  if (!t) return;
  const r = Number(t.dataset.r);
  const c = Number(t.dataset.c);
  const cur = state.items.find((it) => it.r === r && it.c === c);
  state.items = state.items.filter((it) => it !== cur);
  if (!cur) state.items.push({ r, c, type: 'swap' });
  else if (cur.type === 'swap') state.items.push({ r, c, type: 'dot' });
  requestSolve();
});

/** 계산 중 안내 (판 위) */
function renderOverlay() {
  const el = $('boardOverlay');
  const c = state.computing;
  el.hidden = !c;
  if (c) el.innerHTML = `<div class="spinner"></div><b>계산 중…</b>${c.phase ? `<small>${c.phase}</small>` : ''}`;
}

function renderBoard() {
  renderOverlay();
  renderNowStep();
  // 계산 중: 계산을 시작할 때의 판을 그대로 보여준다 (이전 추천은 지금 판과 맞지 않으므로 숨김)
  const frozen = state.computing;
  const plan = frozen ? null : state.plan;
  const before = plan ? boardsBeforeMoves(plan) : [];
  const base = frozen ? frozen.rows : plan && typeof state.view === 'number' ? before[state.view] : state.rows;
  const items = frozen ? frozen.items : state.items;
  const colors = frozen ? frozen.colors : state.colors;
  const ghost = new Map<string, number>();
  const clearRows = new Set<number>();
  if (plan) {
    plan.moves.forEach((m, i) => {
      if (state.view !== 'all' && state.view !== i) return;
      for (const [r, c] of moveCells(m)) ghost.set(`${r},${c}`, i);
      if (state.view === i) m.cleared.forEach((r) => clearRows.add(r));
    });
  }
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      const el = cellEls[r][c];
      const filled = ((base[r] >> c) & 1) === 1;
      const g = ghost.get(`${r},${c}`);
      const item = items.find((it) => it.r === r && it.c === c);
      const color = colors[r]?.[c] ?? 'gray';
      el.className = 'cell';
      el.textContent = '';
      if (filled) el.classList.add('filled', `c-${color}`);
      if (g !== undefined) {
        el.classList.add('ghost', moveColorClass(plan!.moves[g], g), moveNumberClass(plan!.moves[g]));
        el.textContent = String(g + 1);
      } else if (item) {
        el.textContent = item.type === 'swap' ? '⇄' : '⊙';
        el.classList.add('item');
      }
      if (item && newDrops.has(itemKey(item))) el.classList.add('new-drop');
      if (clearRows.has(r)) el.classList.add('clearing');
    }

  const tabs = $('stepTabs');
  tabs.innerHTML = '';
  tabs.hidden = !!frozen;
  if (!plan) return;
  const mk = (label: string, v: 'all' | number) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (state.view === v) b.classList.add('active');
    b.onclick = () => {
      state.view = v;
      renderBoard();
      renderMoves();
    };
    tabs.appendChild(b);
  };
  plan.moves.forEach((_, i) => mk(`${i < state.step ? '✓ ' : i === state.step ? '▶ ' : ''}${i + 1}단계`, i));
  mk('전체', 'all');
}

/** 보드 위 '지금 할 일' 안내 */
function renderNowStep() {
  const el = $('nowStep');
  const plan = state.computing ? null : state.plan;
  el.innerHTML = '';
  el.hidden = !plan || plan.moves.length === 0;
  if (!plan || el.hidden) return;
  const n = plan.moves.length;
  const prev = document.createElement('button');
  prev.textContent = '◀';
  prev.title = '이전 단계';
  prev.disabled = state.step === 0;
  prev.onclick = () => goToStep(state.step - 1);
  const next = document.createElement('button');
  next.textContent = '다음 ▶';
  next.title = '이 단계를 마쳤다고 표시 (화면 인식이 놓쳤을 때)';
  next.disabled = state.step >= n;
  next.onclick = () => goToStep(state.step + 1);
  const body = document.createElement('div');
  body.className = 'now-body';
  if (state.step >= n) {
    el.className = 'now-step done';
    body.innerHTML = `<div class="now-title">✓ 안내한 순서를 모두 놓았습니다</div><div class="now-text muted">다음 블록을 기다리는 중…</div>`;
  } else {
    const m = plan.moves[state.step];
    el.className = 'now-step';
    body.innerHTML = `<div class="now-title">지금 할 일 <span class="muted">${state.step + 1} / ${n}단계</span></div>
      <div class="now-text"><span class="badge ${moveColorClass(m, state.step)} ${moveNumberClass(m)}">${state.step + 1}</span> ${moveSummary(m)}</div>`;
  }
  el.append(prev, body, next);
}

/** 한 줄 요약: 'ㅋ (3번 조각) · 회전 3번 → 2행 5열' */
function moveSummary(m: Move): string {
  if (m.kind === 'dot') return `<b>⊙ 점 찍기</b> → <b>${m.r + 1}행 ${m.c + 1}열</b>`;
  const op = opText(m.slot, PIECES[m.type].orientations[m.orient]);
  return `<b>${m.type}</b> <span class="muted">(${m.slot + 1}번 조각)</span>${op ? ` · <span class="op">${op}</span>` : ''} → <b>${m.r + 1}행 ${m.c + 1}열</b>${
    m.cleared.length ? ` <span class="clear">✦ ${m.cleared.length}줄 제거 +${linePoints(m.cleared.length).toLocaleString()}</span>` : ''
  }${m.drop && !m.drop.blocked ? ` <span class="drop">⬇ 능력 드롭${m.drop.expired ? ` · ${itemIcon(m.drop.expired)} 사라짐` : ''}</span>` : ''}`;
}

function itemIcon(it: Item): string {
  return it.type === 'dot' ? '⊙' : '⇄';
}

/** 이 조각을 놓으면 아이템이 떨어진다는 안내 */
function dropNote(m: Move): string {
  if (m.kind !== 'piece' || !m.drop) return '';
  if (m.drop.blocked) return `<br/><span class="drop muted">⬇ 드롭 차례지만 능력을 7개 보유 중이라 생기지 않음</span>`;
  const e = m.drop.expired;
  return `<br/><span class="drop">⬇ 이 조각을 놓으면 능력이 떨어짐${
    e ? ` · 보드 위 아이템이 3개라 가장 오래된 ${itemIcon(e)}(${e.r + 1}행 ${e.c + 1}열)이 사라짐` : ''
  }</span>`;
}

function opText(slot: number, target: Orientation): string {
  const s = state.hand[slot];
  if (!s || s.type === null || s.orient < 0) return '';
  const shown = PIECES[s.type].orientations[s.orient];
  const t = transformSteps(shown, target);
  if (!t) return '';
  const parts: string[] = [];
  if (t.flip) parts.push('반전');
  if (t.rotations) parts.push(`회전 ${t.rotations}번`);
  return parts.length ? parts.join(' → ') : '그대로';
}

function renderMoves() {
  const ol = $('moves');
  ol.innerHTML = '';
  const plan = state.plan;
  const verdict = $('verdict');
  verdict.innerHTML = '';
  if (state.computing) {
    ol.innerHTML = '<li class="muted">계산 중… 끝나면 1단계부터 안내합니다.</li>';
    return;
  }
  if (!plan) {
    ol.innerHTML = '<li class="muted">보유 조각을 입력하거나 화면 공유를 시작하세요.</li>';
    return;
  }
  plan.moves.forEach((m, i) => {
    const li = document.createElement('li');
    const phase = i < state.step ? 'done' : i === state.step ? 'now' : 'later';
    li.className = `move ${phase} ${state.view === i ? 'active' : ''}`;
    // 마우스를 올리면 그 단계를 미리 보고, 벗어나면 지금 단계로 돌아간다
    li.onmouseenter = () => {
      state.view = i;
      renderBoard();
    };
    li.onmouseleave = () => {
      state.view = Math.min(state.step, plan.moves.length);
      renderBoard();
    };
    li.onclick = () => {
      state.view = i;
      renderBoard();
      renderMoves();
    };
    const badge = document.createElement('span');
    badge.className = `badge ${moveColorClass(m, i)} ${moveNumberClass(m)}`;
    badge.textContent = i < state.step ? '✓' : String(i + 1);
    li.appendChild(badge);
    const body = document.createElement('div');
    body.className = 'move-body';
    if (m.kind === 'dot') {
      body.innerHTML = `<b>⊙ 점 찍기</b> → <b>${m.r + 1}행 ${m.c + 1}열</b>`;
    } else {
      const target = PIECES[m.type].orientations[m.orient];
      const op = opText(m.slot, target);
      body.innerHTML = `<b>${m.type}</b> <span class="muted">(${m.slot + 1}번 조각)</span>${
        op ? ` · <span class="op">${op}</span>` : ''
      }<br/>→ <b>${m.r + 1}행 ${m.c + 1}열</b> <span class="muted">(모양의 왼쪽 위 기준)</span>`;
      li.appendChild(shapeEl(target, moveColorClass(m, i)));
    }
    if (m.cleared.length) {
      const gained = plan.itemsGained.filter((it) => m.cleared.includes(it.r));
      body.innerHTML += `<br/><span class="clear">✦ ${m.cleared.length}줄 동시 제거 (+${linePoints(m.cleared.length).toLocaleString()}점)${
        gained.length ? ` · 아이템 ${gained.length}개 획득` : ''
      }</span>`;
    }
    body.innerHTML += dropNote(m);
    li.insertBefore(body, li.children[1] ?? null);
    ol.appendChild(li);
  });

  const lines: string[] = [];
  if (!plan.complete) lines.push('<p class="warn">⚠ 이 손패로는 모든 조각을 놓을 수 없습니다.</p>');
  lines.push(
    `<p class="points">이번 손패 예상 <b>+${plan.points.toLocaleString()}점</b> <span class="muted">(줄 제거 ${plan.lines} · 능력 획득 ${plan.itemsGained.length})</span></p>`,
    `<p class="muted">평가 ${plan.score.toFixed(1)} · ${state.solveMs.toFixed(0)}ms · ${currentStage()}단계 확률로 계산</p>`,
  );
  const o = plan.outlook;
  if (o) {
    const pct = Math.round(o.completeRate * 100);
    lines.push(
      `<p class="outlook ${pct < 80 ? 'warn' : ''}">다음 손패 미리 보기: 무작위 ${o.samples}가지 중 <b>${pct}%</b>는 3개 다 놓을 수 있음 <span class="muted">(후보 ${o.candidates}개 비교)</span></p>`,
    );
    if (o.twoStepRate !== undefined) {
      const p2 = Math.round(o.twoStepRate * 100);
      lines.push(`<p class="outlook ${p2 < 70 ? 'warn' : ''}">두 손패 앞까지: 다음 손패와 그다음 손패를 연달아 다 놓을 확률 <b>${p2}%</b></p>`);
    }
  }
  verdict.innerHTML = lines.join('');
}

function renderHand() {
  const wrap = $('hand');
  wrap.innerHTML = '';
  state.hand.forEach((s, i) => {
    const card = document.createElement('div');
    const swapTarget = swapRecommendation()?.top.slot === i && !s.used;
    card.className = `slot ${s.used ? 'used' : ''} ${swapTarget ? 'swap-target' : ''}`;
    const title = document.createElement('div');
    title.className = `slot-title num-${i}`;
    title.textContent = `${i + 1}번`;
    card.appendChild(title);
    if (s.type && !s.used) {
      const o = PIECES[s.type].orientations[Math.max(0, s.orient)];
      card.appendChild(shapeEl(o, s.color ? `gc-${s.color}` : 'plain'));
    } else {
      const p = document.createElement('div');
      p.className = 'slot-empty';
      p.textContent = s.used ? '사용 완료' : '—';
      card.appendChild(p);
    }
    const sel = document.createElement('select');
    sel.innerHTML =
      `<option value="">(없음)</option><option value="__used">사용 완료</option>` +
      PIECE_TYPES.map((t) => `<option value="${t}">${t} (${PIECES[t].size}칸)</option>`).join('');
    sel.value = s.used ? '__used' : (s.type ?? '');
    sel.onchange = () => {
      const v = sel.value;
      state.hand[i] =
        v === '__used'
          ? { type: null, orient: -1, used: true }
          : { type: (v || null) as PieceType | null, orient: v ? 0 : -1, used: false };
      requestSolve();
    };
    card.appendChild(sel);
    wrap.appendChild(card);
  });
}

function renderInventory() {
  const wrap = $('inventory');
  wrap.innerHTML = '';
  wrap.appendChild(renderGameRow());
  const total = state.inventory.dot + state.inventory.swap;
  for (const [key, label] of [
    ['dot', '⊙ 점 찍기'],
    ['swap', '⇄ 바꿔 뽑기'],
  ] as const) {
    const row = document.createElement('div');
    row.className = 'inv-row';
    row.innerHTML = `<span>${label}</span>`;
    const minus = document.createElement('button');
    minus.textContent = '−';
    minus.onclick = () => {
      state.inventory[key] = Math.max(0, state.inventory[key] - 1);
      renderInventory();
      requestSolve();
    };
    const n = document.createElement('b');
    n.textContent = String(state.inventory[key]);
    const plus = document.createElement('button');
    plus.textContent = '+';
    plus.disabled = total >= INVENTORY_CAP;
    plus.onclick = () => {
      state.inventory[key]++;
      renderInventory();
      requestSolve();
    };
    row.append(minus, n, plus);
    if (state.countFromScreen[key]) {
      const tag = document.createElement('small');
      tag.className = 'tag';
      tag.textContent = '화면';
      tag.title = '게임 화면에서 읽은 값';
      row.appendChild(tag);
    }
    wrap.appendChild(row);

    const prompt = state.digitPrompt[key];
    if (prompt) {
      const box = document.createElement('div');
      box.className = 'digit-prompt';
      box.innerHTML = `<img src="${prompt.url}" alt="" /><span>처음 보는 숫자입니다. 몇인가요?</span>`;
      const btns = document.createElement('div');
      btns.className = 'digit-btns';
      for (let v = 0; v <= INVENTORY_CAP; v++) {
        const b = document.createElement('button');
        b.textContent = String(v);
        b.onclick = () => {
          learnDigit(key, prompt.sig, v);
          countSmoothers[key].set(v);
          state.digitPrompt[key] = null;
          state.inventory[key] = v;
          state.countFromScreen[key] = true;
          addLog(`숫자 ${v} 학습 (${label})`);
          appliedSig = '';
          requestSolve();
        };
        btns.appendChild(b);
      }
      box.appendChild(btns);
      wrap.appendChild(box);
    }
  }
  wrap.appendChild(renderDropRow());

  const cap = document.createElement('div');
  cap.className = 'muted';
  cap.textContent = `보유 ${total}/${INVENTORY_CAP} · 보드 위 아이템 ${state.items.length}/${BOARD_ITEM_CAP}개`;
  wrap.appendChild(cap);

  // 숫자 학습 현황 + 초기화 (숫자 영역을 지정했거나 학습한 숫자가 있을 때만)
  const learned = learnedDigits(state.digits, DEFAULT_DIGITS);
  const learnedDrop = learnedDigits(state.dropDigits, DEFAULT_DROP_DIGITS);
  const learnedNum = learnedDigits(state.numDigits, DEFAULT_NUM_DIGITS);
  const anyLearned = learned.length + learnedDrop.length + learnedNum.length > 0;
  const stageCounts = Object.entries(state.pieceStats)
    .map(([st, c]) => [st, Object.values(c).reduce((a, b) => a + b, 0)] as const)
    .filter(([, n]) => n > 0)
    .sort();
  const anyStats = stageCounts.length > 0;
  if (anyLearned || anyStats || COUNTER_KEYS.some((k) => state.calib.counters[k])) {
    const row = document.createElement('div');
    row.className = 'digit-learned';
    const text = document.createElement('span');
    text.className = 'muted';
    const builtin = Object.keys(DEFAULT_DIGITS).sort().join(', ') || '없음';
    const builtinDrop = Object.keys(DEFAULT_DROP_DIGITS).sort().join(', ') || '없음';
    text.textContent =
      `학습한 숫자 · 보유 개수: ${learned.join(', ') || '없음'} (기본 내장: ${builtin})` +
      ` · 획득까지: ${learnedDrop.join(', ') || '없음'} (기본 내장: ${builtinDrop})` +
      ` · 점수·줄: ${learnedNum.join(', ') || '없음'}` +
      ` · 받은 조각 ${stageCounts.map(([st, n]) => `${st}단계 ${n}개`).join(', ') || '없음'}`;
    const exp = document.createElement('button');
    exp.textContent = '학습 데이터 내보내기';
    exp.title = '학습한 숫자와 받은 조각 통계를 파일로 저장합니다. 이 파일을 보내주면 모든 사용자의 기본값과 조각 확률에 반영할 수 있습니다.';
    exp.disabled = !anyLearned && !anyStats;
    exp.onclick = exportDigits;
    const reset = document.createElement('button');
    reset.textContent = '숫자 학습 초기화';
    reset.disabled = !anyLearned;
    reset.onclick = () => {
      if (confirm('학습한 숫자를 모두 지울까요? 기본 내장된 숫자만 남습니다.')) resetDigits();
    };
    const btns = document.createElement('div');
    btns.className = 'digit-learned-btns';
    btns.append(exp, reset);
    row.append(text, btns);
    wrap.appendChild(row);
  }
}

/** 게임 진행: 제거한 줄 누적(단계)과 추정 점수. 중간부터 보기 시작했으면 줄 수를 직접 고친다 */
function renderGameRow(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'game-row';
  const stage = currentStage();
  const lines = document.createElement('label');
  lines.innerHTML = `제거한 줄 `;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.value = String(state.game.lines);
  input.title = state.calib.numbers.lines
    ? '화면에서 읽은 값입니다 (틀리면 고칠 수 있지만 화면 값으로 다시 바뀝니다)'
    : "'영역 지정'에서 제거한 줄 숫자 영역을 지정하면 화면에서 읽습니다. 지정하지 않으면 직접 입력하세요 (단계 = 조각 등장 확률)";
  input.onchange = () => {
    const before = stage;
    state.game.lines = Math.max(0, Math.round(Number(input.value) || 0));
    saveJson(GAME_KEY, state.game);
    if (currentStage() !== before) requestSolve(state.locked);
    renderInventory();
  };
  lines.appendChild(input);
  lines.append(`줄 · `);
  const st = document.createElement('b');
  st.textContent = `${stage}단계`;
  st.title = `${STAGE_RANGES[stage - 1]} · 단계가 오를수록 칸 수가 적은 조각이 덜 나옵니다`;
  lines.appendChild(st);
  if (state.numFromScreen.lines) {
    const tag = document.createElement('small');
    tag.className = 'tag';
    tag.textContent = '화면';
    lines.appendChild(tag);
  }
  const score = document.createElement('div');
  score.className = 'muted';
  if (state.calib.numbers.score) {
    const pct = Math.min(100, (state.game.score / TARGET_SCORE) * 100);
    score.innerHTML = state.numFromScreen.score
      ? `점수 <b>${state.game.score.toLocaleString()}</b> / ${TARGET_SCORE.toLocaleString()} (${pct.toFixed(1)}%)`
      : '점수: 화면에서 읽는 중…';
  } else score.textContent = `점수: '영역 지정'에서 점수 숫자 영역을 지정하면 화면에서 읽습니다 (목표 ${TARGET_SCORE.toLocaleString()})`;
  box.append(lines, score);
  for (const k of NUMBER_KEYS) {
    const prompt = state.numPrompt[k];
    if (!prompt) continue;
    const q = document.createElement('div');
    q.className = 'digit-prompt';
    q.innerHTML = `<img src="${prompt.url}" alt="" /><span>${NUMBER_NAME[k]}에 처음 보는 숫자가 있습니다. 화면의 숫자를 그대로 입력하세요.</span>`;
    const form = document.createElement('form');
    form.className = 'num-form';
    const field = document.createElement('input');
    field.inputMode = 'numeric';
    field.placeholder = `${prompt.sigs.length}자리`;
    const ok = document.createElement('button');
    ok.textContent = '학습';
    const err = document.createElement('small');
    err.className = 'warn';
    form.onsubmit = (e) => {
      e.preventDefault();
      const msg = learnNumber(k, prompt.sigs, field.value);
      if (msg) err.textContent = msg;
      else renderInventory();
    };
    form.append(field, ok, err);
    q.appendChild(form);
    box.appendChild(q);
  }
  return box;
}

/** '다음 능력 획득까지' 표시 (화면에서 읽거나 직접 입력) + 처음 보는 숫자 질문 */
function renderDropRow(): HTMLElement {
  const box = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'inv-row';
  row.innerHTML = `<span title="블록을 이만큼 더 놓으면 빈 칸에 능력이 떨어집니다. 보드 위 아이템이 이미 3개면 가장 오래된 것이 사라집니다.">⬇ 능력 획득까지</span>`;
  const set = (v: number | null) => {
    state.dropIn = v;
    state.countFromScreen.drop = false;
    renderInventory();
    requestSolve();
  };
  const minus = document.createElement('button');
  minus.textContent = '−';
  minus.onclick = () => set(state.dropIn === null ? DROP_EVERY : Math.max(1, state.dropIn - 1));
  const n = document.createElement('b');
  n.textContent = state.dropIn === null ? '?' : `${state.dropIn}번`;
  const plus = document.createElement('button');
  plus.textContent = '+';
  plus.onclick = () => set(state.dropIn === null ? 1 : Math.min(DROP_EVERY, state.dropIn + 1));
  row.append(minus, n, plus);
  if (state.countFromScreen.drop) {
    const tag = document.createElement('small');
    tag.className = 'tag';
    tag.textContent = '화면';
    row.appendChild(tag);
  }
  box.appendChild(row);
  const prompt = state.digitPrompt.drop;
  if (prompt) {
    const q = document.createElement('div');
    q.className = 'digit-prompt';
    q.innerHTML = `<img src="${prompt.url}" alt="" /><span>'능력 획득까지' 숫자를 처음 봅니다. 몇인가요?</span>`;
    const btns = document.createElement('div');
    btns.className = 'digit-btns';
    for (let v = 1; v <= DROP_EVERY; v++) {
      const b = document.createElement('button');
      b.textContent = String(v);
      b.onclick = () => {
        learnDigit('drop', prompt.sig, v);
        countSmoothers.drop.set(v);
        state.digitPrompt.drop = null;
        state.dropIn = v;
        state.countFromScreen.drop = true;
        addLog(`숫자 ${v} 학습 (능력 획득까지)`);
        renderInventory();
      };
      btns.appendChild(b);
    }
    q.appendChild(btns);
    box.appendChild(q);
  }
  return box;
}

/** 바꿔 뽑기를 추천하는가 (손패를 다 못 놓으면 무조건, 아니면 기대 이득이 비용보다 클 때) */
function swapRecommendation(): { top: SwapAdvice; urgent: boolean } | null {
  if (state.inventory.swap <= 0 || !state.plan || !state.swaps?.length) return null;
  const top = state.swaps[0];
  const urgent = !state.plan.complete;
  if (!urgent && top.gain < DEFAULT_WEIGHTS.swapCost) return null;
  return { top, urgent };
}

let lastSwapLogKey = '';

function renderSwapAdvice() {
  const el = $('swapAdvice');
  const banner = $('swapBanner');
  el.innerHTML = '';
  banner.hidden = true;
  banner.innerHTML = '';
  if (state.inventory.swap <= 0 || !state.plan) return;
  if (!state.swaps) {
    el.innerHTML = '<p class="muted">바꿔 뽑기 분석 중…</p>';
    return;
  }
  const rec = swapRecommendation();
  if (!rec) {
    const top = state.swaps[0];
    if (top) el.innerHTML = `<p class="muted">바꿔 뽑기는 아껴두세요 (최대 기대 이득 ${top.gain.toFixed(1)}: ${top.slot + 1}번 ${top.type})</p>`;
    return;
  }
  const { top, urgent } = rec;
  const pct = (top.completeRate * 100).toFixed(0);
  banner.hidden = false;
  banner.classList.toggle('urgent', urgent);
  banner.innerHTML = `
    <div class="swap-banner-icon">⇄</div>
    <div>
      <div class="swap-banner-title">${urgent ? '⚠ 이대로는 블록을 다 놓을 수 없어요' : '바꿔 뽑기를 먼저 쓰세요!'}</div>
      <div class="swap-banner-body"><b class="num-${top.slot}">${top.slot + 1}번 조각 (${top.type})</b>을 바꿔 뽑기로 교체하세요</div>
      <div class="swap-banner-sub">${urgent ? '' : `기대 이득 +${top.gain.toFixed(1)} · `}교체 후 전부 놓을 확률 ${pct}%</div>
    </div>`;
  el.innerHTML = `<p class="go">⇄ <b>${top.slot + 1}번 조각 (${top.type})</b> 교체 추천 (위 안내 참고)</p>`;
  const key = `${swapReqId}:${top.slot}`;
  if (key !== lastSwapLogKey) {
    lastSwapLogKey = key;
    addLog(`⇄ 바꿔 뽑기 추천: ${top.slot + 1}번 조각 (${top.type})${urgent ? ' — 이대로는 다 못 놓음' : ''}`);
  }
}

function renderLog() {
  $('log').innerHTML = state.log.map((l) => `<li>${l}</li>`).join('');
}

function renderAll() {
  renderBoard();
  renderMoves();
  renderHand();
  renderInventory();
  renderSwapAdvice();
}

// ───────────── 화면 인식 ─────────────

type Source = { grab(): (Frame & { image: CanvasImageSource }) | null };
const capture = new ScreenCapture();
let source: Source | null = null;
let prevSnap: Snapshot | null = null;
/** 보드 칸 상태 필터 (순간적인 오인식 거르기) */
const boardFilter = new BoardFilter();
/** 가장 최근 프레임 (영역 자동 맞춤에 사용) */
let lastFrame: (Frame & { image: CanvasImageSource }) | null = null;
/** 칸별 마지막으로 읽은 블록 색 */
const lastColors: (string | null)[][] = Array.from({ length: H }, () => new Array<string | null>(W).fill(null));
const itemConfirmer = new ItemConfirmer();
const countSmoothers: Record<CounterKey, CountSmoother> = {
  dot: new CountSmoother(),
  swap: new CountSmoother(),
  drop: new CountSmoother(),
};
let lastSig = '';
let stable = 0;
let appliedSig = '';

function calibReady() {
  return !!state.calib.board && state.calib.slots.every(Boolean);
}

/** 새 블록을 받는 등 계산을 다시 하게 될 때, 화면이 이 시간 동안 변하지 않아야 계산한다 (줄 제거·새 블록 애니메이션 대기) */
const SETTLE_MS = 1200;
/** 지금 인식 결과(sig)가 처음 나타난 시각 */
let sigSince = 0;

function tick() {
  if (!source) return;
  const frame = source.grab();
  if (!frame) return;
  lastFrame = frame;
  if (!$('calibPanel').hidden) drawPreview(frame);
  if (!calibReady() || state.paused) return;
  if (!checkFrameSize(frame)) return;
  const now = performance.now();
  // 보유 능력 개수·점수·줄 수는 보드·손패와 상관없이 매 순간 읽어 바로 반영한다
  updateCounters(frame, now);
  updateNumbers(frame, now);

  const slots = state.calib.slots.map((r) => readHandSlot(frame, r!));
  // 게임에서 조각을 클릭해 선택(노란 카드)한 동안에는 화면을 반영하지도, 계산하지도 않는다.
  // (조각을 끌고 다니는 중의 보드 변화도 무시) 선택이 끝나면 그때 화면부터 다시 반영한다.
  // 바꿔 뽑기를 누른 동안(카드 배경이 보라)도 마찬가지로 멈춘다. 조각이 바뀌면 끝난 뒤 새 블록으로 보고 다시 계산한다.
  const swapping = slots.some((s) => s.swapping);
  if (swapping || slots.some((s) => s.selected)) {
    enterSelectionPause(swapping ? '⇄ 바꿔 뽑기 중 · 계산 멈춤' : '✋ 조각 선택 중 · 계산 멈춤');
    recordFrame(frame, now, { selected: true, hand: slots });
    return;
  }
  leaveSelectionPause();

  const b = readBoard(frame, state.calib.board!);
  const rawRows = b.rows;
  // 칸 상태는 일정 시간 같은 상태가 이어질 때만 바꾼다 (순간적인 오인식·아이콘 빛·애니메이션 거르기)
  b.rows = boardFilter.update(rawRows, now, b.unsure);
  // 채워져 있는데 색을 못 읽은 칸(빛에 가려 유지된 칸 등)은 직전 색을 쓴다
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++)
      if ((b.rows[r] >> c) & 1) {
        if (b.colors[r][c]) lastColors[r][c] = b.colors[r][c];
        else b.colors[r][c] = lastColors[r][c];
      } else lastColors[r][c] = null;
  // 1초 이상 같은 자리에 보인 아이템만 인정 (줄 제거 번쩍임 등 걸러냄)
  const items = itemConfirmer.update(b.items, now);
  watchDrops(items, now);
  recordFrame(frame, now, { selected: false, hand: slots, raw: rawRows, rows: b.rows, items });
  const sig =
    b.rows.join(',') +
    '|' +
    items.map((it) => `${it.r}.${it.c}.${it.type}`).join(',') +
    '|' +
    slots.map((s) => (s.used ? 'U' : `${s.type ?? '?'}${s.orient}`)).join(',');
  if (sig === lastSig) stable++;
  else {
    lastSig = sig;
    stable = 0;
    sigSince = now;
  }
  // 애니메이션(줄 제거 등) 중 오인식을 피하려고 같은 결과가 연속 3번(약 0.5초) 나와야 반영
  if (stable < 2 || sig === appliedSig) return;

  const snap: Snapshot = {
    rows: b.rows,
    items,
    hand: slots.map((s) => ({ type: s.type, used: s.used })),
  };
  const newBlocks = prevSnap !== null && receivedNewBlocks(prevSnap, snap);
  // 추천 고정 중: 사용자가 안내대로 놓았는지 확인 (다음 단계로 / 다르게 놓았으면 다시 계산)
  const progress: ProgressResult =
    state.locked && !newBlocks && state.plan && state.planBase
      ? checkProgress(state.planBase.rows, state.plan.moves, state.planBase.used, state.step, b.rows, slots.map((s) => s.used))
      : { kind: 'same' };
  // 계산으로 이어지는 변화(새 블록을 받음 / 고정 안 됨 / 안내와 다르게 놓음)라면 화면이 충분히 안정될 때까지 기다린다.
  // 마지막 블록을 놓는 순간에는 줄 제거 이펙트와 새 블록이 함께 나타나기 때문이다.
  if (
    (!state.locked || newBlocks || progress.kind === 'deviated') &&
    (now - sigSince < SETTLE_MS || boardFilter.pending)
  ) {
    setStatus('⏳ 화면이 안정되길 기다리는 중…', 'busy');
    return;
  }
  // 능력이 떨어질 차례였다면, 떨어진 능력을 확인한 다음에 계산한다
  if ((!state.locked || newBlocks || progress.kind === 'deviated') && dropWatch) {
    setStatus('⏳ 떨어진 능력 확인 중…', 'busy');
    return;
  }
  appliedSig = sig;

  const res = track(prevSnap, snap, live.items, state.inventory);
  if (!prevSnap) {
    // 화면을 처음 반영할 때 이미 있던 아이템은 '드롭'으로 보지 않는다
    knownItems = new Map(res.items.map((it) => [itemKey(it), 0]));
    dropsPrimed = true;
  }
  if (prevSnap && newBlocks) countPieces(prevSnap, snap);
  prevSnap = snap;
  res.events.forEach(addLog);
  if (slots.some((s) => s.unknown)) addLog('인식할 수 없는 조각이 있습니다 (영역을 확인하세요)');

  live.rows = b.rows;
  live.colors = b.colors;
  live.items = res.items;
  live.hand = slots.map((s) => ({ type: s.type, orient: s.orient, used: s.used, color: s.color }));
  state.inventory = res.inventory;
  // 화면에서 읽은 개수가 있으면 추적값보다 우선한다
  for (const k of ITEM_KEYS) if (state.countFromScreen[k] && countSmoothers[k].value != null) state.inventory[k] = countSmoothers[k].value!;

  // 추천 고정 중: 안내대로 놓으면 다음 단계로, 다르게 놓으면 남은 조각으로 다시 계산
  if (state.locked && !newBlocks) {
    if (dropRecompute && live.hand.some((h) => !h.used && h.type)) {
      dropRecompute = false;
      addLog('능력이 새로 떨어져 남은 조각으로 다시 계산합니다');
      applyLive();
      requestSolve(true);
      return;
    }
    if (progress.kind === 'deviated') {
      addLog(`추천과 다르게 놓아서 남은 조각으로 다시 계산합니다 (${progress.reason})`);
      applyLive();
      requestSolve(true);
      return;
    }
    if (progress.kind === 'advanced') goToStep(progress.step, true);
    renderInventory();
    return;
  }
  applyLive();
  requestSolve(true);
}

/**
 * 보유 능력 개수를 화면에서 읽어 바로 반영한다 (매 프레임).
 * 같은 값이 0.6초 이어질 때만 바꾸고, 숫자가 안 보이면 마지막 값을 유지한다.
 * - 추천 고정 중: 계획은 그대로, 바꿔 뽑기 개수가 바뀌면 바꿔 뽑기 분석만 다시 한다
 * - 고정 아님: 개수가 바뀌면 다시 계산한다
 */
const numSmoothers: Record<NumberKey, CountSmoother> = { score: new CountSmoother(), lines: new CountSmoother() };
/** 숫자 모양 문자열 → 글자별 모양 (처음 보는 숫자를 물어볼 때 쓴다) */
const numSigCache: Record<NumberKey, Map<string, DigitSig[]>> = { score: new Map(), lines: new Map() };

/** 점수·제거한 줄 수를 화면에서 읽는다 (매 프레임, 같은 값이 0.6초 이어질 때만 반영) */
function updateNumbers(frame: Frame & { image: CanvasImageSource }, now: number) {
  let changed = false;
  for (const k of NUMBER_KEYS) {
    const rect = state.calib.numbers[k];
    if (!rect) continue;
    const sigs = readNumberSigs(frame, rect);
    const key = sigs ? sigs.join('/') : '';
    if (sigs) {
      const cache = numSigCache[k];
      cache.set(key, sigs);
      if (cache.size > 50) cache.delete(cache.keys().next().value!);
    }
    const c = numSmoothers[k].update(sigs ? { sig: key, value: matchNumber(sigs, state.numDigits) } : null, now);
    if (c.value != null && (c.value !== state.game[k] || !state.numFromScreen[k])) {
      setGameNumber(k, c.value);
      changed = true;
    }
    if (c.value != null && state.numPrompt[k] && matchNumber(state.numPrompt[k]!.sigs, state.numDigits) !== null) {
      state.numPrompt[k] = null;
      changed = true;
    }
    if (c.unknownSig && state.numPrompt[k]?.sigs.join('/') !== c.unknownSig) {
      const unknown = numSigCache[k].get(c.unknownSig);
      if (unknown) {
        state.numPrompt[k] = { sigs: unknown, url: cropUrl(frame, rect) };
        changed = true;
      }
    }
  }
  if (changed) renderInventory();
}

function updateCounters(frame: Frame & { image: CanvasImageSource }, now: number) {
  const reads = readCounters(frame);
  const changed: ItemKey[] = [];
  let promptChanged = false;
  for (const k of COUNTER_KEYS) {
    if (!state.calib.counters[k]) continue;
    const c = countSmoothers[k].update(reads[k], now);
    if (k === 'drop') {
      // '다음 능력 획득까지'는 블록을 놓을 때마다 바뀌므로 다시 계산하지 않고 값만 기억한다 (다음 계산 때 반영)
      if (c.value != null && (state.dropIn !== c.value || !state.countFromScreen.drop)) {
        // 숫자가 다시 올라갔다(1 → 7) = 방금 블록을 놓아 능력이 떨어질 차례 → 판에서 새 능력을 찾는다
        if (state.countFromScreen.drop && state.dropIn !== null && c.value > state.dropIn) startDropWatch(now);
        state.dropIn = c.value;
        state.countFromScreen.drop = true;
        promptChanged = true;
      }
      if (c.value != null && state.digitPrompt.drop) {
        state.digitPrompt.drop = null;
        promptChanged = true;
      }
    } else if (c.value != null) {
      if (!state.countFromScreen[k] || state.inventory[k] !== c.value) {
        if (state.countFromScreen[k]) addLog(`${k === 'dot' ? '⊙ 점 찍기' : '⇄ 바꿔 뽑기'} ${state.inventory[k]} → ${c.value}개`);
        state.inventory[k] = c.value;
        state.countFromScreen[k] = true;
        changed.push(k);
      }
      if (state.digitPrompt[k]) {
        state.digitPrompt[k] = null;
        promptChanged = true;
      }
    }
    if (c.unknownSig && state.digitPrompt[k]?.sig !== c.unknownSig) {
      state.digitPrompt[k] = { sig: c.unknownSig, url: cropUrl(frame, state.calib.counters[k]!) };
      promptChanged = true;
    }
  }
  if (!changed.length && !promptChanged) return;
  renderInventory();
  if (!changed.length || !state.plan || selectionPaused) {
    renderSwapAdvice();
    return;
  }
  if (state.locked) {
    if (changed.includes('swap')) requestSwapAnalysis();
    else renderSwapAdvice();
  } else requestSolve(!!source);
}

/** 보유 능력 숫자 읽기. 영역이 없거나 숫자가 안 보이면 null, 모르는 모양이면 value=null */
function readCounters(frame: Frame): Record<CounterKey, { sig: DigitSig; value: number | null } | null> {
  const out = { dot: null, swap: null, drop: null } as Record<CounterKey, { sig: DigitSig; value: number | null } | null>;
  for (const k of COUNTER_KEYS) {
    const rect = state.calib.counters[k];
    if (!rect) continue;
    const drop = k === 'drop';
    const sig = readDigitSig(frame, rect, drop ? 'dark' : 'light');
    if (sig) out[k] = { sig, value: matchDigit(sig, drop ? state.dropDigits : state.digits) };
  }
  return out;
}

function cropUrl(frame: Frame & { image: CanvasImageSource }, r: Rect): string {
  const scale = Math.max(1, Math.round(48 / r.h));
  const cv = document.createElement('canvas');
  cv.width = Math.round(r.w * scale);
  cv.height = Math.round(r.h * scale);
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frame.image, r.x, r.y, r.w, r.h, 0, 0, cv.width, cv.height);
  return cv.toDataURL();
}

// ───────────── 조각 선택 중 일시 정지 ─────────────


let selectionPausedAt = 0;

function enterSelectionPause(label: string) {
  const el = $('status');
  if (!selectionPaused) {
    selectionPaused = true;
    selectionPausedAt = performance.now();
    statusBeforeSelection = { text: el.textContent ?? '', kind: el.dataset.kind ?? 'idle' };
  }
  el.textContent = label;
  el.dataset.kind = 'idle';
}

function leaveSelectionPause() {
  if (!selectionPaused) return;
  selectionPaused = false;
  // 선택 중에는 보드를 보지 않았으므로, 아이템·칸 상태 기록을 그 시간만큼 미룬다
  // (그러지 않으면 선택이 끝난 뒤 있던 아이템이 사라졌다 다시 나타난 '새 드롭'으로 보인다)
  const paused = performance.now() - selectionPausedAt;
  itemConfirmer.shift(paused);
  boardFilter.shift(paused);
  if (dropWatch) dropWatch.until += paused;
  // 선택 중에 쌓인 '같은 화면' 판정을 버리고 지금 화면부터 다시 안정 여부를 본다
  lastSig = '';
  stable = 0;
  if (statusBeforeSelection) {
    const el = $('status');
    el.textContent = statusBeforeSelection.text;
    el.dataset.kind = statusBeforeSelection.kind;
  }
  statusBeforeSelection = null;
}

/** 화면에서 인식한 최신 상태 (추천 고정 중에도 계속 갱신) */
const live = {
  rows: emptyRows() as Rows,
  colors: [] as (string | null)[][],
  items: [] as Item[],
  hand: [] as Slot[],
};

function applyLive() {
  state.rows = live.rows;
  state.colors = live.colors;
  state.items = live.items;
  if (live.hand.length) state.hand = live.hand;
}

/** 화면을 처음부터 다시 읽도록 인식 상태를 모두 초기화 */
function resetRecognition() {
  prevSnap = null;
  appliedSig = '';
  lastSig = '';
  stable = 0;
  itemConfirmer.reset();
  boardFilter.reset();
  countSmoothers.dot.reset();
  countSmoothers.swap.reset();
  countSmoothers.drop.reset();
  numSmoothers.score.reset();
  numSmoothers.lines.reset();
  dropsPrimed = false;
  dropWatch = null;
  dropRecompute = false;
}

// ───────────── 공유 화면 크기 확인 ─────────────

let sizeWarnedFor = '';

/** 영역을 지정할 때와 공유 화면 크기가 다르면 비율대로 맞춘다. 비율 자체가 다르면 false (다시 지정 필요) */
function checkFrameSize(frame: Frame): boolean {
  const c = state.calib;
  if (!c.frame) {
    c.frame = { w: frame.width, h: frame.height };
    saveCalib();
    return true;
  }
  if (c.frame.w === frame.width && c.frame.h === frame.height) return true;
  const sx = frame.width / c.frame.w;
  const sy = frame.height / c.frame.h;
  if (Math.abs(sx - sy) <= 0.02 * Math.max(sx, sy)) {
    const scale = (r: Rect | null): Rect | null => (r ? { x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy } : null);
    c.board = scale(c.board);
    c.slots = c.slots.map(scale);
    c.counters = { dot: scale(c.counters.dot), swap: scale(c.counters.swap), drop: scale(c.counters.drop) };
    c.numbers = { score: scale(c.numbers.score), lines: scale(c.numbers.lines) };
    addLog(`공유 화면 크기가 ${c.frame.w}×${c.frame.h} → ${frame.width}×${frame.height}로 바뀌어 영역을 비율대로 맞췄습니다`);
    c.frame = { w: frame.width, h: frame.height };
    saveCalib();
    resetRecognition();
    return true;
  }
  const key = `${frame.width}×${frame.height}`;
  if (sizeWarnedFor !== key) {
    sizeWarnedFor = key;
    addLog(`⚠ 공유 화면(${key})의 가로세로 비율이 영역 지정 때(${c.frame.w}×${c.frame.h})와 다릅니다. 영역을 다시 지정하세요.`);
    setStatus('⚠ 화면 크기가 바뀌었습니다 · 영역을 다시 지정하세요', 'warn');
    openCalib();
  }
  return false;
}

// ───────────── 최근 화면 기록 / 저장 (문제 분석용) ─────────────

const RECORD_INTERVAL_MS = 500;
const RECORD_KEEP = 16; // 약 8초
interface RecordInfo {
  selected: boolean;
  hand: { type: PieceType | null; used: boolean; selected: boolean; color: string | null; unknown: boolean }[];
  raw?: Rows;
  rows?: Rows;
  items?: Item[];
}
const records: { time: number; area: Rect; bitmap: ImageBitmap | null; info: RecordInfo }[] = [];
let lastRecordAt = 0;

/** 보드·보유 조각·개수 영역을 모두 포함하는 사각형 */
function recordArea(frame: Frame): Rect {
  const rects = [state.calib.board, ...state.calib.slots, ...COUNTER_KEYS.map((k) => state.calib.counters[k]), ...NUMBER_KEYS.map((k) => state.calib.numbers[k])].filter(
    (r): r is Rect => !!r,
  );
  const m = 12;
  const x0 = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.x)) - m));
  const y0 = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.y)) - m));
  const x1 = Math.min(frame.width, Math.ceil(Math.max(...rects.map((r) => r.x + r.w)) + m));
  const y1 = Math.min(frame.height, Math.ceil(Math.max(...rects.map((r) => r.y + r.h)) + m));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function recordFrame(
  frame: Frame & { image: CanvasImageSource },
  now: number,
  info: Omit<RecordInfo, 'hand'> & { hand: { type: PieceType | null; used: boolean; selected: boolean; color: string | null; unknown: boolean }[] },
) {
  if (now - lastRecordAt < RECORD_INTERVAL_MS) return;
  lastRecordAt = now;
  const area = recordArea(frame);
  const entry = {
    time: Date.now(),
    area,
    bitmap: null as ImageBitmap | null,
    info: {
      ...info,
      hand: info.hand.map(({ type, used, selected, color, unknown }) => ({ type, used, selected, color, unknown })),
    },
  };
  records.push(entry);
  while (records.length > RECORD_KEEP) records.shift()?.bitmap?.close();
  // 호출 시점의 화면을 복사해 둔다
  createImageBitmap(frame.image, area.x, area.y, area.w, area.h)
    .then((bm) => (entry.bitmap = bm))
    .catch(() => {});
}

/** 최근 몇 초의 화면과 인식 결과, 현재 상태를 JSON 파일 하나로 내려받는다 */
function saveCapture() {
  const frames = records
    .filter((r) => r.bitmap)
    .map((r) => {
      const cv = document.createElement('canvas');
      cv.width = r.bitmap!.width;
      cv.height = r.bitmap!.height;
      cv.getContext('2d')!.drawImage(r.bitmap!, 0, 0);
      return {
        time: new Date(r.time).toISOString(),
        area: r.area,
        png: cv.toDataURL('image/png'),
        selected: r.info.selected,
        hand: r.info.hand,
        rawRows: r.info.raw ? rowsToStrings(r.info.raw) : null,
        rows: r.info.rows ? rowsToStrings(r.info.rows) : null,
        items: r.info.items ?? null,
      };
    });
  const data = {
    app: 'moamoa-helper',
    savedAt: new Date().toISOString(),
    calib: state.calib,
    state: {
      rows: rowsToStrings(state.rows),
      hand: state.hand,
      items: state.items,
      inventory: state.inventory,
      dropIn: state.dropIn,
      locked: state.locked,
      plan: state.plan ? { complete: state.plan.complete, moves: state.plan.moves } : null,
    },
    log: state.log,
    // 학습한 숫자도 함께 (scripts/merge-digits.ts로 기본값에 합칠 수 있음)
    digits: learnedOnly(state.digits, DEFAULT_DIGITS),
    dropDigits: learnedOnly(state.dropDigits, DEFAULT_DROP_DIGITS),
    numDigits: learnedOnly(state.numDigits, DEFAULT_NUM_DIGITS),
    game: state.game,
    frames,
  };
  const name = `moamoa-${timestamp()}.json`;
  downloadJson(data, name);
  addLog(`화면 저장: 최근 ${frames.length}장 (${name})`);
}

setInterval(tick, 250);

// ───────────── 능력 드롭 확인 ─────────────
// 능력은 블록 7번 배치마다 떨어진다. '능력 획득까지' 숫자를 화면에서 읽고 있으면 그 숫자가 다시 올라가는 순간(드롭 시점)에만
// 판에서 새 능력을 찾고, 찾을 때까지 계산을 미룬다. 숫자를 못 읽으면 예전처럼 1초마다 판을 확인한다.

const itemKey = (it: Item) => `${it.r},${it.c},${it.type}`;
/** 새로 떨어진 아이템 → 처음 본 시각 (보드에서 깜빡임 표시) */
const newDrops = new Map<string, number>();
const NEW_DROP_MS = 5000;
/** 알고 있는 아이템 → 처음 확인한 시각 */
let knownItems = new Map<string, number>();
/** 화면을 처음 반영했는가 (그때 있던 아이템이 기준) */
let dropsPrimed = false;
/** 드롭 시점부터 새 능력이 보일 때까지 기다리는 최대 시간 (아이콘이 1초 이상 보여야 인정하므로 여유 있게) */
const DROP_WAIT_MS = 3500;

/** 드롭 시점을 '능력 획득까지' 숫자로 알 수 있는가 */
function timedDrops(): boolean {
  return !!state.calib.counters.drop && state.countFromScreen.drop;
}

function startDropWatch(now: number) {
  if (state.inventory.dot + state.inventory.swap >= INVENTORY_CAP) {
    addLog('능력 드롭 차례지만 7개 보유 중이라 생기지 않습니다');
    return;
  }
  dropWatch = { since: now, until: now + DROP_WAIT_MS };
}

function addDrop(it: Item, now: number) {
  newDrops.set(itemKey(it), now);
  addLog(`${it.type === 'dot' ? '⊙ 점 찍기' : '⇄ 바꿔 뽑기'} 드롭: ${it.r + 1}행 ${it.c + 1}열`);
}

/** 매 프레임: 드롭을 기다리는 중이면 새로 확인된 아이템을 찾는다 */
function watchDrops(items: Item[], now: number) {
  if (!timedDrops() || !dropsPrimed) return;
  if (!dropWatch) {
    // 드롭 시점이 아닐 때 보이는 아이템은 기준으로만 기억한다
    const next = new Map<string, number>();
    for (const it of items) next.set(itemKey(it), knownItems.get(itemKey(it)) ?? now);
    knownItems = next;
    return;
  }
  // 드롭 직전에 막 확인된 아이템도 이번 드롭일 수 있다 (숫자 인식이 아이콘 확인보다 늦을 때)
  const fresh = items.filter((it) => {
    const t = knownItems.get(itemKey(it));
    return t === undefined || t > dropWatch!.since - 1500;
  });
  if (fresh.length) {
    for (const it of fresh) addDrop(it, now);
    for (const it of items) if (!knownItems.has(itemKey(it))) knownItems.set(itemKey(it), now);
    dropWatch = null;
    if (state.locked) {
      state.items = items.slice();
      dropRecompute = true;
      // 고정 중에는 화면 변화가 없을 수 있으므로 다음 프레임에서 바로 반영하게 한다
      appliedSig = '';
    }
    renderBoard();
    renderInventory();
  } else if (now > dropWatch.until) {
    addLog('능력 드롭 시점이었지만 새 능력을 찾지 못했습니다 (가려졌거나 이미 반영됨)');
    dropWatch = null;
  }
}

/** 1초마다: 깜빡임 표시 정리, 고정 중 보드의 아이템 표시 갱신. 드롭 시점을 모를 때만 여기서 새 능력을 찾는다 */
function checkDrops() {
  if (!source || !calibReady() || state.paused) return;
  const now = performance.now();
  if (!dropsPrimed) return;
  let changed = false;
  if (!timedDrops()) {
    for (const it of live.items) {
      if (knownItems.has(itemKey(it))) continue;
      addDrop(it, now);
      changed = true;
    }
    knownItems = new Map(live.items.map((it) => [itemKey(it), knownItems.get(itemKey(it)) ?? now]));
  }
  for (const [k, t] of newDrops)
    if (now - t > NEW_DROP_MS) {
      newDrops.delete(k);
      changed = true;
    }
  // 추천 고정 중: 블록·추천은 그대로 두고 보드의 아이템 표시만 갱신한다
  if (state.locked) {
    const shown = new Set(state.items.map(itemKey));
    const cur = new Set(live.items.map(itemKey));
    if (shown.size !== cur.size || [...cur].some((k) => !shown.has(k))) {
      state.items = live.items.slice();
      changed = true;
    }
  }
  if (changed) {
    renderBoard();
    renderInventory();
  }
}

setInterval(checkDrops, 1000);

$('btnCapture').onclick = async () => {
  if (capture.active) {
    capture.stop();
    return;
  }
  try {
    await capture.start();
    source = capture;
    resetRecognition();
    $('btnCapture').textContent = '화면 공유 중지';
    addLog('화면 공유 시작');
    if (!calibReady()) openCalib();
  } catch (err) {
    addLog(`화면 공유 실패: ${(err as Error).message}`);
  }
};
capture.onEnded = () => {
  $('btnCapture').textContent = '화면 공유 시작';
  if (source === capture) source = null;
  addLog('화면 공유 종료');
};

$<HTMLInputElement>('fileInput').onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const bmp = await createImageBitmap(file);
  const cv = document.createElement('canvas');
  cv.width = bmp.width;
  cv.height = bmp.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  if (capture.active) capture.stop();
  source = { grab: () => ({ data: img.data, width: img.width, height: img.height, image: cv }) };
  resetRecognition();
  addLog(`이미지 열기: ${file.name} (${img.width}×${img.height})`);
  if (!calibReady()) openCalib();
};

$('btnPause').onclick = () => {
  state.paused = !state.paused;
  $('btnPause').textContent = state.paused ? '재개' : '일시정지';
  $('btnPause').classList.toggle('active', state.paused);
  if (!state.paused) appliedSig = '';
};

$('btnReset').onclick = () => {
  state.rows = emptyRows();
  state.colors = [];
  state.items = [];
  state.hand = [0, 1, 2].map(() => ({ type: null, orient: -1, used: false }));
  state.inventory = { dot: 0, swap: 0 };
  // 새 게임: 제거한 줄·추정 점수도 처음부터
  state.game = { lines: 0, score: 0 };
  saveJson(GAME_KEY, state.game);
  live.rows = emptyRows();
  live.colors = [];
  live.items = [];
  live.hand = [];
  resetRecognition();
  requestSolve();
};

$('effort').onchange = () => requestSolve(state.locked);

$('btnSave').onclick = () => {
  if (!records.length) {
    addLog('저장할 화면이 없습니다 (화면 공유와 영역 지정 후 사용하세요)');
    return;
  }
  saveCapture();
};

$('btnResolve').onclick = () => {
  if (source) {
    // 기억해 둔 인식 상태를 버리고 지금 화면을 처음부터 다시 읽은 뒤 계산한다
    resetRecognition();
    state.locked = false;
    setStatus('지금 화면을 다시 읽는 중…', 'busy');
    return;
  }
  requestSolve(false);
};

$('btnLock').onclick = () => {
  state.lockEnabled = !state.lockEnabled;
  $('btnLock').textContent = `추천 고정: ${state.lockEnabled ? '켜짐' : '꺼짐'}`;
  $('btnLock').classList.toggle('active', state.lockEnabled);
  if (!state.lockEnabled && state.locked) {
    state.locked = false;
    appliedSig = '';
  }
};

// ───────────── 영역 지정 ─────────────

const TARGETS = ['보드', '조각 1', '조각 2', '조각 3', '점 찍기 개수', '바꿔 뽑기 개수', '능력 획득까지', '점수', '제거한 줄'] as const;
const TARGET_HELP = [
  '보드 격자(10×16)를 대략 드래그하면 격자선에 자동으로 맞춥니다. 칸마다 찍힌 점이 각 칸 가운데에 오는지 확인하세요.',
  '1번 보유 조각의 흰 영역(블록 그림만, 글자·버튼 제외)을 드래그하세요.',
  '2번 보유 조각의 흰 영역을 드래그하세요.',
  '3번 보유 조각의 흰 영역을 드래그하세요.',
  '(선택) 점 찍기 버튼 오른쪽 숫자 동그라미를 드래그하세요.',
  '(선택) 바꿔 뽑기 버튼 오른쪽 숫자 동그라미를 드래그하세요.',
  "(선택) '다음 능력 획득까지 N번'에서 숫자 N만 드래그하세요 ('번' 글자는 빼고). 아이템이 사라지는 시점을 계산에 씁니다.",
  '(선택) 게임 점수의 숫자 부분만 드래그하세요 (글자·아이콘은 빼고, 자릿수가 늘어날 것을 생각해 오른쪽/왼쪽 여유를 두세요).',
  '(선택) 제거한 줄 수의 숫자 부분만 드래그하세요. 단계(조각 등장 확률)를 정하는 데 씁니다.',
];
let calibTarget = 0;
const preview = $<HTMLCanvasElement>('preview');
const pctx = preview.getContext('2d')!;
let drag: { x0: number; y0: number; x1: number; y1: number } | null = null;

function getRect(i: number): Rect | null {
  if (i === 0) return state.calib.board;
  if (i <= 3) return state.calib.slots[i - 1];
  if (i >= 4 + COUNTER_KEYS.length) return state.calib.numbers[NUMBER_KEYS[i - 4 - COUNTER_KEYS.length]];
  return state.calib.counters[COUNTER_KEYS[i - 4]];
}
function setRect(i: number, r: Rect) {
  // 영역을 지정한 공유 화면 크기를 함께 기억한다 (나중에 크기가 바뀌면 비율대로 맞춤)
  if (preview.width && preview.height) state.calib.frame = { w: preview.width, h: preview.height };
  if (i === 0) state.calib.board = r;
  else if (i <= 3) state.calib.slots[i - 1] = r;
  else if (i >= 4 + COUNTER_KEYS.length) state.calib.numbers[NUMBER_KEYS[i - 4 - COUNTER_KEYS.length]] = r;
  else state.calib.counters[COUNTER_KEYS[i - 4]] = r;
  saveCalib();
}

function openCalib() {
  $('calibPanel').hidden = false;
  renderCalibHead();
}

function renderCalibHead() {
  const t = $('calibTargets');
  t.innerHTML = '';
  TARGETS.forEach((name, i) => {
    const b = document.createElement('button');
    b.textContent = (getRect(i) ? '✓ ' : '') + name;
    if (i === calibTarget) b.classList.add('active');
    b.onclick = () => {
      calibTarget = i;
      renderCalibHead();
    };
    t.appendChild(b);
  });
  $('calibMsg').textContent = TARGET_HELP[calibTarget];
  const inputs = $('rectInputs');
  inputs.innerHTML = '';
  const r = getRect(calibTarget);
  if (!r) return;
  for (const k of ['x', 'y', 'w', 'h'] as const) {
    const lab = document.createElement('label');
    lab.textContent = k;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.value = String(Math.round(r[k] * 10) / 10);
    inp.step = '0.5';
    inp.oninput = () => {
      const cur = getRect(calibTarget);
      if (!cur) return;
      setRect(calibTarget, { ...cur, [k]: Number(inp.value) });
      appliedSig = '';
    };
    lab.appendChild(inp);
    inputs.appendChild(lab);
  }
}

function drawPreview(frame: Frame & { image: CanvasImageSource }) {
  if (preview.width !== frame.width || preview.height !== frame.height) {
    preview.width = frame.width;
    preview.height = frame.height;
  }
  pctx.drawImage(frame.image, 0, 0);
  const lw = Math.max(1, frame.width / 600);
  TARGETS.forEach((name, i) => {
    const r = getRect(i);
    if (!r) return;
    pctx.strokeStyle = i === calibTarget ? '#ff3b6b' : '#ffd43b';
    pctx.lineWidth = lw * 2;
    pctx.strokeRect(r.x, r.y, r.w, r.h);
    if (i === 0) {
      pctx.lineWidth = lw * 0.7;
      for (let c = 1; c < W; c++) {
        pctx.beginPath();
        pctx.moveTo(r.x + (r.w * c) / W, r.y);
        pctx.lineTo(r.x + (r.w * c) / W, r.y + r.h);
        pctx.stroke();
      }
      for (let k = 1; k < H; k++) {
        pctx.beginPath();
        pctx.moveTo(r.x, r.y + (r.h * k) / H);
        pctx.lineTo(r.x + r.w, r.y + (r.h * k) / H);
        pctx.stroke();
      }
    }
    pctx.fillStyle = pctx.strokeStyle;
    pctx.font = `${12 * lw}px sans-serif`;
    pctx.fillText(name, r.x + 2, r.y - 4 * lw);
  });
  // 보드 칸마다 인식 결과 표시: 채움=블록 색 점, 빈칸=작은 원, 아이템=글자
  const br = state.calib.board;
  if (br) {
    const read = readBoard(frame, br);
    const pw = br.w / W;
    const ph = br.h / H;
    const rad = Math.max(2, Math.min(pw, ph) * 0.18);
    const dotColor: Record<string, string> = { blue: '#1c7ed6', pink: '#d6336c', yellow: '#f08c00', green: '#2b8a3e', purple: '#7048e8' };
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++) {
        const cx = br.x + (c + 0.5) * pw;
        const cy = br.y + (r + 0.5) * ph;
        const filled = ((read.rows[r] >> c) & 1) === 1;
        pctx.beginPath();
        pctx.arc(cx, cy, rad, 0, Math.PI * 2);
        pctx.lineWidth = Math.max(1, rad * 0.4);
        pctx.strokeStyle = '#fff';
        if (filled) {
          pctx.fillStyle = dotColor[read.colors[r][c] ?? ''] ?? '#495057';
          pctx.fill();
        }
        pctx.stroke();
        const it = read.items.find((x) => x.r === r && x.c === c);
        if (it) {
          pctx.fillStyle = '#fff';
          pctx.font = `bold ${Math.round(ph * 0.45)}px sans-serif`;
          pctx.fillText(it.type === 'dot' ? '⊙' : '⇄', cx + rad, cy - rad);
        }
      }
  }
  if (drag) {
    pctx.strokeStyle = '#ff3b6b';
    pctx.setLineDash([6, 4]);
    pctx.strokeRect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0);
    pctx.setLineDash([]);
  }
}

function toFrame(e: MouseEvent) {
  const b = preview.getBoundingClientRect();
  return {
    x: ((e.clientX - b.left) / b.width) * preview.width,
    y: ((e.clientY - b.top) / b.height) * preview.height,
  };
}
preview.addEventListener('mousedown', (e) => {
  const p = toFrame(e);
  drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const p = toFrame(e);
  drag.x1 = p.x;
  drag.y1 = p.y;
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  const r: Rect = {
    x: Math.min(drag.x0, drag.x1),
    y: Math.min(drag.y0, drag.y1),
    w: Math.abs(drag.x1 - drag.x0),
    h: Math.abs(drag.y1 - drag.y0),
  };
  drag = null;
  if (r.w < 4 || r.h < 4) return;
  setRect(calibTarget, calibTarget === 0 ? snapToGrid(r) : r);
  appliedSig = '';
  calibTarget = Math.min(calibTarget + 1, TARGETS.length - 1);
  renderCalibHead();
});

/** 보드 영역을 실제 격자선에 맞춘다. 맞춤이 더 나쁘면 원래 영역 그대로 */
function snapToGrid(r: Rect): Rect {
  if (!lastFrame) return r;
  const res = snapBoardRect(lastFrame, r);
  if (res.after <= res.before) return r;
  const d = (a: number, b: number) => (a - b >= 0 ? '+' : '') + (a - b).toFixed(1);
  addLog(`보드 영역을 격자에 자동으로 맞췄습니다 (x ${d(res.rect.x, r.x)}, y ${d(res.rect.y, r.y)}, 너비 ${d(res.rect.w, r.w)}, 높이 ${d(res.rect.h, r.h)})`);
  return res.rect;
}

$('btnSnap').onclick = () => {
  const r = state.calib.board;
  if (!r) {
    addLog('먼저 보드 영역을 드래그해 지정하세요');
    return;
  }
  setRect(0, snapToGrid(r));
  resetRecognition();
  renderCalibHead();
};

$('btnCalib').onclick = () => {
  if ($('calibPanel').hidden) openCalib();
  else $('calibPanel').hidden = true;
};
$('btnCalibDone').onclick = () => {
  $('calibPanel').hidden = true;
  appliedSig = '';
};

renderAll();
renderLog();
if (oldDigitsDropped) addLog('숫자 인식 방식이 바뀌어 예전에 학습한 숫자를 지웠습니다. 처음 보는 숫자가 나오면 다시 알려주세요.');

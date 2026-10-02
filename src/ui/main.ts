import '../style.css';
import {
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
import type { SolveRequest, SolveResponse } from '../core/solver.worker';
import { ScreenCapture } from '../capture/capture';
import {
  DEFAULT_DIGITS,
  matchDigit,
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
  /** 화면에서 읽은 블록 색 (blue / pink / yellow / green), 수동 입력이면 null */
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
  /** 보유 능력 버튼의 숫자 영역 (선택) */
  counters: Record<ItemKey, Rect | null>;
  /** 영역을 지정할 때의 공유 화면 크기 */
  frame?: { w: number; h: number };
}

type ItemKey = 'dot' | 'swap';
const ITEM_KEYS: ItemKey[] = ['dot', 'swap'];

const CALIB_KEY = 'moamoa.calib.v1';
const DIGITS_KEY = 'moamoa.digits.v2';
/** 숫자 인식 방식이 바뀌기 전의 학습 데이터 (호환 안 됨) */
const OLD_DIGITS_KEY = 'moamoa.digits.v1';
let oldDigitsDropped = false;
const EFFORT = {
  fast: { beam: 60, finalists: 30 },
  normal: { beam: 150, finalists: 60 },
  deep: { beam: 400, finalists: 150 },
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
  view: 'all' as 'all' | number,
  log: [] as string[],
  digits: loadDigits(),
  /** 화면에서 개수를 읽고 있는가 */
  countFromScreen: { dot: false, swap: false } as Record<ItemKey, boolean>,
  /** 처음 보는 숫자 모양 → 사용자에게 값을 물어본다 */
  digitPrompt: { dot: null, swap: null } as Record<ItemKey, { sig: DigitSig; url: string } | null>,
};

function loadCalib(): Calib {
  try {
    const raw = localStorage.getItem(CALIB_KEY);
    if (raw) return { counters: { dot: null, swap: null }, ...(JSON.parse(raw) as Partial<Calib>) } as Calib;
  } catch {
    /* 저장소 사용 불가 */
  }
  return { board: null, slots: [null, null, null], counters: { dot: null, swap: null } };
}

function loadDigits(): DigitTemplates {
  const out: DigitTemplates = structuredClone(DEFAULT_DIGITS);
  try {
    if (localStorage.getItem(OLD_DIGITS_KEY)) {
      localStorage.removeItem(OLD_DIGITS_KEY);
      oldDigitsDropped = true;
    }
    const raw = localStorage.getItem(DIGITS_KEY);
    if (raw) for (const [d, sigs] of Object.entries(JSON.parse(raw) as DigitTemplates)) out[d] = [...new Set([...(out[d] ?? []), ...sigs])];
  } catch {
    /* 저장소 사용 불가 */
  }
  return out;
}

function learnDigit(sig: DigitSig, value: number) {
  const list = (state.digits[value] ??= []);
  if (!list.includes(sig)) list.push(sig);
  try {
    localStorage.setItem(DIGITS_KEY, JSON.stringify(state.digits));
  } catch {
    /* 무시 */
  }
}

/** 학습한 숫자를 지우고 기본 템플릿(0)만 남긴다 */
function resetDigits() {
  state.digits = structuredClone(DEFAULT_DIGITS);
  try {
    localStorage.removeItem(DIGITS_KEY);
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

/** 게임에서 조각을 선택(노란 카드)한 동안 화면 반영·계산을 멈춘 상태 */
let selectionPaused = false;
let statusBeforeSelection: { text: string; kind: string } | null = null;

function setStatus(msg: string, kind: 'idle' | 'busy' | 'ok' | 'warn' = 'idle') {
  // 조각 선택 중에는 '선택 중' 표시를 유지하고, 다른 상태는 선택이 끝난 뒤 보여준다
  if (selectionPaused && !msg.startsWith('✋')) {
    statusBeforeSelection = { text: msg, kind };
    return;
  }
  const el = $('status');
  el.textContent = msg;
  el.dataset.kind = kind;
}

// ───────────── 탐색 (Web Worker) ─────────────

const worker = new Worker(new URL('../core/solver.worker.ts', import.meta.url), { type: 'module' });
let reqId = 0;

let lockAfterSolve = false;

function requestSolve(fromScreen = false) {
  lockAfterSolve = fromScreen && state.lockEnabled;
  state.locked = false;
  const effort = EFFORT[($('effort') as HTMLSelectElement).value as keyof typeof EFFORT];
  const input: SolveInput = {
    // 꽉 찬 줄은 게임에서 바로 지워지므로 빈 줄로 넘긴다
    rows: withoutFullRows(state.rows),
    hand: state.hand.map((s) => (s.used ? null : s.type)),
    items: state.items.slice(),
    inventory: { ...state.inventory },
    weights: DEFAULT_WEIGHTS,
    maxDots: 2,
    ...effort,
  };
  state.swaps = null;
  if (input.hand.every((h) => h === null)) {
    state.plan = null;
    renderAll();
    setStatus('보유 조각 없음', 'idle');
    return;
  }
  setStatus('계산 중…', 'busy');
  worker.postMessage({ id: ++reqId, input } satisfies SolveRequest);
}

worker.onmessage = (e: MessageEvent<SolveResponse>) => {
  const res = e.data;
  if (res.id !== reqId) return;
  if (res.kind === 'plan') {
    state.plan = res.plan;
    state.solveMs = res.ms;
    state.view = 'all';
    state.locked = lockAfterSolve && !!res.plan;
    newDrops.clear();
    if (state.locked) setStatus(`🔒 추천 고정 (${res.ms.toFixed(0)}ms) · 다음 블록을 받으면 다시 계산`, 'ok');
    else setStatus(`계산 완료 (${res.ms.toFixed(0)}ms)`, res.plan?.complete === false ? 'warn' : 'ok');
  } else {
    state.swaps = res.swaps;
  }
  renderAll();
};

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
function boardsBeforeMoves(plan: Plan): Rows[] {
  const out: Rows[] = [];
  let rows = state.rows;
  for (const m of plan.moves) {
    out.push(rows);
    rows =
      m.kind === 'dot'
        ? placeDot(rows, m.r, m.c).rows
        : place(rows, PIECES[m.type].orientations[m.orient], m.r, m.c).rows;
  }
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

function renderBoard() {
  const plan = state.plan;
  const before = plan ? boardsBeforeMoves(plan) : [];
  const base = plan && typeof state.view === 'number' ? before[state.view] : state.rows;
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
      const item = state.items.find((it) => it.r === r && it.c === c);
      const color = state.colors[r]?.[c] ?? 'gray';
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
  mk('전체', 'all');
  plan.moves.forEach((_, i) => mk(`${i + 1}단계`, i));
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
  if (!plan) {
    ol.innerHTML = '<li class="muted">보유 조각을 입력하거나 화면 공유를 시작하세요.</li>';
    return;
  }
  plan.moves.forEach((m, i) => {
    const li = document.createElement('li');
    li.className = `move ${state.view === i ? 'active' : ''}`;
    li.onmouseenter = () => {
      state.view = i;
      renderBoard();
    };
    li.onclick = () => {
      state.view = i;
      renderBoard();
      renderMoves();
    };
    const badge = document.createElement('span');
    badge.className = `badge ${moveColorClass(m, i)} ${moveNumberClass(m)}`;
    badge.textContent = String(i + 1);
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
      body.innerHTML += `<br/><span class="clear">✦ ${m.cleared.length}줄 제거${
        gained.length ? ` · 아이템 ${gained.length}개 획득` : ''
      }</span>`;
    }
    li.insertBefore(body, li.children[1] ?? null);
    ol.appendChild(li);
  });

  const lines: string[] = [];
  if (!plan.complete) lines.push('<p class="warn">⚠ 이 손패로는 모든 조각을 놓을 수 없습니다.</p>');
  lines.push(
    `<p class="muted">줄 제거 ${plan.lines} · 아이템 획득 ${plan.itemsGained.length} · 평가 ${plan.score.toFixed(1)} · ${state.solveMs.toFixed(0)}ms</p>`,
  );
  verdict.innerHTML = lines.join('');
}

function renderHand() {
  const wrap = $('hand');
  wrap.innerHTML = '';
  state.hand.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = `slot ${s.used ? 'used' : ''}`;
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
      requestSolve();
    };
    const n = document.createElement('b');
    n.textContent = String(state.inventory[key]);
    const plus = document.createElement('button');
    plus.textContent = '+';
    plus.disabled = total >= INVENTORY_CAP;
    plus.onclick = () => {
      state.inventory[key]++;
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
          learnDigit(prompt.sig, v);
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
  const cap = document.createElement('div');
  cap.className = 'muted';
  cap.textContent = `보유 ${total}/${INVENTORY_CAP} · 보드 위 아이템 ${state.items.length}개`;
  wrap.appendChild(cap);

  // 숫자 학습 현황 + 초기화 (개수 영역을 지정했거나 학습한 숫자가 있을 때만)
  const learned = Object.keys(state.digits)
    .filter((d) => state.digits[d].some((sig) => !DEFAULT_DIGITS[d]?.includes(sig)))
    .sort();
  if (learned.length || ITEM_KEYS.some((k) => state.calib.counters[k])) {
    const row = document.createElement('div');
    row.className = 'digit-learned';
    const text = document.createElement('span');
    text.className = 'muted';
    text.textContent = `학습한 숫자: ${learned.length ? learned.join(', ') : '없음'} (0은 기본 내장)`;
    const reset = document.createElement('button');
    reset.textContent = '숫자 학습 초기화';
    reset.disabled = learned.length === 0;
    reset.onclick = () => {
      if (confirm('학습한 숫자를 모두 지울까요? 기본 내장된 0만 남습니다.')) resetDigits();
    };
    row.append(text, reset);
    wrap.appendChild(row);
  }
}

function renderSwapAdvice() {
  const el = $('swapAdvice');
  el.innerHTML = '';
  if (state.inventory.swap <= 0 || !state.plan) return;
  if (!state.swaps) {
    el.innerHTML = '<p class="muted">바꿔 뽑기 분석 중…</p>';
    return;
  }
  const top = state.swaps[0];
  if (!top) return;
  const recommend = !state.plan.complete || top.gain >= DEFAULT_WEIGHTS.swapCost;
  el.innerHTML = recommend
    ? `<p class="go">⇄ <b>바꿔 뽑기 추천: ${top.slot + 1}번 조각 (${top.type})</b><br/>
       <span class="muted">기대 이득 +${top.gain.toFixed(1)} · 교체 후 전부 놓을 확률 ${(top.completeRate * 100).toFixed(0)}%</span></p>`
    : `<p class="muted">바꿔 뽑기는 아껴두세요 (최대 기대 이득 ${top.gain.toFixed(1)}: ${top.slot + 1}번 ${top.type})</p>`;
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
const countSmoothers: Record<ItemKey, CountSmoother> = { dot: new CountSmoother(), swap: new CountSmoother() };
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

  const slots = state.calib.slots.map((r) => readHandSlot(frame, r!));
  // 게임에서 조각을 클릭해 선택(노란 카드)한 동안에는 화면을 반영하지도, 계산하지도 않는다.
  // (조각을 끌고 다니는 중의 보드 변화도 무시) 선택이 끝나면 그때 화면부터 다시 반영한다.
  if (slots.some((s) => s.selected)) {
    enterSelectionPause();
    recordFrame(frame, now, { selected: true, hand: slots });
    return;
  }
  leaveSelectionPause();

  const b = readBoard(frame, state.calib.board!);
  const rawRows = b.rows;
  // 칸 상태는 일정 시간 같은 상태가 이어질 때만 바꾼다 (순간적인 오인식·아이콘 빛·애니메이션 거르기)
  b.rows = boardFilter.update(rawRows, now);
  // 채워져 있는데 색을 못 읽은 칸(빛에 가려 유지된 칸 등)은 직전 색을 쓴다
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++)
      if ((b.rows[r] >> c) & 1) {
        if (b.colors[r][c]) lastColors[r][c] = b.colors[r][c];
        else b.colors[r][c] = lastColors[r][c];
      } else lastColors[r][c] = null;
  // 1초 이상 같은 자리에 보인 아이템만 인정 (줄 제거 번쩍임 등 걸러냄)
  const items = itemConfirmer.update(b.items, now);
  // 보유 능력 숫자: 같은 값이 0.6초 이어져야 바꾸고, 안 보이면 마지막 값 유지
  const countReads = readCounters(frame);
  const counts = {
    dot: countSmoothers.dot.update(countReads.dot, now),
    swap: countSmoothers.swap.update(countReads.swap, now),
  };
  recordFrame(frame, now, { selected: false, hand: slots, raw: rawRows, rows: b.rows, items });
  const sig =
    b.rows.join(',') +
    '|' +
    items.map((it) => `${it.r}.${it.c}.${it.type}`).join(',') +
    '|' +
    slots.map((s) => (s.used ? 'U' : `${s.type ?? '?'}${s.orient}`)).join(',') +
    '|' +
    ITEM_KEYS.map((k) => `${counts[k].value ?? '-'}${counts[k].unknownSig ? '?' : ''}`).join(',');
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
  // 계산으로 이어지는 변화(새 블록을 받음 / 고정 안 됨)라면 화면이 충분히 안정될 때까지 기다린다.
  // 마지막 블록을 놓는 순간에는 줄 제거 이펙트와 새 블록이 함께 나타나기 때문이다.
  if ((!state.locked || newBlocks) && (now - sigSince < SETTLE_MS || boardFilter.pending)) {
    setStatus('⏳ 화면이 안정되길 기다리는 중…', 'busy');
    return;
  }
  appliedSig = sig;

  const res = track(prevSnap, snap, live.items, state.inventory);
  prevSnap = snap;
  res.events.forEach(addLog);
  if (slots.some((s) => s.unknown)) addLog('인식할 수 없는 조각이 있습니다 (영역을 확인하세요)');

  live.rows = b.rows;
  live.colors = b.colors;
  live.items = res.items;
  live.hand = slots.map((s) => ({ type: s.type, orient: s.orient, used: s.used, color: s.color }));
  state.inventory = res.inventory;
  // 화면에서 읽은 개수가 있으면 추적값보다 우선한다
  for (const k of ITEM_KEYS) {
    const c = counts[k];
    state.countFromScreen[k] = c.value != null;
    if (c.value != null) {
      state.inventory[k] = c.value;
      state.digitPrompt[k] = null;
    }
    if (c.unknownSig) state.digitPrompt[k] = { sig: c.unknownSig, url: cropUrl(frame, state.calib.counters[k]!) };
  }

  // 추천 고정 중: 블록을 옮기는 동안에는 화면을 바꾸지 않는다 (보유 능력 개수만 갱신)
  if (state.locked && !newBlocks) {
    renderInventory();
    return;
  }
  applyLive();
  requestSolve(true);
}

/** 보유 능력 숫자 읽기. 영역이 없거나 숫자가 안 보이면 null, 모르는 모양이면 value=null */
function readCounters(frame: Frame): Record<ItemKey, { sig: DigitSig; value: number | null } | null> {
  const out = { dot: null, swap: null } as Record<ItemKey, { sig: DigitSig; value: number | null } | null>;
  for (const k of ITEM_KEYS) {
    const rect = state.calib.counters[k];
    if (!rect) continue;
    const sig = readDigitSig(frame, rect);
    if (sig) out[k] = { sig, value: matchDigit(sig, state.digits) };
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


function enterSelectionPause() {
  if (selectionPaused) return;
  selectionPaused = true;
  const el = $('status');
  statusBeforeSelection = { text: el.textContent ?? '', kind: el.dataset.kind ?? 'idle' };
  setStatus('✋ 조각 선택 중 · 계산 멈춤', 'idle');
}

function leaveSelectionPause() {
  if (!selectionPaused) return;
  selectionPaused = false;
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
  dropsPrimed = false;
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
    c.counters = { dot: scale(c.counters.dot), swap: scale(c.counters.swap) };
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
  const rects = [state.calib.board, ...state.calib.slots, state.calib.counters.dot, state.calib.counters.swap].filter(
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
      locked: state.locked,
      plan: state.plan ? { complete: state.plan.complete, moves: state.plan.moves } : null,
    },
    log: state.log,
    frames,
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  a.download = `moamoa-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  addLog(`화면 저장: 최근 ${frames.length}장 (${a.download})`);
}

setInterval(tick, 250);

// ───────────── 능력 드롭 확인 (1초마다) ─────────────

const itemKey = (it: Item) => `${it.r},${it.c},${it.type}`;
/** 새로 떨어진 아이템 → 처음 본 시각 (보드에서 깜빡임 표시) */
const newDrops = new Map<string, number>();
const NEW_DROP_MS = 5000;
let knownItems = new Set<string>();
let dropsPrimed = false;
/** 이 시각까지 보인 아이템은 원래 있던 것으로 본다 (아이템 인정에 1초가 걸리므로 여유를 둔다) */
let dropsBaselineUntil = 0;
const DROP_BASELINE_MS = 2500;

function checkDrops() {
  if (!source || !calibReady() || state.paused) return;
  const now = performance.now();
  const cur = new Set(live.items.map(itemKey));
  if (!dropsPrimed) {
    dropsPrimed = true;
    dropsBaselineUntil = now + DROP_BASELINE_MS;
  }
  if (now < dropsBaselineUntil) {
    // 화면 공유를 시작했을 때 이미 있던 아이템은 '드롭'으로 보지 않는다
    knownItems = cur;
    return;
  }
  let changed = false;
  for (const it of live.items) {
    if (knownItems.has(itemKey(it))) continue;
    newDrops.set(itemKey(it), now);
    addLog(`${it.type === 'dot' ? '⊙ 점 찍기' : '⇄ 바꿔 뽑기'} 드롭: ${it.r + 1}행 ${it.c + 1}열`);
    changed = true;
  }
  knownItems = cur;
  for (const [k, t] of newDrops)
    if (now - t > NEW_DROP_MS) {
      newDrops.delete(k);
      changed = true;
    }
  // 추천 고정 중: 블록·추천은 그대로 두고 보드의 아이템 표시만 갱신한다
  if (state.locked) {
    const shown = new Set(state.items.map(itemKey));
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

const TARGETS = ['보드', '조각 1', '조각 2', '조각 3', '점 찍기 개수', '바꿔 뽑기 개수'] as const;
const TARGET_HELP = [
  '보드 격자(10×16)를 대략 드래그하면 격자선에 자동으로 맞춥니다. 칸마다 찍힌 점이 각 칸 가운데에 오는지 확인하세요.',
  '1번 보유 조각의 흰 영역(블록 그림만, 글자·버튼 제외)을 드래그하세요.',
  '2번 보유 조각의 흰 영역을 드래그하세요.',
  '3번 보유 조각의 흰 영역을 드래그하세요.',
  '(선택) 점 찍기 버튼 오른쪽 숫자 동그라미를 드래그하세요.',
  '(선택) 바꿔 뽑기 버튼 오른쪽 숫자 동그라미를 드래그하세요.',
];
let calibTarget = 0;
const preview = $<HTMLCanvasElement>('preview');
const pctx = preview.getContext('2d')!;
let drag: { x0: number; y0: number; x1: number; y1: number } | null = null;

function getRect(i: number): Rect | null {
  if (i === 0) return state.calib.board;
  if (i <= 3) return state.calib.slots[i - 1];
  return state.calib.counters[ITEM_KEYS[i - 4]];
}
function setRect(i: number, r: Rect) {
  // 영역을 지정한 공유 화면 크기를 함께 기억한다 (나중에 크기가 바뀌면 비율대로 맞춤)
  if (preview.width && preview.height) state.calib.frame = { w: preview.width, h: preview.height };
  if (i === 0) state.calib.board = r;
  else if (i <= 3) state.calib.slots[i - 1] = r;
  else state.calib.counters[ITEM_KEYS[i - 4]] = r;
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
    const dotColor: Record<string, string> = { blue: '#1c7ed6', pink: '#d6336c', yellow: '#f08c00', green: '#2b8a3e' };
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

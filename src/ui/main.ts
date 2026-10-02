import '../style.css';
import {
  H,
  INVENTORY_CAP,
  W,
  emptyRows,
  place,
  placeDot,
  type Inventory,
  type Item,
  type Rows,
} from '../core/board';
import { PIECES, PIECE_TYPES, transformSteps, type Orientation, type PieceType } from '../core/pieces';
import { DEFAULT_WEIGHTS } from '../core/eval';
import type { Move, Plan, SolveInput, SwapAdvice } from '../core/search';
import type { SolveRequest, SolveResponse } from '../core/solver.worker';
import { ScreenCapture } from '../capture/capture';
import { readBoard, readHandSlot, type Frame, type Rect } from '../capture/recognize';
import { track, type Snapshot } from '../capture/tracker';

// ───────────── 상태 ─────────────

interface Slot {
  type: PieceType | null;
  /** 화면에 보이는 방향 (-1 = 모름) */
  orient: number;
  used: boolean;
}

interface Calib {
  board: Rect | null;
  slots: (Rect | null)[];
}

const CALIB_KEY = 'moamoa.calib.v1';
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
  plan: null as Plan | null,
  swaps: null as SwapAdvice[] | null,
  solveMs: 0,
  view: 'all' as 'all' | number,
  log: [] as string[],
};

function loadCalib(): Calib {
  try {
    const raw = localStorage.getItem(CALIB_KEY);
    if (raw) return JSON.parse(raw) as Calib;
  } catch {
    /* 저장소 사용 불가 */
  }
  return { board: null, slots: [null, null, null] };
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

function setStatus(msg: string, kind: 'idle' | 'busy' | 'ok' | 'warn' = 'idle') {
  const el = $('status');
  el.textContent = msg;
  el.dataset.kind = kind;
}

// ───────────── 탐색 (Web Worker) ─────────────

const worker = new Worker(new URL('../core/solver.worker.ts', import.meta.url), { type: 'module' });
let reqId = 0;

function requestSolve() {
  const effort = EFFORT[($('effort') as HTMLSelectElement).value as keyof typeof EFFORT];
  const input: SolveInput = {
    rows: state.rows.slice(),
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
    setStatus(`계산 완료 (${res.ms.toFixed(0)}ms)`, res.plan?.complete === false ? 'warn' : 'ok');
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
        el.classList.add('ghost', plan!.moves[g].kind === 'dot' ? 'ghost-dot' : `ghost-${g % 4}`);
        el.textContent = String(g + 1);
      } else if (item) {
        el.textContent = item.type === 'swap' ? '⇄' : '⊙';
        el.classList.add('item');
      }
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
    badge.className = `badge ${m.kind === 'dot' ? 'ghost-dot' : `ghost-${i % 4}`}`;
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
      li.appendChild(shapeEl(target, `ghost-${i % 4}`));
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
    title.className = 'slot-title';
    title.textContent = `${i + 1}번`;
    card.appendChild(title);
    if (s.type && !s.used) {
      const o = PIECES[s.type].orientations[Math.max(0, s.orient)];
      card.appendChild(shapeEl(o, 'plain'));
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
    wrap.appendChild(row);
  }
  const cap = document.createElement('div');
  cap.className = 'muted';
  cap.textContent = `보유 ${total}/${INVENTORY_CAP} · 보드 위 아이템 ${state.items.length}개`;
  wrap.appendChild(cap);
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
let lastSig = '';
let stable = 0;
let appliedSig = '';

function calibReady() {
  return !!state.calib.board && state.calib.slots.every(Boolean);
}

function tick() {
  if (!source) return;
  const frame = source.grab();
  if (!frame) return;
  if (!$('calibPanel').hidden) drawPreview(frame);
  if (!calibReady() || state.paused) return;

  const b = readBoard(frame, state.calib.board!);
  const slots = state.calib.slots.map((r) => readHandSlot(frame, r!));
  const sig =
    b.rows.join(',') +
    '|' +
    b.items.map((it) => `${it.r}.${it.c}.${it.type}`).join(',') +
    '|' +
    slots.map((s) => (s.used ? 'U' : `${s.type ?? '?'}${s.orient}`)).join(',');
  if (sig === lastSig) stable++;
  else {
    lastSig = sig;
    stable = 0;
  }
  // 애니메이션 중 오인식을 피하려고 같은 결과가 연속 2번 나와야 반영
  if (stable < 1 || sig === appliedSig) return;
  appliedSig = sig;

  const snap: Snapshot = {
    rows: b.rows,
    items: b.items,
    hand: slots.map((s) => ({ type: s.type, used: s.used })),
  };
  const res = track(prevSnap, snap, state.items, state.inventory);
  prevSnap = snap;
  res.events.forEach(addLog);
  if (slots.some((s) => s.unknown)) addLog('인식할 수 없는 조각이 있습니다 (영역을 확인하세요)');

  state.rows = b.rows;
  state.colors = b.colors;
  state.items = res.items;
  state.inventory = res.inventory;
  state.hand = slots.map((s) => ({ type: s.type, orient: s.orient, used: s.used }));
  requestSolve();
}

setInterval(tick, 250);

$('btnCapture').onclick = async () => {
  if (capture.active) {
    capture.stop();
    return;
  }
  try {
    await capture.start();
    source = capture;
    prevSnap = null;
    appliedSig = '';
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
  prevSnap = null;
  appliedSig = '';
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
  prevSnap = null;
  appliedSig = '';
  requestSolve();
};

$('effort').onchange = () => requestSolve();

// ───────────── 영역 지정 ─────────────

const TARGETS = ['보드', '조각 1', '조각 2', '조각 3'] as const;
const TARGET_HELP = [
  '보드 격자(10×16)의 바깥 테두리에 딱 맞게 드래그하세요.',
  '1번 보유 조각의 흰 영역(블록 그림만, 글자·버튼 제외)을 드래그하세요.',
  '2번 보유 조각의 흰 영역을 드래그하세요.',
  '3번 보유 조각의 흰 영역을 드래그하세요.',
];
let calibTarget = 0;
const preview = $<HTMLCanvasElement>('preview');
const pctx = preview.getContext('2d')!;
let drag: { x0: number; y0: number; x1: number; y1: number } | null = null;

function getRect(i: number): Rect | null {
  return i === 0 ? state.calib.board : state.calib.slots[i - 1];
}
function setRect(i: number, r: Rect) {
  if (i === 0) state.calib.board = r;
  else state.calib.slots[i - 1] = r;
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
  setRect(calibTarget, r);
  appliedSig = '';
  calibTarget = Math.min(calibTarget + 1, TARGETS.length - 1);
  renderCalibHead();
});

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

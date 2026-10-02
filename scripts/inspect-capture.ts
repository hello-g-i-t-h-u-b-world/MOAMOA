// '화면 저장'으로 받은 파일 분석:  npx tsx scripts/inspect-capture.ts <파일.json> [출력폴더]
// 저장된 각 화면을 PNG로 풀고, 지금 코드로 다시 인식해 저장 당시 결과와 비교한다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { readBoard, readHandSlot, type Rect } from '../src/capture/recognize';
import { rowsToStrings } from '../src/core/board';

const [file, outDir = 'capture-out'] = process.argv.slice(2);
if (!file) {
  console.error('사용법: npx tsx scripts/inspect-capture.ts <파일.json> [출력폴더]');
  process.exit(1);
}
const data = JSON.parse(readFileSync(file, 'utf8'));
mkdirSync(outDir, { recursive: true });
console.log(`저장 시각 ${data.savedAt}, 화면 ${data.frames.length}장, 영역 지정 화면 크기 ${JSON.stringify(data.calib.frame)}`);
console.log('현재 상태:', JSON.stringify(data.state.hand.map((h: { type: string; used: boolean }) => (h.used ? '사용' : h.type))), '고정:', data.state.locked);
console.log(data.state.rows.join('\n'));

const shift = (r: Rect | null, a: Rect): Rect | null => (r ? { ...r, x: r.x - a.x, y: r.y - a.y } : null);
data.frames.forEach((fr: any, i: number) => {
  const buf = Buffer.from(fr.png.split(',')[1], 'base64');
  const name = `${String(i).padStart(2, '0')}-${fr.time.slice(11, 23).replace(/:/g, '')}.png`;
  writeFileSync(join(outDir, name), buf);
  const png = PNG.sync.read(buf);
  const f = { data: png.data, width: png.width, height: png.height };
  const board = shift(data.calib.board, fr.area)!;
  const now = rowsToStrings(readBoard(f, board).rows);
  const hand = data.calib.slots.map((r: Rect) => readHandSlot(f, shift(r, fr.area)!));
  console.log(`\n[${i}] ${fr.time} ${fr.selected ? '(조각 선택 중)' : ''} → ${name}`);
  console.log('  손패(저장 당시):', fr.hand.map((h: any) => (h.used ? '사용' : `${h.type ?? '?'}${h.selected ? '*' : ''}`)).join(' '));
  console.log('  손패(지금 코드):', hand.map((h: any) => (h.used ? '사용' : `${h.type ?? '?'}${h.selected ? '*' : ''}`)).join(' '));
  if (fr.rows) {
    for (let r = 0; r < 16; r++) {
      const mark = fr.rawRows[r] !== fr.rows[r] ? ' ← 필터 보정' : now[r] !== fr.rawRows[r] ? ' ← 지금 코드와 다름' : '';
      console.log(`  ${String(r + 1).padStart(2)}행 ${fr.rawRows[r]}  확정 ${fr.rows[r]}${mark}`);
    }
  }
});

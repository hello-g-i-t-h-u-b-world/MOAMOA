// 사용자들이 보내준 숫자 학습 데이터를 검사해 기본 내장값(src/capture/digits.json)에 합친다.
//   npx tsx scripts/merge-digits.ts 받은파일1.json [받은파일2.json ...]          # 검사만
//   npx tsx scripts/merge-digits.ts --write 받은파일1.json [...]                 # 검사 후 저장
// '학습 데이터 내보내기' 파일과 '화면 저장' 파일 모두 받을 수 있다.
import { readFileSync, writeFileSync } from 'node:fs';
import { mergeDigits } from '../src/capture/digit-data';
import type { DigitTemplates } from '../src/capture/recognize';

const args = process.argv.slice(2);
const write = args.includes('--write');
const files = args.filter((a) => a !== '--write');
if (!files.length) {
  console.error('사용법: npx tsx scripts/merge-digits.ts [--write] <파일.json> ...');
  process.exit(1);
}
// 보유 능력 개수 숫자와 '다음 능력 획득까지' 숫자는 글꼴이 달라 따로 저장한다
const SETS = [
  { field: 'digits', path: 'src/capture/digits.json', name: '보유 능력 개수' },
  { field: 'dropDigits', path: 'src/capture/drop-digits.json', name: '다음 능력 획득까지' },
] as const;
for (const set of SETS) {
  let current: DigitTemplates = JSON.parse(readFileSync(set.path, 'utf8'));
  let total = 0;
  console.log(`\n━━ ${set.name} (${set.path})`);
  for (const f of files) {
    const data = JSON.parse(readFileSync(f, 'utf8'));
    const incoming: DigitTemplates = data[set.field] ?? {};
    if (!Object.keys(incoming).length) continue;
    const { merged, report } = mergeDigits(current, incoming);
    current = merged;
    total += report.added.length;
    console.log(`\n■ ${f}`);
    console.log(`  추가 ${report.added.length}개: ${report.added.map((a) => a.digit).join(', ') || '-'}`);
    console.log(`  이미 있음 ${report.duplicates}개`);
    for (const c of report.conflicts) console.log(`  ⚠ 제외: '${c.digit}'로 답했지만 기존 '${c.looksLike}'와 거의 같음 (${c.dist}칸 차이) → 잘못 답했을 수 있음`);
    for (const i of report.invalid) console.log(`  ✗ 형식 오류: ${i}`);
  }
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => Number(a) - Number(b)));
  console.log(`\n합계: ${total}개 추가 · 숫자별 모양 수 ${Object.entries(sorted).map(([d, s]) => `${d}:${s.length}`).join(' ') || '-'}`);
  if (write && total) {
    writeFileSync(set.path, JSON.stringify(sorted, null, 2) + '\n');
    console.log(`${set.path} 저장 완료 → 커밋하면 모든 사용자에게 적용됩니다`);
  } else if (total) console.log('(검사만 했습니다. 반영하려면 --write)');
}

// 받은 조각 통계 (단계 → 조각 → 횟수): 공개되지 않은 등장 확률을 추정하는 데 쓴다 → src/core/piece-stats.json에 더한다
const STATS_PATH = 'src/core/piece-stats.json';
const stats: Record<string, Record<string, number>> = JSON.parse(readFileSync(STATS_PATH, 'utf8'));
let statTotal = 0;
for (const f of files) {
  const incoming = JSON.parse(readFileSync(f, 'utf8')).pieceStats as typeof stats | undefined;
  for (const [stage, counts] of Object.entries(incoming ?? {}))
    for (const [type, n] of Object.entries(counts)) {
      if (!/^[1-5]$/.test(stage) || !Number.isInteger(n) || n < 0) continue;
      (stats[stage] ??= {})[type] = (stats[stage][type] ?? 0) + n;
      statTotal += n;
    }
}
if (statTotal) {
  console.log(`\n━━ 받은 조각 통계 (${STATS_PATH}): ${statTotal}개 추가`);
  for (const [stage, counts] of Object.entries(stats).sort()) {
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`  ${stage}단계 ${sum}개: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${((n / sum) * 100).toFixed(1)}%`).join(' ')}`);
  }
  if (write) writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2) + '\n');
}

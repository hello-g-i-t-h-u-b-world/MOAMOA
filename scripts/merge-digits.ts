// 사용자들이 보내준 숫자 학습 데이터를 검사해 기본 내장값(src/capture/digits.json)에 합친다.
//   npx tsx scripts/merge-digits.ts 받은파일1.json [받은파일2.json ...]          # 검사만
//   npx tsx scripts/merge-digits.ts --write 받은파일1.json [...]                 # 검사 후 저장
// '학습 데이터 내보내기' 파일과 '화면 저장' 파일 모두 받을 수 있다.
import { readFileSync, writeFileSync } from 'node:fs';
import { mergeDigits, mergePieceStats, type StageCounts, type StatsSource } from '../src/capture/digit-data';
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
  { field: 'numDigits', path: 'src/capture/num-digits.json', name: '점수·제거한 줄 수', maxDigit: 9 },
] as const;
for (const set of SETS) {
  let current: DigitTemplates = JSON.parse(readFileSync(set.path, 'utf8'));
  let total = 0;
  console.log(`\n━━ ${set.name} (${set.path})`);
  for (const f of files) {
    const data = JSON.parse(readFileSync(f, 'utf8'));
    const incoming: DigitTemplates = data[set.field] ?? {};
    if (!Object.keys(incoming).length) continue;
    const { merged, report } = mergeDigits(current, incoming, 'maxDigit' in set ? set.maxDigit : undefined);
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

// 받은 조각 통계 (단계 → 조각 → 횟수): 공개되지 않은 등장 확률을 추정하는 데 쓴다 → src/core/piece-stats.json
// 같은 브라우저에서 다시 내보낸 파일은 누적값이라, 출처별 마지막 값(piece-stats-sources.json)보다 늘어난 만큼만 더한다
const STATS_PATH = 'src/core/piece-stats.json';
const SOURCES_PATH = 'src/core/piece-stats-sources.json';
let stats: StageCounts = JSON.parse(readFileSync(STATS_PATH, 'utf8'));
let sources: Record<string, StatsSource> = JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
let statTotal = 0;
console.log(`\n━━ 받은 조각 통계 (${STATS_PATH})`);
for (const f of files) {
  const data = JSON.parse(readFileSync(f, 'utf8'));
  const r = mergePieceStats(stats, sources, data);
  stats = r.total;
  sources = r.sources;
  statTotal += r.added;
  const what = {
    none: '통계 없음',
    duplicate: '이미 합친 파일과 같음 → 건너뜀',
    new: '새 출처',
    update: '같은 출처의 누적값 → 늘어난 만큼만',
    reset: '같은 출처지만 통계가 초기화됨 → 전부 새 기록',
  }[r.status];
  console.log(`  ■ ${f}: ${what}, ${r.added}개 추가`);
}
for (const [stage, counts] of Object.entries(stats).sort()) {
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`  ${stage}단계 ${sum}개: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${((n / sum) * 100).toFixed(1)}%`).join(' ')}`);
}
if (write && statTotal) {
  writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2) + '\n');
  writeFileSync(SOURCES_PATH, JSON.stringify(sources, null, 2) + '\n');
  console.log(`  ${statTotal}개 추가 → 저장 완료`);
} else if (statTotal) console.log(`  ${statTotal}개 추가 예정 (검사만 했습니다. 반영하려면 --write)`);

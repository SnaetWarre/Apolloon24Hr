import type { RunnerInsight } from '../../lib/analysis';
import { foldSearchText } from '../../lib/runners';

export type RunnerInsightSort = 'laps' | 'average' | 'best' | 'consistency';

export function runnerInsightMatches(insight: RunnerInsight, query: string) {
  const normalized = foldSearchText(query.trim());
  if (!normalized) return true;
  return (
    foldSearchText(insight.runnerName).includes(normalized) ||
    foldSearchText(insight.runnerNumber || '').includes(normalized)
  );
}

export function sortRunnerInsight(mode: RunnerInsightSort) {
  return (a: RunnerInsight, b: RunnerInsight) => {
    if (mode === 'average') {
      return nullableAsc(a.averageMs, b.averageMs) || b.count - a.count;
    }
    if (mode === 'best') {
      return nullableAsc(a.bestMs, b.bestMs) || b.count - a.count;
    }
    if (mode === 'consistency') {
      return nullableAsc(a.standardDeviationMs, b.standardDeviationMs) || b.count - a.count;
    }
    return b.count - a.count || nullableAsc(a.averageMs, b.averageMs);
  };
}

function nullableAsc(a: number | null, b: number | null) {
  return (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER);
}

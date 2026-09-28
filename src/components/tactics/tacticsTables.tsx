import { formatClockTimeMs, formatDurationMs } from '../../lib/time';
import type { LapRecord } from '../../types';

export function RecentLapsTable({
  laps,
  minimumLapSeconds,
  maximumLapSeconds,
}: {
  laps: LapRecord[];
  minimumLapSeconds: number;
  maximumLapSeconds: number;
}) {
  const sortedLaps = [...laps].sort((firstLap, secondLap) => secondLap.finishedAt - firstLap.finishedAt);
  const recentLaps = sortedLaps.slice(0, 30);
  const suspiciousLaps = sortedLaps.filter((lap) => {
    const durationSeconds = lap.durationMs / 1_000;
    return durationSeconds < minimumLapSeconds || durationSeconds > maximumLapSeconds;
  });
  return (
    <div className="tactics-lap-tables">
      <LapReviewTable laps={recentLaps} minimumLapSeconds={minimumLapSeconds} maximumLapSeconds={maximumLapSeconds} />
      {suspiciousLaps.length > 0 && (
        <details className="tactics-suspicious-details">
          <summary>Alle {suspiciousLaps.length} verdachte rondes bekijken</summary>
          <LapReviewTable laps={suspiciousLaps} minimumLapSeconds={minimumLapSeconds} maximumLapSeconds={maximumLapSeconds} />
        </details>
      )}
    </div>
  );
}

function LapReviewTable({
  laps,
  minimumLapSeconds,
  maximumLapSeconds,
}: {
  laps: LapRecord[];
  minimumLapSeconds: number;
  maximumLapSeconds: number;
}) {
  return (
    <div className="table-wrap">
      <table className="analysis-table">
        <thead><tr><th>Moment</th><th>Loper</th><th>Ronde</th><th>Tijd</th><th>Controle</th></tr></thead>
        <tbody>
          {laps.map((lap) => {
            const durationSeconds = lap.durationMs / 1_000;
            const suspicious = durationSeconds < minimumLapSeconds || durationSeconds > maximumLapSeconds;
            return (
              <tr key={lap.id}>
                <td>{formatClockTimeMs(lap.finishedAt)}</td>
                <td><strong>{lap.runnerName}</strong></td>
                <td>{lap.lapNumber}</td>
                <td>{formatDurationMs(lap.durationMs)}</td>
                <td><span className={`tactics-lap-status tactics-lap-status--${suspicious ? 'warning' : 'valid'}`}>{suspicious ? 'Nakijken' : 'Geldig'}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Apolloon Wrapped: after the race every runner who ran gets one image about their race,
 * to share on Instagram. This file only turns the finished race into numbers and short
 * Dutch sentences ("facts"); the card component draws them, so the design can change
 * without touching the stats.
 */
import type { Label, LapRecord, RaceEvent, Runner, RunnerRegistration } from '../types';
import { compareLabels } from '../../shared/labelOrder';
import { MAX_PLAUSIBLE_LAP_MS, MIN_LAP_MS } from '../../shared/lapTimes';
import { hasPlausibleDuration, isMeasuredLap } from './analysis';
import { mailHref } from './contact';
import { calculateLapPoints } from './ranking';
import { formatDurationMs } from './time';

const HOUR_MS = 3_600_000;
/** One lap of the track. */
export const LAP_METERS = 520;
/** How many facts a card shows, best first. */
export const WRAPPED_FACTS_PER_CARD = 4;

const BRUSSELS_HOUR = new Intl.DateTimeFormat('nl-BE', {
  hour: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Brussels',
});
const NUMBER = new Intl.NumberFormat('nl-BE', { maximumFractionDigits: 1 });

export type WrappedRank = { place: number; of: number };

export type WrappedLabelRank = { label: Label; byLaps: WrappedRank; byPoints: WrappedRank };

/** One clock hour (Brussels), named after the hour it starts, e.g. "03u". */
export type WrappedHour = { startsAt: number; label: string; laps: number };

export type WrappedFactKind =
  | 'fastest_of_team'
  | 'most_laps_of_team'
  | 'top_in_team'
  | 'burgie'
  | 'top_in_label'
  | 'beat_last_year'
  | 'beat_own_guess'
  | 'faster_than_guess'
  | 'night_owl'
  | 'distance'
  | 'streak'
  | 'share_of_team'
  | 'busiest_hour'
  | 'fastest_lap'
  | 'time_on_track'
  | 'laps';

export type WrappedFact = {
  kind: WrappedFactKind;
  /** Higher shows first. */
  priority: number;
  text: string;
  values: Record<string, number | string>;
};

export type WrappedRunner = {
  runnerId: string;
  runnerNumber: string | null;
  name: string;
  /** As typed in the form; `emailValid` says whether it can be mailed. */
  email: string;
  emailValid: boolean;
  /** Answered no to being contacted again in the form, so they get no mail. */
  refusedContact: boolean;
  labels: Label[];
  laps: number;
  distanceKm: number;
  lapShareOfTeam: number;
  fastestLapMs: number | null;
  fastestLapAt: number | null;
  fastestLapNumber: number | null;
  averageLapMs: number | null;
  totalTimeOnTrackMs: number;
  points: number;
  teamRank: { laps: WrappedRank; points: WrappedRank; fastestLap: WrappedRank | null };
  labelRanks: WrappedLabelRank[];
  hours: WrappedHour[];
  firstLapAt: number;
  lastLapAt: number;
  nightLaps: number;
  longestStreak: number;
  vsLastYear: { bestDeltaMs: number | null; averageDeltaMs: number | null } | null;
  vsOwnGuess: {
    estimatedLaps: number | null;
    estimatedPaceMs: number | null;
    guessedFastestLapMs: number | null;
  } | null;
  burgieMoments: number[];
  /** Best first; the card shows the first WRAPPED_FACTS_PER_CARD. */
  facts: WrappedFact[];
};

export type WrappedInput = {
  runners: Runner[];
  laps: LapRecord[];
  registrations: Record<string, RunnerRegistration>;
  events: RaceEvent[];
};

type Tally = { laps: number; points: number };

/** One entry per runner with at least one lap. */
export function buildWrapped({ runners, laps, registrations, events }: WrappedInput): WrappedRunner[] {
  const sortedLaps = [...laps].sort(
    (a, b) => a.finishedAt - b.finishedAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  );
  const lapsByRunner = groupBy(sortedLaps, (lap) => lap.runnerId);
  const streaks = longestStreaks(sortedLaps);

  // Per label, what each runner ran in it: the labels they had at the time of each lap.
  const labelsById = new Map<string, Label>();
  const tallyByLabel = new Map<string, Map<string, Tally>>();
  for (const lap of sortedLaps) {
    const points = calculateLapPoints(lap);
    for (const label of lap.labels) {
      labelsById.set(label.id, label);
      const tallies = tallyByLabel.get(label.id) ?? new Map<string, Tally>();
      const tally = tallies.get(lap.runnerId) ?? { laps: 0, points: 0 };
      tally.laps += 1;
      tally.points += points;
      tallies.set(lap.runnerId, tally);
      tallyByLabel.set(label.id, tallies);
    }
  }

  const stats = runners.flatMap((runner) => {
    const runnerLaps = lapsByRunner.get(runner.id);
    return runnerLaps ? [runnerStats(runner, runnerLaps)] : [];
  });
  const lapRanks = ranks(stats.map((entry) => [entry.runner.id, entry.laps]));
  const pointRanks = ranks(stats.map((entry) => [entry.runner.id, entry.points]));
  const timed = stats.filter((entry) => entry.fastest);
  const fastestRanks = ranks(timed.map((entry) => [entry.runner.id, -entry.fastest!.durationMs]));
  const labelRanks = new Map(
    [...tallyByLabel].map(([labelId, tallies]) => {
      const entries = [...tallies];
      return [
        labelId,
        {
          laps: ranks(entries.map(([runnerId, tally]) => [runnerId, tally.laps])),
          points: ranks(entries.map(([runnerId, tally]) => [runnerId, tally.points])),
          of: entries.length,
        },
      ];
    })
  );

  const teamLaps = sortedLaps.length;
  const burgieByRunner = groupBy(
    events.filter((event) => event.type === 'burgie_gepakt' && event.runnerId),
    (event) => event.runnerId!
  );

  const wrappedRunners = stats.map((entry): WrappedRunner => {
    const { runner } = entry;
    const registration = registrations[runner.id];
    const email = registration?.email.trim() ?? '';
    const ownLabelRanks = [...new Set(entry.lapList.flatMap((lap) => lap.labels.map((label) => label.id)))]
      .map((labelId) => {
        const rank = labelRanks.get(labelId)!;
        return {
          label: labelsById.get(labelId)!,
          byLaps: { place: rank.laps.get(runner.id)!, of: rank.of },
          byPoints: { place: rank.points.get(runner.id)!, of: rank.of },
        };
      })
      .sort((a, b) => compareLabels(a.label, b.label));
    const wrapped: WrappedRunner = {
      runnerId: runner.id,
      runnerNumber: runner.runnerNumber,
      name: runner.name,
      email,
      emailValid: Boolean(mailHref(email)),
      refusedContact: /^\s*nee\b/i.test(registration?.reuseConsent ?? ''),
      labels: runner.labels,
      laps: entry.laps,
      distanceKm: (entry.laps * LAP_METERS) / 1000,
      lapShareOfTeam: teamLaps ? entry.laps / teamLaps : 0,
      fastestLapMs: entry.fastest?.durationMs ?? null,
      fastestLapAt: entry.fastest?.finishedAt ?? null,
      fastestLapNumber: entry.fastest?.lapNumber ?? null,
      averageLapMs: entry.averageMs,
      totalTimeOnTrackMs: entry.timeOnTrackMs,
      points: entry.points,
      teamRank: {
        laps: { place: lapRanks.get(runner.id)!, of: stats.length },
        points: { place: pointRanks.get(runner.id)!, of: stats.length },
        fastestLap: entry.fastest ? { place: fastestRanks.get(runner.id)!, of: timed.length } : null,
      },
      labelRanks: ownLabelRanks,
      hours: hourCounts(entry.lapList),
      firstLapAt: entry.lapList[0].finishedAt,
      lastLapAt: entry.lapList[entry.lapList.length - 1].finishedAt,
      nightLaps: entry.lapList.filter((lap) => brusselsHour(lap.finishedAt) < 6).length,
      longestStreak: streaks.get(runner.id) ?? 1,
      vsLastYear: compareWithLastYear(runner, entry),
      vsOwnGuess: registration ? readGuesses(registration) : null,
      burgieMoments: (burgieByRunner.get(runner.id) ?? []).map((event) => event.occurredAt),
      facts: [],
    };
    wrapped.facts = runnerFacts(wrapped);
    return wrapped;
  });

  return wrappedRunners;
}

type RunnerStats = ReturnType<typeof runnerStats>;

function runnerStats(runner: Runner, lapList: LapRecord[]) {
  // A double press, a guessed split half, or a forgotten handoff counts as a lap but not as a lap time.
  const measured = lapList.filter((lap) => isMeasuredLap(lap) && hasPlausibleDuration(lap));
  const fastest = measured.reduce<LapRecord | null>(
    (best, lap) => (!best || lap.durationMs < best.durationMs ? lap : best),
    null
  );
  const timeOnTrackMs = measured.reduce((sum, lap) => sum + lap.durationMs, 0);
  return {
    runner,
    lapList,
    laps: lapList.length,
    points: lapList.reduce((sum, lap) => sum + calculateLapPoints(lap), 0),
    fastest,
    averageMs: measured.length ? Math.round(timeOnTrackMs / measured.length) : null,
    timeOnTrackMs,
  };
}

function runnerFacts(runner: WrappedRunner): WrappedFact[] {
  const facts: WrappedFact[] = [];
  const add = (kind: WrappedFactKind, priority: number, text: string, values: WrappedFact['values'] = {}) =>
    facts.push({ kind, priority, text, values });
  const { teamRank } = runner;

  if (teamRank.fastestLap?.place === 1 && runner.fastestLapMs != null) {
    add('fastest_of_team', 100, `De snelste ronde van de hele 24 uur: ${formatLapTime(runner.fastestLapMs)}`, {
      fastestLapMs: runner.fastestLapMs,
    });
  }
  if (teamRank.laps.place === 1 && teamRank.laps.of > 1) {
    add('most_laps_of_team', 98, `Niemand liep meer rondes dan jij: ${runner.laps}`, { laps: runner.laps });
  } else if (teamRank.laps.place <= 3 && teamRank.laps.of > 3) {
    add('top_in_team', 95 - teamRank.laps.place, `Nummer ${teamRank.laps.place} in rondes van het hele team`, {
      place: teamRank.laps.place,
    });
  }
  if (runner.burgieMoments.length) {
    add(
      'burgie',
      90,
      runner.burgieMoments.length === 1
        ? 'Jij liep toen de burgie gepakt werd'
        : `Jij liep ${runner.burgieMoments.length} keer toen de burgie gepakt werd`,
      { times: runner.burgieMoments.length }
    );
  }
  const bestLabel = [...runner.labelRanks]
    .filter((rank) => rank.byLaps.of > 1)
    .sort((a, b) => a.byLaps.place - b.byLaps.place || b.byLaps.of - a.byLaps.of)[0];
  if (bestLabel && bestLabel.byLaps.place <= 3) {
    add('top_in_label', 88 - bestLabel.byLaps.place, `Nummer ${bestLabel.byLaps.place} van ${bestLabel.label.name}`, {
      label: bestLabel.label.name,
      place: bestLabel.byLaps.place,
      of: bestLabel.byLaps.of,
    });
  }
  const bestDelta = runner.vsLastYear?.bestDeltaMs;
  if (bestDelta != null && bestDelta < 0) {
    add('beat_last_year', 80, `${formatSeconds(-bestDelta)} sneller dan je beste ronde van vorig jaar`, {
      deltaMs: -bestDelta,
    });
  }
  const guessedLaps = runner.vsOwnGuess?.estimatedLaps;
  if (guessedLaps != null && runner.laps >= guessedLaps) {
    add(
      'beat_own_guess',
      runner.laps > guessedLaps ? 75 : 60,
      runner.laps > guessedLaps
        ? `Je schatte ${plural(guessedLaps, 'ronde', 'rondes')}, het werden er ${runner.laps}`
        : `Je schatte ${plural(guessedLaps, 'ronde', 'rondes')} en liep er precies zoveel`,
      { estimatedLaps: guessedLaps, laps: runner.laps }
    );
  }
  const guessedPace = runner.vsOwnGuess?.estimatedPaceMs;
  if (guessedPace != null && runner.averageLapMs != null && runner.averageLapMs < guessedPace) {
    add(
      'faster_than_guess',
      70,
      `Je dacht ${formatLapTime(guessedPace, false)} per ronde, het werd gemiddeld ${formatLapTime(runner.averageLapMs, false)}`,
      { estimatedPaceMs: guessedPace, averageLapMs: runner.averageLapMs }
    );
  }
  if (runner.nightLaps) {
    add('night_owl', 65, `Je liep ${plural(runner.nightLaps, 'ronde', 'rondes')} tussen middernacht en 6 uur`, {
      nightLaps: runner.nightLaps,
    });
  }
  add('distance', 50, `Je liep ${NUMBER.format(runner.distanceKm)} km`, { km: runner.distanceKm });
  if (runner.longestStreak > 1) {
    add('streak', 55, `${runner.longestStreak} rondes na elkaar, zonder wissel`, { streak: runner.longestStreak });
  }
  const busiest = runner.hours.reduce<WrappedHour | null>(
    (best, hour) => (!best || hour.laps > best.laps ? hour : best),
    null
  );
  if (busiest && busiest.laps > 1) {
    add('busiest_hour', 45, `Je drukste uur: ${busiest.label}, met ${busiest.laps} rondes`, {
      hour: busiest.label,
      laps: busiest.laps,
    });
  }
  add('share_of_team', 40, `${formatPercent(runner.lapShareOfTeam)} van alle rondes van het team`, {
    share: runner.lapShareOfTeam,
  });
  if (runner.fastestLapMs != null) {
    add('fastest_lap', 30, `Je snelste ronde: ${formatLapTime(runner.fastestLapMs)}`, {
      fastestLapMs: runner.fastestLapMs,
    });
  }
  if (runner.totalTimeOnTrackMs >= 60_000) {
    add('time_on_track', 20, `${Math.round(runner.totalTimeOnTrackMs / 60_000)} minuten op de piste`, {
      minutes: Math.round(runner.totalTimeOnTrackMs / 60_000),
    });
  }
  add('laps', 10, `${plural(runner.laps, 'ronde', 'rondes')} voor het team`, { laps: runner.laps });

  return facts.sort((a, b) => b.priority - a.priority);
}

function compareWithLastYear(runner: Runner, entry: RunnerStats): WrappedRunner['vsLastYear'] {
  const bestDeltaMs =
    runner.historicalBestMs && entry.fastest ? entry.fastest.durationMs - runner.historicalBestMs : null;
  const averageDeltaMs =
    runner.historicalAvgMs && entry.averageMs != null ? entry.averageMs - runner.historicalAvgMs : null;
  return bestDeltaMs == null && averageDeltaMs == null ? null : { bestDeltaMs, averageDeltaMs };
}

/** The guesses from the form, only where the typed answer reads cleanly; "Zo veel mogelijk" stays out. */
function readGuesses(registration: RunnerRegistration): WrappedRunner['vsOwnGuess'] {
  const lapsText = registration.estimatedLaps.trim();
  const estimatedLaps = /^\d{1,3}$/.test(lapsText) && Number(lapsText) > 0 ? Number(lapsText) : null;
  const estimatedPaceMs = parseTypedLapTime(registration.estimatedPace);
  const guessedFastestLapMs = parseTypedLapTime(registration.fastestLap);
  return estimatedLaps == null && estimatedPaceMs == null && guessedFastestLapMs == null
    ? null
    : { estimatedLaps, estimatedPaceMs, guessedFastestLapMs };
}

/**
 * A lap time typed in the form: "1:25", "1'25", "1:25.4", or "85 sec". Anything else,
 * or a time no real lap takes, gives null.
 */
export function parseTypedLapTime(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  const clock = /^(\d{1,2})\s*[:'’]\s*(\d{2})(?:[.,](\d{1,3}))?\s*(?:["”]|min)?$/.exec(trimmed);
  const seconds = /^(\d{2,3})(?:[.,](\d{1,3}))?\s*(?:s|sec|seconden)$/.exec(trimmed);
  let ms: number | null = null;
  if (clock && Number(clock[2]) < 60) {
    ms = (Number(clock[1]) * 60 + Number(clock[2])) * 1000 + fractionMs(clock[3]);
  } else if (seconds) {
    ms = Number(seconds[1]) * 1000 + fractionMs(seconds[2]);
  }
  return ms != null && ms >= MIN_LAP_MS && ms <= MAX_PLAUSIBLE_LAP_MS ? ms : null;
}

function fractionMs(digits: string | undefined): number {
  return digits ? Math.round(Number(`0.${digits}`) * 1000) : 0;
}

/** Most laps each runner ran back to back, with nobody else in between. */
function longestStreaks(sortedLaps: LapRecord[]): Map<string, number> {
  const longest = new Map<string, number>();
  let current = 0;
  sortedLaps.forEach((lap, index) => {
    current = index > 0 && sortedLaps[index - 1].runnerId === lap.runnerId ? current + 1 : 1;
    longest.set(lap.runnerId, Math.max(longest.get(lap.runnerId) ?? 0, current));
  });
  return longest;
}

/** Laps per clock hour, by the hour each lap finished in. Brussels is a whole number of hours off UTC. */
function hourCounts(laps: LapRecord[]): WrappedHour[] {
  const counts = new Map<number, number>();
  for (const lap of laps) {
    const startsAt = Math.floor(lap.finishedAt / HOUR_MS) * HOUR_MS;
    counts.set(startsAt, (counts.get(startsAt) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => a - b)
    .map(([startsAt, count]) => ({ startsAt, label: hourLabel(startsAt), laps: count }));
}

/** Place by runner id, 1 for the highest value; equal values share a place. */
function ranks(values: Array<[runnerId: string, value: number]>): Map<string, number> {
  return new Map(values.map(([runnerId, value]) => [runnerId, 1 + values.filter(([, other]) => other > value).length]));
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

function brusselsHour(ms: number): number {
  return Number(BRUSSELS_HOUR.format(ms));
}

function hourLabel(ms: number): string {
  return `${BRUSSELS_HOUR.format(ms)}u`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "1:05.3", or "1:05" without tenths. */
export function formatLapTime(ms: number, tenths = true): string {
  const text = formatDurationMs(ms);
  return tenths ? text.slice(0, -2) : text.slice(0, -4);
}

function formatSeconds(ms: number): string {
  const seconds = Math.round(ms / 100) / 10;
  return `${NUMBER.format(seconds)} ${seconds === 1 ? 'seconde' : 'seconden'}`;
}

function formatPercent(share: number): string {
  return `${NUMBER.format(share * 100)}%`;
}

/** A file name per runner, "0012 - Jan Peeters.png"; two runners never share one. */
export function wrappedFileNames(runners: Array<Pick<WrappedRunner, 'runnerNumber' | 'name' | 'runnerId'>>) {
  const taken = new Set<string>();
  return new Map(
    runners.map((runner) => {
      const base = wrappedFileName(runner).slice(0, -'.png'.length);
      let fileName = `${base}.png`;
      for (let copy = 2; taken.has(fileName.toLowerCase()); copy += 1) fileName = `${base} (${copy}).png`;
      taken.add(fileName.toLowerCase());
      return [runner.runnerId, fileName];
    })
  );
}

/** "0012 - Jan Peeters.png": sorts by number, and safe as a Windows file name. */
function wrappedFileName(runner: Pick<WrappedRunner, 'runnerNumber' | 'name' | 'runnerId'>): string {
  const number = runner.runnerNumber?.trim();
  const name = runner.name
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const prefix = number ? (/^\d+$/.test(number) ? number.padStart(4, '0') : number.replace(/[^\w-]/g, '')) : '';
  const base = [prefix, name || runner.runnerId].filter(Boolean).join(' - ');
  return `${base.slice(0, 120)}.png`;
}

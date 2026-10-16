/**
 * Apolloon Wrapped: after the race every runner who ran gets one image about their race,
 * to share on Instagram. Apolloon chose what is on it: the runner's profile and type,
 * their lap count, fastest and average lap, their coefficient place (overall and in each
 * of their labels), and the burgies caught while they ran. This file only computes those;
 * the card component draws them, so the design can change without touching the numbers.
 */
import type { Label, LapRecord, RaceEvent, Runner, RunnerRegistration } from '../types';
import { compareLabels } from '../../shared/labelOrder';
import { hasPlausibleDuration, isMeasuredLap } from './analysis';
import { mailHref } from './contact';
import { calculateLapPoints } from './ranking';
import { formatDurationMs } from './time';

/** The labels a card lists a coefficient place for, best place first. */
export const WRAPPED_LABEL_PLACES = 3;

const BRUSSELS_HOUR = new Intl.DateTimeFormat('nl-BE', {
  hour: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Brussels',
});

export type WrappedRank = { place: number; of: number };

/** What kind of runner someone was, from their own race. */
export type WrappedRunnerType = {
  kind: 'sprinter' | 'kilometervreter' | 'metronoom' | 'nachtloper' | 'vroege_vogel' | 'teamspeler';
  title: string;
  text: string;
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
  runnerType: WrappedRunnerType;
  laps: number;
  fastestLapMs: number | null;
  averageLapMs: number | null;
  points: number;
  /** Coefficient place among everyone who ran. */
  pointsRank: WrappedRank;
  /** Coefficient place in each label they ran laps in, best first. */
  labelPointsRanks: Array<WrappedRank & { label: Label }>;
  /** "Burgie gepakt" moments while this runner was on the track. */
  burgies: number;
};

export type WrappedInput = {
  runners: Runner[];
  laps: LapRecord[];
  registrations: Record<string, RunnerRegistration>;
  events: RaceEvent[];
};

/** One entry per runner with at least one lap. */
export function buildWrapped({ runners, laps, registrations, events }: WrappedInput): WrappedRunner[] {
  const lapsByRunner = groupBy(laps, (lap) => lap.runnerId);
  const stats = runners.flatMap((runner) => {
    const runnerLaps = lapsByRunner.get(runner.id);
    return runnerLaps ? [runnerStats(runner, runnerLaps)] : [];
  });
  const lapRanks = ranks(stats.map((entry) => [entry.runner.id, entry.laps]));
  const pointRanks = ranks(stats.map((entry) => [entry.runner.id, entry.points]));
  const timed = stats.filter((entry) => entry.fastestMs != null);
  const fastestRanks = ranks(timed.map((entry) => [entry.runner.id, -entry.fastestMs!]));

  // Per label, the points each runner earned in it: by the labels they had at the time of each lap,
  // as the Binnenscherm ranks a label.
  const labelsById = new Map<string, Label>();
  const pointsByLabel = new Map<string, Map<string, number>>();
  for (const lap of laps) {
    for (const label of lap.labels) {
      labelsById.set(label.id, label);
      const points = pointsByLabel.get(label.id) ?? new Map<string, number>();
      points.set(lap.runnerId, (points.get(lap.runnerId) ?? 0) + calculateLapPoints(lap));
      pointsByLabel.set(label.id, points);
    }
  }
  const labelRanks = new Map(
    [...pointsByLabel].map(([labelId, points]) => [labelId, { places: ranks([...points]), of: points.size }])
  );

  const burgies = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'burgie_gepakt' && event.runnerId) {
      burgies.set(event.runnerId, (burgies.get(event.runnerId) ?? 0) + 1);
    }
  }

  return stats.map((entry): WrappedRunner => {
    const { runner } = entry;
    const email = registrations[runner.id]?.email.trim() ?? '';
    const labelPointsRanks = [...new Set(entry.lapList.flatMap((lap) => lap.labels.map((label) => label.id)))]
      .map((labelId) => {
        const rank = labelRanks.get(labelId)!;
        return { label: labelsById.get(labelId)!, place: rank.places.get(runner.id)!, of: rank.of };
      })
      .filter((rank) => rank.of > 1)
      .sort((a, b) => a.place - b.place || b.of - a.of || compareLabels(a.label, b.label))
      .slice(0, WRAPPED_LABEL_PLACES);
    return {
      runnerId: runner.id,
      runnerNumber: runner.runnerNumber,
      name: runner.name,
      email,
      emailValid: Boolean(mailHref(email)),
      refusedContact: /^\s*nee\b/i.test(registrations[runner.id]?.reuseConsent ?? ''),
      labels: runner.labels,
      runnerType: runnerType(entry, {
        laps: { place: lapRanks.get(runner.id)!, of: stats.length },
        fastestLap: entry.fastestMs != null ? { place: fastestRanks.get(runner.id)!, of: timed.length } : null,
      }),
      laps: entry.laps,
      fastestLapMs: entry.fastestMs,
      averageLapMs: entry.averageMs,
      points: entry.points,
      pointsRank: { place: pointRanks.get(runner.id)!, of: stats.length },
      labelPointsRanks,
      burgies: burgies.get(runner.id) ?? 0,
    };
  });
}

type RunnerStats = ReturnType<typeof runnerStats>;

function runnerStats(runner: Runner, lapList: LapRecord[]) {
  // A double press, a guessed split half, or a forgotten handoff counts as a lap but not as a lap time.
  const measured = lapList
    .filter((lap) => isMeasuredLap(lap) && hasPlausibleDuration(lap))
    .map((lap) => lap.durationMs);
  return {
    runner,
    lapList,
    laps: lapList.length,
    points: lapList.reduce((sum, lap) => sum + calculateLapPoints(lap), 0),
    measured,
    fastestMs: measured.length ? Math.min(...measured) : null,
    averageMs: measured.length ? Math.round(measured.reduce((sum, ms) => sum + ms, 0) / measured.length) : null,
  };
}

/** The first type that fits, from the rarest to the one everybody gets. */
function runnerType(
  entry: RunnerStats,
  rank: { laps: WrappedRank; fastestLap: WrappedRank | null }
): WrappedRunnerType {
  const topTenth = (of: number) => Math.max(1, Math.ceil(of * 0.1));
  const hours = entry.lapList.map((lap) => Number(BRUSSELS_HOUR.format(lap.finishedAt)));
  const share = (from: number, to: number) => hours.filter((hour) => hour >= from && hour < to).length / hours.length;
  const spreadMs = entry.measured.length >= 3 ? Math.max(...entry.measured) - Math.min(...entry.measured) : null;

  if (rank.fastestLap && rank.fastestLap.of >= 5 && rank.fastestLap.place <= topTenth(rank.fastestLap.of)) {
    return { kind: 'sprinter', title: 'Sprinter', text: 'Je snelste ronde hoort bij de snelste 10% van de 24 uur.' };
  }
  if (rank.laps.of >= 5 && rank.laps.place <= topTenth(rank.laps.of)) {
    return { kind: 'kilometervreter', title: 'Kilometervreter', text: 'Je liep meer rondjes dan 90% van de lopers.' };
  }
  if (spreadMs != null && spreadMs <= 4_000) {
    return {
      kind: 'metronoom',
      title: 'Metronoom',
      text: `Je rondes lagen nooit meer dan ${Math.max(1, Math.round(spreadMs / 1000))} seconden uit elkaar.`,
    };
  }
  if (share(0, 6) >= 0.5) {
    return {
      kind: 'nachtloper',
      title: 'Nachtloper',
      text: 'De meeste van je rondjes liep je tussen middernacht en 6 uur.',
    };
  }
  if (share(6, 10) >= 0.5) {
    return {
      kind: 'vroege_vogel',
      title: 'Vroege vogel',
      text: 'De meeste van je rondjes liep je tussen 6 en 10 uur.',
    };
  }
  return { kind: 'teamspeler', title: 'Teamspeler', text: 'Elk rondje telt, en jij liep ze voor het team.' };
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

/** "1:05.3": minutes, seconds and tenths. */
export function formatLapTime(ms: number): string {
  return formatDurationMs(ms).slice(0, -2);
}

/** "3e", or "Top 30%" further down, in steps of 5%. */
export function formatPlace({ place, of }: WrappedRank): { headline: string; detail: string } {
  if (place <= 10) return { headline: `${place}e`, detail: `van ${of} lopers` };
  return { headline: `Top ${Math.ceil((place / of) * 20) * 5}%`, detail: `plaats ${place} van ${of}` };
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

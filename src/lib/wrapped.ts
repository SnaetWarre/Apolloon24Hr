/**
 * Apolloon Wrapped: after the race every runner who ran gets four story images about their
 * race, to share on Instagram. This file only computes the numbers on them; the story
 * component draws them, so the design can change without touching the numbers.
 */
import type { LapRecord, Runner, RunnerRegistration } from '../types';
import { isMeasuredLap } from '../../shared/points';
import { hasPlausibleDuration } from './analysis';
import { mailHref } from './contact';
import { formatDurationMs } from './time';

/** One lap of the track, in meters. */
export const LAP_METERS = 520;
const HOUR_MS = 3_600_000;

const BRUSSELS_HOUR = new Intl.DateTimeFormat('nl-BE', {
  hour: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Brussels',
});
const BRUSSELS_TIME = new Intl.DateTimeFormat('nl-BE', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Brussels',
});

/** What kind of runner someone was, from their own race. */
export type WrappedRunnerType = {
  kind: 'sprinter' | 'kilometervreter' | 'metronoom' | 'nachtuil' | 'vroege_vogel' | 'teamspeler';
  title: string;
  text: string;
  /** The clock hours [from, to) the type is about, drawn in orange on the chart. */
  hours: { from: number; to: number } | null;
};

export type WrappedRunner = {
  runnerId: string;
  runnerNumber: string | null;
  name: string;
  firstName: string;
  lastName: string;
  /** As typed in the form; `emailValid` says whether it can be mailed. */
  email: string;
  emailValid: boolean;
  /** Answered no to being contacted again in the form, so they get no mail. */
  refusedContact: boolean;
  runnerType: WrappedRunnerType;
  laps: number;
  meters: number;
  /** Share of everyone who ran that ran fewer laps, in whole percents. */
  lapsBeatenPercent: number;
  fastestLapMs: number | null;
  averageLapMs: number | null;
  fastestLap: {
    /** Which of this runner's own laps it was, from 1. */
    number: number;
    finishedAt: number;
    /** Place among everyone's fastest lap; equal times share a place. */
    place: number;
  } | null;
  /** Laps finished in each hour of the race, from the hour it started. */
  lapsPerHour: number[];
};

export type WrappedInput = {
  runners: Runner[];
  laps: LapRecord[];
  registrations: Record<string, RunnerRegistration>;
  raceStartedAt: number | null;
};

/** One entry per runner with at least one lap. */
export function buildWrapped({ runners, laps, registrations, raceStartedAt }: WrappedInput): WrappedRunner[] {
  const lapsByRunner = groupBy(
    [...laps].sort((a, b) => a.finishedAt - b.finishedAt),
    (lap) => lap.runnerId
  );
  const stats = runners.flatMap((runner) => {
    const runnerLaps = lapsByRunner.get(runner.id);
    return runnerLaps ? [runnerStats(runner, runnerLaps)] : [];
  });
  const lapRanks = ranks(stats.map((entry) => [entry.runner.id, entry.laps]));
  const timed = stats.filter((entry) => entry.fastest != null);
  const fastestRanks = ranks(timed.map((entry) => [entry.runner.id, -entry.fastest!.durationMs]));
  const fewerLaps = (entry: RunnerStats) => stats.filter((other) => other.laps < entry.laps).length;
  const firstHour = hourStart(raceStartedAt ?? Math.min(...laps.map((lap) => lap.startedAt)));

  return stats.map((entry): WrappedRunner => {
    const { runner, fastest } = entry;
    const email = registrations[runner.id]?.email.trim() ?? '';
    const [firstName, lastName] = splitName(runner.name);
    const lapsPerHour = Array.from({ length: 24 }, () => 0);
    for (const lap of entry.lapList) {
      const hour = Math.floor((lap.finishedAt - firstHour) / HOUR_MS);
      lapsPerHour[Math.min(23, Math.max(0, hour))] += 1;
    }
    return {
      runnerId: runner.id,
      runnerNumber: runner.runnerNumber,
      name: runner.name,
      firstName,
      lastName,
      email,
      emailValid: Boolean(mailHref(email)),
      refusedContact: /^\s*nee\b/i.test(registrations[runner.id]?.reuseConsent ?? ''),
      runnerType: runnerType(entry, {
        laps: { place: lapRanks.get(runner.id)!, of: stats.length, fewer: fewerLaps(entry) },
        fastestLap: fastest ? { place: fastestRanks.get(runner.id)!, of: timed.length } : null,
      }),
      laps: entry.laps,
      meters: entry.laps * LAP_METERS,
      lapsBeatenPercent: Math.floor((100 * fewerLaps(entry)) / stats.length),
      fastestLapMs: fastest?.durationMs ?? null,
      averageLapMs: entry.averageMs,
      fastestLap: fastest
        ? {
            number: entry.lapList.indexOf(fastest) + 1,
            finishedAt: fastest.finishedAt,
            place: fastestRanks.get(runner.id)!,
          }
        : null,
      lapsPerHour,
    };
  });
}

type RunnerStats = ReturnType<typeof runnerStats>;

function runnerStats(runner: Runner, lapList: LapRecord[]) {
  // A double press, a guessed split half, or a forgotten handoff counts as a lap but not as a lap time.
  const measured = lapList.filter((lap) => isMeasuredLap(lap) && hasPlausibleDuration(lap));
  const fastest = measured.reduce<LapRecord | null>(
    (best, lap) => (best && best.durationMs <= lap.durationMs ? best : lap),
    null
  );
  return {
    runner,
    lapList,
    laps: lapList.length,
    measured: measured.map((lap) => lap.durationMs),
    fastest,
    averageMs: measured.length
      ? Math.round(measured.reduce((sum, lap) => sum + lap.durationMs, 0) / measured.length)
      : null,
  };
}

type Rank = { place: number; of: number };

/** The first type that fits, from the rarest to the one everybody gets. */
function runnerType(
  entry: RunnerStats,
  rank: { laps: Rank & { fewer: number }; fastestLap: Rank | null }
): WrappedRunnerType {
  const topTenth = (of: number) => Math.max(1, Math.ceil(of * 0.1));
  const hours = entry.lapList.map((lap) => Number(BRUSSELS_HOUR.format(lap.finishedAt)));
  const spreadMs = entry.measured.length >= 3 ? Math.max(...entry.measured) - Math.min(...entry.measured) : null;
  const between = (from: number, to: number) => {
    const count = hours.filter((hour) => hour >= from && hour < to).length;
    const window = `tussen ${String(from).padStart(2, '0')}:00 en ${String(to).padStart(2, '0')}:00`;
    const text =
      count === entry.laps
        ? entry.laps === 1
          ? `Je ronde was ${window}`
          : `Al je ${entry.laps} rondes waren ${window}`
        : `${count} van je ${entry.laps} rondes ${count === 1 ? 'was' : 'waren'} ${window}`;
    return { share: count / entry.laps, text, hours: { from, to } };
  };

  if (rank.fastestLap && rank.fastestLap.of >= 5 && rank.fastestLap.place <= topTenth(rank.fastestLap.of)) {
    return {
      kind: 'sprinter',
      title: 'Sprinter',
      text: 'Je snelste ronde hoort bij de snelste 10% van de 24 uur',
      hours: null,
    };
  }
  // Counted by who ran fewer laps, not by place, so a tie at the edge of the top 10% doesn't count.
  if (rank.laps.of >= 5 && rank.laps.fewer >= rank.laps.of * 0.9) {
    const more = rank.laps.place - 1;
    return {
      kind: 'kilometervreter',
      title: 'Kilometervreter',
      text:
        more === 0
          ? 'Niemand liep meer rondes dan jij'
          : `Maar ${more} ${more === 1 ? 'loper liep' : 'lopers liepen'} meer rondes dan jij`,
      hours: null,
    };
  }
  if (spreadMs != null && spreadMs <= 4_000) {
    return {
      kind: 'metronoom',
      title: 'Metronoom',
      text: `Je rondes lagen nooit meer dan ${Math.max(1, Math.round(spreadMs / 1000))} seconden uit elkaar`,
      hours: null,
    };
  }
  const night = between(0, 6);
  if (night.share >= 0.5) return { kind: 'nachtuil', title: 'Nachtuil', text: night.text, hours: night.hours };
  const morning = between(6, 10);
  if (morning.share >= 0.5) {
    return { kind: 'vroege_vogel', title: 'Vroege vogel', text: morning.text, hours: morning.hours };
  }
  return {
    kind: 'teamspeler',
    title: 'Teamspeler',
    text: 'Elke ronde telt, en jij liep ze voor het team',
    hours: null,
  };
}

/** "Warre Snaet" → ["Warre", "Snaet"]; everything after the first word is the last name. */
export function splitName(name: string): [string, string] {
  const [first = '', ...rest] = name.trim().split(/\s+/);
  return [first, rest.join(' ')];
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

/** The whole hour a moment falls in; Brussels is a whole number of hours from UTC. */
function hourStart(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/** The Brussels clock hour of each hour on the chart, from the hour the race started. */
export function chartHours(raceStartedAt: number): number[] {
  const first = hourStart(raceStartedAt);
  return Array.from({ length: 25 }, (_, index) => Number(BRUSSELS_HOUR.format(first + index * HOUR_MS)));
}

/** "1:05.3": minutes, seconds and tenths. */
export function formatLapTime(ms: number): string {
  return formatDurationMs(ms).slice(0, -2);
}

/** "03:41 's nachts", in Brussels time. */
export function formatTimeOfDay(at: number): string {
  const time = BRUSSELS_TIME.format(at);
  const hour = Number(time.slice(0, 2));
  const part = hour < 6 ? "'s nachts" : hour < 12 ? "'s ochtends" : hour < 18 ? "'s middags" : "'s avonds";
  return `${time} ${part}`;
}

/** A file name per runner without its extension, "0012 - Jan Peeters"; two runners never share one. */
export function wrappedFileNames(runners: Array<Pick<WrappedRunner, 'runnerNumber' | 'name' | 'runnerId'>>) {
  const taken = new Set<string>();
  return new Map(
    runners.map((runner) => {
      const base = wrappedFileName(runner);
      let fileName = base;
      for (let copy = 2; taken.has(fileName.toLowerCase()); copy += 1) fileName = `${base} (${copy})`;
      taken.add(fileName.toLowerCase());
      return [runner.runnerId, fileName];
    })
  );
}

/** "0012 - Jan Peeters": sorts by number, and safe as a Windows file name. */
function wrappedFileName(runner: Pick<WrappedRunner, 'runnerNumber' | 'name' | 'runnerId'>): string {
  const number = runner.runnerNumber?.trim();
  const name = runner.name
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const prefix = number ? (/^\d+$/.test(number) ? number.padStart(4, '0') : number.replace(/[^\w-]/g, '')) : '';
  return [prefix, name || runner.runnerId].filter(Boolean).join(' - ').slice(0, 116);
}

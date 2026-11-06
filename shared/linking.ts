/**
 * The rule for which way Koppelen links two groups, shared by the server, which links them
 * (server/cluster.ts), and the screens, which say beforehand what will happen to whose data.
 */

/** What a group tells about itself when two groups link. */
export type LinkSide = {
  clusterId: string;
  /** The race started there: ten laps were counted (fewer are a test). */
  raceStarted: boolean;
  /** The race started there and was not finished. */
  raceRunning: boolean;
  runners: number;
  /** Someone changed the event data there; a fresh laptop says false. */
  changed: boolean;
  laptops: number;
};

type RaceFacts = Pick<LinkSide, 'raceStarted' | 'raceRunning'>;

/** Before the race (it started on neither side), the joining side's runners and labels merge into the other group. */
export function runnersMerge(a: RaceFacts, b: RaceFacts): boolean {
  return !a.raceStarted && !b.raceStarted;
}

/**
 * Why `a` keeps its data against `b` because of the race: it runs on `a` and not on `b`
 * (`running`), or it started on `a` and not on `b` (`started`); null when the race does not decide.
 */
export function raceKeeps(a: RaceFacts, b: RaceFacts): 'running' | 'started' | null {
  if (a.raceRunning && !b.raceRunning) return 'running';
  if (a.raceStarted && !b.raceStarted) return 'started';
  return null;
}

/**
 * Which way Koppelen links two groups. Before the race (see runnersMerge), the joining side's
 * runners and labels merge into the other group, so only the rest is taken over: settings, logos,
 * a test race. Then a group nobody changed yet takes the data of one that someone prepared, then
 * the smaller group joins the larger, then the one with fewer runners joins, and then the group id
 * decides. Either side can then start it: `invite` asks the other side over.
 *
 * Once the race started somewhere, nothing merges. A group where the race runs (started, not
 * finished) keeps its data against one where it does not, so a spare laptop with the
 * registration list, or with a practice race that was finished, never replaces a running race.
 * Then a group where the race started keeps its data against one where it did not (raceKeeps).
 * Otherwise the one with fewer runners takes the other's data; with as many runners, the rules
 * from before the race decide. The other side is only asked to come over while it holds no
 * runners; else it is pressed there (`there`), where it is `join`.
 *
 * Both sides work this out alike, so a press on both at once links them one way.
 */
export function linkDirection(own: LinkSide, other: LinkSide): 'join' | 'invite' | 'there' {
  const merging = runnersMerge(own, other);
  const beforeRace = () =>
    other.changed !== own.changed
      ? other.changed
      : other.laptops !== own.laptops
        ? other.laptops > own.laptops
        : other.runners !== own.runners
          ? other.runners > own.runners
          : other.clusterId < own.clusterId;
  const otherKeeps = merging
    ? beforeRace()
    : raceKeeps(other, own)
      ? true
      : raceKeeps(own, other)
        ? false
        : other.runners !== own.runners
          ? other.runners > own.runners
          : beforeRace();
  if (otherKeeps) return 'join';
  return merging || other.runners === 0 ? 'invite' : 'there';
}

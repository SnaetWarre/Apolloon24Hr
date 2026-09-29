import { type TemporaryTeam } from '../../shared/schemas.js';
import { all, one, run, transaction } from './connection.js';
import { TEMPORARY_TEAM_ACTIVE_SQL, TEMPORARY_TEAM_KIND, ensureTemporaryTeamRow } from './labels.js';
import { clusterNow } from '../clock.js';

export function syncTemporaryTeamRows(): void {
  run(
    `INSERT OR IGNORE INTO temporary_teams (label_id, active, activated_at)
     SELECT id, 0, NULL FROM labels WHERE kind = ?`,
    [TEMPORARY_TEAM_KIND]
  );
}

/** Night teams with `active` evaluated at `nowMs`; a team without members is never active. */
export function getTemporaryTeams(nowMs = clusterNow()): TemporaryTeam[] {
  const membersByTeam = new Map<string, string[]>();
  for (const member of all<{ labelId: string; runnerId: string }>(
    `SELECT team_label_id AS labelId, runner_id AS runnerId FROM temporary_team_members ORDER BY runner_id`
  )) {
    membersByTeam.set(member.labelId, [...(membersByTeam.get(member.labelId) ?? []), member.runnerId]);
  }
  return all<{
    labelId: string;
    active: number;
    activatedAt: number | null;
    startsAt: number | null;
    endsAt: number | null;
  }>(
    `SELECT t.label_id AS labelId, ${TEMPORARY_TEAM_ACTIVE_SQL} AS active, t.activated_at AS activatedAt,
            t.starts_at AS startsAt, t.ends_at AS endsAt
     FROM temporary_teams t
     JOIN labels l ON l.id = t.label_id
     WHERE l.kind = ?
     ORDER BY COALESCE(l.sort_order, 9999), l.name`,
    [nowMs, TEMPORARY_TEAM_KIND]
  ).map((team) => {
    const memberRunnerIds = membersByTeam.get(team.labelId) ?? [];
    const active = Boolean(team.active) && memberRunnerIds.length > 0;
    const scheduled = team.startsAt !== null && team.endsAt !== null;
    return {
      labelId: team.labelId,
      active,
      activatedAt: active ? (scheduled ? team.startsAt : team.activatedAt) : null,
      startsAt: team.startsAt,
      endsAt: team.endsAt,
      memberRunnerIds,
    };
  });
}

export function getTemporaryTeam(labelId: string, nowMs = clusterNow()): TemporaryTeam | null {
  return getTemporaryTeams(nowMs).find((team) => team.labelId === labelId) ?? null;
}

function requireTemporaryTeam(labelId: string): TemporaryTeam {
  const team = getTemporaryTeam(labelId);
  if (!team) throw new Error('Tijdelijke nachtploeg niet gevonden');
  return team;
}

export function setTemporaryTeamMembers(labelId: string, runnerIds: string[]): TemporaryTeam {
  const label = one<{ kind: string }>('SELECT kind FROM labels WHERE id = ?', [labelId]);
  if (label?.kind !== TEMPORARY_TEAM_KIND) throw new Error('Tijdelijke nachtploeg niet gevonden');
  const uniqueRunnerIds = [...new Set(runnerIds)];
  for (const runnerId of uniqueRunnerIds) {
    if (!one<{ id: string }>('SELECT id FROM runners WHERE id = ?', [runnerId])) {
      throw new Error('Een geselecteerde loper bestaat niet meer');
    }
    const otherTeam = one<{ labelId: string }>(
      `SELECT team_label_id AS labelId FROM temporary_team_members
       WHERE runner_id = ? AND team_label_id <> ?`,
      [runnerId, labelId]
    );
    if (otherTeam) throw new Error('Een loper kan maar in een tijdelijke nachtploeg zitten');
  }

  transaction(() => {
    ensureTemporaryTeamRow(labelId);
    run('DELETE FROM temporary_team_members WHERE team_label_id = ?', [labelId]);
    for (const runnerId of uniqueRunnerIds) {
      run('INSERT INTO temporary_team_members (team_label_id, runner_id) VALUES (?, ?)', [labelId, runnerId]);
    }
  });
  return requireTemporaryTeam(labelId);
}

/** Switches an unscheduled team by hand; scheduled teams follow their window. */
export function setTemporaryTeamActive(labelId: string, active: boolean, nowMs = clusterNow()): TemporaryTeam {
  const team = requireTemporaryTeam(labelId);
  if (team.startsAt !== null) throw new Error('Deze ploeg volgt haar planning. Pas het begin- of einduur aan.');
  if (active && team.memberRunnerIds.length === 0) throw new Error('Voeg eerst minstens een loper toe');
  run('UPDATE temporary_teams SET active = ?, activated_at = ? WHERE label_id = ?', [
    active ? 1 : 0,
    active ? nowMs : null,
    labelId,
  ]);
  return requireTemporaryTeam(labelId);
}

export function setTemporaryTeamSchedule(labelId: string, startsAt: number, endsAt: number): TemporaryTeam {
  if (endsAt <= startsAt) throw new Error('Het einduur moet na het beginuur liggen');
  requireTemporaryTeam(labelId);
  run('UPDATE temporary_teams SET starts_at = ?, ends_at = ?, active = 0, activated_at = NULL WHERE label_id = ?', [
    startsAt,
    endsAt,
    labelId,
  ]);
  return requireTemporaryTeam(labelId);
}

/** Changes whenever a night team starts or stops, so clients can refresh derived labels. */
export function activeTemporaryTeamsKey(nowMs = clusterNow()): string {
  return getTemporaryTeams(nowMs)
    .filter((team) => team.active)
    .map((team) => team.labelId)
    .join('|');
}

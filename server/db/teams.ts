import { type TemporaryTeam } from '../../shared/schemas.js';
import { all, one, run, transaction } from './connection.js';
import { TEMPORARY_TEAM_KIND, ensureTemporaryTeamRow, getBaseSpeedteamLabels } from './labels.js';
import { getRunnerById } from './runner-queries.js';
import { parseStringArray } from './values.js';

export function syncTemporaryTeamRows(): void {
  run(
    `INSERT OR IGNORE INTO temporary_teams (label_id, active, activated_at)
     SELECT id, 0, NULL FROM labels WHERE kind = ?`,
    [TEMPORARY_TEAM_KIND]
  );
}

export function getTemporaryTeams(): TemporaryTeam[] {
  const members = all<{ labelId: string; runnerId: string; restoreJson: string | null }>(
    `SELECT team_label_id AS labelId, runner_id AS runnerId, restore_label_ids_json AS restoreJson
     FROM temporary_team_members
     ORDER BY runner_id`
  );
  const membersByTeam = new Map<string, Pick<TemporaryTeam, 'memberRunnerIds' | 'restoreLabelIdsByRunner'>>();
  for (const member of members) {
    let team = membersByTeam.get(member.labelId);
    if (!team) {
      team = { memberRunnerIds: [], restoreLabelIdsByRunner: {} };
      membersByTeam.set(member.labelId, team);
    }
    team.memberRunnerIds.push(member.runnerId);
    team.restoreLabelIdsByRunner[member.runnerId] = parseStringArray(member.restoreJson);
  }
  return all<Omit<TemporaryTeam, 'active' | 'memberRunnerIds' | 'restoreLabelIdsByRunner'> & { active: number }>(
    `SELECT tt.label_id AS labelId, tt.active, tt.activated_at AS activatedAt,
            tt.starts_at AS startsAt, tt.ends_at AS endsAt, tt.schedule_owner_host_id AS scheduleOwnerHostId
     FROM temporary_teams tt
     JOIN labels l ON l.id = tt.label_id
     WHERE l.kind = ?
     ORDER BY COALESCE(l.sort_order, 9999), l.name`,
    [TEMPORARY_TEAM_KIND]
  ).map((team) => ({
    ...team,
    active: Boolean(team.active),
    memberRunnerIds: [],
    restoreLabelIdsByRunner: {},
    ...membersByTeam.get(team.labelId),
  }));
}

export function getTemporaryTeam(labelId: string): TemporaryTeam | null {
  return getTemporaryTeams().find((team) => team.labelId === labelId) ?? null;
}

function requireTemporaryTeam(labelId: string): TemporaryTeam {
  const team = getTemporaryTeam(labelId);
  if (!team) throw new Error('Tijdelijke nachtploeg niet gevonden');
  return team;
}

/** A temporary team replaces exactly one ordinary speedteam, which it restores afterwards. */
function requireSingleBaseSpeedteam(runnerId: string): string {
  const baseTeams = getBaseSpeedteamLabels(runnerId);
  if (baseTeams.length !== 1) {
    throw new Error(`${getRunnerById(runnerId)?.name ?? 'Loper'} moet exact een gewone speedteamploeg hebben`);
  }
  return baseTeams[0].id;
}

export function setTemporaryTeamMembers(labelId: string, runnerIds: string[]): TemporaryTeam {
  const label = one<{ kind: string }>('SELECT kind FROM labels WHERE id = ?', [labelId]);
  if (label?.kind !== TEMPORARY_TEAM_KIND) throw new Error('Tijdelijke nachtploeg niet gevonden');
  if (one<{ active: number }>('SELECT active FROM temporary_teams WHERE label_id = ?', [labelId])?.active) {
    throw new Error('Deactiveer de ploeg voordat je de ledenlijst wijzigt');
  }
  const uniqueRunnerIds = [...new Set(runnerIds)];
  for (const runnerId of uniqueRunnerIds) {
    if (!one<{ id: string }>('SELECT id FROM runners WHERE id = ?', [runnerId])) {
      throw new Error('Een geselecteerde loper bestaat niet meer');
    }
    requireSingleBaseSpeedteam(runnerId);
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
      run(
        `INSERT INTO temporary_team_members (team_label_id, runner_id, restore_label_ids_json)
         VALUES (?, ?, NULL)`,
        [labelId, runnerId]
      );
    }
  });
  return requireTemporaryTeam(labelId);
}

export function setTemporaryTeamActive(labelId: string, active: boolean, nowMs = Date.now()): TemporaryTeam {
  const team = requireTemporaryTeam(labelId);
  if (team.active === active) return team;
  if (active && team.memberRunnerIds.length === 0) throw new Error('Voeg eerst minstens een loper toe');

  transaction(() => {
    if (active) {
      for (const runnerId of team.memberRunnerIds) {
        const baseTeamId = requireSingleBaseSpeedteam(runnerId);
        run(
          `UPDATE temporary_team_members SET restore_label_ids_json = ?
           WHERE team_label_id = ? AND runner_id = ?`,
          [JSON.stringify([baseTeamId]), labelId, runnerId]
        );
        run(
          `DELETE FROM runner_labels
           WHERE runner_id = ? AND label_id IN (
             SELECT id FROM labels WHERE kind IN ('speedteam', 'temporary_team')
           )`,
          [runnerId]
        );
        run('INSERT OR IGNORE INTO runner_labels (runner_id, label_id) VALUES (?, ?)', [runnerId, labelId]);
      }
      run('UPDATE temporary_teams SET active = 1, activated_at = ? WHERE label_id = ?', [nowMs, labelId]);
    } else {
      const restores = all<{ runnerId: string; restoreJson: string | null }>(
        `SELECT runner_id AS runnerId, restore_label_ids_json AS restoreJson
         FROM temporary_team_members WHERE team_label_id = ?`,
        [labelId]
      );
      for (const restore of restores) {
        run('DELETE FROM runner_labels WHERE runner_id = ? AND label_id = ?', [restore.runnerId, labelId]);
        for (const restoreLabelId of parseStringArray(restore.restoreJson)) {
          run(
            `INSERT OR IGNORE INTO runner_labels (runner_id, label_id)
             SELECT ?, id FROM labels WHERE id = ?`,
            [restore.runnerId, restoreLabelId]
          );
        }
      }
      run('UPDATE temporary_team_members SET restore_label_ids_json = NULL WHERE team_label_id = ?', [labelId]);
      run('UPDATE temporary_teams SET active = 0, activated_at = NULL WHERE label_id = ?', [labelId]);
    }
  });
  return requireTemporaryTeam(labelId);
}

export function setTemporaryTeamSchedule(labelId: string, startsAt: number, endsAt: number, ownerHostId: string | null = null): TemporaryTeam {
  if (!Number.isSafeInteger(startsAt) || !Number.isSafeInteger(endsAt) || startsAt < 0 || endsAt <= startsAt) {
    throw new Error('Het einduur moet na het beginuur liggen');
  }
  requireTemporaryTeam(labelId);
  run(
    'UPDATE temporary_teams SET starts_at = ?, ends_at = ?, schedule_owner_host_id = COALESCE(?, schedule_owner_host_id) WHERE label_id = ?',
    [startsAt, endsAt, ownerHostId, labelId]
  );
  return requireTemporaryTeam(labelId);
}

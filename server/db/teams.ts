import { run, all, one, transaction } from './connection.js';
import { TEMPORARY_TEAM_KIND, getRunnerLabels } from './labels.js';
import { type TemporaryTeam } from '../../shared/schemas.js';
import { parseStringArray } from './values.js';
import { getRunnerById } from './runner-queries.js';

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
  const membersByTeam = new Map<string, string[]>();
  const restoresByTeam = new Map<string, Record<string, string[]>>();
  for (const member of members) {
    const teamMembers = membersByTeam.get(member.labelId);
    if (teamMembers) teamMembers.push(member.runnerId);
    else membersByTeam.set(member.labelId, [member.runnerId]);
    const restores = restoresByTeam.get(member.labelId) ?? {};
    restores[member.runnerId] = parseStringArray(member.restoreJson);
    restoresByTeam.set(member.labelId, restores);
  }
  return all<{ labelId: string; active: number; activatedAt: number | null }>(
    `SELECT tt.label_id AS labelId, tt.active, tt.activated_at AS activatedAt
     FROM temporary_teams tt
     JOIN labels l ON l.id = tt.label_id
     WHERE l.kind = ?
     ORDER BY COALESCE(l.sort_order, 9999), l.name`,
    [TEMPORARY_TEAM_KIND]
  ).map((team) => ({
    labelId: team.labelId,
    active: Boolean(team.active),
    activatedAt: team.activatedAt ?? null,
    memberRunnerIds: membersByTeam.get(team.labelId) ?? [],
    restoreLabelIdsByRunner: restoresByTeam.get(team.labelId) ?? {},
  }));
}

export function setTemporaryTeamMembers(labelId: string, runnerIds: string[]): TemporaryTeam {
  const label = one<{ id: string; kind: string }>('SELECT id, kind FROM labels WHERE id = ?', [labelId]);
  if (!label || label.kind !== TEMPORARY_TEAM_KIND) throw new Error('Tijdelijke nachtploeg niet gevonden');
  const state = one<{ active: number }>('SELECT active FROM temporary_teams WHERE label_id = ?', [labelId]);
  if (state?.active) throw new Error('Deactiveer de ploeg voordat je de ledenlijst wijzigt');
  const uniqueRunnerIds = [...new Set(runnerIds)];
  for (const runnerId of uniqueRunnerIds) {
    if (!one<{ id: string }>('SELECT id FROM runners WHERE id = ?', [runnerId])) {
      throw new Error('Een geselecteerde loper bestaat niet meer');
    }
    const other = one<{ labelId: string }>(
      `SELECT team_label_id AS labelId FROM temporary_team_members
       WHERE runner_id = ? AND team_label_id <> ?`,
      [runnerId, labelId]
    );
    if (other) throw new Error('Een loper kan maar in een tijdelijke nachtploeg zitten');
  }

  transaction(() => {
    run('INSERT OR IGNORE INTO temporary_teams (label_id, active, activated_at) VALUES (?, 0, NULL)', [labelId]);
    run('DELETE FROM temporary_team_members WHERE team_label_id = ?', [labelId]);
    for (const runnerId of uniqueRunnerIds) {
      run(
        `INSERT INTO temporary_team_members (team_label_id, runner_id, restore_label_ids_json)
         VALUES (?, ?, NULL)`,
        [labelId, runnerId]
      );
    }
  });
  const team = getTemporaryTeams().find((item) => item.labelId === labelId);
  if (!team) throw new Error('Tijdelijke nachtploeg opslaan mislukt');
  return team;
}

export function setTemporaryTeamActive(labelId: string, active: boolean, nowMs = Date.now()): TemporaryTeam {
  const team = getTemporaryTeams().find((item) => item.labelId === labelId);
  if (!team) throw new Error('Tijdelijke nachtploeg niet gevonden');
  if (team.active === active) return team;
  if (active && team.memberRunnerIds.length === 0) throw new Error('Voeg eerst minstens een loper toe');

  transaction(() => {
    if (active) {
      for (const runnerId of team.memberRunnerIds) {
        const baseTeams = getRunnerLabels(runnerId).filter((label) => label.kind === 'speedteam');
        if (baseTeams.length !== 1) {
          const runner = getRunnerById(runnerId);
          throw new Error(`${runner?.name ?? 'Loper'} moet exact een gewone speedteamploeg hebben`);
        }
        run(
          `UPDATE temporary_team_members SET restore_label_ids_json = ?
           WHERE team_label_id = ? AND runner_id = ?`,
          [JSON.stringify(baseTeams.map((label) => label.id)), labelId, runnerId]
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
        const ids = parseStringArray(restore.restoreJson);
        for (const restoreLabelId of ids) {
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
  const updated = getTemporaryTeams().find((item) => item.labelId === labelId);
  if (!updated) throw new Error('Tijdelijke nachtploeg aanpassen mislukt');
  return updated;
}

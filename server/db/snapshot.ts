import { type AppSnapshot } from '../../shared/schemas.js';
import { transaction, run } from './connection.js';
import { cleanRegistrationSource, cleanStatus, serializeHistoricalLabels, cleanRaceEventType } from './values.js';
import { setPublicRecordMode, DEFAULT_PUBLIC_RECORD_MODE } from './settings.js';

export function applySnapshot(snapshot: AppSnapshot): void {
  transaction(() => {
    run('DELETE FROM handoff_history');
    run('DELETE FROM race_events');
    run('DELETE FROM laps');
    run('DELETE FROM temporary_team_members');
    run('DELETE FROM temporary_teams');
    run('DELETE FROM runner_labels');
    run('DELETE FROM queue_entries');
    run('DELETE FROM runners');
    run('DELETE FROM labels');

    for (const label of snapshot.labels) {
      run(
        `INSERT INTO labels (
          id,
          name,
          color,
          icon,
          kind,
          image_url,
          target_laps,
          sort_order,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          label.id,
          label.name,
          label.color,
          label.icon,
          label.kind,
          label.imageUrl ?? null,
          label.targetLaps ?? null,
          label.sortOrder ?? null,
          label.createdAt ?? Date.now(),
          label.updatedAt ?? Date.now(),
        ]
      );
    }

    for (const runner of snapshot.runners) {
      run(
        `INSERT INTO runners (
          id,
          runner_number,
          name,
          target_laps,
          historical_avg_ms,
          historical_best_ms,
          registration_source,
          notes,
          registration_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          runner.id,
          runner.runnerNumber ?? null,
          runner.name,
          runner.targetLaps ?? null,
          runner.historicalAvgMs ?? null,
          runner.historicalBestMs ?? null,
          cleanRegistrationSource(runner.registrationSource),
          runner.notes ?? '',
          runner.registration ? JSON.stringify(runner.registration) : null,
          runner.createdAt,
          runner.updatedAt,
        ]
      );
      run(
        `INSERT INTO queue_entries (
          runner_id,
          status,
          queue_index,
          status_since,
          hidden_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          runner.id,
          cleanStatus(runner.status),
          runner.queueIndex ?? null,
          runner.statusSince ?? null,
          runner.queueHiddenAt ?? null,
        ]
      );
      for (const label of runner.labels || []) {
        run('INSERT OR IGNORE INTO runner_labels (runner_id, label_id) VALUES (?, ?)', [
          runner.id,
          label.id,
        ]);
      }
    }

    for (const lap of snapshot.laps.slice().reverse()) {
      run(
        `INSERT INTO laps (
          id,
          runner_id,
          lap_number,
          started_at,
          finished_at,
          duration_ms,
          source,
          created_at,
          labels_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          lap.id,
          lap.runnerId,
          lap.lapNumber,
          lap.startedAt,
          lap.finishedAt,
          lap.durationMs,
          lap.source,
          lap.createdAt,
          serializeHistoricalLabels(lap.labels ?? []),
        ]
      );
    }

    for (const team of snapshot.temporaryTeams ?? []) {
      run(
        `INSERT INTO temporary_teams (label_id, active, activated_at)
         VALUES (?, ?, ?)`,
        [team.labelId, team.active ? 1 : 0, team.activatedAt ?? null]
      );
      for (const runnerId of team.memberRunnerIds) {
        run(
          `INSERT INTO temporary_team_members (
             team_label_id, runner_id, restore_label_ids_json
           ) VALUES (?, ?, ?)`,
          [team.labelId, runnerId, JSON.stringify(team.restoreLabelIdsByRunner?.[runnerId] ?? [])]
        );
      }
    }

    for (const event of snapshot.events.slice().reverse()) {
      run(
        `INSERT INTO race_events (
          id,
          type,
          message,
          occurred_at,
          runner_id,
          runner_number,
          runner_name,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.id,
          cleanRaceEventType(event.type),
          event.message,
          event.occurredAt,
          event.runnerId ?? null,
          event.runnerNumber ?? null,
          event.runnerName ?? null,
          event.createdAt,
        ]
      );
    }

    run(
      `UPDATE race_state
       SET active_runner_id = ?,
           active_started_at = ?,
           race_started_at = ?,
           race_finished_at = ?,
           active_labels_json = ?
       WHERE id = 1`,
      [
        snapshot.race.activeRunnerId ?? null,
        snapshot.race.activeStartedAt ?? null,
        snapshot.race.raceStartedAt ?? null,
        snapshot.race.raceFinishedAt ?? null,
        JSON.stringify(snapshot.race.activeLabels ?? []),
      ]
    );
    setPublicRecordMode(snapshot.settings?.publicRecordMode ?? DEFAULT_PUBLIC_RECORD_MODE);
  });
}

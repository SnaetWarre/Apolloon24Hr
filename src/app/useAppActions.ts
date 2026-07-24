import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '../api';
import type {
  AppSnapshot,
  LabelInput,
  LabelPatch,
  PublicRecordMode,
  RaceStateExpectation,
  RunnerInput,
  RunnerPatch,
  RunnerStatus,
} from '../types';
import { snapshotKey } from './snapshot';
import { hasRealtimeConnection } from './useRealtimeBridge';
import { createUuid } from '../lib/uuid';

const CLIENT_ID_KEY = 'apolloon-client-id';
let memoryClientId: string | null = null;

function command<T extends object>(input: T): T & { _commandId: string; _clientId: string } {
  return {
    ...input,
    _commandId: createUuid(),
    _clientId: getClientId(),
  };
}

function getClientId(): string {
  if (memoryClientId) return memoryClientId;
  const stored = window.localStorage.getItem(CLIENT_ID_KEY);
  if (stored) {
    memoryClientId = stored;
    return stored;
  }
  memoryClientId = createUuid();
  window.localStorage.setItem(CLIENT_ID_KEY, memoryClientId);
  return memoryClientId;
}

export function useAppActions() {
  const activeQueryClient = useQueryClient();

  const reconcileSnapshot = React.useCallback(async () => {
    if (hasRealtimeConnection()) return;
    await activeQueryClient.invalidateQueries({ queryKey: snapshotKey });
  }, [activeQueryClient]);

  const currentRaceExpectation = React.useCallback((): RaceStateExpectation => {
    const snapshot = activeQueryClient.getQueryData<AppSnapshot>(snapshotKey);
    if (!snapshot) throw new Error('Timingstatus wordt nog geladen');
    return {
      activeRunnerId: snapshot.race.activeRunnerId,
      activeStartedAt: snapshot.race.activeStartedAt,
    };
  }, [activeQueryClient]);

  return React.useMemo(
    () => ({
      async addRunner(input: string | RunnerInput) {
        const body = typeof input === 'string' ? { name: input } : input;
        await trpc.runners.create.mutate(command(body));
        await reconcileSnapshot();
      },
      async updateRunner(id: string, input: RunnerPatch) {
        await trpc.runners.update.mutate(command({ id, fields: input }));
        await reconcileSnapshot();
      },
      async setStatus(id: string, status: RunnerStatus) {
        await trpc.runners.setStatus.mutate(command({ id, status }));
        await reconcileSnapshot();
      },
      async moveInQueue(id: string, targetId: string) {
        const snapshot = activeQueryClient.getQueryData<AppSnapshot>(snapshotKey);
        const waiting = (snapshot?.runners ?? [])
          .filter((runner) => runner.status === 'waiting')
          .sort(
            (a, b) =>
              (a.queueIndex ?? Number.MAX_SAFE_INTEGER) - (b.queueIndex ?? Number.MAX_SAFE_INTEGER) ||
              (a.statusSince ?? Number.MAX_SAFE_INTEGER) - (b.statusSince ?? Number.MAX_SAFE_INTEGER)
          );
        const oldIndex = waiting.findIndex((runner) => runner.id === id);
        const targetIndex = waiting.findIndex((runner) => runner.id === targetId);
        if (oldIndex === -1 || targetIndex === -1 || oldIndex === targetIndex) return;
        const [moved] = waiting.splice(oldIndex, 1);
        waiting.splice(targetIndex, 0, moved);
        await trpc.runners.reorder.mutate(command({ ids: waiting.map((runner) => runner.id) }));
        await reconcileSnapshot();
      },
      async deleteRunner(id: string) {
        await trpc.runners.delete.mutate(command({ id }));
        await reconcileSnapshot();
      },
      async hideRunner(id: string) {
        await trpc.runners.hide.mutate(command({ id }));
        await reconcileSnapshot();
      },
      async unhideRunner(id: string) {
        await trpc.runners.unhide.mutate(command({ id }));
        await reconcileSnapshot();
      },
      async createLabel(input: LabelInput) {
        await trpc.labels.create.mutate(command(input));
        await reconcileSnapshot();
      },
      async updateLabel(id: string, input: LabelPatch) {
        await trpc.labels.update.mutate(command({ id, fields: input }));
        await reconcileSnapshot();
      },
      async deleteLabel(id: string) {
        await trpc.labels.delete.mutate(command({ id }));
        await reconcileSnapshot();
      },
      async setTemporaryTeamMembers(labelId: string, runnerIds: string[]) {
        const team = await trpc.temporaryTeams.setMembers.mutate(command({ labelId, runnerIds }));
        await reconcileSnapshot();
        return team;
      },
      async setTemporaryTeamActive(labelId: string, active: boolean) {
        const team = await trpc.temporaryTeams.setActive.mutate(command({ labelId, active }));
        await reconcileSnapshot();
        return team;
      },
      async importRunnersCsv(csvText: string) {
        const summary = await trpc.runners.importCsv.mutate(command({ csvText }));
        await reconcileSnapshot();
        return `${summary.created} aangemaakt, ${summary.updated} bijgewerkt, ${summary.skipped} overgeslagen`;
      },
      async handoff() {
        await trpc.race.handoff.mutate(command(currentRaceExpectation()));
        await reconcileSnapshot();
      },
      async startNext() {
        await trpc.race.startNext.mutate(command(currentRaceExpectation()));
        await reconcileSnapshot();
      },
      async undoLastHandoff() {
        await trpc.race.undoLastHandoff.mutate(command(currentRaceExpectation()));
        await reconcileSnapshot();
      },
      async finishRace() {
        await trpc.race.finish.mutate(command(currentRaceExpectation()));
        await reconcileSnapshot();
      },
      async burgieGepakt() {
        const event = await trpc.events.burgieGepakt.mutate(command({}));
        await reconcileSnapshot();
        return event;
      },
      async updatePublicRecordMode(publicRecordMode: PublicRecordMode) {
        const settings = await trpc.settings.updatePublicRecordMode.mutate(
          command({ publicRecordMode })
        );
        await reconcileSnapshot();
        return settings;
      },
      async claimTimingControl() {
        const result = await trpc.cluster.claimTimingControl.mutate(command({}));
        await activeQueryClient.invalidateQueries({ queryKey: ['cluster', 'status'] });
        await reconcileSnapshot();
        return result;
      },
      async joinCluster(remoteUrl: string, pairingCode: string) {
        const response = await fetch('/api/cluster/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ remoteUrl, pairingCode }),
        });
        const responseText = await response.text();
        let result: {
          ok?: boolean;
          error?: string;
          backupFile?: string;
        };
        try {
          result = JSON.parse(responseText) as typeof result;
        } catch {
          result = { ok: false, error: responseText || `HTTP ${response.status}` };
        }
        if (!response.ok || !result.ok) {
          throw new Error(result.error || `Koppelen mislukt (${response.status})`);
        }
        await activeQueryClient.invalidateQueries({ queryKey: snapshotKey });
        await activeQueryClient.invalidateQueries({ queryKey: ['cluster', 'status'] });
        return result;
      },
      async resolveConflict(
        conflictId: string,
        selectedOperationId: string
      ) {
        const result = await trpc.cluster.resolveConflict.mutate(
          command({ conflictId, selectedOperationId })
        );
        await activeQueryClient.invalidateQueries({ queryKey: snapshotKey });
        await activeQueryClient.invalidateQueries({ queryKey: ['cluster', 'status'] });
        return result;
      },
    }),
    [activeQueryClient, currentRaceExpectation, reconcileSnapshot]
  );
}

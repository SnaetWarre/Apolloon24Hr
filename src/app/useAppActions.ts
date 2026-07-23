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
        await trpc.runners.create.mutate(body);
        await reconcileSnapshot();
      },
      async updateRunner(id: string, input: RunnerPatch) {
        await trpc.runners.update.mutate({ id, fields: input });
        await reconcileSnapshot();
      },
      async setStatus(id: string, status: RunnerStatus) {
        await trpc.runners.setStatus.mutate({ id, status });
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
        await trpc.runners.reorder.mutate({ ids: waiting.map((runner) => runner.id) });
        await reconcileSnapshot();
      },
      async deleteRunner(id: string) {
        await trpc.runners.delete.mutate({ id });
        await reconcileSnapshot();
      },
      async hideRunner(id: string) {
        await trpc.runners.hide.mutate({ id });
        await reconcileSnapshot();
      },
      async unhideRunner(id: string) {
        await trpc.runners.unhide.mutate({ id });
        await reconcileSnapshot();
      },
      async createLabel(input: LabelInput) {
        await trpc.labels.create.mutate(input);
        await reconcileSnapshot();
      },
      async updateLabel(id: string, input: LabelPatch) {
        await trpc.labels.update.mutate({ id, fields: input });
        await reconcileSnapshot();
      },
      async deleteLabel(id: string) {
        await trpc.labels.delete.mutate({ id });
        await reconcileSnapshot();
      },
      async setTemporaryTeamMembers(labelId: string, runnerIds: string[]) {
        const team = await trpc.temporaryTeams.setMembers.mutate({ labelId, runnerIds });
        await reconcileSnapshot();
        return team;
      },
      async setTemporaryTeamActive(labelId: string, active: boolean) {
        const team = await trpc.temporaryTeams.setActive.mutate({ labelId, active });
        await reconcileSnapshot();
        return team;
      },
      async importRunnersCsv(csvText: string) {
        const summary = await trpc.runners.importCsv.mutate({ csvText });
        await reconcileSnapshot();
        return `${summary.created} aangemaakt, ${summary.updated} bijgewerkt, ${summary.skipped} overgeslagen`;
      },
      async handoff() {
        await trpc.race.handoff.mutate(currentRaceExpectation());
        await reconcileSnapshot();
      },
      async startNext() {
        await trpc.race.startNext.mutate(currentRaceExpectation());
        await reconcileSnapshot();
      },
      async undoLastHandoff() {
        await trpc.race.undoLastHandoff.mutate(currentRaceExpectation());
        await reconcileSnapshot();
      },
      async finishRace() {
        await trpc.race.finish.mutate(currentRaceExpectation());
        await reconcileSnapshot();
      },
      async burgieGepakt() {
        const event = await trpc.events.burgieGepakt.mutate();
        await reconcileSnapshot();
        return event;
      },
      async updatePublicRecordMode(publicRecordMode: PublicRecordMode) {
        const settings = await trpc.settings.updatePublicRecordMode.mutate({ publicRecordMode });
        await reconcileSnapshot();
        return settings;
      },
    }),
    [activeQueryClient, currentRaceExpectation, reconcileSnapshot]
  );
}

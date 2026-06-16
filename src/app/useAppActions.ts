import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '../api';
import type { LabelInput, LabelPatch, PublicRecordMode, RunnerInput, RunnerPatch, RunnerStatus } from '../types';
import { snapshotKey } from './snapshot';
import { useAppData } from './useAppData';

export function useAppActions() {
  const activeQueryClient = useQueryClient();
  const { runners } = useAppData();

  const refreshSnapshot = React.useCallback(async () => {
    await activeQueryClient.invalidateQueries({ queryKey: snapshotKey });
  }, [activeQueryClient]);

  return React.useMemo(
    () => ({
      async addRunner(input: string | RunnerInput) {
        const body = typeof input === 'string' ? { name: input } : input;
        await trpc.runners.create.mutate(body);
        await refreshSnapshot();
      },
      async updateRunner(id: string, input: RunnerPatch) {
        await trpc.runners.update.mutate({ id, fields: input });
        await refreshSnapshot();
      },
      async setStatus(id: string, status: RunnerStatus) {
        await trpc.runners.setStatus.mutate({ id, status });
        await refreshSnapshot();
      },
      async moveInQueue(id: string, newIndex: number) {
        const waiting = runners
          .filter((runner) => runner.status === 'waiting')
          .sort((a, b) => (a.queueIndex ?? 0) - (b.queueIndex ?? 0));
        const oldIndex = waiting.findIndex((runner) => runner.id === id);
        if (oldIndex === -1) return;
        const [moved] = waiting.splice(oldIndex, 1);
        waiting.splice(newIndex, 0, moved);
        await trpc.runners.reorder.mutate({ ids: waiting.map((runner) => runner.id) });
        await refreshSnapshot();
      },
      async deleteRunner(id: string) {
        await trpc.runners.delete.mutate({ id });
        await refreshSnapshot();
      },
      async hideRunner(id: string) {
        await trpc.runners.hide.mutate({ id });
        await refreshSnapshot();
      },
      async unhideRunner(id: string) {
        await trpc.runners.unhide.mutate({ id });
        await refreshSnapshot();
      },
      async createLabel(input: LabelInput) {
        await trpc.labels.create.mutate(input);
        await refreshSnapshot();
      },
      async updateLabel(id: string, input: LabelPatch) {
        await trpc.labels.update.mutate({ id, fields: input });
        await refreshSnapshot();
      },
      async deleteLabel(id: string) {
        await trpc.labels.delete.mutate({ id });
        await refreshSnapshot();
      },
      async importRunnersCsv(csvText: string) {
        const summary = await trpc.runners.importCsv.mutate({ csvText });
        await refreshSnapshot();
        return `${summary.created} aangemaakt, ${summary.updated} bijgewerkt, ${summary.skipped} overgeslagen`;
      },
      async handoff() {
        await trpc.race.handoff.mutate();
        await refreshSnapshot();
      },
      async startNext() {
        await trpc.race.startNext.mutate();
        await refreshSnapshot();
      },
      async undoLastHandoff() {
        await trpc.race.undoLastHandoff.mutate();
        await refreshSnapshot();
      },
      async finishRace() {
        await trpc.race.finish.mutate();
        await refreshSnapshot();
      },
      async burgieGepakt() {
        const event = await trpc.events.burgieGepakt.mutate();
        await refreshSnapshot();
        return event;
      },
      async updatePublicRecordMode(publicRecordMode: PublicRecordMode) {
        const settings = await trpc.settings.updatePublicRecordMode.mutate({ publicRecordMode });
        await refreshSnapshot();
        return settings;
      },
    }),
    [refreshSnapshot, runners]
  );
}

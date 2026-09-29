import React from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { trpc } from '../api';
import type {
  LabelInput,
  LabelPatch,
  LiveAppSnapshot,
  PublicRecordMode,
  RaceStateExpectation,
  RunnerInput,
  RunnerPatch,
  RunnerStatus,
} from '../types';
import type { PressTime } from '../lib/pressTiming';
import { appKey, clusterStatusKey, snapshotKey } from './snapshot';

export function useAppActions() {
  const queryClient = useQueryClient();

  return React.useMemo(() => {
    /** Wraps a server call so this screen shows its effect as soon as the call returns. */
    function action<Args extends unknown[], Result>(
      call: (...args: Args) => Promise<Result>,
      refresh: QueryKey[] = [appKey]
    ): (...args: Args) => Promise<Result> {
      return async (...args) => {
        const result = await call(...args);
        await Promise.all(refresh.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        return result;
      };
    }

    const snapshot = () => queryClient.getQueryData<LiveAppSnapshot>(snapshotKey);

    /** Timing actions send the race state this screen shows, so a stale press is refused. */
    const raceExpectation = (): RaceStateExpectation => {
      const race = snapshot()?.race;
      if (!race) throw new Error('Timingstatus wordt nog geladen');
      return {
        activeRunnerId: race.activeRunnerId,
        activeStartedAt: race.activeStartedAt,
      };
    };

    return {
      addRunner: action((input: RunnerInput) => trpc.runners.create.mutate(input)),
      updateRunner: action((id: string, fields: RunnerPatch) => trpc.runners.update.mutate({ id, fields })),
      setStatus: action((id: string, status: RunnerStatus) => trpc.runners.setStatus.mutate({ id, status })),
      moveInQueue: action(async (id: string, targetId: string) => {
        const waiting = (snapshot()?.runners ?? [])
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
        await trpc.runners.reorder.mutate({
          ids: waiting.map((runner) => runner.id),
        });
      }),
      deleteRunner: action((id: string) => trpc.runners.delete.mutate({ id })),
      hideRunner: action((id: string) => trpc.runners.hide.mutate({ id })),
      unhideRunner: action((id: string) => trpc.runners.unhide.mutate({ id })),
      importRunnersCsv: action(async (csvText: string) => {
        const summary = await trpc.runners.importCsv.mutate({ csvText });
        return `${summary.created} aangemaakt, ${summary.updated} bijgewerkt, ${summary.skipped} overgeslagen`;
      }),
      createLabel: action((input: LabelInput) => trpc.labels.create.mutate(input)),
      updateLabel: action((id: string, fields: LabelPatch) => trpc.labels.update.mutate({ id, fields })),
      deleteLabel: action((id: string) => trpc.labels.delete.mutate({ id })),
      createTemporaryTeam: action(
        (input: { name: string; color: string; startsAt: number; endsAt: number; runnerIds: string[] }) =>
          trpc.temporaryTeams.create.mutate(input)
      ),
      setTemporaryTeamMembers: action((labelId: string, runnerIds: string[]) =>
        trpc.temporaryTeams.setMembers.mutate({ labelId, runnerIds })
      ),
      setTemporaryTeamSchedule: action((labelId: string, startsAt: number, endsAt: number) =>
        trpc.temporaryTeams.setSchedule.mutate({ labelId, startsAt, endsAt })
      ),
      setTemporaryTeamActive: action((labelId: string, active: boolean) =>
        trpc.temporaryTeams.setActive.mutate({ labelId, active })
      ),
      handoff: action((press: PressTime) => trpc.race.handoff.mutate({ ...raceExpectation(), ...press })),
      startNext: action((press: PressTime) => trpc.race.startNext.mutate({ ...raceExpectation(), ...press })),
      undoLastHandoff: action(() => trpc.race.undoLastHandoff.mutate(raceExpectation())),
      finishRace: action((press: PressTime) =>
        trpc.race.finish.mutate({ ...raceExpectation(), pressedAt: press.pressedAt })
      ),
      burgieGepakt: action(() => trpc.events.burgieGepakt.mutate()),
      updatePublicRecordMode: action((publicRecordMode: PublicRecordMode) =>
        trpc.settings.updatePublicRecordMode.mutate({ publicRecordMode })
      ),
      createBackup: action(() => trpc.backups.create.mutate(), [clusterStatusKey]),
      joinPrimary: action((primaryUrl: string) => trpc.cluster.join.mutate({ primaryUrl }), [appKey, clusterStatusKey]),
      promoteToPrimary: action(
        (emergency: boolean) => trpc.cluster.promote.mutate({ emergency }),
        [appKey, clusterStatusKey]
      ),
    };
  }, [queryClient]);
}

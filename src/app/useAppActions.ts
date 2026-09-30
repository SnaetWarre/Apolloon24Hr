import React from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { trpc } from '../api';
import type {
  LabelImageUpload,
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
import { nowMs } from '../lib/time';
import { addPendingChange, confirmedSnapshot, orderPatch, statusPatch, waitingOrder } from './optimistic';
import { appKey, backupsKey, clusterStatusKey, snapshotKey } from './snapshot';

// Queue changes go to the server one at a time, in the order they were clicked, so quick clicks
// are never lost and the back of the queue fills in the order people were sent there.
let queueChanges: Promise<unknown> = Promise.resolve();
function inClickOrder<Result>(call: () => Promise<Result>): Promise<Result> {
  const result = queueChanges.then(call, call);
  queueChanges = result.catch(() => undefined);
  return result;
}

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

    /**
     * Shows `patch` on this screen right away and keeps it on top of every refetch until the server
     * has answered; then the server's snapshot takes over, also when the change was refused.
     */
    async function optimistic<Result>(
      patch: (current: LiveAppSnapshot) => LiveAppSnapshot,
      call: () => Promise<Result>
    ): Promise<Result> {
      const removePatch = addPendingChange(patch);
      queryClient.setQueryData<LiveAppSnapshot>(snapshotKey, (current) => current && patch(current));
      return inClickOrder(async () => {
        try {
          const result = await call();
          // The patch stays until the refetch lands, so the screen never shows the old state in between.
          await queryClient.invalidateQueries({ queryKey: appKey });
          return result;
        } catch (error) {
          // Refused: drop the patch first, so the refetch shows what the server really has.
          removePatch();
          await queryClient.invalidateQueries({ queryKey: appKey });
          throw error;
        } finally {
          removePatch();
        }
      });
    }

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
      setStatus: (id: string, status: RunnerStatus) => {
        // The server only takes whole milliseconds; the clock offset can be fractional.
        const statusSince = Math.round(nowMs());
        return optimistic(statusPatch(id, status, statusSince), () =>
          trpc.runners.setStatus.mutate({ id, status, statusSince })
        );
      },
      moveInQueue: async (id: string, targetId: string) => {
        const current = snapshot();
        if (!current) return;
        const order = waitingOrder(current);
        const oldIndex = order.indexOf(id);
        const targetIndex = order.indexOf(targetId);
        if (oldIndex === -1 || targetIndex === -1 || oldIndex === targetIndex) return;
        order.splice(oldIndex, 1);
        order.splice(targetIndex, 0, id);
        await optimistic(orderPatch(order), () => {
          // The server wants exactly its own waiting runners. Runners still on their way to the
          // queue from an earlier click are left out; anyone missing keeps their turn at the back.
          const serverWaiting = waitingOrder(confirmedSnapshot() ?? current);
          const known = new Set(serverWaiting);
          const ids = order.filter((runnerId) => known.has(runnerId));
          const listed = new Set(ids);
          return trpc.runners.reorder.mutate({
            ids: [...ids, ...serverWaiting.filter((runnerId) => !listed.has(runnerId))],
          });
        });
      },
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
      uploadLabelImage: action((input: LabelImageUpload) => trpc.labels.uploadImage.mutate(input), []),
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
      createBackup: action(() => trpc.backups.create.mutate(), [clusterStatusKey, backupsKey]),
      restoreBackup: action(
        (fileName: string) => trpc.backups.restore.mutate({ fileName }),
        [appKey, clusterStatusKey, backupsKey]
      ),
      joinGroup: action((url: string) => trpc.cluster.join.mutate({ url }), [appKey, clusterStatusKey]),
      continueAlone: action(() => trpc.cluster.continueAlone.mutate(), [appKey, clusterStatusKey]),
    };
  }, [queryClient]);
}

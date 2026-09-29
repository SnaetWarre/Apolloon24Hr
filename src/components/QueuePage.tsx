import React from 'react';
import { useAppData } from '../app/index';
import { getNextWaitingRunner } from '../lib/runners';
import type { LiveAppSnapshot } from '../types';
import { KanbanBoard } from './KanbanBoard';
import { LiveDuration } from './LiveTime';
import { PageHeader } from './PageHeader';
import { QueueActions } from './QueueActions';
import { RunnerName } from './RunnerName';
import { RunnerProfileModal } from './RunnerProfileModal';

const selectQueuePageData = ({ race, runners }: LiveAppSnapshot) => ({
  race,
  runners,
});

export function QueuePage() {
  const { race, runners } = useAppData(selectQueuePageData);
  const [profileRunnerId, setProfileRunnerId] = React.useState<string | null>(null);

  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextWaitingRunner(runners);
  const waitingCount = runners.filter((runner) => runner.status === 'waiting').length;

  return (
    <>
      <PageHeader title="Wachtrij" actions={<QueueActions onOpenProfile={setProfileRunnerId} />} />
      <section className="race-strip" aria-label="Wisselzone">
        <div className="race-strip__now">
          <span className="race-strip__label">Nu op de piste</span>
          <span className="race-strip__runner">
            {activeRunner ? <RunnerName runner={activeRunner} /> : 'Nog niemand gestart'}
          </span>
          {race.activeStartedAt && activeRunner && (
            <LiveDuration
              startedAt={race.activeStartedAt}
              className="race-strip__time"
              refreshMs={1_000}
              format="seconds"
            />
          )}
        </div>
        <div>
          <span className="race-strip__label">Volgende</span>
          <span className="race-strip__runner">
            {nextRunner ? <RunnerName runner={nextRunner} /> : 'Niemand klaar'}
          </span>
        </div>
        <div>
          <span className="race-strip__label">Klaar om te lopen</span>
          <span className="race-strip__runner">
            {waitingCount} {waitingCount === 1 ? 'loper' : 'lopers'}
          </span>
        </div>
      </section>
      <KanbanBoard onOpenProfile={setProfileRunnerId} />
      {profileRunnerId && <RunnerProfileModal runnerId={profileRunnerId} onClose={() => setProfileRunnerId(null)} />}
    </>
  );
}
